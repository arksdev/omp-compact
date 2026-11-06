import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	settings,
} from "@oh-my-pi/pi-coding-agent";
import { cfgExtensionTranscriptPresenters } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import type { KeyId } from "@oh-my-pi/pi-tui";
import type { EditCapture } from "./audit";

import {
	captureEditCandidates,
	captureWriteCandidate,
	completeEditCreateCandidate,
	completeEditMutations,
	completeWriteCandidate,
	releaseEditCandidates,
} from "./audit";
import { AuditLifecycle } from "./audit-lifecycle";
import { createSettingsStore, readDisplayCycleKeySync } from "./config";
import {
	describeShortcutConflict,
	type ShortcutConflictLike,
} from "./display-cycle";
import { resolveSessionCwd } from "./display-path";
import { formatGitRecords, recognizeGitCommands } from "./git-records";
import { IdleQueue } from "./idle-queue";
import {
	GIT_MESSAGE_TYPE,
	type GitMessageDetails,
	type LegacyMutationMessageDetails,
	MUTATION_MESSAGE_TYPE,
	type MutationMessageDetails,
	mutationBranchEntries,
	writeSourceEntryId,
} from "./messages";
import { ModePolicy } from "./mode-policy";
import { objectRecord } from "./object-record";
import { TranscriptPresenterState, ternNativeView } from "./presenter";
import { gitMessageComponent, mutationMessageComponent } from "./render";
import {
	evidenceFromResult,
	hasAssistantUsage,
	isRunStatsEvidence,
	RunStats,
	type RunStatsEvidence,
	resultFromEvidence,
	STATS_MESSAGE_CONTENT,
	STATS_MESSAGE_TYPE,
	StatsRow,
	statsLine,
} from "./run-stats";
import { SessionLedger } from "./session-ledger";
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

/** Where the presenter switch lives in `/settings`. */
const PRESENTER_SETTING_PATH =
	"/settings -> Tools -> Extensions -> Extension Transcript Presenters";
/**
 * Whether OMP has extension transcript presenters enabled.
 * Safe fallback to false if settings are unavailable or uninitialized.
 */
function isPresenterSettingEnabled(): boolean {
	try {
		return cfgExtensionTranscriptPresenters.get(settings) === true;
	} catch {
		return false;
	}
}

const MAX_GIT_RESULT_TEXT = 8_192;

/**
 * The branch as the audit sees it: scoped write carriers moved right after
 * the entry that issued their write (see `mutationBranchEntries`).
 */
function auditBranch(context: ExtensionContext): readonly unknown[] {
	const manager = context.sessionManager;
	return mutationBranchEntries(manager.getBranch(), manager.getEntries());
}

function writeSource(
	context: ExtensionContext,
	toolCallId: string,
	sourceEntryId?: string,
): string | undefined {
	const manager = context.sessionManager;
	if (sourceEntryId)
		return writeSourceEntryId(manager.getEntry(sourceEntryId), toolCallId) ===
			sourceEntryId
			? sourceEntryId
			: undefined;
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const source = writeSourceEntryId(branch[index], toolCallId);
		if (source) return source;
	}
	return undefined;
}

function pendingGitCommand(payload: unknown): string | undefined {
	const command = objectRecord(payload).command;
	return typeof command === "string" ? command : undefined;
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

export default function ompCompact(pi: ExtensionAPI): void {
	pi.setLabel("omp-compact");

	/**
	 * The latest event context: the session the plugin presents. Handlers
	 * refresh it on every event; the presenter, the idle wait and the stats
	 * row read it.
	 */
	let session: ExtensionContext | undefined;

	// Where the plugin's warnings go. A session with UI gets a notification;
	// a session without one logs to the host file log, because a subagent
	// shares the main TUI's terminal and a stderr write there leaves stray
	// rows in the frame. Stderr remains only before the first event.
	function warn(message: string): void {
		try {
			if (session === undefined) defaultWarn(message);
			else if (session.hasUI) session.ui.notify(message, "warning");
			else pi.logger.warn(`[omp-compact] ${message}`);
		} catch {
			// Best-effort: the warning itself must never throw.
		}
	}

	const listen = ((
		event: string,
		handler: (event: unknown, context: ExtensionContext) => unknown,
	) =>
		(pi.on as (event: string, handler: unknown) => void)(
			event,
			(payload: unknown, context: ExtensionContext) => {
				session = context;
				return handler(payload, context);
			},
		)) as unknown as ExtensionAPI["on"];

	/** Ask omp to draw these blocks again after the plugin's state changed. */
	function refresh(ids: readonly string[]): void {
		if (ids.length === 0) return;
		try {
			session?.ui.refreshTranscript(ids);
		} catch {
			// Decorative: the next data change asks again anyway.
		}
	}

	// Typed persistent settings store + /compact-settings command. The
	// command stays available when the runtime is globally disabled. The
	// store is per plugin INSTANCE: two sessions in one process must never
	// share settings state.
	const settingsStore = createSettingsStore({ env: Bun.env, warn });

	/** What holds a chord, or `undefined`: free, or the host gives no answer. */
	function shortcutConflict(chord: string): ShortcutConflictLike | undefined {
		try {
			return pi.getShortcutConflict(chord as KeyId);
		} catch {
			// No answer (an unparsable chord the host refuses): syntax rules.
			return undefined;
		}
	}

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
			hintPresenterSetting(ctx as unknown as ExtensionContext);
			const initial = await settingsStore.load();
			await openSettingsDialog(ctx.ui, {
				settings: initial,
				checkShortcut: (chord) =>
					describeShortcutConflict(chord, shortcutConflict(chord)),
				// `saveSettingsFlow` emits exactly one success notification, so
				// nothing is notified again after the dialog closes.
				onSave: async (next) => {
					await saveSettingsFlow(next, {
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
	// Registered unconditionally: the "off" step is part of the cycle, so a
	// globally disabled runtime must still answer the key that re-enables it.
	// The chord is read synchronously: omp binds the shortcuts the factory
	// declared and offers no way to unregister one, so a change only takes
	// effect after restarting OMP — exactly what the settings dialog reports.
	const cycleKey = registerDisplayCycleShortcut<ExtensionContext>(
		pi,
		readDisplayCycleKeySync({ env: Bun.env }),
		{
			description: "Cycle omp-compact display: compact / live / clear / off",
			handler: async (ctx) => {
				// omp calls shortcut handlers without awaiting them, so an async
				// rejection would escape to the process-level hook. The cycle is
				// decorative: it fails open with a warning instead.
				try {
					await cycleDisplayState({
						store: settingsStore,
						theme: ctx.ui.theme,
						notify: (level, message) => {
							try {
								ctx.ui.notify(message, level);
							} catch {
								// Headless/RPC notify is a no-op.
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
	let cycleKeyChecked = false;

	// One settings snapshot per logical run, captured at agent_start; settings
	// changes (incl. global disable) apply at the next run boundary.
	const modePolicy = new ModePolicy(settingsStore);
	modePolicy.prime();

	const ledger = new SessionLedger({
		restoredMode: () => modePolicy.historical(),
		displayPaths: () => ({
			cwd: session ? resolveSessionCwd(session) : "",
			enabled: settingsStore.snapshot().compactPaths,
		}),
	});

	/** Walk the current branch into the ledger once; the restored call ids. */
	function restoreHistory(): readonly string[] {
		if (ledger.restored || !session) return [];
		try {
			return ledger.restore(auditBranch(session));
		} catch {
			// An unreadable branch leaves history on omp's own cards.
			return [];
		}
	}

	/** Advisor notes show compact only while the plugin is on (live settings). */
	function compactAdvisorNotes(): boolean {
		const settings = settingsStore.snapshot();
		return settings.enabled && settings.compactAdvisorNotes;
	}

	const presenter = new TranscriptPresenterState({
		ledger,
		restore: () => {
			restoreHistory();
		},
		theme: () => (session?.hasUI ? session.ui.theme : undefined),
		historicalMode: () => modePolicy.historical(),
		compactAdvisorNotes,
		nativeView: () => ternNativeView(Bun.env),
	});
	pi.registerTranscriptPresenter(presenter.present);

	// The advisor switch is a live display preference: the cards already in
	// the transcript follow a save (or the display cycle) at once. omp
	// redraws only the cards whose answer changed.
	settingsStore.subscribe(() => refresh(presenter.advisorIds()));

	/**
	 * The branch changed under the transcript (a new session, resume,
	 * `/tree`, `/branch`, compaction): walk it again and ask omp about the
	 * restored calls, in case it drew them before the plugin knew them.
	 */
	function reloadHistory(): void {
		ledger.invalidateHistory();
		refresh(restoreHistory());
	}

	const auditLifecycle = new AuditLifecycle({
		capture: captureWriteCandidate,
		complete: completeWriteCandidate,
		warn,
	});
	// RunStats: one usage row per logical run, aggregated from message_end
	// completions and distinct tool_execution_start actions.
	const runStats = new RunStats();
	const idle = new IdleQueue();
	/** Bumped at each session boundary: older stats belong to another session. */
	let statsGeneration = 0;
	let presenterHintShown = false;

	/** Once per process: notify when transcript presenters setting is not enabled. */
	function hintPresenterSetting(context: ExtensionContext): void {
		if (presenterHintShown || presenter.asked) return;
		if (!context.hasUI || context.mode !== "tui") return;
		if (isPresenterSettingEnabled()) return;
		presenterHintShown = true;
		try {
			context.ui.notify(
				`omp-compact draws nothing until transcript presenters are on: ${PRESENTER_SETTING_PATH}`,
				"warning",
			);
		} catch {
			// Best-effort hint.
		}
	}

	function sendStats(evidence: RunStatsEvidence): void {
		const stats = settingsStore.snapshot().stats;
		if (!stats.enabled) return;
		const theme = session?.ui.theme;
		const line = theme
			? statsLine(resultFromEvidence(evidence), stats, theme)
			: "";
		if (!line) return;
		pi.sendMessage<RunStatsEvidence>(
			{
				customType: STATS_MESSAGE_TYPE,
				// A fixed marker, not the line: whatever reads session messages
				// directly (an advisor) must not quote the stats. The row is
				// drawn from `details`; the content stays non-empty for
				// providers should the plugin be removed later.
				content: STATS_MESSAGE_CONTENT,
				display: true,
				details: evidence,
			},
			// omp's silent idle append: persisted with its details and added to
			// the chat. `triggerTurn: false` alone rebuilds the whole transcript,
			// which duplicates scrollback in tmux and resets expanded cards.
			{ deliverAs: "nextTurn" },
		);
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
		(message, _context, theme) => {
			const evidence = message.details;
			if (!isRunStatsEvidence(evidence)) return undefined;
			return new StatsRow(
				() => {
					const stats = settingsStore.snapshot().stats;
					return stats.enabled
						? statsLine(resultFromEvidence(evidence), stats, theme)
						: "";
				},
				{
					available: () => {
						const run = ledger.run(evidence.runId);
						return run !== undefined && presenter.hidesCalls(run);
					},
					shown: () => ledger.run(evidence.runId)?.revealed === true,
					toggle: () => {
						const run = ledger.run(evidence.runId);
						if (!run) return;
						run.revealed = !run.revealed;
						refresh([...presenter.hiddenCallIds(run), ...run.leaves]);
					},
				},
			);
		},
	);

	// The stats row is for the user only: it never reaches the model.
	pi.on("context", (event) => {
		const messages = event.messages.filter(
			(message) =>
				message.role !== "custom" || message.customType !== STATS_MESSAGE_TYPE,
		);
		return messages.length === event.messages.length ? undefined : { messages };
	});

	/**
	 * `isIdle()` is only "not streaming": omp replaces the session before it
	 * announces the switch, so a waiting row would land in the target session.
	 * A vetoed transition loses that one row.
	 */
	function dropPendingStats(): void {
		statsGeneration++;
		idle.clear();
	}

	function dispose(): void {
		dropPendingStats();
		auditLifecycle.dispose();
		modePolicy.dispose();
		runStats.dispose();
		ledger.reset();
	}

	listen("session_start", async (_event, context) => {
		dispose();
		await modePolicy.ready();
		reloadHistory();
		hintPresenterSetting(context);
		if (!cycleKeyChecked) {
			cycleKeyChecked = true;
			const conflict = shortcutConflict(cycleKey);
			if (
				context.hasUI &&
				(conflict?.kind === "reserved" || conflict?.kind === "keybinding")
			)
				warn(
					`omp-compact: cycle shortcut ${describeShortcutConflict(cycleKey, conflict)} in /compact-settings`,
				);
		}
	});

	listen("session_switch", async (event) => {
		// A fork keeps the in-memory conversation and never rebuilds it.
		if (event.reason === "fork") return;
		dispose();
		await modePolicy.ready();
		reloadHistory();
	});
	listen("session_before_switch", () => dropPendingStats());
	listen("session_before_tree", () => dropPendingStats());
	listen("session_before_branch", () => dropPendingStats());
	listen("session_tree", async () => reloadHistory());
	listen("session_branch", async () => reloadHistory());
	listen("session_compact", async () => reloadHistory());

	listen("agent_start", async () => {
		// A logical run starts here and spans toolUse/willContinue
		// continuations; its settings are captured only at the true start.
		ledger.beginRun(() => modePolicy.prepareRun());
		runStats.start();
	});

	// RunStats: the authoritative finalized completion. Advisor cards,
	// non-assistant messages and completions without a usage record never
	// count; an empty/all-zero usage object counts once.
	listen("message_end", async (event) => {
		const message = objectRecord(event.message);
		if (message.role !== "assistant" || !hasAssistantUsage(message)) return;
		runStats.observeAssistantMessage(message);
	});

	listen("tool_execution_start", async (event, context) => {
		runStats.recordTool(event.toolCallId);
		const call = ledger.startCall(event.toolCallId, event.toolName, event.args);
		if (!call?.run.mode.enabled) return;
		// Audit routing follows the presentation registry: every unregistered
		// tool, non-mutating tool, or `xd://` device dispatch riding the write
		// transport resolves to "none" (no evidence).
		switch (resolveToolAudit(event.toolName, event.args)) {
			case "write": {
				// Register the audit record synchronously, before the first
				// filesystem await: omp invokes listeners fire-and-forget, so a
				// fast tool_execution_end can otherwise find no record.
				const cwd = resolveSessionCwd(context);
				auditLifecycle.startWrite(
					{ toolCallId: event.toolCallId, args: event.args, cwd, root: cwd },
					writeSource(context, event.toolCallId),
				);
				break;
			}
			case "edit": {
				const cwd = resolveSessionCwd(context);
				const capture = captureEditCandidates({
					toolCallId: event.toolCallId,
					args: event.args,
					cwd,
					root: cwd,
				});
				auditLifecycle.startSync(event.toolCallId, capture, {
					targets: capture.targets,
					release: () => releaseEditCandidates(capture),
				});
				break;
			}
			case "git-bash": {
				const command = objectRecord(event.args).command;
				if (typeof command === "string" && recognizeGitCommands(command))
					auditLifecycle.startSync(event.toolCallId, { command });
				break;
			}
		}
	});

	listen("tool_execution_end", async (event, context) => {
		if (event.isError === true) runStats.recordToolError(event.toolCallId);
		ledger.settleCall(event.toolCallId);
		if (!ledger.call(event.toolCallId)?.run.mode.enabled) {
			auditLifecycle.discard(event.toolCallId);
			return;
		}
		const id = event.toolCallId;
		// The end event carries no args, so only the static audit kind is
		// known here; `endWrite`/`endSync` are no-ops without a start record.
		switch (resolveToolAudit(event.toolName)) {
			case "write":
				auditLifecycle.endWrite(
					{ toolCallId: id, result: event.result, isError: event.isError },
					(mutations, payload) => {
						if (
							typeof payload !== "string" ||
							writeSource(context, id, payload) !== payload
						)
							throw new Error("write audit source unavailable");
						for (const entry of mutations) {
							entry.sourceEntryId = payload;
							pi.appendEntry(MUTATION_MESSAGE_TYPE, entry);
						}
						if (
							writeSource(context, id) === payload &&
							ledger.setMutations(id, mutations)
						)
							refresh([id]);
					},
				);
				return;
			case "edit":
				auditLifecycle.endSync(id, (payload) => {
					// Only the edit-start path constructs this in-process payload.
					const capture = payload as EditCapture | undefined;
					const mutations = completeEditMutations(
						id,
						event.result,
						event.isError,
						capture
							? (file) => completeEditCreateCandidate(capture, file)
							: undefined,
					);
					if (mutations.length === 0) return;
					for (const entry of mutations)
						pi.appendEntry(MUTATION_MESSAGE_TYPE, entry);
					if (ledger.setMutations(id, mutations)) refresh([id]);
				});
				return;
			case "git-bash":
				auditLifecycle.endSync(id, (payload) => {
					const command = pendingGitCommand(payload);
					if (command === undefined) return;
					const records = formatGitRecords({
						command,
						resultText: textFromResult(event.result),
						isError: event.isError,
					});
					const first = records?.[0];
					if (!records || !first) return;
					const details: GitMessageDetails = {
						version: 1,
						toolCallId: id,
						subcommand: first.subcommand,
						text: first.text,
						isError: first.isError,
						records: records.map((record) => ({
							subcommand: record.subcommand,
							text: record.text,
							isError: record.isError,
						})),
					};
					pi.appendEntry(GIT_MESSAGE_TYPE, details);
					if (ledger.setGit(id, details)) refresh([id]);
				});
				return;
		}
	});

	listen("agent_end", (event, context) => {
		// Snapshot the run's audit records synchronously at emission: work
		// registered later (a continuation) must not join this drain.
		const runAudit = auditLifecycle.snapshot();
		const phase = classifyAgentEnd(event);
		const run = ledger.endRun(event);
		// RunStats: only a terminal answer produces the row; aborts/errors
		// keep the diagnostic log, render no row, and discard their open
		// aggregation. Continuations keep the run open.
		let evidence: RunStatsEvidence | undefined;
		if (phase === "filtered") {
			runStats.endRun(true);
			const usage = runStats.finalize();
			if (usage && run?.mode.enabled)
				evidence = evidenceFromResult(usage, run.id, run.calls.at(-1)?.id);
		} else if (phase === "working") runStats.endRun(false);
		else runStats.abort();
		const link = auditLifecycle.enqueueAgentEnd(
			runAudit,
			phase !== "working",
			() => {
				if (run && phase !== "working" && ledger.finalizeRun(run, phase))
					refresh([...run.calls.map((call) => call.id), ...run.leaves]);
			},
		);
		const generation = statsGeneration;
		if (phase !== "working")
			void link.then(() => {
				if (generation !== statsGeneration) return;
				// Sent only once the session is idle: a `nextTurn` message sent
				// while it still reports busy stays hidden until the next turn.
				idle.push(
					() => {
						if (generation !== statsGeneration) return;
						if (evidence) sendStats(evidence);
						hintPresenterSetting(context);
					},
					() => context.isIdle(),
				);
			});
		// Return the drain so an awaiting dispatcher sees the evidence land.
		return link.then(() => undefined);
	});

	listen("session_shutdown", async () => {
		dispose();
	});
}
