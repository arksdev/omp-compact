import { afterAll, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	addAnswer,
	addTool,
	beginRun,
	bootWithTranscript,
	cleanupGeneratedDirs,
	dispatch,
	fakeTool,
	finishRun,
	finishTool,
	fixtureDir,
	shutdown,
	stockTest,
	toolUi,
	visibleRows,
} from "./integration-harness";

afterAll(cleanupGeneratedDirs);

stockTest("tool-use continuation never triggers cleanup", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const call = await addTool(
		booted,
		"grep",
		{ pattern: "registerTool", path: "src" },
		"grep-1",
	);
	await finishTool(booted, call, {
		toolCallId: "grep-1",
		toolName: "grep",
		result: {
			content: [{ type: "text", text: "match" }],
			details: { matchCount: 1 },
		},
		isError: false,
	});
	await finishRun(booted, "working", "toolUse", true);
	expect(visibleRows(booted.transcript).join("\n")).toContain("registerTool");
	await dispatch(booted, { type: "agent_start" });
	expect(visibleRows(booted.transcript).join("\n")).toContain("registerTool");
	addAnswer(booted, "done");
	await finishRun(booted, "done");
	expect(visibleRows(booted.transcript).join("\n")).not.toContain(
		"registerTool",
	);
	await shutdown(booted);
});

stockTest(
	"provisional tool IDs migrate onto the bound native component",
	async () => {
		const cwd = fixtureDir("provisional-id");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "migrated.ts");
		await Bun.write(path, "old\n");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "",
						name: "write",
						arguments: { path: "provisional.ts", content: "new\n" },
					},
				],
			},
		});
		const component = new booted.host.ToolExecutionComponent(
			"write",
			{ path: "provisional.ts", content: "new\n" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("write"),
			toolUi(),
			cwd,
			"",
		);
		booted.transcript.addChild(component);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"provisional.ts",
		);
		component.updateArgs?.(
			{ path: "migrated.ts", content: "new\n" },
			"write-real",
		);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "write-real",
			toolName: "write",
			args: { path: "migrated.ts", content: "new\n" },
		});
		await Bun.write(path, "new\n");
		await finishTool(booted, component, {
			toolCallId: "write-real",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("write: migrated.ts");
		expect(completed).toContain("+1|1");
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-write",
			data: { toolCallId: "write-real" },
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"non-empty provisional tool IDs migrate onto the bound component",
	async () => {
		const cwd = fixtureDir("provisional-nonempty");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "final.ts");
		await Bun.write(path, "old\n");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "write-prov",
						name: "write",
						arguments: { path: "staging.ts", content: "new\n" },
					},
				],
			},
		});
		const component = new booted.host.ToolExecutionComponent(
			"write",
			{ path: "staging.ts", content: "new\n" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("write"),
			toolUi(),
			cwd,
			"write-prov",
		);
		booted.transcript.addChild(component);
		expect(visibleRows(booted.transcript).join("\n")).toContain("staging.ts");
		component.updateArgs?.(
			{ path: "final.ts", content: "new\n" },
			"write-real",
		);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "write-real",
			toolName: "write",
			args: { path: "final.ts", content: "new\n" },
		});
		await Bun.write(path, "new\n");
		await finishTool(booted, component, {
			toolCallId: "write-real",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("write: final.ts");
		expect(completed).not.toContain("staging.ts");
		expect(completed).toContain("+1|1");
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-write",
			data: { toolCallId: "write-real" },
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest("git evidence lands on the migrated real-ID row", async () => {
	const cwd = fixtureDir("provisional-git");
	await rm(cwd, { recursive: true, force: true });
	await mkdir(cwd, { recursive: true });
	const booted = await bootWithTranscript(cwd);
	await beginRun(booted);
	await dispatch(booted, {
		type: "message_update",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "",
					name: "bash",
					arguments: { command: "git status" },
				},
			],
		},
	});
	const component = new booted.host.ToolExecutionComponent(
		"bash",
		{ command: "git status" },
		{ showImages: false, useBuiltInRenderer: true },
		fakeTool("bash"),
		toolUi(),
		cwd,
		"",
	);
	booted.transcript.addChild(component);
	expect(visibleRows(booted.transcript).join("\n")).toContain("git status");
	component.updateArgs?.({ command: "git status" }, "bash-real");
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "bash-real",
		toolName: "bash",
		args: { command: "git status" },
	});
	await finishTool(booted, component, {
		toolCallId: "bash-real",
		toolName: "bash",
		result: {
			content: [{ type: "text", text: " M migrated.ts" }],
			details: { exitCode: 0 },
		},
		isError: false,
	});
	addAnswer(booted, "done");
	await finishRun(booted, "done");
	const completed = visibleRows(booted.transcript).join("\n");
	// the non-commit Git row is filtered by the terminal answer; the evidence
	// still lands on the migrated real-ID row of the persisted entry
	expect(completed).not.toContain("git status");
	expect(booted.appendedEntries[0]).toMatchObject({
		customType: "omp-compact-git",
		data: { toolCallId: "bash-real" },
	});
	await shutdown(booted);
	await rm(cwd, { recursive: true, force: true });
});

stockTest(
	"migration merges a pre-existing real-ID state without duplicates",
	async () => {
		const cwd = fixtureDir("provisional-merge");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "merged.ts");
		await Bun.write(path, "old\n");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "",
						name: "write",
						arguments: { path: "staging.ts", content: "new\n" },
					},
				],
			},
		});
		const component = new booted.host.ToolExecutionComponent(
			"write",
			{ path: "staging.ts", content: "new\n" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("write"),
			toolUi(),
			cwd,
			"",
		);
		booted.transcript.addChild(component);
		expect(visibleRows(booted.transcript).join("\n")).toContain("staging.ts");
		// The real-ID state is created before the component rebinds.
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "write-real",
			toolName: "write",
			args: { path: "merged.ts", content: "new\n" },
		});
		await Bun.write(path, "new\n");
		component.updateArgs?.(
			{ path: "merged.ts", content: "new\n" },
			"write-real",
		);
		await finishTool(booted, component, {
			toolCallId: "write-real",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("write: merged.ts");
		expect(completed).not.toContain("staging.ts");
		expect(completed.match(/\+1\|1/g)).toHaveLength(1);
		expect(booted.appendedEntries).toHaveLength(1);
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-write",
			data: { toolCallId: "write-real" },
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);
