/**
 * B05: session-scoped runtime state — ledgers, tool/group records, pending
 * set, terminal projections, stats placement and the presentation
 * generation lifecycle.
 *
 * RuntimeAdapter stays the host/event orchestrator; this module owns every
 * piece of mutable run state the adapter used to declare directly:
 * - logical ledgers and their frozen mode snapshots (run sequence,
 *   continuation);
 * - tool/group state records (args/result/error/expansion/version,
 *   ledger/entry links);
 * - the pending set (in-flight component updates, spinner);
 * - terminal projections (aggregate Git hashes + summary anchor);
 * - stats-carrier placement (live rows and replayed evidence);
 * - active-vs-historical ownership and the rebuild lifecycle
 *   (`beginRebuild`/`commitRebuild`/`abortRebuild`) — behavior-neutral
 *   hooks the C rebuild phase consumes instead of a second generation
 *   store.
 *
 * The module never holds private stock method names and never touches host
 * objects beyond the plugin's own typed transcript abstraction (used for
 * stats-carrier placement only).
 */

import { ComponentBinding } from "./component-binding";
import type { DisplayPathOptions } from "./display-path";
import {
	isBoundedString,
	isPayloadWithinBudget,
	MAX_MUTATION_ENTRIES,
	MAX_TOOL_CALL_ID_LENGTH,
	MAX_TOOL_NAME_LENGTH,
} from "./hydration-bounds";
import {
	GIT_MESSAGE_TYPE,
	type GitMessageDetails,
	isGitMessageDetails,
	isMutationMessageDetails,
	MUTATION_MESSAGE_TYPE,
	type LegacyMutationMessageDetails,
	type MutationMessageDetails,
} from "./messages";
import {
	DEFAULT_RUN_MODE,
	type ModePolicy,
	type RunModeSnapshot,
	runModeFromSettings,
} from "./mode-policy";
import { gitCommitHashes } from "./render";
import {
	createStatsCarrier,
	isRunStatsEvidence,
	type RunStatsEvidence,
	STATS_MESSAGE_TYPE,
} from "./run-stats";
import type { RenderableBlock, TranscriptHost } from "./transcript-fold";
import {
	type AgentEndEvent,
	classifyAgentEnd,
	type LedgerEntry,
	TurnLedger,
	type TurnLedgerResult,
} from "./turn-ledger";

export interface ToolStartInput {
	toolCallId: string;
	toolName: string;
	args: unknown;
}

export interface ToolResultInput {
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
	isPartial?: boolean;
}

export interface AgentEndInput {
	messages: unknown[];
	willContinue?: boolean;
}

export interface ToolState {
	// Mutated only by the provisional → real toolCallId migration.
	id: string;
	readonly toolName: string;
	// Monotonic creation sequence; read rows render in this chronological
	// order regardless of later map re-keying or group updateArgs order.
	readonly seq: number;
	args: unknown;
	result: unknown;
	isError: boolean;
	isPartial: boolean;
	expanded: boolean;
	component?: RenderableBlock;
	ledger: TurnLedger;
	entry: LedgerEntry;
	mutations: (MutationMessageDetails | LegacyMutationMessageDetails)[];
	git?: GitMessageDetails;
	version: number;
}

export interface TerminalProjection {
	/** Aggregate commit hashes of the ledger, in chronological order. */
	hashes: string[];
	/** State that renders the trailing summary row of the filtered ledger. */
	anchor?: ToolState;
}

export interface GroupState {
	readonly component: RenderableBlock;
	ledger?: TurnLedger;
	expanded: boolean;
	// Ids observed through updateArgs/updateResult. Stock hosts add the group
	// and call updateArgs BEFORE the extension's tool_execution_start creates
	// the state, so ids are recorded first and the mapping completes in
	// startTool once the state exists. Compact rows render only when every
	// observed id resolves to a read state mapped to this group; a group with
	// untracked entries keeps the raw native renderer in every phase (even
	// terminal filtering) so native entries are never silently dropped.
	observedIds: Set<string>;
	version: number;
}

export interface SessionStateOptions {
	/**
	 * RuntimeModes: per-run mode policy. The session snapshots the mode when
	 * a ledger starts (agent_start or branch hydration) and keeps it frozen
	 * for that logical run; settings changes apply at the next boundary.
	 */
	modePolicy?: ModePolicy;
	/**
	 * Display-path options for the run, resolved once when a new ledger
	 * starts (agent_start or branch hydration): the session cwd and the
	 * `compactPaths` snapshot stay immutable for that logical run.
	 */
	displayPaths?: () => DisplayPathOptions;
	/**
	 * Replay seam (RunStats): rebuild a themed stats line from persisted
	 * evidence when a session branch hydrates. Return `undefined` to skip.
	 */
	statsRenderer?: (evidence: RunStatsEvidence) => string | undefined;
	/**
	 * Version-pinned host seam for plugin-owned stats carrier insertion.
	 * Returning false leaves the native transcript untouched.
	 */
	placeStatsCarrier?: (
		transcript: TranscriptHost,
		index: number,
		carrier: unknown,
	) => boolean;
	/**
	 * Live tool-output expansion state. Stock pre-sets `setExpanded(...)` on
	 * components before the adapter can wrap them, so the initial expanded
	 * state is read here instead of guessed from the native presentation.
	 */
	getToolsExpanded?: () => boolean;
}

/**
 * Active-ownership snapshot captured by `beginRebuild`: the working ledger
 * (or undefined) and its states with preserved object identity. The C
 * rebuild phase uses this to re-bind re-added components without losing
 * pending/partial evidence.
 */
export interface RebuildSnapshot {
	readonly generation: number;
	readonly activeLedger: TurnLedger | undefined;
	readonly activeStates: readonly ToolState[];
}

export interface RebuildOutcome {
	readonly generation: number;
	/** False when binding stayed ambiguous/incompatible (native fail-open). */
	readonly mapped: boolean;
}

interface DeferredTerminalLedger {
	readonly ledger: TurnLedger;
	readonly answerAnchor: unknown;
}

// Intentional per-module copy of objectRecord for tree-shakeability;
// identical logic in 7 files across the plugin.
function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

/**
 * All mutable session state of one RuntimeAdapter. Constructed by the
 * adapter, which remains the host/event orchestrator: discovery, patching,
 * fold wiring, timers and UI render requests never enter this module.
 */
export class RuntimeSessionState {
	readonly #modePolicy: ModePolicy | undefined;
	readonly #displayPathsSource: (() => DisplayPathOptions) | undefined;
	readonly #statsRenderer:
		| ((evidence: RunStatsEvidence) => string | undefined)
		| undefined;
	readonly #placeStatsCarrier:
		| ((transcript: TranscriptHost, index: number, carrier: unknown) => boolean)
		| undefined;
	readonly #getToolsExpanded: (() => boolean) | undefined;
	/** Component ↔ state associations (see ComponentBinding). */
	readonly binding: ComponentBinding;
	readonly #ledgerModes = new WeakMap<TurnLedger, RunModeSnapshot>();
	readonly #states = new Map<string, ToolState>();
	readonly #pendingStates = new Set<ToolState>();
	readonly #terminalProjections = new Map<TurnLedger, TerminalProjection>();
	// A terminal agent_end may await audit work while stock starts the next
	// run. Keep only those exact in-flight terminal ledgers addressable until
	// their adapter drain finishes, including an exact pre-next-run answer
	// anchor for a no-tool stats row; ordinary history remains state-owned.
	readonly #deferredTerminalLedgers = new Map<string, DeferredTerminalLedger>();
	// RunStats integration: exactly-once guard for live terminal rows and the
	// replayed evidence carriers (one per logical run).
	readonly #liveStatsLines = new Map<TurnLedger, string>();
	readonly #hydratedStatsEvidence: Array<{
		ledger: TurnLedger;
		evidence: RunStatsEvidence;
	}> = [];
	#ledger: TurnLedger | undefined;
	#displayPaths: DisplayPathOptions | undefined;
	#transcript: TranscriptHost | undefined;
	#seq = 0;
	#runNumber = 0;
	#continuationPending = false;
	#generation = 0;
	#rebuildInProgress = false;
	#disposed = false;

	constructor(options: SessionStateOptions) {
		this.#modePolicy = options.modePolicy;
		this.#displayPathsSource = options.displayPaths;
		this.#statsRenderer = options.statsRenderer;
		this.#getToolsExpanded = options.getToolsExpanded;
		this.#placeStatsCarrier = options.placeStatsCarrier;
		this.binding = new ComponentBinding(this.#states, {
			markPending: (state) => {
				this.#pendingStates.add(state);
			},
			unmarkPending: (state) => this.#pendingStates.delete(state),
		});
	}

	/** Monotonic presentation-generation counter (rebuild lifecycle). */
	get generation(): number {
		return this.#generation;
	}

	/**
	 * Advance the generation without a rebuild: hydration-only boundaries
	 * (initial/resume replay) use the returned token to invalidate stale
	 * settlement microtasks the same way a new rebuild boundary does.
	 */
	bumpGeneration(): number {
		this.#generation++;
		return this.#generation;
	}

	/** The active logical run; undefined between runs. */
	get activeLedger(): TurnLedger | undefined {
		return this.#ledger;
	}

	/** Claim the current working ledger for its delayed terminal audit drain. */
	captureTerminalRunId(): string | undefined {
		if (this.#disposed || this.#ledger?.phase !== "working") return undefined;
		const children = this.#transcript?.children;
		const answerAnchor =
			Array.isArray(children) && children.length > 0
				? children[children.length - 1]
				: undefined;
		this.#deferredTerminalLedgers.set(this.#ledger.runId, {
			ledger: this.#ledger,
			answerAnchor,
		});
		return this.#ledger.runId;
	}

	/**
	 * Release an exact terminal claim after its projection lifecycle settles.
	 * A successful drain already finalized the ledger through `endRun`, so the
	 * release is a no-op (returns `undefined`). A failed/skipped drain never
	 * ran `endRun`; the release then performs the fallback finalization of
	 * exactly the captured ledger (abort/full semantics — complete diagnostic
	 * log, no filtered projection, no stats row) and returns it so the adapter
	 * can request its render. Idempotent: the claim is taken first, and a
	 * second release of the same claim finds nothing.
	 */
	releaseTerminalRun(runId: string | undefined): TurnLedger | undefined {
		if (typeof runId !== "string") return undefined;
		const deferred = this.#deferredTerminalLedgers.get(runId);
		if (!deferred) return undefined;
		this.#deferredTerminalLedgers.delete(runId);
		return this.#finalizeWorkingLedger(deferred.ledger)
			? deferred.ledger
			: undefined;
	}

	/** Frozen display-path snapshot of the active logical run. */
	get displayPaths(): DisplayPathOptions | undefined {
		return this.#displayPaths;
	}

	/** The transcript the stats placement targets; undefined pre-install. */
	get transcript(): TranscriptHost | undefined {
		return this.#transcript;
	}

	attachTranscript(transcript: TranscriptHost | undefined): void {
		this.#transcript = transcript;
	}

	/**
	 * Start a logical run. A continuation (`agent_end` with
	 * `willContinue=true` then a new `agent_start`) keeps the working
	 * ledger; a fresh start finalizes the previous working ledger as full
	 * (abort semantics) when it still owns states.
	 */
	beginRun(): void {
		if (this.#disposed) return;
		if (this.#ledger?.phase === "working" && this.#continuationPending) {
			this.#continuationPending = false;
			return;
		}
		this.#continuationPending = false;
		const activeLedger = this.#ledger;
		if (
			activeLedger?.phase === "working" &&
			this.#hasStates(activeLedger) &&
			!this.#deferredTerminalLedgers.has(activeLedger.runId)
		)
			this.finishFull();
		// A component that never received an exact binding belongs to the
		// preceding run at best. Do not carry its narrow order fallback across
		// this fresh logical boundary.
		this.binding.discardUnboundComponents();
		this.#ledger = this.#createLedger("omp-compact-run-");
		this.#displayPaths = this.#displayPathsSource?.();
		this.binding.tryBindByOrder(this.#ledger);
	}

	/**
	 * Replay branch hydration (session_start). Parses typed branch entries
	 * into ledgers/states, hydrates persisted evidence, pairs components by
	 * observed ids or proven full-cardinality order and reinserts stats
	 * carriers. Returns true when hydration ran; false when the session
	 * already owns live states, is disposed, or the branch is empty (the
	 * caller skips its settlement scheduling in that case).
	 */
	hydrateBranch(entries: readonly unknown[]): boolean {
		if (this.#disposed || this.#states.size > 0 || entries.length === 0)
			return false;
		this.#displayPaths = this.#displayPathsSource?.();
		let ledger: TurnLedger | undefined;
		const ensureLedger = (): TurnLedger => {
			if (ledger?.phase !== "working") {
				ledger = this.#createLedger("omp-compact-replay-");
			}
			return ledger;
		};

		for (const value of entries) {
			const entry = objectRecord(value);
			if (entry.type === "message") {
				const message = objectRecord(entry.message);
				if (message.role === "user") {
					if (ledger?.phase === "working" && ledger.entries.length > 0) {
						this.finalizeLedger(ledger, { messages: [], willContinue: false });
					}
					ledger = this.#createLedger("omp-compact-replay-");
					continue;
				}
				if (message.role === "assistant") {
					const contents = message.content;
					if (Array.isArray(contents)) {
						for (const content of contents) {
							const call = objectRecord(content);
							// F01: identity and payload bounds run before any
							// state allocation; oversized entries stay native.
							if (
								call.type !== "toolCall" ||
								!isBoundedString(call.id, MAX_TOOL_CALL_ID_LENGTH) ||
								!isBoundedString(call.name, MAX_TOOL_NAME_LENGTH) ||
								!isPayloadWithinBudget(call.arguments)
							) {
								continue;
							}
							this.stateForLedger(
								{
									toolCallId: call.id,
									toolName: call.name,
									args: call.arguments,
								},
								ensureLedger(),
							);
						}
					}
					if (
						ledger &&
						classifyAgentEnd({ messages: [message], willContinue: false }) ===
							"filtered"
					) {
						this.finalizeLedger(ledger, {
							messages: [message],
							willContinue: false,
						});
					}
					continue;
				}
				if (
					message.role === "toolResult" &&
					isBoundedString(message.toolCallId, MAX_TOOL_CALL_ID_LENGTH)
				) {
					const state = this.#states.get(message.toolCallId);
					if (state) {
						// F01: an oversized result payload is settled but never
						// retained — the giant object stays in the parsed
						// branch, not in ToolState.
						if (isPayloadWithinBudget(message)) state.result = message;
						state.isPartial = false;
						this.#pendingStates.delete(state);
						state.isError = message.isError === true;
						state.entry.state = state.isError ? "error" : "success";
						state.version++;
					}
				}
				continue;
			}

			if (
				entry.type === "custom" &&
				entry.customType === "tool_execution_start"
			) {
				const data = objectRecord(entry.data);
				// F01: identity and payload bounds run before any state
				// allocation; oversized entries stay native.
				if (
					isBoundedString(data.toolCallId, MAX_TOOL_CALL_ID_LENGTH) &&
					isBoundedString(data.toolName, MAX_TOOL_NAME_LENGTH) &&
					isPayloadWithinBudget(data.args)
				) {
					this.stateForLedger(
						{
							toolCallId: data.toolCallId,
							toolName: data.toolName,
							args: data.args,
						},
						ensureLedger(),
					);
				}
				continue;
			}

			if (entry.type === "custom") {
				this.#hydrateEvidence(entry.customType, entry.data, ledger);
				continue;
			}
			if (entry.type === "custom_message") {
				this.#hydrateEvidence(entry.customType, entry.details, ledger);
			}
		}

		if (ledger?.phase === "working")
			this.finalizeLedger(ledger, { messages: [], willContinue: false });
		this.#ledger = ledger;
		this.#queueReadSegments();
		this.#pendingStates.clear();
		this.binding.bindHydrated(
			true,
			this.#modePolicy?.restoreOverride !== undefined,
		);
		this.#insertHydratedStatsCarriers();
		return true;
	}

	/**
	 * Rebuild lifecycle: begin. Behavior-neutral hook for the C rebuild
	 * phase, called by the transcript clear wrapper before the native
	 * clear. Bumps the generation, preserves the active working ownership
	 * (ledger + its states, same object identity) and retires historical
	 * bindings: finalized states/ledgers leave the state map, terminal
	 * projections and stats carriers are dropped, unbound-component
	 * bookkeeping is reset, every state loses its component ref, and the
	 * exact active component ↔ state associations are preserved so a
	 * synchronously re-added instance restores its binding by object
	 * identity (stock re-adds live components without replaying
	 * updateArgs). Never touches the ledger phase, the pending set of the
	 * active run, or the transcript instance.
	 */
	beginRebuild(): RebuildSnapshot {
		if (this.#rebuildInProgress) {
			// C02 two-quick-clears: a newer clear supersedes the pending
			// rebuild. The preserved active ownership is unchanged (the
			// first beginRebuild kept it in the state map), but components
			// re-added since may have bound — re-capture the identity map
			// from the current bindings and reset, under a fresh
			// generation token so only the latest settlement commits and
			// stale microtasks abort on the token guard.
			this.#generation++;
			const activeLedger =
				this.#ledger?.phase === "working" ? this.#ledger : undefined;
			const activeStates = activeLedger ? this.ledgerStates(activeLedger) : [];
			this.binding.preserveActive(activeStates);
			return { generation: this.#generation, activeLedger, activeStates };
		}
		this.#generation++;
		this.#rebuildInProgress = true;
		const activeLedger =
			this.#ledger?.phase === "working" ? this.#ledger : undefined;
		const activeStates = activeLedger ? this.ledgerStates(activeLedger) : [];
		for (const state of [...this.#states.values()]) {
			if (state.ledger !== activeLedger) this.#states.delete(state.id);
		}
		this.#terminalProjections.clear();
		this.#liveStatsLines.clear();
		this.#hydratedStatsEvidence.length = 0;
		// Preserve the exact active component ↔ state associations before
		// detaching: stock re-adds the same live objects after the clear
		// without replaying their updateArgs callback, so object identity
		// is the only exact evidence left to restore the compact binding.
		this.binding.preserveActive(activeStates);
		return { generation: this.#generation, activeLedger, activeStates };
	}

	/**
	 * Rebuild lifecycle: commit. Called from the C generation-guarded
	 * microtask after the transcript repopulated. Walks the branch entries
	 * like `hydrateBranch` but without its empty-state guard and without
	 * clobbering the preserved active ledger: branch states merge into
	 * snapshot states by exact toolCallId with active ownership winning
	 * (pending/partial evidence is never replaced), historical segments
	 * finalize, bindings resolve by exact observed ids (order fallbacks
	 * only under `allowOrder`), the active ledger is restored when present
	 * and replayed stats carriers are reinserted.
	 */
	commitRebuild(
		snapshot: RebuildSnapshot,
		options: { branchEntries: readonly unknown[] },
	): RebuildOutcome {
		if (!this.#rebuildInProgress || snapshot.generation !== this.#generation) {
			return { generation: this.#generation, mapped: false };
		}
		this.#rebuildInProgress = false;
		const activeLedger =
			snapshot.activeLedger && snapshot.activeLedger.phase === "working"
				? snapshot.activeLedger
				: undefined;
		// The active run's frozen display paths survive the rebuild; only a
		// pure replay (no active ledger) re-snapshots.
		if (!activeLedger) this.#displayPaths = this.#displayPathsSource?.();
		let walkLedger: TurnLedger | undefined;
		const ensureLedger = (): TurnLedger => {
			if (walkLedger?.phase !== "working") {
				walkLedger = this.#createLedger("omp-compact-replay-");
			}
			return walkLedger;
		};

		for (const value of options.branchEntries) {
			const entry = objectRecord(value);
			if (entry.type === "message") {
				const message = objectRecord(entry.message);
				if (message.role === "user") {
					if (
						walkLedger?.phase === "working" &&
						walkLedger.entries.length > 0
					) {
						this.finalizeLedger(walkLedger, {
							messages: [],
							willContinue: false,
						});
					}
					walkLedger = this.#createLedger("omp-compact-replay-");
					continue;
				}
				if (message.role === "assistant") {
					const contents = message.content;
					if (Array.isArray(contents)) {
						for (const content of contents) {
							const call = objectRecord(content);
							// F01: identity and payload bounds run before any
							// state allocation; oversized entries stay native.
							if (
								call.type !== "toolCall" ||
								!isBoundedString(call.id, MAX_TOOL_CALL_ID_LENGTH) ||
								!isBoundedString(call.name, MAX_TOOL_NAME_LENGTH) ||
								!isPayloadWithinBudget(call.arguments)
							) {
								continue;
							}
							this.stateForLedger(
								{
									toolCallId: call.id,
									toolName: call.name,
									args: call.arguments,
								},
								ensureLedger(),
							);
						}
					}
					if (
						walkLedger &&
						classifyAgentEnd({ messages: [message], willContinue: false }) ===
							"filtered"
					) {
						this.finalizeLedger(walkLedger, {
							messages: [message],
							willContinue: false,
						});
					}
					continue;
				}
				if (
					message.role === "toolResult" &&
					isBoundedString(message.toolCallId, MAX_TOOL_CALL_ID_LENGTH)
				) {
					const state = this.#states.get(message.toolCallId);
					// Active ownership wins: the live event stream settles the
					// preserved run's states; branch results must never
					// replace pending/partial evidence.
					if (state && state.ledger !== activeLedger) {
						// F01: an oversized result payload is settled but never
						// retained — the giant object stays in the parsed
						// branch, not in ToolState.
						if (isPayloadWithinBudget(message)) state.result = message;
						state.isPartial = false;
						this.#pendingStates.delete(state);
						state.isError = message.isError === true;
						state.entry.state = state.isError ? "error" : "success";
						state.version++;
					}
				}
				continue;
			}

			if (
				entry.type === "custom" &&
				entry.customType === "tool_execution_start"
			) {
				const data = objectRecord(entry.data);
				// F01: identity and payload bounds run before any state
				// allocation; oversized entries stay native.
				if (
					isBoundedString(data.toolCallId, MAX_TOOL_CALL_ID_LENGTH) &&
					isBoundedString(data.toolName, MAX_TOOL_NAME_LENGTH) &&
					isPayloadWithinBudget(data.args)
				) {
					this.stateForLedger(
						{
							toolCallId: data.toolCallId,
							toolName: data.toolName,
							args: data.args,
						},
						ensureLedger(),
					);
				}
				continue;
			}

			if (entry.type === "custom") {
				this.#hydrateEvidence(
					entry.customType,
					entry.data,
					walkLedger,
					activeLedger,
				);
				continue;
			}
			if (entry.type === "custom_message") {
				this.#hydrateEvidence(
					entry.customType,
					entry.details,
					walkLedger,
					activeLedger,
				);
			}
		}

		if (
			walkLedger &&
			walkLedger !== activeLedger &&
			walkLedger.phase === "working"
		) {
			this.finalizeLedger(walkLedger, { messages: [], willContinue: false });
		}
		this.#ledger = activeLedger ?? walkLedger;
		this.#queueReadSegments();
		// Active pending states stay pending (spinner semantics); walk
		// states of finalized historical segments are drained.
		for (const state of [...this.#pendingStates]) {
			if (state.ledger !== activeLedger) this.#pendingStates.delete(state);
		}
		// Order-based fallbacks bind only when no active working ownership
		// is mixed into the rehydrated presentation (the two orderings
		// diverge); with preserved active states only exact toolCallId
		// evidence binds and ambiguous surfaces stay native.
		const mapped = this.binding.bindHydrated(
			snapshot.activeStates.length === 0,
			// Suffix alignment is a restored-history contract: it pairs the
			// visible tail only when the restore override is armed. A
			// live-session rebuild (no arm — e.g. a finished run re-rendered
			// after a later clear) must never guess positions.
			this.#modePolicy?.restoreOverride !== undefined,
		);
		// Settlement closes the identity window: the synchronous repopulation
		// is over, so preserved active ownership must not bind components of
		// any later generation or logical run.
		this.binding.clearPreserved();
		this.#insertHydratedStatsCarriers();
		return { generation: this.#generation, mapped };
	}

	/**
	 * Queue read-group pairing entries for the hydrated states: one entry
	 * per maximal contiguous run of `read` states in chronological
	 * (insertion) order — a non-read state or a different ledger starts a
	 * new segment. A single ledger spanning several runs contributes
	 * several segments with their exact state ids, so pairing never hands
	 * the whole ledger to the first group (zero-claim starvation of later
	 * segments rendering native).
	 */
	#queueReadSegments(): void {
		let previousReadLedger: TurnLedger | undefined;
		let segmentIds: string[] = [];
		const flushSegment = (): void => {
			if (previousReadLedger !== undefined && segmentIds.length > 0)
				this.binding.addHydratedReadSegment(previousReadLedger, segmentIds);
			previousReadLedger = undefined;
			segmentIds = [];
		};
		for (const state of this.#states.values()) {
			if (state.toolName === "read") {
				if (state.ledger !== previousReadLedger) {
					flushSegment();
					previousReadLedger = state.ledger;
				}
				segmentIds.push(state.id);
			} else {
				flushSegment();
			}
		}
		flushSegment();
	}

	/**
	 * Rebuild lifecycle: abort. Never throws. The C rebuild phase owns the
	 * rollback (its dispose path restores stock presentation); this method
	 * clears the in-progress marker so a later rebuild can start, and closes
	 * the preserved identity window — the exact component ↔ state map is
	 * only valid until the rebuild is cancelled or settled, so it must never
	 * outlive an aborted generation. The unresolved backlog stays: states
	 * that lost their host callback remain exact evidence and must keep
	 * excluding themselves from new-tool fallbacks until the logical-run
	 * boundary (dispose clears it anyway).
	 */
	abortRebuild(snapshot: RebuildSnapshot): void {
		try {
			if (snapshot.generation === this.#generation) {
				this.#rebuildInProgress = false;
				this.binding.clearPreserved();
			}
		} catch {
			// Abort must never throw into the clear wrapper.
		}
	}

	/** Release every reference; idempotent, never throws. */
	dispose(): void {
		if (this.#disposed) return;
		this.finishFull();
		this.binding.reset();
		this.#ledger = undefined;
		this.#transcript = undefined;
		this.#continuationPending = false;
		this.#rebuildInProgress = false;
		this.#states.clear();
		this.#terminalProjections.clear();
		this.#deferredTerminalLedgers.clear();
		this.#pendingStates.clear();
		this.#liveStatsLines.clear();
		this.#hydratedStatsEvidence.length = 0;
		this.#disposed = true;
	}

	/**
	 * Create a new logical ledger (run sequence) with its frozen mode
	 * snapshot. Historical segments use the `omp-compact-replay-` prefix.
	 */
	createLedger(prefix: string): TurnLedger {
		return this.#createLedger(prefix);
	}

	/** The active working ledger, starting one if the session is idle. */
	ensureLedger(): TurnLedger {
		if (this.#ledger?.phase !== "working") this.beginRun();
		if (!this.#ledger) throw new Error("ledger unavailable");
		return this.#ledger;
	}

	/**
	 * Create (or re-key-update) the state record of one tool call in a
	 * ledger. New states record their single chronological ledger entry and
	 * start pending; replay/rebuild walks rely on the exact-toolCallId
	 * absorption (an existing state keeps its identity and evidence).
	 */
	stateForLedger(input: ToolStartInput, ledger: TurnLedger): ToolState {
		const existing = this.#states.get(input.toolCallId);
		if (existing) {
			// A rebuild may replay a stale branch snapshot for an in-flight
			// active state. Only the owning ledger can refresh its args; live
			// event state remains authoritative across that boundary.
			if (existing.ledger === ledger) existing.args = input.args;
			return existing;
		}
		const entry: LedgerEntry = {
			id: input.toolCallId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			state: "running",
			retention: "discard",
		};
		ledger.record(entry);
		const state: ToolState = {
			id: input.toolCallId,
			toolName: input.toolName,
			seq: ++this.#seq,
			args: input.args,
			result: undefined,
			isError: false,
			isPartial: true,
			expanded: this.#getToolsExpanded?.() === true,
			ledger,
			entry,
			mutations: [],
			version: 1,
		};
		this.#states.set(state.id, state);
		this.#pendingStates.add(state);
		return state;
	}

	/** tool_execution_start: create/absorb and mark in-flight. */
	startState(input: ToolStartInput): ToolState {
		const state = this.stateForLedger(input, this.ensureLedger());
		state.args = input.args;
		state.isPartial = true;
		this.#pendingStates.add(state);
		state.version++;
		return state;
	}

	/**
	 * A tool event may mutate a state only while its ledger is still the
	 * mutable working run. Once a ledger finalizes (`filtered`/`full`) — or
	 * a terminal `agent_end` parks it in the deferred-terminal map while the
	 * audit drain runs — its states are frozen: a late
	 * `tool_execution_update`/`end` delivery must not rewrite the settled
	 * run's state, resurrect a spinner row in `#pendingStates`, or bump the
	 * presentation version of an already-committed view. Continuation runs
	 * (`willContinue`) are never captured as deferred and stay working, so
	 * their legitimate events pass unchanged.
	 */
	#stateMutable(state: ToolState): boolean {
		if (state.ledger.phase !== "working") return false;
		if (this.#deferredTerminalLedgers.has(state.ledger.runId)) return false;
		return true;
	}

	/** tool_execution_update: partial result. */
	updateTool(input: ToolResultInput): RenderableBlock | undefined {
		const state = this.#states.get(input.toolCallId);
		if (!state || !this.#stateMutable(state)) return undefined;
		state.result = input.result;
		state.isPartial = input.isPartial === true;
		if (state.isPartial) this.#pendingStates.add(state);
		else this.#pendingStates.delete(state);
		state.isError =
			input.isError || objectRecord(input.result).isError === true;
		state.version++;
		return state.component;
	}

	/** tool_execution_end: settled result. */
	finishTool(input: ToolResultInput): RenderableBlock | undefined {
		const state = this.#states.get(input.toolCallId);
		if (!state || !this.#stateMutable(state)) return undefined;
		state.result = input.result;
		state.isPartial = false;
		this.#pendingStates.delete(state);
		state.isError =
			input.isError || objectRecord(input.result).isError === true;
		state.entry.state = state.isError ? "error" : "success";
		state.version++;
		return state.component;
	}

	/** Verified write/edit/delete mutation evidence (retention class `mutation`). */
	setMutations(
		toolCallId: string,
		entries: (MutationMessageDetails | LegacyMutationMessageDetails)[],
	): RenderableBlock | undefined {
		const state = this.#states.get(toolCallId);
		if (!state) return undefined;
		// Keep any real mutation: non-zero exact counts, and deletes whose
		// path is evidence even when the count is unknown.
		const kept = entries.filter(
			(entry) =>
				entry.toolName === "delete" ||
				(entry.added ?? 0) > 0 ||
				(entry.removed ?? 0) > 0,
		);
		// F01: the live batch respects the same per-state evidence cap as
		// replay hydration; a set beyond the cap cannot claim exactness over
		// the truncated tail (the caller's array is never mutated).
		const truncated = kept.length > MAX_MUTATION_ENTRIES;
		state.mutations = truncated ? kept.slice(0, MAX_MUTATION_ENTRIES) : kept;
		if (state.mutations.length > 0) {
			state.entry.state = "success";
			state.entry.retention = "mutation";
			state.entry.mutation = {
				added: state.mutations.reduce(
					(sum, entry) => sum + (entry.added ?? 0),
					0,
				),
				removed: state.mutations.reduce(
					(sum, entry) => sum + (entry.removed ?? 0),
					0,
				),
				// The aggregate never claims exactness over unknown counts
				// (count-less deletes demote it, matching the F01 truncation
				// demotion).
				exact: state.mutations.every((entry) => entry.exact === true),
			};
			if (truncated) this.#markMutationInexact(state);
		}
		state.version++;
		return state.component;
	}

	/** Recognized Git invocation evidence (retention class `git`). */
	setGit(
		toolCallId: string,
		git: GitMessageDetails | undefined,
	): RenderableBlock | undefined {
		const state = this.#states.get(toolCallId);
		if (!state || !git) return undefined;
		state.git = git;
		state.entry.retention = "git";
		state.entry.git = { text: git.text, isError: git.isError };
		state.version++;
		return state.component;
	}

	/**
	 * agent_end: finalize either the active ledger or an exact terminal claim,
	 * drain its pending states and bump presentation versions. A delayed claim
	 * must never fall back to a newer active run.
	 */
	endRun(
		event: AgentEndInput,
		expectedRunId?: string,
	): "working" | "filtered" | "full" {
		const ledger =
			expectedRunId === undefined
				? this.#ledger
				: (this.#deferredTerminalLedgers.get(expectedRunId)?.ledger ??
					(this.#ledger?.runId === expectedRunId ? this.#ledger : undefined));
		if (!ledger) return "full";
		const isActiveLedger = ledger === this.#ledger;
		const finalization = this.finalizeLedger(ledger, event);
		if (finalization.mode === "working") {
			if (isActiveLedger) this.#continuationPending = true;
			return "working";
		}
		if (isActiveLedger) this.#continuationPending = false;
		this.#bumpLedger(ledger);
		for (const state of this.#pendingStates) {
			if (state.ledger === ledger) this.#pendingStates.delete(state);
		}
		return finalization.mode;
	}

	/** Force the active working ledger to a full (abort) finalization. */
	finishFull(): void {
		const ledger = this.#ledger;
		if (ledger) void this.#finalizeWorkingLedger(ledger);
	}

	/**
	 * Abort-finalize one exact ledger (fail-closed fallback for a failed
	 * terminal drain and the shared `finishFull` path): the full retention
	 * keeps the complete diagnostic log, the ledger leaves the working phase,
	 * and its pending states leave the spinner set. Idempotent per ledger
	 * through `TurnLedger.finalize`; returns true only when this call
	 * performed the finalization.
	 */
	#finalizeWorkingLedger(ledger: TurnLedger): boolean {
		if (ledger.phase !== "working") return false;
		this.finalizeLedger(ledger, { messages: [], willContinue: false });
		this.#bumpLedger(ledger);
		for (const state of this.#pendingStates) {
			if (state.ledger === ledger) this.#pendingStates.delete(state);
		}
		return true;
	}

	/**
	 * RunStats terminal row: record + place a plugin-owned carrier directly
	 * above the run's answer. Exactly once per ledger; fail-open so a stats
	 * failure never disturbs the terminal projection.
	 */
	showStats(runId: string, line: string): boolean {
		if (this.#disposed || typeof line !== "string" || line.length === 0)
			return false;
		const ledger = this.#ledgerByRunId(runId);
		if (!ledger || this.#liveStatsLines.has(ledger)) return false;
		try {
			if (!this.#insertStatsCarrier(ledger, line)) return false;
			this.#liveStatsLines.set(ledger, line);
			return true;
		} catch {
			// The row is decoration; the answer must stay intact.
			return false;
		}
	}

	/** Distinct tool executions of a run, failures included. */
	ledgerActions(runId: string): number | undefined {
		if (this.#disposed) return undefined;
		return this.#ledgerByRunId(runId)?.entries.length;
	}

	/** True when any tool execution of the run settled as an error. */
	ledgerHasError(runId: string): boolean | undefined {
		if (this.#disposed) return undefined;
		const ledger = this.#ledgerByRunId(runId);
		return ledger
			? ledger.entries.some((entry) => entry.state === "error")
			: undefined;
	}

	/** Frozen mode snapshot of a ledger (defaults to enabled `live`). */
	modeFor(ledger: TurnLedger): RunModeSnapshot {
		return this.#ledgerModes.get(ledger) ?? DEFAULT_RUN_MODE;
	}

	/** Finalize a ledger with its frozen mode; idempotent per ledger. */
	finalizeLedger(
		ledger: TurnLedger,
		event: AgentEndEvent | undefined,
	): TurnLedgerResult {
		return ledger.finalize(event, this.modeFor(ledger).mode);
	}

	/** State record by toolCallId. */
	state(id: string): ToolState | undefined {
		return this.#states.get(id);
	}

	/** Snapshot of every state record. */
	allStates(): readonly ToolState[] {
		return [...this.#states.values()];
	}

	/** States belonging to one ledger. */
	ledgerStates(ledger: TurnLedger): readonly ToolState[] {
		return [...this.#states.values()].filter(
			(state) => state.ledger === ledger,
		);
	}

	/** Snapshot of the pending set (in-flight component updates). */
	pending(): readonly ToolState[] {
		return [...this.#pendingStates];
	}

	markPending(state: ToolState): void {
		this.#pendingStates.add(state);
	}

	/** True when the state was pending. */
	unmarkPending(state: ToolState): boolean {
		return this.#pendingStates.delete(state);
	}

	clearPending(): void {
		this.#pendingStates.clear();
	}

	/**
	 * The terminal Git projection of one filtered ledger, computed once and
	 * cached: aggregate commit hashes in transcript (chronological) order
	 * plus the anchor state that renders the trailing summary row. A
	 * ledger's evidence is immutable once finalized — live tool ends drain
	 * before `agent_end`, and replay hydrates every record before the first
	 * render — so the projection needs no invalidation. Read-only: working
	 * evidence and persisted details are never mutated, so live/full phases
	 * and replay keep the original records.
	 */
	terminalProjection(ledger: TurnLedger): TerminalProjection {
		let projection = this.#terminalProjections.get(ledger);
		if (!projection) {
			projection = this.#computeTerminalProjection(ledger);
			this.#terminalProjections.set(ledger, projection);
		}
		return projection;
	}

	/**
	 * C10: after a successful filtered terminal projection, release raw tool
	 * args/results and per-call Git payloads. The immutable terminal projection
	 * is materialized first, so mutation rows and the aggregate commit summary
	 * keep rendering exactly as before; compact-mode/full diagnostics are never
	 * retired. Returns true only when this call released retained payload data.
	 */
	retireFilteredPayloads(runId: string): boolean {
		if (this.#disposed) return false;
		const ledger = this.#ledgerByRunId(runId);
		if (ledger?.phase !== "filtered") return false;
		this.terminalProjection(ledger);
		let retired = false;
		for (const state of this.#states.values()) {
			if (state.ledger !== ledger) continue;
			let stateRetired = false;
			if (state.args !== undefined) {
				state.args = undefined;
				stateRetired = true;
			}
			if (state.result !== undefined) {
				state.result = undefined;
				stateRetired = true;
			}
			if (state.git !== undefined) {
				state.git = undefined;
				stateRetired = true;
			}
			if (stateRetired) {
				state.version++;
				retired = true;
			}
		}
		return retired;
	}

	/** Exact lookup for adapter-owned delayed terminal finalization. */
	ledgerForRun(runId: string): TurnLedger | undefined {
		if (this.#disposed) return undefined;
		return this.#ledgerByRunId(runId);
	}

	#hasStates(ledger: TurnLedger): boolean {
		for (const state of this.#states.values()) {
			if (state.ledger === ledger) return true;
		}
		return false;
	}

	// Linear search through deferred + active + all states. O(n) for large
	// sessions; typical sessions have 10-50 states so this is not a hotspot.
	#ledgerByRunId(runId: string): TurnLedger | undefined {
		if (typeof runId !== "string" || runId.length === 0) return undefined;
		const deferred = this.#deferredTerminalLedgers.get(runId);
		if (deferred) return deferred.ledger;
		if (this.#ledger?.runId === runId) return this.#ledger;
		for (const state of this.#states.values())
			if (state.ledger.runId === runId) return state.ledger;
		return undefined;
	}

	#createLedger(prefix: string): TurnLedger {
		const ledger = new TurnLedger(`${prefix}${++this.#runNumber}`);
		this.#ledgerModes.set(ledger, this.#captureMode());
		return ledger;
	}

	/**
	 * RuntimeModes: the mode snapshot for a new ledger — the armed restore
	 * override (a restored session's historical transcript hydrates
	 * compact), else the active run's frozen snapshot (captured by
	 * ModePolicy at agent_start), else the latest resolved settings, else
	 * the enabled `live` default (fail-open). The override only lives
	 * between a restore entry and the next run boundary (prepareRun clears
	 * it), so live runs always take the persisted policy.
	 */
	#captureMode(): RunModeSnapshot {
		const policy = this.#modePolicy;
		if (policy) {
			const restore = policy.restoreOverride;
			if (restore) return restore;
			const run = policy.run;
			if (run) return run;
			const current = policy.current;
			if (current) return runModeFromSettings(current);
		}
		return DEFAULT_RUN_MODE;
	}

	/**
	 * Replay: parse and apply custom-message evidence (mutation/git/stats). The
	 * `ledger` parameter is the local walk ledger (undefined before the first
	 * run boundary); `skipLedger` is the preserved active working ledger whose
	 * live evidence must not be replaced by stale branch data.
	 */
	#hydrateEvidence(
		customType: unknown,
		details: unknown,
		ledger?: TurnLedger,
		skipLedger?: TurnLedger,
	): void {
		if (
			customType === MUTATION_MESSAGE_TYPE &&
			isMutationMessageDetails(details)
		) {
			const state = this.#states.get(details.toolCallId);
			// Rebuild: active states keep their live evidence; the event
			// stream delivers it again on completion.
			if (state && state.ledger !== skipLedger) {
				// F01: a corrupted branch must not grow the evidence array
				// without bound. Excess carriers are ignored evidence, and
				// the aggregate must not claim exactness of a truncated set.
				if (state.mutations.length >= MAX_MUTATION_ENTRIES) {
					this.#markMutationInexact(state);
					return;
				}
				this.setMutations(details.toolCallId, [...state.mutations, details]);
			}
			return;
		}
		if (customType === GIT_MESSAGE_TYPE && isGitMessageDetails(details)) {
			const state = this.#states.get(details.toolCallId);
			if (state && state.ledger !== skipLedger)
				this.setGit(details.toolCallId, details);
			return;
		}
		if (customType === STATS_MESSAGE_TYPE && isRunStatsEvidence(details)) {
			// The evidence entry sits right after the run's final answer
			// message in the branch, so the local working ledger is the run.
			const target = ledger ?? this.#ledger;
			// A preserved active run renders its stats row only at its own
			// live finalization; branch evidence must not pre-place it.
			if (target && target !== skipLedger) {
				// F01: exactly one stats row per logical run — duplicate
				// carriers in a corrupted branch are ignored evidence.
				if (!this.#hydratedStatsEvidence.some((r) => r.ledger === target))
					this.#hydratedStatsEvidence.push({
						ledger: target,
						evidence: details,
					});
			}
		}
	}

	/**
	 * F01: a mutation carrier was ignored because the per-state evidence
	 * array is at its cap. The aggregate summary must not claim exactness
	 * over a truncated set, so it is demoted to inexact (the filtered
	 * retention then drops the row instead of presenting partial evidence
	 * as complete).
	 */
	#markMutationInexact(state: ToolState): void {
		const mutation = state.entry.mutation;
		if (mutation) state.entry.mutation = { ...mutation, exact: false };
	}

	/**
	 * Replay/rebuild: rebuild the themed stats line from persisted evidence
	 * and reinsert the carrier above the run's answer. Historical runs without
	 * bound tool rows use only the branch-final fallback; a live delayed drain
	 * additionally has an exact terminal answer anchor captured at agent_end.
	 */
	#insertHydratedStatsCarriers(): void {
		if (this.#hydratedStatsEvidence.length === 0) return;
		const transcript = this.#transcript;
		if (!transcript || !Array.isArray(transcript.children)) return;
		for (const record of this.#hydratedStatsEvidence) {
			const line =
				typeof this.#statsRenderer === "function"
					? this.#statsRenderer(record.evidence)
					: undefined;
			if (!line) continue;
			try {
				this.#insertStatsCarrier(record.ledger, line);
			} catch {
				// Fail open: a replayed stats row must not break hydration.
			}
		}
		this.#hydratedStatsEvidence.length = 0;
	}

	/**
	 * The stats carrier sits after the ledger's last bound block, so it
	 * joins the trailing fold run and lands after mutation rows and the
	 * optional Git summary, immediately above the native answer. A no-tool
	 * live run can instead use its exact pre-next-run terminal answer anchor;
	 * replay remains restricted to the branch-final fallback.
	 */
	#insertStatsCarrier(ledger: TurnLedger, line: string): boolean {
		const transcript = this.#transcript;
		if (!transcript || !Array.isArray(transcript.children)) return false;
		const children = transcript.children;
		let index = -1;
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			if (!child || typeof child !== "object") continue;
			const state = this.binding.componentState(child);
			if (state && state.ledger === ledger) {
				index = i + 1;
				break;
			}
			const group = this.binding.groupState(child);
			if (group?.ledger === ledger) {
				index = i + 1;
				break;
			}
		}
		if (index < 0) {
			const deferred = this.#deferredTerminalLedgers.get(ledger.runId);
			const anchor =
				deferred?.ledger === ledger ? deferred.answerAnchor : undefined;
			if (anchor !== undefined) {
				const anchorIndex = children.indexOf(anchor);
				if (anchorIndex >= 0) index = anchorIndex;
			}
		}
		if (index < 0) {
			if (ledger !== this.#ledger) return false;
			index = Math.max(0, children.length - 1);
		}
		if (index > children.length) index = children.length;
		const place = this.#placeStatsCarrier;
		return place?.(transcript, index, createStatsCarrier(line)) === true;
	}

	#bumpLedger(ledger: TurnLedger): void {
		for (const state of this.#states.values())
			if (state.ledger === ledger) state.version++;
		for (const group of this.binding.groups())
			if (group.ledger === ledger) group.version++;
	}

	#computeTerminalProjection(ledger: TurnLedger): TerminalProjection {
		const hashes: string[] = [];
		let anchor: ToolState | undefined;
		const consider = (state: ToolState): void => {
			if (state.ledger !== ledger) return;
			let commitCount = 0;
			if (state.git) {
				const gitHashes = gitCommitHashes(state.git);
				commitCount = gitHashes.length;
				hashes.push(...gitHashes);
			}
			if (state.mutations.length > 0 || commitCount > 0) anchor = state;
		};
		const children = this.#transcript?.children;
		if (children) {
			for (const child of children) {
				if (!child || typeof child !== "object") continue;
				const state = this.binding.componentState(child);
				if (state) consider(state);
			}
		} else {
			const states = [...this.#states.values()]
				.filter((state) => state.ledger === ledger)
				.sort((a, b) => a.seq - b.seq);
			for (const state of states) consider(state);
		}
		return { hashes, anchor };
	}
}
