/**
 * The `omp` script is how a developer launches the host with this plugin
 * loaded. Two properties of it are load-bearing; the rest of the string is
 * formatting.
 *
 * The previous version asserted the presence of five literal fragments and
 * the absence of two long-deleted scripts. Reordering the flags broke it
 * while the launcher still worked, and nothing returns a removed script by
 * accident.
 */
import { expect, test } from "bun:test";

import pkg from "../../package.json";

const scripts = pkg.scripts as Record<string, string | undefined>;

test("the omp launcher loads this plugin and no other extension", () => {
	const command = scripts.omp;
	expect(command).toBeDefined();
	// Loading the plugin under test is the point of the script.
	expect(command).toContain("./.omp-plugin/index.ts");
	// Without this, a developer's globally installed extensions join the
	// session and the observed behavior stops being this plugin's.
	expect(command).toContain("--no-extensions");
});

test("the launcher inherits the persisted mode instead of pinning one", () => {
	const command = scripts.omp;
	// `-u NAME` unsets the variable so the plugin falls back to its persisted
	// config; `NAME=value` would freeze every launch into one mode and make
	// the mode-switch commands unobservable in a real session.
	expect(command).toContain("-u OMP_COMPACT_MODE");
	expect(command).not.toMatch(/OMP_COMPACT_MODE\s*=/);
});

test("the gate script runs the suite against the pinned host", () => {
	// host-env-guard.test.ts fails the run without OMP_STOCK_BIN, so this
	// assignment is what keeps the stock-host suites from skipping silently.
	expect(scripts.test).toContain("OMP_STOCK_BIN=");
	expect(scripts.check).toContain("bun run test");
});
