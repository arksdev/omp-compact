import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolExecutionEndEvent,
} from "@oh-my-pi/pi-coding-agent";

import {
	captureWriteCandidate,
	completeEditMutations,
	completeWriteCandidate,
} from "./audit";
import { AuditLifecycle } from "./audit-lifecycle";
import { createSettingsStore, readDisplayCycleKeySync } from "./config";
import { resolveSessionCwd } from "./display-path";
import { formatGitRecords, recognizeGitCommands } from "./git-records";
import {
	createHostSettingsBridge,
	createSessionSettingsApi,
	createSessionSettingsResolver,
	type HostSettingsBridge,
} from "./host-settings";
import {
	GIT_MESSAGE_TYPE,
	type GitMessageDetails,
	type LegacyMutationMessageDetails,
	MUTATION_MESSAGE_TYPE,
	type MutationMessageDetails,
} from "./messages";
// RuntimeModes (upgrade2 item 2): per-logical-run mode policy (compact/live/
// clear + enabled + retainGitLive), consumed by the runtime adapter.
import { ModePolicy } from "./mode-policy";
import { objectRecord } from "./object-record";
import {
	createSessionResolver,
	PostTurnShake,
	resolveAutoShake,
} from "./post-turn-shake";
import { gitMessageComponent, mutationMessageComponent } from "./render";
// RunStats (upgrade2 item 4): configurable terminal usage row. The
// aggregator and evidence stay in run-stats.ts; this file only wires events
// and the two adapter seams (onRunFinalized / statsRenderer).
import {
	evidenceFromResult,
	hasAssistantUsage,
	RunStats,
	type RunStatsEvidence,
	resultFromEvidence,
	STATS_MESSAGE_TYPE,
	statsLine,
	statsMessageComponent,
} from "./run-stats";
import {
	type AdapterUI,
	captureHostRoot,
	RuntimeAdapter,
} from "./runtime-adapter";
import {
	cycleDisplayState,
	openSettingsDialog,
	registerDisplayCycleShortcut,
	registerSettingsCommand,
	saveSettingsFlow,
} from "./settings-ui";
import { resolveToolAudit } from "./tool-presentation-rules";
import { classifyAgentEnd } from "./turn-ledger";
import { defaultWarn } from "./warn-sink";

interface PendingGit {
	command: string;
}

interface PendingTerminalStats {
	line: string;
}

/**
 * Classes of decorative UI failure that warn once each. Adding a class means
 * adding it here, not in two places that must agree.
 */
type DecorativeWarningKey =
	| "decorative-stats-failed"
	| "decorative-scrollback-failed"
	| "decorative-retire-failed"
	| "decorative-shake-failed";

/**
 * The context's UI narrowed to the optional warning sink. `notify` is absent
 * headless and over RPC, so every caller treats it as optional.
 */
type NotifyingUI = ExtensionContext["ui"] & {
	notify?: (message: string, level: "warning") => void;
};

/**
 * The context narrowed to the optional session manager. The host adds it on
 * the real context; the plugin never assumes it is there.
 */
type ContextWithSessionManager = ExtensionContext & {
	sessionManager?: { getBranch?: () => readonly unknown[] };
};

const MAX_GIT_RESULT_TEXT = 8_192;

function pendingGitFrom(payload: unknown): PendingGit | undefined {
	if (payload && typeof payload === "object" && "command" in payload) {
		const command = payload.command; // unknown after `in` narrowing
		if (typeof command === "string") return { command };
	}
	return undefined;
}

function textFromResult(result: unknown): string {
	const content = objectRecord(result).content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const item of content) {
		const part = objectRecord(item).text;
		if (typeof part !== "string" || part.length === 0) continue;
		const separator = text ? "\n" : "";
		const remaining = MAX_GIT_RESULT_TEXT - text.length - separator.length;
		if (remaining <= 0) break;
		text += separator + part.slice(0, remaining);
	}
	return text;
}

/**
 * Resolve a method from an opaque host root and return a bound caller.
 * The returned function always calls the method with `root` as receiver,
 * so the caller does not need to track the host object.
 */
function requestMethod(
	root: unknown,
	name: string,
): ((...args: unknown[]) => void) | undefined {
	if (!root || typeof root !== "object") return undefined;
	const method = (root as Record<string, unknown>)[name];
	return typeof method === "function"
		? (...args: unknown[]) =>
				(method as (...values: unknown[]) => void).call(root, ...args)
		: undefined;
}

function adapterUI(context: ExtensionContext, root: unknown): AdapterUI {
	const ui = context.ui as ExtensionContext["ui"] & {
		getToolsExpanded?: () => boolean | undefined;
	};
	// `/theme` reassigns the host's live theme binding (`export var theme`
	// in the host's modes/theme/theme.ts, swapped via setTheme), and
	// `context.ui.theme` is a getter over
	// that binding. Snapshotting it here froze every compact row on the boot
	// palette until the session restarted, while the message renderers and
	// statsRenderer already read the host getter per call. The eager read below
	// keeps bring-up validation: a host whose accessor throws must fail open
	// once at bring-up rather than from inside a host render call.
	const bootTheme = context.ui.theme;
	return {
		get theme(): AdapterUI["theme"] {
			try {
				return context.ui.theme;
			} catch {
				// An accessor that starts throwing mid-session keeps rows on the
				// last known-good palette instead of throwing into host paint.
				return bootTheme;
			}
		},
		setWidget: context.ui.setWidget.bind(context.ui) as AdapterUI["setWidget"],
		requestRender: requestMethod(root, "requestRender"),
		requestComponentRender: requestMethod(root, "requestComponentRender"),
		// Deliberately un-coerced: `undefined` (no accessor, or an accessor
		// that refused) must stay distinguishable from a known-collapsed
		// `false`, which is the only state the advisor-note compaction may
		// trust.
		getToolsExpanded:
			typeof ui.getToolsExpanded === "function"
				? () => ui.getToolsExpanded?.()
				: undefined,
	};
}

// AdapterFailOpenFix: transactional rollback for a failed runtime bring-up.
// Restores every partial own-instance effect the guard may have left behind:
// the host probe widget (best-effort re-removal) and any constructed adapter
// (descriptor/discovery patches, spinner timer). Never throws: a capability
// failure must not escape into the event stream.
function rollbackAdapterFailure(
	ui: AdapterUI,
	candidate: RuntimeAdapter | undefined,
): void {
	try {
		ui.setWidget?.("omp-compact-tui", undefined);
	} catch {
		// A host that cannot remove the probe cannot be forced.
	}
	try {
		candidate?.dispose();
	} catch {
		// Rollback must never throw into the event handler.
	}
}

/**
 * Extract short hash and subject from a pre-formatted git commit row
 * produced by `formatGitRecords`. Matches the `git commit <hash> <subject>`
 * pattern emitted by commitSummary in git-records.ts; the subject is
 * optional (a row without one must still keep the hash, mirroring
 * `gitCommitHashes` tolerance in render.ts).
 */
function commitDetails(
	text: string,
): Pick<GitMessageDetails, "shortHash" | "subject"> {
	const match = /^git commit\s+([0-9a-f]{4,64})(?:\s+(.+))?$/i.exec(text);
	if (!match) return {};
	return match[2]
		? { shortHash: match[1], subject: match[2] }
		: { shortHash: match[1] };
}

export default function ompCompact(pi: ExtensionAPI): void {
	pi.setLabel("omp-compact");

	// Guarded host registrations, same degrade contract as
	// registerSettingsCommand: a host without the surface (older runtime, RPC
	// shim) must not take the plugin down — the feature is skipped with a
	// warning, every other feature keeps working. The narrow casts mirror the
	// host signatures; the pinned host's implementations are pure in-memory
	// writes, so these only fire on hosts that lack the surface.
	const listen = ((event: string, handler: unknown) => {
		try {
			(pi.on as (event: string, handler: unknown) => void)(event, handler);
		} catch {
			defaultWarn(`event subscription skipped (${event} unavailable)`);
		}
	}) as unknown as ExtensionAPI["on"];
	const registerRenderer = ((customType: string, renderer: unknown) => {
		try {
			(
				pi.registerMessageRenderer as (
					customType: string,
					renderer: unknown,
				) => void
			)(customType, renderer);
		} catch {
			defaultWarn(`message renderer skipped (${customType} unavailable)`);
		}
	}) as unknown as ExtensionAPI["registerMessageRenderer"];

	// Public SDK registry seam shared with post-turn-shake: resolves the live
	// main AgentSession (identity-checked against each command context).
	const agentRegistry = (pi.pi as { AgentRegistry?: unknown } | undefined)
		?.AgentRegistry;
	// HostSettingsBridge (upgrade2 item 6): resolves the initialized
	// per-session Settings of the live main agent session. The exported
	// global `settings` Proxy is NEVER used — this runtime never calls
	// `Settings.init()`, so that proxy throws on any access, while every live
	// AgentSession owns an initialized `session.settings`.
	const hostSettingsResolver = createSessionSettingsResolver(agentRegistry);

	// SettingsFoundation (upgrade2 item 1): typed persistent settings store
	// + /compact-settings command. The command must stay available even when
	// the runtime is globally disabled, so registration runs before the mode
	// gate; the store is created lazily (no disk I/O until the menu opens).
	// The store is per plugin INSTANCE: two sessions in one process must never
	// share settings state (cross-session/subagent contamination).
	const settingsStore = createSettingsStore({ env: Bun.env });
	registerSettingsCommand<ExtensionCommandContext>(pi, {
		description: "Open omp-compact plugin settings",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				try {
					ctx.ui.notify(
						"omp-compact settings require an interactive terminal",
						"warning",
					);
				} catch {
					// Headless/RPC: notify is a no-op; exit safely.
				}
				return;
			}
			// HostSettingsBridge (upgrade2 item 6): resolve the live main
			// session's Settings eagerly, before the menu opens, so host rows
			// can be disabled when no verified live settings instance exists
			// while plugin rows stay savable. Loading the plugin never touches
			// host config; opening/cancelling never writes.
			const hostSettings = hostSettingsResolver(ctx);
			const hostBridge: HostSettingsBridge | undefined = hostSettings
				? createHostSettingsBridge({
						api: createSessionSettingsApi(hostSettings),
					})
				: undefined;
			const initial = await settingsStore.load();
			// E01: the dialog's save outcome (including the single success
			// notification) is fully handled by saveSettingsFlow inside
			// onSave, so the dialog result needs no post-processing here.
			await openSettingsDialog(ctx.ui, {
				settings: {
					...initial,
					host: hostBridge ? hostBridge.read() : initial.host,
				},
				hostAvailable: hostBridge !== undefined,
				onSave: async (next) => {
					// Host flush runs first; on flush failure the bridge rolls
					// back the host values and rethrows, so the plugin JSON
					// stays untouched. Thinking visibility has no safe live
					// refresh in stock: saveSettingsFlow never reloads and
					// notifies honestly ("restart OMP to apply") instead.
					//
					// E01: saveSettingsFlow emits exactly one success
					// notification through the seam below — the plain
					// "omp-compact settings saved" for an unmasked save, or a
					// single message carrying both facts (saved + effective)
					// when a hard env override masks the persisted value — so
					// nothing is notified again after the dialog closes.
					await saveSettingsFlow(next, {
						bridge: hostBridge,
						previous: initial,
						store: settingsStore,
						notify: (level, message) => {
							try {
								ctx.ui.notify(message, level);
							} catch {
								// no-op
							}
						},
					});
					// AdvisorNotes: the advisor toggle is a live display
					// preference, so a successful save repaints the cards
					// already in the transcript (on → re-prove and compact,
					// off → restore the native renderer). Deliberately after
					// the flow: the store snapshot must already carry the new
					// value, and a failed save keeps the old presentation.
					// Decorative only — a failing repaint must not turn a
					// saved setting into a failed save.
					if (
						initial.compactAdvisorNotes !== next.compactAdvisorNotes ||
						initial.enabled !== next.enabled
					) {
						try {
							adapter?.refreshAdvisorPresentation();
						} catch {
							// Best-effort: the preference is already persisted.
						}
					}
				},
				warn: (message) => {
					try {
						ctx.ui.notify(message, "warning");
					} catch {
						// no-op
					}
				},
			});
		},
	});

	// DisplayCycle: one chord walks compact -> live -> clear -> off -> compact.
	// Registered unconditionally, next to the settings command and for the same
	// reason: the "off" step is part of the cycle, so a globally disabled
	// runtime must still answer the key that re-enables it.
	//
	// The chord is read synchronously: the host collects extension shortcuts
	// from whatever this factory declared by the time it returns and offers no
	// way to unregister one afterwards (`ExtensionAPI` has `registerShortcut`
	// and no counterpart), so a change only takes effect after restarting OMP —
	// exactly what the settings dialog reports.
	registerDisplayCycleShortcut<ExtensionContext>(
		pi,
		readDisplayCycleKeySync({ env: Bun.env }),
		{
			description: "Cycle omp-compact display: compact / live / clear / off",
			handler: async (ctx) => {
				// Stock awaits extension *command* handlers inside a try/catch
				// (`session/agent-session.ts` `#tryExecuteExtensionCommand`) but
				// calls *shortcut* handlers without awaiting
				// (`modes/controllers/input-controller.ts`
				// `registerExtensionShortcuts`), so its surrounding try/catch
				// only sees synchronous throws. An async rejection from here
				// would escape to the process-level `unhandledRejection` hook
				// and take the host down — the cycle is decorative, so it
				// fails open with a warning instead.
				try {
					const hostSettings = hostSettingsResolver(ctx);
					await cycleDisplayState({
						store: settingsStore,
						bridge: hostSettings
							? createHostSettingsBridge({
									api: createSessionSettingsApi(hostSettings),
								})
							: undefined,
						theme: ctx.ui.theme,
						notify: (level, message) => {
							try {
								ctx.ui.notify(message, level);
							} catch {
								// Headless/RPC notify is a no-op; the settings are
								// already persisted, so a silent sink is harmless.
							}
						},
					});
				} catch (error) {
					try {
						ctx.ui.notify(
							`omp-compact: display cycle failed: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					} catch {
						// Nothing left to report through; never rethrow.
					}
				}
			},
		},
	);

	// RuntimeModes (upgrade2 item 2): one settings snapshot per logical run,
	// captured at agent_start; settings changes (incl. global disable) apply
	// at the next run boundary and never mix into an active run. The runtime
	// stays wired so re-enable reinstalls cleanly mid-session; the settings
	// command above stays registered regardless of enabled state.
	const modePolicy = new ModePolicy(settingsStore);
	modePolicy.prime();

	// PostTurnShake (upgrade2 item 5): native auto-shake after a visible
	// successful terminal answer. Default off; per-run settings are captured
	// in beginRun() (OMP_COMPACT_SHAKE=1/0 overrides the JSON value). E05:
	// a successfully resolved shake reports the stock formatShakeSummary
	// one-liner through the ephemeral UI notification — never an appended
	// session/custom entry, so the session tree topology stays untouched.
	const postShake = new PostTurnShake({
		getContextUsage: (context) => context.getContextUsage?.(),
		resolveSession: createSessionResolver(agentRegistry),
		// A successful `shake("elide")` rewrites the persisted entries,
		// replaces the agent messages and makes the host clear and rebuild
		// the transcript synchronously — the same collapsed-tail rebuild an
		// LLM compaction produces, and equally not a live user clear. Without
		// the suffix permit the rebuild falls into the strict exact-count
		// branch, leaves the reconstructed read tail unbound and permanently
		// re-expands rows the finished turn had already hidden. Arm the
		// permit here, at the single point that knows the rebuild is ours;
		// the shake module itself stays ignorant of mode policy.
		shake: (session, signal) => {
			modePolicy.armCollapsedRebuild();
			return session.shake("elide", { signal });
		},
		notify: (context, message) => {
			try {
				(context as ExtensionContext).ui.notify(message, "info");
			} catch {
				// Headless/RPC notify is a no-op; a failing UI sink must
				// never break the shake path.
			}
		},
	});

	let adapter: RuntimeAdapter | undefined;
	let adapterDisabled = false;
	// adapterFailureWarned: one warning per failure episode. Cleared by
	// disableRuntime() (settings disable and session dispose) so a later
	// bring-up may warn again. Distinct from adapterDisabled — that host-
	// invariant latch is cleared only by dispose() at a session boundary;
	// a settings toggle does not release it.
	let adapterFailureWarned = false;
	// RuntimeModes: a logical run spans toolUse/willContinue continuations,
	// each of which re-emits agent_start. While `runActive` the run's frozen
	// mode governs: settings changes (including global disable) apply only at
	// the next idle boundary, never mid-run.
	let runActive = false;
	/**
	 * Decorative UI failures (stats row, scrollback replay, payload retire,
	 * post-shake dispatch): warn once per class for the plugin instance.
	 * Never shares {@link adapterFailureWarned} — that flag is session-
	 * terminal disable signaling, not decorative noise control.
	 * Cleared on session dispose so a later session may re-signal.
	 */
	const decorativeWarned = new Set<DecorativeWarningKey>();
	function warnDecorativeOnce(
		key: DecorativeWarningKey,
		message: string,
		context?: ExtensionContext,
	): void {
		if (decorativeWarned.has(key)) return;
		decorativeWarned.add(key);
		try {
			const notify = (context?.ui as NotifyingUI | undefined)?.notify;
			if (typeof notify === "function" && context) {
				notify.call(context.ui, message, "warning");
				return;
			}
			defaultWarn(message);
		} catch {
			// Best-effort: the warning itself must never throw.
		}
	}
	// Audit lifecycle owns its own class-keyed warn-once (capture/completion/
	// barrier/chain). Constructed without a live ExtensionContext, so the
	// sink is the shared defaultWarn (see ./warn-sink). The
	// adapter's `warn` callback is reserved for session-terminal disable.
	const auditLifecycle = new AuditLifecycle({
		capture: captureWriteCandidate,
		complete: completeWriteCandidate,
	});
	// RunStats (upgrade2 item 4): one configurable usage row per logical run,
	// aggregated from authoritative message_end completions and distinct
	// tool_execution_start actions (toolCallId-deduplicated).
	const runStats = new RunStats();
	// Durable stats evidence is captured synchronously at terminal agent_end;
	// the line remains pending until the audit projection drain can place it.
	const pendingTerminalStats = new Map<string, PendingTerminalStats>();
	// `agent_end` serialization lives inside the lifecycle's
	// `enqueueAgentEnd` (generation-guarded chain; see audit-lifecycle.ts).
	// AdapterFailOpenFix: warn once per failure episode through the available
	// UI notification seam. A failing or absent notify (headless/RPC) must
	// never throw into the event stream.
	function warnAdapterFailure(context: ExtensionContext, error: unknown): void {
		if (adapterFailureWarned) return;
		adapterFailureWarned = true;
		const ui = context.ui as NotifyingUI;
		try {
			ui.notify?.(`omp-compact disabled: ${String(error)}`, "warning");
		} catch {
			// Best-effort: the warning itself must never throw.
		}
	}

	// Shared bring-up failure exit: probe-widget rollback, session disable,
	// one warning. Used by both install() === false and thrown construct.
	// Never throws into the host event stream.
	function failAdapterBringUp(
		context: ExtensionContext,
		ui: AdapterUI,
		candidate: RuntimeAdapter | undefined,
		reason: unknown,
	): undefined {
		rollbackAdapterFailure(ui, candidate);
		adapterDisabled = true;
		warnAdapterFailure(context, reason);
		return undefined;
	}

	function ensureAdapter(
		context: ExtensionContext,
	): RuntimeAdapter | undefined {
		// RuntimeModes: while globally disabled (OMP_COMPACT_PLUGIN=0 or
		// settings.enabled=false) the adapter must not (re)install; the next
		// enabled run boundary reinstalls cleanly.
		if (!modePolicy.enabled) return undefined;
		if (adapterDisabled) return undefined;
		if (adapter) return adapter;
		// Mid-session host-invariant rollback clears `adapter` via onDisabled
		// and sets adapterDisabled; the check above already covers that path.
		// AdapterFailOpenFix: host-probe capture, adapter construction, and
		// install run as one transaction. Any exception (a throwing setWidget
		// probe, a failing host getter, an install fault) must never escape
		// into the event stream — stock would re-fire ensureAdapter on every
		// event and re-throw each time. On failure the guard restores partial
		// own-instance effects, disables the adapter for the session, warns
		// once, and retries only at the next session boundary (dispose
		// resets). Headless root absence stays a quiet fail-open.
		const ui = context.ui as unknown as AdapterUI;
		let root: unknown;
		let candidate: RuntimeAdapter | undefined;
		try {
			root = captureHostRoot(ui);
			if (!root) return undefined;
			const timerContext = context as ExtensionContext & {
				setInterval?: (callback: () => void, ms?: number) => unknown;
				clearTimer?: (timer: unknown) => void;
			};
			const setTimer = timerContext.setInterval;
			const clearTimer = timerContext.clearTimer;
			const timers =
				typeof setTimer === "function" && typeof clearTimer === "function"
					? {
							setInterval: (callback: () => void, ms?: number) =>
								setTimer.call(timerContext, callback, ms),
							clearTimer: (timer: unknown) =>
								clearTimer.call(timerContext, timer),
						}
					: undefined;
			const notify = (context.ui as NotifyingUI).notify;
			candidate = new RuntimeAdapter({
				root,
				ui: adapterUI(context, root),
				timers,
				// RuntimeModes: the adapter snapshots mode per ledger at run
				// boundaries; rendering consults the frozen snapshot only.
				modePolicy,
				// AdvisorNotes: a display-only preference, read per render —
				// deliberately not frozen per run like the mode, because the
				// cards it repaints already exist in the transcript.
				compactAdvisorNotes: () => {
					const settings = settingsStore.snapshot();
					return settings.enabled && settings.compactAdvisorNotes;
				},
				// Construction-time sessionManager reference from this event's
				// ExtensionContext — never a global settings/session lookup.
				// Methods on that manager stay live (getBranch/getCwd mutate in
				// place across /move and switchSession). context.cwd itself is
				// a createContext string snapshot and must NOT be read for path
				// display; displayPaths uses getCwd() instead.
				getBranch: () => {
					const manager = (context as ContextWithSessionManager).sessionManager;
					if (typeof manager?.getBranch !== "function") return undefined;
					const branch = manager.getBranch();
					return Array.isArray(branch) ? branch : undefined;
				},
				displayPaths: () => ({
					cwd: resolveSessionCwd(context),
					enabled: settingsStore.snapshot().compactPaths,
				}),
				// RunStats: render the terminal usage row after the run's
				// evidence drains. The hook fires only for terminal filtered
				// runs; everything here fails open. Actions/hasError come from
				// the aggregator itself (tool_execution_start dedup /
				// tool_execution_end errors), never from adapter mapping.
				onRunFinalized: (runId) => {
					const pending = pendingTerminalStats.get(runId);
					pendingTerminalStats.delete(runId);
					if (pending) {
						try {
							// The carrier was persisted synchronously at agent_end;
							// after audit drain, place only its already-frozen visual row.
							const statsAdapter = candidate;
							if (statsAdapter?.installed)
								statsAdapter.showStats(runId, pending.line);
						} catch {
							// A stats failure must not suppress the independent terminal
							// scrollback replay or disturb the answer.
							warnDecorativeOnce(
								"decorative-stats-failed",
								"omp-compact: decorative-stats-failed (usage row skipped)",
								context,
							);
						}
					}
					try {
						// D03: after the stats insertion attempt — also when stats
						// are disabled or usage is absent — replay the frozen native
						// scrollback exactly once through the capability-checked
						// exact-root `resetDisplay`.
						candidate?.replayAfterTerminalProjection();
					} catch {
						// Missing/incompatible capability, pending generation,
						// disposal or an adapter exception fails open.
						warnDecorativeOnce(
							"decorative-scrollback-failed",
							"omp-compact: decorative-scrollback-failed (native replay skipped)",
							context,
						);
					}
					try {
						// C10: once the filtered projection (including optional
						// scrollback replay) is complete, raw args/results and per-call
						// Git payloads are no longer needed. The adapter preserves the
						// immutable mutation/aggregate projection and never retires
						// compact-mode or abort/full diagnostics.
						candidate?.retireFilteredPayloads(runId);
					} catch {
						// Memory retirement is optional decoration; fail open.
						warnDecorativeOnce(
							"decorative-retire-failed",
							"omp-compact: decorative-retire-failed (payload retention kept)",
							context,
						);
					}
				},
				statsRenderer: (evidence) => {
					try {
						const statsSettings = settingsStore.snapshot().stats;
						if (!statsSettings.enabled) return undefined;
						return statsLine(
							resultFromEvidence(evidence),
							statsSettings,
							context.ui.theme,
						);
					} catch {
						return undefined;
					}
				},
				// Share the once-per-episode flag with warnAdapterFailure so an
				// install()-time #rollback warn and the bring-up failure path
				// never double-notify.
				warn:
					typeof notify === "function"
						? (message) => {
								if (adapterFailureWarned) return;
								adapterFailureWarned = true;
								notify.call(context.ui, message, "warning");
							}
						: undefined,
				// Host-invariant mid-session rollback: drop the live handle and
				// stay native until a session boundary. Reinstall is deliberately
				// refused — multiple transcripts / unpatchable core / settle
				// throws almost certainly recur immediately, and an unbounded
				// retry would warn/rollback-loop on every event.
				onDisabled: () => {
					adapter = undefined;
					adapterDisabled = true;
				},
			});
			if (!candidate.install()) {
				// install() already rolled the candidate back (and may have
				// warned through adapter.warn). Share the bring-up failure path
				// so the probe widget is re-cleared and a synthetic reason still
				// warns when the adapter had no warn sink. String reason — no
				// fake Error stack.
				return failAdapterBringUp(context, ui, candidate, "install failed");
			}
		} catch (error) {
			return failAdapterBringUp(context, ui, candidate, error);
		}
		adapter = candidate;
		return adapter;
	}

	function persistMutation(
		entry: MutationMessageDetails | LegacyMutationMessageDetails,
	): void {
		pi.appendEntry(MUTATION_MESSAGE_TYPE, entry);
	}

	function persistGit(entry: GitMessageDetails): void {
		pi.appendEntry(GIT_MESSAGE_TYPE, entry);
	}

	function persistStats(entry: RunStatsEvidence): void {
		pi.appendEntry(STATS_MESSAGE_TYPE, entry);
	}

	/**
	 * Freeze and persist a successful run's stats while the terminal assistant
	 * is still the session leaf. `agent_end` listeners are fire-and-forget in
	 * stock OMP, so waiting for audit work can otherwise append a carrier as a
	 * sibling of the next user branch, where getBranch() cannot recover it.
	 */
	function stageTerminalStats(
		runId: string,
		context: ExtensionContext,
	): boolean {
		if (pendingTerminalStats.has(runId)) return true;
		const usage = runStats.finalize();
		if (!usage) return false;
		const statsSettings = settingsStore.snapshot().stats;
		if (!statsSettings.enabled) return false;
		const line = statsLine(usage, statsSettings, context.ui.theme);
		if (!line) return false;
		pendingTerminalStats.set(runId, { line });
		try {
			persistStats(evidenceFromResult(usage, runId));
			return true;
		} catch {
			pendingTerminalStats.delete(runId);
			warnDecorativeOnce(
				"decorative-stats-failed",
				"omp-compact: decorative-stats-failed (usage row skipped)",
				context,
			);
			return false;
		}
	}

	registerRenderer<MutationMessageDetails | LegacyMutationMessageDetails>(
		MUTATION_MESSAGE_TYPE,
		(message, _context, theme) =>
			mutationMessageComponent(message.details, theme),
	);
	registerRenderer<GitMessageDetails>(
		GIT_MESSAGE_TYPE,
		(message, _context, theme) => gitMessageComponent(message.details, theme),
	);
	registerRenderer<RunStatsEvidence>(
		STATS_MESSAGE_TYPE,
		(message, _context, theme) => statsMessageComponent(message.details, theme),
	);

	listen("session_start", async (_event, context) => {
		// RuntimeModes: never install the runtime before the first settings
		// resolution — a persisted `enabled=false` must not see a transient
		// adapter (wrappers/timers) even for an instant.
		await modePolicy.ready();
		const current = ensureAdapter(context);
		const sessionManager = (context as ContextWithSessionManager)
			.sessionManager;
		const branch = sessionManager?.getBranch?.();
		if (Array.isArray(branch)) {
			// Restore view (upgrade2 item 3): entering an EXISTING session
			// (`omp -c`, `--resume`/picker, auto-resume) presents the
			// historical transcript immediately in compact view. The branch
			// is non-empty exactly when the session carries persisted
			// entries (`SessionManager.pathTo(leaf)`: a brand-new session
			// resets the index to empty, so `[]` never arms the override).
			// The override is one-shot: cleared at the next `agent_start`
			// boundary (ModePolicy.prepareRun), so the resumed session's
			// live runs keep the normal persisted mode policy.
			if (branch.length > 0) modePolicy.armRestoreOverride();
			current?.hydrateBranch(branch);
		}
	});

	listen("session_switch", async (event, context) => {
		// Restore view (upgrade2 item 3): an in-process entry into an
		// existing session (`/resume` picker, `ctx.switchSession`, reload)
		// arrives as `session_switch` with reason "resume" — emitted after
		// the target session's entries are loaded but BEFORE the caller's
		// `renderInitialMessages` rebuild. The adapter was disposed at
		// `session_before_switch`, so re-install it here while the exact
		// transcript instance is still patchable; the transcript `clear`
		// that follows (the rebuild boundary) then rehydrates the restored
		// branch under the armed override and replays compact. Explicitly
		// NOT applied to reason "new" (fresh session), "fork" (a derived
		// session keeps the in-memory conversation and never rebuilds the
		// transcript), or "handoff" (automatic compaction continuation) —
		// only a user-visible resume enters an existing session.
		if (event.reason !== "resume") return;
		await modePolicy.ready();
		if (!modePolicy.enabled) return;
		modePolicy.armRestoreOverride();
		ensureAdapter(context);
	});

	listen("session_compact", async () => {
		// Successful LLM compaction (manual /compact or auto context-full):
		// stock writes the compaction entry then rebuilds the transcript via
		// rebuildChatFromMessages with display.collapseCompacted (default
		// true) — only the post-summary tail is reconstructed while
		// getBranch() still walks the full path. Arm a one-shot suffix
		// permit so commitRebuild can pair the visible tail without forcing
		// compact mode on historical ledgers (unlike armRestoreOverride).
		// Emitted only after a successful compaction entry; cancelled/
		// failed compact never fires this event. Shake does not emit it.
		await modePolicy.ready();
		if (!modePolicy.enabled) return;
		modePolicy.armCollapsedRebuild();
	});

	listen("auto_compaction_end", async (event) => {
		// Auto-shake elides heavy tool-result content in place and stock
		// rebuilds the whole transcript from committed messages (both on
		// success and on the fallback path that reclaimed tokens before
		// handing off to another method). It writes no compaction entry, so
		// `session_compact` never fires for it. Unarmed, that rebuild binds
		// only while the replayed tool components match the branch's tool
		// states exactly — a long session, where reads re-collapse into one
		// group and pending/background tools are kept live by the replay,
		// misses that count and drops every visible card to native chrome for
		// the rest of the session (reopening the session renders compact,
		// which is what makes it look mode-related). A shake never rewrites
		// the branch, so the visible transcript stays a faithful replay of it
		// and suffix alignment is exactly the right pairing.
		//
		// The cancelled and benign-skip paths rebuild nothing, so they must
		// not leave a permit behind for the next unrelated clear. Other
		// actions either land a compaction entry (`session_compact` arms
		// them) or fail without rebuilding.
		if (event.action !== "shake") return;
		if (event.aborted || event.skipped) return;
		await modePolicy.ready();
		if (!modePolicy.enabled) return;
		modePolicy.armCollapsedRebuild();
	});

	listen("session_tree", async (event) => {
		// Committed `/tree` navigation (and equivalent navigateTree callers):
		// stock emits `session_tree` only AFTER the leaf move lands and BEFORE
		// the caller's `renderInitialMessages` rebuild (disposeChildren +
		// re-add). Same restore-view contract as in-process `/resume`: arm the
		// one-shot restore override so historical/collapsed tails bind under
		// the selected mode. Cancelled/no-op tree interactions never
		// emit this event, so they never arm. Rehydration still keys off the
		// transcript clear that follows — noteTreeIntent stays a no-op seam.
		await modePolicy.ready();
		if (modePolicy.enabled) modePolicy.armRestoreOverride();
		adapter?.noteTreeIntent(event);
	});

	listen("session_branch", async () => {
		// Committed `/branch` (AgentSession.branch and equivalent callers):
		// stock emits `session_branch` only AFTER the branched session file
		// lands and BEFORE the caller's `renderInitialMessages` rebuild
		// (disposeChildren + re-add in selector-controller /
		// extension-ui-controller). Same restore-view contract as committed
		// `/tree` and in-process `/resume`: arm the one-shot restore override
		// so historical/collapsed tails bind under the selected mode.
		// Cancelled session_before_branch never reaches this event.
		// Rehydration still keys off the transcript clear that follows —
		// this handler only arms; it does not begin a presentation generation.
		await modePolicy.ready();
		if (modePolicy.enabled) modePolicy.armRestoreOverride();
	});

	listen("agent_start", async (_event, context) => {
		// RuntimeModes: a logical run starts here and spans toolUse/
		// willContinue continuations. The mode snapshot is captured only at
		// the start (settings changes apply at the next idle boundary, never
		// mid-run); disabled runs are tracked as runs so a mid-run re-enable
		// still lands on the next boundary.
		if (!runActive) {
			const snapshot = await modePolicy.prepareRun();
			if (!snapshot.enabled) {
				// Global disable: transactionally dispose wrappers/timers;
				// the next enabled run boundary reinstalls cleanly.
				disableRuntime();
				runActive = true;
				// PostTurnShake: explicitly disarm at the true boundary — a
				// globally disabled run must never shake even if the prior
				// run was armed or OMP_COMPACT_SHAKE=1 forces auto-shake.
				postShake.beginRun({ enabled: false, thresholdTokens: 0 }, false);
				return;
			}
			runActive = true;
			ensureAdapter(context)?.beginRun();
			// PostTurnShake: capture this run's auto-shake settings exactly
			// once at the true logical-run boundary (immutable for one run;
			// env OMP_COMPACT_SHAKE=1/0 overrides JSON). Continuations never
			// re-snapshot, so mid-run settings changes are never observed.
			postShake.beginRun(
				resolveAutoShake(settingsStore.snapshot().autoShake, Bun.env),
				true,
			);
		}
		// RunStats: authoritative logical-run start (continuations keep the
		// open run; see RunStats.start()).
		runStats.start();
	});

	listen("message_update", async (event) => {
		adapter?.observeAssistantMessage(event.message);
	});

	// RunStats: the authoritative finalized completion. Stock emits
	// `message_end` for every settled message (agent-session.ts
	// #emitExtensionEvent), and the settled assistant message carries the
	// final usage — unlike streaming `message_update` deltas, which can be
	// coalesced or dropped at subscription boundaries. Role + structural
	// usage filter: advisor cards, non-assistant messages, and completions
	// without a real usage record never count, while an empty/all-zero usage
	// object is a legitimate completion and counts once.
	listen("message_end", async (event) => {
		const message = objectRecord(event.message);
		// AdvisorNotes: structured metadata for the compact card presentation.
		// Deliberately before the assistant filter — advisor cards are custom
		// (`role: custom`) messages. Display-only: the payload is parsed for
		// bounded notes metadata and never retained or re-emitted.
		adapter?.observeAdvisorMessage(message);
		if (message.role !== "assistant") return;
		if (!hasAssistantUsage(message)) return;
		runStats.observeAssistantMessage(message);
	});

	listen("tool_execution_start", async (event, context) => {
		// RunStats: count every distinct execution here, deduplicated by
		// toolCallId — independent of adapter mapping.
		runStats.recordTool(event.toolCallId);
		const current = ensureAdapter(context);
		current?.startTool(event);
		if (!current?.installed) return;
		// Audit routing is selected by the presentation registry: the effective
		// audit kind picks the lifecycle path, and every unregistered tool,
		// non-mutating tool, or `xd://` device dispatch riding the write
		// transport resolves to "none" (no evidence, native renderer).
		switch (resolveToolAudit(event.toolName, event.args)) {
			case "write":
				// Register the audit record synchronously, before the first
				// filesystem await: stock invokes listeners fire-and-forget, so a
				// fast tool_execution_end can otherwise arrive while the pre-image
				// capture is still in flight and find no record.
				{
					const cwd = resolveSessionCwd(context);
					auditLifecycle.startWrite({
						toolCallId: event.toolCallId,
						args: event.args,
						cwd,
						// Confinement root = live session cwd (same source as
						// display-path resolution). Injectable on the capture
						// API so tests can pin a fixture root; production never
						// invents a second mechanism.
						root: cwd,
					});
				}
				break;
			case "git-bash": {
				const command = objectRecord(event.args).command;
				if (typeof command === "string" && recognizeGitCommands(command)) {
					auditLifecycle.startSync(event.toolCallId, { command });
				}
				break;
			}
		}
	});

	listen("tool_execution_update", async (event) => {
		adapter?.updateTool({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.partialResult,
			isError: false,
			isPartial: true,
		});
	});

	listen("tool_execution_end", async (event: ToolExecutionEndEvent) => {
		// RunStats: failed executions mark the run's row as dirty (warning
		// separators); distinct action counting happens at start.
		if (event.isError === true) runStats.recordToolError(event.toolCallId);
		const current = adapter;
		current?.finishTool(event);
		if (!current?.installed) {
			auditLifecycle.discard(event.toolCallId);
			return;
		}
		const installed = current;
		// The same effective audit kind selects the end-path consumption;
		// unknown/native-live/routine tools and device dispatches fall through
		// with no audit work. `endWrite` is a no-op without a start record, so
		// a mid-call settings change cannot strand one. The end event carries
		// no `args` (see the host's `ToolExecutionEndEvent`), so the resolve
		// here can only see the static kind: device re-checking already
		// happened at start, and the no-op conditions above keep the residual
		// difference inert.
		switch (resolveToolAudit(event.toolName)) {
			case "write":
				// Consume the record registered synchronously at start; capture,
				// post-image audit, and publish run exactly once inside the
				// lifecycle-tracked completion, which the agent_end drain awaits.
				auditLifecycle.endWrite(
					{
						toolCallId: event.toolCallId,
						result: event.result,
						isError: event.isError === true,
					},
					(mutations) => {
						installed.setMutations(event.toolCallId, mutations);
						for (const entry of mutations) persistMutation(entry);
					},
				);
				return;
			case "edit": {
				const mutations = completeEditMutations(
					event.toolCallId,
					event.result,
					event.isError,
				);
				if (mutations.length > 0) {
					installed.setMutations(event.toolCallId, mutations);
					for (const entry of mutations) persistMutation(entry);
				}
				return;
			}
			case "git-bash":
				auditLifecycle.endSync(event.toolCallId, (payload) => {
					const git = pendingGitFrom(payload);
					if (!git) return;
					const records = formatGitRecords({
						command: git.command,
						resultText: textFromResult(event.result),
						isError: event.isError === true,
					});
					if (records && records.length > 0) {
						const first = records[0];
						if (!first) return;
						const details: GitMessageDetails = {
							version: 1,
							toolCallId: event.toolCallId,
							subcommand: first.subcommand,
							text: first.text,
							isError: first.isError,
							...commitDetails(first.text),
							records: records.map((record) => ({
								subcommand: record.subcommand,
								text: record.text,
								isError: record.isError,
							})),
						};
						installed.setGit(event.toolCallId, details);
						persistGit(details);
					}
				});
				break;
		}
	});

	listen("agent_end", (event, context) => {
		// Snapshot the run's audit records synchronously at emission: work
		// registered later (a continuation run) must not join this drain.
		const runAudit = auditLifecycle.snapshot();
		const phase = classifyAgentEnd(event);
		const terminal = phase !== "working";
		// RuntimeModes: a terminal settle closes the logical run; the next
		// agent_start (idle boundary) may apply fresh settings.
		if (terminal) runActive = false;
		// RunStats: only a terminal filtered settle produces the row;
		// aborts/errors (full) keep the diagnostic log, render no row, and
		// discard their open aggregation so nothing leaks into the next run.
		// toolUse/willContinue continuations keep the run open.
		const target = adapter;
		let terminalRunId: string | undefined;
		if (terminal) {
			try {
				terminalRunId = target?.captureTerminalRunId();
			} catch {
				// Incompatible host adapters remain native/fail-open.
			}
		}
		let pendingStatsRunId: string | undefined;
		if (phase === "filtered") {
			runStats.endRun(true);
			try {
				if (terminalRunId && stageTerminalStats(terminalRunId, context))
					pendingStatsRunId = terminalRunId;
			} catch {
				// Stats are decorative; persistence failure must not block terminal work.
			}
		} else if (phase === "working") runStats.endRun(false);
		else runStats.abort();
		// Serialized, generation-guarded link: overlap is safe, and a link
		// still queued when session_before_switch/shutdown disposes the
		// lifecycle can neither finalize the new session's adapter nor delay
		// its chain.
		const link = auditLifecycle.enqueueAgentEnd(runAudit, terminal, () => {
			target?.endRun(
				{
					messages: event.messages,
					willContinue: event.willContinue,
				},
				terminalRunId,
			);
		});
		void link.then(() => {
			try {
				target?.releaseTerminalRun(terminalRunId);
			} catch {
				// A stale/disposed adapter cannot retain a session-owned claim.
			}
			// `onRunFinalized` consumes the line on success. Failed/disposed drains
			// never render it and must not retain the frozen payload.
			if (pendingStatsRunId) pendingTerminalStats.delete(pendingStatsRunId);
		});
		// PostTurnShake: run strictly after the evidence drain settles AND
		// succeeded. The link resolves `true` only when the drain finished
		// and the run's audit/Git evidence was persisted; `false` means the
		// drain failed closed (barrier timeout), was skipped (session
		// switch/shutdown), or a terminal purge abandoned pending records
		// (their evidence was never persisted — the run still finalized
		// through the adapter's end-run work, it just must not shake). The
		// drain has already settled here, so no persistence barrier is
		// passed. The module is fail-open and never throws (noop catch is
		// defensive).
		void link
			.then((drained) => {
				if (!drained) return undefined;
				return postShake.onAgentEnd(event, context);
			})
			.catch(() => {
				// postShake is fail-open; this catch is defensive only.
				warnDecorativeOnce(
					"decorative-shake-failed",
					"omp-compact: decorative-shake-failed (auto-shake skipped)",
					context,
				);
				return undefined;
			});
		// Return the drain promise so an awaited dispatch (or the extension
		// runner) observes the evidence before agent_end settles; stock's
		// fire-and-forget emission ignores it.
		return link.then(() => undefined);
	});

	// RuntimeModes: transactional runtime teardown for a global disable —
	// restores every own-instance wrapper and clears timers, keeps the audit
	// lifecycle and the settings command alive for a clean re-enable.
	// Does NOT clear adapterDisabled: that latch is a statement about the
	// host (multiple transcripts / unpatchable core / settle throws), not
	// the user's preference. Only dispose() releases it at a session boundary.
	function disableRuntime(): void {
		adapter?.dispose();
		adapter = undefined;
		// Warn-dedup only: a later bring-up (or a session boundary that still
		// cannot host the runtime) may warn once more. Asymmetry with
		// adapterDisabled is deliberate — do not "tidy" the latch into here.
		adapterFailureWarned = false;
	}

	function dispose(): void {
		auditLifecycle.dispose();
		// ModePolicy: detach the settings subscription exactly once so store
		// notifications cannot outlive the instance; idempotent, and the next
		// session's ready()/prepareRun() re-arm it (reinitialization-safe).
		modePolicy.dispose();
		runActive = false;
		disableRuntime();
		// Host-invariant latch: only a session boundary clears it. Kept out
		// of disableRuntime() so a mid-session settings toggle cannot launder
		// a terminal host failure into a reinstall retry.
		adapterDisabled = false;
		// RunStats: drop partial aggregation state so a later session starts
		// clean.
		runStats.dispose();
		pendingTerminalStats.clear();
		// PostTurnShake: abort any in-flight shake and disarm stale settings.
		postShake.dispose();
		// Decorative warn-once may re-signal after a session boundary.
		decorativeWarned.clear();
	}

	listen("session_before_switch", async () => {
		dispose();
	});
	listen("session_shutdown", async () => {
		dispose();
	});
}
