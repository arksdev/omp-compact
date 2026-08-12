import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const repoRoot = resolve(import.meta.dir, "../..");
const execFileAsync = promisify(execFile);

async function exists(path: string): Promise<boolean> {
	return Bun.file(path).exists();
}

/** Repo-root-relative paths of every tracked file; throws when git cannot provide them. */
async function trackedFiles(): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
			cwd: repoRoot,
		});
		return stdout.split("\0").filter((path) => path.length > 0);
	} catch (error) {
		throw new Error(
			`cannot list tracked files with git ls-files: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
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
		const forbidden = (await trackedFiles()).filter(
			(path) =>
				path.startsWith("context/") || path.startsWith(".github/workflows/"),
		);
		expect(
			forbidden,
			"no tracked path may live under context/ or .github/workflows/",
		).toEqual([]);
	});

	test("ships the README demonstration media", async () => {
		for (const file of ["before.gif", "after.gif", "before.mp4", "after.mp4"]) {
			expect(
				await exists(join(repoRoot, "docs", "assets", file)),
				`missing docs/assets/${file}`,
			).toBe(true);
		}
		const english = await Bun.file(join(repoRoot, "README.md")).text();
		const russian = await Bun.file(join(repoRoot, "README.ru.md")).text();
		for (const file of ["before.gif", "after.gif", "before.mp4", "after.mp4"]) {
			expect(english).toContain(`docs/assets/${file}`);
			expect(russian).toContain(`docs/assets/${file}`);
		}
	});
});
