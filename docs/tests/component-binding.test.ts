import { describe, expect, test } from "bun:test";

import {
	type BindingDelegates,
	ComponentBinding,
} from "../../.omp-plugin/component-binding";
import type { ToolState } from "../../.omp-plugin/runtime-session-state";
import type { RenderableBlock } from "../../.omp-plugin/transcript-fold";
import { type LedgerEntry, TurnLedger } from "../../.omp-plugin/turn-ledger";

class FakeToolComponent implements RenderableBlock {
	readonly observed: Array<[string, unknown[]]> = [];
	render(): readonly string[] {
		return [];
	}
	updateArgs(...args: unknown[]): void {
		this.observed.push(["updateArgs", args]);
	}
	updateResult(...args: unknown[]): void {
		this.observed.push(["updateResult", args]);
	}
	setArgsComplete(...args: unknown[]): void {
		this.observed.push(["setArgsComplete", args]);
	}
	setExpanded(...args: unknown[]): void {
		this.observed.push(["setExpanded", args]);
	}
	seal(): void {}
	setToolActivityVisible(): void {}
}

class FakeReadGroup implements RenderableBlock {
	readonly observed: Array<[string, unknown[]]> = [];
	render(): readonly string[] {
		return [];
	}
	updateArgs(...args: unknown[]): void {
		this.observed.push(["updateArgs", args]);
	}
	updateResult(...args: unknown[]): void {
		this.observed.push(["updateResult", args]);
	}
	removeEntry(...args: unknown[]): void {
		this.observed.push(["removeEntry", args]);
	}
	renameEntry(...args: unknown[]): void {
		this.observed.push(["renameEntry", args]);
	}
	setExpanded(...args: unknown[]): void {
		this.observed.push(["setExpanded", args]);
	}
}

let stateSeq = 0;
let ledgerSeq = 0;

function makeState(
	overrides: Partial<ToolState> & { id: string; toolName: string },
): ToolState {
	const { id, toolName, ...rest } = overrides;
	const ledger = new TurnLedger(`bind-${++ledgerSeq}`);
	const entry: LedgerEntry = {
		id,
		toolCallId: id,
		toolName,
		state: "running",
		retention: "discard",
	};
	ledger.record(entry);
	return {
		id,
		toolName,
		seq: ++stateSeq,
		args: { path: "/tmp/x" },
		result: undefined,
		isError: false,
		isPartial: true,
		expanded: false,
		ledger,
		entry,
		mutations: [],
		version: 1,
		...rest,
	};
}

function makeBinding(): {
	binding: ComponentBinding;
	states: Map<string, ToolState>;
	pending: Set<ToolState>;
} {
	const states = new Map<string, ToolState>();
	const pending = new Set<ToolState>();
	const delegates: BindingDelegates = {
		markPending: (state) => {
			pending.add(state);
		},
		unmarkPending: (state) => pending.delete(state),
	};
	return { binding: new ComponentBinding(states, delegates), states, pending };
}

describe("ComponentBinding: exact-ID binding", () => {
	test("binds a component to a state and reports bound", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		expect(binding.bind(component, state)).toBe("bound");
		expect(binding.componentState(component)).toBe(state);
		expect(state.component).toBe(component);
	});

	test("conflicts are silent native fail-open (ambiguous)", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const first = makeState({ id: "call-1", toolName: "bash" });
		const second = makeState({ id: "call-2", toolName: "bash" });
		states.set("call-1", first);
		states.set("call-2", second);
		expect(binding.bind(component, first)).toBe("bound");
		// A state already claimed by another component must not rebind.
		expect(binding.bind(component, second)).toBe("ambiguous");
		expect(binding.componentState(component)).toBe(first);
		// A component already claimed by another state must not rebind.
		const other = new FakeToolComponent();
		expect(binding.bind(other, first)).toBe("ambiguous");
		expect(binding.componentState(other)).toBeUndefined();
	});

	test("observeToolMethod binds through updateArgs toolCallId", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "read" });
		states.set("call-1", state);
		binding.registerUnboundComponent(component);
		expect(
			binding.observeToolMethod(component, "updateArgs", [
				{ path: "/a" },
				"call-1",
			]),
		).toBe("bound");
		expect(binding.componentState(component)).toBe(state);
		expect(state.args).toEqual({ path: "/a" });
		expect(state.version).toBe(3);
		expect(binding.unboundComponents()).toEqual([]);
	});

	test("observeToolMethod without a state leaves the component unbound", () => {
		const { binding } = makeBinding();
		const component = new FakeToolComponent();
		expect(
			binding.observeToolMethod(component, "updateArgs", [{}, "ghost"]),
		).toBe("unmapped");
		expect(binding.componentState(component)).toBeUndefined();
	});

	test("observeToolMethod tracks result, partial and expanded state", () => {
		const { binding, states, pending } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.bind(component, state);
		expect(
			binding.observeToolMethod(component, "updateResult", [
				{ ok: true },
				true,
			]),
		).toBe("bound");
		expect(state.result).toEqual({ ok: true });
		expect(state.isPartial).toBe(true);
		expect(pending.has(state)).toBe(true);
		expect(
			binding.observeToolMethod(component, "updateResult", [
				{ ok: true },
				false,
			]),
		).toBe("bound");
		expect(state.isPartial).toBe(false);
		expect(pending.has(state)).toBe(false);
		binding.observeToolMethod(component, "updateResult", [
			{ isError: true },
			false,
		]);
		expect(state.isError).toBe(true);
		binding.observeToolMethod(component, "setArgsComplete", []);
		expect(state.isPartial).toBe(true);
		expect(pending.has(state)).toBe(true);
		binding.observeToolMethod(component, "setExpanded", [true]);
		expect(state.expanded).toBe(true);
	});
});

describe("ComponentBinding: provisional → real ID migration", () => {
	test("re-keys a provisional state onto the real toolCallId", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "", toolName: "read" });
		states.set("", state);
		binding.bind(component, state);
		expect(
			binding.observeToolMethod(component, "updateArgs", [
				{ path: "/a" },
				"real-1",
			]),
		).toBe("bound");
		expect(states.has("")).toBe(false);
		expect(states.get("real-1")).toBe(state);
		expect(state.id).toBe("real-1");
		expect(state.entry.id).toBe("real-1");
		expect(state.entry.toolCallId).toBe("real-1");
		expect(state.args).toEqual({ path: "/a" });
	});

	test("absorbs an existing real-ID duplicate and drops its ledger entry", () => {
		const { binding, states, pending } = makeBinding();
		const component = new FakeToolComponent();
		const provisional = makeState({ id: "", toolName: "read" });
		const real = makeState({ id: "real-1", toolName: "read" });
		real.result = { content: [] };
		states.set("", provisional);
		states.set("real-1", real);
		pending.add(real);
		binding.bind(component, provisional);
		expect(
			binding.observeToolMethod(component, "updateArgs", [
				{ path: "/a" },
				"real-1",
			]),
		).toBe("bound");
		expect(states.get("real-1")).toBe(provisional);
		expect(states.size).toBe(1);
		expect(provisional.result).toEqual({ content: [] });
		expect(pending.has(real)).toBe(false);
		expect(pending.has(provisional)).toBe(true);
		expect(real.ledger.entries).toEqual([]);
	});

	test("an existing real-ID state bound elsewhere is ambiguous", () => {
		const { binding, states } = makeBinding();
		const otherComponent = new FakeToolComponent();
		const real = makeState({ id: "real-1", toolName: "read" });
		states.set("real-1", real);
		binding.bind(otherComponent, real);
		const provisional = makeState({ id: "", toolName: "read" });
		states.set("", provisional);
		const component = new FakeToolComponent();
		binding.bind(component, provisional);
		expect(
			binding.observeToolMethod(component, "updateArgs", [{}, "real-1"]),
		).toBe("ambiguous");
		// Nothing was re-keyed.
		expect(states.get("")).toBe(provisional);
		expect(states.get("real-1")).toBe(real);
	});
});

describe("ComponentBinding: read-group observed-id ownership", () => {
	test("observed ids accumulate and bind states to the group", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		const read = makeState({ id: "read-1", toolName: "read" });
		states.set("read-1", read);
		expect(
			binding.observeReadMethod(group, groupComponent, "updateArgs", [
				{ path: "/a" },
				"read-1",
			]),
		).toBe("bound");
		expect([...group.observedIds]).toEqual(["read-1"]);
		expect(group.ledger).toBe(read.ledger);
		expect(read.component).toBe(groupComponent);
		expect(binding.groupCompletelyMapped(group)).toBe(true);
		expect(binding.mappedReadStates(group)).toEqual([read]);
	});

	test("untracked observed ids keep the group natively mapped", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		const read = makeState({ id: "read-1", toolName: "read" });
		states.set("read-1", read);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/a" },
			"read-1",
		]);
		binding.observeReadMethod(group, groupComponent, "updateResult", [
			{},
			false,
			"read-2",
		]);
		expect(group.observedIds.has("read-2")).toBe(true);
		expect(binding.groupCompletelyMapped(group)).toBe(false);
	});

	test("read groups never claim a non-read state with a matching id", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		const toolComponent = new FakeToolComponent();
		const bash = makeState({ id: "shared-id", toolName: "bash" });
		states.set("shared-id", bash);
		expect(binding.bind(toolComponent, bash)).toBe("bound");

		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/a" },
			"shared-id",
		]);
		expect(bash.component).toBe(toolComponent);
		expect(group.ledger).toBeUndefined();
		expect(binding.groupCompletelyMapped(group)).toBe(false);
	});

	test("renameEntry migrates the streamed provisional id", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		const state = makeState({ id: "", toolName: "read" });
		states.set("", state);
		binding.observeReadMethod(group, groupComponent, "renameEntry", [
			"",
			"read-final",
		]);
		expect(states.has("")).toBe(false);
		expect(states.get("read-final")).toBe(state);
		expect(group.observedIds.has("read-final")).toBe(true);
		expect(group.observedIds.has("")).toBe(false);
		expect(state.component).toBe(groupComponent);
	});

	test("removeEntry drops the observed id and the component ref", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		const read = makeState({ id: "read-1", toolName: "read" });
		states.set("read-1", read);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{},
			"read-1",
		]);
		binding.observeReadMethod(group, groupComponent, "removeEntry", ["read-1"]);
		expect(group.observedIds.has("read-1")).toBe(false);
		expect(read.component).toBeUndefined();
	});

	test("group expanded state tracks setExpanded", () => {
		const { binding } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		binding.observeReadMethod(group, groupComponent, "setExpanded", [true]);
		expect(group.expanded).toBe(true);
		expect(group.version).toBe(2);
	});

	test("bindByObservedId adopts a state when the group already observed it", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{},
			"read-1",
		]);
		const state = makeState({ id: "read-1", toolName: "read" });
		states.set("read-1", state);
		expect(binding.bindByObservedId("read-1", state)).toBe("bound");
		expect(state.component).toBe(groupComponent);
		expect(group.ledger).toBe(state.ledger);
	});
});

describe("ComponentBinding: order fallbacks", () => {
	test("tryBindByOrder pairs exactly one state with one component", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.registerUnboundComponent(component);
		expect(binding.tryBindByOrder(state.ledger)).toBe("bound");
		expect(state.component).toBe(component);
		expect(binding.unboundComponents()).toEqual([]);
	});

	test("tryBindByOrder refuses without proven single cardinality", () => {
		const { binding, states } = makeBinding();
		const first = new FakeToolComponent();
		const second = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.registerUnboundComponent(first);
		binding.registerUnboundComponent(second);
		expect(binding.tryBindByOrder(state.ledger)).toBe("unmapped");
		expect(state.component).toBeUndefined();
	});

	test("tryBindByOrder never binds read states positionally", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const read = makeState({ id: "read-1", toolName: "read" });
		states.set("read-1", read);
		binding.registerUnboundComponent(component);
		expect(binding.tryBindByOrder(read.ledger)).toBe("unmapped");
		expect(read.component).toBeUndefined();
	});

	test("bindHydrated pairs on proven full cardinality", () => {
		const { binding, states } = makeBinding();
		const first = new FakeToolComponent();
		const second = new FakeToolComponent();
		const stateA = makeState({ id: "call-1", toolName: "bash" });
		const stateB = makeState({ id: "call-2", toolName: "glob" });
		states.set("call-1", stateA);
		states.set("call-2", stateB);
		binding.registerUnboundComponent(first);
		binding.registerUnboundComponent(second);
		expect(binding.bindHydrated(true)).toBe(true);
		expect(stateA.component).toBe(first);
		expect(stateB.component).toBe(second);
		expect(binding.unboundComponents()).toEqual([]);
	});

	test("bindHydrated with allowOrder=false leaves mismatches native", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.registerUnboundComponent(component);
		expect(binding.bindHydrated(false)).toBe(false);
		expect(state.component).toBeUndefined();
		// The queue drains; the component stays native rather than retried.
		expect(binding.unboundComponents()).toEqual([]);
	});

	test("bindHydrated pairs read groups with hydrated ledgers in order", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		binding.createGroup(groupComponent, false);
		const read = makeState({ id: "read-1", toolName: "read" });
		states.set("read-1", read);
		binding.addHydratedReadLedger(read.ledger);
		expect(binding.bindHydrated(true)).toBe(true);
		expect(read.component).toBe(groupComponent);
		expect(binding.groupState(groupComponent)?.ledger).toBe(read.ledger);
	});

	test("bindHydrated suffix-aligns a visible tool tail over hidden prefix states", () => {
		const { binding, states } = makeBinding();
		const tail = new FakeToolComponent();
		const old = makeState({ id: "call-1", toolName: "bash" });
		const mid = makeState({ id: "call-2", toolName: "glob" });
		const newest = makeState({ id: "call-3", toolName: "bash" });
		states.set("call-1", old);
		states.set("call-2", mid);
		states.set("call-3", newest);
		binding.registerUnboundComponent(tail);
		// Stock collapses the compacted/summarized history behind the
		// summary divider (`display.collapseCompacted`) and reconstructs
		// components only for the newest tail, so fewer visible components
		// than branch states is the normal cold-launch shape, not a
		// mismatch. The visible tail pairs with the newest states in
		// chronological order; the hidden prefix has no surface and never
		// blocks the mapped result.
		expect(binding.bindHydrated(true)).toBe(true);
		expect(newest.component).toBe(tail);
		expect(old.component).toBeUndefined();
		expect(mid.component).toBeUndefined();
		expect(binding.unboundComponents()).toEqual([]);
	});

	test("duplicate-ledger group stays unbound instead of a zero-claim ledger mark", () => {
		const { binding, states } = makeBinding();
		const duplicateComponent = new FakeReadGroup();
		const ownerComponent = new FakeReadGroup();
		binding.createGroup(duplicateComponent, false);
		const owner = binding.createGroup(ownerComponent, false);
		const reads = ["read-1", "read-2"].map((id) =>
			makeState({ id, toolName: "read" }),
		);
		for (const read of reads) states.set(read.id, read);
		binding.addHydratedReadLedger(reads[0].ledger);
		binding.addHydratedReadLedger(reads[1].ledger);
		// The initial-replay owner claimed BOTH ledgers' read states; its
		// own ledger ends on the last claim (L2), matching its suffix slot
		// at index 1. The fresh rebuild group ordinals into L1's slot where
		// every state is already claimed — it must stay unbound (native
		// fail-open) instead of carrying a zero-claim ledger mark that
		// renders zero rows and erases native output.
		binding.observeReadMethod(owner, ownerComponent, "updateArgs", [
			{ path: "/a" },
			"read-1",
		]);
		binding.observeReadMethod(owner, ownerComponent, "updateArgs", [
			{ path: "/b" },
			"read-2",
		]);
		// Unresolved duplicate → bindHydrated reports unmapped (native),
		// never a resolved-but-empty ledger mark.
		expect(binding.bindHydrated(true)).toBe(false);
		const dupGroup = binding.groupState(duplicateComponent);
		expect(dupGroup).toBeDefined();
		expect(dupGroup!.ledger).toBeUndefined();
		expect(binding.mappedReadStates(dupGroup!)).toEqual([]);
	});

	test("bindHydrated ordinal offset accounts for exact-bound groups (no duplicate zero-claim)", () => {
		const { binding, states } = makeBinding();
		const staleMid1Component = new FakeReadGroup();
		const staleMid2Component = new FakeReadGroup();
		const exactTail1Component = new FakeReadGroup();
		const exactTail2Component = new FakeReadGroup();
		const staleMid1 = binding.createGroup(staleMid1Component, false);
		const staleMid2 = binding.createGroup(staleMid2Component, false);
		const exactTail1 = binding.createGroup(exactTail1Component, false);
		const exactTail2 = binding.createGroup(exactTail2Component, false);
		// The newest tail groups resolve exact ids first (they observed the
		// real branch ids) and claim the trailing ledgers. The middle groups
		// carry stale replay ids the branch walk never materialized. The
		// ordinal fallback must align against ALL visible groups, otherwise
		// the unbound-only offset double-assigns the exact groups' ledgers
		// and the middle groups end up ledger-marked with zero mapped reads
		// (the output-reset regression: rendered zero rows).
		const reads = ["read-1", "read-2", "read-3", "read-4"].map((id) =>
			makeState({ id, toolName: "read" }),
		);
		for (const read of reads) states.set(read.id, read);
		binding.addHydratedReadLedger(reads[0].ledger);
		binding.addHydratedReadLedger(reads[1].ledger);
		binding.addHydratedReadLedger(reads[2].ledger);
		binding.addHydratedReadLedger(reads[3].ledger);
		binding.observeReadMethod(staleMid1, staleMid1Component, "updateArgs", [
			{ path: "/a" },
			"stale-1",
		]);
		binding.observeReadMethod(staleMid2, staleMid2Component, "updateArgs", [
			{ path: "/b" },
			"stale-2",
		]);
		binding.observeReadMethod(exactTail1, exactTail1Component, "updateArgs", [
			{ path: "/c" },
			"read-3",
		]);
		binding.observeReadMethod(exactTail2, exactTail2Component, "updateArgs", [
			{ path: "/d" },
			"read-4",
		]);
		expect(binding.bindHydrated(true)).toBe(true);
		const expectMapped = (
			component: FakeReadGroup,
			read: ReturnType<typeof makeState>,
		) => {
			const group = binding.groupState(component);
			expect(group).toBeDefined();
			expect(group!.ledger).toBe(read.ledger);
			expect(binding.mappedReadStates(group!)).toEqual([read]);
			expect(binding.groupCompletelyMapped(group!)).toBe(true);
		};
		expectMapped(staleMid1Component, reads[0]);
		expectMapped(staleMid2Component, reads[1]);
		expectMapped(exactTail1Component, reads[2]);
		expectMapped(exactTail2Component, reads[3]);
	});

	test("bindHydrated suffix-aligns read groups to the trailing ledgers", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		binding.createGroup(groupComponent, false);
		const first = makeState({ id: "read-1", toolName: "read" });
		const last = makeState({ id: "read-2", toolName: "read" });
		states.set("read-1", first);
		states.set("read-2", last);
		binding.addHydratedReadLedger(first.ledger);
		binding.addHydratedReadLedger(last.ledger);
		expect(binding.bindHydrated(true)).toBe(true);
		expect(binding.groupState(groupComponent)?.ledger).toBe(last.ledger);
		expect(first.component).toBeUndefined();
		expect(last.component).toBe(groupComponent);
	});

	test("bindHydrated suffix-aligns read groups carrying unresolved observed ids", () => {
		const { binding, states } = makeBinding();
		const midGroupComponent = new FakeReadGroup();
		const tailGroupComponent = new FakeReadGroup();
		const midGroup = binding.createGroup(midGroupComponent, false);
		const tailGroup = binding.createGroup(tailGroupComponent, false);
		// Restored collapsed history: stock replays the tail read groups and
		// their `updateArgs` carry ids the branch walk never materialized as
		// states (streamed/provisional or stale replay ids). Exact-ID
		// resolution fails — the groups must still join the ordinal suffix
		// pairing inside the proven restored context (restoredArmed=true,
		// no preserved active) instead of staying native.
		binding.observeReadMethod(midGroup, midGroupComponent, "updateArgs", [
			{ path: "/a" },
			"stale-mid-1",
		]);
		binding.observeReadMethod(midGroup, midGroupComponent, "updateArgs", [
			{ path: "/b" },
			"stale-mid-2",
		]);
		binding.observeReadMethod(tailGroup, tailGroupComponent, "updateArgs", [
			{ path: "/c" },
			"stale-tail-1",
		]);
		const first = makeState({ id: "read-1", toolName: "read" });
		const mid = makeState({ id: "read-2", toolName: "read" });
		const last = makeState({ id: "read-3", toolName: "read" });
		states.set("read-1", first);
		states.set("read-2", mid);
		states.set("read-3", last);
		binding.addHydratedReadLedger(first.ledger);
		binding.addHydratedReadLedger(mid.ledger);
		binding.addHydratedReadLedger(last.ledger);
		expect(binding.bindHydrated(true)).toBe(true);
		expect(binding.groupState(midGroupComponent)?.ledger).toBe(mid.ledger);
		expect(binding.groupState(tailGroupComponent)?.ledger).toBe(last.ledger);
		expect(mid.component).toBe(midGroupComponent);
		expect(last.component).toBe(tailGroupComponent);
		expect(first.component).toBeUndefined();
	});

	test("one ledger with two read segments pairs each group to its own segment", () => {
		const { binding, states } = makeBinding();
		const firstComponent = new FakeReadGroup();
		const secondComponent = new FakeReadGroup();
		binding.createGroup(firstComponent, false);
		binding.createGroup(secondComponent, false);
		// One logical run interleaves a non-read between reads (read-a,
		// bash, read-b): the SAME ledger holds two separate contiguous read
		// segments. The rebuild/hydration walk queues one entry per segment
		// with its exact state ids — ledger-level pairing would hand every
		// unbound read of the ledger to the first group and leave the
		// second with a zero-claim mark (native output-reset regression).
		const ledger = new TurnLedger("bind-seg");
		const readA = makeState({ id: "read-a", toolName: "read", ledger });
		const bash = makeState({ id: "bash-1", toolName: "bash", ledger });
		const readB = makeState({ id: "read-b", toolName: "read", ledger });
		for (const state of [readA, bash, readB]) states.set(state.id, state);
		binding.addHydratedReadSegment(ledger, [readA.id]);
		binding.addHydratedReadSegment(ledger, [readB.id]);
		expect(binding.bindHydrated(true)).toBe(true);
		const first = binding.groupState(firstComponent);
		const second = binding.groupState(secondComponent);
		expect(first?.ledger).toBe(ledger);
		expect(second?.ledger).toBe(ledger);
		if (!first || !second) throw new Error("segment groups must pair");
		expect(binding.mappedReadStates(first)).toEqual([readA]);
		expect(binding.mappedReadStates(second)).toEqual([readB]);
		expect(binding.groupCompletelyMapped(first)).toBe(true);
		expect(binding.groupCompletelyMapped(second)).toBe(true);
	});

	test("bindHydrated refuses suffix alignment under preserved active ownership", () => {
		const { binding, states } = makeBinding();
		const old = makeState({ id: "call-1", toolName: "bash" });
		const newest = makeState({ id: "call-2", toolName: "bash" });
		states.set("call-1", old);
		states.set("call-2", newest);
		const liveOld = new FakeToolComponent();
		const liveNew = new FakeToolComponent();
		binding.bind(liveOld, old);
		binding.bind(liveNew, newest);
		// A live run existed before the rebuild: the exact component ↔ state
		// ownership is preserved across the clear. A re-added instance that
		// is not the same object is genuinely ambiguous (it may correspond
		// to any of the preserved calls), so positional suffix guessing must
		// stay off — the component renders native.
		binding.preserveActive([old, newest]);
		const tail = new FakeToolComponent();
		binding.registerUnboundComponent(tail);
		expect(binding.bindHydrated(true)).toBe(false);
		expect(old.component).toBeUndefined();
		expect(newest.component).toBeUndefined();
	});

	test("bindHydrated skips suffix alignment when the restore override is not armed", () => {
		const { binding, states } = makeBinding();
		const old = makeState({ id: "call-1", toolName: "bash" });
		const newest = makeState({ id: "call-2", toolName: "bash" });
		states.set("call-1", old);
		states.set("call-2", newest);
		const tail = new FakeToolComponent();
		binding.registerUnboundComponent(tail);
		// A live-session rebuild (no restore override armed): the single
		// visible component may correspond to either call, so positional
		// suffix guessing stays off and the surface renders native.
		expect(binding.bindHydrated(true, false)).toBe(false);
		expect(old.component).toBeUndefined();
		expect(newest.component).toBeUndefined();
	});

	test("bindHydrated fails open when visible components exceed states", () => {
		const { binding, states } = makeBinding();
		const first = new FakeToolComponent();
		const second = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.registerUnboundComponent(first);
		binding.registerUnboundComponent(second);
		// More components than states cannot be a suffix of the branch:
		// nothing pairs and the surfaces stay native.
		expect(binding.bindHydrated(true)).toBe(false);
		expect(state.component).toBeUndefined();
		expect(binding.unboundComponents()).toEqual([]);
	});
});

describe("ComponentBinding: rebuild identity window", () => {
	test("preserveActive restores the exact re-added component by identity", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.bind(component, state);
		binding.preserveActive([state]);
		expect(state.component).toBeUndefined();
		// stock re-adds the exact live object without replaying updateArgs
		binding.registerUnboundComponent(component);
		expect(binding.componentState(component)).toBe(state);
		expect(state.component).toBe(component);
		expect(binding.unboundComponents()).toEqual([]);
	});

	test("clearPreserved closes the identity window", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.bind(component, state);
		binding.preserveActive([state]);
		binding.clearPreserved();
		// a re-add after settlement is never identity-bound
		binding.registerUnboundComponent(component);
		expect(binding.componentState(component)).toBeUndefined();
		expect(binding.unboundComponents()).toEqual([component]);
	});

	test("discardUnboundComponents closes the identity window", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.bind(component, state);
		binding.preserveActive([state]);
		binding.discardUnboundComponents();
		binding.registerUnboundComponent(component);
		expect(binding.componentState(component)).toBeUndefined();
		expect(binding.unboundComponents()).toEqual([component]);
	});

	test("reset closes the identity window", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.bind(component, state);
		binding.preserveActive([state]);
		binding.reset();
		binding.registerUnboundComponent(component);
		expect(binding.componentState(component)).toBeUndefined();
		expect(binding.unboundComponents()).toEqual([component]);
	});

	test("an unresolved preserved state never poisons a fresh start's fallback", () => {
		const { binding, states } = makeBinding();
		const ledger = new TurnLedger("run-1");
		const staleComponent = new FakeToolComponent();
		const stale = makeState({ id: "stale-1", toolName: "bash", ledger });
		states.set("stale-1", stale);
		binding.bind(staleComponent, stale);
		binding.preserveActive([stale]);
		binding.clearPreserved(); // rebuild settled; stale never re-added
		const freshComponent = new FakeToolComponent();
		const fresh = makeState({ id: "fresh-1", toolName: "bash", ledger });
		states.set("fresh-1", fresh);
		binding.registerUnboundComponent(freshComponent);
		// the single-pair fallback sees only the fresh candidate — the
		// backlog must not inflate cardinality or be guessed against
		expect(binding.tryBindByOrder(ledger)).toBe("bound");
		expect(fresh.component).toBe(freshComponent);
		expect(stale.component).toBeUndefined();
	});

	test("a newer exact binding supersedes an older preserved object identity", () => {
		const { binding, states } = makeBinding();
		const ledger = new TurnLedger("run-1");
		const a = new FakeToolComponent();
		const b = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash", ledger });
		states.set("call-1", state);
		binding.bind(a, state); // original object A
		binding.preserveActive([state]); // clear 1: preserves {A -> state}
		expect(state.component).toBeUndefined();
		// between the clears the host exact-binds a replacement component B
		binding.bind(b, state);
		binding.preserveActive([state]); // clear 2: only B may survive
		// re-adding the older object A first must not steal the state
		binding.registerUnboundComponent(a);
		expect(binding.componentState(a)).toBeUndefined();
		expect(state.component).toBeUndefined();
		expect(binding.unboundComponents()).toEqual([a]);
		// only the current identity B restores
		binding.registerUnboundComponent(b);
		expect(binding.componentState(b)).toBe(state);
		expect(state.component).toBe(b);
	});

	test("a previous pair whose state is no longer preserved is never carried", () => {
		const { binding, states } = makeBinding();
		const a = new FakeToolComponent();
		const old = makeState({ id: "old-1", toolName: "bash" });
		states.set("old-1", old);
		binding.bind(a, old);
		binding.preserveActive([old]);
		// the next generation preserves a different state; the old state
		// stays in #states as evidence but is not in the active set
		const other = makeState({ id: "other-1", toolName: "bash" });
		states.set("other-1", other);
		binding.preserveActive([other]);
		binding.registerUnboundComponent(a);
		expect(binding.componentState(a)).toBeUndefined();
		expect(old.component).toBeUndefined();
		expect(binding.unboundComponents()).toEqual([a]);
	});

	test("a restored backlog state binds and leaves the fallback exclusion", () => {
		const { binding, states } = makeBinding();
		const ledger = new TurnLedger("run-1");
		const preservedComponent = new FakeToolComponent();
		const preserved = makeState({
			id: "stale-1",
			toolName: "bash",
			ledger,
		});
		states.set("stale-1", preserved);
		binding.bind(preservedComponent, preserved);
		binding.preserveActive([preserved]);
		// the host re-adds the exact object synchronously: identity restore
		binding.registerUnboundComponent(preservedComponent);
		expect(binding.componentState(preservedComponent)).toBe(preserved);
		expect(binding.unboundComponents()).toEqual([]);
		// the resolved state no longer blocks a fresh start's fallback
		const freshComponent = new FakeToolComponent();
		const fresh = makeState({ id: "fresh-1", toolName: "bash", ledger });
		states.set("fresh-1", fresh);
		binding.registerUnboundComponent(freshComponent);
		expect(binding.tryBindByOrder(ledger)).toBe("bound");
		expect(fresh.component).toBe(freshComponent);
	});
});

describe("ComponentBinding: reset", () => {
	test("reset drops every association and component ref", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.bind(component, state);
		const read = makeState({ id: "read-1", toolName: "read" });
		states.set("read-1", read);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{},
			"read-1",
		]);
		binding.registerUnboundComponent(new FakeToolComponent());
		binding.addHydratedReadLedger(new TurnLedger("replay-1"));
		binding.reset();
		expect(binding.componentState(component)).toBeUndefined();
		expect(binding.groupState(groupComponent)).toBeUndefined();
		expect([...binding.groups()]).toEqual([]);
		expect(binding.unboundComponents()).toEqual([]);
		expect(binding.hydratedReadLedgers()).toEqual([]);
		expect(state.component).toBeUndefined();
		expect(read.component).toBeUndefined();
	});
});
