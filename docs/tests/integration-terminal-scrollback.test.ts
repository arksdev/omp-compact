import { afterAll, expect } from "bun:test";
import {
	addAnswer,
	addTool,
	assistant,
	beginRun,
	bootForRebuild,
	bootWithStats,
	type CommittedSeamTranscript,
	cleanupGeneratedDirs,
	completeAnswer,
	dispatch,
	finishRun,
	finishTool,
	rebuildHarness,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";
import type { TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

/**
 * Retires every settled block into terminal history, the way the real
 * terminal does: 18.0.1 offers a batch only under viewport pressure, so the
 * one-row window below forces the offer, and the acknowledgement is what
 * makes those rows immutable history.
 */
function commitTerminalHistory(
	transcript: TranscriptInstance,
	width = 120,
): boolean {
	const host = transcript as CommittedSeamTranscript;
	const batch = host.peekFinalizedBatch?.(width, 1);
	if (!batch) return false;
	host.acknowledgeFinalizedBatch?.(batch.id);
	return true;
}

// ---------------------------------------------------------------------------
// D03 terminal scrollback replay: the terminal retires settled rows into
// immutable history, so a later projection change could never take them off
// the screen again. After the terminal projection and the stats carrier
// insertion attempt, the adapter replays the full presentation exactly once
// through the capability-checked exact-root `resetDisplay` — but only when
// the fold owns rows that already retired (block state `committed`). No
// committed rows, compact/full terminal paths, aborts, continuations,
// missing capability and disposed adapters all stay no-op/native. Tests
// assert observable rows and reset counts — never private maps.
// ---------------------------------------------------------------------------

stockTest(
	"D03: a committed filtered run replays terminal scrollback exactly once after stats insertion",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		// First run: it ends, its carrier settles, and the terminal retires the
		// rows into immutable history — the real path to committed rows.
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf history" },
			"d03-history",
		);
		await finishTool(booted, first, {
			toolCallId: "d03-history",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "d03 first");
		await completeAnswer(booted, "d03 first");
		// Nothing had retired yet, so that terminal answer replayed nothing.
		expect(booted.harness.resetCalls).toBe(0);
		expect(commitTerminalHistory(booted.transcript)).toBe(true);
		// Second run over immutable history: its terminal projection changes
		// rows the terminal can no longer reach, so the adapter replays.
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf scrollback" },
			"d03-bash",
		);
		await finishTool(booted, call, {
			toolCallId: "d03-bash",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(visibleRows(booted.transcript).length).toBeGreaterThan(0);
		// no replay before the terminal answer
		expect(booted.harness.resetCalls).toBe(0);
		addAnswer(booted, "d03 done");
		await completeAnswer(booted, "d03 done");
		// exactly one replay, after the stats carrier insertion: the stats
		// row renders directly above the answer
		expect(booted.harness.resetCalls).toBe(1);
		const rows = visibleRows(booted.transcript);
		const statsRow = rows.find((row) => row.includes("1 actions"));
		expect(statsRow).toBeDefined();
		expect(rows.indexOf(statsRow as string)).toBeLessThan(
			rows.indexOf("d03 done"),
		);
		await shutdown(booted);
	},
);

stockTest(
	"D03: a filtered run without committed rows never replays",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf uncommitted" },
			"d03-uncommitted",
		);
		await finishTool(booted, call, {
			toolCallId: "d03-uncommitted",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		// the run stays in the live region: nothing was declared committed
		expect(visibleRows(booted.transcript).length).toBeGreaterThan(0);
		expect(booted.harness.resetCalls).toBe(0);
		addAnswer(booted, "uncommitted done");
		await completeAnswer(booted, "uncommitted done");
		// the terminal seam still ran (stats inserted), but the missing
		// committed declaration keeps the replay a no-op
		expect(booted.harness.resetCalls).toBe(0);
		expect(
			visibleRows(booted.transcript).some((row) => row.includes("1 actions")),
		).toBe(true);
		await shutdown(booted);
	},
);

stockTest(
	"D03: a long answer whose rows already streamed out replays them",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		// The case from the field: one long streamed answer, no tool use. The
		// container publishes its prefix into scrollback row by row while the
		// block itself stays live, so no carrier ever retires — yet most of the
		// answer is already written out above the viewport.
		await beginRun(booted);
		// An append-only answer: the container publishes stable rows as they
		// arrive and streams them out one per frame.
		const rows = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
		booted.transcript.addChild({
			transcriptBlockMode: "appendOnly",
			render: () => rows,
			getTranscriptStableRows: () => rows.map((_, index) => ({ id: index })),
			renderTranscriptStableRows: (count: number) => rows.slice(0, count),
			isTranscriptBlockFinalized: () => false,
			isDisplaceableBlock: () => false,
			setTranscriptAllocation: () => {},
			seal: () => {},
		});
		booted.transcript.renderViewport(120, 4, { tick: 0, now: 0 });
		const batch = booted.transcript.peekFinalizedBatch(120, 4);
		expect(batch).toBeDefined();
		booted.transcript.acknowledgeFinalizedBatch((batch as { id: number }).id);
		expect(
			booted.transcript.blockStates().every((state) => state !== "committed"),
		).toBe(true);
		expect(booted.harness.resetCalls).toBe(0);
		await completeAnswer(booted, "a long answer");
		// Those emitted rows are frozen native output, so the finished answer
		// gets its one replay and becomes reachable from its first line.
		expect(booted.harness.resetCalls).toBe(1);
		await shutdown(booted);
	},
);

stockTest(
	"D03: compact-mode terminal runs (full retained log) never replay",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("compact", harness);
		// A first run retires into history, so committed rows really exist.
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf compact history" },
			"d03-compact-history",
		);
		await finishTool(booted, first, {
			toolCallId: "d03-compact-history",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "compact first");
		await completeAnswer(booted, "compact first");
		expect(commitTerminalHistory(booted.transcript)).toBe(true);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf compact" },
			"d03-compact",
		);
		await finishTool(booted, call, {
			toolCallId: "d03-compact",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "compact done");
		await completeAnswer(booted, "compact done");
		// the full retained log settles as "full": committed rows exist but
		// the terminal projection never changed, so no replay
		expect(booted.harness.resetCalls).toBe(0);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"printf compact",
		);
		await shutdown(booted);
	},
);

stockTest(
	"D03: abort, continuation and disposed adapters never replay",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		// Retire a first run into history so the abort below really happens
		// over immutable rows.
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf abort history" },
			"d03-abort-history",
		);
		await finishTool(booted, first, {
			toolCallId: "d03-abort-history",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "abort first");
		await completeAnswer(booted, "abort first");
		expect(commitTerminalHistory(booted.transcript)).toBe(true);
		expect(booted.harness.resetCalls).toBe(0);
		await beginRun(booted);

		const call = await addTool(
			booted,
			"bash",
			{ command: "printf abort" },
			"d03-abort",
		);
		await finishTool(booted, call, {
			toolCallId: "d03-abort",
			toolName: "bash",
			result: { content: [{ type: "text", text: "failed" }] },
			isError: true,
		});
		expect(visibleRows(booted.transcript).length).toBeGreaterThan(0);
		// continuation: willContinue never fires the terminal seam
		await finishRun(booted, "continue text", "toolUse", true);
		expect(booted.harness.resetCalls).toBe(0);
		// abort/error finalization: the full log path never replays
		await finishRun(booted, "", "aborted");
		expect(booted.harness.resetCalls).toBe(0);
		// dispose: a late terminal event after shutdown touches no adapter
		await shutdown(booted);
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("late done")],
			willContinue: false,
		});
		expect(booted.harness.resetCalls).toBe(0);
	},
);

stockTest(
	"D03: a committed filtered run without the exact-root resetDisplay stays native",
	async () => {
		// standard boot: the host root has no resetDisplay capability
		const booted = await bootWithStats();
		// Retire a first run into history: committed rows exist, only the
		// capability is missing.
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf nocap history" },
			"d03-nocap-history",
		);
		await finishTool(booted, first, {
			toolCallId: "d03-nocap-history",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "nocap first");
		await completeAnswer(booted, "nocap first");
		expect(commitTerminalHistory(booted.transcript)).toBe(true);
		await beginRun(booted);

		const call = await addTool(
			booted,
			"bash",
			{ command: "printf nocap" },
			"d03-nocap",
		);
		await finishTool(booted, call, {
			toolCallId: "d03-nocap",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(visibleRows(booted.transcript).length).toBeGreaterThan(0);
		addAnswer(booted, "nocap done");
		await completeAnswer(booted, "nocap done");
		// capability missing: the replay fails open and the projection with
		// the stats row stays observable
		const rows = visibleRows(booted.transcript);
		expect(rows.some((row) => row.includes("1 actions"))).toBe(true);
		expect(rows).toContain("nocap done");
		await shutdown(booted);
	},
);
