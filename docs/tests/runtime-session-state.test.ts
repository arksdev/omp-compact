import { describe, expect, test } from "bun:test";

import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type CompactSettings,
	type CompactSettingsStore,
	DEFAULT_SETTINGS,
} from "../../.omp-plugin/config";
import {
	MAX_EVIDENCE_PATH_LENGTH,
	MAX_EVIDENCE_TEXT_LENGTH,
	MAX_MUTATION_COUNT,
	MAX_MUTATION_ENTRIES,
	MAX_PAYLOAD_BYTES,
	MAX_PAYLOAD_STEPS,
	MAX_TOOL_CALL_ID_LENGTH,
	MAX_TOOL_NAME_LENGTH,
	isBoundedCount,
	isPayloadWithinBudget,
} from "../../.omp-plugin/hydration-bounds";
import {
	type GitMessageDetails,
	isGitMessageDetails,
	isLegacyMutationMessageDetails,
	isMutationMessageDetails,
	type MutationMessageDetails,
} from "../../.omp-plugin/messages";
import { ModePolicy } from "../../.omp-plugin/mode-policy";
import { renderCompactToolRows } from "../../.omp-plugin/render";
import { MAX_STATS_ACTIONS } from "../../.omp-plugin/run-stats";
import {
	RuntimeSessionState,
	type ToolState,
} from "../../.omp-plugin/runtime-session-state";
import { insertTranscriptChildAt } from "../../.omp-plugin/host-adapter";
import type {
	RenderableBlock,
	TranscriptHost,
} from "../../.omp-plugin/transcript-fold";

class FakeTranscript implements TranscriptHost {
	readonly children: unknown[] = [];

	addChild(child: unknown): void {
		this.children.push(child);
	}

	render(): readonly string[] {
		return [];
	}

	renderViewportTail(): readonly string[] {
		return [];
	}

	isBlockUncommitted(): boolean {
		return false;
	}

	isBlockInLiveRegion(): boolean {
		return false;
	}
}

class FakeToolComponent implements RenderableBlock {
	render(): readonly string[] {
		return [];
	}
}

function customTypeOf(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || !("message" in value))
		return undefined;
	const message = value.message;
	if (
		!message ||
		typeof message !== "object" ||
		!("customType" in message) ||
		typeof message.customType !== "string"
	)
		return undefined;
	return message.customType;
}

function makeSession(): RuntimeSessionState {
	return new RuntimeSessionState({
		placeStatsCarrier: insertTranscriptChildAt,
	});
}

function makeStatsSession(): RuntimeSessionState {
	return new RuntimeSessionState({
		statsRenderer: () => "usage row",
		placeStatsCarrier: insertTranscriptChildAt,
	});
}

function fakeModeStore(
	initial: CompactSettings = DEFAULT_SETTINGS,
): CompactSettingsStore {
	let current = initial;
	const subscribers = new Set<(settings: CompactSettings) => void>();
	return {
		load: async () => current,
		snapshot: () => current,
		update: async (patch) => {
			current = {
				...current,
				...patch,
				stats: { ...current.stats, ...(patch.stats ?? {}) },
				autoShake: { ...current.autoShake, ...(patch.autoShake ?? {}) },
				host: { ...current.host, ...(patch.host ?? {}) },
			} as CompactSettings;
			for (const fn of [...subscribers]) fn(current);
			return current;
		},
		subscribe: (fn) => {
			subscribers.add(fn);
			return () => {
				subscribers.delete(fn);
			};
		},
	};
}

/** Live start that must allocate (in-budget id/name). Refusal tests call startState directly. */
function mustStart(
	session: RuntimeSessionState,
	input: {
		toolCallId: string;
		toolName: string;
		args: unknown;
	},
): ToolState {
	const state = session.startState(input);
	if (!state)
		throw new Error(`startState refused ${JSON.stringify(input.toolCallId)}`);
	return state;
}

function assistant(text: string, stopReason = "stop"): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
	};
}

function gitDetails(toolCallId: string, text: string): GitMessageDetails {
	return {
		version: 1,
		toolCallId,
		subcommand: "commit",
		text,
		isError: false,
	};
}

function mutationDetails(
	toolCallId: string,
	added: number,
	removed: number,
): MutationMessageDetails {
	return {
		version: 1,
		toolCallId,
		toolName: "write",
		path: "/tmp/x.ts",
		added,
		removed,
		exact: true,
	};
}

describe("RuntimeSessionState: run sequence and continuation", () => {
	test("beginRun creates a working ledger with a fresh run id", () => {
		const session = makeSession();
		session.beginRun();
		expect(session.activeLedger).toBeDefined();
		expect(session.activeLedger?.phase).toBe("working");
	});

	test("willContinue continuations keep the same working ledger", () => {
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger;
		expect(session.endRun({ messages: [], willContinue: true })).toBe(
			"working",
		);
		session.beginRun();
		expect(session.activeLedger).toBe(first);
		expect(first?.phase).toBe("working");
	});

	test("a terminal answer starts the next run on a fresh ledger", () => {
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger;
		expect(session.endRun({ messages: [assistant("done")] })).toBe("filtered");
		session.beginRun();
		expect(session.activeLedger).not.toBe(first);
		expect(first?.phase).toBe("filtered");
	});

	test("beginRun finalizes an abandoned working run as full", () => {
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger;
		mustStart(session, { toolCallId: "c1", toolName: "bash", args: {} });
		session.beginRun();
		expect(first?.phase).toBe("full");
		expect(session.activeLedger).not.toBe(first);
	});

	test("a claimed terminal run survives a following agent_start until its audit drain", () => {
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger;
		mustStart(session, {
			toolCallId: "first-call",
			toolName: "bash",
			args: {},
		});
		const firstRunId = session.captureTerminalRunId();
		expect(firstRunId).toBe(first?.runId);

		// Stock's fire-and-forget agent_end listener allows the next run to
		// begin before the previous audit projection resolves.
		session.beginRun();
		const second = session.activeLedger;
		expect(first?.phase).toBe("working");

		expect(
			session.endRun({ messages: [assistant("first done")] }, firstRunId),
		).toBe("filtered");
		expect(first?.phase).toBe("filtered");
		expect(session.activeLedger).toBe(second);
		session.releaseTerminalRun(firstRunId);
	});

	test("release after a failed drain finalizes only the old ledger and drains its spinner state", () => {
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger;
		expect(first).toBeDefined();
		mustStart(session, {
			toolCallId: "stale-call",
			toolName: "bash",
			args: {},
		});
		const firstRunId = session.captureTerminalRunId();
		expect(firstRunId).toBe(first?.runId);

		// Drain false: endRun never runs; the next run begins before the
		// release (stock agent_start delivery is fire-and-forget).
		session.beginRun();
		const second = session.activeLedger;
		expect(first?.phase).toBe("working");
		expect(session.pending().some((state) => state.ledger === first)).toBe(
			true,
		);

		// The release is the guaranteed finalization point: it returns the
		// exact ledger it just finalized (fallback finalization performed).
		expect(session.releaseTerminalRun(firstRunId)).toBe(first);
		expect(first?.phase).toBe("full");
		expect(session.pending().some((state) => state.ledger === first)).toBe(
			false,
		);
		expect(second?.phase).toBe("working");
		expect(session.activeLedger).toBe(second);

		// Idempotent: a second release of the same claim is a no-op.
		expect(session.releaseTerminalRun(firstRunId)).toBeUndefined();
	});

	test("release after a successful endRun finalization returns undefined (no double render)", () => {
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger;
		expect(first).toBeDefined();
		mustStart(session, { toolCallId: "done-call", toolName: "bash", args: {} });
		const firstRunId = session.captureTerminalRunId();
		expect(
			session.endRun({ messages: [assistant("first done")] }, firstRunId),
		).toBe("filtered");
		expect(first?.phase).toBe("filtered");

		expect(session.releaseTerminalRun(firstRunId)).toBeUndefined();
		expect(first?.phase).toBe("filtered");
	});

	test("a delayed no-tool stats row remains anchored to its terminal answer", () => {
		const session = makeSession();
		const transcript = new FakeTranscript();
		const answer = new FakeToolComponent();
		transcript.children.push(answer);
		session.attachTranscript(transcript);
		session.beginRun();
		const firstRunId = session.captureTerminalRunId();
		session.beginRun();

		session.endRun({ messages: [assistant("first done")] }, firstRunId);
		expect(session.showStats(firstRunId as string, "stats A")).toBe(true);
		expect(transcript.children).toHaveLength(2);
		expect(
			(transcript.children[0] as { message?: { customType?: string } }).message
				?.customType,
		).toBe("omp-compact-stats");
		expect(transcript.children[1]).toBe(answer);
		session.releaseTerminalRun(firstRunId);
	});

	test("a fresh run never order-binds a stale unbound component", () => {
		const session = makeSession();
		session.beginRun();
		const stale = new FakeToolComponent();
		session.binding.registerUnboundComponent(stale);
		expect(session.endRun({ messages: [assistant("done")] })).toBe("filtered");

		session.beginRun();
		const next = mustStart(session, {
			toolCallId: "next-run",
			toolName: "bash",
			args: { command: "printf next" },
		});
		expect(session.binding.tryBindByOrder(session.activeLedger)).toBe(
			"unmapped",
		);
		expect(next.component).toBeUndefined();
		expect(session.binding.unboundComponents()).toEqual([]);
	});
});

describe("RuntimeSessionState: tool state records", () => {
	test("startState creates a state, entry and pending marker", () => {
		const session = makeSession();
		session.beginRun();
		const state = mustStart(session, {
			toolCallId: "c1",
			toolName: "bash",
			args: { command: "ls" },
		});
		const activeLedger = session.activeLedger;
		expect(activeLedger).toBeDefined();
		if (!activeLedger) throw new Error("active ledger missing");
		expect(session.state("c1")).toBe(state);
		expect(state.ledger).toBe(activeLedger);
		expect(state.entry.id).toBe("c1");
		expect(session.pending()).toContain(state);
		expect(session.activeLedger?.entries.length).toBe(1);
	});

	test("the same toolCallId absorbs instead of duplicating", () => {
		const session = makeSession();
		session.beginRun();
		const first = mustStart(session, {
			toolCallId: "c1",
			toolName: "bash",
			args: {},
		});
		const second = mustStart(session, {
			toolCallId: "c1",
			toolName: "bash",
			args: { command: "updated" },
		});
		expect(second).toBe(first);
		expect(session.activeLedger?.entries.length).toBe(1);
	});

	test("updateTool/finishTool track partial results and errors", () => {
		const session = makeSession();
		session.beginRun();
		mustStart(session, { toolCallId: "c1", toolName: "bash", args: {} });
		const partial = session.updateTool({
			toolCallId: "c1",
			toolName: "bash",
			result: { content: ["partial"] },
			isError: false,
			isPartial: true,
		});
		expect(partial).toBeUndefined();
		expect(session.state("c1")?.isPartial).toBe(true);
		expect(session.pending().length).toBe(1);
		session.finishTool({
			toolCallId: "c1",
			toolName: "bash",
			result: { content: ["final"] },
			isError: true,
		});
		const state = session.state("c1");
		expect(state?.isPartial).toBe(false);
		expect(state?.isError).toBe(true);
		expect(state?.entry.state).toBe("error");
		expect(session.pending()).toEqual([]);
	});

	test("setMutations assigns exact retention only for non-zero diffs", () => {
		const session = makeSession();
		session.beginRun();
		mustStart(session, { toolCallId: "c1", toolName: "write", args: {} });
		session.setMutations("c1", [
			mutationDetails("c1", 0, 0),
			mutationDetails("c1", 3, 1),
		]);
		const state = session.state("c1");
		expect(state?.mutations.length).toBe(1);
		expect(state?.entry.retention).toBe("mutation");
		expect(state?.entry.mutation).toEqual({
			added: 3,
			removed: 1,
			exact: true,
		});
	});

	test("live setMutations caps the batch and demotes exactness over the truncated set", () => {
		const session = makeSession();
		session.beginRun();
		mustStart(session, { toolCallId: "c1", toolName: "write", args: {} });
		const excess = Array.from({ length: MAX_MUTATION_ENTRIES + 5 }, () =>
			mutationDetails("c1", 1, 0),
		);
		const input = [...excess];
		session.setMutations("c1", excess);
		const state = session.state("c1");
		expect(state?.mutations.length).toBe(MAX_MUTATION_ENTRIES);
		expect(state?.entry.retention).toBe("mutation");
		expect(state?.entry.mutation).toEqual({
			added: MAX_MUTATION_ENTRIES,
			removed: 0,
			exact: false,
		});
		// the caller's array is never mutated
		expect(excess).toHaveLength(input.length);
		// in-cap batches keep exactness
		session.setMutations("c1", [
			mutationDetails("c1", 2, 1),
			mutationDetails("c1", 0, 0),
		]);
		expect(session.state("c1")?.entry.mutation).toEqual({
			added: 2,
			removed: 1,
			exact: true,
		});
	});

	test("setMutations keeps count-less delete entries and demotes aggregate exactness", () => {
		const session = makeSession();
		session.beginRun();
		mustStart(session, { toolCallId: "c1", toolName: "edit", args: {} });
		session.setMutations("c1", [
			{
				toolCallId: "c1",
				toolName: "delete",
				path: "/tmp/gone.ts",
				exact: false,
			},
		]);
		const state = session.state("c1");
		// The delete row is kept even without exact counts…
		expect(state?.mutations.length).toBe(1);
		expect(state?.entry.retention).toBe("mutation");
		expect(state?.entry.state).toBe("success");
		// …and the aggregate never claims exactness over unknown counts.
		expect(state?.entry.mutation).toEqual({
			added: 0,
			removed: 0,
			exact: false,
		});
	});

	test("setMutations mixes exact and count-less delete entries honestly", () => {
		const session = makeSession();
		session.beginRun();
		mustStart(session, { toolCallId: "c1", toolName: "edit", args: {} });
		session.setMutations("c1", [
			mutationDetails("c1", 3, 1),
			{
				toolCallId: "c1",
				toolName: "delete",
				path: "/tmp/gone.ts",
				exact: false,
			},
		]);
		const state = session.state("c1");
		expect(state?.mutations.length).toBe(2);
		// Exact members are summed; the unknown-count delete demotes exactness.
		expect(state?.entry.mutation).toEqual({
			added: 3,
			removed: 1,
			exact: false,
		});
	});

	test("setGit assigns the git retention class", () => {
		const session = makeSession();
		session.beginRun();
		mustStart(session, { toolCallId: "c1", toolName: "bash", args: {} });
		session.setGit("c1", gitDetails("c1", "git commit abcd1234 Fix"));
		const state = session.state("c1");
		expect(state?.entry.retention).toBe("git");
		expect(state?.entry.git).toEqual({
			text: "git commit abcd1234 Fix",
			isError: false,
		});
	});

	test("endRun drains pending states of the finalized ledger", () => {
		const session = makeSession();
		session.beginRun();
		mustStart(session, { toolCallId: "c1", toolName: "bash", args: {} });
		expect(session.endRun({ messages: [assistant("done")] })).toBe("filtered");
		expect(session.pending()).toEqual([]);
	});
});

describe("RuntimeSessionState: phase guards freeze settled ledgers", () => {
	test("updateTool/finishTool are no-ops after a filtered finalization", () => {
		const session = makeSession();
		session.beginRun();
		const state = mustStart(session, {
			toolCallId: "c1",
			toolName: "bash",
			args: {},
		});
		expect(session.endRun({ messages: [assistant("done")] })).toBe("filtered");
		// Finalization settles the visual partial flag; late stream events
		// must not resurrect a spinner or rewrite the settled run.
		expect(state.isPartial).toBe(false);
		const version = state.version;

		expect(
			session.updateTool({
				toolCallId: "c1",
				toolName: "bash",
				result: { content: ["late partial"] },
				isError: false,
				isPartial: true,
			}),
		).toBeUndefined();
		expect(state.result).toBeUndefined();
		expect(state.isPartial).toBe(false);
		expect(state.version).toBe(version);
		expect(session.pending()).toEqual([]);

		expect(
			session.finishTool({
				toolCallId: "c1",
				toolName: "bash",
				result: { content: ["late end"] },
				isError: false,
			}),
		).toBeUndefined();
		expect(state.result).toBeUndefined();
		expect(state.isError).toBe(false);
		// Never-finished tool: no fabricated success after finalization.
		expect(state.entry.state).toBe("running");
		expect(state.version).toBe(version);
		expect(session.pending()).toEqual([]);
	});

	test("updateTool/finishTool are no-ops after a full (abort) finalization", () => {
		const session = makeSession();
		session.beginRun();
		const state = mustStart(session, {
			toolCallId: "c1",
			toolName: "bash",
			args: {},
		});
		session.finishFull();
		expect(session.activeLedger?.phase).toBe("full");
		expect(state.isPartial).toBe(false);
		const version = state.version;

		expect(
			session.finishTool({
				toolCallId: "c1",
				toolName: "bash",
				result: { ok: true },
				isError: false,
			}),
		).toBeUndefined();
		expect(state.entry.state).toBe("running");
		expect(state.isPartial).toBe(false);
		expect(state.version).toBe(version);

		expect(
			session.updateTool({
				toolCallId: "c1",
				toolName: "bash",
				result: { ok: true },
				isError: false,
				isPartial: true,
			}),
		).toBeUndefined();
		expect(session.pending()).toEqual([]);
		expect(state.isPartial).toBe(false);
		expect(state.version).toBe(version);
	});

	test("streaming updateTool freezes while a terminal ledger awaits its audit drain", () => {
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger;
		const state = mustStart(session, {
			toolCallId: "c1",
			toolName: "bash",
			args: {},
		});
		const runId = session.captureTerminalRunId();
		expect(runId).toBe(first?.runId);
		// The ledger is still nominally working until the drain settles.
		expect(first?.phase).toBe("working");

		const version = state.version;
		// Streaming partials stay frozen — they can rewrite a settled view
		// mid-drain. Authentic finishTool for a known id is the exception
		// (covered by the late-end test below).
		expect(
			session.updateTool({
				toolCallId: "c1",
				toolName: "bash",
				result: { content: ["late"] },
				isError: false,
				isPartial: true,
			}),
		).toBeUndefined();
		expect(state.version).toBe(version);
		expect(state.result).toBeUndefined();
		expect(state.entry.state).toBe("running");
		// Still partial while deferred and no end arrived — visual settle
		// happens at finalization.
		expect(state.isPartial).toBe(true);

		// Fallback finalization at release settles visual partial and keeps
		// post-finalization stream events frozen.
		session.releaseTerminalRun(runId);
		expect(first?.phase).toBe("full");
		expect(state.isPartial).toBe(false);
		const postRelease = state.version;
		expect(
			session.finishTool({
				toolCallId: "c1",
				toolName: "bash",
				result: { ok: true },
				isError: false,
			}),
		).toBeUndefined();
		expect(state.entry.state).toBe("running");
		expect(state.isPartial).toBe(false);
		expect(state.version).toBe(postRelease);
	});

	test("late tool_execution_end during deferred drain records the real result", () => {
		// agent_end parks the claim before stock's fire-and-forget
		// tool_execution_end may land. A known id's authentic end must still
		// write result/isError and clear partial — unlike streaming
		// updateTool, which stays frozen for the deferred window.
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger;
		const state = mustStart(session, {
			toolCallId: "late-end",
			toolName: "bash",
			args: { command: "printf done" },
		});
		session.updateTool({
			toolCallId: "late-end",
			toolName: "bash",
			result: { content: ["partial"] },
			isError: false,
			isPartial: true,
		});
		expect(state.isPartial).toBe(true);
		expect(state.result).toEqual({ content: ["partial"] });

		const runId = session.captureTerminalRunId();
		expect(runId).toBe(first?.runId);
		expect(first?.phase).toBe("working");

		// Streaming partials stay frozen in the deferred window.
		expect(
			session.updateTool({
				toolCallId: "late-end",
				toolName: "bash",
				result: { content: ["should-not-land"] },
				isError: false,
				isPartial: true,
			}),
		).toBeUndefined();
		expect(state.result).toEqual({ content: ["partial"] });

		// Authentic end for the already-known id lands.
		expect(
			session.finishTool({
				toolCallId: "late-end",
				toolName: "bash",
				result: { content: ["final-output"] },
				isError: false,
			}),
		).toBeUndefined(); // no component bound
		expect(state.result).toEqual({ content: ["final-output"] });
		expect(state.isPartial).toBe(false);
		expect(state.isError).toBe(false);
		expect(state.entry.state).toBe("success");
		expect(session.pending()).not.toContain(state);

		// Finalization keeps the real result; does not fabricate over it.
		expect(session.endRun({ messages: [assistant("done")] }, runId)).toBe(
			"filtered",
		);
		expect(first?.phase).toBe("filtered");
		expect(state.result).toEqual({ content: ["final-output"] });
		expect(state.isPartial).toBe(false);
		expect(state.entry.state).toBe("success");

		// After finalization, further ends stay frozen.
		const version = state.version;
		expect(
			session.finishTool({
				toolCallId: "late-end",
				toolName: "bash",
				result: { content: ["forged"] },
				isError: true,
			}),
		).toBeUndefined();
		expect(state.result).toEqual({ content: ["final-output"] });
		expect(state.isError).toBe(false);
		expect(state.version).toBe(version);
	});

	test("unknown toolCallId finishTool during deferred never allocates", () => {
		const session = makeSession();
		session.beginRun();
		mustStart(session, {
			toolCallId: "known",
			toolName: "bash",
			args: {},
		});
		const runId = session.captureTerminalRunId();
		expect(
			session.finishTool({
				toolCallId: "ghost-never-started",
				toolName: "bash",
				result: { ok: true },
				isError: false,
			}),
		).toBeUndefined();
		expect(session.state("ghost-never-started")).toBeUndefined();
		session.releaseTerminalRun(runId);
	});

	test("working-phase events still process (legitimate events are not blocked)", () => {
		const session = makeSession();
		session.beginRun();
		const state = mustStart(session, {
			toolCallId: "c1",
			toolName: "bash",
			args: {},
		});
		session.updateTool({
			toolCallId: "c1",
			toolName: "bash",
			result: { content: ["partial"] },
			isError: false,
			isPartial: true,
		});
		expect(state.isPartial).toBe(true);
		expect(session.pending()).toContain(state);
		session.finishTool({
			toolCallId: "c1",
			toolName: "bash",
			result: { content: ["final"] },
			isError: false,
		});
		expect(session.state("c1")?.entry.state).toBe("success");
		expect(session.pending()).toEqual([]);
	});

	test("continuation tool events are not blocked (willContinue keeps the ledger working)", () => {
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger;
		expect(session.endRun({ messages: [], willContinue: true })).toBe(
			"working",
		);
		session.beginRun();
		expect(session.activeLedger).toBe(first);
		mustStart(session, { toolCallId: "c2", toolName: "bash", args: {} });
		session.updateTool({
			toolCallId: "c2",
			toolName: "bash",
			result: { content: ["part"] },
			isError: false,
			isPartial: true,
		});
		expect(session.state("c2")?.isPartial).toBe(true);
		expect(session.pending().length).toBe(1);
	});

	test("live startState refuses oversized ids the way hydration does (no ordinal compact bind)", () => {
		const session = makeSession();
		session.beginRun();
		const overId = "c".repeat(MAX_TOOL_CALL_ID_LENGTH + 1);
		const component = new FakeToolComponent();
		session.binding.registerUnboundComponent(component);
		expect(
			session.startState({
				toolCallId: overId,
				toolName: "bash",
				args: {},
			}),
		).toBeUndefined();
		expect(session.state(overId)).toBeUndefined();
		// Without a compact state the single-pair order fallback must not
		// bind the unbound host component to a ghost call.
		expect(session.binding.tryBindByOrder(session.activeLedger)).toBe(
			"unmapped",
		);
		expect(session.binding.unboundComponents()).toEqual([component]);

		// Empty provisional id still allocates (stock event-controller path).
		const provisional = mustStart(session, {
			toolCallId: "",
			toolName: "bash",
			args: { command: "echo" },
		});
		expect(provisional).toBeDefined();
		expect(session.state("")).toBe(provisional);
		expect(session.binding.tryBindByOrder(session.activeLedger)).toBe("bound");
		expect(provisional?.component).toBe(component);
	});

	test("live startState refuses oversized tool names; exact in-budget ids still absorb", () => {
		const session = makeSession();
		session.beginRun();
		const overName = "t".repeat(MAX_TOOL_NAME_LENGTH + 1);
		expect(
			session.startState({
				toolCallId: "ok-id",
				toolName: overName,
				args: {},
			}),
		).toBeUndefined();
		expect(session.state("ok-id")).toBeUndefined();

		const first = mustStart(session, {
			toolCallId: "ok-id",
			toolName: "bash",
			args: { command: "one" },
		});
		const second = mustStart(session, {
			toolCallId: "ok-id",
			toolName: "bash",
			args: { command: "two" },
		});
		expect(second).toBe(first);
		expect(first?.args).toEqual({ command: "two" });
	});

	test("setMutations/setGit are no-ops after a filtered finalization", () => {
		const session = makeSession();
		session.beginRun();
		const state = mustStart(session, {
			toolCallId: "c1",
			toolName: "write",
			args: {},
		});
		expect(session.endRun({ messages: [assistant("done")] })).toBe("filtered");
		const version = state.version;
		const retention = state.entry.retention;

		expect(
			session.setMutations("c1", [mutationDetails("c1", 3, 1)]),
		).toBeUndefined();
		expect(state.mutations).toEqual([]);
		expect(state.entry.mutation).toBeUndefined();
		expect(state.entry.retention).toBe(retention);
		expect(state.version).toBe(version);

		expect(
			session.setGit("c1", gitDetails("c1", "git commit abcd1234 Late")),
		).toBeUndefined();
		expect(state.git).toBeUndefined();
		expect(state.entry.git).toBeUndefined();
		expect(state.entry.retention).toBe(retention);
		expect(state.version).toBe(version);
	});

	test("setMutations/setGit are no-ops after a full (abort) finalization", () => {
		const session = makeSession();
		session.beginRun();
		const state = mustStart(session, {
			toolCallId: "c1",
			toolName: "write",
			args: {},
		});
		session.finishFull();
		expect(session.activeLedger?.phase).toBe("full");
		const version = state.version;
		const retention = state.entry.retention;

		expect(
			session.setMutations("c1", [mutationDetails("c1", 2, 0)]),
		).toBeUndefined();
		expect(state.mutations).toEqual([]);
		expect(state.entry.retention).toBe(retention);
		expect(state.version).toBe(version);

		expect(
			session.setGit("c1", gitDetails("c1", "git commit deadbeef Abort")),
		).toBeUndefined();
		expect(state.git).toBeUndefined();
		expect(state.entry.retention).toBe(retention);
		expect(state.version).toBe(version);
	});

	test("setMutations/setGit stay open during deferred drain; freeze after finalization", () => {
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger;
		const state = mustStart(session, {
			toolCallId: "c1",
			toolName: "write",
			args: {},
		});
		const runId = session.captureTerminalRunId();
		expect(runId).toBe(first?.runId);
		// Still working while parked: the agent_end audit drain publishes
		// verified mutation/Git rows in this window (before endRun).
		expect(first?.phase).toBe("working");

		expect(session.setMutations("c1", [mutationDetails("c1", 4, 2)])).toBe(
			undefined,
		);
		// No component bound — returns undefined but evidence still applies.
		expect(state.mutations).toHaveLength(1);
		expect(state.entry.retention).toBe("mutation");
		expect(
			session.setGit("c1", gitDetails("c1", "git commit cafe0001 Drain")),
		).toBeUndefined();
		expect(state.git?.text).toBe("git commit cafe0001 Drain");
		expect(state.entry.retention).toBe("git");

		// Streaming tool_execution_update remains frozen for the deferred
		// ledger even after evidence landed. Authentic finishTool for a
		// known id is allowed separately; here only updateTool stays closed.
		const version = state.version;
		const entryState = state.entry.state;
		expect(
			session.updateTool({
				toolCallId: "c1",
				toolName: "write",
				result: { ok: true },
				isError: false,
				isPartial: true,
			}),
		).toBeUndefined();
		expect(state.entry.state).toBe(entryState);
		expect(state.version).toBe(version);
		expect(state.result).toBeUndefined();

		session.releaseTerminalRun(runId);
		expect(first?.phase).toBe("full");
		const postRelease = state.version;
		const mutations = [...state.mutations];
		expect(
			session.setMutations("c1", [mutationDetails("c1", 1, 0)]),
		).toBeUndefined();
		expect(state.mutations).toEqual(mutations);
		expect(state.version).toBe(postRelease);
	});

	test("deferred terminal settles isPartial so drain mutations render (no stuck Working…)", () => {
		// Stock may drop tool_execution_end after agent_end parks the run.
		// When the end never arrives, finalization must still clear the
		// visual partial flag so render shows mutation rows, not Working….
		// (When the end does arrive late, finishTool records the real
		// result — covered separately.)
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger;
		const state = mustStart(session, {
			toolCallId: "c1",
			toolName: "write",
			args: { path: "/tmp/x.ts" },
		});
		expect(state.isPartial).toBe(true);
		const runId = session.captureTerminalRunId();
		expect(runId).toBe(first?.runId);
		expect(first?.phase).toBe("working");

		// Drain publishes evidence while the ledger is still working.
		expect(session.setMutations("c1", [mutationDetails("c1", 4, 2)])).toBe(
			undefined,
		);
		expect(state.mutations).toHaveLength(1);
		// No tool_execution_end arrives in this scenario.
		expect(state.isPartial).toBe(true);
		expect(state.result).toBeUndefined();

		expect(session.endRun({ messages: [assistant("done")] }, runId)).toBe(
			"filtered",
		);
		expect(first?.phase).toBe("filtered");
		// Visual settle: no spinner residual after terminal finalization.
		expect(state.isPartial).toBe(false);
		expect(session.pending()).not.toContain(state);
		// Mutation retention already promoted entry.state during the drain;
		// finalization must not fabricate a different success claim.
		expect(state.entry.state).toBe("success");
		// Late finish still must not rewrite the settled run.
		const version = state.version;
		expect(
			session.finishTool({
				toolCallId: "c1",
				toolName: "write",
				result: { forged: true },
				isError: false,
			}),
		).toBeUndefined();
		expect(state.result).toBeUndefined();
		expect(state.version).toBe(version);

		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			getFgAnsi: () => "",
			getBgAnsi: () => "",
			spinnerFrames: ["⣾"],
			getSpinnerFrames: () => ["⠦"],
		} as unknown as Theme;
		const rows = renderCompactToolRows(
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
		);
		const text = rows.map((line) => Bun.stripANSI(line)).join("\n");
		expect(text).not.toContain("Working…");
		expect(text).toContain("write:");
		expect(text).toContain("/tmp/x.ts");
		expect(text).toMatch(/\+4/);
		expect(text).toMatch(/2/);
	});

	test("working-phase setMutations/setGit still process (live evidence is not blocked)", () => {
		const session = makeSession();
		session.beginRun();
		const state = mustStart(session, {
			toolCallId: "c1",
			toolName: "write",
			args: {},
		});
		const component = new FakeToolComponent();
		session.binding.bind(component, state);

		expect(session.setMutations("c1", [mutationDetails("c1", 2, 1)])).toBe(
			component,
		);
		expect(state.mutations).toHaveLength(1);
		expect(state.entry.retention).toBe("mutation");
		expect(state.entry.mutation).toEqual({
			added: 2,
			removed: 1,
			exact: true,
		});
		const afterMutation = state.version;

		expect(
			session.setGit("c1", gitDetails("c1", "git commit beef0001 Live")),
		).toBe(component);
		expect(state.git?.text).toBe("git commit beef0001 Live");
		expect(state.entry.retention).toBe("git");
		expect(state.version).toBeGreaterThan(afterMutation);
	});

	test("continuation setMutations/setGit are not blocked (willContinue keeps the ledger working)", () => {
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger;
		expect(session.endRun({ messages: [], willContinue: true })).toBe(
			"working",
		);
		session.beginRun();
		expect(session.activeLedger).toBe(first);
		const state = mustStart(session, {
			toolCallId: "c2",
			toolName: "write",
			args: {},
		});
		session.setMutations("c2", [mutationDetails("c2", 1, 0)]);
		session.setGit("c2", gitDetails("c2", "git commit cont0001 Cont"));
		expect(state.mutations).toHaveLength(1);
		expect(state.git?.text).toBe("git commit cont0001 Cont");
		expect(state.entry.retention).toBe("git");
	});
});

describe("RuntimeSessionState: terminal projections", () => {
	test("aggregate hashes stay chronological and the anchor is the last retained state", () => {
		const session = makeSession();
		session.beginRun();
		const ledger = session.activeLedger as NonNullable<
			RuntimeSessionState["activeLedger"]
		>;
		mustStart(session, { toolCallId: "c1", toolName: "bash", args: {} });
		session.setGit("c1", gitDetails("c1", "git commit aaaa1111 First"));
		mustStart(session, { toolCallId: "c2", toolName: "write", args: {} });
		session.setGit("c2", gitDetails("c2", "git commit bbbb2222 Second"));
		session.setMutations("c2", [mutationDetails("c2", 2, 0)]);
		session.endRun({ messages: [assistant("done")] });
		const projection = session.terminalProjection(ledger);
		expect(projection.hashes).toEqual(["aaaa1111", "bbbb2222"]);
		expect(projection.anchor).toBe(session.state("c2"));
		// Cached: the same immutable projection object is returned.
		expect(session.terminalProjection(ledger)).toBe(projection);
	});
});

describe("RuntimeSessionState: stats placement", () => {
	test("showStats inserts the carrier exactly once after the bound block", () => {
		const session = makeSession();
		const transcript = new FakeTranscript();
		session.attachTranscript(transcript);
		session.beginRun();
		const runId = session.activeLedger?.runId as string;
		const component = new FakeToolComponent();
		const state = mustStart(session, {
			toolCallId: "c1",
			toolName: "bash",
			args: {},
		});
		session.binding.bind(component, state);
		transcript.children.push(component);
		expect(session.showStats(runId, "usage line")).toBe(true);
		expect(transcript.children.length).toBe(2);
		const carrier = transcript.children[1] as {
			message?: { customType?: string };
		};
		expect(carrier.message?.customType).toBe("omp-compact-stats");
		expect(session.showStats(runId, "again")).toBe(false);
		expect(transcript.children.length).toBe(2);
	});

	test("unknown run ids and empty lines fail open", () => {
		const session = makeSession();
		session.beginRun();
		expect(session.showStats("ghost-run", "line")).toBe(false);
		expect(session.showStats("", "")).toBe(false);
	});

	test("no-tool runs place the carrier before the trailing answer", () => {
		const session = makeSession();
		const transcript = new FakeTranscript();
		session.attachTranscript(transcript);
		session.beginRun();
		const runId = session.activeLedger?.runId as string;
		const answer = new FakeToolComponent();
		transcript.children.push(answer);
		expect(session.showStats(runId, "usage")).toBe(true);
		expect(transcript.children[0]).not.toBe(answer);
		expect(transcript.children[1]).toBe(answer);
	});

	test("stats carrier placement fails open when the transcript array is immutable", () => {
		const session = makeSession();
		session.beginRun();
		const runId = session.activeLedger?.runId;
		if (!runId) throw new Error("missing active run");
		const transcript = new FakeTranscript();
		const answer = new FakeToolComponent();
		transcript.children.push(answer);
		Object.freeze(transcript.children);
		session.attachTranscript(transcript);
		expect(session.showStats(runId, "usage")).toBe(false);
		expect(transcript.children).toEqual([answer]);
	});
});

describe("RuntimeSessionState: hydrateBranch", () => {
	test("replays branch entries into finalized ledgers with evidence", () => {
		const session = makeSession();
		session.hydrateBranch([
			{ type: "message", message: { role: "user", content: [] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "h1",
							name: "read",
							arguments: { path: "/a" },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "h1",
					content: [],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "omp-compact-write",
				data: mutationDetails("h1", 2, 0),
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					stopReason: "stop",
				},
			},
		]);
		const state = session.state("h1");
		expect(state?.toolName).toBe("read");
		expect(state?.entry.state).toBe("success");
		expect(state?.mutations.length).toBe(1);
		expect(state?.ledger.phase).toBe("filtered");
		expect(session.activeLedger).toBe(state?.ledger);
		expect(session.pending()).toEqual([]);
	});

	test("hydrateBranch is a no-op once live states exist", () => {
		const session = makeSession();
		session.beginRun();
		mustStart(session, { toolCallId: "live-1", toolName: "bash", args: {} });
		session.hydrateBranch([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "hist-1", name: "read", arguments: {} },
					],
				},
			},
		]);
		expect(session.state("hist-1")).toBeUndefined();
		expect(session.state("live-1")).toBeDefined();
	});
});

describe("RuntimeSessionState: rebuild lifecycle", () => {
	test("beginRebuild preserves active ownership and retires historical bindings", () => {
		const session = makeSession();
		session.beginRun();
		const first = session.activeLedger as NonNullable<
			RuntimeSessionState["activeLedger"]
		>;
		mustStart(session, {
			toolCallId: "hist-1",
			toolName: "read",
			args: {},
		});
		session.endRun({ messages: [assistant("done")] });
		session.beginRun();
		const active = session.activeLedger as NonNullable<
			RuntimeSessionState["activeLedger"]
		>;
		const component = new FakeToolComponent();
		const activeState = mustStart(session, {
			toolCallId: "live-1",
			toolName: "bash",
			args: {},
		});
		session.binding.bind(component, activeState);
		expect(session.pending()).toContain(activeState);

		const snapshot = session.beginRebuild();
		expect(snapshot.generation).toBe(1);
		expect(session.generation).toBe(1);
		expect(snapshot.activeLedger).toBe(active);
		expect(snapshot.activeStates).toContain(activeState);
		// Historical finalized state left the map; the active state survived
		// with object identity.
		expect(session.allStates().map((state) => state.id)).toEqual(["live-1"]);
		expect(session.state("live-1")).toBe(activeState);
		expect(session.state("hist-1")).toBeUndefined();
		// Every component ref was cleared so re-added instances re-bind.
		expect(activeState.component).toBeUndefined();
		expect(session.binding.componentState(component)).toBeUndefined();
		// Active pending semantics are untouched.
		expect(session.pending()).toContain(activeState);
		// The active ledger phase is untouched.
		expect(active.phase).toBe("working");
		expect(first.phase).toBe("filtered");
		session.abortRebuild(snapshot);
	});

	test("a second beginRebuild supersedes the pending rebuild", () => {
		const session = makeSession();
		session.beginRun();
		const active = session.activeLedger;
		const first = session.beginRebuild();
		const second = session.beginRebuild();
		expect(second.generation).toBe(first.generation + 1);
		expect(second.activeLedger).toBe(first.activeLedger);
		expect(second.activeLedger).toBe(active);
		// Only the latest generation commits; the stale token no-ops.
		const stale = session.commitRebuild(first, { branchEntries: [] });
		expect(stale.mapped).toBe(false);
		session.abortRebuild(second);
	});

	test("abortRebuild clears the marker and never throws", () => {
		const session = makeSession();
		session.beginRun();
		const snapshot = session.beginRebuild();
		expect(() => session.abortRebuild(snapshot)).not.toThrow();
		const again = session.beginRebuild();
		expect(again.generation).toBe(2);
		session.abortRebuild(again);
	});

	test("abortRebuild closes the preserved identity window", () => {
		const session = makeSession();
		session.beginRun();
		const component = new FakeToolComponent();
		const state = mustStart(session, {
			toolCallId: "live-1",
			toolName: "bash",
			args: {},
		});
		session.binding.bind(component, state);
		const snapshot = session.beginRebuild();
		expect(state.component).toBeUndefined();
		session.abortRebuild(snapshot);
		// after abort a re-add is never identity-bound: the exact component
		// map is only valid until the rebuild is cancelled or settled
		session.binding.registerUnboundComponent(component);
		expect(session.binding.componentState(component)).toBeUndefined();
		expect(session.binding.unboundComponents()).toEqual([component]);
	});

	test("commitRebuild rebuilds historical ledgers and restores the active one", () => {
		const session = makeSession();
		session.beginRun();
		const active = session.activeLedger as NonNullable<
			RuntimeSessionState["activeLedger"]
		>;
		mustStart(session, { toolCallId: "live-1", toolName: "bash", args: {} });
		const snapshot = session.beginRebuild();
		const outcome = session.commitRebuild(snapshot, {
			branchEntries: [
				{ type: "message", message: { role: "user", content: [] } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "hist-1",
								name: "read",
								arguments: { path: "/a" },
							},
						],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						stopReason: "stop",
					},
				},
			],
		});
		expect(outcome.generation).toBe(1);
		expect(outcome.mapped).toBe(true);
		expect(session.activeLedger).toBe(active);
		const historical = session.state("hist-1");
		expect(historical?.ledger).not.toBe(active);
		expect(historical?.ledger.phase).toBe("filtered");
		expect(session.state("live-1")).toBeDefined();
	});

	test("commitRebuild keeps active ownership: branch never replaces live evidence", () => {
		const session = makeSession();
		session.beginRun();
		const activeState = mustStart(session, {
			toolCallId: "live-1",
			toolName: "bash",
			args: { command: "live" },
		});
		activeState.result = { content: ["partial stream"] };
		activeState.isPartial = true;
		const snapshot = session.beginRebuild();
		const outcome = session.commitRebuild(snapshot, {
			branchEntries: [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "live-1",
								name: "bash",
								arguments: { command: "branch-stale" },
							},
						],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "live-1",
						content: [{ type: "text", text: "branch result" }],
						isError: false,
					},
				},
			],
		});
		expect(outcome.mapped).toBe(true);
		expect(session.state("live-1")).toBe(activeState);
		expect(activeState.result).toEqual({ content: ["partial stream"] });
		expect(activeState.args).toEqual({ command: "live" });
		expect(activeState.isPartial).toBe(true);
		expect(activeState.ledger.phase).toBe("working");
		expect(session.activeLedger).toBe(activeState.ledger);
	});

	test("commitRebuild with a stale generation is a safe no-op", () => {
		const session = makeSession();
		session.beginRun();
		const first = session.beginRebuild();
		session.abortRebuild(first);
		const second = session.beginRebuild();
		const outcome = session.commitRebuild(first, { branchEntries: [] });
		expect(outcome.generation).toBe(2);
		expect(outcome.mapped).toBe(false);
		session.abortRebuild(second);
	});

	test("commitRebuild reports mapped=false when bindings stay ambiguous", () => {
		const session = makeSession();
		session.beginRun();
		mustStart(session, { toolCallId: "active", toolName: "bash", args: {} });
		const snapshot = session.beginRebuild();
		const component = new FakeToolComponent();
		session.binding.registerUnboundComponent(component);
		const outcome = session.commitRebuild(snapshot, { branchEntries: [] });
		expect(outcome.mapped).toBe(false);
		expect(session.binding.unboundComponents()).toEqual([]);
	});

	test("terminal retirement drops raw payloads but preserves filtered projection", () => {
		const session = makeSession();
		session.beginRun();
		const ledger = session.activeLedger as NonNullable<
			RuntimeSessionState["activeLedger"]
		>;
		const state = mustStart(session, {
			toolCallId: "retire-1",
			toolName: "write",
			args: { path: "/tmp/retire.ts", content: "x".repeat(4_096) },
		});
		session.finishTool({
			toolCallId: state.id,
			toolName: state.toolName,
			result: { content: [{ type: "text", text: "y".repeat(4_096) }] },
			isError: false,
		});
		session.setMutations(state.id, [mutationDetails(state.id, 3, 1)]);
		session.setGit(state.id, gitDetails(state.id, "git commit abc1234 done"));
		expect(session.endRun({ messages: [assistant("done")] })).toBe("filtered");
		const projection = session.terminalProjection(ledger);
		expect(projection.hashes).toEqual(["abc1234"]);

		expect(session.retireFilteredPayloads(ledger.runId)).toBe(true);
		expect(state.args).toBeUndefined();
		expect(state.result).toBeUndefined();
		expect(state.git).toBeUndefined();
		expect(state.mutations).toEqual([mutationDetails(state.id, 3, 1)]);
		expect(session.terminalProjection(ledger)).toBe(projection);
		expect(session.retireFilteredPayloads(ledger.runId)).toBe(false);
	});

	test("five-thousand-call rebuilds replace retired generation state", () => {
		const session = makeSession();
		const calls = Array.from({ length: 5_000 }, (_, index) => ({
			type: "toolCall",
			id: `stress-${index}`,
			name: "bash",
			arguments: { command: `printf ${index}` },
		}));
		const branch: unknown[] = [
			{ type: "message", message: { role: "user", content: [] } },
			{
				type: "message",
				message: { role: "assistant", content: calls, stopReason: "toolUse" },
			},
			...calls.map((call) => ({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: call.id,
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			})),
			{ type: "message", message: assistant("done") },
		];

		expect(session.hydrateBranch(branch)).toBe(true);
		expect(session.allStates()).toHaveLength(5_000);
		let retired = session.state("stress-0");
		for (let generation = 1; generation <= 3; generation++) {
			const snapshot = session.beginRebuild();
			expect(snapshot.generation).toBe(generation);
			expect(session.allStates()).toHaveLength(0);
			const outcome = session.commitRebuild(snapshot, {
				branchEntries: branch,
			});
			expect(outcome.mapped).toBe(true);
			expect(session.allStates()).toHaveLength(5_000);
			expect(session.state("stress-0")).not.toBe(retired);
			retired = session.state("stress-0");
		}
	});

	test("dispose releases every reference and rebuild marker", () => {
		const session = makeSession();
		session.beginRun();
		const state = mustStart(session, {
			toolCallId: "c1",
			toolName: "bash",
			args: {},
		});
		const component = new FakeToolComponent();
		session.binding.bind(component, state);
		const snapshot = session.beginRebuild();
		session.dispose();
		expect(session.activeLedger).toBeUndefined();
		expect(session.allStates()).toEqual([]);
		expect(session.pending()).toEqual([]);
		expect(session.showStats("x", "line")).toBe(false);
		expect(session.ledgerActions("x")).toBeUndefined();
		// A stale rebuild token must not resurrect work on a disposed session.
		expect(session.commitRebuild(snapshot, { branchEntries: [] }).mapped).toBe(
			false,
		);
	});

	test("in-session collapsed LLM-compaction rebuild suffix-binds via collapsed rebuild permit", async () => {
		// Models stock post-LLM-compaction UI rebuild (NOT /shake, NOT resume):
		//   session_compact → armCollapsedRebuild
		//   rebuildChatFromMessages → chatContainer.clear → collapsed tail only
		//   (display.collapseCompacted default true), while getBranch() still
		//   walks the FULL path including pre-compaction tool calls.
		// restoreOverride stays undefined so historical ledgers keep live mode.
		const store = fakeModeStore({
			...DEFAULT_SETTINGS,
			mode: "live",
			enabled: true,
		});
		const policy = new ModePolicy(store);
		policy.prime();
		await policy.ready();
		// session_compact path: permit only, never armRestoreOverride.
		policy.armCollapsedRebuild();
		expect(policy.restoreOverride).toBeUndefined();
		expect(policy.collapsedRebuildArmed).toBe(true);

		const session = new RuntimeSessionState({
			placeStatsCarrier: insertTranscriptChildAt,
			modePolicy: policy,
		});
		const branch: unknown[] = [
			{ type: "message", message: { role: "user", content: [] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "bash-old",
							name: "bash",
							arguments: { command: "printf old" },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-old",
					toolName: "bash",
					content: [{ type: "text", text: "old" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("old done") },
			{ type: "message", message: { role: "user", content: [] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "bash-new",
							name: "bash",
							arguments: { command: "printf new" },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-new",
					toolName: "bash",
					content: [{ type: "text", text: "new" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("new done") },
		];
		expect(session.hydrateBranch(branch)).toBe(true);
		// Permit is not spent by hydrateBranch (cold path); only commitRebuild
		// / abortRebuild / prepareRun / dispose consume it.
		expect(policy.collapsedRebuildArmed).toBe(true);
		const oldState = session.state("bash-old");
		const newState = session.state("bash-new");
		expect(oldState).toBeDefined();
		expect(newState).toBeDefined();
		if (!oldState || !newState)
			throw new Error("expected hydrated tool states");
		const oldLedgerMode = session.modeFor(oldState.ledger);
		const newLedgerMode = session.modeFor(newState.ledger);
		// Without restoreOverride, ledgers keep the persisted live policy.
		expect(oldLedgerMode.mode).toBe("live");
		expect(newLedgerMode.mode).toBe("live");
		expect(session.activeLedger?.phase).not.toBe("working");

		const snapshot = session.beginRebuild();
		expect(snapshot.activeStates).toEqual([]);
		const visibleTail = new FakeToolComponent();
		session.binding.registerUnboundComponent(visibleTail);

		const outcome = session.commitRebuild(snapshot, { branchEntries: branch });
		const newest = session.state("bash-new");
		const oldest = session.state("bash-old");
		expect(outcome.mapped).toBe(true);
		expect(newest?.component).toBe(visibleTail);
		expect(oldest?.component).toBeUndefined();
		expect(session.binding.componentState(visibleTail)).toBe(newest);
		// One-shot: spent after settlement so a later /shake clear cannot reuse it.
		expect(policy.collapsedRebuildArmed).toBe(false);
		// Mode still live after rebuild (not forced compact by the permit).
		expect(newest).toBeDefined();
		if (!newest) throw new Error("expected newest state after rebuild");
		expect(session.modeFor(newest.ledger).mode).toBe("live");
	});
});

describe("RuntimeSessionState: hydration bounds (F01)", () => {
	function answerMessage(text = "done"): unknown {
		return { type: "message", message: assistant(text) };
	}

	function toolCallMessage(
		id: string,
		name: string,
		args: unknown = {},
	): unknown {
		return {
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id, name, arguments: args }],
				stopReason: "toolUse",
			},
		};
	}

	function toolResultMessage(id: string, text: string): unknown {
		return {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: id,
				content: [{ type: "text", text }],
				isError: false,
			},
		};
	}

	function mutationCarrier(details: MutationMessageDetails): unknown {
		return { type: "custom", customType: "omp-compact-write", data: details };
	}

	function gitCarrier(details: GitMessageDetails): unknown {
		return { type: "custom", customType: "omp-compact-git", data: details };
	}

	function gitDetailsWithRecords(id: string, count: number): GitMessageDetails {
		return {
			version: 1,
			toolCallId: id,
			subcommand: "add",
			text: "git add a",
			isError: false,
			records: Array.from({ length: count }, () => ({
				subcommand: "status",
				text: "git status",
				isError: false,
			})),
		};
	}

	test("tool starts at the identity limit hydrate; over the limit stay native", () => {
		const session = makeSession();
		const atLimitId = "c".repeat(MAX_TOOL_CALL_ID_LENGTH);
		const overId = "c".repeat(MAX_TOOL_CALL_ID_LENGTH + 1);
		const overName = "b".repeat(MAX_TOOL_NAME_LENGTH + 1);
		expect(
			session.hydrateBranch([
				{ type: "message", message: { role: "user", content: [] } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: atLimitId, name: "read", arguments: {} },
							{ type: "toolCall", id: overId, name: "read", arguments: {} },
							{
								type: "toolCall",
								id: "ok-1",
								name: overName,
								arguments: {},
							},
							{
								type: "toolCall",
								id: "ok-2",
								name: "read",
								arguments: {},
							},
						],
					},
				},
				answerMessage(),
			]),
		).toBe(true);
		expect(session.state(atLimitId)).toBeDefined();
		expect(session.state(overId)).toBeUndefined();
		expect(session.state("ok-1")).toBeUndefined();
		expect(session.state("ok-2")).toBeDefined();
		expect(session.activeLedger?.phase).toBe("filtered");
	});

	test("tool args over the payload budget skip allocation; in-budget args hydrate", () => {
		const session = makeSession();
		const hugeArgs = { content: "x".repeat(MAX_PAYLOAD_BYTES + 1) };
		const okArgs = { content: "x".repeat(1_024) };
		session.hydrateBranch([
			{ type: "message", message: { role: "user", content: [] } },
			toolCallMessage("big", "write", hugeArgs),
			toolCallMessage("small", "write", okArgs),
			answerMessage(),
		]);
		expect(session.state("big")).toBeUndefined();
		expect(session.state("small")?.args).toBe(okArgs);
	});

	test("oversized result payloads settle the state without retaining the payload", () => {
		const session = makeSession();
		const hugeText = "x".repeat(MAX_PAYLOAD_BYTES + 1);
		const okText = "ok";
		session.hydrateBranch([
			{ type: "message", message: { role: "user", content: [] } },
			toolCallMessage("big", "bash"),
			toolCallMessage("small", "bash"),
			toolResultMessage("big", hugeText),
			toolResultMessage("small", okText),
			answerMessage(),
		]);
		const big = session.state("big");
		expect(big?.entry.state).toBe("success");
		expect(big?.isPartial).toBe(false);
		expect(big?.result).toBeUndefined();
		const small = session.state("small");
		expect(small?.result).toEqual({
			role: "toolResult",
			toolCallId: "small",
			content: [{ type: "text", text: okText }],
			isError: false,
		});
	});

	test("mutation carriers: oversized fields are ignored, valid siblings hydrate", () => {
		const session = makeSession();
		session.hydrateBranch([
			{ type: "message", message: { role: "user", content: [] } },
			toolCallMessage("m1", "read"),
			toolCallMessage("m2", "read"),
			toolCallMessage("m3", "read"),
			toolResultMessage("m1", "ok"),
			toolResultMessage("m2", "ok"),
			toolResultMessage("m3", "ok"),
			mutationCarrier({
				...mutationDetails("m1", 1, 0),
				path: "p".repeat(MAX_EVIDENCE_PATH_LENGTH + 1),
			}),
			mutationCarrier({
				...mutationDetails("m2", 1, 0),
				added: MAX_MUTATION_COUNT + 1,
			}),
			mutationCarrier(mutationDetails("m3", 2, 1)),
			answerMessage(),
		]);
		expect(session.state("m1")?.mutations).toEqual([]);
		expect(session.state("m2")?.mutations).toEqual([]);
		expect(session.state("m3")?.mutations.length).toBe(1);
		expect(session.state("m3")?.entry.mutation).toEqual({
			added: 2,
			removed: 1,
			exact: true,
		});
	});

	test("mutation carriers at the per-state cap drop excess evidence and demote exactness", () => {
		const session = makeSession();
		const carriers = Array.from({ length: MAX_MUTATION_ENTRIES + 1 }, () =>
			mutationCarrier(mutationDetails("cap-1", 1, 0)),
		);
		session.hydrateBranch([
			{ type: "message", message: { role: "user", content: [] } },
			toolCallMessage("cap-1", "edit"),
			toolResultMessage("cap-1", "ok"),
			...carriers,
			answerMessage(),
		]);
		const state = session.state("cap-1");
		expect(state?.mutations.length).toBe(MAX_MUTATION_ENTRIES);
		// The excess carrier was ignored and the aggregate no longer claims
		// exactness over the truncated set.
		expect(state?.entry.mutation?.exact).toBe(false);
	});

	test("git carriers: bounded records hydrate; oversized rows, texts and counts stay ignored", () => {
		const session = makeSession();
		session.hydrateBranch([
			{ type: "message", message: { role: "user", content: [] } },
			toolCallMessage("g1", "bash"),
			toolCallMessage("g2", "bash"),
			toolCallMessage("g3", "bash"),
			toolCallMessage("g4", "bash"),
			toolCallMessage("g5", "bash"),
			toolResultMessage("g1", "ok"),
			toolResultMessage("g2", "ok"),
			toolResultMessage("g3", "ok"),
			toolResultMessage("g4", "ok"),
			toolResultMessage("g5", "ok"),
			gitCarrier(gitDetailsWithRecords("g1", 8)),
			gitCarrier(gitDetailsWithRecords("g2", 9)),
			gitCarrier({
				...gitDetailsWithRecords("g3", 1),
				records: [
					{
						subcommand: "status",
						text: "t".repeat(MAX_EVIDENCE_TEXT_LENGTH + 1),
						isError: false,
					},
				],
			}),
			gitCarrier({
				...gitDetails("g4", "git status"),
				text: "t".repeat(MAX_EVIDENCE_TEXT_LENGTH + 1),
			}),
			gitCarrier(gitDetails("g5", "git commit abcd1234 Fix")),
			answerMessage(),
		]);
		expect(session.state("g1")?.git?.records?.length).toBe(8);
		expect(session.state("g2")?.git).toBeUndefined();
		expect(session.state("g3")?.git).toBeUndefined();
		expect(session.state("g4")?.git).toBeUndefined();
		expect(session.state("g5")?.git).toBeDefined();
	});

	test("stats carriers: bounded evidence reinserts once; oversized or duplicate evidence is ignored", () => {
		const transcript = new FakeTranscript();
		const answer = new FakeToolComponent();
		transcript.children.push(answer);
		const session = makeStatsSession();
		session.attachTranscript(transcript);
		const good = {
			version: 1,
			runId: "omp-compact-run-9",
			actions: 1,
			sent: 100,
			received: 50,
			cacheRead: 200,
			cacheWrite: 30,
			hitRate: 200 / 300,
			durationMs: 32_000,
			hasError: false,
			messages: 1,
			completedAt: 1_700_000_100_000,
		};
		const oversized = { ...good, actions: MAX_STATS_ACTIONS + 1 };
		session.hydrateBranch([
			{ type: "message", message: { role: "user", content: [] } },
			answerMessage("replayed"),
			{ type: "custom", customType: "omp-compact-stats", data: good },
			{ type: "custom", customType: "omp-compact-stats", data: good },
			{ type: "custom", customType: "omp-compact-stats", data: oversized },
		]);
		expect(transcript.children.length).toBe(2);
		expect(customTypeOf(transcript.children[0])).toBe("omp-compact-stats");
		expect(transcript.children[1]).toBe(answer);
	});

	test("stats carriers from completed branch runs reinsert in chronological order", () => {
		const transcript = new FakeTranscript();
		const firstTool = new FakeToolComponent();
		const secondTool = new FakeToolComponent();
		const finalAnswer = new FakeToolComponent();
		transcript.children.push(firstTool, secondTool, finalAnswer);
		const session = makeStatsSession();
		session.attachTranscript(transcript);
		session.binding.registerUnboundComponent(firstTool);
		session.binding.registerUnboundComponent(secondTool);
		const stats = (runId: string) => ({
			version: 1,
			runId,
			actions: 1,
			sent: 100,
			received: 50,
			cacheRead: 200,
			cacheWrite: 30,
			hitRate: 2 / 3,
			durationMs: 32_000,
			hasError: false,
			messages: 1,
			completedAt: 1_700_000_100_000,
		});
		expect(
			session.hydrateBranch([
				{ type: "message", message: { role: "user", content: [] } },
				toolCallMessage("first-tool", "bash"),
				toolResultMessage("first-tool", "ok"),
				answerMessage("first done"),
				{
					type: "custom",
					customType: "omp-compact-stats",
					data: stats("run-a"),
				},
				{ type: "message", message: { role: "user", content: [] } },
				toolCallMessage("second-tool", "bash"),
				toolResultMessage("second-tool", "ok"),
				answerMessage("second done"),
				{
					type: "custom",
					customType: "omp-compact-stats",
					data: stats("run-b"),
				},
			]),
		).toBe(true);
		expect(transcript.children).toHaveLength(5);
		expect(transcript.children[0]).toBe(firstTool);
		expect(customTypeOf(transcript.children[1])).toBe("omp-compact-stats");
		expect(transcript.children[2]).toBe(secondTool);
		expect(customTypeOf(transcript.children[3])).toBe("omp-compact-stats");
		expect(transcript.children[4]).toBe(finalAnswer);
	});

	test("an oversized stats carrier alone inserts nothing", () => {
		const transcript = new FakeTranscript();
		const answer = new FakeToolComponent();
		transcript.children.push(answer);
		const session = makeStatsSession();
		session.attachTranscript(transcript);
		session.hydrateBranch([
			{ type: "message", message: { role: "user", content: [] } },
			answerMessage("replayed"),
			{
				type: "custom",
				customType: "omp-compact-stats",
				data: {
					version: 1,
					runId: "r".repeat(129),
					actions: 1,
					sent: 100,
					received: 50,
					cacheRead: 200,
					cacheWrite: 30,
					hitRate: 0.5,
					durationMs: 32_000,
					hasError: false,
					messages: 1,
					completedAt: 1_700_000_100_000,
				},
			},
		]);
		expect(transcript.children).toEqual([answer]);
	});

	test("a malformed entry coexists with valid retained evidence", () => {
		const session = makeSession();
		expect(
			session.hydrateBranch([
				{ type: "message", message: { role: "user", content: [] } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "h1", name: "read", arguments: {} },
							{ type: "toolCall", id: "h2", name: "bash", arguments: {} },
							{
								type: "toolCall",
								id: "c".repeat(MAX_TOOL_CALL_ID_LENGTH + 1),
								name: "read",
								arguments: {},
							},
						],
					},
				},
				toolResultMessage("h1", "ok"),
				toolResultMessage("h2", "ok"),
				mutationCarrier({
					...mutationDetails("h1", 1, 0),
					path: "p".repeat(MAX_EVIDENCE_PATH_LENGTH + 1),
				}),
				mutationCarrier(mutationDetails("h1", 2, 0)),
				gitCarrier(gitDetailsWithRecords("h2", 9)),
				gitCarrier(gitDetails("h2", "git commit abcd1234 Fix")),
				answerMessage(),
			]),
		).toBe(true);
		const h1 = session.state("h1");
		const h2 = session.state("h2");
		expect(h1?.mutations.length).toBe(1);
		expect(h1?.entry.mutation).toEqual({ added: 2, removed: 0, exact: true });
		expect(h2?.git?.text).toBe("git commit abcd1234 Fix");
		expect(h1?.entry.state).toBe("success");
		expect(h2?.entry.state).toBe("success");
		expect(
			session.state("c".repeat(MAX_TOOL_CALL_ID_LENGTH + 1)),
		).toBeUndefined();
		expect(session.activeLedger?.phase).toBe("filtered");
		expect(session.pending()).toEqual([]);
	});

	test("mutation evidence validator bounds fields at limit and over limit", () => {
		const base = mutationDetails("m1", 1, 0);
		expect(isMutationMessageDetails(base)).toBe(true);
		expect(
			isMutationMessageDetails({
				...base,
				toolName: "delete",
				added: 0,
				removed: 3,
			}),
		).toBe(true);
		expect(
			isMutationMessageDetails({
				...base,
				toolCallId: "c".repeat(MAX_TOOL_CALL_ID_LENGTH),
			}),
		).toBe(true);
		expect(
			isMutationMessageDetails({
				...base,
				toolCallId: "c".repeat(MAX_TOOL_CALL_ID_LENGTH + 1),
			}),
		).toBe(false);
		expect(
			isMutationMessageDetails({
				...base,
				path: "p".repeat(MAX_EVIDENCE_PATH_LENGTH),
			}),
		).toBe(true);
		expect(
			isMutationMessageDetails({
				...base,
				path: "p".repeat(MAX_EVIDENCE_PATH_LENGTH + 1),
			}),
		).toBe(false);
		expect(
			isMutationMessageDetails({ ...base, added: MAX_MUTATION_COUNT }),
		).toBe(true);
		expect(
			isMutationMessageDetails({ ...base, added: MAX_MUTATION_COUNT + 1 }),
		).toBe(false);
		expect(
			isMutationMessageDetails({ ...base, removed: MAX_MUTATION_COUNT }),
		).toBe(true);
		expect(
			isMutationMessageDetails({ ...base, removed: MAX_MUTATION_COUNT + 1 }),
		).toBe(false);
		expect(isMutationMessageDetails({ ...base, version: 2 })).toBe(false);
	});

	test("count-less delete evidence validates as legacy, not as exact", () => {
		const deleteWithoutCounts = {
			toolCallId: "m1",
			toolName: "delete",
			path: "/tmp/gone.ts",
			exact: false,
		};
		expect(isLegacyMutationMessageDetails(deleteWithoutCounts)).toBe(true);
		// Exact-evidence validation is NOT weakened for count-less deletes:
		// the strict v1 validator still rejects them.
		expect(isMutationMessageDetails(deleteWithoutCounts)).toBe(false);
	});

	test("git evidence validator bounds fields at limit and over limit", () => {
		const base: GitMessageDetails = {
			version: 1,
			toolCallId: "g1",
			subcommand: "add",
			text: "git add a",
			isError: false,
		};
		expect(isGitMessageDetails(base)).toBe(true);
		expect(
			isGitMessageDetails({
				...base,
				records: gitDetailsWithRecords("g1", 8).records,
			}),
		).toBe(true);
		expect(
			isGitMessageDetails({
				...base,
				records: gitDetailsWithRecords("g1", 9).records,
			}),
		).toBe(false);
		expect(
			isGitMessageDetails({
				...base,
				toolCallId: "c".repeat(MAX_TOOL_CALL_ID_LENGTH + 1),
			}),
		).toBe(false);
		expect(
			isGitMessageDetails({
				...base,
				text: "t".repeat(MAX_EVIDENCE_TEXT_LENGTH + 1),
			}),
		).toBe(false);
		expect(
			isGitMessageDetails({
				...base,
				cwd: "c".repeat(MAX_EVIDENCE_PATH_LENGTH + 1),
			}),
		).toBe(false);
		expect(isGitMessageDetails({ ...base, shortHash: "h".repeat(65) })).toBe(
			false,
		);
		expect(
			isGitMessageDetails({
				...base,
				subject: "s".repeat(MAX_EVIDENCE_TEXT_LENGTH + 1),
			}),
		).toBe(false);
	});

	test("a wide primitive array over the byte budget is rejected", () => {
		// 2_000 numbers x 8 retained bytes each: 16_008 > 1_024 budget. The
		// retained primitive cost must trip the byte budget before the step
		// cap could ever be reached.
		expect(
			isPayloadWithinBudget(
				Array.from({ length: 2_000 }, () => 7),
				1_024,
			),
		).toBe(false);
		// 2_000 nulls x 4 retained bytes each: 8_008 > 1_024 budget.
		expect(
			isPayloadWithinBudget(
				Array.from({ length: 2_000 }, () => null),
				1_024,
			),
		).toBe(false);
		// Wide-but-shallow object: 2_000 null-valued keys cost their fixed
		// leaf slots, not just the 1-byte key names.
		expect(
			isPayloadWithinBudget(
				Object.fromEntries(
					Array.from({ length: 2_000 }, (_, i) => [`k${i}`, null]),
				),
				1_024,
			),
		).toBe(false);
	});

	test("small primitive payloads stay accepted", () => {
		expect(isPayloadWithinBudget([1, "hi", true, null, 3.5], 1_024)).toBe(true);
		expect(isPayloadWithinBudget(7, 1_024)).toBe(true);
		expect(isPayloadWithinBudget(null, 1_024)).toBe(true);
		expect(isPayloadWithinBudget(undefined, 1_024)).toBe(true);
		expect(isPayloadWithinBudget(() => undefined, 1_024)).toBe(true);
	});

	test("cycles, depth, hostile proxies and step overflow stay fail-closed", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(isPayloadWithinBudget(cyclic)).toBe(false);
		let deep: unknown = null;
		for (let i = 0; i < 40; i += 1) deep = { a: deep };
		expect(isPayloadWithinBudget(deep)).toBe(false);
		const hostile = new Proxy(
			{ a: 1 },
			{
				get() {
					throw new Error("hostile getter");
				},
			},
		);
		expect(isPayloadWithinBudget(hostile)).toBe(false);
		// Step cap: more nodes than MAX_PAYLOAD_STEPS are rejected even under
		// a byte budget large enough to hold them all.
		expect(
			isPayloadWithinBudget(
				Array.from({ length: MAX_PAYLOAD_STEPS + 1 }, () => null),
				MAX_PAYLOAD_STEPS * 8,
			),
		).toBe(false);
		// Wide primitive array at the default budget: rejected (bytes trip
		// first, well before the step cap).
		expect(
			isPayloadWithinBudget(Array.from({ length: 200_000 }, () => 7)),
		).toBe(false);
	});

	test("fractional mutation counts are rejected; integer boundaries accepted", () => {
		expect(isBoundedCount(0, MAX_MUTATION_COUNT)).toBe(true);
		expect(isBoundedCount(MAX_MUTATION_COUNT, MAX_MUTATION_COUNT)).toBe(true);
		expect(isBoundedCount(MAX_MUTATION_COUNT + 1, MAX_MUTATION_COUNT)).toBe(
			false,
		);
		expect(isBoundedCount(-1, MAX_MUTATION_COUNT)).toBe(false);
		expect(isBoundedCount(3.5, MAX_MUTATION_COUNT)).toBe(false);
		expect(isBoundedCount(Number.NaN, MAX_MUTATION_COUNT)).toBe(false);
		expect(isBoundedCount(Number.POSITIVE_INFINITY, MAX_MUTATION_COUNT)).toBe(
			false,
		);
		// Through the evidence validator: exact mutation details reject
		// fractional added/removed counts.
		const base = mutationDetails("m1", 1, 0);
		expect(isMutationMessageDetails({ ...base, added: 2.5 })).toBe(false);
		expect(isMutationMessageDetails({ ...base, removed: 1.5 })).toBe(false);
	});

	test("wide primitive tool args over the retained budget skip allocation", () => {
		const session = makeSession();
		session.hydrateBranch([
			{ type: "message", message: { role: "user", content: [] } },
			toolCallMessage("wide", "write", {
				values: Array.from({ length: 200_000 }, () => 7),
			}),
			toolCallMessage("small", "write", { values: [1, 2, 3] }),
			answerMessage(),
		]);
		expect(session.state("wide")).toBeUndefined();
		expect(session.state("small")?.args).toEqual({ values: [1, 2, 3] });
	});
});
