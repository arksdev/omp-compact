import { describe, expect, test } from "bun:test";

import {
	type BindingDelegates,
	ComponentBinding,
} from "../../.omp-plugin/component-binding";
import type { ToolState } from "../../.omp-plugin/runtime-session-state";
import type { RenderableBlock } from "../../.omp-plugin/transcript-fold";
import { type LedgerEntry, TurnLedger } from "../../.omp-plugin/turn-ledger";

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
	const { id, toolName, ledger: ledgerOverride, ...rest } = overrides;
	const ledger = ledgerOverride ?? new TurnLedger(`bind-${++ledgerSeq}`);
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
		executionStarted: true,
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
} {
	const states = new Map<string, ToolState>();
	const pending = new Set<ToolState>();
	const delegates: BindingDelegates = {
		markPending: (state) => {
			pending.add(state);
		},
		unmarkPending: (state) => pending.delete(state),
		isStateMutable: (state) => state.ledger.phase === "working",
	};
	return { binding: new ComponentBinding(states, delegates), states };
}

describe("ComponentBinding: strict-slot guard for unresolved observed groups", () => {
	test("hazard: interleaved unresolved observed group owns a queued slot — later strict group must not bind it", () => {
		const { binding, states } = makeBinding();
		const g1 = new FakeReadGroup();
		const gobs = new FakeReadGroup();
		const g2 = new FakeReadGroup();
		binding.createGroup(g1, false);
		binding.createGroup(gobs, false);
		binding.createGroup(g2, false);
		const gobsGroup = binding.groupState(gobs);
		if (!gobsGroup) throw new Error("group must exist");
		// gobs observed the original state id of its segment; that state was
		// replaced (never materialized) so exact-ID resolution fails, but
		// its TRUE slot — the queued read-mid segment — sits between the
		// two strict groups. Under index-wise strict-to-segment pairing the
		// hidden slot shifts g2 onto gobs's segment.
		binding.observeReadMethod(gobsGroup, gobs, "updateArgs", [
			{ path: "/b" },
			"stale-replaced-id",
		]);
		const l1 = new TurnLedger("L1");
		const readA = makeState({ id: "read-a", toolName: "read", ledger: l1 });
		const l2 = new TurnLedger("L2");
		const readMid = makeState({ id: "read-mid", toolName: "read", ledger: l2 });
		states.set(readA.id, readA);
		states.set(readMid.id, readMid);
		// True history: [s0 (g1), sMid (gobs), s2 (g2)]; the walk queued
		// only s0 and sMid — g2's segment s2 is absent.
		binding.addHydratedReadSegment(l1, [readA.id]);
		binding.addHydratedReadSegment(l2, [readMid.id]);
		expect(binding.bindHydrated(true)).toBe(false);
		// The safe prefix still pairs: no unresolved group precedes g1.
		expect(readA.component).toBe(g1);
		// The regression: g2 must NOT claim read-mid (its true owner is
		// gobs's slot). Fail-open: g2 stays native.
		expect(readMid.component).toBeUndefined();
		expect(binding.groupState(g2)?.ledger).toBeUndefined();
		expect(binding.groupState(gobs)?.ledger).toBeUndefined();
	});

	test("control: trailing unresolved observed group (no queued segment) must not suspend the safe pairs", () => {
		const { binding, states } = makeBinding();
		const g1 = new FakeReadGroup();
		const g2 = new FakeReadGroup();
		const gobs = new FakeReadGroup();
		binding.createGroup(g1, false);
		binding.createGroup(g2, false);
		binding.createGroup(gobs, false);
		const gobsGroup = binding.groupState(gobs);
		if (!gobsGroup) throw new Error("group must exist");
		binding.observeReadMethod(gobsGroup, gobs, "updateArgs", [
			{ path: "/b" },
			"ghost-id",
		]);
		const l1 = new TurnLedger("ctrl-L1");
		const readA = makeState({ id: "read-a", toolName: "read", ledger: l1 });
		const l2 = new TurnLedger("ctrl-L2");
		const readMid = makeState({ id: "read-mid", toolName: "read", ledger: l2 });
		states.set(readA.id, readA);
		states.set(readMid.id, readMid);
		// gobs trails both strict groups; its segment is absent, so it
		// cannot shift any strict slot. Both strict pairs must hold.
		binding.addHydratedReadSegment(l1, [readA.id]);
		binding.addHydratedReadSegment(l2, [readMid.id]);
		expect(binding.bindHydrated(true)).toBe(false);
		expect(readA.component).toBe(g1);
		expect(readMid.component).toBe(g2);
		expect(binding.groupState(gobs)?.ledger).toBeUndefined();
	});

	test("cost case: interleaved unresolved observed group, its segment absent — observationally identical to the hazard, must also fail open", () => {
		const { binding, states } = makeBinding();
		const g1 = new FakeReadGroup();
		const gobs = new FakeReadGroup();
		const g2 = new FakeReadGroup();
		binding.createGroup(g1, false);
		binding.createGroup(gobs, false);
		binding.createGroup(g2, false);
		const gobsGroup = binding.groupState(gobs);
		if (!gobsGroup) throw new Error("group must exist");
		binding.observeReadMethod(gobsGroup, gobs, "updateArgs", [
			{ path: "/b" },
			"ghost-id",
		]);
		const l1 = new TurnLedger("cost-L1");
		const readA = makeState({ id: "read-a", toolName: "read", ledger: l1 });
		const l2 = new TurnLedger("cost-L2");
		const readMid = makeState({ id: "read-mid", toolName: "read", ledger: l2 });
		states.set(readA.id, readA);
		states.set(readMid.id, readMid);
		// Same observable inputs as the hazard (visible [g1, gobs, g2],
		// two queued segments): the code cannot know gobs's segment is
		// absent, so g2 must also stay native — indistinguishable shapes
		// must not pair differently.
		binding.addHydratedReadSegment(l1, [readA.id]);
		binding.addHydratedReadSegment(l2, [readMid.id]);
		expect(binding.bindHydrated(true)).toBe(false);
		expect(readA.component).toBe(g1);
		expect(readMid.component).toBeUndefined();
		expect(binding.groupState(g2)?.ledger).toBeUndefined();
	});
});
