/**
 * B05: rebuild / branch-hydration lifecycle of `RuntimeSessionState`.
 *
 * `RuntimeSessionState` keeps its public methods as the entry points; this
 * module owns the lifecycle logic behind them: the persisted-branch walks
 * (`hydrateBranch`, `commitRebuild` — one shared walk), the rebuild
 * ownership transaction (`beginRebuild`) and its abort, the read-segment
 * bookkeeping the walks drive, persisted-evidence hydration and the
 * replayed stats-carrier insertion.
 *
 * All mutable session state stays in `RuntimeSessionState`. `RebuildLifecycle`
 * reaches it only through the explicit `RebuildLifecycleAccess` seam the
 * session constructs from its private fields, so the extraction never widens
 * the session's public surface. This class owns only walk-scoped bookkeeping
 * (`#readSegmentBreaks`, `#lastGroupedRead`).
 */

function canonicalizeMessage(text: string | null | undefined): string {
	if (!text) return "";
	const trimmed = text.trim();
	for (let i = 0; i < trimmed.length; i++) {
		const code = trimmed.charCodeAt(i);
		if (
			code !== 0x2e &&
			code !== 0x2026 &&
			code !== 0x20 &&
			code !== 0x09 &&
			code !== 0x0a &&
			code !== 0x0d
		) {
			return trimmed;
		}
	}
	return "";
}

import type { ComponentBinding } from "./component-binding";
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
import type { ModePolicy } from "./mode-policy";
import { objectRecord } from "./object-record";
import {
	isRunStatsEvidence,
	type RunStatsEvidence,
	STATS_MESSAGE_TYPE,
} from "./run-stats";
import type {
	RebuildOutcome,
	RebuildSnapshot,
	TerminalProjection,
	ToolStartInput,
	ToolState,
} from "./runtime-session-state";
import type { RenderableBlock, TranscriptHost } from "./transcript-fold";
import {
	type AgentEndEvent,
	classifyAgentEnd,
	type TurnLedger,
	type TurnLedgerResult,
} from "./turn-ledger";

/**
 * The session-facing seam through which the lifecycle reaches
 * `RuntimeSessionState`'s private session state and unchanged entry
 * helpers. Built once inside the session from its private fields, so the
 * extraction never widens the session's public surface: every member is
 * either a collection/flag the lifecycle must read or drive, or a bound
 * callback into the session's own implementation.
 */
export interface RebuildLifecycleAccess {
	/** Component ↔ state associations (see ComponentBinding). */
	readonly binding: ComponentBinding;
	/** The session's state map (walked and pruned by the lifecycle). */
	readonly states: Map<string, ToolState>;
	/** In-flight/partial states (spinner semantics; drained by walks). */
	readonly pendingStates: Set<ToolState>;
	/**
	 * Persisted run-stats evidence staged by the replay walks, one record
	 * per logical run; reinserted by `#insertHydratedStatsCarriers` and
	 * dropped at `beginRebuild`.
	 */
	readonly hydratedStatsEvidence: Array<{
		ledger: TurnLedger;
		evidence: RunStatsEvidence;
	}>;
	/** The active working ledger; undefined between runs. */
	ledger: TurnLedger | undefined;
	/** Monotonic presentation-generation counter (rebuild lifecycle). */
	generation: number;
	/** True between `beginRebuild` and its commit/abort. */
	rebuildInProgress: boolean;
	/**
	 * True only while hydrate/commit walks apply persisted mutation/Git
	 * carriers onto (possibly already-finalized) historical states. Live
	 * late publishes after filtered/full stay frozen.
	 */
	replayingBranch: boolean;
	/** Frozen display-path snapshot of the active logical run. */
	displayPaths: DisplayPathOptions | undefined;
	/** Display-path options resolved when a run/rebuild boundary starts. */
	readonly displayPathsSource: (() => DisplayPathOptions) | undefined;
	/** The transcript the stats placement targets; undefined pre-install. */
	readonly transcript: TranscriptHost | undefined;
	/** Terminal projections; a rebuild drops them with the old history. */
	readonly terminalProjections: Map<TurnLedger, TerminalProjection>;
	/** Exactly-once guard for live terminal stats rows. */
	readonly liveStatsLines: Map<TurnLedger, string>;
	/** Per-run mode policy (suffix-alignment arm / collapse permit). */
	readonly modePolicy: ModePolicy | undefined;
	/** Replay seam (RunStats): rebuild a themed stats line from evidence. */
	readonly statsRenderer:
		| ((evidence: RunStatsEvidence) => string | undefined)
		| undefined;
	/** True after `dispose`; hydration refuses to run on a disposed session. */
	readonly disposed: boolean;
	/** Settle-time clock seam, shared with the session's live settle paths. */
	now(): number;
	/** Create a new logical ledger (run sequence) with its frozen mode. */
	createLedger(prefix: string): TurnLedger;
	/** Finalize a ledger with its frozen mode; idempotent per ledger. */
	finalizeLedger(
		ledger: TurnLedger,
		event: AgentEndEvent | undefined,
	): TurnLedgerResult;
	/** Create (or re-key-update) the state record of one tool call. */
	stateForLedger(input: ToolStartInput, ledger: TurnLedger): ToolState;
	/** Verified write/edit/delete mutation evidence (retention `mutation`). */
	setMutations(
		toolCallId: string,
		entries: (MutationMessageDetails | LegacyMutationMessageDetails)[],
	): RenderableBlock | undefined;
	/** Recognized Git invocation evidence (retention class `git`). */
	setGit(
		toolCallId: string,
		git: GitMessageDetails | undefined,
	): RenderableBlock | undefined;
	/** States belonging to one ledger. */
	ledgerStates(ledger: TurnLedger): readonly ToolState[];
	/** Insert a plugin-owned stats carrier above the ledger's answer. */
	insertStatsCarrier(ledger: TurnLedger, line: string): boolean;
}

/**
 * The parameters that distinguish the two branch walks. The walks share
 * every step; the preserved active ownership (`activeLedger`) and the
 * order-pairing permit (`allowOrder`) are the only behavior differences
 * between a pure replay (`hydrateBranch`) and a rebuild commit over
 * preserved active states.
 */
interface BranchWalkOptions {
	/**
	 * Preserved active working ledger (rebuild commit): branch results and
	 * evidence must never replace its live pending/partial evidence. A pure
	 * replay passes `undefined`, and every `!== undefined` ownership guard
	 * then holds trivially — `hydrateBranch` behavior stays identical.
	 */
	readonly activeLedger: TurnLedger | undefined;
	/**
	 * Order-based pairing fallback permit: `hydrateBranch` always allows
	 * it; `commitRebuild` only when no active states are preserved (the
	 * two orderings diverge).
	 */
	readonly allowOrder: boolean;
}

/**
 * The rebuild / branch-hydration lifecycle of one `RuntimeSessionState`.
 * Constructed by the session with the `RebuildLifecycleAccess` seam; the
 * session's public methods delegate here and the C rebuild phase never
 * observes this class directly.
 */
export class RebuildLifecycle {
	readonly #access: RebuildLifecycleAccess;
	/**
	 * Read-segment boundaries discovered by the current branch walk: the
	 * newest grouped-read state id of an assistant message whose usage row
	 * cannot join the read group. Stock seals the group and starts a fresh
	 * one at exactly those points (`flushPendingUsage` →
	 * `groupedReadUsageCallIds`), so segments must split there too —
	 * otherwise the visible group count exceeds the segment count and
	 * `bindHydrated` pairs nothing, leaving every restored read native.
	 */
	#readSegmentBreaks = new Set<string>();
	/** Newest grouped-read state id seen by the current branch walk. */
	#lastGroupedRead: string | undefined;

	constructor(access: RebuildLifecycleAccess) {
		this.#access = access;
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
		const access = this.#access;
		if (access.disposed || access.states.size > 0 || entries.length === 0)
			return false;
		this.#walkBranch(entries, { activeLedger: undefined, allowOrder: true });
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
		const access = this.#access;
		if (access.rebuildInProgress) {
			// Two quick clears: a newer clear supersedes the pending
			// rebuild. The preserved active ownership is unchanged (the
			// first beginRebuild kept it in the state map), but components
			// re-added since may have bound — re-capture the identity map
			// from the current bindings and reset, under a fresh
			// generation token so only the latest settlement commits and
			// stale microtasks abort on the token guard.
			access.generation++;
			const activeLedger =
				access.ledger?.phase === "working" ? access.ledger : undefined;
			const activeStates = activeLedger
				? access.ledgerStates(activeLedger)
				: [];
			access.binding.preserveActive(activeStates);
			return { generation: access.generation, activeLedger, activeStates };
		}
		access.generation++;
		access.rebuildInProgress = true;
		const activeLedger =
			access.ledger?.phase === "working" ? access.ledger : undefined;
		const activeStates = activeLedger ? access.ledgerStates(activeLedger) : [];
		for (const state of [...access.states.values()]) {
			if (state.ledger !== activeLedger) access.states.delete(state.id);
		}
		access.terminalProjections.clear();
		access.liveStatsLines.clear();
		access.hydratedStatsEvidence.length = 0;
		// Preserve the exact active component ↔ state associations before
		// detaching: stock re-adds the same live objects after the clear
		// without replaying their updateArgs callback, so object identity
		// is the only exact evidence left to restore the compact binding.
		access.binding.preserveActive(activeStates);
		return { generation: access.generation, activeLedger, activeStates };
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
		const access = this.#access;
		if (
			!access.rebuildInProgress ||
			snapshot.generation !== access.generation
		) {
			return { generation: access.generation, mapped: false };
		}
		access.rebuildInProgress = false;
		const activeLedger =
			snapshot.activeLedger && snapshot.activeLedger.phase === "working"
				? snapshot.activeLedger
				: undefined;
		const mapped = this.#walkBranch(options.branchEntries, {
			activeLedger,
			allowOrder: snapshot.activeStates.length === 0,
		});
		// Settlement closes the identity window: the synchronous repopulation
		// is over, so preserved active ownership must not bind components of
		// any later generation or logical run.
		access.binding.clearPreserved();
		// One-shot: the suffix permit is spent with this settlement so a
		// later user `/shake` or live clear cannot reuse it.
		access.modePolicy?.consumeCollapsedRebuild();
		this.#insertHydratedStatsCarriers();
		return { generation: access.generation, mapped };
	}

	/**
	 * Walk persisted branch entries into ledgers/states, apply tool results
	 * and evidence, then settle pairing. Shared by `hydrateBranch` (pure
	 * replay: no preserved ownership) and `commitRebuild` (branch states
	 * merge into the preserved active ledger, whose live evidence always
	 * wins). Owns the replay-walk flag for its whole span, matching the
	 * original try/finally of both callers. Returns the `bindHydrated`
	 * outcome; the commit-only settlement steps (`clearPreserved`,
	 * `consumeCollapsedRebuild`) stay in the caller so their order after
	 * `bindHydrated` is preserved exactly.
	 */
	#walkBranch(
		entries: readonly unknown[],
		options: BranchWalkOptions,
	): boolean {
		const access = this.#access;
		// The active run's frozen display paths survive the rebuild; only a
		// pure replay (no active ledger) re-snapshots.
		if (!options.activeLedger)
			access.displayPaths = access.displayPathsSource?.();
		access.replayingBranch = true;
		try {
			let walkLedger: TurnLedger | undefined;
			const ensureLedger = (): TurnLedger => {
				if (walkLedger?.phase !== "working") {
					walkLedger = access.createLedger("omp-compact-replay-");
				}
				return walkLedger;
			};
			this.#readSegmentBreaks.clear();
			this.#lastGroupedRead = undefined;

			for (const value of entries) {
				const entry = objectRecord(value);
				if (entry.type === "message") {
					const message = objectRecord(entry.message);
					if (message.role === "user") {
						if (
							walkLedger?.phase === "working" &&
							walkLedger.entries.length > 0
						) {
							access.finalizeLedger(walkLedger, {
								messages: [],
								willContinue: false,
							});
						}
						walkLedger = access.createLedger("omp-compact-replay-");
						continue;
					}
					if (message.role === "assistant") {
						const contents = message.content;
						this.#breakReadSegmentOnVisibleContent(contents);
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
								access.stateForLedger(
									{
										toolCallId: call.id,
										toolName: call.name,
										args: call.arguments,
									},
									ensureLedger(),
								);
								if (
									call.name === "read" &&
									access.binding.isGroupPresentationRead(call.id)
								)
									this.#lastGroupedRead = call.id;
							}
						}
						if (
							walkLedger &&
							classifyAgentEnd({
								messages: [message],
								willContinue: false,
							}) === "filtered"
						) {
							access.finalizeLedger(walkLedger, {
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
						const state = access.states.get(message.toolCallId);
						// Active ownership wins: the live event stream settles the
						// preserved run's states; branch results must never
						// replace pending/partial evidence.
						if (state && state.ledger !== options.activeLedger) {
							// An oversized result payload is settled but never
							// retained — the giant object stays in the parsed
							// branch, not in ToolState.
							if (isPayloadWithinBudget(message)) state.result = message;
							state.isPartial = false;
							// Freeze the frame clock: a hydrated settled row must
							// repaint identically. `settledAt` is a render clock,
							// never persisted and never shown as a claim, so the
							// hydration moment is the honest stamp — the row's
							// visible timestamps still come from its evidence.
							state.settledAt ??= access.now();
							access.pendingStates.delete(state);
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
						access.stateForLedger(
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
						options.activeLedger,
					);
					continue;
				}
				if (entry.type === "custom_message") {
					this.#hydrateEvidence(
						entry.customType,
						entry.details,
						walkLedger,
						options.activeLedger,
					);
				}
			}

			if (
				walkLedger &&
				walkLedger !== options.activeLedger &&
				walkLedger.phase === "working"
			) {
				access.finalizeLedger(walkLedger, {
					messages: [],
					willContinue: false,
				});
			}
			access.ledger = options.activeLedger ?? walkLedger;
			this.#queueReadSegments();
			// Active pending states stay pending (spinner semantics); walk
			// states of finalized historical segments are drained.
			for (const state of [...access.pendingStates]) {
				if (state.ledger !== options.activeLedger)
					access.pendingStates.delete(state);
			}
			// Order-based fallbacks bind only when no active working ownership
			// is mixed into the rehydrated presentation (the two orderings
			// diverge); with preserved active states only exact toolCallId
			// evidence binds and ambiguous surfaces stay native.
			const mapped = access.binding.bindHydrated(
				options.allowOrder,
				// Suffix alignment pairs a collapsed visible tail with the
				// trailing branch states when either the resume restore
				// override is armed OR the one-shot collapsed-rebuild
				// permit is armed (LLM compaction, or our own automatic
				// post-turn shake elide). A live clear with neither armed —
				// the user's own `/shake` command, a theme toggle — never
				// guesses.
				this.#suffixAlignmentArmed(),
			);
			return mapped;
		} finally {
			access.replayingBranch = false;
		}
	}

	/**
	 * Stock closes the current read run at every assistant message that has
	 * visible content — text, thinking or an image — regardless of where it
	 * sits in the message (`ui-helpers` seals the group under
	 * `assistantHasVisibleContent`; this mirrors that predicate, including
	 * its canonicalization, so the counts cannot drift). Called BEFORE the
	 * message's own tool states exist: the break closes the run accumulated
	 * so far, and this message's reads open a fresh segment.
	 */
	#breakReadSegmentOnVisibleContent(contents: unknown): void {
		if (this.#lastGroupedRead === undefined) return;
		if (!Array.isArray(contents)) return;
		for (const content of contents) {
			const part = objectRecord(content);
			if (
				part.type === "image" ||
				(part.type === "text" &&
					typeof part.text === "string" &&
					canonicalizeMessage(part.text) !== "") ||
				(part.type === "thinking" &&
					typeof part.thinking === "string" &&
					canonicalizeMessage(part.thinking) !== "")
			) {
				this.#readSegmentBreaks.add(this.#lastGroupedRead);
				return;
			}
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
		const access = this.#access;
		let previousReadLedger: TurnLedger | undefined;
		let segmentIds: string[] = [];
		const flushSegment = (): void => {
			if (previousReadLedger !== undefined && segmentIds.length > 0)
				access.binding.addHydratedReadSegment(previousReadLedger, segmentIds);
			previousReadLedger = undefined;
			segmentIds = [];
		};
		for (const state of access.states.values()) {
			// Only group-presentation reads join segments. Full-card internal
			// URL reads seal the current segment (like a non-read) so they
			// pair through the tool-component path instead.
			if (
				state.toolName === "read" &&
				access.binding.isGroupPresentationRead(state.id)
			) {
				if (state.ledger !== previousReadLedger) {
					flushSegment();
					previousReadLedger = state.ledger;
				}
				segmentIds.push(state.id);
				if (this.#readSegmentBreaks.has(state.id)) flushSegment();
			} else {
				flushSegment();
			}
		}
		flushSegment();
	}

	/**
	 * Whether bindHydrated may suffix-align a collapsed visible tail.
	 * Resume restore override OR the one-shot post-compaction permit.
	 * Never invents a mode change — mode capture stays on restoreOverride alone.
	 */
	#suffixAlignmentArmed(): boolean {
		const policy = this.#access.modePolicy;
		if (!policy) return false;
		return policy.restoreOverride !== undefined || policy.collapsedRebuildArmed;
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
		const access = this.#access;
		if (
			customType === MUTATION_MESSAGE_TYPE &&
			isMutationMessageDetails(details)
		) {
			const state = access.states.get(details.toolCallId);
			// Rebuild: active states keep their live evidence; the event
			// stream delivers it again on completion.
			if (state && state.ledger !== skipLedger) {
				// A corrupted branch must not grow the evidence array
				// without bound. Excess carriers are ignored evidence, and
				// the aggregate must not claim exactness of a truncated set.
				if (state.mutations.length >= MAX_MUTATION_ENTRIES) {
					this.markMutationInexact(state);
					return;
				}
				access.setMutations(details.toolCallId, [...state.mutations, details]);
			}
			return;
		}
		if (customType === GIT_MESSAGE_TYPE && isGitMessageDetails(details)) {
			const state = access.states.get(details.toolCallId);
			if (state && state.ledger !== skipLedger)
				access.setGit(details.toolCallId, details);
			return;
		}
		if (customType === STATS_MESSAGE_TYPE && isRunStatsEvidence(details)) {
			// The evidence entry sits right after the run's final answer
			// message in the branch, so the local working ledger is the run.
			const target = ledger ?? access.ledger;
			// A preserved active run renders its stats row only at its own
			// live finalization; branch evidence must not pre-place it.
			if (target && target !== skipLedger) {
				// Exactly one stats row per logical run — duplicate
				// carriers in a corrupted branch are ignored evidence.
				if (!access.hydratedStatsEvidence.some((r) => r.ledger === target))
					access.hydratedStatsEvidence.push({
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
	markMutationInexact(state: ToolState): void {
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
		const access = this.#access;
		if (access.hydratedStatsEvidence.length === 0) return;
		const transcript = access.transcript;
		if (!transcript || !Array.isArray(transcript.children)) return;
		for (const record of access.hydratedStatsEvidence) {
			const line =
				typeof access.statsRenderer === "function"
					? access.statsRenderer(record.evidence)
					: undefined;
			if (!line) continue;
			try {
				access.insertStatsCarrier(record.ledger, line);
			} catch {
				// Fail open: a replayed stats row must not break hydration.
			}
		}
		access.hydratedStatsEvidence.length = 0;
	}
}
