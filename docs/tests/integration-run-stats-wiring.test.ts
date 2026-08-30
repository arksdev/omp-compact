import { afterAll, expect } from "bun:test";
import { DEFAULT_SETTINGS } from "../../.omp-plugin/config";
import {
	addAnswer,
	addTool,
	assistant,
	assistantWithUsage,
	type BootedPlugin,
	beginRun,
	bootPlugin,
	bootWithStats,
	bootWithTranscript,
	cleanupGeneratedDirs,
	completeAnswer,
	dispatch,
	dispatchFireAndForget,
	finishRun,
	finishTool,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";
import type { TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

function statsEntries(
	booted: BootedPlugin,
): Array<{ customType: string; data: Record<string, unknown> }> {
	return booted.appendedEntries.filter(
		(entry) =>
			entry.customType === "omp-compact-stats" && entry.data !== undefined,
	) as Array<{ customType: string; data: Record<string, unknown> }>;
}

stockTest(
	"a failing stats append warns once across runs, never per run",
	async () => {
		// Stats are decoration: a persistence failure must not abort the run,
		// and it must not turn into a notification per run either. The value
		// under test is the deduplication — a broken host seam would
		// otherwise emit one warning for every completed run for the whole
		// session.
		//
		// appendEntry is failed only for the stats type: mutation and git
		// evidence are deliberately fail-closed, and a blanket throw would
		// exercise those paths instead of this one.
		let transcript: TranscriptInstance | undefined;
		const booted = await bootPlugin(
			(root, host) => {
				transcript = new host.TranscriptContainer();
				root.addChild(transcript);
			},
			"/tmp",
			[],
			false,
			{
				...DEFAULT_SETTINGS,
				mode: "live",
				stats: { ...DEFAULT_SETTINGS.stats, enabled: true, clock: false },
			},
			{
				piMutate: (pi) => {
					const original = pi.appendEntry as (
						customType: string,
						data?: unknown,
					) => void;
					pi.appendEntry = (customType: string, data?: unknown) => {
						if (customType === "omp-compact-stats") {
							throw new Error("stats sink unavailable");
						}
						original(customType, data);
					};
				},
			},
		);
		if (!transcript) throw new Error("transcript missing");
		const withTranscript = { ...booted, transcript };

		for (const [index, answer] of ["first", "second"].entries()) {
			await beginRun(withTranscript);
			addAnswer(withTranscript, answer);
			await completeAnswer(
				withTranscript,
				answer,
				{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
				1_700_000_000_500 + index,
			);
		}

		// The runs still complete and the answers still render.
		const rows = visibleRows(transcript).join("\n");
		expect(rows).toContain("first");
		expect(rows).toContain("second");
		// No stats evidence survived, and the pending entry was dropped
		// rather than left to place a row without persisted evidence.
		expect(statsEntries(booted)).toHaveLength(0);
		// Exactly one warning for two failures: the point of the warn-once.
		const warnings = booted.notifications.filter((message) =>
			message.includes("decorative-stats-failed"),
		);
		expect(warnings).toHaveLength(1);
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: message_end usage, action dedup and one evidence entry",
	async () => {
		const booted = await bootWithStats();
		await beginRun(booted);
		// two distinct executions; the second start redelivers the first id
		await addTool(booted, "bash", { command: "printf a" }, "bash-1");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "printf a" },
		});
		const call = await addTool(booted, "read", { path: "/tmp/a.ts" }, "read-2");
		await finishTool(booted, call, {
			toolCallId: "read-2",
			toolName: "read",
			result: { content: [{ type: "text", text: "src" }] },
			isError: false,
		});
		addAnswer(booted, "done");
		await completeAnswer(
			booted,
			"done",
			{ input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
			1_700_000_000_100,
		);
		const stats = statsEntries(booted);
		expect(stats).toHaveLength(1);
		expect(stats[0]?.data).toMatchObject({
			version: 1,
			actions: 2,
			sent: 100,
			received: 50,
			cacheRead: 200,
			cacheWrite: 30,
			hasError: false,
			messages: 1,
		});
		// the row renders above the answer
		const rows = visibleRows(booted.transcript);
		const line = rows.find((row) => row.includes("2 actions"));
		expect(line).toBeDefined();
		expect(rows.indexOf(line as string)).toBeLessThan(rows.indexOf("done"));
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: persists terminal evidence before async projection drains",
	async () => {
		const booted = await bootWithStats();
		await beginRun(booted);
		addAnswer(booted, "boundary");
		await dispatch(booted, {
			type: "message_end",
			message: assistantWithUsage(
				"boundary",
				{ input: 13, output: 8, cacheRead: 21, cacheWrite: 0 },
				1_700_000_000_150,
			),
		});

		const terminal = dispatchFireAndForget(booted, {
			type: "agent_end",
			messages: [assistant("boundary")],
			willContinue: false,
		});
		// Stock dispatch does not await extension listeners. Durable evidence
		// must already be an ancestor candidate before another user run can
		// enter the session tree; visual placement may still await audit drain.
		expect(statsEntries(booted)).toHaveLength(1);
		expect(statsEntries(booted)[0]?.data).toMatchObject({
			sent: 13,
			received: 8,
			messages: 1,
		});
		expect(
			visibleRows(booted.transcript).some((row) => row.includes("13 fresh")),
		).toBe(false);
		// A new agent_start may arrive before the async terminal projection.
		// It must not erase or reclassify run A's already-durable evidence.
		const nextRun = dispatchFireAndForget(booted, { type: "agent_start" });
		expect(statsEntries(booted)[0]?.data).toMatchObject({ sent: 13 });
		await nextRun;
		await terminal;
		expect(statsEntries(booted)).toHaveLength(1);
		expect(
			visibleRows(booted.transcript).some((row) => row.includes("13 fresh")),
		).toBe(true);
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: two distinct completions sum usage by message identity",
	async () => {
		const booted = await bootWithStats();
		await beginRun(booted);
		addAnswer(booted, "first");
		await completeAnswer(
			booted,
			"first",
			{ input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
			1_700_000_000_100,
		);
		await beginRun(booted);
		addAnswer(booted, "second");
		// a second, distinct completion with equal usage is NOT fingerprint-deduped
		await completeAnswer(
			booted,
			"second",
			{ input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
			1_700_000_000_200,
		);
		// two consecutive successful runs → two evidence entries
		const stats = statsEntries(booted);
		expect(stats).toHaveLength(2);
		expect(stats[0]?.data).toMatchObject({ messages: 1, sent: 100 });
		expect(stats[1]?.data).toMatchObject({ messages: 1, sent: 100 });
		await shutdown(booted);
	},
);

stockTest("stats wiring: message_end without usage is ignored", async () => {
	const booted = await bootWithStats();
	await beginRun(booted);
	addAnswer(booted, "no usage");
	// assistant completions without a usage record (advisor cards, malformed
	// events) must not count as aggregated messages
	await dispatch(booted, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "no usage" }],
			stopReason: "stop",
			timestamp: 1_700_000_000_350,
		},
	});
	await dispatch(booted, {
		type: "message_end",
		message: assistantWithUsage(
			"no usage",
			"garbage" as unknown as Record<string, number>,
			1_700_000_000_351,
		),
	});
	await finishRun(booted, "no usage");
	const stats = statsEntries(booted);
	expect(stats).toHaveLength(1);
	expect(stats[0]?.data).toMatchObject({ messages: 0, sent: 0 });
	await shutdown(booted);
});

// Zero-valued usage and duplicate-completion dedup are pure RunStats
// arithmetic, covered exactly at that seam by run-stats.test.ts:216 and
// :232. Re-asserting them through a booted host added no wiring evidence
// the test above does not already give.

stockTest(
	"stats wiring: no-tool clear answer still persists and renders the row",
	async () => {
		const booted = await bootWithStats("clear");
		await beginRun(booted);
		addAnswer(booted, "plain");
		await completeAnswer(
			booted,
			"plain",
			{ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
			1_700_000_000_300,
		);
		const stats = statsEntries(booted);
		expect(stats).toHaveLength(1);
		expect(stats[0]?.data).toMatchObject({ actions: 0, messages: 1, sent: 7 });
		const rows = visibleRows(booted.transcript);
		const line = rows.find((row) => row.includes("0 actions"));
		expect(line).toBeDefined();
		expect(rows.indexOf(line as string)).toBeLessThan(rows.indexOf("plain"));
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: aborted runs persist no stats and pollute no later run",
	async () => {
		const booted = await bootWithStats();
		await beginRun(booted);
		const call = await addTool(booted, "bash", { command: "false" }, "abort-1");
		await finishTool(booted, call, {
			toolCallId: "abort-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "boom" }] },
			isError: true,
		});
		addAnswer(booted, "");
		await dispatch(booted, {
			type: "message_end",
			message: assistantWithUsage("", undefined, 1_700_000_000_400, "aborted"),
		});
		await finishRun(booted, "", "aborted");
		// abort: no answer, no stats row/evidence
		expect(statsEntries(booted)).toEqual([]);
		// the next successful run starts clean: no aborted usage/actions leak
		await beginRun(booted);
		const call2 = await addTool(booted, "bash", { command: "true" }, "ok-2");
		await finishTool(booted, call2, {
			toolCallId: "ok-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "recovered");
		await completeAnswer(
			booted,
			"recovered",
			{ input: 11, output: 4, cacheRead: 0, cacheWrite: 0 },
			1_700_000_000_500,
		);
		const stats = statsEntries(booted);
		expect(stats).toHaveLength(1);
		expect(stats[0]?.data).toMatchObject({
			actions: 1,
			sent: 11,
			messages: 1,
			hasError: false,
		});
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: failed tool marks the row dirty without blocking it",
	async () => {
		const booted = await bootWithStats();
		await beginRun(booted);
		const call = await addTool(booted, "bash", { command: "false" }, "fail-1");
		await finishTool(booted, call, {
			toolCallId: "fail-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "boom" }] },
			isError: true,
		});
		addAnswer(booted, "still answered");
		await completeAnswer(
			booted,
			"still answered",
			{ input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
			1_700_000_000_600,
		);
		const stats = statsEntries(booted);
		expect(stats).toHaveLength(1);
		expect(stats[0]?.data).toMatchObject({ actions: 1, hasError: true });
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: disabled stats persist nothing even on success",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		addAnswer(booted, "quiet");
		await completeAnswer(
			booted,
			"quiet",
			{ input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
			1_700_000_000_700,
		);
		expect(booted.appendedEntries).toEqual([]);
		expect(visibleRows(booted.transcript).join("\n")).not.toContain(
			"actions ·",
		);
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: willContinue continuations produce one row at the answer",
	async () => {
		const booted = await bootWithStats();
		await beginRun(booted);
		await dispatch(booted, {
			type: "message_end",
			message: assistantWithUsage(
				"partial",
				{ input: 40, output: 20, cacheRead: 80, cacheWrite: 0 },
				1_700_000_000_800,
				"toolUse",
			),
		});
		await finishRun(booted, "partial", "toolUse", true);
		// continuation: same logical run keeps accumulating
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf cont" },
			"cont-1",
		);
		await finishTool(booted, call, {
			toolCallId: "cont-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "final");
		await completeAnswer(
			booted,
			"final",
			{ input: 60, output: 30, cacheRead: 120, cacheWrite: 0 },
			1_700_000_000_900,
		);
		const stats = statsEntries(booted);
		expect(stats).toHaveLength(1);
		expect(stats[0]?.data).toMatchObject({
			actions: 1,
			sent: 100,
			received: 50,
			cacheRead: 200,
			messages: 2,
		});
		await shutdown(booted);
	},
);
