import { describe, expect, test } from "bun:test";

import { isVibeToolName } from "../../.omp-plugin/render";
import {
	resolveToolRule,
	TOOL_RULES,
} from "../../.omp-plugin/tool-presentation-rules";

// Stock vibe worker-session devices. Explicit inventory (like CANONICAL_NAMES
// in tool-presentation-rules.test.ts): the set lives in two tables — VIBE_OPS
// in render.ts (row grammar) and TOOL_RULES (presentation rule) — and this
// suite keeps them in sync. Growing the stock device set must extend both
// tables and this list together.
const VIBE_TOOL_NAMES = [
	"vibe_spawn",
	"vibe_send",
	"vibe_wait",
	"vibe_kill",
	"vibe_list",
];

describe("vibe tool-name sync", () => {
	test("every VIBE_OPS name is a registered TOOL_RULES rule", () => {
		// VIBE_OPS is module-private; the exported isVibeToolName probe is the
		// observable contract for its membership.
		for (const name of VIBE_TOOL_NAMES) {
			expect(isVibeToolName(name), name).toBe(true);
			expect(resolveToolRule(name), name).toBeDefined();
		}
	});

	test("every registered vibe_ rule is accepted by isVibeToolName", () => {
		const vibeRules = Object.keys(TOOL_RULES).filter((name) =>
			name.startsWith("vibe_"),
		);
		for (const name of vibeRules) {
			expect(isVibeToolName(name), name).toBe(true);
		}
	});

	test("the vibe rule inventory holds exactly the five stock devices", () => {
		const vibeRules = Object.keys(TOOL_RULES)
			.filter((name) => name.startsWith("vibe_"))
			.sort();
		expect(vibeRules).toEqual([...VIBE_TOOL_NAMES].sort());
	});
});
