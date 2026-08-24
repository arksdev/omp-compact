import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	completeEditMutations,
	countDiffChanges,
} from "../../.omp-plugin/audit-diff";
import { loadStockPlugin } from "./test-stock-host";

/**
 * Cross-route guard mirrors and the write path's scheme/compound guards,
 * pinned at their observable boundaries:
 *
 * - The write snapshot byte cap (SNAPSHOT_MAX_BYTES), the edit diff byte cap
 *   (MAX_DIFF_BYTES) and the delete pre-image byte cap (MAX_DELETE_BYTES) are
 *   documented mirrors of one another ("mirrors the write snapshot byte
 *   cap"); a drift between them would let one route accept evidence the
 *   others reject. The write snapshot line cap and the delete line cap are
 *   likewise documented mirrors.
 * - The write path's URI-scheme guard (second line of defence behind the
 *   `xd://` device-routing decision) must reject every `scheme://` form —
 *   not only the device schemes it is named after — before any filesystem
 *   I/O, along with compound archive targets and `:conflicts` selectors.
 */

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
}

let auditModule: AuditModule;

beforeAll(async () => {
	// The write audit depends on stock @oh-my-pi modules, which resolve from
	// the repository's exact root development dependencies.
	auditModule = await loadStockPlugin<AuditModule>("audit.ts", "audi-guards");
});

async function stage(): Promise<{
	cwd: string;
	cleanup: () => Promise<void>;
}> {
	const cwd = await mkdtemp(join(tmpdir(), "omp-compact-guards-"));
	return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

function captureWriteCandidate(input: {
	toolCallId: string;
	args: unknown;
	cwd: string;
	root?: string;
}): Promise<WriteCandidate | undefined> {
	return auditModule.captureWriteCandidate(input);
}

/** A numbered-countable unified diff of exactly `length` characters. */
function unifiedDiffOfLength(length: number): string {
	const header = "@@ -0,0 +1,1 @@\n+";
	return `${header}${"a".repeat(length - header.length - 1)}\n`;
}

describe("route budget mirrors", () => {
	test("write, edit and delete agree on the 1 MiB byte bound at exactly-at and just-over", async () => {
		const { cwd, cleanup } = await stage();
		try {
			// Write: the snapshot byte cap is enforced before any diff.
			const exact = "b".repeat(1_048_576);
			await writeFile(join(cwd, "exact.ts"), exact);
			const atBound = await captureWriteCandidate({
				toolCallId: "w-at",
				args: { path: "exact.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(atBound).toBeDefined();
			expect(atBound?.before).toBe(exact);

			await writeFile(join(cwd, "over.ts"), "b".repeat(1_048_577));
			const overBound = await captureWriteCandidate({
				toolCallId: "w-over",
				args: { path: "over.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(overBound).toBeUndefined();

			// Edit: the per-file diff byte cap.
			expect(countDiffChanges(unifiedDiffOfLength(1_048_576))).toEqual({
				added: 1,
				removed: 0,
			});
			expect(countDiffChanges(unifiedDiffOfLength(1_048_577))).toBeUndefined();

			// Delete: the pre-image byte cap keeps the row but drops exact
			// stats — the mirror of the write route dropping the candidate.
			const exactDelete = completeEditMutations(
				"d",
				{
					details: {
						op: "delete",
						path: "d.ts",
						oldText: "a".repeat(1_048_576),
					},
				},
				false,
			);
			expect(exactDelete).toHaveLength(1);
			expect(exactDelete[0]).toMatchObject({ removed: 1, exact: true });
			const overDelete = completeEditMutations(
				"d",
				{
					details: {
						op: "delete",
						path: "d.ts",
						oldText: "a".repeat(1_048_577),
					},
				},
				false,
			);
			expect(overDelete).toHaveLength(1);
			expect(overDelete[0]).toMatchObject({ exact: false });
		} finally {
			await cleanup();
		}
	});

	test("write and delete agree on the 50 000-line gate at exactly-at and just-over", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const atLines = "x\n".repeat(50_000);
			await writeFile(join(cwd, "at-lines.ts"), atLines);
			const atBound = await captureWriteCandidate({
				toolCallId: "w-at-lines",
				args: { path: "at-lines.ts", content: "x" },
				cwd,
			});
			expect(atBound).toBeDefined();
			expect(atBound?.before).toBe(atLines);

			const overLines = "x\n".repeat(50_001);
			await writeFile(join(cwd, "over-lines.ts"), overLines);
			const overBound = await captureWriteCandidate({
				toolCallId: "w-over-lines",
				args: { path: "over-lines.ts", content: "x" },
				cwd,
			});
			expect(overBound).toBeUndefined();

			const atDelete = completeEditMutations(
				"d",
				{
					details: {
						op: "delete",
						path: "d.ts",
						oldText: "x\n".repeat(50_000),
					},
				},
				false,
			);
			expect(atDelete).toHaveLength(1);
			expect(atDelete[0]).toMatchObject({ removed: 50_000, exact: true });
			const overDelete = completeEditMutations(
				"d",
				{
					details: {
						op: "delete",
						path: "d.ts",
						oldText: "x\n".repeat(50_001),
					},
				},
				false,
			);
			expect(overDelete).toHaveLength(1);
			expect(overDelete[0]).toMatchObject({ exact: false });
		} finally {
			await cleanup();
		}
	});
});

describe("write path URI and compound guards", () => {
	test("every scheme:// URI form is rejected before any filesystem I/O", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const schemePaths = [
				"xd://mcp__github/x/y", // the device form the guard is named after
				"file:///tmp/secret.ts", // any other scheme:// form: second line
				"HTTPS://example.com/x.ts", // case-insensitive scheme match
			];
			for (const path of schemePaths) {
				const candidate = await captureWriteCandidate({
					toolCallId: "w-scheme",
					args: { path, content: "x" },
					cwd,
				});
				expect(
					candidate,
					`expected ${path} to be rejected as a non-file target`,
				).toBeUndefined();
			}
		} finally {
			await cleanup();
		}
	});

	test("compound archive targets and :conflicts selectors are rejected like the scheme guard", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const compound = await captureWriteCandidate({
				toolCallId: "w-compound",
				args: { path: "notes.zip:inner/readme.md", content: "x" },
				cwd,
			});
			expect(compound).toBeUndefined();
			const conflicts = await captureWriteCandidate({
				toolCallId: "w-conflicts",
				args: { path: "p.ts:conflicts", content: "x" },
				cwd,
			});
			expect(conflicts).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	test("a scheme without // is a plain filename, not a device target", async () => {
		const { cwd, cleanup } = await stage();
		try {
			// `xd:bare` is not an xd:// device dispatch (stock parseXdUrl
			// grammar) and not a scheme:// URI; the guard leaves it to the
			// file route, where a missing file becomes a creation candidate.
			const candidate = await captureWriteCandidate({
				toolCallId: "w-bare",
				args: { path: "xd:bare", content: "x" },
				cwd,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("");
		} finally {
			await cleanup();
		}
	});
});
