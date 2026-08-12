import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

async function exists(path: string): Promise<boolean> {
	return Bun.file(path).exists();
}

describe("public repository layout", () => {
	test("keeps production code and tests out of the root", async () => {
		const rootEntries = await readdir(repoRoot);
		expect(rootEntries.filter((name) => name.endsWith(".ts"))).toEqual([]);
		expect(rootEntries).not.toContain("replay");
		expect(rootEntries).not.toContain("hero.jpg");
		expect(await exists(join(repoRoot, ".omp-plugin", "index.ts"))).toBe(true);
		expect(
			await exists(join(repoRoot, "docs", "tests", "replay", "harness.ts")),
		).toBe(true);
		expect(await exists(join(repoRoot, "docs", "assets", "hero.jpg"))).toBe(
			true,
		);
	});

	test("does not track internal context or GitHub workflows", async () => {
		expect(await exists(join(repoRoot, "context"))).toBe(false);
		expect(await exists(join(repoRoot, ".github", "workflows"))).toBe(false);
	});
});
