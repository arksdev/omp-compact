import { afterAll, expect } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
	addAnswer,
	addTool,
	beginRun,
	bootWithTranscript,
	cleanupGeneratedDirs,
	finishRun,
	finishTool,
	fixtureDir,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";

afterAll(cleanupGeneratedDirs);

stockTest(
	"todo remains in the live log and disappears after the answer",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"todo",
			{ op: "done", task: "alpha" },
			"todo-1",
		);
		await finishTool(booted, call, {
			toolCallId: "todo-1",
			toolName: "todo",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain("alpha");
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		expect(visibleRows(booted.transcript).join("\n")).not.toContain("alpha");
		await shutdown(booted);
	},
);

stockTest(
	"abort without an answer commits the complete compact log",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "false" },
			"bash-abort",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-abort",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "failed" }],
				details: { exitCode: 1 },
			},
			isError: true,
		});
		await finishRun(booted, "", "aborted");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("false");
		expect(rows).toContain("exit 1");
		expect(rows).toContain("✗");
		expect(call.isTranscriptBlockFinalized()).toBe(true);
		await shutdown(booted);
	},
);

stockTest("verified non-zero write survives final filtering", async () => {
	const cwd = fixtureDir("integration");
	await mkdir(cwd, { recursive: true });
	const path = join(cwd, "write.ts");
	await Bun.write(path, "const a = 1;\nkeep();\n");
	const booted = await bootWithTranscript(cwd);
	await beginRun(booted);
	const args = { path: "write.ts", content: "ignored raw input" };
	const call = await addTool(booted, "write", args, "write-1");
	await Bun.write(path, "const a = 2;\nkeep();\nextra();\n");
	await finishTool(booted, call, {
		toolCallId: "write-1",
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
	expect(rows).toContain("write: write.ts");
	expect(rows).toContain("+2|1");
	expect(booted.sentMessages).toEqual([]);
	expect(booted.appendedEntries[0]).toMatchObject({
		customType: "omp-compact-write",
		data: {
			version: 1,
			toolCallId: "write-1",
			added: 2,
			removed: 1,
			exact: true,
		},
	});
	await shutdown(booted);
	await rm(cwd, { recursive: true, force: true });
});

stockTest(
	"write audit resolves relative paths against live sessionManager.getCwd",
	async () => {
		// Mid-session /move updates SessionManager.#cwd without rebuilding
		// ExtensionContext: context.cwd stays at the pre-move snapshot while
		// getCwd() returns the live root. Relative write pre-images must land
		// under the live root, or +N/−M evidence is wrong or missing.
		const stale = fixtureDir("write-cwd-stale");
		const live = fixtureDir("write-cwd-live");
		await rm(stale, { recursive: true, force: true });
		await rm(live, { recursive: true, force: true });
		await mkdir(stale, { recursive: true });
		await mkdir(live, { recursive: true });
		const path = join(live, "moved.ts");
		await Bun.write(path, "old\n");
		// A same-named file under the stale snapshot must not be the pre-image.
		await Bun.write(join(stale, "moved.ts"), "stale-preimage\n");

		const booted = await bootWithTranscript(stale);
		Object.assign(booted.context.sessionManager, {
			getCwd: () => live,
		});
		await beginRun(booted);
		const call = await addTool(
			booted,
			"write",
			{ path: "moved.ts", content: "new\n" },
			"write-live-cwd",
		);
		await Bun.write(path, "new\n");
		await finishTool(booted, call, {
			toolCallId: "write-live-cwd",
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
		expect(rows).toContain("write: moved.ts");
		// live old→new is +1|1; stale-preimage→new would be a different count
		// and a path-canonicality miss would publish nothing.
		expect(rows).toContain("+1|1");
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-write",
			data: {
				version: 1,
				toolCallId: "write-live-cwd",
				added: 1,
				removed: 1,
				exact: true,
			},
		});
		await shutdown(booted);
		await rm(stale, { recursive: true, force: true });
		await rm(live, { recursive: true, force: true });
	},
);

stockTest(
	"write audit fails open to context.cwd when getCwd is unavailable",
	async () => {
		const cwd = fixtureDir("write-cwd-fallback");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "fallback.ts");
		await Bun.write(path, "before\n");

		const booted = await bootWithTranscript(cwd);
		// sessionManager has getBranch only — no getCwd. Capture must still
		// resolve the relative path against the snapshot field.
		await beginRun(booted);
		const call = await addTool(
			booted,
			"write",
			{ path: "fallback.ts", content: "after\n" },
			"write-cwd-fallback",
		);
		await Bun.write(path, "after\n");
		await finishTool(booted, call, {
			toolCallId: "write-cwd-fallback",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		addAnswer(booted, "written");
		await finishRun(booted, "written");

		expect(visibleRows(booted.transcript).join("\n")).toContain("+1|1");
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-write",
			data: { toolCallId: "write-cwd-fallback", added: 1, removed: 1 },
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest("new write below a symlinked parent keeps exact stats", async () => {
	const cwd = fixtureDir("symlink");
	await rm(cwd, { recursive: true, force: true });
	await mkdir(join(cwd, "real"), { recursive: true });
	await symlink("real", join(cwd, "link"));
	const path = join(cwd, "link", "new.ts");
	const booted = await bootWithTranscript(cwd);
	await beginRun(booted);
	const call = await addTool(
		booted,
		"write",
		{ path: "link/new.ts", content: "new\n" },
		"write-symlink",
	);
	await Bun.write(path, "new\n");
	await finishTool(booted, call, {
		toolCallId: "write-symlink",
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
	expect(rows).toContain("write: link/new.ts");
	expect(rows).toContain("+1|0");
	expect(booted.sentMessages).toEqual([]);
	expect(booted.appendedEntries).toHaveLength(1);
	await shutdown(booted);
	await rm(cwd, { recursive: true, force: true });
});

stockTest(
	"no-op writes and non-Git failures are removed after the answer",
	async () => {
		const cwd = fixtureDir("noop");
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "same.ts");
		await Bun.write(path, "same\n");
		const mismatchPath = join(cwd, "mismatch.ts");
		const otherPath = join(cwd, "other.ts");
		await Bun.write(mismatchPath, "old\n");
		await Bun.write(otherPath, "other\n");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const write = await addTool(
			booted,
			"write",
			{ path: "same.ts", content: "same\n" },
			"write-noop",
		);
		await finishTool(booted, write, {
			toolCallId: "write-noop",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		const mismatch = await addTool(
			booted,
			"write",
			{ path: "mismatch.ts", content: "new\n" },
			"write-mismatch",
		);
		await Bun.write(mismatchPath, "new\n");
		await finishTool(booted, mismatch, {
			toolCallId: "write-mismatch",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: otherPath },
			},
			isError: false,
		});
		const virtual = await addTool(
			booted,
			"write",
			{ path: "vault://_/note.md", content: "x" },
			"write-virtual",
		);
		await finishTool(booted, virtual, {
			toolCallId: "write-virtual",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: otherPath },
			},
			isError: false,
		});
		const bash = await addTool(
			booted,
			"bash",
			{ command: "exit 2" },
			"bash-error",
		);
		await finishTool(booted, bash, {
			toolCallId: "bash-error",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "no" }],
				details: { exitCode: 2 },
			},
			isError: true,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain("exit 2");
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("same.ts");
		expect(completed).not.toContain("mismatch.ts");
		expect(completed).not.toContain("vault://_/note.md");
		expect(completed).not.toContain("exit 2");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest("partial edit retains successful changed files", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const call = await addTool(
		booted,
		"edit",
		{ input: "multi-file" },
		"edit-partial",
	);
	await finishTool(booted, call, {
		toolCallId: "edit-partial",
		toolName: "edit",
		result: {
			content: [{ type: "text", text: "one file failed" }],
			details: {
				perFileResults: [
					{
						path: "src/a.ts",
						diff: "--- a\n+++ b\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n",
					},
					{ path: "src/b.ts", diff: "", isError: true },
				],
			},
		},
		isError: true,
	});
	addAnswer(booted, "partially edited");
	await finishRun(booted, "partially edited");
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("edit: src/a.ts");
	expect(rows).toContain("+2|1");
	expect(rows).not.toContain("src/b.ts");
	expect(booted.sentMessages).toEqual([]);
	expect(booted.appendedEntries).toHaveLength(1);
	await shutdown(booted);
});

stockTest(
	"numbered edit row survives terminal answer with audit evidence",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"edit",
			{ input: "replace" },
			"edit-numbered",
		);
		await finishTool(booted, call, {
			toolCallId: "edit-numbered",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "edited" }],
				details: {
					path: "src/numbered.ts",
					op: "update",
					diff: "-12|old line\n+12|new line",
				},
			},
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"edit: src/numbered.ts",
		);
		addAnswer(booted, "numbered edit done");
		await finishRun(booted, "numbered edit done");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("edit: src/numbered.ts");
		expect(rows).toContain("+1|1");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([
			{
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId: "edit-numbered",
					toolName: "edit",
					path: "src/numbered.ts",
					added: 1,
					removed: 1,
					exact: true,
				},
			},
		]);
		await shutdown(booted);
	},
);

stockTest(
	"recognized Git commits leave one summary row; non-commit rows filter",
	async () => {
		const success = await bootWithTranscript();
		await beginRun(success);
		const commit = await addTool(
			success,
			"bash",
			{ command: "git commit -m 'Fix compact log'" },
			"git-1",
		);
		await finishTool(success, commit, {
			toolCallId: "git-1",
			toolName: "bash",
			result: {
				content: [
					{
						type: "text",
						text: "[main abc1234] Fix compact log\n 1 file changed",
					},
				],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(success, "committed");
		await finishRun(success, "committed");
		const successRows = visibleRows(success.transcript).join("\n");
		expect(successRows).toContain("git commit: abc1234");
		// the individual Git row is replaced by the aggregate summary
		expect(successRows).not.toContain("git commit abc1234 Fix compact log");
		expect(success.sentMessages).toEqual([]);
		expect(success.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-git",
			data: { toolCallId: "git-1", text: "git commit abc1234 Fix compact log" },
		});
		await shutdown(success);

		const failure = await bootWithTranscript();
		await beginRun(failure);
		const rebase = await addTool(
			failure,
			"bash",
			{ command: "git rebase main" },
			"git-2",
		);
		await finishTool(failure, rebase, {
			toolCallId: "git-2",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "conflict" }],
				details: { exitCode: 1 },
			},
			isError: true,
		});
		addAnswer(failure, "reported");
		await finishRun(failure, "reported");
		const failureRows = visibleRows(failure.transcript).join("\n");
		// a non-commit failure produces no hash and is filtered with the answer
		expect(failureRows).not.toContain("git rebase main");
		expect(failureRows).not.toContain("git commit:");
		expect(failure.sentMessages).toEqual([]);
		expect(failure.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-git",
			data: { toolCallId: "git-2", text: "✗ git rebase main", isError: true },
		});
		await shutdown(failure);
	},
);

stockTest(
	"subject-less commit rows keep the hash in persisted evidence",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const commit = await addTool(
			booted,
			"bash",
			{ command: "git commit -m 'No subject line'" },
			"git-subjectless",
		);
		await finishTool(booted, commit, {
			toolCallId: "git-subjectless",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "[main abc1234]\n 1 file changed" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(booted, "committed");
		await finishRun(booted, "committed");
		const entry = booted.appendedEntries[0] as {
			customType: string;
			data: Record<string, unknown>;
		};
		expect(entry).toMatchObject({
			customType: "omp-compact-git",
			data: {
				toolCallId: "git-subjectless",
				subcommand: "commit",
				text: "git commit abc1234",
				shortHash: "abc1234",
			},
		});
		expect("subject" in entry.data).toBe(false);
		expect(visibleRows(booted.transcript).join("\n")).toContain("abc1234");
		await shutdown(booted);
	},
);

stockTest(
	"failed cd-gated Git rows are filtered as ordinary Bash errors",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "cd /missing && git status" },
			"git-cd-gated",
		);
		await finishTool(booted, call, {
			toolCallId: "git-cd-gated",
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "cd: no such file or directory: /missing" },
				],
				details: { exitCode: 1 },
			},
			isError: true,
		});
		addAnswer(booted, "reported");
		await finishRun(booted, "reported");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("git status");
		expect(completed).toContain("reported");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);
	},
);

stockTest(
	"audit kinds route write, edit, and Git Bash through the registry lifecycle",
	async () => {
		const cwd = fixtureDir("audit-kinds");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "kinds.ts");
		await Bun.write(path, "const a = 1;\nkeep();\n");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const write = await addTool(
			booted,
			"write",
			{ path: "kinds.ts", content: "untrusted raw input" },
			"kinds-write",
		);
		await Bun.write(path, "const a = 2;\nkeep();\nextra();\n");
		await finishTool(booted, write, {
			toolCallId: "kinds-write",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		const edit = await addTool(
			booted,
			"edit",
			{ input: "replace" },
			"kinds-edit",
		);
		await finishTool(booted, edit, {
			toolCallId: "kinds-edit",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "edited" }],
				details: {
					path: "src/kinds.ts",
					op: "update",
					diff: "-12|old line\n+12|new line",
				},
			},
			isError: false,
		});
		const git = await addTool(
			booted,
			"bash",
			{ command: "git commit -m 'Route audit'" },
			"kinds-git",
		);
		await finishTool(booted, git, {
			toolCallId: "kinds-git",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "[main abc1234] Route audit" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const rows = visibleRows(booted.transcript).join("\n");
		// every audit kind keeps its current presentation through the
		// registry-selected lifecycle: write row with exact stats, edit row,
		// one aggregate Git summary
		expect(rows).toContain("write: kinds.ts");
		expect(rows).toContain("+2|1");
		expect(rows).toContain("edit: src/kinds.ts");
		expect(rows).toContain("git commit: abc1234");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toHaveLength(3);
		expect(
			booted.appendedEntries.find(
				(entry) =>
					(entry.data as { toolCallId?: string })?.toolCallId === "kinds-write",
			),
		).toMatchObject({
			customType: "omp-compact-write",
			data: { toolCallId: "kinds-write", added: 2, removed: 1, exact: true },
		});
		expect(
			booted.appendedEntries.find(
				(entry) =>
					(entry.data as { toolCallId?: string })?.toolCallId === "kinds-edit",
			),
		).toMatchObject({
			customType: "omp-compact-write",
			data: {
				toolCallId: "kinds-edit",
				toolName: "edit",
				path: "src/kinds.ts",
				added: 1,
				removed: 1,
				exact: true,
			},
		});
		expect(
			booted.appendedEntries.find(
				(entry) =>
					(entry.data as { toolCallId?: string })?.toolCallId === "kinds-git",
			),
		).toMatchObject({
			customType: "omp-compact-git",
			data: {
				toolCallId: "kinds-git",
				subcommand: "commit",
				text: "git commit abc1234 Route audit",
				isError: false,
			},
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"apply_patch wire alias keeps the compact edit route and mutation audit",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"apply_patch",
			{
				input:
					"*** Begin Patch\n*** Update File: src/alias.ts\n@@\n-old\n+new\n*** End Patch",
			},
			"apply-patch-1",
		);
		await finishTool(booted, call, {
			toolCallId: "apply-patch-1",
			toolName: "apply_patch",
			result: {
				content: [{ type: "text", text: "edited" }],
				details: {
					path: "src/alias.ts",
					op: "update",
					diff: "-1|old\n+1|new",
				},
			},
			isError: false,
		});
		const workingRows = visibleRows(booted.transcript).join("\n");
		expect(workingRows).toContain("edit: src/alias.ts");
		expect(workingRows).not.toContain("native apply_patch");

		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completedRows = visibleRows(booted.transcript).join("\n");
		expect(completedRows).toContain("edit: src/alias.ts");
		expect(booted.appendedEntries).toEqual([
			expect.objectContaining({
				customType: "omp-compact-write",
				data: expect.objectContaining({
					toolCallId: "apply-patch-1",
					toolName: "edit",
					path: "src/alias.ts",
					added: 1,
					removed: 1,
					exact: true,
				}),
			}),
		]);
		await shutdown(booted);
	},
);

stockTest(
	"unknown, native-live, and routine tools create no audit evidence",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const calls = [
			{ toolCallId: "mystery", toolName: "no-such-tool", args: {} },
			{ toolCallId: "live", toolName: "task", args: { op: "spawn" } },
			{ toolCallId: "routine", toolName: "grep", args: { pattern: "x" } },
			// alias of the canonical ast_grep: an alias must never create
			// audit work either
			{ toolCallId: "alias", toolName: "ast-grep", args: { pattern: "x" } },
			// routine Bash (non-Git command) stays below the Git gate
			{
				toolCallId: "shell",
				toolName: "bash",
				args: { command: "printf routine" },
			},
		];
		for (const call of calls) {
			const component = await addTool(
				booted,
				call.toolName,
				call.args,
				call.toolCallId,
			);
			await finishTool(booted, component, {
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				result: { content: [{ type: "text", text: "ok" }], details: {} },
				isError: false,
			});
		}
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);
	},
);
