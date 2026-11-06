/**
 * The stats row under the answer: sent once the session is idle, one per
 * answered run even when the next run starts first, and the click in Tern
 * that brings back the calls its own run hid.
 */
import { afterAll, afterEach, beforeEach, expect, jest, test } from "bun:test";

import { STATS_MESSAGE_TYPE } from "../../.omp-plugin/run-stats";
import {
	assistant,
	beginRun,
	boot,
	type BootedPlugin,
	clickStatsRow,
	continueRun,
	dispatch,
	endRun,
	rows,
	runTool,
	statsRows,
	stockDescribe,
} from "./integration-kit";
import { cleanupStockSettings } from "./test-stock-host";

afterAll(() => {
	cleanupStockSettings();
});

// The idle wait polls on a timer; the clock is driven, never waited on.
beforeEach(() => {
	jest.useFakeTimers();
});
afterEach(() => {
	jest.useRealTimers();
});

function waitForIdlePoll(): void {
	jest.advanceTimersByTime(200);
}

function usage(booted: BootedPlugin, input: number): Promise<void> {
	return dispatch(booted, {
		type: "message_end",
		message: assistant("", "toolUse", {
			input,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
		}),
	});
}

function statsSent(booted: BootedPlugin) {
	return booted.sentMessages.filter(
		({ message }) => message.customType === STATS_MESSAGE_TYPE,
	);
}

stockDescribe("the stats row", () => {
	test("waits for idle, and an overlapping next run gets its own row after it", async () => {
		const booted = await boot("live", { stats: true });
		let idle = false;
		booted.context.isIdle = () => idle;

		await beginRun(booted);
		await runTool(booted, "g1", "grep", { pattern: "first" });
		await usage(booted, 100);
		await endRun(booted);
		waitForIdlePoll();
		expect(statsSent(booted)).toEqual([]);

		// The next prompt starts before the session ever reported idle.
		await beginRun(booted);
		await runTool(booted, "g2", "grep", { pattern: "second" });
		await usage(booted, 200);
		waitForIdlePoll();
		expect(statsSent(booted)).toEqual([]);
		await endRun(booted);

		idle = true;
		waitForIdlePoll();
		const [first, second] = statsSent(booted);
		expect(statsSent(booted)).toHaveLength(2);
		expect(first?.options).toEqual({ deliverAs: "nextTurn" });
		expect(statsRows(booted)[0]).toContain("100");
		expect(statsRows(booted)[1]).toContain("200");

		// Each row reveals only its own run's calls.
		expect(rows(booted)).toBe("");
		expect(clickStatsRow(booted, first?.message.details)).toBe(true);
		expect(rows(booted)).toContain("grep: first");
		expect(rows(booted)).not.toContain("grep: second");
		expect(clickStatsRow(booted, second?.message.details)).toBe(true);
		expect(rows(booted)).toContain("grep: second");
		expect(clickStatsRow(booted, first?.message.details)).toBe(true);
		expect(rows(booted)).not.toContain("grep: first");
	});

	test("each row reveals its own run's call when the runs repeat a tool id", async () => {
		const booted = await boot("live", { stats: true });
		booted.context.isIdle = () => true;
		for (const [pattern, tokens] of [
			["first", 100],
			["second", 200],
		] as const) {
			await beginRun(booted);
			await runTool(booted, "call_0", "grep", { pattern });
			await usage(booted, tokens);
			await endRun(booted);
			waitForIdlePoll();
		}
		const [first, second] = statsSent(booted);
		expect(rows(booted)).toBe("");
		expect(clickStatsRow(booted, first?.message.details)).toBe(true);
		expect(rows(booted)).toBe("• grep: first");
		expect(clickStatsRow(booted, second?.message.details)).toBe(true);
		expect(rows(booted)).toContain("grep: second");
		expect(clickStatsRow(booted, first?.message.details)).toBe(true);
		expect(rows(booted)).toBe("• grep: second");
	});

	for (const type of [
		"session_before_switch",
		"session_before_tree",
		"session_before_branch",
	]) {
		test(`${type} drops a row still waiting for idle`, async () => {
			const booted = await boot("live", { stats: true });
			let idle = false;
			booted.context.isIdle = () => idle;
			await beginRun(booted);
			await runTool(booted, "g1", "grep", { pattern: "first" });
			await usage(booted, 100);
			await endRun(booted);
			await dispatch(booted, { type });
			idle = true;
			waitForIdlePoll();
			expect(statsSent(booted)).toEqual([]);
		});
	}

	test("a drain that resolves after the session ended queues no row", async () => {
		const booted = await boot("live", { stats: true });
		booted.context.isIdle = () => true;
		await beginRun(booted);
		await runTool(booted, "g1", "grep", { pattern: "first" });
		await usage(booted, 100);
		const ended = endRun(booted);
		await dispatch(booted, { type: "session_shutdown" });
		await ended;
		waitForIdlePoll();
		expect(statsSent(booted)).toEqual([]);
	});

	test("the evidence names one of its run's calls", async () => {
		const booted = await boot("live", { stats: true });
		booted.context.isIdle = () => true;
		await beginRun(booted);
		await runTool(booted, "g1", "grep", { pattern: "first" });
		await usage(booted, 100);
		await endRun(booted);
		waitForIdlePoll();
		const [sent] = statsSent(booted);
		expect(sent?.message.details).toMatchObject({ anchorToolCallId: "g1" });
	});

	test("one row per logical run, summed across its responses", async () => {
		const booted = await boot("live", { stats: true });
		await beginRun(booted);
		await runTool(booted, "g1", "grep", { pattern: "first" });
		await usage(booted, 100);
		await continueRun(booted);
		await runTool(booted, "g2", "grep", { pattern: "second" });
		await usage(booted, 23);
		await endRun(booted);
		waitForIdlePoll();
		expect(statsSent(booted)).toHaveLength(1);
		expect(statsRows(booted)[0]).toContain("2 actions");
		expect(statsRows(booted)[0]).toContain("123");
	});

	test("an aborted run sends no row and leaves nothing to the next one", async () => {
		const booted = await boot("live", { stats: true });
		await beginRun(booted);
		await runTool(booted, "g1", "grep", { pattern: "first" });
		await usage(booted, 100);
		await endRun(booted, "aborted");
		waitForIdlePoll();
		expect(statsSent(booted)).toEqual([]);

		await beginRun(booted);
		await usage(booted, 7);
		await endRun(booted);
		waitForIdlePoll();
		expect(statsSent(booted)).toHaveLength(1);
		expect(statsRows(booted)[0]).not.toContain("107");
	});

	test("a run that hid nothing offers no click", async () => {
		const booted = await boot("compact", { stats: true });
		await beginRun(booted);
		await runTool(booted, "g1", "grep", { pattern: "first" });
		await usage(booted, 100);
		await endRun(booted);
		waitForIdlePoll();
		const [sent] = statsSent(booted);
		expect(clickStatsRow(booted, sent?.message.details)).toBe(false);
	});

	test("stats off sends nothing", async () => {
		const booted = await boot("live", { stats: false });
		await beginRun(booted);
		await usage(booted, 100);
		await endRun(booted);
		waitForIdlePoll();
		expect(booted.sentMessages).toEqual([]);
	});

	test("an answer without tool calls still gets its row in clear", async () => {
		const booted = await boot("clear", { stats: true });
		await beginRun(booted);
		await usage(booted, 42);
		await endRun(booted);
		waitForIdlePoll();
		expect(statsSent(booted)).toHaveLength(1);
		expect(statsRows(booted)[0]).toContain("42");
	});
});
