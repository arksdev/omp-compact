import { afterAll, expect } from "bun:test";
import {
	addAnswer,
	addTool,
	beginRun,
	bootWithMode,
	cleanupGeneratedDirs,
	dispatch,
	finishRun,
	finishTool,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";

afterAll(cleanupGeneratedDirs);

stockTest(
	"compact mode keeps the entire compact tool log at terminal",
	async () => {
		const booted = await bootWithMode("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf compact-kept" },
			"bash-compact",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-compact",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf compact-kept",
		);
		addAnswer(booted, "compact done");
		await finishRun(booted, "compact done");
		const terminalRows = visibleRows(booted.transcript).join("\n");
		// the full compact log survives the successful terminal finalization
		expect(terminalRows).toContain("bash: printf compact-kept");
		// no duplicate aggregate projections on top of the kept log
		expect(terminalRows).not.toContain("git commit:");
		await shutdown(booted);
	},
);

stockTest(
	"compact mode keeps read and git rows at terminal (live filters them)",
	async () => {
		const booted = await bootWithMode("compact");
		await beginRun(booted);
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/keep.ts" }, "read-c");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-c",
			toolName: "read",
			args: { path: "src/keep.ts" },
		});
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-c",
			toolName: "read",
			result: { content: [{ type: "text", text: "src" }] },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "src" }] },
			false,
			"read-c",
		);
		const git = await addTool(
			booted,
			"bash",
			{ command: "git status --short" },
			"git-c",
		);
		await finishTool(booted, git, {
			toolCallId: "git-c",
			toolName: "bash",
			result: { content: [{ type: "text", text: " M src/keep.ts" }] },
			isError: false,
		});
		addAnswer(booted, "compact read done");
		await finishRun(booted, "compact read done");
		const terminalRows = visibleRows(booted.transcript).join("\n");
		expect(terminalRows).toContain("read src/keep.ts");
		expect(terminalRows).toContain("git status --short");
		await shutdown(booted);
	},
);

stockTest("clear mode hides routine tools including task", async () => {
	const booted = await bootWithMode("clear");
	await beginRun(booted);
	const call = await addTool(
		booted,
		"bash",
		{ command: "printf clear-hidden" },
		"bash-clear",
	);
	await finishTool(booted, call, {
		toolCallId: "bash-clear",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	const task = await addTool(
		booted,
		"task",
		{ description: "subagent work" },
		"task-clear",
	);
	await finishTool(booted, task, {
		toolCallId: "task-clear",
		toolName: "task",
		result: { content: [{ type: "text", text: "done" }] },
		isError: false,
	});
	// Clear mode hides compact routine rows while preserving the native
	// renderer only for genuinely interactive controls.
	const liveRows = visibleRows(booted.transcript).join("\n");
	expect(liveRows).not.toContain("clear-hidden");
	expect(liveRows).not.toContain("task: description: subagent work");
	addAnswer(booted, "clear done");
	await finishRun(booted, "clear done");
	const terminalRows = visibleRows(booted.transcript).join("\n");
	expect(terminalRows).not.toContain("clear-hidden");
	expect(terminalRows).not.toContain("subagent work");
	expect(terminalRows).toContain("clear done");
	await shutdown(booted);
});

stockTest("clear mode abort hides diagnostic rows", async () => {
	// The quiet view stays quiet through an interrupted turn: routine rows go
	// even though the run ended without an answer.
	const booted = await bootWithMode("clear");
	await beginRun(booted);
	const call = await addTool(
		booted,
		"bash",
		{ command: "printf clear-diag" },
		"bash-diag",
	);
	await finishTool(booted, call, {
		toolCallId: "bash-diag",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	await finishRun(booted, "", "aborted");
	expect(visibleRows(booted.transcript).join("\n")).not.toContain(
		"bash: printf clear-diag",
	);
	await shutdown(booted);
});

stockTest(
	"clear mode keeps unknown tool components native in every phase",
	async () => {
		const booted = await bootWithMode("clear");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"future_tool",
			{ query: "clear fail-open" },
			"unknown-clear",
		);
		call.render = () => ["native-clear-unknown"];
		await finishTool(booted, call, {
			toolCallId: "unknown-clear",
			toolName: "future_tool",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		// `clear` hides routine rows but must never hide an unknown tool
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"native-clear-unknown",
		);
		await finishRun(booted, "", "aborted");
		// abort diagnostics keep the unknown tool's native surface too
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"native-clear-unknown",
		);
		await shutdown(booted);
	},
);

stockTest(
	"clear mode abort hides the task row without going native",
	async () => {
		// Neither the compact row nor the stock card may come back on abort.
		const booted = await bootWithMode("clear");
		await beginRun(booted);
		const task = await addTool(
			booted,
			"task",
			{ description: "subagent diagnostics" },
			"task-clear-abort",
		);
		task.render = () => ["native-task-abort"];
		await finishTool(booted, task, {
			toolCallId: "task-clear-abort",
			toolName: "task",
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});
		await finishRun(booted, "", "aborted");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("task: description: subagent diagnostics");
		expect(rows).not.toContain("native-task-abort");
		await shutdown(booted);
	},
);

stockTest(
	"retainGitLive=false suppresses Git rows and the commit summary",
	async () => {
		const booted = await bootWithMode("live", { retainGitLive: false });
		await beginRun(booted);
		const commit = await addTool(
			booted,
			"bash",
			{ command: "git commit -m 'Hide me'" },
			"git-hidden",
		);
		await finishTool(booted, commit, {
			toolCallId: "git-hidden",
			toolName: "bash",
			result: { content: [{ type: "text", text: "[main abc1234] Hide me" }] },
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).not.toContain(
			"git commit abc1234 Hide me",
		);
		addAnswer(booted, "hidden commit done");
		await finishRun(booted, "hidden commit done");
		const terminalRows = visibleRows(booted.transcript).join("\n");
		expect(terminalRows).not.toContain("git commit:");
		// evidence is never mutated by the visual toggle
		const gitEntries = booted.appendedEntries.filter(
			(entry) => entry.customType === "omp-compact-git",
		);
		expect(gitEntries).toHaveLength(1);
		expect(gitEntries[0]).toMatchObject({
			data: { toolCallId: "git-hidden", text: "git commit abc1234 Hide me" },
		});
		await shutdown(booted);
	},
);

stockTest(
	"a git tool call whose command is not a string produces no git evidence",
	async () => {
		// Two independent barriers keep host-shaped args out of persisted
		// evidence: the start-side type check before startSync, and
		// pendingGitFrom on the end side. Either one alone suffices, which is
		// why weakening just one keeps this test green — the contract under
		// test is that no coercing path exists at all, so the payload below
		// is one whose String() form would parse as a real commit.
		const booted = await bootWithMode("live");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			// Structurally present, wrong type — and its String() form would
			// parse as a git commit, so a guard that coerces instead of
			// checking the type persists evidence from a payload the host
			// never promised.
			{ command: { toString: () => "git commit -m 'Nope'" } },
			"git-malformed",
		);
		await finishTool(booted, call, {
			toolCallId: "git-malformed",
			toolName: "bash",
			result: { content: [{ type: "text", text: "[main abc1234] Nope" }] },
			isError: false,
		});
		addAnswer(booted, "malformed git done");
		await finishRun(booted, "malformed git done");

		// The run completes and the answer renders: the guard fails open.
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"malformed git done",
		);
		// No git evidence, and no commit summary invented from the output.
		expect(
			booted.appendedEntries.filter(
				(entry) => entry.customType === "omp-compact-git",
			),
		).toHaveLength(0);
		expect(visibleRows(booted.transcript).join("\n")).not.toContain("abc1234");
		await shutdown(booted);
	},
);
