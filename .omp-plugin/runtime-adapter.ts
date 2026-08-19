import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

import type { DisplayPathOptions } from "./display-path";
import {
	HostAdapter1731,
	isBashExecutionComponent,
	isEvalExecutionComponent,
	isLateDiagnosticsMessageComponent,
	isReadGroupComponent,
	isSkillMessageComponent,
	isTodoReminderComponent,
	isToolComponent,
	isTranscriptHost,
	isTtsrNotificationComponent,
	transcriptCapabilities,
} from "./host-adapter";
import { isPayloadWithinBudget } from "./hydration-bounds";
import type { GitMessageDetails, MutationMessageDetails } from "./messages";
import { DEFAULT_RUN_MODE, type ModePolicy } from "./mode-policy";
import { objectRecord } from "./object-record";
import { DescriptorPatch } from "./patch-kit";
import {
	type ExpandObservedState,
	injectRulesFromTtsrComponent,
	lateDiagnosticsFromComponent,
	renderCompactToolRows,
	renderInjectRuleRows,
	renderLateDiagnosticsRow,
	renderSkillMessageRow,
	renderTodoReminderRow,
	renderUserExecutionRow,
	skillMessageFromComponent,
	terminalGitSummaryLine,
	todoReminderFromComponent,
	type UserExecutionObservedState,
	userBashExecutionFromComponent,
	userEvalExecutionFromComponent,
} from "./render";
import { decideReadGroupRender, decideToolRender } from "./render-decision";
import type { RunStatsEvidence } from "./run-stats";
import {
	type AgentEndInput,
	type RebuildSnapshot,
	RuntimeSessionState,
	type ToolResultInput,
	type ToolStartInput,
} from "./runtime-session-state";
import { resolveToolRule } from "./tool-presentation-rules";
import {
	type RenderableBlock,
	TranscriptFold,
	type TranscriptHost,
} from "./transcript-fold";
import { classifyAgentEnd, type TurnLedger } from "./turn-ledger";

// Re-exported for index.ts and the test surface: the input contracts are
// session-state concepts now, the adapter is their event-driven facade.
export type {
	AgentEndInput,
	ToolResultInput,
	ToolStartInput,
} from "./runtime-session-state";

const EMPTY_LINES: readonly string[] = Object.freeze([]);

export interface AdapterUI {
	theme?: Theme;
	setWidget?(key: string, content: unknown): void;
	/**
	 * Host TUI paint request. Typed `void` on purpose: every adapter caller
	 * fires-and-forgets (no status is consumed). Stock today returns nothing
	 * meaningful; if a future host surfaces a code, wire it at the
	 * `requestMethod` binding in index.ts — do not start reading it here
	 * without a caller that needs it.
	 */
	requestRender?(): void;
	/** Same discard contract as `requestRender` for a single component. */
	requestComponentRender?(component: unknown): void;
	// Live tool-output expansion state. Stock pre-sets `setExpanded(...)` on
	// components before the adapter can wrap them, so the initial expanded
	// state is read here instead of guessed from the native presentation.
	getToolsExpanded?(): boolean;
}

export interface TimerContext {
	setInterval?(callback: () => void, ms?: number): unknown;
	clearTimer?(timer: unknown): void;
}

export interface RuntimeAdapterOptions {
	root: unknown;
	ui: AdapterUI;
	timers?: TimerContext;
	warn?(message: string): void;
	/**
	 * Display-path options for the run, resolved once when a new ledger
	 * starts (agent_start or branch hydration): the session cwd and the
	 * `compactPaths` snapshot stay immutable for that logical run.
	 */
	displayPaths?: () => DisplayPathOptions;
	/**
	 * Terminal run seam (owned by endRun): invoked once per
	 * logical run when it reaches a successful terminal answer — in every
	 * presentation mode (`live` filtered, `compact` full-retained log,
	 * `clear` hidden rows). Aborts, errors and working continuations never
	 * fire it. Runs after the ledger finalizes (its evidence has drained)
	 * and the run render bumps. RunStats registers it to render the usage
	 * row above the assistant answer; the terminal scrollback
	 * replay after that insertion attempt.
	 */
	onRunFinalized?(runId: string): void;
	/**
	 * Replay seam (RunStats): rebuild a themed stats line from persisted
	 * evidence when a session branch hydrates. Return `undefined` to skip. A
	 * hydrated stats carrier is anchored to that run's bound tool/read block;
	 * a final no-tool run may fall back to the branch tail. Earlier no-tool
	 * runs fail open rather than guessing transcript positions.
	 */
	statsRenderer?: (evidence: RunStatsEvidence) => string | undefined;
	// Per-run mode policy. The session snapshots the mode when
	// a ledger starts (agent_start or branch hydration) and keeps it frozen
	// for that logical run; settings changes apply at the next boundary.
	modePolicy?: ModePolicy;
	/**
	 * Identity-matched current-branch resolver of the live main
	 * session, wired by index.ts from the event context's sessionManager —
	 * never a global settings/session lookup. Consulted when a transcript
	 * rebuild begins (and by branch hydration callers). Absent, throwing,
	 * or non-array results fail open: the rebuild keeps only the preserved
	 * active working ownership and leaves ambiguous surfaces native.
	 */
	getBranch?: () => readonly unknown[] | undefined;
	/**
	 * Host-invariant failure seam: fired once from `#rollback` after the
	 * adapter has disposed itself. Index clears its live handle and marks
	 * the session native — never from plain `dispose()` (session boundary /
	 * settings disable), which is an intentional teardown the owner already
	 * drives. Must never throw into the host event stream.
	 */
	onDisabled?: () => void;
}

function isCompactCustomMessage(value: unknown): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	const message = objectRecord(candidate.message);
	return (
		typeof candidate.render === "function" &&
		typeof message.customType === "string" &&
		message.customType.startsWith("omp-compact-")
	);
}

/**
 * Host/event orchestrator of the compact plugin. Owns no run state:
 * ComponentBinding maps components ↔ toolCallIds, RuntimeSessionState owns
 * ledgers/records/projections/rebuild lifecycle, RenderDecision maps the
 * pure presentation matrix, TranscriptFold wires the block fold. This class
 * coordinates discovery, patching, fold installation, timers, UI render
 * requests and the C rebuild boundary.
 */
export class RuntimeAdapter {
	readonly #host: HostAdapter1731;
	readonly #ui: AdapterUI;
	readonly #timers: TimerContext | undefined;
	readonly #warn: ((message: string) => void) | undefined;
	readonly #session: RuntimeSessionState;
	readonly #patchedComponents = new Map<object, DescriptorPatch>();
	/** Exact-instance TTSR notification render overrides (not fold-owned). */
	readonly #ttsrPatches = new Map<object, DescriptorPatch>();
	/** Exact-instance todo-reminder render overrides (not fold-owned). */
	readonly #todoReminderPatches = new Map<object, DescriptorPatch>();
	/**
	 * Exact-instance user bash/python execution overrides (not fold-owned).
	 * Tracks observed setComplete/setExpanded state because exit codes live
	 * in private fields on the stock components.
	 */
	readonly #userExecutionPatches = new Map<object, DescriptorPatch>();
	readonly #userExecutionState = new WeakMap<
		object,
		UserExecutionObservedState
	>();
	/** Exact-instance skill-prompt render overrides (not fold-owned). */
	readonly #skillPatches = new Map<object, DescriptorPatch>();
	readonly #skillExpandState = new WeakMap<object, ExpandObservedState>();
	/** Exact-instance late-diagnostics render overrides (not fold-owned). */
	readonly #lateDiagnosticsPatches = new Map<object, DescriptorPatch>();
	readonly #lateDiagnosticsExpandState = new WeakMap<
		object,
		ExpandObservedState
	>();
	readonly #discoveryPatches = new Map<object, DescriptorPatch>();
	#transcript: TranscriptHost | undefined;
	#fold: TranscriptFold | undefined;
	#timer: unknown;
	#disposed = false;
	// Presentation generation: the exact transcript `clear` is the
	// rebuild boundary. RuntimeSessionState owns the generation counter;
	// each boundary returns the new token and this class schedules exactly
	// one microtask guarded by it. A newer clear or dispose invalidates
	// stale callbacks, so two quick rebuilds settle only the latest
	// generation. `#rebuildPending` marks a clear between the detach and
	// the microtask settlement (the settle commits the rebuild through
	// RuntimeSessionState.commitRebuild, which rehydrates the branch and
	// rebinds); `#rebuildSnapshot` carries the preserved active ownership
	// between the boundary and its settlement.
	#pendingGeneration: number | undefined;
	#rebuildPending = false;
	#rebuildSnapshot: RebuildSnapshot | undefined;
	/** Exact-instance transcript patches (addChild observer + clear boundary). */
	readonly #transcriptPatches: DescriptorPatch[] = [];
	readonly #getBranch: (() => readonly unknown[] | undefined) | undefined;
	readonly #onRunFinalized: ((runId: string) => void) | undefined;
	readonly #onDisabled: (() => void) | undefined;

	constructor(options: RuntimeAdapterOptions) {
		this.#host = new HostAdapter1731(options.root);
		this.#ui = options.ui;
		this.#timers = options.timers;
		this.#warn = options.warn;
		this.#onRunFinalized = options.onRunFinalized;
		this.#onDisabled = options.onDisabled;
		this.#getBranch = options.getBranch;
		this.#session = new RuntimeSessionState({
			modePolicy: options.modePolicy,
			displayPaths: options.displayPaths,
			statsRenderer: options.statsRenderer,
			placeStatsCarrier: (transcript, index, carrier, options) =>
				this.#host.insertTranscriptChildAt(transcript, index, carrier, options),

			getToolsExpanded: options.ui.getToolsExpanded
				? () => options.ui.getToolsExpanded?.() === true
				: undefined,
		});
	}

	/**
	 * Whether the fold is live on a discovered transcript. Distinct from a
	 * successful `install()`: zero candidates still return true from
	 * `install()` (discovery observe + spinner, fail-open) while this stays
	 * false until `#installTranscript` creates the fold. Index audit routing
	 * and stats placement gate on this flag so a pre-transcript adapter never
	 * pretends UI is ready.
	 */
	get installed(): boolean {
		return this.#fold !== undefined;
	}

	/**
	 * Probe host + arm discovery. Returns false only on hard failure
	 * (rollback). Zero transcript candidates is success: the tree is watched
	 * and a later addChild installs the fold; `installed` remains false until
	 * then.
	 */
	install(): boolean {
		if (this.#disposed) return false;
		try {
			const candidates = this.#host.collectTranscriptCandidates();
			if (candidates.length > 1)
				throw new Error("multiple transcript containers");
			const transcript = candidates[0];
			if (candidates.length === 1 && transcript)
				this.#installTranscript(transcript);
			else if (candidates.length === 0) this.#observeTree(this.#host.root, 0);
			this.#ensureSpinner();
			return true;
		} catch (error) {
			this.#rollback(`omp-compact disabled: ${String(error)}`);
			return false;
		}
	}

	beginRun(): void {
		if (this.#disposed) return;
		this.#session.beginRun();
	}

	hydrateBranch(entries: readonly unknown[]): void {
		if (this.#disposed) return;
		if (this.#session.hydrateBranch(entries)) {
			// Schedule one generation-guarded settlement microtask
			// so a resumed session with committed startup rows replays
			// through the optional exact-root `resetDisplay` once mapping
			// is validated (missing/incompatible capability fails open, no
			// call).
			this.#beginSettlement();
		}
	}

	/**
	 * `session_tree` is optional intent/coalescing metadata only —
	 * stock emits it before the caller-side UI rebuild, so it never begins
	 * a presentation generation here. The exact transcript `clear` that
	 * follows a committed navigation is the only rebuild boundary; a
	 * cancelled or no-op tree interaction never clears and therefore never
	 * advances the generation. Kept as an explicit seam so the intent
	 * plumbing is observable and future coalescing has a home.
	 */
	noteTreeIntent(_event: unknown): void {
		// Deliberately no side effects: rehydration is keyed to the
		// transcript clear, never to this event.
	}

	/**
	 * Public replay seam: generation-guarded, capability-checked full
	 * scrollback replay of the current transcript through the exact-root
	 * `TUI.resetDisplay()`. Fires only when the presentation mapping is
	 * validated (installed, current generation, no pending settlement) and
	 * the capability exists; missing/incompatible hosts fail open and the
	 * method never throws. Safe to call outside the rebuild path — a
	 * future terminal-replay caller reuses it after its own state
	 * changes.
	 */
	replayCurrentPresentation(): boolean {
		if (this.#disposed) return false;
		// A settlement is still pending: the mapping is not yet validated.
		if (this.#pendingGeneration !== undefined) return false;
		if (!this.#transcript || !this.#fold?.installed) return false;
		if (!this.#host.tuiCapabilities().resetDisplay) return false;
		try {
			// Retire the container's committed-scrollback diff cache so
			// the root's resetDisplay re-derives rows through the patched
			// renders. Without this, finalized blocks wholly inside the
			// committed prefix replay their stale native rows and a resumed
			// session (hydrated without any clear) never visibly applies the
			// compact policy — the rebuild path already bumps the generation
			// through clear, so this is an idempotent extra invalidation
			// there. Optional capability: hosts without `invalidate` fail
			// open (fresh containers have no stale segments to retire).
			const transcript = this.#transcript as {
				invalidate?: () => void;
			};
			if (typeof transcript.invalidate === "function") transcript.invalidate();
			this.#host.resetDisplay();
			return true;
		} catch {
			// An incompatible host method fails open: the presentation
			// stays native rather than breaking the session.
			return false;
		}
	}

	/**
	 * Terminal scrollback replay seam: invoked once per successful
	 * filtered terminal run, after the terminal projection and the stats
	 * carrier insertion. Stock freezes mutable live-region rows into native
	 * scrollback when they move above the viewport, so a filtered answer
	 * leaves frozen native rows behind; replaying the full presentation
	 * through the exact-root `resetDisplay` re-derives every row through
	 * the patched renders. Gates: the run must settle filtered (compact
	 * mode finalizes as a full retained log whose projection never
	 * changed, and aborts/errors/continuations never reach this seam), the
	 * fold must be installed with structured committed rows, and the
	 * exact-root capability must exist. Disposed/session-switched adapters,
	 * a pending generation, a missing capability and exceptions all fail
	 * open inside the delegated `replayCurrentPresentation()`.
	 */
	replayAfterTerminalProjection(): boolean {
		if (this.#session.activeLedger?.phase !== "filtered") return false;
		if (!this.#fold?.installed) return false;
		if (!this.#fold.hasCommittedRows()) return false;
		return this.replayCurrentPresentation();
	}

	observeAssistantMessage(message: unknown): void {
		if (this.#disposed) return;
		const ledger = this.#session.activeLedger;
		// Strictly non-creating and non-allocating. A message_update belongs
		// to the logical run that is actively streaming, but stock delivers
		// extension events fire-and-forget (message_update events queue
		// behind earlier stream deltas while agent_end/agent_start are
		// delivered directly), so a delta emitted for a previous run can be
		// handled after that run's terminal agent_end — or after the next
		// run's agent_start. Only the active working ledger may be touched:
		// never fabricate a ledger (ensureLedger) and never allocate a
		// state for an unknown id — tool_execution_start is the sole state
		// allocator. The observer only enriches an EXISTING state of the
		// captured working ledger; a stale delta of a previous run would
		// otherwise pollute the next run's ledger and block its first
		// tool's order binding.
		if (ledger?.phase !== "working") return;
		const contents = objectRecord(message).content;
		if (!Array.isArray(contents)) return;
		for (const content of contents) {
			const call = objectRecord(content);
			if (
				call.type !== "toolCall" ||
				typeof call.id !== "string" ||
				typeof call.name !== "string"
			)
				continue;
			const state = this.#session.state(call.id);
			if (!state || state.ledger !== ledger) continue;
			// Same retained-payload budget as startState/hydrate: over-budget
			// stream deltas must not reintroduce a dropped args blob.
			state.args = isPayloadWithinBudget(call.arguments)
				? call.arguments
				: undefined;
		}
		this.#session.binding.tryBindByOrder(ledger);
	}

	startTool(input: ToolStartInput): void {
		if (this.#disposed) return;
		const state = this.#session.startState(input);
		// Oversized/missing ids refuse allocation (live ≡ hydration bounds);
		// empty provisional ids still allocate and bind below.
		if (!state) return;
		// Stock hosts create the read group and call updateArgs BEFORE this
		// extension event arrives: bind any group that already observed this
		// id, completing the mapping that updateArgs could not resolve yet.
		this.#session.binding.bindByObservedId(input.toolCallId, state);
		this.#observeTree(this.#host.root, 0);
		this.#session.binding.tryBindByOrder(this.#session.activeLedger);
		this.#requestRender(state.component);
		this.#ensureSpinner();
	}

	updateTool(input: ToolResultInput): void {
		if (this.#disposed || !this.#session.state(input.toolCallId)) return;
		this.#requestRender(this.#session.updateTool(input));
	}

	finishTool(input: ToolResultInput): void {
		if (this.#disposed || !this.#session.state(input.toolCallId)) return;
		this.#requestRender(this.#session.finishTool(input));
	}

	setMutations(toolCallId: string, entries: MutationMessageDetails[]): void {
		if (this.#disposed || !this.#session.state(toolCallId)) return;
		this.#requestRender(this.#session.setMutations(toolCallId, entries));
	}

	setGit(toolCallId: string, git: GitMessageDetails | undefined): void {
		if (this.#disposed || !git || !this.#session.state(toolCallId)) return;
		this.#requestRender(this.#session.setGit(toolCallId, git));
	}

	endRun(
		event: AgentEndInput,
		expectedRunId?: string,
	): "working" | "filtered" | "full" {
		const ledger =
			expectedRunId === undefined
				? this.#session.activeLedger
				: this.#session.ledgerForRun(expectedRunId);
		const mode = this.#session.endRun(event, expectedRunId);
		if (mode === "working") return "working";
		if (ledger) {
			this.#requestLedgerRender(ledger);
			// Terminal seam for the stats row: fires for a successful
			// terminal finalization in every presentation mode — `live`
			// (filtered), `compact` (full-retained log) and `clear` (hidden
			// rows). The presentation phase alone cannot distinguish compact
			// success from abort (both land on "full"), so success is
			// classified from the agent-end event itself; aborts/errors
			// never fire the hook.
			if (classifyAgentEnd(event) === "filtered")
				this.#onRunFinalized?.(ledger.runId);
		}
		return mode;
	}

	/**
	 * RunStats terminal row: insert a plugin-owned carrier rendering `line`
	 * directly above the assistant answer. Exactly once per ledger; fail-open
	 * so a stats failure never disturbs the terminal projection.
	 */
	showStats(runId: string, line: string): boolean {
		const placed = this.#session.showStats(runId, line);
		if (placed) this.#ui.requestRender?.();
		return placed;
	}

	/** Claim the current run before its asynchronous terminal audit work. */
	captureTerminalRunId(): string | undefined {
		return this.#disposed ? undefined : this.#session.captureTerminalRunId();
	}

	/**
	 * Release an exact terminal claim after its audit projection settles.
	 * A successful drain already finalized the ledger through `endRun`; a
	 * failed/skipped drain is finalized by this release instead (abort/full
	 * semantics), which returns the exact ledger and requests its render so
	 * the rows flip from working/live to the finalized full presentation.
	 * Render only: onRunFinalized/stats/evidence side effects belong to
	 * endRun and never fire for a fail-closed drain.
	 */
	releaseTerminalRun(runId: string | undefined): void {
		if (this.#disposed) return;
		const ledger = this.#session.releaseTerminalRun(runId);
		if (ledger) this.#requestLedgerRender(ledger);
	}

	/** Release raw payloads once a filtered terminal projection is complete. */
	retireFilteredPayloads(runId: string): boolean {
		return this.#session.retireFilteredPayloads(runId);
	}

	/** Distinct tool executions of a run, failures included. */
	ledgerActions(runId: string): number | undefined {
		return this.#session.ledgerActions(runId);
	}

	/** True when any tool execution of the run settled as an error. */
	ledgerHasError(runId: string): boolean | undefined {
		return this.#session.ledgerHasError(runId);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#session.finishFull();
		try {
			this.#fold?.dispose();
		} catch {
			// Fold restoration must not abort adapter-level rollback.
		}
		this.#fold = undefined;
		for (const patch of this.#patchedComponents.values()) patch.restore();
		this.#patchedComponents.clear();
		for (const patch of this.#ttsrPatches.values()) patch.restore();
		this.#ttsrPatches.clear();
		for (const patch of this.#todoReminderPatches.values()) patch.restore();
		this.#todoReminderPatches.clear();
		for (const patch of this.#userExecutionPatches.values()) patch.restore();
		this.#userExecutionPatches.clear();
		for (const patch of this.#skillPatches.values()) patch.restore();
		this.#skillPatches.clear();
		for (const patch of this.#lateDiagnosticsPatches.values()) patch.restore();
		this.#lateDiagnosticsPatches.clear();
		for (const patch of this.#transcriptPatches) patch.restore();
		this.#transcriptPatches.length = 0;
		this.#removeDiscoveryPatches();
		this.#stopSpinner();
		// C07: dispose invalidates any pending generation microtask — stale
		// callbacks abort on the token/disposed guard and never replay.
		this.#pendingGeneration = undefined;
		this.#rebuildPending = false;
		this.#rebuildSnapshot = undefined;
		this.#session.dispose();
		this.#disposed = true;
	}

	/**
	 * Rebuild boundary, invoked by the exact transcript `clear`
	 * wrapper BEFORE the native clear. Begins a new presentation
	 * generation (cancelling any pending settlement of the previous one),
	 * preserves active working ownership, retires stale historical
	 * bindings, and schedules the single generation-guarded microtask that
	 * commits the authoritative current branch after stock's synchronous
	 * repopulation.
	 */
	#onTranscriptClear(): void {
		if (this.#disposed) return;
		this.#beginRebuild();
	}

	#beginRebuild(): void {
		// RuntimeSessionState owns the generation: the boundary bumps it,
		// snapshots the active working ownership and retires historical
		// bindings as one transaction; the returned token guards this
		// boundary's settlement microtask, so a previously scheduled one
		// becomes stale and aborts (two quick clears settle only the
		// latest generation).
		const snapshot = this.#session.beginRebuild();
		this.#rebuildSnapshot = snapshot;
		this.#rebuildPending = true;
		this.#scheduleSettlement(snapshot.generation);
		this.#detachPresentation();
	}

	/**
	 * Detach every stale binding: the fold (transcript + per-block
	 * wrappers) and every per-component patch are restored to native and
	 * strong references to retired component instances are released.
	 * Component associations and state component refs were already retired
	 * by the session's beginRebuild transaction; the transcript's own
	 * addChild/clear patches survive — they define the rebuild boundary.
	 */
	#detachPresentation(): void {
		try {
			this.#fold?.dispose();
		} catch {
			// Fold restoration must not abort the rebuild detach.
		}
		for (const patch of this.#patchedComponents.values()) patch.restore();
		this.#patchedComponents.clear();
		for (const patch of this.#ttsrPatches.values()) patch.restore();
		this.#ttsrPatches.clear();
		for (const patch of this.#todoReminderPatches.values()) patch.restore();
		this.#todoReminderPatches.clear();
		for (const patch of this.#userExecutionPatches.values()) patch.restore();
		this.#userExecutionPatches.clear();
		for (const patch of this.#skillPatches.values()) patch.restore();
		this.#skillPatches.clear();
		for (const patch of this.#lateDiagnosticsPatches.values()) patch.restore();
		this.#lateDiagnosticsPatches.clear();
	}

	/** One generation-guarded settlement microtask per boundary. */
	#scheduleSettlement(token: number): void {
		this.#pendingGeneration = token;
		queueMicrotask(() => this.#settlePresentation(token));
	}

	/** Generation boundary for hydration-only paths (initial/resume). */
	#beginSettlement(): void {
		this.#scheduleSettlement(this.#session.bumpGeneration());
	}

	/**
	 * Settlement: runs after stock's synchronous repopulation. A stale
	 * token (newer clear or dispose) aborts without side effects. A
	 * pending rebuild commits through RuntimeSessionState: rehydrates the
	 * branch (active working ownership wins for any toolCallId that
	 * already exists, historical ledgers are rebuilt under the current
	 * frozen mode, the live ledger reference is restored), rebinds by
	 * exact toolCallId or proven cardinality, reinstalls the fold, then
	 * replays committed scrollback through the optional exact-root
	 * `resetDisplay`. Any failure rolls the whole generation adapter back
	 * to stock presentation.
	 */
	#settlePresentation(token: number): void {
		if (this.#pendingGeneration === token) this.#pendingGeneration = undefined;
		if (this.#disposed || token !== this.#session.generation) return;
		try {
			if (this.#rebuildPending) {
				this.#rebuildPending = false;
				const snapshot = this.#rebuildSnapshot;
				this.#rebuildSnapshot = undefined;
				if (snapshot) {
					const branch = this.#getBranch?.();
					// Absent or non-array branch results fail open — the
					// rebuild keeps only the preserved active working
					// ownership and leaves ambiguous surfaces native.
					this.#session.commitRebuild(snapshot, {
						branchEntries: Array.isArray(branch) ? branch : [],
					});
					// Detach restored TTSR/tool patches; stock usually
					// re-addChilds through the surviving wrapper, but any
					// child already present (or reinserted without a fresh
					// addChild) must be re-observed here so inject overrides
					// re-attach without double-wrapping (#ttsrPatches.has).
					const transcript = this.#transcript;
					if (transcript) {
						for (const child of transcript.children) {
							if (this.#disposed) break;
							this.#observeTranscriptChild(child);
						}
					}
					this.#installFold();
					if (this.#session.activeLedger)
						this.#requestLedgerRender(this.#session.activeLedger);
					this.#ensureSpinner();
				}
			}
			this.replayCurrentPresentation();
		} catch (error) {
			this.#rollback(`omp-compact disabled: ${String(error)}`);
		}
	}

	#installFold(): void {
		const transcript = this.#transcript;
		if (!transcript) return;
		if (!this.#fold) {
			this.#fold = new TranscriptFold(transcript, {
				isFoldable: (block) =>
					isToolComponent(block) ||
					isReadGroupComponent(block) ||
					isCompactCustomMessage(block),
				render: (block, width, nativeRender) =>
					this.#renderBlock(block, width, nativeRender),
				isFinalized: (block, nativeFinalized) =>
					this.#isFinalized(block, nativeFinalized),
				settledRows: (block, nativeSettledRows) =>
					this.#settledRows(block, nativeSettledRows),
				version: (block, nativeVersion) => this.#version(block, nativeVersion),
				isTerminal: (block) => this.#isTerminal(block),
			});
		}
		// Idempotent: the fold re-patches the transcript instance after a
		// rebuild detach disposed it; per-block patches are (re)installed
		// lazily by the fold's plan during the next render.
		this.#fold.install();
	}

	#renderBlock(
		block: RenderableBlock,
		width: number,
		nativeRender: (width: number) => readonly string[],
	): readonly string[] {
		const state = this.#session.binding.componentState(block);
		if (state) {
			const rule = resolveToolRule(state.toolName);
			const runMode = this.#session.modeFor(state.ledger);
			const phase = state.ledger.phase;
			const filtered = phase === "filtered";
			const projection = filtered
				? this.#session.terminalProjection(state.ledger)
				: undefined;
			const decision = decideToolRender({
				route: rule?.route,
				mode: runMode.mode,
				retainGitLive: runMode.retainGitLive,
				phase,
				expanded: state.expanded,
				compactOnExpand: rule?.compactOnExpand === true,
				hasMutations: state.mutations.length > 0,
				hasGit: state.git !== undefined,
				hashesLength: projection?.hashes.length ?? 0,
				isAnchor: projection?.anchor === state,
			});
			if (decision.kind === "native") return nativeRender(width);
			if (decision.kind === "empty") return EMPTY_LINES;
			const theme = this.#ui.theme;
			if (!theme) return nativeRender(width);
			if (decision.kind === "tool-rows") {
				if (decision.filtered) {
					// Terminal retention: write/edit mutation rows stay in
					// their chronological position, individual Git rows
					// collapse into one aggregate commit-summary line
					// appended after the last retained row of the run. Git
					// evidence without any created commit hash contributes
					// no row at all.
					const rows: string[] = [];
					if (state.mutations.length > 0)
						rows.push(
							...renderCompactToolRows(
								{
									toolName: state.toolName,
									args: state.args,
									result: state.result,
									isError: state.isError,
									isPartial: state.isPartial,
									tick: state.version,
									mutationEntries: state.mutations,
								},
								theme,
								width,
								this.#session.displayPaths,
							),
						);
					if (decision.summary && projection)
						rows.push(terminalGitSummaryLine(projection.hashes, theme, width));
					return rows;
				}
				return renderCompactToolRows(
					{
						toolName: state.toolName,
						args: state.args,
						result: state.result,
						isError: state.isError,
						isPartial: state.isPartial,
						tick: state.version,
						mutationEntries: state.mutations,
						git: decision.includeGit ? state.git : undefined,
					},
					theme,
					width,
					this.#session.displayPaths,
				);
			}
			return nativeRender(width);
		}
		const group = this.#session.binding.groupState(block);
		if (group) {
			const readStates = this.#session.binding.mappedReadStates(group);
			const decision = decideReadGroupRender({
				mode: group.ledger
					? this.#session.modeFor(group.ledger).mode
					: DEFAULT_RUN_MODE.mode,
				phase: group.ledger?.phase,
				expanded: group.expanded,
				completelyMapped: this.#session.binding.groupCompletelyMapped(group),
				readCount: readStates.length,
			});
			if (decision.kind === "native") return nativeRender(width);
			if (decision.kind === "empty") return EMPTY_LINES;
			const theme = this.#ui.theme;
			if (!theme) return nativeRender(width);
			const rows: string[] = [];
			for (const readState of readStates) {
				rows.push(
					...renderCompactToolRows(
						{
							toolName: readState.toolName,
							args: readState.args,
							result: readState.result,
							isError: readState.isError,
							isPartial: readState.isPartial,
							tick: readState.version,
						},
						theme,
						width,
						this.#session.displayPaths,
					),
				);
			}
			return rows;
		}
		return nativeRender(width);
	}

	#isFinalized(
		block: RenderableBlock,
		nativeFinalized: (() => boolean) | undefined,
	): boolean {
		const state = this.#session.binding.componentState(block);
		if (state) return state.ledger.phase !== "working";
		const group = this.#session.binding.groupState(block);
		if (group?.ledger) return group.ledger.phase !== "working";
		return nativeFinalized?.() ?? true;
	}

	#settledRows(
		block: RenderableBlock,
		nativeSettledRows: (() => number) | undefined,
	): number {
		const state = this.#session.binding.componentState(block);
		if (state?.ledger.phase === "working") return 0;
		const group = this.#session.binding.groupState(block);
		if (group?.ledger?.phase === "working") return 0;
		return nativeSettledRows?.() ?? 0;
	}

	#version(
		block: RenderableBlock,
		nativeVersion: (() => number) | undefined,
	): number {
		const state = this.#session.binding.componentState(block);
		if (state) return state.version + (nativeVersion?.() ?? 0);
		const group = this.#session.binding.groupState(block);
		if (group) return group.version + (nativeVersion?.() ?? 0);
		return nativeVersion?.() ?? 0;
	}

	#isTerminal(block: RenderableBlock): boolean {
		const state = this.#session.binding.componentState(block);
		if (state) return state.ledger.phase !== "working";
		const group = this.#session.binding.groupState(block);
		if (group?.ledger) return group.ledger.phase !== "working";
		return isCompactCustomMessage(block);
	}

	/**
	 * Arm the 80 ms pending-row spinner only while a qualifying pending
	 * state exists. Idempotent when already running. Call sites that can
	 * produce spinner work (tool start, bind after observe, rebuild
	 * re-observation, hydration) resume here so a settled idle never leaves
	 * a frozen `Working…` row — and install with zero pending never arms a
	 * forever-idle timer.
	 */
	#ensureSpinner(): void {
		if (this.#timer !== undefined || !this.#timers?.setInterval) return;
		if (!this.#hasSpinnerWork()) return;
		this.#startSpinner();
	}

	#stopSpinner(): void {
		if (this.#timer === undefined) return;
		this.#timers?.clearTimer?.(this.#timer);
		this.#timer = undefined;
	}

	/** True when at least one pending state would animate on the next tick. */
	#hasSpinnerWork(): boolean {
		for (const state of this.#session.pending()) {
			if (state.ledger.phase !== "working" || !state.component) continue;
			if (this.#session.modeFor(state.ledger).mode === "clear") continue;
			return true;
		}
		return false;
	}

	#startSpinner(): void {
		if (this.#timer !== undefined || !this.#timers?.setInterval) return;
		this.#timer = this.#timers.setInterval(() => {
			let pending = false;
			for (const state of this.#session.pending()) {
				if (state.ledger.phase !== "working" || !state.component) continue;
				// `clear` renders no compact rows; stock surfaces animate
				// themselves, so hidden rows must not churn renders.
				if (this.#session.modeFor(state.ledger).mode === "clear") continue;
				pending = true;
				state.version++;
				this.#ui.requestComponentRender?.(state.component);
			}
			if (pending) this.#ui.requestRender?.();
			else this.#stopSpinner();
		}, 80);
	}

	#requestRender(component?: RenderableBlock): void {
		this.#ui.requestRender?.();
		if (component) this.#ui.requestComponentRender?.(component);
	}

	#requestLedgerRender(ledger: TurnLedger): void {
		this.#ui.requestRender?.();
		for (const state of this.#session.ledgerStates(ledger)) {
			if (state.component) this.#ui.requestComponentRender?.(state.component);
		}
		for (const group of this.#session.binding.groups()) {
			if (group.ledger === ledger)
				this.#ui.requestComponentRender?.(group.component);
		}
	}

	// Discovery recursion: depth tracking and cycle detection are the
	// responsibility of HostAdapter.observeTree, not this orchestration
	// layer. The adapter fails closed on any discovery exception.
	#observeTree(value: unknown, depth: number): void {
		if (this.#transcript) return;
		this.#host.observeTree(
			value,
			depth,
			(transcript) => this.#installTranscript(transcript),
			(container) => this.#patchDiscoveryContainer(container),
		);
	}

	#patchDiscoveryContainer(container: Record<string, unknown>): void {
		if (this.#discoveryPatches.has(container)) return;
		const patch = this.#host.patchDiscoveryContainer(container, (child) => {
			try {
				this.#observeTree(child, 0);
			} catch (error) {
				this.#rollback(`omp-compact disabled: ${String(error)}`);
			}
		});
		this.#discoveryPatches.set(container, patch);
	}

	#removeDiscoveryPatches(): void {
		for (const patch of this.#discoveryPatches.values()) patch.restore();
		this.#discoveryPatches.clear();
	}

	#installTranscript(transcript: TranscriptHost): void {
		if (this.#transcript === transcript) return;
		if (this.#transcript) throw new Error("multiple transcript containers");
		this.#transcript = transcript;
		this.#session.attachTranscript(transcript);
		this.#removeDiscoveryPatches();
		const addChildPatch = this.#host.patchAddChild(transcript, (child) => {
			try {
				this.#observeTranscriptChild(child);
			} catch (error) {
				this.#rollback(`omp-compact disabled: ${String(error)}`);
			}
		});
		// The exact transcript `clear` is the rebuild boundary. The
		// wrapper runs the rebuild prologue before the native clear exactly
		// once; stock then synchronously repopulates through addChild, and
		// one generation-guarded microtask settles the presentation. Only
		// installed when the capability exists — install-time compatibility
		// is unchanged, and a host without `clear` fails open (no boundary,
		// live presentation keeps working). The addChild patch is recorded
		// FIRST so a failing clear probe still rolls the adapter back
		// transactionally (its wrapper is restored by dispose).
		this.#transcriptPatches.push(addChildPatch);
		if (transcriptCapabilities(transcript).clear) {
			const clearPatch = this.#host.patchClear(transcript, () => {
				try {
					this.#onTranscriptClear();
				} catch (error) {
					this.#rollback(`omp-compact disabled: ${String(error)}`);
				}
			});
			this.#transcriptPatches.push(clearPatch);
		}
		for (const child of transcript.children) {
			// A fail-closed patch failure (e.g. unpatchable read group)
			// already disposed the adapter mid-walk; stop before any
			// further patching or fold installation can leak.
			if (this.#disposed) break;
			this.#observeTranscriptChild(child);
		}
		this.#session.binding.bindHydrated(true);
		this.#installFold();
		this.#ensureSpinner();
	}

	#observeTranscriptChild(child: unknown): void {
		if (isTranscriptHost(child) && child !== this.#transcript) {
			this.#rollback("omp-compact disabled: multiple transcript containers");
			return;
		}
		if (isReadGroupComponent(child)) {
			// A failed patch already retired the adapter (rollback/dispose);
			// never bind on a disposed session.
			if (!this.#patchReadGroup(child)) return;
			this.#session.binding.tryBindByOrder(this.#session.activeLedger);
			this.#ensureSpinner();
			return;
		}
		if (isTtsrNotificationComponent(child)) {
			this.#patchTtsrNotification(child);
			return;
		}
		if (isTodoReminderComponent(child)) {
			this.#patchTodoReminder(child);
			return;
		}
		if (isSkillMessageComponent(child)) {
			this.#patchSkillMessage(child);
			return;
		}
		if (isLateDiagnosticsMessageComponent(child)) {
			this.#patchLateDiagnostics(child);
			return;
		}
		if (isBashExecutionComponent(child)) {
			this.#patchUserExecution(child, "bash");
			return;
		}
		if (isEvalExecutionComponent(child)) {
			this.#patchUserExecution(child, "python");
			return;
		}
		if (isToolComponent(child)) {
			this.#patchToolComponent(child);
			this.#session.binding.tryBindByOrder(this.#session.activeLedger);
			this.#ensureSpinner();
		}
	}

	/**
	 * Override stock TTSR card chrome with ordinary gray tool rows and a green
	 * `inject` marker. Exact-instance render wrap only — never folded into a
	 * tool run. Expansion (`setExpanded`) only changes the recoverable body
	 * text; compact inject rows still render when extraction succeeds.
	 * Unrecognized trees fail open to the native renderer.
	 */
	#patchTtsrNotification(component: RenderableBlock): void {
		if (this.#ttsrPatches.has(component)) return;
		const own = Object.getOwnPropertyDescriptor(component, "render");
		const proto = Object.getPrototypeOf(component) as object | null;
		const inherited =
			proto && proto !== Object.prototype
				? Object.getOwnPropertyDescriptor(proto, "render")
				: undefined;
		const original =
			typeof own?.value === "function"
				? (own.value as (
						this: RenderableBlock,
						width: number,
					) => readonly string[])
				: typeof inherited?.value === "function"
					? (inherited.value as (
							this: RenderableBlock,
							width: number,
						) => readonly string[])
					: undefined;
		if (!original) return;
		const adapter = this;
		try {
			const patch = new DescriptorPatch(component, ["render"]);
			patch.install({
				render: {
					configurable: true,
					writable: true,
					value(this: RenderableBlock, width: number): readonly string[] {
						if (adapter.#disposed) return original.call(this, width);
						const theme = adapter.#ui.theme;
						if (!theme) return original.call(this, width);
						const rules = injectRulesFromTtsrComponent(this);
						if (!rules) return original.call(this, width);
						return renderInjectRuleRows(rules, theme, width);
					},
				},
			});
			this.#ttsrPatches.set(component, patch);
		} catch {
			// Capability skew fails open: leave the stock yellow card alone.
		}
	}

	/**
	 * Override stock TodoReminder yellow multi-line card with one compact
	 * warning row. Exact-instance render wrap only — never folded into a tool
	 * run.
	 *
	 * Install-time containment: `isTodoReminderComponent` also matches other
	 * activity-only leaves (notably OMP 17.3.4 `StrippedToolCallsPlaceholder`,
	 * which exposes only `render` + `setToolActivityVisible`). Stock
	 * `TodoReminderComponent` builds its Spacer/Box/Text tree in the
	 * constructor via `#rebuild()`, so a successful `todoReminderFromComponent`
	 * probe here is exact evidence the instance is a real reminder card. We
	 * only install a DescriptorPatch when that probe yields a view — collision
	 * leaves stay fully native. Render-time extraction remains the second
	 * fail-open line if the tree later drifts.
	 */
	#patchTodoReminder(component: RenderableBlock): void {
		if (this.#todoReminderPatches.has(component)) return;
		// Probe before capture/install so unrelated activity-only leaves never
		// receive a render wrapper.
		if (!todoReminderFromComponent(component)) return;
		const own = Object.getOwnPropertyDescriptor(component, "render");
		const proto = Object.getPrototypeOf(component) as object | null;
		const inherited =
			proto && proto !== Object.prototype
				? Object.getOwnPropertyDescriptor(proto, "render")
				: undefined;
		const original =
			typeof own?.value === "function"
				? (own.value as (
						this: RenderableBlock,
						width: number,
					) => readonly string[])
				: typeof inherited?.value === "function"
					? (inherited.value as (
							this: RenderableBlock,
							width: number,
						) => readonly string[])
					: undefined;
		if (!original) return;
		const adapter = this;
		try {
			const patch = new DescriptorPatch(component, ["render"]);
			patch.install({
				render: {
					configurable: true,
					writable: true,
					value(this: RenderableBlock, width: number): readonly string[] {
						if (adapter.#disposed) return original.call(this, width);
						const theme = adapter.#ui.theme;
						if (!theme) return original.call(this, width);
						const view = todoReminderFromComponent(this);
						if (!view) return original.call(this, width);
						return renderTodoReminderRow(view, theme, width);
					},
				},
			});
			this.#todoReminderPatches.set(component, patch);
		} catch {
			// Capability skew fails open: leave the stock yellow card alone.
		}
	}

	/**
	 * Override stock skill-prompt card with one compact identity row.
	 * Exact-instance render + setExpanded wrap only — never fold-owned.
	 *
	 * Expanded contract: `#expanded` is host-private, so we observe
	 * `setExpanded` and fall back to the native multi-line card (prompt
	 * body is the point of expand), matching user-execution expand
	 * behavior. Collapsed stays one transparent row.
	 *
	 * Install-time probe: `skillMessageFromComponent` must yield a view
	 * from structured `message` before any DescriptorPatch.
	 */
	#patchSkillMessage(component: RenderableBlock): void {
		this.#patchExpandableLeaf({
			component,
			patches: this.#skillPatches,
			states: this.#skillExpandState,
			// Probe before capture/install so non-skill leaves stay native.
			extract: skillMessageFromComponent,
			renderRow: renderSkillMessageRow,
		});
	}

	/**
	 * Override stock late-diagnostics tree with one compact severity row.
	 * Exact-instance render + setExpanded wrap only.
	 *
	 * Expanded contract: observe `setExpanded` (host `#expanded` private)
	 * and fall back to native formatDiagnostics tree so full diagnostic
	 * lines remain readable — same policy as skill / user-execution.
	 *
	 * Install-time probe refuses empty `messages` (host early-return) so
	 * empty files leaves never receive a wrapper.
	 */
	#patchLateDiagnostics(component: RenderableBlock): void {
		this.#patchExpandableLeaf({
			component,
			patches: this.#lateDiagnosticsPatches,
			states: this.#lateDiagnosticsExpandState,
			// Probe before capture/install so empty/mismatch leaves stay native.
			extract: lateDiagnosticsFromComponent,
			renderRow: renderLateDiagnosticsRow,
		});
	}

	/**
	 * Resolve a callable instance method through the prototype chain. Stock
	 * `BashExecutionComponent` overrides `render` on its own class;
	 * `EvalExecutionComponent` does not and inherits `Container.render`
	 * several levels up. The existing TTSR/todo one-level lookup would miss
	 * eval, so we walk until we find a function value (never patching a
	 * shared prototype — only capturing the function to wrap as an own
	 * instance property).
	 */
	#resolveInstanceMethod(
		component: object,
		name: string,
	): ((...args: never[]) => unknown) | undefined {
		let current: object | null = component;
		while (current && current !== Object.prototype) {
			const descriptor = Object.getOwnPropertyDescriptor(current, name);
			if (typeof descriptor?.value === "function") {
				return descriptor.value as (...args: never[]) => unknown;
			}
			current = Object.getPrototypeOf(current) as object | null;
		}
		return undefined;
	}

	/**
	 * Shared DescriptorPatch scaffolding for expandable leaf cards (skill,
	 * late-diagnostics, user bash/python execution). Callers keep their own
	 * fingerprint gate, patch map, observed-state map, extract, and row
	 * renderer; this only collapses the install path that was copy-pasted.
	 *
	 * TTSR / todo-reminder are intentionally not folded in: they wrap
	 * `render` only (no setExpanded observe) and are a second shape.
	 *
	 * Invariants preserved from the three former copies:
	 * - per-component idempotency via `patches.has`
	 * - install-time content probe *before* method resolve / patch install
	 * - fail-open ladder: disposed → no theme → extract miss → expanded
	 *   all return native output
	 * - `restore()` on dispose still goes through the caller's patch map
	 */
	#patchExpandableLeaf<
		TState extends { expanded?: boolean },
		TView extends { expanded?: boolean },
	>(args: {
		component: RenderableBlock;
		patches: Map<object, DescriptorPatch>;
		states: WeakMap<object, TState>;
		extract: (
			block: unknown,
			observed: TState | undefined,
		) => TView | undefined;
		renderRow: (view: TView, theme: Theme, width?: number) => readonly string[];
		/**
		 * User-execution only: also wrap `setComplete` so private exit codes
		 * reach the next compact render. Omitted for skill / late-diagnostics.
		 */
		observeComplete?: (
			state: TState,
			exitCode: number | undefined,
			cancelled: boolean,
		) => void;
	}): void {
		const { component, patches, states, extract, renderRow, observeComplete } =
			args;
		if (patches.has(component)) return;
		// Probe before capture/install so empty/mismatch leaves stay native.
		if (!extract(component, states.get(component))) return;

		const originalRender = this.#resolveInstanceMethod(component, "render");
		const originalSetExpanded = this.#resolveInstanceMethod(
			component,
			"setExpanded",
		);
		if (!originalRender || !originalSetExpanded) return;

		const render = originalRender as (
			this: RenderableBlock,
			width: number,
		) => readonly string[];
		const setExpanded = originalSetExpanded as (
			this: RenderableBlock,
			expanded: boolean,
		) => unknown;

		let setComplete:
			| ((
					this: RenderableBlock,
					exitCode: number | undefined,
					cancelled: boolean,
					options?: unknown,
			  ) => unknown)
			| undefined;
		if (observeComplete) {
			const originalSetComplete = this.#resolveInstanceMethod(
				component,
				"setComplete",
			);
			if (!originalSetComplete) return;
			setComplete = originalSetComplete as (
				this: RenderableBlock,
				exitCode: number | undefined,
				cancelled: boolean,
				options?: unknown,
			) => unknown;
		}

		const adapter = this;
		const state = states.get(component) ?? ({} as TState);
		states.set(component, state);

		// Capture order matches the three former sites: render, optional
		// setComplete, setExpanded. DescriptorPatch install follows this order.
		const methodNames = observeComplete
			? (["render", "setComplete", "setExpanded"] as const)
			: (["render", "setExpanded"] as const);

		try {
			const patch = new DescriptorPatch(component, methodNames);
			const wrappers: Record<string, PropertyDescriptor> = {
				render: {
					configurable: true,
					writable: true,
					value(this: RenderableBlock, width: number): readonly string[] {
						if (adapter.#disposed) return render.call(this, width);
						const theme = adapter.#ui.theme;
						if (!theme) return render.call(this, width);
						const view = extract(this, states.get(this));
						if (!view) return render.call(this, width);
						// Expanded → native multi-line card so the full body stays readable.
						if (view.expanded === true) return render.call(this, width);
						return renderRow(view, theme, width);
					},
				},
				setExpanded: {
					configurable: true,
					writable: true,
					value(this: RenderableBlock, expanded: boolean): unknown {
						const observed = states.get(this) ?? ({} as TState);
						observed.expanded = expanded === true;
						states.set(this, observed);
						return setExpanded.call(this, expanded);
					},
				},
			};
			if (observeComplete && setComplete) {
				const complete = setComplete;
				wrappers.setComplete = {
					configurable: true,
					writable: true,
					value(
						this: RenderableBlock,
						exitCode: number | undefined,
						cancelled: boolean,
						options?: unknown,
					): unknown {
						const observed = states.get(this) ?? ({} as TState);
						observeComplete(observed, exitCode, cancelled);
						states.set(this, observed);
						return complete.call(this, exitCode, cancelled, options);
					},
				};
			}
			patch.install(wrappers);
			patches.set(component, patch);
		} catch {
			// Capability skew fails open: leave the stock card alone.
		}
	}

	/**
	 * Override stock user bash (`!`/`!!`) and python (`$`/`$$`) multi-line
	 * execution frames with one compact tool-chrome row.
	 *
	 * Lifecycle: only `render` needs wrapping for presentation, but exit
	 * codes/`#expanded` are private on the host classes. We also wrap
	 * `setComplete` and `setExpanded` to record observed state for the next
	 * render. Host still calls its own `invalidate` after those methods, so
	 * the compact row updates without extra requestRender plumbing.
	 *
	 * Expanded contract: when the user expands the block (`setExpanded(true)`),
	 * fall back to the native full frame so streaming/output is readable —
	 * same fail-open idea as expanded read groups staying native. Collapsed
	 * (default) stays one compact line.
	 *
	 * DescriptorPatch note: `install` always defines an *own* wrapper. For
	 * eval (inherited render) capture is `undefined`, so `restore()` deletes
	 * the own property and re-exposes the prototype method. For bash (own
	 * class override found via the chain walk, still not an instance-own
	 * property until first install) the same delete-on-restore applies when
	 * the method lived on the class prototype rather than the instance.
	 *
	 * Install-time content probe refuses empty/unextractable source so a
	 * colliding surface never receives a wrapper.
	 */
	#patchUserExecution(
		component: RenderableBlock,
		kind: "bash" | "python",
	): void {
		const extract =
			kind === "bash"
				? userBashExecutionFromComponent
				: userEvalExecutionFromComponent;
		this.#patchExpandableLeaf({
			component,
			patches: this.#userExecutionPatches,
			states: this.#userExecutionState,
			extract,
			renderRow: renderUserExecutionRow,
			observeComplete(state, exitCode, cancelled) {
				if (typeof exitCode === "number") state.exitCode = exitCode;
				else delete state.exitCode;
				state.cancelled = cancelled === true;
			},
		});
	}

	#patchToolComponent(component: RenderableBlock): void {
		if (this.#patchedComponents.has(component)) return;
		const patch = this.#host.patchToolComponent(component, (name, args) => {
			try {
				const status = this.#session.binding.observeToolMethod(
					component,
					name,
					args,
				);
				// Ambiguous provisional→real-id migration is a per-component
				// data conflict, not a broken host. Quarantine only this
				// surface to native and leave the rest of the session
				// compacting. Session-wide `#rollback` stays reserved for
				// host-invariant failures (unpatchable core, multiple
				// transcripts, capability skew).
				if (status === "ambiguous") {
					this.#quarantineComponent(component);
					return;
				}
				// Binding (or re-binding) can attach a component to a working
				// pending state after the idle spinner stopped — resume it.
				this.#ensureSpinner();
			} catch (error) {
				this.#rollback(`omp-compact disabled: ${String(error)}`);
			}
		});
		this.#patchedComponents.set(component, patch);
		this.#session.binding.registerUnboundComponent(component);
		this.#ensureSpinner();
	}

	#patchReadGroup(component: RenderableBlock): boolean {
		if (this.#patchedComponents.has(component)) return true;
		// The group is registered with the binding BEFORE the host patch
		// runs, so an unpatchable group (capability skew) must be contained
		// here: the group is rolled back through the fail-closed path and
		// the caller is told not to proceed (no tryBind after disposal).
		const group = this.#session.binding.createGroup(
			component,
			this.#ui.getToolsExpanded?.() === true,
		);
		let patch: DescriptorPatch;
		try {
			patch = this.#host.patchReadGroup(component, (name, args) => {
				try {
					const status = this.#session.binding.observeReadMethod(
						group,
						component,
						name,
						args,
					);
					// Same containment as tool components: ambiguous id
					// ownership quarantines this group only.
					if (status === "ambiguous") {
						this.#quarantineComponent(component);
						return;
					}
					this.#ensureSpinner();
				} catch (error) {
					this.#rollback(`omp-compact disabled: ${String(error)}`);
				}
			});
		} catch (error) {
			// rollback disposes the whole session (clearing the group above
			// with it); the failure never escapes the observer.
			this.#rollback(`omp-compact disabled: ${String(error)}`);
			return false;
		}
		this.#patchedComponents.set(component, patch);
		return true;
	}

	/**
	 * Per-component native fail-open for an unresolvable binding conflict.
	 * Restores the host method patch (stop observing), drops this instance
	 * from the patched set, and releases the binding reverse-map so
	 * `#renderBlock` falls through to native — without disposing the
	 * session. A later rebuild re-observes from scratch.
	 */
	#quarantineComponent(component: RenderableBlock): void {
		this.#session.binding.releaseToNative(component);
		const patch = this.#patchedComponents.get(component);
		if (patch) {
			try {
				patch.restore();
			} catch {
				// Restoration must not escalate a data ambiguity into a
				// session-wide rollback.
			}
			this.#patchedComponents.delete(component);
		}
	}

	#rollback(message: string): void {
		try {
			this.#warn?.(message);
		} catch {
			// Capability failure must never prevent descriptor restoration.
		}
		// dispose() catches every exception internally and never throws into
		// rollback; the warn above is the only user-visible failure signal.
		this.dispose();
		// Notify the owner after local teardown so index.ts can drop its
		// handle and mark the session native. Plain dispose() never fires
		// this — only host-invariant rollback. Swallow so a buggy owner
		// callback cannot escape into the host event stream.
		try {
			this.#onDisabled?.();
		} catch {
			// Owner notification is best-effort.
		}
	}
}

export function captureHostRoot(ui: AdapterUI): unknown {
	if (typeof ui.setWidget !== "function") return undefined;
	let root: unknown;
	ui.setWidget("omp-compact-tui", (tui: unknown) => {
		root = tui;
		return { render: () => [] };
	});
	ui.setWidget("omp-compact-tui", undefined);
	return root;
}
