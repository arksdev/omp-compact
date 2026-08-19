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
	type LegacyMutationMessageDetails,
	MUTATION_MESSAGE_TYPE,
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
	 * Per-run mode policy. The session snapshots the mode when
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
	 * Prefer identity anchors (`before`/`after`); returning false leaves the
	 * native transcript untouched. The seam re-resolves anchors at splice
	 * time — see `insertTranscriptChildAt` — so callers must not invent a
	 * fallback index after an anchor miss.
	 */
	placeStatsCarrier?: (
		transcript: TranscriptHost,
		index: number,
		carrier: unknown,
		options?: {
			readonly before?: unknown;
			readonly after?: unknown;
		},
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
		| ((
				transcript: TranscriptHost,
				index: number,
				carrier: unknown,
				options?: {
					readonly before?: unknown;
					readonly after?: unknown;
				},
		  ) => boolean)
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
	// True only while hydrateBranch/commitRebuild walks apply persisted
	// mutation/Git carriers onto (possibly already-finalized) historical
	// states. Live late publishes after filtered/full stay frozen.
	#replayingBranch = false;
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
			// The observed component callbacks share the exact event-stream
			// freeze: a finalized or deferred-terminal ledger's states must
			// not be rewritten by late updateResult/setArgsComplete
			// deliveries either.
			isStateMutable: (state) => this.#stateMutable(state),
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

	/**
	 * Claim the current working ledger for its delayed terminal audit drain.
	 * Captures the current transcript tail as a best-effort stats answer
	 * anchor. A later transcript `clear`/rebuild may drop that child; stats
	 * placement then fails open by skipping the row (the placement seam
	 * re-resolves the anchor identity at splice time and never invents a
	 * position on a miss — see `insertTranscriptChildAt`). Anchors are
	 * intentionally not cleared in `beginRebuild`: the deferred claim must
	 * outlive the rebuild so a late drain still finalizes the exact ledger,
	 * and evidence stays persisted for hydrate reinsert even when the live
	 * row is skipped.
	 */
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
		this.#replayingBranch = true;
		try {
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
							this.finalizeLedger(ledger, {
								messages: [],
								willContinue: false,
							});
						}
						ledger = this.#createLedger("omp-compact-replay-");
						continue;
					}
					if (message.role === "assistant") {
						const contents = message.content;
						if (Array.isArray(contents)) {
							for (const content of contents) {
								const call = objectRecord(content);
								// Identity and payload bounds run before any
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
							classifyAgentEnd({
								messages: [message],
								willContinue: false,
							}) === "filtered"
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
							// An oversized result payload is settled but never
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
					// Identity and payload bounds run before any state
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
			this.binding.bindHydrated(true, this.#suffixAlignmentArmed());

			this.#insertHydratedStatsCarriers();
			return true;
		} finally {
			this.#replayingBranch = false;
		}
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
			// Two quick clears: a newer clear supersedes the pending
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
		this.#replayingBranch = true;
		try {
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
								// Identity and payload bounds run before any
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
							classifyAgentEnd({
								messages: [message],
								willContinue: false,
							}) === "filtered"
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
							// An oversized result payload is settled but never
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
					// Identity and payload bounds run before any state
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
				this.finalizeLedger(walkLedger, {
					messages: [],
					willContinue: false,
				});
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
				// Suffix alignment pairs a collapsed visible tail with the
				// trailing branch states when either the resume restore
				// override is armed OR a one-shot post-LLM-compaction
				// collapsed-rebuild permit is armed. Ordinary live-session
				// clears (e.g. /shake) leave both unset and never guess.
				this.#suffixAlignmentArmed(),
			);
			// Settlement closes the identity window: the synchronous repopulation
			// is over, so preserved active ownership must not bind components of
			// any later generation or logical run.
			this.binding.clearPreserved();
			// One-shot: the post-compaction suffix permit is spent with this
			// settlement so a later /shake or live clear cannot reuse it.
			this.#modePolicy?.consumeCollapsedRebuild();
			this.#insertHydratedStatsCarriers();
			return { generation: this.#generation, mapped };
		} finally {
			this.#replayingBranch = false;
		}
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
	 * Rebuild lifecycle: abort helper for tests and future soft-recovery.
	 * Production RuntimeAdapter never calls this — a settlement failure takes
	 * the hard `#rollback`/`dispose` path (session-wide disable), not a
	 * generation abort that restores presentation. Never throws. When the
	 * snapshot generation still matches, clears the in-progress marker so a
	 * later rebuild can start, and closes the preserved identity window —
	 * the exact component ↔ state map is only valid until the rebuild is
	 * cancelled or settled. The unresolved backlog stays: states that lost
	 * their host callback remain exact evidence and must keep excluding
	 * themselves from new-tool fallbacks until the logical-run boundary
	 * (dispose clears it anyway). Does not restore historical states or
	 * transcript children discarded by `beginRebuild`.
	 */
	abortRebuild(snapshot: RebuildSnapshot): void {
		try {
			if (snapshot.generation === this.#generation) {
				this.#rebuildInProgress = false;
				this.binding.clearPreserved();
				// A cancelled rebuild must not leave the compaction permit
				// armed for a later unrelated clear (/shake, theme toggle).
				this.#modePolicy?.consumeCollapsedRebuild();
			}
		} catch {
			// Abort must never throw into the clear wrapper.
		}
	}

	/**
	 * Whether bindHydrated may suffix-align a collapsed visible tail.
	 * Resume restore override OR the one-shot post-compaction permit.
	 * Never invents a mode change — mode capture stays on restoreOverride alone.
	 */
	#suffixAlignmentArmed(): boolean {
		const policy = this.#modePolicy;
		if (!policy) return false;
		return policy.restoreOverride !== undefined || policy.collapsedRebuildArmed;
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
		// Live and hydrate share one retained-payload budget: over-budget
		// args stay out of ToolState while the state itself still allocates
		// and binds (losing a row is not acceptable; losing an oversized
		// payload is).
		const retainedArgs = isPayloadWithinBudget(input.args)
			? input.args
			: undefined;
		if (existing) {
			// A rebuild may replay a stale branch snapshot for an in-flight
			// active state. Only the owning ledger can refresh its args; live
			// event state remains authoritative across that boundary.
			if (existing.ledger === ledger) existing.args = retainedArgs;
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
			args: retainedArgs,
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

	/**
	 * tool_execution_start: create/absorb and mark in-flight.
	 *
	 * Live identity bounds match hydration: a missing/non-string or
	 * oversized `toolCallId`/`toolName` never allocates a compact state, so
	 * the call stays native and cannot win a single-pair `tryBindByOrder`
	 * compact binding. Empty-string provisional ids remain valid (stock
	 * event-controller streams `""` then migrates through `updateArgs`);
	 * exact-ID precedence for in-budget ids is unchanged. Hydration already
	 * filters before `stateForLedger`; this is the live entry counterpart.
	 */
	startState(input: ToolStartInput): ToolState | undefined {
		if (
			!isBoundedString(input.toolCallId, MAX_TOOL_CALL_ID_LENGTH) ||
			!isBoundedString(input.toolName, MAX_TOOL_NAME_LENGTH)
		) {
			return undefined;
		}
		const state = this.stateForLedger(input, this.ensureLedger());
		// stateForLedger already applied the retained-payload budget; keep
		// the live refresh on the same rule so a second start with huge
		// args cannot reintroduce the payload.
		state.args = isPayloadWithinBudget(input.args) ? input.args : undefined;
		state.isPartial = true;
		this.#pendingStates.add(state);
		state.version++;
		return state;
	}

	/**
	 * A tool event may mutate a state only while its ledger is still the
	 * mutable working run. Once a ledger finalizes (`filtered`/`full`) its
	 * states are frozen against late `tool_execution_update`/`end`
	 * deliveries: those must not rewrite a settled run's
	 * result/pending/version.
	 *
	 * A terminal `agent_end` parks the ledger in the deferred-terminal map
	 * while the audit drain runs — the phase is still `working`. In that
	 * window:
	 * - streaming `updateTool` stays frozen (partials must not thrash the
	 *   view mid-drain or race the audit evidence);
	 * - authentic `finishTool` for an already-known `toolCallId` stays
	 *   open: stock's fire-and-forget end can land after the park, and
	 *   dropping it would lose the real result (visual settle alone never
	 *   fabricates one). Unknown ids never allocate. Continuation runs
	 *   (`willContinue`) are never captured as deferred and stay fully
	 *   mutable.
	 *
	 * Audit evidence setters (`setMutations`/`setGit`) use a narrower gate
	 * (`#evidenceMutable`): they stay legal while the ledger is still
	 * `working`, including the deferred-terminal window, because
	 * `agent_end` parks the claim before the serialized audit drain
	 * publishes verified mutation/Git rows. After `endRun`/`release`
	 * finalizes the ledger, those setters become silent no-ops too.
	 */
	#stateMutable(state: ToolState): boolean {
		if (state.ledger.phase !== "working") return false;
		if (this.#deferredTerminalLedgers.has(state.ledger.runId)) return false;
		return true;
	}

	/**
	 * Mutation/Git evidence mutability:
	 * - live / deferred-terminal: legal while the ledger is still `working`
	 *   (agent_end parks the claim before the audit drain publishes rows);
	 * - hydrate/rebuild walks: legal even on finalized historical ledgers so
	 *   branch carriers can reattach evidence after the walk finalizes;
	 * - after filtered/full outside a replay walk: silent no-op.
	 */
	#evidenceMutable(state: ToolState): boolean {
		if (this.#replayingBranch) return true;
		return state.ledger.phase === "working";
	}

	/** tool_execution_update: partial result. */
	updateTool(input: ToolResultInput): RenderableBlock | undefined {
		const state = this.#states.get(input.toolCallId);
		if (!state || !this.#stateMutable(state)) return undefined;
		state.result = isPayloadWithinBudget(input.result)
			? input.result
			: undefined;
		state.isPartial = input.isPartial === true;
		if (state.isPartial) this.#pendingStates.add(state);
		else this.#pendingStates.delete(state);
		state.isError =
			input.isError || objectRecord(input.result).isError === true;
		state.version++;
		return state.component;
	}

	/**
	 * tool_execution_end: settled result. Allowed for any already-known
	 * state whose ledger is still `working` — including the deferred-
	 * terminal window after `captureTerminalRunId` — so a late host end
	 * records the authentic payload. Gate is phase-only (not the deferred
	 * map): `#states.get` already limits to known ids, and a finalized
	 * ledger (`filtered`/`full`) stays frozen. Never allocates unknown ids.
	 * Over-budget results settle the entry without retaining the payload
	 * (same budget as hydrateBranch / commitRebuild).
	 */
	finishTool(input: ToolResultInput): RenderableBlock | undefined {
		const state = this.#states.get(input.toolCallId);
		if (state?.ledger.phase !== "working") return undefined;
		state.result = isPayloadWithinBudget(input.result)
			? input.result
			: undefined;
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
		// Finalized ledgers freeze evidence; deferred-terminal (still working)
		// stays open so the agent_end audit drain can publish verified rows.
		if (!state || !this.#evidenceMutable(state)) return undefined;
		// Keep any real mutation: non-zero exact counts, and deletes whose
		// path is evidence even when the count is unknown.
		const kept = entries.filter(
			(entry) =>
				entry.toolName === "delete" ||
				(entry.added ?? 0) > 0 ||
				(entry.removed ?? 0) > 0,
		);
		// The live batch respects the same per-state evidence cap as
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
				// (count-less deletes demote it, matching the truncation
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
		// Finalized ledgers freeze evidence; deferred-terminal (still working)
		// stays open so the agent_end audit drain can publish verified rows.
		if (!state || !git || !this.#evidenceMutable(state)) return undefined;
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
		this.#settleLedgerVisualState(ledger);
		this.#bumpLedger(ledger);
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
	 * and its pending/partial visual state is settled. Idempotent per ledger
	 * through `TurnLedger.finalize`; returns true only when this call
	 * performed the finalization.
	 */
	#finalizeWorkingLedger(ledger: TurnLedger): boolean {
		if (ledger.phase !== "working") return false;
		this.finalizeLedger(ledger, { messages: [], willContinue: false });
		this.#settleLedgerVisualState(ledger);
		this.#bumpLedger(ledger);
		return true;
	}

	/**
	 * After a ledger leaves `working` (`filtered`/`full`), no tool row may
	 * remain in a live partial/pending visual state. Stock can drop
	 * `tool_execution_end` after `agent_end` parks the claim; when the end
	 * never arrives, `finishTool` never runs and used to leave `isPartial`
	 * true forever — the renderer kept `Working…` and suppressed mutation/
	 * Git rows behind `!view.isPartial` even though the audit drain had
	 * already published verified evidence.
	 *
	 * Settle the visual flags only:
	 * - `isPartial = false` and drop from `#pendingStates` for every state
	 *   on this ledger (evidence rows can render; spinner stops).
	 * - Do **not** fabricate a settled result or promote `entry.state` to
	 *   success/error here. `finishTool` (allowed during the deferred
	 *   window for known ids) and audit `setMutations` already promote
	 *   when real evidence exists; a tool that never received an end
	 *   event keeps its prior entry state (typically `running`) so the
	 *   ledger does not claim success it never observed. After
	 *   finalization, late `tool_execution_update`/`end` stay frozen.
	 */
	#settleLedgerVisualState(ledger: TurnLedger): void {
		for (const state of this.#states.values()) {
			if (state.ledger !== ledger) continue;
			state.isPartial = false;
			this.#pendingStates.delete(state);
		}
	}

	/**
	 * RunStats terminal row: record + place a plugin-owned carrier directly
	 * above the run's answer. Exactly once per ledger; fail-open so a stats
	 * failure never disturbs the terminal projection.
	 *
	 * Invariant: persisted stats evidence (staged at agent_end into the
	 * branch) may exist without a carrier in the current transcript frame —
	 * e.g. failed/skipped drain drops the pending line, or placement cannot
	 * find an anchor after rebuild. Resume hydrate may still reinsert from
	 * evidence; this method never invents a row from stale placement state.
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
	 * Mode snapshot for a new ledger — the armed restore
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
				// A corrupted branch must not grow the evidence array
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
				// Exactly one stats row per logical run — duplicate
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
	 * A mutation carrier was ignored because the per-state evidence
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
	 *
	 * Position is handed to the placement seam as an identity anchor
	 * (`before`/`after`), not a bare numeric index. The seam re-resolves the
	 * anchor immediately before the splice; a detached/cleared anchor skips
	 * the row rather than inventing a fallback position (appending would put
	 * the stats under the wrong answer after a rebuild).
	 */
	#insertStatsCarrier(ledger: TurnLedger, line: string): boolean {
		const transcript = this.#transcript;
		if (!transcript || !Array.isArray(transcript.children)) return false;
		const children = transcript.children;
		const place = this.#placeStatsCarrier;
		if (!place) return false;
		const carrier = createStatsCarrier(line);

		// Prefer the last bound tool/read-group block of this ledger.
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			if (!child || typeof child !== "object") continue;
			const state = this.binding.componentState(child);
			if (state && state.ledger === ledger) {
				return place(transcript, i + 1, carrier, { after: child }) === true;
			}
			const group = this.binding.groupState(child);
			if (group?.ledger === ledger) {
				return place(transcript, i + 1, carrier, { after: child }) === true;
			}
		}

		// No-tool delayed drain: insert immediately before the captured answer.
		const deferred = this.#deferredTerminalLedgers.get(ledger.runId);
		const answerAnchor =
			deferred?.ledger === ledger ? deferred.answerAnchor : undefined;
		if (answerAnchor !== undefined) {
			// Miss → skip. Never fall through to a guessed index.
			return place(transcript, -1, carrier, { before: answerAnchor }) === true;
		}

		// Active-run, no-tool path with no deferred claim: place before the
		// current transcript tail (the native answer). Historical ledgers
		// without a bound block or answer anchor skip rather than guess.
		if (ledger !== this.#ledger) return false;
		if (children.length === 0) {
			return place(transcript, 0, carrier) === true;
		}
		const tail = children[children.length - 1];
		return (
			place(transcript, children.length - 1, carrier, { before: tail }) === true
		);
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
