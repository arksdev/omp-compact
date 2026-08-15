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
import { createSettingsStore } from "./config";
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
	openSettingsDialog,
	registerSettingsCommand,
	saveSettingsFlow,
} from "./settings-ui";
import { resolveToolRule } from "./tool-presentation-rules";
import { classifyAgentEnd } from "./turn-ledger";

interface PendingGit {
	command: string;
}

interface PendingTerminalStats {
	line: string;
}

const MAX_GIT_RESULT_TEXT = 8_192;

function pendingGitFrom(payload: unknown): PendingGit | undefined {
	if (payload && typeof payload === "object" && "command" in payload) {
		const command = payload.command; // unknown after `in` narrowing
		if (typeof command === "string") return { command };
	}
	return undefined;
}

// Note: objectRecord is intentionally duplicated per-module (no shared
// util) to keep each module independently tree-shakeable and avoid a
// cross-cutting import that would couple otherwise unrelated modules.
function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
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
		getToolsExpanded?: () => boolean;
	};
	return {
		theme: context.ui.theme,
		setWidget: context.ui.setWidget.bind(context.ui) as AdapterUI["setWidget"],
		requestRender: requestMethod(root, "requestRender"),
		requestComponentRender: requestMethod(root, "requestComponentRender"),
		getToolsExpanded:
			typeof ui.getToolsExpanded === "function"
				? () => ui.getToolsExpanded?.() ?? false
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
						store: settingsStore,
						notify: (level, message) => {
							try {
								ctx.ui.notify(message, level);
							} catch {
								// no-op
							}
						},
					});
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
	// AdapterFailOpenFix: one warning per failure episode. The disable state
	// (and this flag) reset only at session boundaries via dispose(); a
	// mid-session global disable/re-enable cycle may warn again if the host
	// still cannot host the runtime.
	let adapterFailureWarned = false;
	// RuntimeModes: a logical run spans toolUse/willContinue continuations,
	// each of which re-emits agent_start. While `runActive` the run's frozen
	// mode governs: settings changes (including global disable) apply only at
	// the next idle boundary, never mid-run.
	let runActive = false;
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
		const ui = context.ui as ExtensionContext["ui"] & {
			notify?: (message: string, level: "warning") => void;
		};
		try {
			ui.notify?.(`omp-compact disabled: ${String(error)}`, "warning");
		} catch {
			// Best-effort: the warning itself must never throw.
		}
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
			const notify = (
				context.ui as ExtensionContext["ui"] & {
					notify?: (message: string, level: "warning") => void;
				}
			).notify;
			candidate = new RuntimeAdapter({
				root,
				ui: adapterUI(context, root),
				timers,
				// RuntimeModes: the adapter snapshots mode per ledger at run
				// boundaries; rendering consults the frozen snapshot only.
				modePolicy,
				// C03: identity-matched current-branch resolver of the live
				// main session, taken from this event context's
				// sessionManager — never a global settings/session lookup.
				// The adapter consults it when a transcript rebuild begins
				// so the authoritative branch rehydrates under the current
				// persisted/effective settings.
				getBranch: () => {
					const manager = (
						context as ExtensionContext & {
							sessionManager?: {
								getBranch?: () => readonly unknown[];
							};
						}
					).sessionManager;
					if (typeof manager?.getBranch !== "function") return undefined;
					const branch = manager.getBranch();
					return Array.isArray(branch) ? branch : undefined;
				},
				displayPaths: () => ({
					cwd: context.cwd,
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
				warn:
					typeof notify === "function"
						? (message) => notify.call(context.ui, message, "warning")
						: undefined,
			});
			if (!candidate.install()) {
				adapterDisabled = true;
				return undefined;
			}
		} catch (error) {
			rollbackAdapterFailure(ui, candidate);
			adapterDisabled = true;
			warnAdapterFailure(context, error);
			return undefined;
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
			return false;
		}
	}

	pi.registerMessageRenderer<
		MutationMessageDetails | LegacyMutationMessageDetails
	>(MUTATION_MESSAGE_TYPE, (message, _context, theme) =>
		mutationMessageComponent(message.details, theme),
	);
	pi.registerMessageRenderer<GitMessageDetails>(
		GIT_MESSAGE_TYPE,
		(message, _context, theme) => gitMessageComponent(message.details, theme),
	);
	pi.registerMessageRenderer<RunStatsEvidence>(
		STATS_MESSAGE_TYPE,
		(message, _context, theme) => statsMessageComponent(message.details, theme),
	);

	pi.on("session_start", async (_event, context) => {
		// RuntimeModes: never install the runtime before the first settings
		// resolution — a persisted `enabled=false` must not see a transient
		// adapter (wrappers/timers) even for an instant.
		await modePolicy.ready();
		const current = ensureAdapter(context);
		const sessionManager = (
			context as ExtensionContext & {
				sessionManager?: { getBranch?: () => readonly unknown[] };
			}
		).sessionManager;
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

	pi.on("session_switch", async (event, context) => {
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

	pi.on("session_tree", async (event) => {
		// C05: `session_tree` is intent/coalescing metadata only — stock
		// emits it before the caller-side UI rebuild, so the actual
		// rehydration is keyed to the transcript `clear` that follows a
		// committed navigation. A cancelled/no-op tree interaction (Esc,
		// exact-real-leaf no-op) never clears and therefore never advances
		// the presentation generation.
		adapter?.noteTreeIntent(event);
	});

	pi.on("agent_start", async (_event, context) => {
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

	pi.on("message_update", async (event) => {
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
	pi.on("message_end", async (event) => {
		const message = objectRecord(event.message);
		if (message.role !== "assistant") return;
		if (!hasAssistantUsage(message)) return;
		runStats.observeAssistantMessage(message);
	});

	pi.on("tool_execution_start", async (event, context) => {
		// RunStats: count every distinct execution here, deduplicated by
		// toolCallId — independent of adapter mapping.
		runStats.recordTool(event.toolCallId);
		const current = ensureAdapter(context);
		current?.startTool(event);
		if (!current?.installed) return;
		// Audit routing is selected by the presentation registry: the rule's
		// audit kind picks the lifecycle path, and every unregistered or
		// non-mutating tool resolves to "none" (no evidence, native renderer).
		switch (resolveToolRule(event.toolName)?.audit ?? "none") {
			case "write":
				// Register the audit record synchronously, before the first
				// filesystem await: stock invokes listeners fire-and-forget, so a
				// fast tool_execution_end can otherwise arrive while the pre-image
				// capture is still in flight and find no record.
				auditLifecycle.startWrite({
					toolCallId: event.toolCallId,
					args: event.args,
					cwd: context.cwd,
				});
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

	pi.on("tool_execution_update", async (event) => {
		adapter?.updateTool({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.partialResult,
			isError: false,
			isPartial: true,
		});
	});

	pi.on("tool_execution_end", async (event: ToolExecutionEndEvent) => {
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
		// The same registry audit kind selects the end-path consumption;
		// unknown/native-live/routine tools fall through with no audit work.
		switch (resolveToolRule(event.toolName)?.audit ?? "none") {
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

	pi.on("agent_end", (event, context) => {
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
		// drain failed closed (barrier timeout) or was skipped (session
		// switch/shutdown), so the run must not shake. The drain has already
		// settled here, so no persistence barrier is passed. The module is
		// fail-open and never throws (noop catch is defensive).
		void link
			.then((drained) => {
				if (!drained) return undefined;
				return postShake.onAgentEnd(event, context);
			})
			.catch(() => undefined);
		// Return the drain promise so an awaited dispatch (or the extension
		// runner) observes the evidence before agent_end settles; stock's
		// fire-and-forget emission ignores it.
		return link.then(() => undefined);
	});

	// RuntimeModes: transactional runtime teardown for a global disable —
	// restores every own-instance wrapper and clears timers, keeps the audit
	// lifecycle and the settings command alive for a clean re-enable.
	function disableRuntime(): void {
		adapter?.dispose();
		adapter = undefined;
		adapterDisabled = false;
		// AdapterFailOpenFix: a session boundary may warn once more if the
		// host still cannot host the runtime.
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
		// RunStats: drop partial aggregation state so a later session starts
		// clean.
		runStats.dispose();
		pendingTerminalStats.clear();
		// PostTurnShake: abort any in-flight shake and disarm stale settings.
		postShake.dispose();
	}

	pi.on("session_before_switch", async () => {
		dispose();
	});
	pi.on("session_shutdown", async () => {
		dispose();
	});
}
