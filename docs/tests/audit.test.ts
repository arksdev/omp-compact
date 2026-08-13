import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	completeEditMutations,
	countDiffChanges,
	countNumberedDiff,
	countUnifiedDiff,
	DIFF_MAX_REMAINING_LINES,
	MAX_DELETE_BYTES,
	MAX_DELETE_LINES,
	MAX_DIFF_BYTES,
	MAX_DIFF_ROWS,
	MAX_PER_FILE_RESULTS,
	trimmedMiddleLines,
} from "../../.omp-plugin/audit-diff";
import { MAX_EVIDENCE_PATH_LENGTH } from "../../.omp-plugin/hydration-bounds";

import type { MutationMessageDetails } from "../../.omp-plugin/messages";
import { loadStockPlugin } from "./test-stock-host";

interface WriteCandidate {
	before: string;
}

interface AuditModule {
	captureWriteCandidate(input: {
		toolCallId: string;
		args: unknown;
		cwd: string;
	}): Promise<WriteCandidate | undefined>;
	completeWriteCandidate(
		candidate: WriteCandidate | undefined,
		result: unknown,
		isError: boolean,
	): Promise<MutationMessageDetails[]>;
}

let auditModule: AuditModule;

beforeAll(async () => {
	// The write audit depends on stock @oh-my-pi modules, which resolve from
	// the repository's exact root development dependencies.
	auditModule = await loadStockPlugin<AuditModule>("audit.ts", "audit-test");
});

function captureWriteCandidate(
	input: Parameters<AuditModule["captureWriteCandidate"]>[0],
): ReturnType<AuditModule["captureWriteCandidate"]> {
	return auditModule.captureWriteCandidate(input);
}

function completeWriteCandidate(
	candidate: WriteCandidate | undefined,
	result: unknown,
	isError: boolean,
): Promise<MutationMessageDetails[]> {
	return auditModule.completeWriteCandidate(candidate, result, isError);
}

describe("unified edit audit", () => {
	test("counts only hunk body markers", () => {
		expect(
			countUnifiedDiff(
				"--- a\n+++ b\n@@ -1 +1,2 @@\n-old\n+new\n+++content\n---content\n",
			),
		).toEqual({
			added: 2,
			removed: 2,
		});
	});

	test("unified headers outside the hunk body are not changes", () => {
		expect(
			countUnifiedDiff(
				"--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
			),
		).toEqual({ added: 1, removed: 1 });
	});


	test("malformed hunk header returns undefined", () => {
		expect(countUnifiedDiff("@@ not-a-hunk\n+fake\n")).toBeUndefined();
		expect(countUnifiedDiff("@@\n+line\n")).toBeUndefined();
	});

	test("well-formed hunk with - or + range succeeds", () => {
		expect(countUnifiedDiff("@@ -1 +1 @@\n-old\n+new\n")).toEqual({
			added: 1,
			removed: 1,
		});
		expect(countUnifiedDiff("@@ +1 @@\n+added\n")).toEqual({
			added: 1,
			removed: 0,
		});
	});
	test("retains successful per-file mutations from an aggregate error", () => {
		const entries = completeEditMutations(
			"edit-1",
			{
				details: {
					perFileResults: [
						{
							path: "src/a.ts",
							diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n",
						},
						{ path: "src/b.ts", diff: "", isError: true },
					],
				},
			},
			true,
		);
		expect(entries).toEqual([
			{
				version: 1,
				toolCallId: "edit-1",
				toolName: "edit",
				path: "src/a.ts",
				added: 1,
				removed: 1,
				exact: true,
			},
		]);
	});
});

describe("numbered edit audit", () => {
	test("numbered update gives exact added and removed counts", () => {
		expect(
			completeEditMutations(
				"edit-2",
				{
					details: {
						path: "src/a.ts",
						diff: "-12|old line\n+12|new line",
					},
				},
				false,
			),
		).toEqual([
			{
				version: 1,
				toolCallId: "edit-2",
				toolName: "edit",
				path: "src/a.ts",
				added: 1,
				removed: 1,
				exact: true,
			},
		]);
	});

	test("numbered insertion counts only added rows", () => {
		expect(
			completeEditMutations(
				"edit-3",
				{
					details: {
						path: "src/a.ts",
						diff: "+10|first\n+11|second",
					},
				},
				false,
			),
		).toEqual([
			{
				version: 1,
				toolCallId: "edit-3",
				toolName: "edit",
				path: "src/a.ts",
				added: 2,
				removed: 0,
				exact: true,
			},
		]);
	});

	test("numbered deletion counts only removed rows", () => {
		expect(
			completeEditMutations(
				"edit-4",
				{
					details: {
						path: "src/a.ts",
						diff: "-5|gone\n-6|also gone",
					},
				},
				false,
			),
		).toEqual([
			{
				version: 1,
				toolCallId: "edit-4",
				toolName: "edit",
				path: "src/a.ts",
				added: 0,
				removed: 2,
				exact: true,
			},
		]);
	});

	test("numbered context rows are not changes", () => {
		expect(
			completeEditMutations(
				"edit-5",
				{
					details: {
						path: "src/a.ts",
						diff: " 12|context\n-13|old\n+13|new\n 14|tail",
					},
				},
				false,
			),
		).toEqual([
			{
				version: 1,
				toolCallId: "edit-5",
				toolName: "edit",
				path: "src/a.ts",
				added: 1,
				removed: 1,
				exact: true,
			},
		]);
	});

	test("gap and diagnostic rows are not changes", () => {
		expect(
			completeEditMutations(
				"edit-6",
				{
					details: {
						path: "src/a.ts",
						diff: "-7|old\n\n+8|new\nApplied patch to 1 file.\n+9|more",
					},
				},
				false,
			),
		).toEqual([
			{
				version: 1,
				toolCallId: "edit-6",
				toolName: "edit",
				path: "src/a.ts",
				added: 2,
				removed: 1,
				exact: true,
			},
		]);
	});

	test("no-op numbered diff stays discarded", () => {
		expect(
			completeEditMutations(
				"edit-7",
				{
					details: {
						path: "src/a.ts",
						diff: " 12|context\n 13|more",
					},
				},
				false,
			),
		).toEqual([]);
	});
});

describe("edit aggregate error handling", () => {
	test("single-path aggregate error keeps applied numbered diff", () => {
		expect(
			completeEditMutations(
				"edit-8",
				{
					details: {
						path: "src/a.ts",
						diff: "-12|old\n+12|new",
					},
					isError: true,
				},
				true,
			),
		).toEqual([
			{
				version: 1,
				toolCallId: "edit-8",
				toolName: "edit",
				path: "src/a.ts",
				added: 1,
				removed: 1,
				exact: true,
			},
		]);
	});

	test("failed single-path result without evidence stays discarded", () => {
		expect(
			completeEditMutations(
				"edit-9",
				{
					details: { path: "src/a.ts", diff: "" },
					isError: true,
				},
				true,
			),
		).toEqual([]);
	});

	test("multi-file aggregate error keeps each applied entry", () => {
		const entries = completeEditMutations(
			"edit-10",
			{
				details: {
					perFileResults: [
						{ path: "src/a.ts", diff: "-1|old\n+1|new" },
						{ path: "src/b.ts", diff: "", isError: true },
						{ path: "src/c.ts", diff: "+10|added" },
					],
				},
				isError: true,
			},
			true,
		);
		expect(entries).toEqual([
			{
				version: 1,
				toolCallId: "edit-10",
				toolName: "edit",
				path: "src/a.ts",
				added: 1,
				removed: 1,
				exact: true,
			},
			{
				version: 1,
				toolCallId: "edit-10",
				toolName: "edit",
				path: "src/c.ts",
				added: 1,
				removed: 0,
				exact: true,
			},
		]);
	});
});

describe("edit delete audit", () => {
	test("delete with exact oldText counts removed lines", () => {
		expect(
			completeEditMutations(
				"edit-11",
				{
					details: {
						path: "src/gone.ts",
						op: "delete",
						diff: "",
						oldText: "line1\nline2\nline3",
					},
				},
				false,
			),
		).toEqual([
			{
				version: 1,
				toolCallId: "edit-11",
				toolName: "edit",
				path: "src/gone.ts",
				added: 0,
				removed: 3,
				exact: true,
			},
		]);
	});

	test("delete trailing newline uses write-audit line semantics", () => {
		expect(
			completeEditMutations(
				"edit-12",
				{
					details: {
						path: "src/gone.ts",
						op: "delete",
						diff: "",
						oldText: "line1\nline2\n",
					},
				},
				false,
			),
		).toEqual([
			{
				version: 1,
				toolCallId: "edit-12",
				toolName: "edit",
				path: "src/gone.ts",
				added: 0,
				removed: 2,
				exact: true,
			},
		]);
	});

	test("delete without oldText does not invent stats", () => {
		expect(
			completeEditMutations(
				"edit-13",
				{
					details: {
						path: "src/gone.ts",
						op: "delete",
						diff: "",
					},
				},
				false,
			),
		).toEqual([]);
	});

	test("pruned delete does not invent stats", () => {
		expect(
			completeEditMutations(
				"edit-14",
				{
					details: {
						path: "src/gone.ts",
						op: "delete",
						diff: "",
						oldText: "x",
						snapshotsPruned: true,
					},
				},
				false,
			),
		).toEqual([]);
	});

	test("per-file delete retained, failed entries discarded", () => {
		const entries = completeEditMutations(
			"edit-15",
			{
				details: {
					perFileResults: [
						{
							path: "src/del.ts",
							diff: "",
							op: "delete",
							oldText: "a\nb",
						},
						{ path: "src/bad.ts", diff: "", isError: true },
					],
				},
				isError: true,
			},
			true,
		);
		expect(entries).toEqual([
			{
				version: 1,
				toolCallId: "edit-15",
				toolName: "edit",
				path: "src/del.ts",
				added: 0,
				removed: 2,
				exact: true,
			},
		]);
	});
});

describe("numbered edit audit", () => {
	test("counts a numbered update row pair", () => {
		expect(countNumberedDiff("-12|old\n+12|new\n")).toEqual({
			added: 1,
			removed: 1,
		});
	});

	test("counts a numbered insertion", () => {
		expect(countNumberedDiff("+12|new line\n")).toEqual({
			added: 1,
			removed: 0,
		});
	});

	test("counts a numbered deletion", () => {
		expect(countNumberedDiff("-12|old line\n")).toEqual({
			added: 0,
			removed: 1,
		});
	});

	test("numbered context rows and gap rows are not changes", () => {
		expect(countNumberedDiff(" 12|context\n\n 13|more\n+14|added\n")).toEqual({
			added: 1,
			removed: 0,
		});
	});

	test("header and diagnostic text is not mixed with numbered rows", () => {
		expect(
			countNumberedDiff(
				"*** Begin Patch\n*** Update File: src/a.ts\n-1|old\n+1|new\n*** End Patch\n",
			),
		).toEqual({ added: 1, removed: 1 });
	});

	test("numbered diff rows flow into an exact mutation entry", () => {
		const entries = completeEditMutations(
			"edit-2",
			{
				details: {
					path: "src/c.ts",
					diff: "-12|old line\n+12|new line\n+13|extra line\n",
				},
			},
			false,
		);
		expect(entries).toEqual([
			{
				version: 1,
				toolCallId: "edit-2",
				toolName: "edit",
				path: "src/c.ts",
				added: 2,
				removed: 1,
				exact: true,
			},
		]);
	});

	test("single-path aggregate error keeps already-applied numbered diff", () => {
		const entries = completeEditMutations(
			"edit-3",
			{
				details: {
					path: "src/d.ts",
					diff: "+12|new\n+13|newer\n",
				},
			},
			true,
		);
		expect(entries).toEqual([
			{
				version: 1,
				toolCallId: "edit-3",
				toolName: "edit",
				path: "src/d.ts",
				added: 2,
				removed: 0,
				exact: true,
			},
		]);
	});

	test("single-path error without usable diff evidence is discarded", () => {
		expect(
			completeEditMutations(
				"edit-4",
				{ details: { path: "src/e.ts", diff: "" } },
				true,
			),
		).toEqual([]);
	});

	test("no-op with empty diff is discarded", () => {
		expect(
			completeEditMutations(
				"edit-noop",
				{ details: { path: "src/n.ts", diff: "", op: "update" } },
				false,
			),
		).toEqual([]);
	});
});

describe("edit delete audit", () => {
	test("successful delete with op and oldText gives exact removed count", () => {
		const entries = completeEditMutations(
			"edit-5",
			{
				details: {
					path: "src/f.ts",
					op: "delete",
					diff: "",
					oldText: "a\nb\nc",
				},
			},
			false,
		);
		expect(entries).toEqual([
			{
				version: 1,
				toolCallId: "edit-5",
				toolName: "edit",
				path: "src/f.ts",
				added: 0,
				removed: 3,
				exact: true,
			},
		]);
	});

	test("delete without retained oldText is discarded", () => {
		expect(
			completeEditMutations(
				"edit-6",
				{ details: { path: "src/g.ts", op: "delete", diff: "" } },
				false,
			),
		).toEqual([]);
	});

	test("delete with pruned snapshots is discarded", () => {
		expect(
			completeEditMutations(
				"edit-7",
				{
					details: {
						path: "src/h.ts",
						op: "delete",
						diff: "",
						snapshotsPruned: true,
					},
				},
				false,
			),
		).toEqual([]);
	});

	test("empty diff without op:delete is a no-op even with oldText", () => {
		expect(
			completeEditMutations(
				"edit-8",
				{
					details: {
						path: "src/i.ts",
						op: "update",
						diff: "",
						oldText: "a\nb\n",
					},
				},
				false,
			),
		).toEqual([]);
	});

	test("multi-file delete retains only the exact per-file removal", () => {
		const entries = completeEditMutations(
			"edit-9",
			{
				details: {
					perFileResults: [
						{
							path: "src/j.ts",
							op: "delete",
							diff: "",
							oldText: "one\ntwo\n",
						},
						{ path: "src/k.ts", diff: "", isError: true },
					],
				},
			},
			true,
		);
		expect(entries).toEqual([
			{
				version: 1,
				toolCallId: "edit-9",
				toolName: "edit",
				path: "src/j.ts",
				added: 0,
				removed: 2,
				exact: true,
			},
		]);
	});

	test("multi-file numbered diffs retain exact counts per file", () => {
		const entries = completeEditMutations(
			"edit-10",
			{
				details: {
					perFileResults: [
						{ path: "src/l.ts", diff: " 1|ctx\n-2|old\n+2|new\n" },
						{ path: "src/m.ts", diff: "", isError: true },
					],
				},
			},
			false,
		);
		expect(entries).toEqual([
			{
				version: 1,
				toolCallId: "edit-10",
				toolName: "edit",
				path: "src/l.ts",
				added: 1,
				removed: 1,
				exact: true,
			},
		]);
	});
});

describe("edit evidence budgets", () => {
	test("counters reject a diff over the byte budget", () => {
		const big = "x".repeat(MAX_DIFF_BYTES + 1);
		expect(countUnifiedDiff(big)).toBeUndefined();
		expect(countNumberedDiff(big)).toBeUndefined();
		expect(countDiffChanges(big)).toBeUndefined();
	});

	test("counters reject a diff over the row budget", () => {
		const rows = "+1|a\n".repeat(MAX_DIFF_ROWS + 1);
		expect(countNumberedDiff(rows)).toBeUndefined();
		expect(countUnifiedDiff(rows)).toBeUndefined();
	});

	test("row budget boundary counts exactly at the cap", () => {
		// A trailing newline visits one extra empty row, so the exact-cap
		// input ends without one.
		const rows = `${"+1|a\n".repeat(MAX_DIFF_ROWS - 1)}+1|a`;
		expect(countNumberedDiff(rows)).toEqual({
			added: MAX_DIFF_ROWS,
			removed: 0,
		});
	});

	test("rows with line-terminator content are not rows (anchored-regex semantics)", () => {
		// The original `(.*)$` row pattern could not span \r/\u2028/\u2029;
		// the budget rewrite preserves that exactly.
		expect(countNumberedDiff(" 12|ctx\r")).toBeUndefined();
		expect(countNumberedDiff("-1|a\r\n+1|b\r\n")).toBeUndefined();
		expect(countNumberedDiff("+1|ok\n-2|bad\u2028\n")).toEqual({
			added: 1,
			removed: 0,
		});
	});

	test("an over-byte per-file diff drops only that entry", () => {
		const entries = completeEditMutations(
			"edit-b-1",
			{
				details: {
					perFileResults: [
						{ path: "src/a.ts", diff: "-1|old\n+1|new\n" },
						{ path: "src/big.ts", diff: "x".repeat(MAX_DIFF_BYTES + 1) },
						{ path: "src/c.ts", diff: "+2|more\n" },
					],
				},
			},
			false,
		);
		expect(entries.map((entry) => entry.path)).toEqual([
			"src/a.ts",
			"src/c.ts",
		]);
	});

	test("over-line delete pre-image yields no exact entry", () => {
		expect(
			completeEditMutations(
				"edit-b-2",
				{
					details: {
						path: "src/del.ts",
						op: "delete",
						diff: "",
						oldText: "x\n".repeat(MAX_DELETE_LINES + 1),
					},
				},
				false,
			),
		).toEqual([]);
	});

	test("over-byte delete pre-image yields no exact entry", () => {
		expect(
			completeEditMutations(
				"edit-b-3",
				{
					details: {
						path: "src/del.ts",
						op: "delete",
						diff: "",
						oldText: "x".repeat(MAX_DELETE_BYTES + 1),
					},
				},
				false,
			),
		).toEqual([]);
	});

	test("over-long evidence path yields no entry", () => {
		const longPath = "p".repeat(MAX_EVIDENCE_PATH_LENGTH + 1);
		expect(
			completeEditMutations(
				"edit-b-4",
				{ details: { path: longPath, diff: "+1|x\n" } },
				false,
			),
		).toEqual([]);
	});

	test("perFileResults processing stops at the file budget", () => {
		const perFileResults = Array.from(
			{ length: MAX_PER_FILE_RESULTS + 40 },
			(_, index) => ({
				path: `src/f${index}.ts`,
				diff: `+1|line ${index}\n`,
			}),
		);
		const entries = completeEditMutations(
			"edit-b-5",
			{ details: { perFileResults } },
			false,
		);
		expect(entries).toHaveLength(MAX_PER_FILE_RESULTS);
		expect(entries[0].path).toBe("src/f0.ts");
		expect(entries[MAX_PER_FILE_RESULTS - 1].path).toBe(
			`src/f${MAX_PER_FILE_RESULTS - 1}.ts`,
		);
		expect(
			entries.some((entry) => entry.path === `src/f${MAX_PER_FILE_RESULTS}.ts`),
		).toBe(false);
	});


	test("oversized file is skipped but smaller subsequent files are scanned", () => {
		const { MAX_TOTAL_SCAN_BYTES } = require("../../.omp-plugin/audit-diff");
		// Test that continue logic allows smaller files after a too-large file.
		// Create files with oldText to control exact byte cost without hitting
		// MAX_DIFF_BYTES or MAX_DIFF_ROWS limits on the diff itself.
		const smallDiff = "+1|x\n"; // ~5 bytes
		const mediumOldText = "a".repeat(Math.floor(MAX_TOTAL_SCAN_BYTES * 0.25)); // 1MB each
		const hugeOldText = "b".repeat(Math.floor(MAX_TOTAL_SCAN_BYTES * 0.35)); // 1.4MB
		const entries = completeEditMutations(
			"edit-skip-1",
			{
				details: {
					perFileResults: [
						// 3 files at 1MB each = 3MB total (75% of 4MB budget)
						{ path: "src/a.ts", diff: smallDiff, oldText: mediumOldText },
						{ path: "src/b.ts", diff: smallDiff, oldText: mediumOldText },
						{ path: "src/c.ts", diff: smallDiff, oldText: mediumOldText },
						// huge would add 1.4MB → 4.4MB > 4MB budget, skip it
						{ path: "src/huge.ts", diff: smallDiff, oldText: hugeOldText },
						// small adds ~5 bytes, fits at 3MB
						{ path: "src/e.ts", diff: smallDiff },
					],
				},
			},
			false,
		);
		// Expect a.ts, b.ts, c.ts, e.ts (huge.ts skipped due to budget).
		expect(entries.map((e) => e.path)).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/e.ts",
		]);
	});
	test("perFileResults accumulation stops at the total scan budget", () => {
		// Five files, each with a valid numbered diff exactly at the per-file
		// byte cap: the cumulative budget allows only the first four, even
		// though every single file is under its own cap.
		const bigDiff = `+1|${"a".repeat(MAX_DIFF_BYTES - 3)}`;
		expect(bigDiff.length).toBe(MAX_DIFF_BYTES);
		const perFileResults = Array.from({ length: 5 }, (_, index) => ({
			path: `src/big${index}.ts`,
			diff: bigDiff,
		}));
		const entries = completeEditMutations(
			"edit-b-6",
			{ details: { perFileResults } },
			false,
		);
		expect(entries).toHaveLength(4);
		expect(entries[3].path).toBe("src/big3.ts");
		expect(entries.some((entry) => entry.path === "src/big4.ts")).toBe(false);
	});

	test("adversarial repeated rows over the row budget flow into no exact entry", () => {
		expect(
			completeEditMutations(
				"edit-b-7",
				{
					details: {
						path: "src/r.ts",
						diff: "+1|x\n".repeat(MAX_DIFF_ROWS + 1),
					},
				},
				false,
			),
		).toEqual([]);
	});
});

describe("write audit snapshot bounds", () => {
	async function stage(): Promise<{
		cwd: string;
		cleanup: () => Promise<void>;
	}> {
		const cwd = await mkdtemp(join(tmpdir(), "omp-compact-bound-"));
		return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
	}

	test("a pre-image larger than the byte bound yields no candidate", async () => {
		const { cwd, cleanup } = await stage();
		try {
			await writeFile(join(cwd, "big.ts"), "a".repeat(1_048_576 + 1));
			const candidate = await captureWriteCandidate({
				toolCallId: "write-big",
				args: { path: "big.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(candidate).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	test("a pre-image exactly at the byte bound is captured in full", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const exact = "b".repeat(1_048_576);
			await writeFile(join(cwd, "exact.ts"), exact);
			const candidate = await captureWriteCandidate({
				toolCallId: "write-exact",
				args: { path: "exact.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe(exact);
		} finally {
			await cleanup();
		}
	});
});

describe("write audit diff budget", () => {
	async function stage(): Promise<{
		cwd: string;
		cleanup: () => Promise<void>;
	}> {
		const cwd = await mkdtemp(join(tmpdir(), "omp-compact-diffbudget-"));
		return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
	}

	const line = (seed: string, index: number): string =>
		`${seed}${String(index).padStart(6, "0")}\n`;
	const file = (count: number, seed: string): string =>
		Array.from({ length: count }, (_, index) => line(seed, index)).join("");

	test("trimmed middle counts collapse common prefix and suffix", () => {
		expect(trimmedMiddleLines("", "")).toEqual({
			beforeLines: 0,
			afterLines: 0,
		});
		expect(trimmedMiddleLines("a\nb\n", "a\nb\n")).toEqual({
			beforeLines: 0,
			afterLines: 0,
		});
		expect(trimmedMiddleLines("a\nb\nc\n", "a\nX\nc\n")).toEqual({
			beforeLines: 1,
			afterLines: 1,
		});
		expect(trimmedMiddleLines("a\nb\nc\n", "a\nb\nc\nd\n")).toEqual({
			beforeLines: 0,
			afterLines: 1,
		});
		expect(trimmedMiddleLines("a\nc\n", "a\nb\nc\n")).toEqual({
			beforeLines: 0,
			afterLines: 1,
		});
		expect(trimmedMiddleLines("", "x\ny\n")).toEqual({
			beforeLines: 0,
			afterLines: 2,
		});
		expect(trimmedMiddleLines("a\n", "a")).toEqual({
			beforeLines: 1,
			afterLines: 1,
		});
		expect(trimmedMiddleLines("a\r\nb\n", "a\r\nX\n")).toEqual({
			beforeLines: 1,
			afterLines: 1,
		});
		expect(trimmedMiddleLines("a\n", "a\r\n")).toEqual({
			beforeLines: 1,
			afterLines: 1,
		});
	});

	test("identical rewrite of an existing file is a no-op", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const content = "const a = 1;\nkeep();\n";
			await writeFile(join(cwd, "same.ts"), content);
			const candidate = await captureWriteCandidate({
				toolCallId: "write-same",
				args: { path: "same.ts", content },
				cwd,
			});
			expect(candidate).toBeDefined();
			await writeFile(join(cwd, "same.ts"), content);
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(cwd, "same.ts") },
				},
				false,
			);
			expect(entries).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("identical rewrite of a near-cap file short-circuits without a diff", async () => {
		// The equal fast path must hold at snapshot-capped sizes: a hostile
		// or format-on-save no-op write must not pay for diff work at all.
		const { cwd, cleanup } = await stage();
		try {
			const content = file(40_000, "same");
			await writeFile(join(cwd, "big-same.ts"), content);
			const candidate = await captureWriteCandidate({
				toolCallId: "write-same-big",
				args: { path: "big-same.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(candidate).toBeDefined();
			await writeFile(join(cwd, "big-same.ts"), content);
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(cwd, "big-same.ts") },
				},
				false,
			);
			expect(entries).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("localized change in a near-cap file stays exact", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const before = file(40_000, "keep");
			await writeFile(join(cwd, "big-edit.ts"), before);
			const candidate = await captureWriteCandidate({
				toolCallId: "write-big-edit",
				args: { path: "big-edit.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(candidate).toBeDefined();
			const after = before.replace("keep020000\n", "changed20000\n");
			await writeFile(join(cwd, "big-edit.ts"), after);
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(cwd, "big-edit.ts") },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "write-big-edit",
					toolName: "write",
					path: "big-edit.ts",
					added: 1,
					removed: 1,
					exact: true,
				},
			]);
		} finally {
			await cleanup();
		}
	});

	test("wholesale rewrite exactly at the budget stays exact", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const count = Math.floor(DIFF_MAX_REMAINING_LINES / 2);
			const before = file(count, "old");
			await writeFile(join(cwd, "boundary.ts"), before);
			const candidate = await captureWriteCandidate({
				toolCallId: "write-boundary",
				args: { path: "boundary.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(candidate).toBeDefined();
			await writeFile(join(cwd, "boundary.ts"), file(count, "new"));
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(cwd, "boundary.ts") },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "write-boundary",
					toolName: "write",
					path: "boundary.ts",
					added: count,
					removed: count,
					exact: true,
				},
			]);
		} finally {
			await cleanup();
		}
	});

	test("wholesale rewrite beyond the budget yields no exact entry", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const count = Math.floor(DIFF_MAX_REMAINING_LINES / 2) + 1;
			const before = file(count, "old");
			await writeFile(join(cwd, "over.ts"), before);
			const candidate = await captureWriteCandidate({
				toolCallId: "write-over",
				args: { path: "over.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(candidate).toBeDefined();
			await writeFile(join(cwd, "over.ts"), file(count, "new"));
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(cwd, "over.ts") },
				},
				false,
			);
			expect(entries).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("an all-added tail beyond a full rewrite of the base stays exact", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const base = 3_000;
			const added = 2_000;
			const before = file(base, "line");
			await writeFile(join(cwd, "append.ts"), before);
			const candidate = await captureWriteCandidate({
				toolCallId: "write-append",
				args: { path: "append.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(candidate).toBeDefined();
			await writeFile(join(cwd, "append.ts"), before + file(added, "more"));
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(cwd, "append.ts") },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "write-append",
					toolName: "write",
					path: "append.ts",
					added,
					removed: 0,
					exact: true,
				},
			]);
		} finally {
			await cleanup();
		}
	});
});

describe("write audit for brand-new files", () => {
	async function stage(): Promise<{
		cwd: string;
		cleanup: () => Promise<void>;
	}> {
		const cwd = await mkdtemp(join(tmpdir(), "omp-compact-audit-"));
		return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
	}

	test("single-line new file reports exact +1|0 from the real post-image", async () => {
		const { cwd, cleanup } = await stage();
		try {
			// The raw requested content is untrusted: the stats must come from
			// the post-image that actually lands on disk, never from args.content.
			const candidate = await captureWriteCandidate({
				toolCallId: "write-new-1",
				args: { path: "fresh.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(candidate).toBeDefined();
			// A missing file is honestly an empty pre-image.
			expect(candidate?.before).toBe("");
			await writeFile(join(cwd, "fresh.ts"), "const one = 1;\n");
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(cwd, "fresh.ts") },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "write-new-1",
					toolName: "write",
					path: "fresh.ts",
					added: 1,
					removed: 0,
					exact: true,
				},
			]);
		} finally {
			await cleanup();
		}
	});

	test("multi-line new file reports exact +N|0", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const candidate = await captureWriteCandidate({
				toolCallId: "write-new-2",
				args: { path: "multi.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("");
			await writeFile(join(cwd, "multi.ts"), "one\ntwo\nthree\n");
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(cwd, "multi.ts") },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "write-new-2",
					toolName: "write",
					path: "multi.ts",
					added: 3,
					removed: 0,
					exact: true,
				},
			]);
		} finally {
			await cleanup();
		}
	});

	test("new file below a symlinked parent in brand-new nested dirs keeps stats", async () => {
		// Regression contract: at capture neither the file nor its nested
		// directories exist, so a naive canonicalization falls back to the raw
		// path while completion-time realpath resolves the symlinked prefix — a
		// false mismatch that dropped exact stats for the new file.
		const { cwd, cleanup } = await stage();
		try {
			await mkdir(join(cwd, "real"));
			await symlink("real", join(cwd, "link"));
			const candidate = await captureWriteCandidate({
				toolCallId: "write-new-3",
				args: { path: "link/a/b/fresh.ts", content: "x\n" },
				cwd,
			});
			expect(candidate).toBeDefined();
			const absolute = join(cwd, "link", "a", "b", "fresh.ts");
			await mkdir(join(cwd, "link", "a", "b"), { recursive: true });
			await writeFile(absolute, "x\n");
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: absolute },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "write-new-3",
					toolName: "write",
					path: "link/a/b/fresh.ts",
					added: 1,
					removed: 0,
					exact: true,
				},
			]);
		} finally {
			await cleanup();
		}
	});

	test("empty new file stays a no-op with no entry", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const candidate = await captureWriteCandidate({
				toolCallId: "write-new-4",
				args: { path: "empty.ts", content: "" },
				cwd,
			});
			expect(candidate).toBeDefined();
			await writeFile(join(cwd, "empty.ts"), "");
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(cwd, "empty.ts") },
				},
				false,
			);
			expect(entries).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("resolvedPath mismatch drops the entry", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const candidate = await captureWriteCandidate({
				toolCallId: "write-new-5",
				args: { path: "target.ts", content: "y\n" },
				cwd,
			});
			expect(candidate).toBeDefined();
			await writeFile(join(cwd, "target.ts"), "y\n");
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(cwd, "elsewhere.ts") },
				},
				false,
			);
			expect(entries).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("existing-file edit counts stay exact and unchanged", async () => {
		const { cwd, cleanup } = await stage();
		try {
			await writeFile(join(cwd, "edit.ts"), "const a = 1;\nkeep();\n");
			const candidate = await captureWriteCandidate({
				toolCallId: "write-new-6",
				args: { path: "edit.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("const a = 1;\nkeep();\n");
			await writeFile(
				join(cwd, "edit.ts"),
				"const a = 2;\nkeep();\nextra();\n",
			);
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(cwd, "edit.ts") },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "write-new-6",
					toolName: "write",
					path: "edit.ts",
					added: 2,
					removed: 1,
					exact: true,
				},
			]);
		} finally {
			await cleanup();
		}
	});
});
