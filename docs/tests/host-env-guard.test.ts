/**
 * Turns a missing stock host into a failure instead of an invisible skip.
 *
 * Every host-integrated suite gates itself on `OMP_STOCK_BIN`
 * (`const stockTest = binary ? test : test.skip`), so a run without that
 * variable reports `0 fail` while silently skipping 236 tests — including
 * every contract that covers the runtime adapter. The exit code stays 0, so
 * neither a human nor a CI job can tell the difference between a green run
 * and a run that never exercised the host.
 *
 * This guard is unconditional on purpose. `bun run test` sets the variable
 * itself, so the project's own gate keeps passing; only a run that bypasses
 * the script turns red, which is exactly the case that used to lie.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

test("OMP_STOCK_BIN points at the pinned stock host binary", () => {
	const binary = process.env.OMP_STOCK_BIN;
	expect(
		binary,
		"OMP_STOCK_BIN is unset: host-integrated suites would skip silently. Run `bun run test` (it sets the variable) or export OMP_STOCK_BIN=./node_modules/.bin/omp",
	).toBeTruthy();
	expect(
		existsSync(binary as string),
		`OMP_STOCK_BIN points at ${binary}, which does not exist. Run \`bun install\` to restore the pinned host`,
	).toBe(true);
});
