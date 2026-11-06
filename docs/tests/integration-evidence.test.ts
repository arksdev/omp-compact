/**
 * What a run leaves behind after its answer: the files it changed, read
 * from disk around each write, and the commits its Git commands created,
 * however the commands were chained.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MUTATION_MESSAGE_TYPE } from "../../.omp-plugin/messages";
import {
	beginRun,
	boot,
	type BootedPlugin,
	continueRun,
	dispatch,
	endRun,
	endTool,
	rows,
	runTool,
	startTool,
	stockDescribe,
	textResult,
} from "./integration-kit";
import { cleanupStockSettings } from "./test-stock-host";

afterAll(() => {
	cleanupStockSettings();
});

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-compact-evidence-"));
	dirs.push(dir);
	return dir;
}

/** The assistant entry that issued a write: the audit's proof of ownership. */
function issueWrite(booted: BootedPlugin, id: string, args: unknown): void {
	booted.branch.push(
		{
			type: "message",
			id: "user-1",
			message: { role: "user", content: [{ type: "text", text: "go" }] },
		},
		{
			type: "message",
			id: `entry-${id}`,
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id, name: "write", arguments: args }],
			},
		},
	);
}

async function write(
	booted: BootedPlugin,
	id: string,
	path: string,
	content: string,
): Promise<void> {
	const args = { path, content };
	issueWrite(booted, id, args);
	const block = await startTool(booted, id, "write", args);
	writeFileSync(path, content);
	await endTool(booted, block, id, "write", wrote(path));
}

/** omp's write result: the file it wrote, resolved. */
function wrote(path: string): unknown {
	return { ...textResult(`Wrote ${path}`), details: { resolvedPath: path } };
}

const commit = (hash: string, subject: string) =>
	textResult(`[main ${hash}] ${subject}\n 1 file changed, 1 insertion(+)`);

stockDescribe("evidence after the answer", () => {
	test("a write keeps its row with exact line counts; routine calls go", async () => {
		const cwd = workspace();
		const booted = await boot("live", { cwd });
		await beginRun(booted);
		await runTool(booted, "g1", "grep", { pattern: "needle" });
		await write(booted, "w1", join(cwd, "notes.txt"), "a\nb\nc\n");
		await endRun(booted);
		const text = rows(booted);
		expect(text).toContain("notes.txt");
		expect(text).toContain("+3");
		expect(text).not.toContain("grep: needle");
		expect(
			booted.appendedEntries.filter(
				(e) => e.customType === MUTATION_MESSAGE_TYPE,
			),
		).toHaveLength(1);
	});

	test("evidence that lands after the call ended still reaches its row", async () => {
		const cwd = workspace();
		const path = join(cwd, "late.txt");
		const booted = await boot("live", { cwd });
		await beginRun(booted);
		const args = { path, content: "x\ny\n" };
		issueWrite(booted, "w1", args);
		const block = await startTool(booted, "w1", "write", args);
		writeFileSync(path, args.content);
		await endTool(booted, block, "w1", "write", wrote(path));
		// The audit reads the file after the end event, so the row first draws
		// without counts; a continuation's agent_end waits for the audit.
		await continueRun(booted);
		expect(rows(booted)).toContain("+2");
		await endRun(booted);
		expect(rows(booted)).toContain("+2");
	});

	test("a write that changed nothing leaves no row", async () => {
		const cwd = workspace();
		const path = join(cwd, "same.txt");
		writeFileSync(path, "same\n");
		const booted = await boot("live", { cwd });
		await beginRun(booted);
		await write(booted, "w1", path, "same\n");
		await endRun(booted);
		expect(rows(booted)).toBe("");
		expect(booted.appendedEntries).toEqual([]);
	});

	test("creating an empty file keeps its row after the answer", async () => {
		const cwd = workspace();
		const booted = await boot("live", { cwd });
		await beginRun(booted);
		await write(booted, "w1", join(cwd, ".gitkeep"), "");
		await endRun(booted);
		expect(rows(booted)).toContain(".gitkeep");
	});

	test("an abort keeps the write row with its counts", async () => {
		const cwd = workspace();
		const booted = await boot("live", { cwd });
		await beginRun(booted);
		await write(booted, "w1", join(cwd, "a.txt"), "1\n");
		await runTool(booted, "g1", "grep", { pattern: "needle" });
		await endRun(booted, "aborted");
		const text = rows(booted);
		expect(text).toContain("a.txt");
		expect(text).toContain("+1");
		expect(text).toContain("grep: needle");
	});

	test("commits from several calls and a chained command share one summary row", async () => {
		const booted = await boot("live");
		await beginRun(booted);
		await runTool(
			booted,
			"b1",
			"bash",
			{ command: "git add a.ts && git commit -m 'Add a'" },
			commit("abc1234", "Add a"),
		);
		await runTool(booted, "g1", "grep", { pattern: "needle" });
		await runTool(
			booted,
			"b2",
			"bash",
			{ command: "git commit -am 'Fix b'" },
			commit("def5678", "Fix b"),
		);
		await endRun(booted);
		const lines = rows(booted).split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("abc1234");
		expect(lines[0]).toContain("def5678");
	});

	for (const separator of ["; ", "\n"]) {
		test(`an unguarded chain (${JSON.stringify(separator)}) keeps its Bash row and claims no commit`, async () => {
			const booted = await boot("live");
			await beginRun(booted);
			await runTool(
				booted,
				"b1",
				"bash",
				{ command: `git add missing${separator}git status --porcelain` },
				textResult("fatal: pathspec 'missing' did not match any files"),
			);
			expect(rows(booted)).toContain("bash: git add missing");
			await endRun(booted);
			expect(rows(booted)).toBe("");
			expect(booted.appendedEntries).toEqual([]);
		});
	}

	test("a failed or cd-gated commit leaves nothing after the answer", async () => {
		for (const command of [
			"git add a && git commit -m 'x'",
			"cd repo && git add a && git commit -m 'x'",
		]) {
			const booted = await boot("live");
			await beginRun(booted);
			await runTool(
				booted,
				"b1",
				"bash",
				{ command },
				textResult("nothing to commit"),
				true,
			);
			await endRun(booted);
			expect(rows(booted), command).toBe("");
			expect(booted.appendedEntries, command).toEqual([]);
		}
	});

	test("retainGitLive off hides Git rows and the summary", async () => {
		const booted = await boot("live", { settings: { retainGitLive: false } });
		await beginRun(booted);
		await runTool(
			booted,
			"b1",
			"bash",
			{ command: "git commit -m change" },
			commit("abc1234", "change"),
		);
		expect(rows(booted)).toBe("");
		await endRun(booted);
		expect(rows(booted)).toBe("");
		// The evidence is still recorded: the setting only changes the view.
		expect(booted.appendedEntries).toHaveLength(1);
	});

	test("a call that ends after the answer publishes no late evidence", async () => {
		const booted = await boot("live");
		await beginRun(booted);
		const block = await startTool(booted, "b1", "bash", {
			command: "git commit -m late",
		});
		await endRun(booted);
		await dispatch(booted, { type: "agent_start" });
		await endTool(booted, block, "b1", "bash", commit("abc1234", "late"));
		expect(rows(booted)).not.toContain("abc1234");
	});
});
