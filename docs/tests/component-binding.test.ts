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
		ledger,
		entry,
		mutations: [],
		version: 1,
		...rest,
	};
}

function makeBinding(options?: {
	isStateMutable?: (state: ToolState) => boolean;
}): {
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
		// Default: the phase half of the production `#stateMutable`
		// semantics. The regression suites override it to simulate
		// deferred-terminal runs.
		isStateMutable:
			options?.isStateMutable ?? ((state) => state.ledger.phase === "working"),
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

	test("observeToolMethod updateResult binds unbound non-read by toolCallId", () => {
		// Stock ToolExecutionComponent constructor takes `_toolCallId` but does
		// not call updateArgs with it. rebuildChatFromMessages reconstructs a
		// tool card then delivers updateResult(result, false, toolCallId)
		// (chat-transcript-builder.ts appendToolResult). Intended contract:
		// that third-arg id is exact ownership evidence — bind when the
		// component is unbound and the state is an unbound non-read. No
		// migration, no order guess.
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({
			id: "bash-1",
			toolName: "bash",
			args: { command: "wc -l *.ts" },
		});
		states.set("bash-1", state);
		binding.registerUnboundComponent(component);

		expect(
			binding.observeToolMethod(component, "updateResult", [
				{
					content: [{ type: "text", text: "[shaken ~12 tokens]" }],
					isError: false,
				},
				false,
				"bash-1",
			]),
		).toBe("bound");
		expect(binding.componentState(component)).toBe(state);
		expect(state.component).toBe(component);
		expect(state.result).toEqual({
			content: [{ type: "text", text: "[shaken ~12 tokens]" }],
			isError: false,
		});
		expect(state.isPartial).toBe(false);
		expect(binding.unboundComponents()).toEqual([]);
	});

	test("post-shake rebuild: updateResult-id binds non-reads; reads stay on group path", () => {
		// Host shake("elide") → rebuildChatFromMessages (NOT session_compact):
		// toolCall args survive; read groups reconstruct with updateArgs(args, id);
		// non-read cards reconstruct with updateResult-only. Intended: exact-id
		// bind on that updateResult for non-reads. Order/suffix still unarmed.
		const { binding, states } = makeBinding();
		const readLedger = new TurnLedger("shake-read-run");
		const readA = makeState({
			id: "read-a",
			toolName: "read",
			args: { path: "/repo/.omp-plugin/index.ts" },
			ledger: readLedger,
		});
		const readB = makeState({
			id: "read-b",
			toolName: "read",
			args: { path: "/repo/.omp-plugin/runtime-adapter.ts" },
			ledger: readLedger,
		});
		const glob = makeState({
			id: "glob-1",
			toolName: "glob",
			args: { path: "/repo/.omp-plugin/**" },
		});
		const grep = makeState({
			id: "grep-1",
			toolName: "grep",
			args: { pattern: "resolveToolRule" },
		});
		const bash = makeState({
			id: "bash-1",
			toolName: "bash",
			args: { command: "wc -l *.ts | sort -rn" },
		});
		const ev = makeState({
			id: "eval-1",
			toolName: "eval",
			args: { code: "1+1", language: "js" },
		});
		// Hidden prefix state (collapsed compacted history still on getBranch).
		const hiddenBash = makeState({
			id: "bash-old",
			toolName: "bash",
			args: { command: "echo old" },
		});
		for (const state of [hiddenBash, readA, glob, grep, bash, ev, readB]) {
			states.set(state.id, state);
		}

		const group = new FakeReadGroup();
		const groupState = binding.createGroup(group, false);
		expect(
			binding.observeReadMethod(groupState, group, "updateArgs", [
				readA.args,
				"read-a",
			]),
		).toBe("bound");
		expect(
			binding.observeReadMethod(groupState, group, "updateArgs", [
				readB.args,
				"read-b",
			]),
		).toBe("bound");

		const globC = new FakeToolComponent();
		const grepC = new FakeToolComponent();
		const bashC = new FakeToolComponent();
		const evalC = new FakeToolComponent();
		for (const component of [globC, grepC, bashC, evalC]) {
			binding.registerUnboundComponent(component);
		}
		const shaken = {
			content: [{ type: "text", text: "[shaken ~8 tokens]" }],
			isError: false,
		};
		for (const [component, id] of [
			[globC, "glob-1"],
			[grepC, "grep-1"],
			[bashC, "bash-1"],
			[evalC, "eval-1"],
		] as const) {
			expect(
				binding.observeToolMethod(component, "updateResult", [
					shaken,
					false,
					id,
				]),
			).toBe("bound");
		}

		// Order/suffix still unarmed — exact-id already resolved the visible set.
		expect(binding.bindHydrated(true, false)).toBe(true);

		expect(readA.component).toBe(group);
		expect(readB.component).toBe(group);
		expect(binding.groupState(group)?.ledger).toBe(readA.ledger);

		expect(glob.component).toBe(globC);
		expect(grep.component).toBe(grepC);
		expect(bash.component).toBe(bashC);
		expect(ev.component).toBe(evalC);
		expect(binding.componentState(globC)).toBe(glob);
		expect(binding.componentState(grepC)).toBe(grep);
		expect(binding.componentState(bashC)).toBe(bash);
		expect(binding.componentState(evalC)).toBe(ev);
		// Hidden prefix never received a component — stays unbound, not stolen.
		expect(hiddenBash.component).toBeUndefined();
	});

	test("updateResult-id: two components claiming the same id stay ambiguous", () => {
		const { binding, states } = makeBinding();
		const first = new FakeToolComponent();
		const second = new FakeToolComponent();
		const state = makeState({ id: "bash-1", toolName: "bash" });
		states.set("bash-1", state);
		expect(
			binding.observeToolMethod(first, "updateResult", [
				{ ok: 1 },
				false,
				"bash-1",
			]),
		).toBe("bound");
		expect(
			binding.observeToolMethod(second, "updateResult", [
				{ ok: 2 },
				false,
				"bash-1",
			]),
		).toBe("ambiguous");
		expect(state.component).toBe(first);
		expect(binding.componentState(first)).toBe(state);
		expect(binding.componentState(second)).toBeUndefined();
		// Second never applied its payload.
		expect(state.result).toEqual({ ok: 1 });
	});

	test("updateResult-id: successive different ids do not migrate", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const first = makeState({ id: "bash-1", toolName: "bash" });
		const second = makeState({ id: "bash-2", toolName: "bash" });
		states.set("bash-1", first);
		states.set("bash-2", second);
		expect(
			binding.observeToolMethod(component, "updateResult", [
				{ n: 1 },
				false,
				"bash-1",
			]),
		).toBe("bound");
		// Already bound: later updateResult with another id is payload-only on
		// the first binding (no migrateToRealId on this path).
		expect(
			binding.observeToolMethod(component, "updateResult", [
				{ n: 2 },
				false,
				"bash-2",
			]),
		).toBe("bound");
		expect(binding.componentState(component)).toBe(first);
		expect(first.component).toBe(component);
		expect(second.component).toBeUndefined();
		expect(first.result).toEqual({ n: 2 });
		expect(second.result).toBeUndefined();
	});

	test("updateResult-id: refuses a state already bound to another component", () => {
		const { binding, states } = makeBinding();
		const owner = new FakeToolComponent();
		const other = new FakeToolComponent();
		const state = makeState({ id: "grep-1", toolName: "grep" });
		states.set("grep-1", state);
		binding.bind(owner, state);
		expect(
			binding.observeToolMethod(other, "updateResult", [
				{ stolen: true },
				false,
				"grep-1",
			]),
		).toBe("ambiguous");
		expect(state.component).toBe(owner);
		expect(binding.componentState(other)).toBeUndefined();
		expect(state.result).toBeUndefined();
	});

	test("updateResult-id: read state on tool path is refused; group path unaffected", () => {
		const { binding, states } = makeBinding();
		const toolCard = new FakeToolComponent();
		const group = new FakeReadGroup();
		const groupState = binding.createGroup(group, false);
		const read = makeState({
			id: "read-1",
			toolName: "read",
			args: { path: "/a" },
		});
		states.set("read-1", read);
		expect(
			binding.observeToolMethod(toolCard, "updateResult", [
				{ content: [] },
				false,
				"read-1",
			]),
		).toBe("unmapped");
		expect(read.component).toBeUndefined();
		expect(binding.componentState(toolCard)).toBeUndefined();
		expect(
			binding.observeReadMethod(groupState, group, "updateArgs", [
				read.args,
				"read-1",
			]),
		).toBe("bound");
		expect(read.component).toBe(group);
		expect(groupState.ledger).toBe(read.ledger);
	});

	test("updateResult-id: frozen ledger binds ownership without writing payload", () => {
		const { binding, states } = makeBinding({
			isStateMutable: () => false,
		});
		const component = new FakeToolComponent();
		const state = makeState({
			id: "bash-1",
			toolName: "bash",
			args: { command: "true" },
			result: { kept: true },
			isPartial: false,
			version: 7,
		});
		states.set("bash-1", state);
		expect(
			binding.observeToolMethod(component, "updateResult", [
				{ content: [{ type: "text", text: "late" }], isError: true },
				true,
				"bash-1",
			]),
		).toBe("bound");
		expect(binding.componentState(component)).toBe(state);
		expect(state.component).toBe(component);
		// Ownership only — settled evidence frozen.
		expect(state.result).toEqual({ kept: true });
		expect(state.isPartial).toBe(false);
		expect(state.isError).toBe(false);
		expect(state.version).toBe(7);
	});

	test("updateResult without toolCallId fails open to native", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "bash-1", toolName: "bash" });
		states.set("bash-1", state);
		expect(
			binding.observeToolMethod(component, "updateResult", [
				{ content: [{ type: "text", text: "x" }] },
				false,
			]),
		).toBe("unmapped");
		expect(binding.componentState(component)).toBeUndefined();
		expect(state.component).toBeUndefined();
		expect(state.result).toBeUndefined();
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

	test("releaseToNative drops reverse maps but keeps state claims", () => {
		const { binding, states } = makeBinding();
		const otherComponent = new FakeToolComponent();
		const real = makeState({ id: "real-1", toolName: "bash" });
		states.set("real-1", real);
		binding.bind(otherComponent, real);
		const provisional = makeState({ id: "", toolName: "bash" });
		states.set("", provisional);
		const component = new FakeToolComponent();
		binding.bind(component, provisional);
		expect(
			binding.observeToolMethod(component, "updateArgs", [{}, "real-1"]),
		).toBe("ambiguous");
		// Caller quarantine: reverse map gone, claim retained so order
		// binding cannot steal the provisional state onto another surface.
		binding.releaseToNative(component);
		expect(binding.componentState(component)).toBeUndefined();
		expect(binding.componentState(otherComponent)).toBe(real);
		expect(provisional.component).toBe(component);
		expect(real.component).toBe(otherComponent);
		// The other surface is untouched and still exact-bound.
		expect(states.get("real-1")).toBe(real);
		expect(states.get("")).toBe(provisional);
	});

	test("releaseToNative retires a read group without freeing claimed states", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		const read = makeState({ id: "read-1", toolName: "read" });
		states.set("read-1", read);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/a" },
			"read-1",
		]);
		expect(read.component).toBe(groupComponent);
		expect(binding.groupState(groupComponent)).toBe(group);
		binding.releaseToNative(groupComponent);
		expect(binding.groupState(groupComponent)).toBeUndefined();
		expect([...binding.groups()]).toEqual([]);
		// Claim retained: a later group cannot adopt this state mid-run.
		expect(read.component).toBe(groupComponent);
		const later = new FakeReadGroup();
		const laterGroup = binding.createGroup(later, false);
		expect(
			binding.observeReadMethod(laterGroup, later, "updateArgs", [
				{ path: "/a" },
				"read-1",
			]),
		).toBe("bound");
		expect(read.component).toBe(groupComponent);
		expect(laterGroup.ledger).toBeUndefined();
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

	test('renameEntry ""→realId race keeps the group native until the real id maps', () => {
		// Host-first ordering: the group observes the empty provisional id
		// before any ToolState exists. Until rename + start settle onto a
		// mapped read state, completelyMapped stays false so compact cannot
		// hide or misattribute the still-native entry.
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);

		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/pending.ts" },
			"",
		]);
		expect(group.observedIds.has("")).toBe(true);
		expect(binding.groupCompletelyMapped(group)).toBe(false);

		// Mid-race: rename lands before tool_execution_start creates the state.
		binding.observeReadMethod(group, groupComponent, "renameEntry", [
			"",
			"read-real",
		]);
		expect(group.observedIds.has("")).toBe(false);
		expect(group.observedIds.has("read-real")).toBe(true);
		expect(binding.groupCompletelyMapped(group)).toBe(false);

		// Start finally creates the real-id state; bindByObservedId claims it
		// and the gate opens.
		const state = makeState({ id: "read-real", toolName: "read" });
		states.set("read-real", state);
		expect(binding.bindByObservedId("read-real", state)).toBe("bound");
		expect(state.component).toBe(groupComponent);
		expect(binding.groupCompletelyMapped(group)).toBe(true);
	});

	test("one untracked sibling keeps a partially observed group native", () => {
		// All-or-nothing: a mapped read must not pull the group into compact
		// while another observed id is still untracked.
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		const known = makeState({ id: "read-known", toolName: "read" });
		states.set("read-known", known);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/known.ts" },
			"read-known",
		]);
		expect(binding.groupCompletelyMapped(group)).toBe(true);

		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/ghost.ts" },
			"read-ghost",
		]);
		expect(group.observedIds.has("read-ghost")).toBe(true);
		expect(binding.groupCompletelyMapped(group)).toBe(false);
		expect(binding.mappedReadStates(group)).toEqual([known]);
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

	test("tryBindByOrder candidate filter matches the full predicate set", () => {
		// Same ledger holds noise the counting loop must skip with the
		// identical predicate the old dual-filter used: already-bound tools,
		// reads, rebuild-backlog states, and other-ledger unbound tools.
		// preserveActive resets every component claim, so the already-bound
		// tool is established after the backlog is opened.
		const { binding, states } = makeBinding();
		const ledger = new TurnLedger("run-1");
		const otherLedger = new TurnLedger("run-2");

		const staleComponent = new FakeToolComponent();
		const stale = makeState({ id: "stale-1", toolName: "bash", ledger });
		states.set("stale-1", stale);
		binding.bind(staleComponent, stale);
		binding.preserveActive([stale]);
		binding.clearPreserved(); // backlog poison; must not count

		const boundComponent = new FakeToolComponent();
		const bound = makeState({ id: "bound-1", toolName: "bash", ledger });
		states.set("bound-1", bound);
		binding.bind(boundComponent, bound);

		const read = makeState({ id: "read-1", toolName: "read", ledger });
		states.set("read-1", read);

		const other = makeState({
			id: "other-1",
			toolName: "bash",
			ledger: otherLedger,
		});
		states.set("other-1", other);

		const freshComponent = new FakeToolComponent();
		const fresh = makeState({ id: "fresh-1", toolName: "glob", ledger });
		states.set("fresh-1", fresh);
		binding.registerUnboundComponent(freshComponent);

		expect(binding.tryBindByOrder(ledger)).toBe("bound");
		expect(fresh.component).toBe(freshComponent);
		expect(bound.component).toBe(boundComponent);
		expect(read.component).toBeUndefined();
		expect(stale.component).toBeUndefined();
		expect(other.component).toBeUndefined();
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
		if (!dupGroup) throw new Error("duplicate group must exist");
		expect(dupGroup.ledger).toBeUndefined();
		expect(binding.mappedReadStates(dupGroup)).toEqual([]);
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
			if (!group) throw new Error("mapped group must exist");
			expect(group.ledger).toBe(read.ledger);
			expect(binding.mappedReadStates(group)).toEqual([read]);
			expect(binding.groupCompletelyMapped(group)).toBe(true);
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

	test("collapsed post-compaction rebuild suffix-binds without a restore arm", () => {
		// Same shape as stock rebuildChatFromMessages after LLM /compact or
		// auto context-full: full branch states, collapsed visible tool tail,
		// no preserved active run. Production commitRebuild now arms a
		// dedicated collapsed-rebuild permit (not restoreOverride) so
		// restoredArmed=true without forcing compact mode on ledgers.
		const { binding, states } = makeBinding();
		const old = makeState({ id: "bash-old", toolName: "bash" });
		const newest = makeState({ id: "bash-new", toolName: "bash" });
		states.set("bash-old", old);
		states.set("bash-new", newest);
		const visibleTail = new FakeToolComponent();
		binding.registerUnboundComponent(visibleTail);

		// Permit-armed path (restoredArmed=true): suffix pairs the newest
		// state. The unarmed path remains fail-open (covered below).
		expect(binding.bindHydrated(true, true)).toBe(true);
		expect(newest.component).toBe(visibleTail);
		expect(old.component).toBeUndefined();
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

describe("ComponentBinding: frozen-state mutation guard", () => {
	test("late updateResult/setArgsComplete after finalization do not resurrect pending state or change settled result/version", () => {
		const { binding, states, pending } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.bind(component, state);
		// The tool settles with a completed result while the run is live.
		binding.observeToolMethod(component, "updateResult", [
			{ ok: true, content: [] },
			false,
		]);
		expect(state.result).toEqual({ ok: true, content: [] });
		expect(state.isPartial).toBe(false);
		expect(pending.has(state)).toBe(false);
		const settledVersion = state.version;
		// The run reaches its terminal answer; the ledger freezes.
		state.ledger.finalize(
			{
				messages: [
					{
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "done" }],
					},
				],
			},
			"live",
		);
		expect(state.ledger.phase).toBe("filtered");
		// A late delivery must not rewrite the settled result...
		expect(
			binding.observeToolMethod(component, "updateResult", [
				{ late: true },
				true,
			]),
		).toBe("bound");
		expect(state.result).toEqual({ ok: true, content: [] });
		expect(state.isPartial).toBe(false);
		expect(pending.has(state)).toBe(false);
		// ...nor resurrect the spinner via setArgsComplete...
		binding.observeToolMethod(component, "setArgsComplete", []);
		expect(state.isPartial).toBe(false);
		expect(pending.has(state)).toBe(false);
		// ...nor re-tick the committed presentation version.
		expect(state.version).toBe(settledVersion);
	});

	test("late callbacks stay frozen while the run awaits its deferred terminal drain", () => {
		const deferredRuns = new Set<string>();
		const { binding, states, pending } = makeBinding({
			isStateMutable: (state) =>
				state.ledger.phase === "working" &&
				!deferredRuns.has(state.ledger.runId),
		});
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.bind(component, state);
		binding.observeToolMethod(component, "updateResult", [{ ok: true }, false]);
		const settledVersion = state.version;
		// A terminal agent_end parks the run in the deferred-terminal map
		// while its audit drain runs; the ledger is still phase "working".
		deferredRuns.add(state.ledger.runId);
		expect(state.ledger.phase).toBe("working");
		binding.observeToolMethod(component, "updateResult", [
			{ late: true },
			true,
		]);
		binding.observeToolMethod(component, "setArgsComplete", []);
		expect(state.result).toEqual({ ok: true });
		expect(state.isPartial).toBe(false);
		expect(pending.has(state)).toBe(false);
		expect(state.version).toBe(settledVersion);
	});

	test("updateArgs still binds on frozen state but never rewrites args or version", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.registerUnboundComponent(component);
		state.ledger.finalize(undefined, "live");
		expect(state.ledger.phase).toBe("full");
		const settledArgs = state.args;
		const settledVersion = state.version;
		// Replay of the historical updateArgs after hydration: the exact-ID
		// bind is ownership and resolves, but the payload refresh and the
		// presentation tick are evidence mutations of a settled ledger.
		expect(
			binding.observeToolMethod(component, "updateArgs", [
				{ path: "/late" },
				"call-1",
			]),
		).toBe("bound");
		expect(binding.componentState(component)).toBe(state);
		expect(state.args).toBe(settledArgs);
		expect(state.version).toBe(settledVersion);
		expect(binding.unboundComponents()).toEqual([]);
	});

	test("a frozen provisional state keeps its binding; migration never re-keys or merges", () => {
		const { binding, states, pending } = makeBinding();
		const component = new FakeToolComponent();
		const provisional = makeState({ id: "", toolName: "read" });
		states.set("", provisional);
		binding.bind(component, provisional);
		// The real-id duplicate also exists (a replay/hydration shape); the
		// run has settled.
		const real = makeState({ id: "real-1", toolName: "read" });
		real.result = { content: [] };
		states.set("real-1", real);
		pending.add(real);
		provisional.ledger.finalize(undefined, "live");
		real.ledger.finalize(undefined, "live");
		expect(provisional.ledger.phase).toBe("full");
		const settledArgs = provisional.args;
		const settledVersion = provisional.version;
		// A late provisional→real updateArgs after finalization must not
		// migrate: no re-key, no entry rewrite, no args/version change, no
		// evidence merge, no pending transfer, no map eviction. The chosen
		// contract keeps the provisional exact binding and reports bound
		// (fail-open — the native updateArgs proceeds untouched).
		expect(
			binding.observeToolMethod(component, "updateArgs", [
				{ path: "/late" },
				"real-1",
			]),
		).toBe("bound");
		expect(binding.componentState(component)).toBe(provisional);
		expect(states.get("")).toBe(provisional);
		expect(states.get("real-1")).toBe(real);
		expect(provisional.id).toBe("");
		expect(provisional.entry.id).toBe("");
		expect(provisional.entry.toolCallId).toBe("");
		expect(provisional.args).toBe(settledArgs);
		expect(provisional.version).toBe(settledVersion);
		expect(provisional.result).toBeUndefined();
		expect(pending.has(provisional)).toBe(false);
		expect(pending.has(real)).toBe(true);
		expect(real.result).toEqual({ content: [] });
	});

	test("a live provisional migration reads but never rewrites a settled real-id duplicate", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const provisional = makeState({ id: "", toolName: "read" });
		states.set("", provisional);
		binding.bind(component, provisional);
		// The real-id duplicate belongs to a settled run; the provisional is
		// still live (working ledger). Live migration keeps its documented
		// absorb-and-drop behavior...
		const real = makeState({ id: "real-1", toolName: "read" });
		real.result = { content: ["settled"] };
		real.isError = true;
		real.isPartial = false;
		states.set("real-1", real);
		real.ledger.finalize(undefined, "live");
		expect(real.ledger.phase).toBe("full");
		expect(
			binding.observeToolMethod(component, "updateArgs", [
				{ path: "/live" },
				"real-1",
			]),
		).toBe("bound");
		expect(states.get("real-1")).toBe(provisional);
		expect(states.get("")).toBeUndefined();
		expect(provisional.id).toBe("real-1");
		expect(provisional.args).toEqual({ path: "/live" });
		expect(provisional.result).toEqual({ content: ["settled"] });
		expect(provisional.isError).toBe(true);
		// ...while the settled duplicate's own evidence fields are read,
		// never rewritten.
		expect(real.id).toBe("real-1");
		expect(real.result).toEqual({ content: ["settled"] });
		expect(real.isError).toBe(true);
		expect(real.isPartial).toBe(false);
	});

	test("setExpanded stays presentation-only on frozen state", () => {
		const { binding, states } = makeBinding();
		const component = new FakeToolComponent();
		const state = makeState({ id: "call-1", toolName: "bash" });
		states.set("call-1", state);
		binding.bind(component, state);
		state.ledger.finalize(undefined, "live");
		const settledVersion = state.version;
		// The expand/collapse of a settled row is a live presentation
		// choice — the render decision reads `expanded` to pick native vs
		// compact — never settled evidence. It keeps tracking after the
		// ledger freezes, and its version tick is the re-render signal for
		// the deliberate change, not evidence churn.
		binding.observeToolMethod(component, "setExpanded", [true]);
		expect(state.expanded).toBe(true);
		expect(state.version).toBe(settledVersion + 1);
	});
});

describe("ComponentBinding: bindByObservedId collision hardening", () => {
	test("a group bound to another ledger is never overwritten by a cross-run id", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		// Run A: the group owns read-1; its ledger is settled.
		const first = makeState({ id: "read-1", toolName: "read" });
		states.set("read-1", first);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/a" },
			"read-1",
		]);
		expect(binding.bindByObservedId("read-1", first)).toBe("bound");
		expect(group.ledger).toBe(first.ledger);
		expect(first.component).toBe(groupComponent);
		// Run B: the same (stale) group observed an id that now resolves to
		// a read of a different run. The settled binding must not be
		// overwritten and the new state must stay native.
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/b" },
			"shared-1",
		]);
		const cross = makeState({ id: "shared-1", toolName: "read" });
		states.set("shared-1", cross);
		expect(binding.bindByObservedId("shared-1", cross)).toBe("ambiguous");
		expect(group.ledger).toBe(first.ledger);
		expect(first.component).toBe(groupComponent);
		expect(cross.component).toBeUndefined();
	});

	test("bindByObservedId never binds a non-read state to a group", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		const bash = makeState({ id: "shared-1", toolName: "bash" });
		states.set("shared-1", bash);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/a" },
			"shared-1",
		]);
		expect(binding.bindByObservedId("shared-1", bash)).toBe("unmapped");
		expect(bash.component).toBeUndefined();
		expect(group.ledger).toBeUndefined();
	});

	test("an id observed by two groups binds neither (ambiguous fail-open)", () => {
		const { binding, states } = makeBinding();
		const firstComponent = new FakeReadGroup();
		const secondComponent = new FakeReadGroup();
		const first = binding.createGroup(firstComponent, false);
		const second = binding.createGroup(secondComponent, false);
		// Host-first ordering: both groups streamed the same id before the
		// extension start event created the state — a duplicated/corrupted
		// host surface where either claim would be a guess.
		binding.observeReadMethod(first, firstComponent, "updateArgs", [
			{ path: "/a" },
			"read-1",
		]);
		binding.observeReadMethod(second, secondComponent, "updateArgs", [
			{ path: "/b" },
			"read-1",
		]);
		expect(first.observedIds.has("read-1")).toBe(true);
		expect(second.observedIds.has("read-1")).toBe(true);
		const read = makeState({ id: "read-1", toolName: "read" });
		states.set("read-1", read);
		expect(binding.bindByObservedId("read-1", read)).toBe("ambiguous");
		expect(read.component).toBeUndefined();
		expect(first.ledger).toBeUndefined();
		expect(second.ledger).toBeUndefined();
	});

	test("a same-ledger second read still adopts through bindByObservedId", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		const first = makeState({ id: "read-1", toolName: "read" });
		states.set("read-1", first);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/a" },
			"read-1",
		]);
		expect(binding.bindByObservedId("read-1", first)).toBe("bound");
		// Host-first ordering: the group streams read-2 before the extension
		// start event creates its state, so only the id is tracked.
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/b" },
			"read-2",
		]);
		expect(group.observedIds.has("read-2")).toBe(true);
		const second = makeState({
			id: "read-2",
			toolName: "read",
			ledger: first.ledger,
		});
		states.set("read-2", second);
		expect(binding.bindByObservedId("read-2", second)).toBe("bound");
		expect(second.component).toBe(groupComponent);
		expect(group.ledger).toBe(first.ledger);
		expect(binding.mappedReadStates(group)).toEqual([first, second]);
	});

	test("mappedReadStates sees bindByObservedId claims without a version bump", () => {
		// bindByObservedId claims state.component without group.version++.
		// A memo keyed only on group.version would go stale here and drop
		// the newly adopted read from every subsequent frame.
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		const first = makeState({ id: "read-1", toolName: "read" });
		states.set("read-1", first);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/a" },
			"read-1",
		]);
		// Host-first: observe the second id before its state exists.
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/b" },
			"read-2",
		]);
		// Warm any version-keyed memo before the silent claim.
		expect(binding.mappedReadStates(group)).toEqual([first]);
		const versionAfterObserve = group.version;
		const second = makeState({
			id: "read-2",
			toolName: "read",
			ledger: first.ledger,
			// Higher seq than first so chronological order is unambiguous.
			seq: first.seq + 10,
		});
		states.set("read-2", second);
		expect(binding.bindByObservedId("read-2", second)).toBe("bound");
		expect(group.version).toBe(versionAfterObserve);
		expect(binding.mappedReadStates(group)).toEqual([first, second]);
	});

	test("mappedReadStates orders by seq even when observe order differs", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		// Force creation-sequence order opposite to observe order via seq.
		const later = makeState({ id: "read-later", toolName: "read", seq: 2 });
		const earlier = makeState({
			id: "read-earlier",
			toolName: "read",
			ledger: later.ledger,
			seq: 1,
		});
		states.set("read-later", later);
		states.set("read-earlier", earlier);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/later" },
			"read-later",
		]);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/earlier" },
			"read-earlier",
		]);
		expect(binding.mappedReadStates(group)).toEqual([earlier, later]);
	});

	test("a provisional empty-string id adopts per the existing contract", () => {
		const { binding, states } = makeBinding();
		const groupComponent = new FakeReadGroup();
		const group = binding.createGroup(groupComponent, false);
		binding.observeReadMethod(group, groupComponent, "updateArgs", [
			{ path: "/a" },
			"",
		]);
		expect(group.observedIds.has("")).toBe(true);
		const provisional = makeState({ id: "", toolName: "read" });
		states.set("", provisional);
		expect(binding.bindByObservedId("", provisional)).toBe("bound");
		expect(provisional.component).toBe(groupComponent);
		expect(group.ledger).toBe(provisional.ledger);
	});
});
