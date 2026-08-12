/**
 * Golden replay tests for the omp-compact replay-fixture corpus.
 *
 * Every fixture in `replay/fixtures/` is a bounded, redacted, normalized
 * event stream derived from a real OMP session (see `replay/extract.ts` and
 * each fixture's `meta` for provenance). Each test boots the plugin through
 * the stock runtime host modules, replays the fixture events in order
 * through the same seams as `index.integration.test.ts`, and asserts the
 * observable final projection: the transcript rows and the persisted
 * carrier entries (`appendedEntries`), in order.
 *
 * Regenerate goldens after intentional behavior changes:
 *   OMP_REPLAY_UPDATE=1 bun run test -- replay.test.ts
 */
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ReplayFixture, replayFixture } from "./replay/harness";

const binary = process.env.OMP_STOCK_BIN;
const stockTest = binary ? test : test.skip;
const update = process.env.OMP_REPLAY_UPDATE === "1";

const fixturesDir = join(import.meta.dir, "replay", "fixtures");
const goldenDir = join(import.meta.dir, "replay", "golden");

interface Golden {
	rows: string[];
	carriers: Array<{ customType: string; data?: unknown }>;
}

const fixtureFiles = readdirSync(fixturesDir)
	.filter((file) => file.endsWith(".json"))
	.sort();

for (const file of fixtureFiles) {
	const fixture = JSON.parse(
		readFileSync(join(fixturesDir, file), "utf8"),
	) as ReplayFixture;
	const id = fixture.meta.id;
	stockTest(
		`replay golden: ${id} (${fixture.meta.mode} mode, ${fixture.meta.terminal} terminal)`,
		async () => {
			const { outcome } = await replayFixture(fixture);
			const golden: Golden = {
				rows: outcome.rows,
				carriers: outcome.carriers,
			};
			const goldenPath = join(goldenDir, `${id}.json`);
			if (update) {
				mkdirSync(goldenDir, { recursive: true });
				writeFileSync(goldenPath, `${JSON.stringify(golden, null, 2)}\n`);
				return;
			}
			const expected = JSON.parse(readFileSync(goldenPath, "utf8")) as Golden;
			expect(outcome.rows).toEqual(expected.rows);
			expect(outcome.carriers).toEqual(expected.carriers);
		},
	);
}

// The corpus itself must stay bounded and hermetic: every fixture declares
// its replay settings and never reaches outside the sandbox cwd.
stockTest("fixture corpus stays bounded and hermetic", () => {
	for (const file of fixtureFiles) {
		const fixture = JSON.parse(
			readFileSync(join(fixturesDir, file), "utf8"),
		) as ReplayFixture;
		expect(fixture.meta.cwd).toBe("/repo");
		expect(["live", "compact", "clear"]).toContain(fixture.meta.mode);
		expect(fixture.meta.sourceKind).toBe("session-jsonl");
		expect(fixture.meta.source.length).toBeGreaterThan(0);
		const bytes = readFileSync(join(fixturesDir, file)).byteLength;
		expect(bytes).toBeLessThan(120_000);
	}
});
