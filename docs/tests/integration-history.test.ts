/**
 * History omp draws again: a resumed session, `/tree` and `/branch`
 * navigation. The plugin knows those calls only from the session branch,
 * walked once per branch, including entries older plugin and omp versions
 * wrote.
 */
import { afterAll, expect, test } from "bun:test";

import {
	GIT_MESSAGE_TYPE,
	MUTATION_MESSAGE_TYPE,
} from "../../.omp-plugin/messages";
import { STATS_MESSAGE_TYPE } from "../../.omp-plugin/run-stats";
import {
	addBlock,
	assistant,
	clickStatsRow,
	beginRun,
	boot,
	type BootedPlugin,
	dispatch,
	endRun,
	rows,
	runTool,
	stockDescribe,
	textResult,
} from "./integration-kit";
import { cleanupStockSettings } from "./test-stock-host";

afterAll(() => {
	cleanupStockSettings();
});

const user = { type: "message", message: { role: "user", content: "go" } };

function toolCall(id: string, name: string, args: unknown) {
	return {
		type: "message",
		message: {
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id, name, arguments: args }],
		},
	};
}

function toolResult(id: string) {
	return { type: "message", message: { role: "toolResult", toolCallId: id } };
}

/** How omp's sessions before 18 recorded a call. */
function legacyStart(id: string, name: string, args: unknown) {
	return {
		type: "custom",
		customType: "tool_execution_start",
		data: { toolCallId: id, toolName: name, args },
	};
}

const mutation = {
	version: 1,
	toolCallId: "w1",
	toolName: "write",
	path: "notes.txt",
	added: 3,
	removed: 0,
	exact: true,
};

const git = {
	version: 1,
	toolCallId: "b1",
	subcommand: "commit",
	text: "git commit abc1234 change",
	isError: false,
	records: [
		{ subcommand: "commit", text: "git commit abc1234 change", isError: false },
	],
};

const stats = {
	version: 1,
	runId: "omp-compact-run-old",
	actions: 3,
	sent: 10,
	received: 5,
	cacheRead: 0,
	cacheWrite: 0,
	hitRate: 0,
	durationMs: 1000,
	hasError: false,
	messages: 1,
	completedAt: 1000,
};

const ARGS = {
	g1: { pattern: "needle" },
	w1: { path: "notes.txt", content: "a\nb\nc\n" },
	b1: { command: "git commit -m change" },
} as const;

/** One answered run: a grep, a write and a commit, as the plugin persisted them. */
function answeredRun(): unknown[] {
	return [
		user,
		toolCall("g1", "grep", ARGS.g1),
		toolResult("g1"),
		toolCall("w1", "write", ARGS.w1),
		toolResult("w1"),
		{ type: "custom", customType: MUTATION_MESSAGE_TYPE, data: mutation },
		toolCall("b1", "bash", ARGS.b1),
		toolResult("b1"),
		{ type: "custom", customType: GIT_MESSAGE_TYPE, data: git },
		{ type: "message", message: assistant("done") },
		{ type: "custom_message", customType: STATS_MESSAGE_TYPE, details: stats },
	];
}

/** The same run as 1.x plugins on older omp wrote it. */
function legacyRun(): unknown[] {
	const { records: _records, ...singleRecordGit } = git;
	return [
		user,
		legacyStart("g1", "grep", ARGS.g1),
		toolResult("g1"),
		legacyStart("w1", "write", ARGS.w1),
		toolResult("w1"),
		{
			type: "custom_message",
			customType: MUTATION_MESSAGE_TYPE,
			details: mutation,
		},
		legacyStart("b1", "bash", ARGS.b1),
		toolResult("b1"),
		{
			type: "custom_message",
			customType: GIT_MESSAGE_TYPE,
			details: singleRecordGit,
		},
		{ type: "message", message: assistant("done") },
	];
}

/** omp drawing the restored calls, as a resume does. */
function drawHistory(booted: BootedPlugin): void {
	for (const [id, name] of [
		["g1", "grep"],
		["w1", "write"],
		["b1", "bash"],
	] as const) {
		const block = addBlock(booted, id, name, ARGS[id]);
		block.updateResult({ ...textResult("ok"), isError: false }, false, id);
	}
}

async function resumed(mode: "live" | "compact" | "clear", branch: unknown[]) {
	const booted = await boot(mode, { branch });
	drawHistory(booted);
	return rows(booted);
}

stockDescribe("history", () => {
	for (const [label, branch] of [
		["a resumed session", answeredRun],
		["a session older versions wrote", legacyRun],
	] as const) {
		test(`${label} follows the current mode`, async () => {
			const live = await resumed("live", branch());
			expect(live).not.toContain("grep: needle");
			expect(live).toContain("notes.txt");
			expect(live).toContain("+3");
			expect(live).toContain("abc1234");

			const compact = await resumed("compact", branch());
			expect(compact).toContain("grep: needle");
			expect(compact).toContain("notes.txt");
			expect(compact).toContain("git commit abc1234 change");

			expect(await resumed("clear", branch())).toBe("• git commit: abc1234");
		});
	}

	test("a restored run that never answered keeps its whole log", async () => {
		const branch = answeredRun().slice(0, 3);
		const booted = await boot("live", { branch });
		const block = addBlock(booted, "g1", "grep", ARGS.g1);
		block.updateResult({ ...textResult("ok"), isError: false }, false, "g1");
		expect(rows(booted)).toContain("grep: needle");
	});

	test("the restored stats row still shows the calls its run hid", async () => {
		const booted = await boot("live", { branch: answeredRun(), stats: true });
		drawHistory(booted);
		expect(rows(booted)).not.toContain("grep: needle");
		expect(clickStatsRow(booted, stats)).toBe(true);
		expect(rows(booted)).toContain("grep: needle");
	});

	test("/tree walks the new branch and draws it under the current mode", async () => {
		const booted = await boot("compact");
		const cycle = [...booted.shortcuts.values()][0];
		if (!cycle) throw new Error("cycle shortcut not registered");
		await beginRun(booted);
		await runTool(booted, "g1", "grep", ARGS.g1);
		await endRun(booted);
		expect(rows(booted)).toContain("grep: needle");

		// compact -> live, then navigate: omp rebuilds the transcript and the
		// walk restores the run from the branch under the mode chosen now.
		await cycle(booted.context);
		booted.branch.push(
			user,
			toolCall("g1", "grep", ARGS.g1),
			toolResult("g1"),
			{ type: "message", message: assistant("done") },
		);
		await dispatch(booted, { type: "session_tree" });
		booted.transcript.clear();
		const block = addBlock(booted, "g1", "grep", ARGS.g1);
		block.updateResult({ ...textResult("ok"), isError: false }, false, "g1");
		expect(rows(booted)).toBe("");
	});

	test("stats that landed after the next answer reveal their own run", async () => {
		const answered = (id: string, pattern: string) => [
			user,
			toolCall(id, "grep", { pattern }),
			toolResult(id),
			{ type: "message", message: assistant("done") },
		];
		const delayed = {
			...stats,
			runId: "omp-compact-run-1",
			anchorToolCallId: "g1",
		};
		const next = {
			...stats,
			runId: "omp-compact-run-2",
			anchorToolCallId: "g2",
		};
		const message = (details: unknown) => ({
			type: "custom_message",
			customType: STATS_MESSAGE_TYPE,
			details,
		});
		const booted = await boot("live", {
			stats: true,
			branch: [
				...answered("g1", "first"),
				...answered("g2", "second"),
				message(delayed),
				message(next),
			],
		});
		for (const [id, pattern] of [
			["g1", "first"],
			["g2", "second"],
		] as const) {
			const block = addBlock(booted, id, "grep", { pattern });
			block.updateResult({ ...textResult("ok"), isError: false }, false, id);
		}
		expect(rows(booted)).toBe("");
		expect(clickStatsRow(booted, delayed)).toBe(true);
		expect(rows(booted)).toBe("• grep: first");
		expect(clickStatsRow(booted, delayed)).toBe(true);
		expect(clickStatsRow(booted, next)).toBe(true);
		expect(rows(booted)).toBe("• grep: second");
	});

	test("a tool id repeated in history draws each run's own call", async () => {
		const first = { pattern: "first" };
		const second = { pattern: "second" };
		const booted = await boot("live", {
			branch: [
				user,
				toolCall("call_0", "grep", first),
				toolResult("call_0"),
				{ type: "message", message: assistant("done") },
				user,
				toolCall("call_0", "grep", second),
				toolResult("call_0"),
			],
		});
		for (const args of [first, second]) {
			const block = addBlock(booted, "call_0", "grep", args);
			block.updateResult(
				{ ...textResult("ok"), isError: false },
				false,
				"call_0",
			);
		}
		// The answered run hid its call; the unanswered one keeps its log.
		expect(rows(booted)).toBe("• grep: second");
	});

	test("/tree during a run keeps both the open run's call and the earlier one a repeated id names", async () => {
		const booted = await boot("live");
		const first = { pattern: "first" };
		const second = { pattern: "second" };
		await beginRun(booted);
		await runTool(booted, "call_0", "grep", second);
		booted.branch.push(
			user,
			toolCall("call_0", "grep", first),
			toolResult("call_0"),
			{ type: "message", message: assistant("done") },
			user,
			toolCall("call_0", "grep", second),
			toolResult("call_0"),
		);
		await dispatch(booted, { type: "session_tree" });
		const earlier = addBlock(booted, "call_0", "grep", first);
		earlier.updateResult(
			{ ...textResult("ok"), isError: false },
			false,
			"call_0",
		);
		// The earlier run answered, so its call stays hidden; the open run's
		// call is not doubled by the walk and its run still settles it.
		expect(rows(booted)).toBe("• grep: second");
		await endRun(booted);
		expect(rows(booted)).toBe("");
	});

	test("a call that arrives with no run open keeps its row", async () => {
		const booted = await boot("live", { branch: answeredRun() });
		const block = addBlock(booted, "stray", "grep", { pattern: "stray" });
		block.updateResult({ ...textResult("ok"), isError: false }, false, "stray");
		// No run is open: the call keeps its row rather than vanishing.
		expect(rows(booted)).toContain("grep: stray");
	});
});
