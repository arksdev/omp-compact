import { beforeAll, describe, expect, test } from "bun:test";
import type { FileHandle } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExactAsync, readExactSync } from "../../.omp-plugin/audit";
import type { MutationMessageDetails } from "../../.omp-plugin/messages";
import { loadStockPlugin } from "./test-stock-host";

/**
 * Sync/async snapshot twins — same logic, both I/O flavors. The sync side
 * exists so the write pre-image is captured before the first await (stock
 * fire-and-forget start listener); the async side reads the post-image
 * without blocking the loop. A gate drifting in one flavor only would let
 * the pre-image and the post-image disagree on what a valid snapshot is, so
 * both flavors are pinned at the same boundaries:
 *
 * - readExactSync/readExactAsync reject the same over-bound sizes before
 *   touching the descriptor (the byte gate is the first statement in both).
 * - The async post-image reader (boundedText, reached through
 *   completeWriteCandidate) enforces the byte and line gates at the same
 *   thresholds as the sync pre-image reader (boundedTextSync, pinned
 *   end-to-end in audit-route-guards.test.ts).
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
	auditModule = await loadStockPlugin<AuditModule>("audit.ts", "audit-twins");
});

async function stage(): Promise<{
	cwd: string;
	cleanup: () => Promise<void>;
}> {
	const cwd = await mkdtemp(join(tmpdir(), "omp-compact-twins-"));
	return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

function writeResult(resolvedPath: string): {
	details: { resolvedPath: string };
} {
	return { details: { resolvedPath } };
}

describe("snapshot reader twins", () => {
	test("both readers reject an over-bound size before touching the descriptor", async () => {
		// The byte gate is the first statement in both readers; the fd
		// argument is never reached for an over-bound size.
		expect(readExactSync(42, 1_048_577)).toBeUndefined();
		await expect(
			readExactAsync({} as FileHandle, 1_048_577),
		).resolves.toBeUndefined();
	});
});

describe("async post-image gates mirror the sync pre-image gates", () => {
	test("the post-image byte gate accepts exactly 1 MiB and rejects one byte over", async () => {
		const { cwd, cleanup } = await stage();
		try {
			// Creation path: no pre-file, so the candidate is captured with an
			// empty before; only the post-image read is exercised.
			const candidate = await auditModule.captureWriteCandidate({
				toolCallId: "w-post-byte",
				args: { path: "post.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(candidate).toBeDefined();
			expect(candidate?.before).toBe("");

			await writeFile(join(cwd, "post.ts"), "b".repeat(1_048_576));
			const atBound = await auditModule.completeWriteCandidate(
				candidate,
				writeResult(join(cwd, "post.ts")),
				false,
			);
			expect(atBound).toHaveLength(1);
			expect(atBound[0]).toMatchObject({ added: 1, removed: 0 });

			await writeFile(join(cwd, "post.ts"), "b".repeat(1_048_577));
			const overBound = await auditModule.completeWriteCandidate(
				candidate,
				writeResult(join(cwd, "post.ts")),
				false,
			);
			expect(overBound).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("the post-image line gate accepts exactly 50 000 lines and rejects one line over", async () => {
		const { cwd, cleanup } = await stage();
		try {
			const line = (seed: string, index: number): string =>
				`${seed}${String(index).padStart(6, "0")}\n`;
			const file = (count: number): string =>
				Array.from({ length: count }, (_, index) => line("x", index)).join("");

			const beforeText = file(50_000);
			await writeFile(join(cwd, "before.ts"), beforeText);
			const candidate = await auditModule.captureWriteCandidate({
				toolCallId: "w-post-lines",
				args: { path: "before.ts", content: "untrusted raw input" },
				cwd,
			});
			expect(candidate).toBeDefined();
			// The sync pre-image reader accepts 50_000 lines exactly.
			expect(candidate?.before).toBe(beforeText);

			// One-line change in the middle: the diff gate (4_000 middle
			// lines) is far below, so the line gate is what is exercised.
			// The write targets the captured file itself — the triple
			// canonical equality pins the completion read to the snapshot
			// path, so the pre-image and the post-image share one file.
			const afterText = file(50_000).replace(
				`x${String(25_000).padStart(6, "0")}`,
				"changed-but-same-length",
			);
			await writeFile(join(cwd, "before.ts"), afterText);
			const atBound = await auditModule.completeWriteCandidate(
				candidate,
				writeResult(join(cwd, "before.ts")),
				false,
			);
			expect(atBound).toHaveLength(1);
			expect(atBound[0]).toMatchObject({ added: 1, removed: 1 });

			await writeFile(join(cwd, "before.ts"), file(50_001));
			const overBound = await auditModule.completeWriteCandidate(
				candidate,
				writeResult(join(cwd, "before.ts")),
				false,
			);
			expect(overBound).toEqual([]);
		} finally {
			await cleanup();
		}
	});
});
