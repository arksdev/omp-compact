/**
 * B03: structured exact-ID / provisional / read-group component binding.
 *
 * Owns every component ↔ toolCallId association of the session:
 * - exact-ID binding through `updateArgs`/`updateResult`/`setArgsComplete`;
 * - provisional → real ID migration (stock hosts stream entries under an
 *   empty or provisional id and rebind through `updateArgs(args, realId)`),
 *   including the read group's `renameEntry` path;
 * - read-group observed-id ownership (`observedIds`) and replay pairing;
 * - the unbound-component insertion queue and the safe replay cardinality
 *   fallback (single-pair order, or full-cardinality order when the counts
 *   match exactly — never positional guessing otherwise).
 *
 * Every operation reports an explicit status: `bound`, `ambiguous`,
 * `incompatible` or `unmapped`. Unknown/mixed/ambiguous/incompatible
 * mappings stay native — the module never throws for a conflict; the host
 * caller owns the rollback policy (the adapter treats ambiguous migration
 * as the rollback trigger it historically was).
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
import type { GroupState, ToolState } from "./runtime-session-state";
import type { RenderableBlock } from "./transcript-fold";
import type { TurnLedger } from "./turn-ledger";

export type BindingStatus = "bound" | "ambiguous" | "incompatible" | "unmapped";

export interface BindingDelegates {
	/** Register a state as pending (in-flight component update). */
	markPending(state: ToolState): void;
	/** Unregister a pending state; true when it was pending. */
	unmarkPending(state: ToolState): boolean;
}

function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
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
	#hydratedReadLedgers: TurnLedger[] = [];
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
		return [...this.#hydratedReadLedgers];
	}

	/** Queue a replayed read ledger for group pairing (chronological). */
	addHydratedReadLedger(ledger: TurnLedger): void {
		this.#hydratedReadLedgers.push(ledger);
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
		const unboundStates = [...this.#states.values()].filter(
			(state) => !state.component && state.ledger === ledger,
		);
		// Read states bind to a group only through a matching
		// `updateArgs`/`updateResult` ID; they never use the order fallback.
		const toolStates = unboundStates.filter(
			(state) => state.toolName !== "read" && !this.#rebuildBacklog.has(state),
		);
		if (toolStates.length !== 1 || this.#unboundComponents.length !== 1)
			return "unmapped";
		const component = this.#unboundComponents[0];
		const state = toolStates[0];
		if (component && state) return this.bind(component, state);
		return "unmapped";
	}

	/**
	 * Replay/rebuild pairing over the unbound queues. Tool components pair
	 * with unbound non-read states only when the counts match exactly
	 * (proven full-cardinality order); read groups pair with the hydrated
	 * read-ledger queue in chronological order. `allowOrder=false` (rebuild
	 * with a preserved active run) skips both order fallbacks: components
	 * already bound by exact observed ids are resolved, anything else stays
	 * native. Returns `mapped` only when every discovered state/group and
	 * component is resolved.
	 */
	bindHydrated(allowOrder = true): boolean {
		if (this.#states.size === 0) return true;
		const toolStates = [...this.#states.values()].filter(
			(state) => state.toolName !== "read" && !state.component,
		);
		if (allowOrder && toolStates.length === this.#unboundComponents.length) {
			const components = [...this.#unboundComponents];
			for (let index = 0; index < toolStates.length; index++) {
				const component = components[index];
				const state = toolStates[index];
				if (component && state) this.bind(component, state);
			}
		}
		// Reconstructed groups can receive updateArgs before branch hydration
		// created their states. Those exact IDs outrank ordinal fallback.
		this.#bindObservedReadGroups();
		const groups = [...this.#groups].filter(
			(group) => group.ledger === undefined && group.observedIds.size === 0,
		);
		if (allowOrder && groups.length === this.#hydratedReadLedgers.length) {
			for (let index = 0; index < groups.length; index++) {
				const group = groups[index];
				const ledger = this.#hydratedReadLedgers[index];
				if (!group || !ledger) continue;
				group.ledger = ledger;
				for (const state of this.#states.values()) {
					if (
						state.toolName === "read" &&
						state.ledger === ledger &&
						!state.component
					) {
						state.component = group.component;
						// The replay mapping is this group's complete observed
						// set: compact rows (and terminal hiding of routine
						// reads) apply to replayed groups as to live ones.
						group.observedIds.add(state.id);
					}
				}
				group.version++;
			}
		}
		// The queue drains unconditionally: components that could not be paired
		// stay native rather than re-attempting later. If no component was
		// discovered, an unbound state has no visual surface to invalidate.
		const hasUnboundComponents = this.#unboundComponents.length > 0;
		const unresolvedStates =
			hasUnboundComponents &&
			[...this.#states.values()].some((state) => !state.component);
		const unresolvedGroups = [...this.#groups].some(
			(group) => group.ledger === undefined,
		);
		const mapped =
			this.#unboundComponents.length === 0 &&
			!unresolvedStates &&
			!unresolvedGroups;
		// Drain both queues unconditionally: components and ledgers that could
		// not be paired stay native. Ledgers not cleared would corrupt the next
		// hydration's cardinality check.
		this.#unboundComponents.length = 0;
		this.#hydratedReadLedgers.length = 0;
		return mapped;
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
	 */
	bindByObservedId(toolCallId: string, state: ToolState): BindingStatus {
		for (const group of this.#groups) {
			if (!state.component && group.observedIds.has(toolCallId)) {
				group.ledger = state.ledger;
				state.component = group.component;
				return "bound";
			}
		}
		return "unmapped";
	}

	/**
	 * Tool component method observation (runs before the native method).
	 * Exact-ID binding through `updateArgs`, provisional-ID migration, and
	 * result/partial/expanded state tracking. Returns the significant
	 * status; the caller maps `ambiguous` to its rollback policy.
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
					state.args = updateArgsPayload(args);
					state.version++;
				}
			}
		}
		const state = this.#componentStates.get(component);
		if (!state) return "unmapped";
		if (name === "updateResult") {
			const result = updateResultPayload(args);
			state.result = result;
			state.isPartial = updateResultIsPartial(args);
			state.isError = state.isError || objectRecord(result).isError === true;
			if (state.isPartial) this.#delegates.markPending(state);
			else this.#delegates.unmarkPending(state);
		} else if (name === "setArgsComplete") {
			state.isPartial = true;
			this.#delegates.markPending(state);
		} else if (name === "setExpanded") {
			state.expanded = setExpandedValue(args);
		}
		state.version++;
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
				// ambiguous and the caller's rollback policy fails open.
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
	 */
	mappedReadStates(group: GroupState): ToolState[] {
		const states: ToolState[] = [];
		for (const state of this.#states.values()) {
			if (state.toolName !== "read" || state.component !== group.component)
				continue;
			states.push(state);
		}
		return states.sort((a, b) => a.seq - b.seq);
	}

	/**
	 * Compact rows require every id the group observed through
	 * updateArgs/updateResult to resolve to a read state mapped to this
	 * group. A group with untracked entries (or none yet observed) keeps
	 * the raw native renderer, so no native entry is ever silently dropped.
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
		this.#hydratedReadLedgers.length = 0;
		for (const state of this.#states.values()) state.component = undefined;
	}

	/**
	 * Stock OMP may bind a native component to a provisional toolCallId
	 * (including `""`) and later rebind it through `updateArgs(args, realId)`.
	 * Move the already-bound state — and its single chronological ledger
	 * entry — onto the real ID so later start/end, mutation, and Git evidence
	 * update the same row. If a real-ID state already exists, absorb its
	 * evidence and drop the duplicate; ambiguity (the real ID bound to a
	 * different component) returns `ambiguous` so the caller's rollback
	 * policy fails open, exactly as the historical throw did.
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
