import { expect, test } from "bun:test";

import pkg from "./package.json";

const scripts = pkg.scripts as Record<string, string | undefined>;

test("omp launcher loads the plugin and honors persisted mode and sessions", () => {
	const command = scripts.omp;

	expect(command).toBeDefined();
	expect(command).toContain("-u OMP_COMPACT_MODE");
	expect(command).toContain("-u OMP_COMPACT_PLUGIN");
	expect(command).toContain("./node_modules/.bin/omp");
	expect(command).toContain("-e ./index.ts");
	expect(command).not.toMatch(/OMP_COMPACT_MODE\s*=/);
	expect(command).not.toContain("--no-session");
	expect(scripts.live).toBeUndefined();
});

test("launcher exposes only supported compact modes", () => {
	expect(scripts.cards).toBeUndefined();
});
