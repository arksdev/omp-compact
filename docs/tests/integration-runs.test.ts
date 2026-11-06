/**
 * A logical run as the user watches it: calls across several responses,
 * the answer or an abort/error at its end, in each display mode, with
 * settings that change while it runs and tool ids that repeat.
 */
import { afterAll, expect, test } from "bun:test";

import {
	addBlock,
	beginRun,
	boot,
	type BootedPlugin,
	continueRun,
	dispatch,
	endRun,
	endTool,
	type Mode,
	renameBlock,
	rows,
	runTool,
	stockDescribe,
	textResult,
} from "./integration-kit";
import { cleanupStockSettings } from "./test-stock-host";

afterAll(() => {
	cleanupStockSettings();
});

const COMMIT = textResult(
	"[main abc1234] change\n 1 file changed, 1 insertion(+)",
);

const VIBE_LIST = {
	content: [{ type: "text", text: "- `audit-worker` [good] idle" }],
	details: {
		op: "list",
		screens: [
			{
				id: "audit-worker",
				cli: "good",
				state: "idle",
				model: "AuraPass/grok-4.5:medium",
				turns: 2,
				queued: 0,
				trace: [],
				outputTail: [],
				lastActivity: "Reported the registry diff",
				lastActivityAt: 1_000,
			},
		],
	},
};

/** Two responses: a grep and a commit, then another grep. */
async function twoResponses(mode: Mode) {
	const booted = await boot(mode);
	await beginRun(booted);
	await runTool(booted, "g1", "grep", { pattern: "first" });
	await runTool(
		booted,
		"b1",
		"bash",
		{ command: "git commit -m change" },
		COMMIT,
	);
	await continueRun(booted);
	await runTool(booted, "g2", "grep", { pattern: "second" });
	return booted;
}

/** Press the display-mode shortcut `times` times. */
async function cycleMode(booted: BootedPlugin, times: number) {
	const cycle = [...booted.shortcuts.values()][0];
	if (!cycle) throw new Error("cycle shortcut not registered");
	for (let press = 0; press < times; press++) await cycle(booted.context);
}

stockDescribe("a logical run", () => {
	test("live: every response's calls stay until the answer, then only the commit summary", async () => {
		const booted = await twoResponses("live");
		const working = rows(booted);
		expect(working).toContain("grep: first");
		expect(working).toContain("git commit abc1234 change");
		expect(working).toContain("grep: second");

		await endRun(booted);
		expect(rows(booted)).toBe("• git commit: abc1234");
	});

	test("compact keeps every response's calls after the answer", async () => {
		const booted = await twoResponses("compact");
		await endRun(booted);
		const text = rows(booted);
		expect(text).toContain("grep: first");
		expect(text).toContain("git commit abc1234 change");
		expect(text).toContain("grep: second");
	});

	test("clear shows nothing while working and only the commit summary after", async () => {
		const booted = await twoResponses("clear");
		expect(rows(booted)).toBe("");
		await endRun(booted);
		expect(rows(booted)).toBe("• git commit: abc1234");
	});

	for (const stop of ["aborted", "error"] as const) {
		test(`${stop}: live and compact keep the whole log, clear keeps only the commit`, async () => {
			for (const mode of ["live", "compact"] as const) {
				const booted = await twoResponses(mode);
				await endRun(booted, stop);
				const text = rows(booted);
				expect(text, mode).toContain("grep: first");
				expect(text, mode).toContain("git commit abc1234 change");
				expect(text, mode).toContain("grep: second");
			}
			const clear = await twoResponses("clear");
			await endRun(clear, stop);
			expect(rows(clear)).toBe("• git commit: abc1234");
		});
	}

	test("an answer with no visible text keeps the whole log", async () => {
		const booted = await twoResponses("live");
		await endRun(booted, "stop", "  ");
		expect(rows(booted)).toContain("grep: first");
	});

	test("a settings change mid-run applies from the next run", async () => {
		const booted = await boot("live");
		const cycle = [...booted.shortcuts.values()][0];
		if (!cycle) throw new Error("cycle shortcut not registered");
		await beginRun(booted);
		await runTool(booted, "g1", "grep", { pattern: "first" });
		// live -> clear
		await cycle(booted.context);
		await continueRun(booted);
		await runTool(booted, "g2", "grep", { pattern: "second" });
		// Still live: the continuation keeps the mode the run started with.
		expect(rows(booted)).toContain("grep: second");
		await endRun(booted);
		expect(rows(booted)).toBe("");

		// The next run is clear, so even its working rows stay hidden.
		await beginRun(booted);
		await runTool(booted, "g3", "grep", { pattern: "third" });
		expect(rows(booted)).toBe("");
	});

	test("turning the plugin off mid-run leaves the next run on omp's own cards", async () => {
		const booted = await boot("clear");
		const cycle = [...booted.shortcuts.values()][0];
		if (!cycle) throw new Error("cycle shortcut not registered");
		await beginRun(booted);
		// clear -> off
		await cycle(booted.context);
		await runTool(booted, "g1", "grep", { pattern: "first" });
		expect(rows(booted)).toBe("");
		await endRun(booted);

		await beginRun(booted);
		await runTool(booted, "g2", "grep", { pattern: "second" });
		await endRun(booted);
		// omp's full grep card, framed and multi-row.
		expect(rows(booted)).toContain("second");
		expect(rows(booted).split("\n").length).toBeGreaterThan(1);
	});

	test("a call streaming before its start event draws compact under its final id", async () => {
		const booted = await boot("live");
		await beginRun(booted);
		// The model streams the arguments before omp knows the call's id.
		const block = addBlock(booted, "", "bash", { command: "ls" });
		expect(rows(booted)).toBe("• bash: ls");
		block.updateArgs({ command: "ls -la" });
		renameBlock(block, "real-1");
		expect(rows(booted)).toBe("• bash: ls -la");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "real-1",
			toolName: "bash",
			args: { command: "ls -la" },
		});
		await endTool(booted, block, "real-1", "bash");
		expect(rows(booted)).toContain("bash: ls -la");
		await endRun(booted);
		expect(rows(booted)).toBe("");
	});

	test("a repeated tool id leaves a compact run's row in place when a live run reuses it", async () => {
		const booted = await boot("compact");
		await beginRun(booted);
		await runTool(booted, "call_0", "grep", { pattern: "first" });
		await endRun(booted);
		expect(rows(booted)).toBe("• grep: first");

		// compact -> live
		await cycleMode(booted, 1);
		await beginRun(booted);
		await runTool(booted, "call_0", "grep", { pattern: "second" });
		const working = rows(booted);
		expect(working).toContain("grep: first");
		expect(working).toContain("grep: second");
		await endRun(booted);
		expect(rows(booted)).toBe("• grep: first");
	});

	test("a repeated tool id keeps a live run's call hidden when a compact run reuses it", async () => {
		const booted = await boot("live");
		await beginRun(booted);
		await runTool(booted, "call_0", "grep", { pattern: "first" });
		await endRun(booted);
		expect(rows(booted)).toBe("");

		// live -> clear -> off -> compact
		await cycleMode(booted, 3);
		await beginRun(booted);
		await runTool(booted, "call_0", "grep", { pattern: "second" });
		expect(rows(booted)).toBe("• grep: second");
		await endRun(booted);
		expect(rows(booted)).toBe("• grep: second");
	});

	test("a repeated tool id tells blocks apart though omp adds the intent to a live block", async () => {
		const booted = await boot("compact");
		await beginRun(booted);
		await runTool(booted, "call_0", "grep", { pattern: "first" });
		await endRun(booted);
		await cycleMode(booted, 1);

		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "call_0",
			toolName: "grep",
			args: { pattern: "second" },
			intent: "Searching",
		});
		const block = addBlock(booted, "call_0", "grep", {
			pattern: "second",
			i: "Searching",
		});
		await endTool(booted, block, "call_0", "grep");
		await endRun(booted);
		expect(rows(booted)).toBe("• grep: first");
	});

	test("a tool's own `i` argument tells repeated ids apart", async () => {
		const booted = await boot("compact");
		await beginRun(booted);
		await runTool(booted, "call_0", "computer", { i: "first", code: "x" });
		await endRun(booted);
		await cycleMode(booted, 1);
		await beginRun(booted);
		await runTool(booted, "call_0", "computer", { i: "second", code: "x" });
		await endRun(booted);
		expect(rows(booted)).toContain("first");
		expect(rows(booted)).not.toContain("second");
	});

	test("calls repeating both id and arguments across runs draw as the newest", async () => {
		const booted = await boot("compact");
		await beginRun(booted);
		await runTool(booted, "call_0", "grep", { pattern: "same" });
		await endRun(booted);
		await cycleMode(booted, 1);
		await beginRun(booted);
		await runTool(booted, "call_0", "grep", { pattern: "same" });
		await endRun(booted);
		expect(rows(booted)).toBe("");
	});

	test("an unknown tool gets omp's one-row summary in every mode and phase", async () => {
		for (const mode of ["live", "compact", "clear"] as const) {
			const booted = await boot(mode);
			await beginRun(booted);
			await runTool(booted, "u1", "brand_new_tool", { target: "x" });
			const working = rows(booted);
			expect(working.split("\n"), mode).toHaveLength(1);
			expect(working.toLowerCase(), mode).toContain("brand");
			await endRun(booted);
			expect(rows(booted), mode).toBe(working);
		}
	});

	test("an expanded block draws omp's full card, hidden calls included", async () => {
		const booted = await boot("live");
		await beginRun(booted);
		const shown = await runTool(booted, "g1", "grep", { pattern: "first" });
		await endRun(booted);
		expect(rows(booted)).toBe("");
		// Ctrl+O on a call the answer hid.
		shown.setExpanded(true);
		const expanded = rows(booted);
		expect(expanded).toContain("first");
		expect(expanded).not.toContain("• grep: first");
	});

	test("vibe workers draw as the plugin's rows, or omp's card with compactVibeRows off", async () => {
		const compactRows = await boot("live");
		await beginRun(compactRows);
		const list = await runTool(compactRows, "v1", "vibe_list", {}, VIBE_LIST);
		expect(rows(compactRows)).toBe(
			"• vibe sessions 1\n  ∷ ⟦g⟧ audit-worker 2t grok-4.5 Reported the registry diff",
		);
		// Expanded, even a tool that used to stay compact draws omp's card.
		list.setExpanded(true);
		expect(rows(compactRows)).not.toContain("vibe sessions 1");

		const stock = await boot("live", { settings: { compactVibeRows: false } });
		await beginRun(stock);
		await runTool(stock, "v1", "vibe_list", {}, VIBE_LIST);
		expect(rows(stock)).not.toContain("vibe sessions 1");
		expect(rows(stock)).toContain("audit-worker");
	});
});
