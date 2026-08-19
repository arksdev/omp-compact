import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	isPathInsideRoot,
	readExactAsync,
	readExactSync,
} from "../../.omp-plugin/audit";
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
	toolCallId?: string;
	toolName?: "write";
	displayPath?: string;
	absolutePath?: string;
	canonicalPath?: string;
	before: string;
}

interface AuditModule {
	captureWriteCandidate(input: {
		toolCallId: string;
		args: unknown;
		cwd: string;
		root?: string;
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
	test("single-file top-level error with a diff-shaped result publishes nothing", () => {
		// Fail closed: a top-level error without perFileResults cannot prove
		// the write applied. A diff-shaped payload must not become +N/−M
		// evidence for a failed single-file edit.
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
		).toEqual([]);
		// Top-level flag alone (no result.isError) is enough.
		expect(
			completeEditMutations(
				"edit-8b",
				{
					details: {
						path: "src/a.ts",
						diff: "-1|old\n+1|new",
					},
				},
				true,
			),
		).toEqual([]);
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
				toolName: "delete",
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
				toolName: "delete",
				path: "src/gone.ts",
				added: 0,
				removed: 2,
				exact: true,
			},
		]);
	});

	test("delete without oldText keeps the row without inventing stats", () => {
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
		).toEqual([
			{
				toolCallId: "edit-13",
				toolName: "delete",
				path: "src/gone.ts",
				exact: false,
			},
		]);
	});

	test("pruned delete keeps the row without inventing stats", () => {
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
		).toEqual([
			{
				toolCallId: "edit-14",
				toolName: "delete",
				path: "src/gone.ts",
				exact: false,
			},
		]);
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
				toolName: "delete",
				path: "src/del.ts",
				added: 0,
				removed: 2,
				exact: true,
			},
		]);
	});

	test("per-file delete without oldText keeps the row without stats", () => {
		const entries = completeEditMutations(
			"edit-16",
			{
				details: {
					perFileResults: [
						{
							path: "src/del.ts",
							diff: "",
							op: "delete",
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
				toolCallId: "edit-16",
				toolName: "delete",
				path: "src/del.ts",
				exact: false,
			},
		]);
	});

	test("per-file delete with invalid path is discarded", () => {
		const entries = completeEditMutations(
			"edit-17",
			{
				details: {
					perFileResults: [
						{
							path: 42,
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
		expect(entries).toEqual([]);
	});

	// F01 boundary pins for deleteEntry: the byte gate is evaluated before
	// any line scan, the line gate reuses a single computed count, and the
	// no-op delete (zero removed lines) stays row-less. These pin the exact
	// semantics of the single-scan refactor: unknown-count evidence
	// (exact: false) must survive byte/line overflows unchanged.
	test("delete over the byte gate keeps the row without inventing stats", () => {
		const entries = completeEditMutations(
			"edit-18",
			{
				details: {
					path: "src/gone.ts",
					op: "delete",
					diff: "",
					oldText: "x".repeat(MAX_DELETE_BYTES + 1),
				},
			},
			false,
		);
		expect(entries).toEqual([
			{
				toolCallId: "edit-18",
				toolName: "delete",
				path: "src/gone.ts",
				exact: false,
			},
		]);
	});

	test("delete over the line gate keeps the row without inventing stats", () => {
		const oldText = Array.from(
			{ length: MAX_DELETE_LINES + 1 },
			(_, index) => `line${index}`,
		).join("\n");
		const entries = completeEditMutations(
			"edit-19",
			{
				details: { path: "src/gone.ts", op: "delete", diff: "", oldText },
			},
			false,
		);
		expect(entries).toEqual([
			{
				toolCallId: "edit-19",
				toolName: "delete",
				path: "src/gone.ts",
				exact: false,
			},
		]);
	});

	test("delete exactly at the line gate counts exactly", () => {
		const oldText = Array.from(
			{ length: MAX_DELETE_LINES },
			(_, index) => `line${index}`,
		).join("\n");
		const entries = completeEditMutations(
			"edit-20",
			{
				details: { path: "src/gone.ts", op: "delete", diff: "", oldText },
			},
			false,
		);
		expect(entries).toEqual([
			{
				version: 1,
				toolCallId: "edit-20",
				toolName: "delete",
				path: "src/gone.ts",
				added: 0,
				removed: MAX_DELETE_LINES,
				exact: true,
			},
		]);
	});

	test("empty oldText is a no-op delete with no row", () => {
		const entries = completeEditMutations(
			"edit-21",
			{
				details: {
					path: "src/gone.ts",
					op: "delete",
					diff: "",
					oldText: "",
				},
			},
			false,
		);
		expect(entries).toEqual([]);
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

	test("single-path top-level error discards numbered diff evidence", () => {
		// Same fail-closed rule as the aggregate-error suite: without
		// perFileResults a top-level error cannot prove the write applied.
		expect(
			completeEditMutations(
				"edit-3",
				{
					details: {
						path: "src/d.ts",
						diff: "+12|new\n+13|newer\n",
					},
				},
				true,
			),
		).toEqual([]);
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
				toolName: "delete",
				path: "src/f.ts",
				added: 0,
				removed: 3,
				exact: true,
			},
		]);
	});

	test("delete without retained oldText keeps the row without stats", () => {
		expect(
			completeEditMutations(
				"edit-6",
				{ details: { path: "src/g.ts", op: "delete", diff: "" } },
				false,
			),
		).toEqual([
			{
				toolCallId: "edit-6",
				toolName: "delete",
				path: "src/g.ts",
				exact: false,
			},
		]);
	});

	test("delete with pruned snapshots keeps the row without stats", () => {
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
		).toEqual([
			{
				toolCallId: "edit-7",
				toolName: "delete",
				path: "src/h.ts",
				exact: false,
			},
		]);
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
				toolName: "delete",
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
		// The exact-cap input must count identically whether or not it ends
		// with a trailing newline: a trailing newline is not an extra row.
		const withTrailing = "+1|a\n".repeat(MAX_DIFF_ROWS);
		expect(countNumberedDiff(withTrailing)).toEqual({
			added: MAX_DIFF_ROWS,
			removed: 0,
		});
		const withoutTrailing = `${"+1|a\n".repeat(MAX_DIFF_ROWS - 1)}+1|a`;
		expect(countNumberedDiff(withoutTrailing)).toEqual({
			added: MAX_DIFF_ROWS,
			removed: 0,
		});
	});

	test("unified row budget boundary counts exactly at the cap with trailing newline", () => {
		// The hunk header occupies one row of the budget, so the body holds
		// MAX_DIFF_ROWS - 1 rows; a trailing newline must not push the count
		// over the budget.
		const rows = `@@ -1 +1 @@\n${"-x\n".repeat(MAX_DIFF_ROWS - 2)}-x\n`;
		expect(countUnifiedDiff(rows)).toEqual({
			added: 0,
			removed: MAX_DIFF_ROWS - 1,
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

	test("over-line delete pre-image keeps the row without exact stats", () => {
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
		).toEqual([
			{
				toolCallId: "edit-b-2",
				toolName: "delete",
				path: "src/del.ts",
				exact: false,
			},
		]);
	});

	test("over-byte delete pre-image keeps the row without exact stats", () => {
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
		).toEqual([
			{
				toolCallId: "edit-b-3",
				toolName: "delete",
				path: "src/del.ts",
				exact: false,
			},
		]);
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
		expect(entries[0]?.path).toBe("src/f0.ts");
		expect(entries[MAX_PER_FILE_RESULTS - 1]?.path).toBe(
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
		expect(entries[3]?.path).toBe("src/big3.ts");
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

	test("an overlong display path is rejected before any filesystem I/O", async () => {
		const { cwd, cleanup } = await stage();
		try {
			// Mirrors the edit/delete path bound (audit-diff): an overlong
			// write target must not reach the snapshot read at all — the
			// evidence would never survive the message validator anyway.
			// (The read would also fail with ENAMETOOLONG past PATH_MAX, but
			// the rejection must be explicit and I/O-free, not incidental.)
			const candidate = await captureWriteCandidate({
				toolCallId: "write-overlong",
				args: {
					path: "p".repeat(MAX_EVIDENCE_PATH_LENGTH + 1),
					content: "x",
				},
				cwd,
			});
			expect(candidate).toBeUndefined();
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

describe("isPathInsideRoot (shared path-inside-root predicate)", () => {
	test("inside, equal, and deep descendants", () => {
		expect(isPathInsideRoot("/foo/bar", "/foo")).toBe(true);
		expect(isPathInsideRoot("/foo/bar/baz", "/foo/bar")).toBe(true);
		expect(isPathInsideRoot("/foo/bar", "/foo/bar")).toBe(true);
		expect(isPathInsideRoot("/foo", "/foo")).toBe(true);
	});

	test("outside and prefix-boundary lookalikes", () => {
		expect(isPathInsideRoot("/foo/barbaz", "/foo/bar")).toBe(false);
		expect(isPathInsideRoot("/foo", "/foo/bar")).toBe(false);
		expect(isPathInsideRoot("/elsewhere/x", "/foo")).toBe(false);
		expect(isPathInsideRoot("/foobar", "/foo")).toBe(false);
	});

	test("trailing slashes on the root are ignored", () => {
		expect(isPathInsideRoot("/foo/bar", "/foo/")).toBe(true);
		expect(isPathInsideRoot("/foo", "/foo//")).toBe(true);
		expect(isPathInsideRoot("/foo/barbaz", "/foo/bar/")).toBe(false);
	});

	test("root cwd special-case", () => {
		expect(isPathInsideRoot("/", "/")).toBe(true);
		expect(isPathInsideRoot("/a", "/")).toBe(true);
		expect(isPathInsideRoot("/a/b", "/")).toBe(true);
	});

	test("Windows-style absolutes and non-absolutes fail closed (POSIX-only)", () => {
		// Documented contract: both sides must start with `/`. Windows roots
		// and relatives are outside — confinement/config degrade fail-closed.
		expect(isPathInsideRoot("C:\\Users\\x", "C:\\Users")).toBe(false);
		expect(isPathInsideRoot("C:/Users/x", "C:/Users")).toBe(false);
		expect(isPathInsideRoot("\\\\server\\share\\a", "\\\\server\\share")).toBe(
			false,
		);
		expect(isPathInsideRoot("foo/bar", "foo")).toBe(false);
		expect(isPathInsideRoot("/foo/bar", "foo")).toBe(false);
		expect(isPathInsideRoot("foo", "/foo")).toBe(false);
		expect(isPathInsideRoot("", "/")).toBe(false);
		expect(isPathInsideRoot("/a", "")).toBe(false);
	});
});

describe("write audit pre-image confinement", () => {
	async function stage(): Promise<{
		root: string;
		outside: string;
		cleanup: () => Promise<void>;
	}> {
		const root = await mkdtemp(join(tmpdir(), "omp-compact-confine-root-"));
		const outside = await mkdtemp(join(tmpdir(), "omp-compact-confine-out-"));
		return {
			root,
			outside,
			cleanup: async () => {
				await rm(root, { recursive: true, force: true });
				await rm(outside, { recursive: true, force: true });
			},
		};
	}

	test("creation outside the root still yields exact +N|0", async () => {
		const { root, outside, cleanup } = await stage();
		try {
			const absolute = join(outside, "fresh.ts");
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-create-out",
				args: { path: absolute, content: "untrusted raw input" },
				cwd: root,
				root,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("");
			await writeFile(absolute, "one\ntwo\n");
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
					toolCallId: "confine-create-out",
					toolName: "write",
					path: absolute,
					added: 2,
					removed: 0,
					exact: true,
				},
			]);
		} finally {
			await cleanup();
		}
	});

	test("overwrite outside the root yields no candidate and no evidence", async () => {
		const { root, outside, cleanup } = await stage();
		try {
			const absolute = join(outside, "secret.ts");
			await writeFile(absolute, "pre-existing secret\nline two\n");
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-over-out",
				args: { path: absolute, content: "untrusted raw input" },
				cwd: root,
				root,
			});
			expect(candidate).toBeUndefined();
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: absolute },
				},
				false,
			);
			expect(entries).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("overwrite inside the root still yields exact evidence", async () => {
		const { root, cleanup } = await stage();
		try {
			await writeFile(join(root, "edit.ts"), "const a = 1;\nkeep();\n");
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-over-in",
				args: { path: "edit.ts", content: "untrusted raw input" },
				cwd: root,
				root,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("const a = 1;\nkeep();\n");
			await writeFile(
				join(root, "edit.ts"),
				"const a = 2;\nkeep();\nextra();\n",
			);
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(root, "edit.ts") },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "confine-over-in",
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

	test("completeWriteCandidate releases the pre-image after publishing evidence", async () => {
		const { root, cleanup } = await stage();
		try {
			await writeFile(join(root, "edit.ts"), "const a = 1;\nkeep();\n");
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-release-before",
				args: { path: "edit.ts", content: "untrusted raw input" },
				cwd: root,
				root,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("const a = 1;\nkeep();\n");
			await writeFile(
				join(root, "edit.ts"),
				"const a = 2;\nkeep();\nextra();\n",
			);
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(root, "edit.ts") },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "confine-release-before",
					toolName: "write",
					path: "edit.ts",
					added: 2,
					removed: 1,
					exact: true,
				},
			]);
			// Pre-image must not stay resident after the exact diff is done.
			expect(candidate?.before).toBe("");
		} finally {
			await cleanup();
		}
	});

	test("dangling symlink to an outside target is not treated as creation", async () => {
		const { root, outside, cleanup } = await stage();
		try {
			const outsideTarget = join(outside, "missing-secret");
			await symlink(outsideTarget, join(root, "escape"));
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-dangle",
				args: { path: "escape", content: "untrusted raw input" },
				cwd: root,
				root,
			});
			// Must not launder an out-of-root write as empty-before creation.
			expect(candidate).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	test("dangling in-root symlink yields exact +N|0 as creation", async () => {
		const { root, cleanup } = await stage();
		try {
			// Link lives inside the root; destination is missing. Existence of
			// the destination must decide creation — no content open on the
			// link path (boundedTextSync missingAsEmpty is not the path).
			const destination = join(root, "created.ts");
			await symlink(destination, join(root, "link.ts"));
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-dangle-in",
				args: { path: "link.ts", content: "untrusted raw input" },
				cwd: root,
				root,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("");
			// Native write through the link creates the destination file.
			await writeFile(destination, "one\ntwo\nthree\n");
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: destination },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "confine-dangle-in",
					toolName: "write",
					path: "link.ts",
					added: 3,
					removed: 0,
					exact: true,
				},
			]);
		} finally {
			await cleanup();
		}
	});

	test("in-root symlink to an existing file still yields exact overwrite stats", async () => {
		const { root, cleanup } = await stage();
		try {
			await writeFile(join(root, "target.ts"), "const a = 1;\nkeep();\n");
			await symlink("target.ts", join(root, "alias.ts"));
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-symlink-in",
				args: { path: "alias.ts", content: "untrusted raw input" },
				cwd: root,
				root,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("const a = 1;\nkeep();\n");
			await writeFile(
				join(root, "target.ts"),
				"const a = 2;\nkeep();\nextra();\n",
			);
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(root, "target.ts") },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "confine-symlink-in",
					toolName: "write",
					path: "alias.ts",
					added: 2,
					removed: 1,
					exact: true,
				},
			]);
		} finally {
			await cleanup();
		}
	});

	test("symlink to an existing outside file does not read the pre-image", async () => {
		const { root, outside, cleanup } = await stage();
		try {
			const outsideTarget = join(outside, "secret.ts");
			await writeFile(outsideTarget, "outside secret pre-image\n");
			await symlink(outsideTarget, join(root, "alias.ts"));
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-symlink-out",
				args: { path: "alias.ts", content: "untrusted raw input" },
				cwd: root,
				root,
			});
			expect(candidate).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	test("nested in-root symlink hop is not followed for pre-image", async () => {
		// Single-hop only: link → mid-link → outside must not treat the chain
		// as an in-root regular file (lstat on the first destination sees a
		// symlink, not a regular file).
		const { root, outside, cleanup } = await stage();
		try {
			const outsideTarget = join(outside, "secret.ts");
			await writeFile(outsideTarget, "nested-hop-secret-marker\n");
			const mid = join(root, "mid.ts");
			await symlink(outsideTarget, mid);
			await symlink(mid, join(root, "alias.ts"));
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-nested-hop",
				args: { path: "alias.ts", content: "untrusted raw input" },
				cwd: root,
				root,
			});
			expect(candidate).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	test("plain path swapped to outside symlink yields no evidence and no secret read", async () => {
		// TOCTOU contract: between the confinement lstat and the pre-image
		// open, a concurrent swap can replace an in-root regular file with a
		// symlink to an outside secret. The open must not follow that link
		// (O_NOFOLLOW); evidence is dropped fail-closed. A tight sibling
		// process hammers the swap while this process captures repeatedly —
		// the secret marker must never appear in a captured pre-image.
		const { root, outside, cleanup } = await stage();
		try {
			const victim = join(root, "victim.ts");
			const outsideTarget = join(outside, "secret.ts");
			const secret = "plain-path-toctou-secret-marker\n";
			await writeFile(outsideTarget, secret);
			await writeFile(victim, "safe pre-image\n");

			const swapper = Bun.spawn(
				[
					"bun",
					"-e",
					`
const { unlinkSync, symlinkSync, writeFileSync } = require("node:fs");
const victim = process.env.VICTIM;
const outsideTarget = process.env.OUTSIDE;
const stop = process.env.STOP;
const { existsSync } = require("node:fs");
while (!existsSync(stop)) {
  try { unlinkSync(victim); } catch {}
  try { symlinkSync(outsideTarget, victim); } catch {}
  try { unlinkSync(victim); } catch {}
  try { writeFileSync(victim, "safe pre-image\\n"); } catch {}
}
`,
				],
				{
					env: {
						...Bun.env,
						VICTIM: victim,
						OUTSIDE: outsideTarget,
						STOP: join(root, "stop"),
					},
					stdout: "ignore",
					stderr: "ignore",
				},
			);

			try {
				let sawUndefined = false;
				let sawSafe = false;
				for (let i = 0; i < 400; i++) {
					const candidate = await captureWriteCandidate({
						toolCallId: `confine-toctou-plain-${i}`,
						args: { path: "victim.ts", content: "untrusted raw input" },
						cwd: root,
						root,
					});
					if (candidate === undefined) {
						sawUndefined = true;
						continue;
					}
					expect(candidate.before).not.toContain(
						"plain-path-toctou-secret-marker",
					);
					if (candidate.before === "safe pre-image\n") sawSafe = true;
				}
				// The race must have been observable at least once either way;
				// the hard contract is "secret never leaks".
				expect(sawUndefined || sawSafe).toBe(true);
			} finally {
				await writeFile(join(root, "stop"), "1");
				swapper.kill();
				await swapper.exited.catch(() => undefined);
			}
		} finally {
			await cleanup();
		}
	});

	test("symlink path re-pointed outside during capture yields no secret read", async () => {
		// Confused-deputy / TOCTOU on the symlink branch: confinement keys
		// off the resolved destination, so the pre-image open must target
		// that destination (O_NOFOLLOW), not re-follow the link path. A
		// sibling process re-points the in-root link at an outside secret
		// while capture runs; the secret must never land in `before`.
		const { root, outside, cleanup } = await stage();
		try {
			const target = join(root, "target.ts");
			const alias = join(root, "alias.ts");
			const outsideTarget = join(outside, "secret.ts");
			const secret = "symlink-branch-toctou-secret-marker\n";
			await writeFile(target, "const a = 1;\nkeep();\n");
			await writeFile(outsideTarget, secret);
			await symlink(target, alias);

			const swapper = Bun.spawn(
				[
					"bun",
					"-e",
					`
const { unlinkSync, symlinkSync } = require("node:fs");
const { existsSync } = require("node:fs");
const alias = process.env.ALIAS;
const target = process.env.TARGET;
const outsideTarget = process.env.OUTSIDE;
const stop = process.env.STOP;
while (!existsSync(stop)) {
  try { unlinkSync(alias); } catch {}
  try { symlinkSync(outsideTarget, alias); } catch {}
  try { unlinkSync(alias); } catch {}
  try { symlinkSync(target, alias); } catch {}
}
`,
				],
				{
					env: {
						...Bun.env,
						ALIAS: alias,
						TARGET: target,
						OUTSIDE: outsideTarget,
						STOP: join(root, "stop"),
					},
					stdout: "ignore",
					stderr: "ignore",
				},
			);

			try {
				for (let i = 0; i < 400; i++) {
					const candidate = await captureWriteCandidate({
						toolCallId: `confine-toctou-link-${i}`,
						args: { path: "alias.ts", content: "untrusted raw input" },
						cwd: root,
						root,
					});
					if (candidate === undefined) continue;
					expect(candidate.before).not.toContain(
						"symlink-branch-toctou-secret-marker",
					);
				}
			} finally {
				await writeFile(join(root, "stop"), "1");
				swapper.kill();
				await swapper.exited.catch(() => undefined);
			}
		} finally {
			await cleanup();
		}
	});

	test("post-image path swapped to outside symlink yields no evidence and no secret read", async () => {
		// TOCTOU contract on the async after-read: between the completion-time
		// canonicalPath triple-check and boundedText's open, a concurrent swap
		// can replace the canonical final component with a symlink to an
		// outside secret. O_NOFOLLOW must refuse that open; evidence is dropped
		// fail-closed and the secret must never shape the published +N|−M.
		//
		// Capture once with a known pre-image, land the safe post-image, then
		// hammer completeWriteCandidate concurrently while a sibling process
		// flips the final component between the safe file and an outside
		// symlink. Cloning the candidate each time keeps `before` intact
		// (complete clears it in `finally`). The secret body is many lines so
		// a confused-deputy read is unmistakable in `added` — the hard
		// contract is that count never approaches the secret line count.
		const { root, outside, cleanup } = await stage();
		try {
			const victim = join(root, "victim.ts");
			const outsideTarget = join(outside, "secret.ts");
			const secretLines = 80;
			const secret = `${Array.from(
				{ length: secretLines },
				(_, i) => `post-image-toctou-secret-marker-${i}`,
			).join("\n")}\n`;
			const safeBefore = "safe before\n";
			const safeAfter = "safe before\nsafe after line\n";
			await writeFile(outsideTarget, secret);
			await writeFile(victim, safeBefore);

			const base = await captureWriteCandidate({
				toolCallId: "confine-toctou-post-base",
				args: { path: "victim.ts", content: "untrusted raw input" },
				cwd: root,
				root,
			});
			expect(base).toBeDefined();
			expect(base?.before).toBe(safeBefore);
			expect(typeof base?.displayPath).toBe("string");
			expect(typeof base?.absolutePath).toBe("string");
			expect(typeof base?.canonicalPath).toBe("string");
			const held = base as WriteCandidate & {
				displayPath: string;
				absolutePath: string;
				canonicalPath: string;
			};
			await writeFile(victim, safeAfter);

			const swapper = Bun.spawn(
				[
					"bun",
					"-e",
					`
const { unlinkSync, symlinkSync, writeFileSync, existsSync } = require("node:fs");
const victim = process.env.VICTIM;
const outsideTarget = process.env.OUTSIDE;
const stop = process.env.STOP;
const safeAfter = process.env.SAFE_AFTER;
while (!existsSync(stop)) {
  try { unlinkSync(victim); } catch {}
  try { symlinkSync(outsideTarget, victim); } catch {}
  try { unlinkSync(victim); } catch {}
  try { writeFileSync(victim, safeAfter); } catch {}
}
`,
				],
				{
					env: {
						...Bun.env,
						VICTIM: victim,
						OUTSIDE: outsideTarget,
						STOP: join(root, "stop"),
						SAFE_AFTER: safeAfter,
					},
					stdout: "ignore",
					stderr: "ignore",
				},
			);

			try {
				let sawEmpty = false;
				let sawSafe = false;
				let n = 0;
				// Accumulate worst-case `added` across the hammer instead of
				// asserting inside the time-boxed loop: the hard contract is
				// "no sample ever reaches the secret line count", which is
				// exactly `maxAdded < secretLines`. In-loop expects scale with
				// machine speed and poison the suite's quoted expect() total.
				let maxAdded = 0;
				const deadline = Date.now() + 2_500;
				while (Date.now() < deadline) {
					const batch: Promise<MutationMessageDetails[]>[] = [];
					for (let j = 0; j < 24; j++) {
						n += 1;
						batch.push(
							completeWriteCandidate(
								{
									toolCallId: `confine-toctou-post-${n}`,
									toolName: "write",
									displayPath: held.displayPath,
									absolutePath: held.absolutePath,
									canonicalPath: held.canonicalPath,
									// Fresh pre-image each time: complete clears
									// `before` in its finally block.
									before: safeBefore,
								},
								{
									content: [{ type: "text", text: "ok" }],
									details: { resolvedPath: victim },
								},
								false,
							),
						);
					}
					const results = await Promise.all(batch);
					for (const entries of results) {
						if (entries.length === 0) {
							sawEmpty = true;
							continue;
						}
						const entry = entries[0];
						if (entry === undefined) continue;
						// Confused-deputy read of the 80-line outside secret
						// yields added ≈ secretLines. Safe overwrite is +1|0.
						// Transient empty/partial races may publish other small
						// shapes — never a secret-sized added count.
						if (entry.added > maxAdded) maxAdded = entry.added;
						if (entry.added === 1 && entry.removed === 0) {
							sawSafe = true;
						}
					}
				}
				expect(n).toBeGreaterThan(0);
				expect(maxAdded).toBeLessThan(secretLines);
				// The race must have been observable at least once either way;
				// the hard contract is "secret never leaks".
				expect(sawEmpty || sawSafe).toBe(true);
			} finally {
				await writeFile(join(root, "stop"), "1");
				swapper.kill();
				await swapper.exited.catch(() => undefined);
			}
		} finally {
			await cleanup();
		}
	});

	test("post-image open of a fully-resolved canonical path still yields exact overwrite stats", async () => {
		// Judgment lock: completeWriteCandidate hands boundedText the
		// realpath'd effectiveResult, whose final component is never a
		// symlink. O_NOFOLLOW on that path is free — ordinary in-root
		// overwrite evidence must keep producing exact +N|−M.
		const { root, cleanup } = await stage();
		try {
			await writeFile(join(root, "edit.ts"), "const a = 1;\nkeep();\n");
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-post-canonical",
				args: { path: "edit.ts", content: "untrusted raw input" },
				cwd: root,
				root,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("const a = 1;\nkeep();\n");
			await writeFile(
				join(root, "edit.ts"),
				"const a = 2;\nkeep();\nextra();\n",
			);
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(root, "edit.ts") },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "confine-post-canonical",
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

	test("post-image via in-root symlink write still yields exact overwrite stats", async () => {
		// Judgment lock: the host's details.resolvedPath is the authored
		// absolute path (not realpath). completeWriteCandidate still opens
		// the realpath'd effectiveResult (destination), so an in-root
		// symlink write keeps exact evidence under O_NOFOLLOW on that
		// resolved destination — same as the pre-image one-hop branch.
		const { root, cleanup } = await stage();
		try {
			await writeFile(join(root, "target.ts"), "const a = 1;\nkeep();\n");
			await symlink("target.ts", join(root, "alias.ts"));
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-post-symlink",
				args: { path: "alias.ts", content: "untrusted raw input" },
				cwd: root,
				root,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("const a = 1;\nkeep();\n");
			await writeFile(
				join(root, "target.ts"),
				"const a = 2;\nkeep();\nextra();\n",
			);
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					// Host emits the authored absolute path, not realpath.
					details: { resolvedPath: join(root, "alias.ts") },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "confine-post-symlink",
					toolName: "write",
					path: "alias.ts",
					added: 2,
					removed: 1,
					exact: true,
				},
			]);
		} finally {
			await cleanup();
		}
	});

	test("empty create still yields no entry", async () => {
		const { root, cleanup } = await stage();
		try {
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-empty",
				args: { path: "empty.ts", content: "" },
				cwd: root,
				root,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("");
			await writeFile(join(root, "empty.ts"), "");
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(root, "empty.ts") },
				},
				false,
			);
			expect(entries).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("existing empty file inside the root still yields exact +N|0", async () => {
		const { root, cleanup } = await stage();
		try {
			await writeFile(join(root, "empty.ts"), "");
			const candidate = await captureWriteCandidate({
				toolCallId: "confine-empty-exist",
				args: { path: "empty.ts", content: "untrusted" },
				cwd: root,
				root,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("");
			await writeFile(join(root, "empty.ts"), "only\n");
			const entries = await completeWriteCandidate(
				candidate,
				{
					content: [{ type: "text", text: "ok" }],
					details: { resolvedPath: join(root, "empty.ts") },
				},
				false,
			);
			expect(entries).toEqual([
				{
					version: 1,
					toolCallId: "confine-empty-exist",
					toolName: "write",
					path: "empty.ts",
					added: 1,
					removed: 0,
					exact: true,
				},
			]);
		} finally {
			await cleanup();
		}
	});
});

describe("boundedTextSync special-file safety", () => {
	// The synchronous pre-image read must never block the main event loop on a
	// model-controlled path. A writer-less FIFO blocks a plain O_RDONLY open
	// inside open(2) forever, so the probe runs the real capture path in a
	// child process and the parent kills it on timeout — a pre-fix hang fails
	// the test instead of hanging the runner.
	const PROBE_TIMEOUT_MS = 3_000;
	const repoRoot = resolve(import.meta.dir, "../..");
	const PROBE_SCRIPT = `
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");
(async () => {
  try {
    const href =
      pathToFileURL(join(process.cwd(), ".omp-plugin", "audit.ts")).href +
      "?special-file-probe";
    const mod = await import(href);
    const result = await mod.captureWriteCandidate({
      toolCallId: "special-file-probe",
      args: { path: process.env.PROBE_PATH, content: "x" },
      cwd: process.cwd(),
    });
    console.log(JSON.stringify(result === undefined ? null : result));
    process.exit(0);
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(2);
  }
})();
`;

	const ASYNC_SWAP_PROBE_SCRIPT = `
const { pathToFileURL } = require("node:url");
const { dirname, join } = require("node:path");
const { unlinkSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
(async () => {
  try {
    const href =
      pathToFileURL(join(process.cwd(), ".omp-plugin", "audit.ts")).href +
      "?special-file-async-probe";
    const mod = await import(href);
    const probePath = process.env.PROBE_PATH;
    // Fixture lives under OS temp; pin the confinement root to the probe's
    // directory so overwrite capture is not silently disabled by the default
    // cwd=process.cwd() root (which is the repo, outside the fixture).
    const probeRoot = dirname(probePath);
    const candidate = await mod.captureWriteCandidate({
      toolCallId: "async-probe",
      args: { path: probePath, content: "x" },
      cwd: probeRoot,
      root: probeRoot,
    });
    if (!candidate) {
      console.log("null");
      process.exit(0);
    }
    // Swap the captured target for a writer-less FIFO, then complete.
    unlinkSync(probePath);
    const made = spawnSync("mkfifo", [probePath]);
    if (made.status !== 0) {
      console.error("mkfifo failed: " + String(made.stderr));
      process.exit(2);
    }
    const entries = await mod.completeWriteCandidate(
      candidate,
      {
        content: [{ type: "text", text: "ok" }],
        details: { resolvedPath: probePath },
      },
      false,
    );
    console.log(JSON.stringify(entries));
    process.exit(0);
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(2);
  }
})();
`;

	function mkfifo(path: string): void {
		const result = Bun.spawnSync(["mkfifo", path]);
		if (result.exitCode !== 0)
			throw new Error(`mkfifo ${path} failed (exit ${result.exitCode})`);
	}

	async function probeResult(fifo: string): Promise<unknown> {
		const child = Bun.spawn(["bun", "-e", PROBE_SCRIPT], {
			cwd: repoRoot,
			env: { ...Bun.env, PROBE_PATH: fifo },
			stdout: "pipe",
			stderr: "pipe",
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, PROBE_TIMEOUT_MS);
		const exitCode = await child.exited;
		clearTimeout(timer);
		if (timedOut)
			throw new Error(
				`boundedTextSync blocked opening the FIFO (killed after ${PROBE_TIMEOUT_MS}ms)`,
			);
		expect(exitCode ?? -1).toBe(0);
		const stdout = await new Response(child.stdout).text();
		return JSON.parse(stdout) as unknown;
	}

	async function stage(): Promise<{
		cwd: string;
		cleanup: () => Promise<void>;
	}> {
		const cwd = await mkdtemp(join(tmpdir(), "omp-compact-special-"));
		return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
	}

	test("a writer-less FIFO target returns promptly with no candidate (regression: no main-loop hang)", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const fifo = join(cwd, "pipe");
			mkfifo(fifo);
			expect(await probeResult(fifo)).toBeNull();
		} finally {
			await cleanup();
		}
	});

	test("a FIFO with a live writer stays fail-open with no candidate", async () => {
		const { cwd, cleanup } = await stage();
		const fifo = join(cwd, "pipe");
		mkfifo(fifo);
		const writer = Bun.spawn(["sh", "-c", 'exec 3>"$FIFO"; sleep 5'], {
			env: { ...Bun.env, FIFO: fifo },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			expect(await probeResult(fifo)).toBeNull();
		} finally {
			writer.kill();
			await cleanup();
		}
	});

	test("regular-file and symlink-to-regular snapshots stay exact", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const content = "const a = 1;\nkeep();\n";
			await writeFile(join(cwd, "target.ts"), content);
			await symlink("target.ts", join(cwd, "alias.ts"));
			const direct = await captureWriteCandidate({
				toolCallId: "special-reg-1",
				args: { path: "target.ts", content: "x" },
				cwd,
			});
			expect(direct?.before).toBe(content);
			const linked = await captureWriteCandidate({
				toolCallId: "special-reg-2",
				args: { path: "alias.ts", content: "x" },
				cwd,
			});
			expect(linked?.before).toBe(content);
		} finally {
			await cleanup();
		}
	});

	test("a character device target is rejected fail-open (no empty-before candidate)", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const candidate = await captureWriteCandidate({
				toolCallId: "special-dev",
				args: { path: "/dev/null", content: "x" },
				cwd,
			});
			expect(candidate).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	test("the async after-read returns promptly when the target is swapped to a writer-less FIFO", async () => {
		// The post-write read (completeWriteCandidate -> boundedText) must
		// never hang on a model-controlled path either. Capture a regular
		// file, then swap it for a writer-less FIFO and complete: a raw
		// Bun.file(path).text() would block forever on the FIFO; the
		// O_NONBLOCK-gated async read rejects it promptly. Runs in a child
		// so a pre-fix hang fails the test instead of the runner (max 10s).
		const { cwd, cleanup } = await stage();
		try {
			const target = join(cwd, "swap.ts");
			await writeFile(target, "const a = 1;\n");
			const child = Bun.spawn(["bun", "-e", ASYNC_SWAP_PROBE_SCRIPT], {
				cwd: repoRoot,
				env: { ...Bun.env, PROBE_PATH: target },
				stdout: "pipe",
				stderr: "pipe",
			});
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, 10_000);
			const exitCode = await child.exited;
			clearTimeout(timer);
			if (timedOut)
				throw new Error(
					"async after-read blocked on the swapped FIFO (killed after 10s)",
				);
			expect(exitCode ?? -1).toBe(0);
			const stdout = await new Response(child.stdout).text();
			expect(JSON.parse(stdout)).toEqual([]);
		} finally {
			await cleanup();
		}
	});
});

describe("exact bounded snapshot readers", () => {
	// The exact-size snapshot contract cannot be exercised through the real
	// file system deterministically: a regular file read returns the full
	// size in one syscall, so short reads, mid-read growth and mid-read
	// shrink are scripted through the injected reader (the production
	// default is node's readSync / FileHandle.read).
	type SyncRead = (
		fd: number,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	) => number;

	function scriptedSyncRead(chunks: number[]): SyncRead {
		let index = 0;
		return (_fd, buffer, offset, length, position) => {
			const count = Math.min(chunks[index] ?? 0, length);
			index += 1;
			if (count > 0) buffer.fill(0x41, offset, offset + count);
			void position;
			return count;
		};
	}

	function syncReadAll(
		_fd: number,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	): number {
		// A faithful single-call read of a `size`-byte file: returns at most
		// the remaining bytes (then EOF), never more than the stat size.
		const size = 10;
		const count = Math.max(0, Math.min(size - position, length));
		buffer.fill(0x41, offset, offset + count);
		return count;
	}

	type AsyncRead = (
		handle: unknown,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	) => Promise<number>;

	function scriptedAsyncRead(chunks: number[]): AsyncRead {
		let index = 0;
		return async (_handle, buffer, offset, length, position) => {
			const count = Math.min(chunks[index] ?? 0, length);
			index += 1;
			if (count > 0) buffer.fill(0x41, offset, offset + count);
			void position;
			return count;
		};
	}

	function asyncReadAll(
		_handle: unknown,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	): Promise<number> {
		const size = 10;
		const count = Math.max(0, Math.min(size - position, length));
		buffer.fill(0x41, offset, offset + count);
		return Promise.resolve(count);
	}

	test("readExactSync loops over short reads until the full size is met", () => {
		const buffer = readExactSync(1, 10, scriptedSyncRead([3, 3, 3, 1]));
		expect(buffer).toBeDefined();
		expect(buffer?.subarray(0, 10).every((byte) => byte === 0x41)).toBe(true);
	});

	test("readExactSync rejects a file that shrank between stat and read", () => {
		expect(readExactSync(1, 10, scriptedSyncRead([4, 0]))).toBeUndefined();
	});

	test("readExactSync rejects a file that grew between stat and read", () => {
		expect(readExactSync(1, 10, scriptedSyncRead([11]))).toBeUndefined();
	});

	test("readExactSync accepts an empty file", () => {
		const buffer = readExactSync(1, 0, scriptedSyncRead([0]));
		expect(buffer).toBeDefined();
		expect(buffer?.subarray(0, 0).length).toBe(0);
	});

	test("readExactSync reads a full-size file in one call", () => {
		const buffer = readExactSync(1, 10, syncReadAll);
		expect(buffer).toBeDefined();
		expect(buffer?.subarray(0, 10).every((byte) => byte === 0x41)).toBe(true);
	});

	test("readExactSync never reads past the snapshot byte bound", () => {
		const calls: number[] = [];
		const result = readExactSync(1, 1_048_576 + 1, (_fd, _b, _o, _l, _p) => {
			calls.push(1);
			return 0;
		});
		expect(result).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("readExactAsync loops over short reads until the full size is met", async () => {
		const buffer = await readExactAsync(
			{} as never,
			10,
			scriptedAsyncRead([3, 3, 3, 1]),
		);
		expect(buffer).toBeDefined();
		expect(buffer?.subarray(0, 10).every((byte) => byte === 0x41)).toBe(true);
	});

	test("readExactAsync rejects a file that shrank between stat and read", async () => {
		expect(
			await readExactAsync({} as never, 10, scriptedAsyncRead([4, 0])),
		).toBeUndefined();
	});

	test("readExactAsync rejects a file that grew between stat and read", async () => {
		expect(
			await readExactAsync({} as never, 10, scriptedAsyncRead([11])),
		).toBeUndefined();
	});

	test("readExactAsync accepts an empty file", async () => {
		const buffer = await readExactAsync({} as never, 0, scriptedAsyncRead([0]));
		expect(buffer).toBeDefined();
		expect(buffer?.subarray(0, 0).length).toBe(0);
	});

	test("readExactAsync reads a full-size file in one call", async () => {
		const buffer = await readExactAsync({} as never, 10, asyncReadAll);
		expect(buffer).toBeDefined();
		expect(buffer?.subarray(0, 10).every((byte) => byte === 0x41)).toBe(true);
	});
});
