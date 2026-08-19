/**
 * B03: structured exact-ID / provisional / read-group component binding.
 *
 * Owns every component ↔ toolCallId association of the session:
 * - exact-ID binding through `updateArgs`/`updateResult`/`setArgsComplete`;
 * - provisional → real ID migration (stock hosts stream entries under an
 *   empty or provisional id and rebind through `updateArgs(args, realId)`),
 *   including the read group's `renameEntry` path;
 * - read-group observed-id ownership (`observedIds`) and replay pairing;
 * - the unbound-component insertion queue and the safe replay fallback
 *   (single-pair order, exact full-cardinality order, or — when stock
 *   collapsed a compacted/summarized session's hidden prefix behind the
 *   summary divider (`display.collapseCompacted`) and reconstructed only
 *   the newest tail — suffix-aligned order pairing the visible tail with
 *   the trailing states/ledgers). Positional guessing is never applied
 *   against preserved active ownership, non-tail shapes or visible sets
 *   larger than the branch.
 *
 * Every operation reports an explicit status: `bound`, `ambiguous`,
 * `incompatible` or `unmapped`. Unknown/mixed/ambiguous/incompatible
 * mappings stay native — the module never throws for a conflict. The
 * adapter quarantines the observing component on `ambiguous` (per-surface
 * native fail-open) and reserves session-wide rollback for host-invariant
 * failures.
 *
 * The module contains no colors, no rows, no theme and no UI: presentation
 * never enters this layer.
 */

import {
	removeEntryToolCallId,
	renameEntryIds,
	setExpandedValue,
	updateArgsPayload,
	updateArgsToolCallId,
	updateResultIsPartial,
	updateResultPayload,
	updateResultToolCallId,
} from "./host-adapter";
import { objectRecord } from "./object-record";
import type { GroupState, ToolState } from "./runtime-session-state";
import type { RenderableBlock } from "./transcript-fold";
import type { TurnLedger } from "./turn-ledger";

export type BindingStatus = "bound" | "ambiguous" | "incompatible" | "unmapped";

export interface BindingDelegates {
	/** Register a state as pending (in-flight component update). */
	markPending(state: ToolState): void;
	/** Unregister a pending state; true when it was pending. */
	unmarkPending(state: ToolState): boolean;
	/**
	 * Whether an observed host callback may still mutate a state's settled
	 * evidence (result/isPartial/isError/pending/args/version). Production
	 * passes RuntimeSessionState's exact `#stateMutable` semantics: a
	 * finalized ledger (`filtered`/`full`) or a deferred-terminal ledger
	 * freezes its states. Binding/ownership (component refs, id migration,
	 * group/ledger assignment) stays legal on frozen states — hydration
	 * and rebuild replay legitimately re-bind them.
	 */
	isStateMutable(state: ToolState): boolean;
}

/**
 * One contiguous run of read states queued for read-group pairing. The
 * rebuild/hydration walk emits one entry per maximal run (same ledger, no
 * interleaved non-read); `stateIds` are the exact state ids of the run in
 * chronological order. `stateIds === undefined` is the legacy ledger-level
 * queue shape, resolved at pair time to the ledger's unbound read states.
 */
interface HydratedReadSegment {
	ledger: TurnLedger;
	stateIds: readonly string[] | undefined;
}

/**
 * Component ↔ toolCallId association store. RuntimeSessionState owns the
 * state records and ledgers; this class owns every mapping between host
 * components and those records.
 */
export class ComponentBinding {
	readonly #states: Map<string, ToolState>;
	readonly #delegates: BindingDelegates;
	#componentStates = new WeakMap<object, ToolState>();
	#groupStates = new WeakMap<object, GroupState>();
	readonly #groups = new Set<GroupState>();
	#unboundComponents: RenderableBlock[] = [];
	/**
	 * Replayed read segments queued for group pairing (chronological
	 * branch order). A segment is one maximal contiguous run of read
	 * states; a single ledger can contribute several segments when a run
	 * interleaves a non-read (read, bash, read). Pairing claims only the
	 * segment's exact state ids, so a later segment of the same ledger is
	 * never starved by the first group claiming the whole ledger.
	 * `stateIds === undefined` is the legacy ledger-level queue shape,
	 * resolved at pair time to the ledger's unbound read states — kept
	 * only for unit tests that queue one read state per ledger.
	 */
	#hydratedReadSegments: HydratedReadSegment[] = [];
	/**
	 * Rebuild identity window: the exact active component ↔ state
	 * associations captured by `preserveActive` before a rebuild detaches
	 * presentation. A re-added component restores its binding only when it
	 * is the same object (`registerUnboundComponent`) — stock re-adds live
	 * `ToolExecutionComponent` instances without replaying the historical
	 * `updateArgs(args, toolCallId)` callback, and object identity is exact
	 * evidence that never weakens the fail-open ambiguity guards. A plain
	 * (strong) Map because the window is bounded — cleared by
	 * `clearPreserved` (rebuild settlement), `discardUnboundComponents`
	 * (logical-run boundary) and `reset` (dispose) — so stale active
	 * ownership can never bind a later generation's components and the
	 * references cannot leak past the window.
	 */
	#preservedActive: Map<object, ToolState> | undefined;
	/**
	 * Rebuild backlog: active working states preserved across a rebuild
	 * that never found their host component again (identity restore failed
	 * or the object was never re-added). They stay full evidence in the
	 * ledger, but as unresolved candidates they must never join — or
	 * poison — the single-pair order fallback of a genuinely new tool in
	 * the same logical run: `tryBindByOrder` scopes its candidates to
	 * fresh starts only. A state leaves the backlog the moment it binds
	 * (`bind`), so exact-ID replays and identity restores resolve
	 * normally; the backlog itself closes at the logical-run boundary
	 * (`discardUnboundComponents`) and on dispose (`reset`). Rebuild
	 * settlement and abort intentionally keep it: the unresolved states
	 * keep protecting later new tools until the run is over.
	 */
	#rebuildBacklog = new Set<ToolState>();

	constructor(states: Map<string, ToolState>, delegates: BindingDelegates) {
		this.#states = states;
		this.#delegates = delegates;
	}

	/**
	 * Frozen-state guard for observed host callbacks: the session's exact
	 * `#stateMutable` semantics (working ledger, not deferred-terminal).
	 * Binding/ownership changes stay legal on frozen states — only settled
	 * evidence is blocked.
	 */
	#stateMutable(state: ToolState): boolean {
		return this.#delegates.isStateMutable(state);
	}

	/** The state bound to a tool component, if any. */
	componentState(block: object): ToolState | undefined {
		return this.#componentStates.get(block);
	}

	/** The group state registered for a read group component, if any. */
	groupState(block: object): GroupState | undefined {
		return this.#groupStates.get(block);
	}

	/** Live iteration over every registered read group. */
	groups(): Iterable<GroupState> {
		return this.#groups;
	}

	/** Snapshot of components waiting for a state (tool components only). */
	unboundComponents(): readonly RenderableBlock[] {
		return [...this.#unboundComponents];
	}

	/** Ledgers queued for read-group pairing (replay/rebuild hydration). */
	hydratedReadLedgers(): readonly TurnLedger[] {
		return this.#hydratedReadSegments.map((segment) => segment.ledger);
	}

	/**
	 * Queue a replayed read ledger for group pairing (chronological).
	 * Legacy ledger-level shape: the segment's ids resolve at pair time to
	 * every unbound read state of the ledger. Production walks queue exact
	 * segment ids through `addHydratedReadSegment`; this form exists only
	 * for unit tests that queue one read state per ledger.
	 */
	addHydratedReadLedger(ledger: TurnLedger): void {
		this.#hydratedReadSegments.push({ ledger, stateIds: undefined });
	}

	/**
	 * Queue one contiguous read segment with its exact state ids. The
	 * rebuild/hydration walk emits one entry per maximal run of read
	 * states (same ledger, no interleaved non-read); repeated segments of
	 * the same ledger pair against separate groups without zero-claim
	 * starvation.
	 */
	addHydratedReadSegment(
		ledger: TurnLedger,
		stateIds: readonly string[],
	): void {
		this.#hydratedReadSegments.push({ ledger, stateIds });
	}

	/**
	 * Queue a newly seen tool component for binding (insertion order).
	 * During the rebuild identity window a preserved active component is
	 * restored by exact object identity instead of being queued: stock
	 * re-adds the same live instance without replaying the historical
	 * `updateArgs` callback, and identity is exact evidence that never
	 * weakens the fail-open ambiguity guards (`bind` stays conflict-safe).
	 * Other components leave the queue when bound or when `bindHydrated`
	 * drains it; anything still queued stays native rather than being
	 * guessed.
	 */
	registerUnboundComponent(component: RenderableBlock): void {
		const preserved = this.#preservedActive?.get(component);
		if (preserved && this.#states.get(preserved.id) === preserved) {
			this.bind(component, preserved);
			return;
		}
		this.#unboundComponents.push(component);
	}

	/**
	 * A positional fallback is valid only within one logical run. A terminal
	 * boundary discards unresolved host components so they stay native instead
	 * of being guessed against the next run's first state, closes the rebuild
	 * identity window and drops the unresolved backlog so preserved active
	 * ownership can never bind a later run's components.
	 */
	discardUnboundComponents(): void {
		this.#unboundComponents.length = 0;
		this.#preservedActive = undefined;
		this.#rebuildBacklog.clear();
	}

	/**
	 * Register a read group and its observed-id set. Called by the host
	 * wrapper transaction when a native read group is first seen.
	 */
	createGroup(component: RenderableBlock, expanded: boolean): GroupState {
		const group: GroupState = {
			component,
			version: 1,
			expanded,
			observedIds: new Set(),
		};
		this.#groupStates.set(component, group);
		this.#groups.add(group);
		return group;
	}

	/**
	 * Bind a component to a state. Conflicts are silent native fail-open:
	 * a state claimed by another component or a component claimed by
	 * another state keeps the block unbound (native renderer).
	 */
	bind(component: RenderableBlock, state: ToolState): BindingStatus {
		if (state.component && state.component !== component) return "ambiguous";
		const existing = this.#componentStates.get(component);
		if (existing && existing !== state) return "ambiguous";
		state.component = component;
		this.#componentStates.set(component, state);
		// A backlog state that found its host component again — identity
		// restore or an exact-ID replay — is resolved evidence, not an
		// unresolved poison, and leaves the fresh-candidate exclusion.
		this.#rebuildBacklog.delete(state);
		const index = this.#unboundComponents.indexOf(component);
		if (index >= 0) this.#unboundComponents.splice(index, 1);
		return "bound";
	}

	/**
	 * Quarantine one component to native presentation after an unresolvable
	 * binding conflict. Drops the reverse maps `#renderBlock` consults
	 * (`componentState` / `groupState`) so the surface renders native, but
	 * keeps each state's `component` claim so the state cannot be stolen by
	 * order-binding or another group. Does not touch other components.
	 * Rebuild retirement (`reset` / `preserveActive`) clears claims as
	 * usual; re-observation after rebuild is a fresh attempt.
	 */
	releaseToNative(component: RenderableBlock): void {
		if (this.#componentStates.has(component))
			this.#componentStates.delete(component);
		const unboundIdx = this.#unboundComponents.indexOf(component);
		if (unboundIdx >= 0) this.#unboundComponents.splice(unboundIdx, 1);
		const group = this.#groupStates.get(component);
		if (!group) return;
		// Drop group registry only — states that pointed at this component
		// keep their claim so a later group cannot adopt them mid-run.
		group.ledger = undefined;
		this.#groupStates.delete(component);
		this.#groups.delete(group);
	}

	/**
	 * Single-pair order fallback: exactly one unbound tool state and exactly
	 * one unbound tool component bind to each other. This is the only
	 * positional guess allowed without full-cardinality proof. Candidates
	 * are scoped to fresh starts: preserved active states that lost their
	 * host callback across a rebuild (`#rebuildBacklog`) never join the
	 * candidate set, so a genuinely new post-rebuild tool binds against its
	 * own start instead of being poisoned by the unresolved backlog (and is
	 * never positionally bound to a delayed/replacement historical
	 * component).
	 */
	tryBindByOrder(ledger: TurnLedger | undefined): BindingStatus {
		// Exactly one unbound non-read, non-backlog state on this ledger and
		// exactly one unbound component. Count in place — no array spreads.
		if (this.#unboundComponents.length !== 1) return "unmapped";
		let only: ToolState | undefined;
		for (const state of this.#states.values()) {
			if (state.component || state.ledger !== ledger) continue;
			// Read states bind to a group only through a matching
			// `updateArgs`/`updateResult` ID; they never use the order fallback.
			// Rebuild-backlog states are unresolved evidence, not fresh starts.
			if (state.toolName === "read" || this.#rebuildBacklog.has(state))
				continue;
			if (only) return "unmapped";
			only = state;
		}
		if (!only) return "unmapped";
		const component = this.#unboundComponents[0];
		if (!component) return "unmapped";
		return this.bind(component, only);
	}

	/**
	 * Replay/rebuild pairing over the unbound queues. Tool components pair
	 * with unbound non-read states in chronological order — full
	 * cardinality when every branch tool call has a rendered component, or
	 * suffix-aligned when stock collapsed the compacted/summarized history
	 * behind the summary divider (`display.collapseCompacted`, default
	 * true) and reconstructed components only for the newest tail. Read
	 * groups pair with the hydrated read-ledger queue the same way.
	 * `allowOrder=false` (rebuild with a preserved active run) skips every
	 * order fallback: components already bound by exact observed ids are
	 * resolved, anything else stays native. Suffix alignment additionally
	 * requires `restoredArmed` (the rebuild must belong to a restored
	 * history, i.e. the restore override is armed) and is never applied
	 * next to preserved active ownership, to non-tail shapes, or to visible
	 * sets larger than the branch — those stay native (fail-open).
	 * Returns true when no visible surface stayed unresolved.
	 */
	bindHydrated(allowOrder = true, restoredArmed = true): boolean {
		if (this.#states.size === 0) return true;
		const toolStates = [...this.#states.values()].filter(
			(state) => state.toolName !== "read" && !state.component,
		);
		const components = [...this.#unboundComponents];
		if (allowOrder && toolStates.length === components.length) {
			// Exact full-cardinality: every branch tool call has a rendered
			// component, so plain chronological order pairs them 1:1.
			for (let index = 0; index < toolStates.length; index++) {
				const component = components[index];
				const state = toolStates[index];
				if (component && state) this.bind(component, state);
			}
		} else if (
			allowOrder &&
			restoredArmed &&
			components.length > 0 &&
			components.length < toolStates.length &&
			(!this.#preservedActive || this.#preservedActive.size === 0)
		) {
			// Collapsed-history suffix alignment: the visible tail is a
			// suffix of the branch walk, so pair the components with the
			// newest states in chronological order. Conservative guard set:
			// exact counts take the branch above, an empty or over-sized
			// visible set is not a suffix, preserved active ownership (a
			// live run before the rebuild) makes a partial re-add genuinely
			// ambiguous, and an unarmed restore override means the rebuild
			// belongs to a live session rather than a restored history —
			// those stay native.
			const offset = toolStates.length - components.length;
			for (let index = 0; index < components.length; index++) {
				const component = components[index];
				const state = toolStates[offset + index];
				if (component && state) this.bind(component, state);
			}
		}
		// Reconstructed groups can receive updateArgs before branch hydration
		// created their states. Those exact IDs outrank ordinal fallback.
		this.#bindObservedReadGroups();
		const visibleGroups = [...this.#groups];
		const strictGroups = visibleGroups.filter(
			(group) => group.observedIds.size === 0,
		);
		// Ordinal pairing never guesses a group whose observed ids resolved
		// to exact-bound states elsewhere (cross-ledger ambiguity), and
		// unresolved observed-ID groups stay native outside the restored
		// suffix — a live/ambiguous rebuild must not guess their position.
		const restoredSuffix =
			allowOrder &&
			restoredArmed &&
			visibleGroups.length > 0 &&
			visibleGroups.length <= this.#hydratedReadSegments.length &&
			(!this.#preservedActive || this.#preservedActive.size === 0);
		if (
			allowOrder &&
			strictGroups.length === this.#hydratedReadSegments.length
		) {
			for (let index = 0; index < strictGroups.length; index++) {
				const group = strictGroups[index];
				const segment = this.#hydratedReadSegments[index];
				if (!group || !segment) continue;
				this.#assignReadSegment(group, segment);
			}
		} else if (restoredSuffix) {
			// Collapsed-history suffix alignment for reads (same contract as
			// tool components): the rendered read groups are the newest tail
			// of the branch's read segments, so pair them with the trailing
			// segments in order. The offset is computed against ALL visible
			// groups — exact-bound groups occupy their own suffix slots, so
			// an unbound-only count would double-assign their segments and
			// leave duplicate zero-claim groups rendering zero rows.
			const offset = this.#hydratedReadSegments.length - visibleGroups.length;
			// Every already-complete group must sit exactly where its ledger
			// lands in the suffix window; any mismatch means the ordinal
			// alignment is unproven and the whole fallback fails open.
			let aligned = true;
			for (let index = 0; index < visibleGroups.length; index++) {
				const group = visibleGroups[index];
				if (group.ledger === undefined) continue;
				if (
					group.ledger !== this.#hydratedReadSegments[offset + index]?.ledger
				) {
					aligned = false;
					break;
				}
			}
			if (aligned) {
				for (let index = 0; index < visibleGroups.length; index++) {
					const group = visibleGroups[index];
					const segment = this.#hydratedReadSegments[offset + index];
					if (!group || !segment || group.ledger !== undefined) continue;
					// Unresolved observed ids are tolerable only here (proven
					// restored suffix): an id resolving to a non-read state,
					// a claimed component, or a different ledger marks the
					// group ambiguous — it stays native.
					let ambiguous = false;
					for (const id of group.observedIds) {
						const state = this.#states.get(id);
						if (
							state !== undefined &&
							(state.toolName !== "read" ||
								state.component !== undefined ||
								state.ledger !== segment.ledger)
						) {
							ambiguous = true;
							break;
						}
					}
					if (ambiguous) continue;
					this.#assignReadSegment(group, segment);
				}
			}
		}
		// The queue drains unconditionally: components that could not be
		// paired stay native rather than re-attempting later. Only visible
		// surfaces that failed to pair are unresolved — hidden-prefix states
		// (collapsed history) have no rendered component and must not make a
		// fully paired visible presentation report unmapped.
		const unresolvedStates = this.#unboundComponents.length > 0;
		const unresolvedGroups = [...this.#groups].some(
			(group) => group.ledger === undefined,
		);
		const mapped = !unresolvedStates && !unresolvedGroups;
		// Drain both queues unconditionally: components and segments that
		// could not be paired stay native. Segments not cleared would corrupt
		// the next hydration's cardinality check.
		this.#unboundComponents.length = 0;
		this.#hydratedReadSegments.length = 0;
		return mapped;
	}

	/**
	 * Pair a reconstructed read group with a hydrated read segment: the
	 * group claims every unbound `read` state of the segment's exact ids
	 * (legacy ledger-level entries resolve to the ledger's unbound read
	 * states), and its observed set is replaced by the claimed state ids
	 * so the replay mapping is complete. A segment whose states are all
	 * claimed elsewhere must not be marked on the group — a zero-claim
	 * ledger-marked group would render zero rows (the output-reset
	 * regression) — the group stays unbound and renders native.
	 */
	#assignReadSegment(group: GroupState, segment: HydratedReadSegment): boolean {
		group.ledger = segment.ledger;
		const claimed: string[] = [];
		const ids =
			segment.stateIds ??
			[...this.#states.values()]
				.filter(
					(state) =>
						state.toolName === "read" && state.ledger === segment.ledger,
				)
				.map((state) => state.id);
		for (const id of ids) {
			const state = this.#states.get(id);
			if (
				state?.toolName === "read" &&
				state.ledger === segment.ledger &&
				!state.component
			) {
				state.component = group.component;
				claimed.push(id);
			}
		}
		if (claimed.length === 0) {
			// A zero-claim segment mark would render zero rows (the
			// output-reset regression): fail open to native instead.
			group.ledger = undefined;
			return false;
		}
		// The replay mapping is this group's complete observed set:
		// compact rows (and terminal hiding of routine reads) apply to
		// replayed groups as to live ones. Stale/unresolvable replay ids
		// are replaced so groupCompletelyMapped holds.
		group.observedIds.clear();
		for (const id of claimed) group.observedIds.add(id);
		group.version++;
		return true;
	}

	/**
	 * Resolve reconstructed read groups from their observed exact IDs. A group
	 * is safe to compact only when every entry resolves to an unclaimed `read`
	 * state from one ledger; partial or cross-ledger groups stay native.
	 */
	#bindObservedReadGroups(): void {
		for (const group of this.#groups) {
			if (group.ledger !== undefined || group.observedIds.size === 0) continue;
			const states: ToolState[] = [];
			let ledger: TurnLedger | undefined;
			let complete = true;
			for (const id of group.observedIds) {
				const state = this.#states.get(id);
				if (
					state?.toolName !== "read" ||
					(state.component !== undefined &&
						state.component !== group.component) ||
					(ledger !== undefined && state.ledger !== ledger)
				) {
					complete = false;
					break;
				}
				ledger ??= state.ledger;
				states.push(state);
			}
			if (!complete || !ledger || states.length !== group.observedIds.size)
				continue;
			group.ledger = ledger;
			for (const state of states) state.component = group.component;
			group.version++;
		}
	}

	/**
	 * startTool completion hook: a read group that already observed this id
	 * adopts the new state (stock hosts create the group and call
	 * `updateArgs` before the extension event arrives).
	 *
	 * Hardened against cross-run/group collisions: only typed, unclaimed
	 * `read` states can join a group, and a group already bound to a
	 * different ledger is never overwritten — a stale observed id of a
	 * later run stays native instead of being dragged into the settled
	 * run. An id observed by more than one group, or conflicting with an
	 * existing claim/ledger, is ambiguous: nothing binds (fail-open).
	 * `""` is a valid provisional id per stock event-controller semantics
	 * and adopts exactly like any other id.
	 */
	bindByObservedId(toolCallId: string, state: ToolState): BindingStatus {
		if (state.toolName !== "read") return "unmapped";
		let match: GroupState | undefined;
		let conflict = false;
		for (const group of this.#groups) {
			if (!group.observedIds.has(toolCallId)) continue;
			if (state.component && state.component !== group.component) {
				conflict = true;
				continue;
			}
			if (group.ledger !== undefined && group.ledger !== state.ledger) {
				conflict = true;
				continue;
			}
			if (match) return "ambiguous";
			match = group;
		}
		if (conflict) return "ambiguous";
		if (!match) return "unmapped";
		match.ledger = state.ledger;
		state.component = match.component;
		return "bound";
	}

	/**
	 * Tool component method observation (runs before the native method).
	 * Exact-ID binding through `updateArgs`, provisional-ID migration,
	 * first-time exact-ID binding through `updateResult`'s toolCallId when
	 * the component is still unbound (stock rebuild reconstructs tool cards
	 * without replaying `updateArgs(args, id)`), and result/partial/expanded
	 * state tracking. Returns the significant status; the caller maps
	 * `ambiguous` to per-component native quarantine (not session-wide
	 * rollback).
	 */
	observeToolMethod(
		component: RenderableBlock,
		name: string,
		args: unknown[],
	): BindingStatus {
		if (name === "updateArgs") {
			const id = updateArgsToolCallId(args);
			const bound = this.#componentStates.get(component);
			if (id && bound && bound.id !== id) {
				// A frozen state keeps its provisional exact binding: the
				// migration would re-key the state map, rewrite entry ids
				// and args, and merge evidence/pending — evidence mutations
				// of a settled view. Skipping it is fail-open: the binding
				// stays exact and the native updateArgs proceeds untouched.
				// Live migration behavior is unchanged.
				if (!this.#stateMutable(bound)) return "bound";
				const status = this.#migrateToRealId(
					bound,
					id,
					updateArgsPayload(args),
				);
				if (status !== "bound") return status;
			} else if (id) {
				const state = this.#states.get(id);
				if (state) {
					const bindStatus = this.bind(component, state);
					if (bindStatus !== "bound") return bindStatus;
					// The exact-ID bind is ownership and stays legal on
					// frozen state (hydration/rebuild replay); the payload
					// refresh and its tick are evidence mutations that must
					// never rewrite a settled view.
					if (this.#stateMutable(state)) {
						state.args = updateArgsPayload(args);
						state.version++;
					}
				}
			}
		} else if (
			name === "updateResult" &&
			!this.#componentStates.has(component)
		) {
			// Host rebuild path: ToolExecutionComponent is constructed with a
			// discarded `_toolCallId` and never gets updateArgs(args, id). Stock
			// still delivers updateResult(result, isPartial, toolCallId). That
			// third-arg id is exact ownership for an unbound non-read state —
			// same conflict rules as updateArgs bind, never migration, never
			// order. Reads stay on the group path exclusively.
			const id = updateResultToolCallId(args);
			if (id) {
				const candidate = this.#states.get(id);
				if (candidate && candidate.toolName !== "read") {
					const bindStatus = this.bind(component, candidate);
					if (bindStatus !== "bound") return bindStatus;
				}
			}
		}
		const state = this.#componentStates.get(component);
		if (!state) return "unmapped";
		if (name === "updateResult") {
			if (!this.#stateMutable(state)) return "bound";
			const result = updateResultPayload(args);
			state.result = result;
			state.isPartial = updateResultIsPartial(args);
			state.isError = state.isError || objectRecord(result).isError === true;
			if (state.isPartial) this.#delegates.markPending(state);
			else this.#delegates.unmarkPending(state);
		} else if (name === "setArgsComplete") {
			if (!this.#stateMutable(state)) return "bound";
			state.isPartial = true;
			this.#delegates.markPending(state);
		} else if (name === "setExpanded") {
			// Presentation-only, deliberately exempt from the freeze: the
			// expand/collapse of a settled row is a live view choice, not
			// settled evidence — it must keep tracking (and its tick must
			// keep re-rendering) after the ledger finalizes, or a
			// post-terminal expand would be visually lost.
			state.expanded = setExpandedValue(args);
		}
		// Frozen states never re-tick the committed presentation version:
		// late updateArgs/updateResult/setArgsComplete deliveries must not
		// churn the settled view. `setExpanded` above is the deliberate
		// presentation-only exception — its tick is the re-render signal
		// for the user's own change.
		if (this.#stateMutable(state) || name === "setExpanded") state.version++;
		return "bound";
	}

	/**
	 * Read group method observation (runs before the native method).
	 * Observed-id ownership, streamed-ID migration through `renameEntry`,
	 * entry removal and expansion tracking.
	 *
	 * Note: `""` (empty string) is a valid provisional id per stock OMP
	 * event-controller.ts semantics; only `undefined` skips id tracking.
	 */
	observeReadMethod(
		group: GroupState,
		component: RenderableBlock,
		name: string,
		args: unknown[],
	): BindingStatus {
		if (name === "updateArgs" || name === "updateResult") {
			const id =
				name === "updateArgs"
					? updateArgsToolCallId(args)
					: updateResultToolCallId(args);
			const state = id ? this.#states.get(id) : undefined;
			if (id !== undefined) group.observedIds.add(id);
			// Only claim unclaimed read states to avoid corrupting an existing
			// tool binding (e.g., a state already bound to another component).
			// A read group may observe an id emitted by an incompatible host
			// surface: only typed, unclaimed read states can be claimed,
			// otherwise this group remains native.
			//
			// No ledger-conflict guard here (unlike bindByObservedId): an
			// unclaimed read has no component and therefore no competing
			// ledger binding yet, so adopting `state.ledger` is a first claim,
			// not a re-point. The sites are asymmetric by design — first claim
			// vs. moving an already-bound group — not by omission.
			// observeToolMethod's updateResult bind excludes reads entirely
			// (`toolName !== "read"`), so unclaimed reads never arrive there.
			if (state?.toolName === "read" && !state.component) {
				group.ledger = state.ledger;
				state.component = component;
			}
		} else if (name === "renameEntry") {
			const { oldId, newId } = renameEntryIds(args);
			// Stock may stream the entry under an empty provisional id
			// (event-controller.ts migrates `""` explicitly): only a missing
			// argument, an empty target, or a no-op rename is skipped.
			if (oldId === undefined || !newId || oldId === newId) {
				group.version++;
				return "bound";
			}
			const state = this.#states.get(oldId);
			// The native rename re-keys this group's entry oldId → newId: the
			// group now owns the new id exclusively, so the observed set
			// follows it unconditionally.
			group.observedIds.delete(oldId);
			group.observedIds.add(newId);
			if (state && state.toolName === "read") {
				// Streamed-ID migration: re-key (or merge with an existing
				// real-id state) onto the final id — one ledger entry, one
				// surviving row. An existing state bound elsewhere is
				// ambiguous; the caller quarantines this group to native.
				const status = this.#migrateToRealId(state, newId, state.args);
				if (status !== "bound") return status;
				group.ledger = state.ledger;
				state.component = group.component;
			} else {
				// No tracked state under the old id (host-first ordering may
				// have already created the final-id state): bind it if it is
				// unbound — it is this group's only entry now.
				const newState = this.#states.get(newId);
				if (newState && newState.toolName === "read" && !newState.component) {
					group.ledger = newState.ledger;
					newState.component = group.component;
				}
			}
		} else if (name === "removeEntry") {
			const id = removeEntryToolCallId(args);
			// `""` is a valid provisional id (event-controller semantics):
			// only a missing argument skips the removal.
			if (id !== undefined) {
				group.observedIds.delete(id);
				const state = this.#states.get(id);
				if (
					state &&
					state.toolName === "read" &&
					state.component === group.component
				)
					state.component = undefined;
			}
		} else if (name === "setExpanded") {
			group.expanded = setExpandedValue(args);
		}
		group.version++;
		return "bound";
	}

	/**
	 * Read rows are built from the mapped ToolState of this group in
	 * chronological tool-call order (creation sequence), never from native
	 * presentation text or the order of `updateArgs` calls.
	 *
	 * Iterates the group's observed ids (O(entries in this group)), not the
	 * session-wide `#states` map. A version-only memo is intentionally not
	 * used: `bindByObservedId` claims `state.component` without bumping
	 * `group.version`, so a memo keyed only on version would go stale and
	 * drop newly adopted reads from subsequent frames. Invalidating on
	 * every `#states` mutation would need more bookkeeping than this scan.
	 */
	mappedReadStates(group: GroupState): ToolState[] {
		const states: ToolState[] = [];
		for (const id of group.observedIds) {
			const state = this.#states.get(id);
			// Same membership as the full-map scan: typed read claimed by
			// this group's component. Missing ids stay out (native gate).
			if (state?.toolName !== "read" || state.component !== group.component)
				continue;
			states.push(state);
		}
		return states.sort((a, b) => a.seq - b.seq);
	}

	/**
	 * All-or-nothing read-group mapping gate.
	 *
	 * Compact rows require every id the group observed through
	 * updateArgs/updateResult/renameEntry to resolve to a read state mapped
	 * to this group. A group with untracked entries (or none yet observed)
	 * keeps the raw native renderer via `decideReadGroupRender`, so no
	 * native entry is ever silently dropped or misattributed. This is an
	 * intentional permanent invariant — not a staging step toward partial
	 * binding. See `ReadGroupRenderInput.completelyMapped`.
	 */
	groupCompletelyMapped(group: GroupState): boolean {
		if (group.observedIds.size === 0) return false;
		for (const id of group.observedIds) {
			const state = this.#states.get(id);
			if (state?.toolName !== "read" || state.component !== group.component)
				return false;
		}
		return true;
	}

	/**
	 * Rebuild retirement: drop every component association and queue so
	 * re-added instances re-bind. All states (active included) lose their
	 * component ref; the caller owns ledger/state retention. Also closes
	 * the rebuild identity window and the unresolved backlog
	 * (`preserveActive` never survives a plain reset).
	 */
	reset(): void {
		this.#preservedActive = undefined;
		this.#rebuildBacklog.clear();
		this.#resetAssociations();
	}

	/**
	 * Rebuild identity preservation: capture the exact active component ↔
	 * state associations before the rebuild detaches presentation, then
	 * retire every association. Only these objects can be re-bound by
	 * identity (`registerUnboundComponent`) during the synchronous
	 * repopulation that follows the transcript clear; everything else
	 * binds from scratch or stays native. The caller passes exactly the
	 * preserved active working states — historical/finalized ownership is
	 * never identity-retained.
	 *
	 * Two-quick-clears: a newer clear supersedes the pending rebuild, but
	 * the identity captured by the superseded generation is still exact
	 * evidence — stock may not have re-added anything between the clears,
	 * so the previous map must carry forward every pair whose state is
	 * still preserved this generation AND has no newer captured component
	 * (a replacement component that exact-bound between the clears
	 * supersedes the older object identity), while the current-bindings
	 * pass above recaptures any component that was re-bound since. A stale
	 * pair (state no longer in the active set, or re-keyed away from this
	 * id) never survives.
	 */
	preserveActive(activeStates: readonly ToolState[]): void {
		const previous = this.#preservedActive;
		const preserved = new Map<object, ToolState>();
		const activeSet = new Set(activeStates);
		for (const state of activeStates) {
			if (state.component) preserved.set(state.component, state);
		}
		if (previous) {
			for (const [component, state] of previous) {
				if (
					activeSet.has(state) &&
					state.component === undefined &&
					this.#states.get(state.id) === state &&
					!preserved.has(component)
				) {
					preserved.set(component, state);
				}
			}
		}
		this.#preservedActive = preserved;
		this.#resetAssociations();
		// Every preserved active state is unbound after the reset; until one
		// finds its host component again it is backlog — exact evidence that
		// must never join (or poison) the single-pair fallback of a later
		// fresh start in the same run.
		this.#rebuildBacklog = new Set(activeStates);
	}

	/**
	 * Rebuild settlement/abort: the identity window is closed — a component
	 * re-added outside the synchronous repopulation is never identity-bound.
	 * The unresolved backlog intentionally survives: preserved active states
	 * that lost their host callback keep excluding themselves from the
	 * single-pair fallback until the logical-run boundary.
	 */
	clearPreserved(): void {
		this.#preservedActive = undefined;
	}

	#resetAssociations(): void {
		this.#componentStates = new WeakMap<object, ToolState>();
		this.#groupStates = new WeakMap<object, GroupState>();
		this.#groups.clear();
		this.#unboundComponents.length = 0;
		this.#hydratedReadSegments.length = 0;
		for (const state of this.#states.values()) state.component = undefined;
	}

	/**
	 * Stock OMP may bind a native component to a provisional toolCallId
	 * (including `""`) and later rebind it through `updateArgs(args, realId)`.
	 * Move the already-bound state — and its single chronological ledger
	 * entry — onto the real ID so later start/end, mutation, and Git evidence
	 * update the same row. If a real-ID state already exists, absorb its
	 * evidence and drop the duplicate; ambiguity (the real ID bound to a
	 * different component) returns `ambiguous` so the caller can quarantine
	 * the observing surface to native without retiring the session.
	 */
	#migrateToRealId(
		state: ToolState,
		realId: string,
		args: unknown,
	): BindingStatus {
		const existing = this.#states.get(realId);
		if (existing && existing !== state) {
			if (existing.component && existing.component !== state.component)
				return "ambiguous";
			if (state.result === undefined) state.result = existing.result;
			state.isError = state.isError || existing.isError;
			state.isPartial = state.isPartial || existing.isPartial;
			for (const entry of existing.mutations)
				if (!state.mutations.includes(entry)) state.mutations.push(entry);
			if (!state.git) state.git = existing.git;
			if (this.#delegates.unmarkPending(existing))
				this.#delegates.markPending(state);
			if (state.entry.retention === "discard") {
				state.entry.retention = existing.entry.retention;
				state.entry.mutation = existing.entry.mutation;
				state.entry.git = existing.entry.git;
			}
			if (state.entry.state !== "success" && state.entry.state !== "error")
				state.entry.state = existing.entry.state;
			if (this.#states.get(existing.id) === existing)
				this.#states.delete(existing.id);
			existing.ledger.removeEntry(existing.entry);
		}
		if (this.#states.get(state.id) === state) this.#states.delete(state.id);
		state.id = realId;
		state.entry.id = realId;
		state.entry.toolCallId = realId;
		state.args = args;
		this.#states.set(realId, state);
		return "bound";
	}
}
