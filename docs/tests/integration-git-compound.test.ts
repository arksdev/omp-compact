import { afterAll, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	addAnswer,
	addTool,
	assistant,
	type BootedPlugin,
	beginRun,
	bootPlugin,
	bootWithTranscript,
	cleanupGeneratedDirs,
	fakeTool,
	finishRun,
	finishTool,
	fixtureDir,
	shutdown,
	stockTest,
	toolUi,
	visibleRows,
} from "./integration-harness";
import type { TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

stockTest(
	"compound Git Bash calls leave one aggregate commit summary after the answer",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "git add src/a.ts && git commit -m 'Add a'" },
			"git-compound",
		);
		await finishTool(booted, call, {
			toolCallId: "git-compound",
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
				],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(booted, "committed");
		await finishRun(booted, "committed");
		const rows = visibleRows(booted.transcript);
		const completed = rows.join("\n");
		// the terminal answer keeps only one aggregate commit summary; the
		// add invocation of the same Bash call is filtered from the view
		expect(completed).not.toContain("git add src/a.ts");
		expect(completed).not.toContain("git commit abc1234 Add a");
		expect(completed).toContain("git commit: abc1234");
		expect(rows.filter((row) => row.includes("git commit:")).length).toBe(1);
		expect(booted.sentMessages).toEqual([]);
		// a single evidence entry carries the ordered record list
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-git",
			data: {
				toolCallId: "git-compound",
				subcommand: "add",
				text: "git add src/a.ts",
				isError: false,
			},
		});
		expect(
			(booted.appendedEntries[0]?.data as { records?: unknown[] })?.records,
		).toEqual([
			{ subcommand: "add", text: "git add src/a.ts", isError: false },
			{
				subcommand: "commit",
				text: "git commit abc1234 Add a",
				isError: false,
			},
		]);
		await shutdown(booted);
	},
);
stockTest(
	"semicolon-joined Git Bash calls leave one aggregate commit summary after the answer",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "git add src/a.ts; git commit -m 'Add a'" },
			"git-compound-semicolon",
		);
		await finishTool(booted, call, {
			toolCallId: "git-compound-semicolon",
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
				],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(booted, "committed");
		await finishRun(booted, "committed");
		const rows = visibleRows(booted.transcript);
		const completed = rows.join("\n");
		expect(completed).not.toContain("git add src/a.ts");
		expect(completed).not.toContain("git commit abc1234 Add a");
		expect(completed).toContain("git commit: abc1234");
		expect(rows.filter((row) => row.includes("git commit:")).length).toBe(1);
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-git",
			data: {
				toolCallId: "git-compound-semicolon",
				subcommand: "add",
				text: "git add src/a.ts",
				isError: false,
			},
		});
		expect(
			(booted.appendedEntries[0]?.data as { records?: unknown[] })?.records,
		).toEqual([
			{ subcommand: "add", text: "git add src/a.ts", isError: false },
			{
				subcommand: "commit",
				text: "git commit abc1234 Add a",
				isError: false,
			},
		]);
		await shutdown(booted);
	},
);

stockTest(
	"failed compound and cd-gated Git calls create no retained rows",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "git add a && git commit -m 'x'" },
			"git-compound-fail",
		);
		await finishTool(booted, call, {
			toolCallId: "git-compound-fail",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "nothing to commit" }],
				details: { exitCode: 1 },
			},
			isError: true,
		});
		addAnswer(booted, "reported");
		await finishRun(booted, "reported");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("git add a");
		expect(completed).not.toContain("git commit");
		expect(completed).toContain("reported");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);

		const gated = await bootWithTranscript();
		await beginRun(gated);
		const gatedCall = await addTool(
			gated,
			"bash",
			{ command: "cd repo && git add a && git commit -m 'x'" },
			"git-cd-fail",
		);
		await finishTool(gated, gatedCall, {
			toolCallId: "git-cd-fail",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "conflict" }],
				details: { exitCode: 1 },
			},
			isError: true,
		});
		addAnswer(gated, "reported");
		await finishRun(gated, "reported");
		const filtered = visibleRows(gated.transcript).join("\n");
		expect(filtered).not.toContain("git add a");
		expect(filtered).not.toContain("git commit");
		expect(filtered).toContain("reported");
		expect(gated.appendedEntries).toEqual([]);
		await shutdown(gated);
	},
);

stockTest(
	"process restore hydrates a compound Git row into its individual compact records",
	async () => {
		let transcript: TranscriptInstance | undefined;
		const branch = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "work" }] },
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "git-compound",
					toolName: "bash",
					args: {
						command: "git add src/a.ts && git commit -m 'Add a'",
					},
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "git-compound",
					toolName: "bash",
					content: [
						{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
					],
					isError: false,
				},
			},
			{ type: "message", message: assistant("done") },
			{
				type: "custom_message",
				customType: "omp-compact-git",
				display: false,
				content: "",
				details: {
					version: 1,
					toolCallId: "git-compound",
					subcommand: "add",
					text: "git add src/a.ts",
					isError: false,
					records: [
						{
							subcommand: "add",
							text: "git add src/a.ts",
							isError: false,
						},
						{
							subcommand: "commit",
							text: "git commit abc1234 Add a",
							isError: false,
						},
					],
				},
			},
		];
		const booted = await bootPlugin(
			(root, host) => {
				transcript = new host.TranscriptContainer();
				root.addChild(transcript);
				const call = new host.ToolExecutionComponent(
					"bash",
					{ command: "git add src/a.ts && git commit -m 'Add a'" },
					{ showImages: false, useBuiltInRenderer: true },
					fakeTool("bash"),
					toolUi(),
					"/tmp",
					"git-compound",
				);
				call.updateResult(
					{
						content: [
							{
								type: "text",
								text: "[main abc1234] Add a\n 1 file changed",
							},
						],
						details: {},
					},
					false,
					"git-compound",
				);
				transcript.addChild(call);
				const ContainerBase = Object.getPrototypeOf(
					host.ReadToolGroupComponent.prototype,
				).constructor as BootedPlugin["ContainerBase"];
				const reply = new ContainerBase();
				reply.addChild({ render: () => ["done"] });
				transcript.addChild(reply);
			},
			"/tmp",
			branch,
			false,
			{ mode: "compact" },
		);
		if (!transcript) throw new Error("transcript missing");
		const rows = visibleRows(transcript).join("\n");
		// the compact mode keeps the restored history a complete log, so the
		// compound call shows its individual records instead of the filtered
		// aggregate summary
		expect(rows).not.toContain("git commit: abc1234");
		expect(rows).toContain("git add src/a.ts");
		expect(rows).toContain("git commit abc1234 Add a");
		expect(rows).toContain("done");
		await shutdown(booted);
	},
);

stockTest(
	"brand-new file below a new nested directory keeps exact +N|0 and retention",
	async () => {
		const cwd = fixtureDir("newfile");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "src", "components", "Button.tsx");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"write",
			{
				path: "src/components/Button.tsx",
				content: "untrusted raw input",
			},
			"write-new-nested",
		);
		// Native completion creates the missing directories as well as the
		// file; the raw requested content never becomes the post-image.
		await mkdir(dirname(path), { recursive: true });
		await Bun.write(path, "export const Button = () => <button />;\n");
		await finishTool(booted, call, {
			toolCallId: "write-new-nested",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		addAnswer(booted, "written");
		await finishRun(booted, "written");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: src/components/Button.tsx");
		expect(rows).toContain("+1|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toHaveLength(1);
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-write",
			data: {
				version: 1,
				toolCallId: "write-new-nested",
				toolName: "write",
				path: "src/components/Button.tsx",
				added: 1,
				removed: 0,
				exact: true,
			},
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"multi-line brand-new file reports exact +3|0 on the same row",
	async () => {
		const cwd = fixtureDir("newfile-multi");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "multi.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			"write-new-multi",
		);
		await Bun.write(path, "one\ntwo\nthree\n");
		await finishTool(booted, call, {
			toolCallId: "write-new-multi",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		addAnswer(booted, "written");
		await finishRun(booted, "written");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: multi.ts");
		expect(rows).toContain("+3|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-write",
			data: {
				version: 1,
				toolCallId: "write-new-multi",
				added: 3,
				removed: 0,
				exact: true,
			},
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"brand-new empty file stays a no-op and disappears after the answer",
	async () => {
		const cwd = fixtureDir("newfile-empty");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "empty.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"write",
			{ path: "empty.ts", content: "" },
			"write-new-empty",
		);
		await Bun.write(path, "");
		await finishTool(booted, call, {
			toolCallId: "write-new-empty",
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
		expect(completed).not.toContain("write: empty.ts");
		expect(completed).not.toContain("0|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"a quiet commit with a substituted message keeps its aggregate summary",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{
				command:
					"cd /repo && git add src/hud/{scene.rs,panel.rs} && git commit -q -m \"$(printf 'fix: turn the spinner from the wall clock\\n\\nThe phase came from the dictation timer.')\" && git log --oneline -1",
			},
			"git-quiet-commit",
		);
		await finishTool(booted, call, {
			toolCallId: "git-quiet-commit",
			toolName: "bash",
			result: {
				content: [
					{
						type: "text",
						text: "3f52b2f fix: turn the spinner from the wall clock\n",
					},
				],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(booted, "committed");
		await finishRun(booted, "committed");
		const rows = visibleRows(booted.transcript);
		expect(rows.join("\n")).toContain("git commit: 3f52b2f");
		expect(
			(booted.appendedEntries[0]?.data as { records?: unknown[] })?.records,
		).toEqual([
			{
				subcommand: "add",
				text: "git add src/hud/{scene.rs,panel.rs}",
				isError: false,
			},
			{
				subcommand: "commit",
				text: "git commit 3f52b2f fix: turn the spinner from the wall clock",
				isError: false,
			},
			{ subcommand: "log", text: "git log --oneline -1", isError: false },
		]);
		await shutdown(booted);
	},
);
