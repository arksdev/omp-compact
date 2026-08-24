import { describe, expect, test } from "bun:test";

import {
	decideToolRender,
	type ToolRenderDecision,
	type ToolRenderInput,
} from "../../.omp-plugin/render-decision";
import {
	resolveToolRule,
	TOOL_RULES,
	type ToolRoute,
} from "../../.omp-plugin/tool-presentation-rules";

/**
 * ToolRoute is a hand-maintained string union whose members are enumerated
 * again by hand at the sites below. None of them is a checked `switch` (the
 * route dispatches are equality predicates, and `readonly ToolRoute[]` is
 * satisfied by a shorter array), so a fourth member added to the union but
 * forgotten at one site compiles clean and degrades silently:
 *
 *   - render-decision.ts:185,193 — the `route === undefined` /
 *     `route === "native-live"` head rules. A forgotten native-like member
 *     matches no head rule and inherits the compact default, so interactive
 *     chrome renders as dense rows instead of the stock card.
 *   - runtime-adapter.ts:397-403 — the early-allocation skip for
 *     `"native-live"` / `"read-group"`. A forgotten member gets an early
 *     compact state allocation instead of the native/group path.
 *   - render.ts:538 — the `route === "read-group"` separator choice. A
 *     forgotten read-like member renders with the colon separator.
 *   - replay-inventory.test.ts:50 (PRODUCTION_ROUTES) and
 *     tool-presentation-rules.test.ts:968 — `readonly ToolRoute[]` literals.
 *     A shorter array satisfies the type, exactly the weakness the
 *     `CompactMode[]` note in compact-mode-set.test.ts documents.
 *
 * Single-value sites (not enumerations; nothing to extend):
 *
 * tool-presentation-rules.ts:43 (the union itself) and the per-rule
 * `route` entries of TOOL_RULES.
 *
 * Extend-all rule: adding a union member MUST also extend every site above
 * and this EXPECTED_ROUTES table together. A new route is a behavioral
 * contract spanning the registry, the render-decision head rules, the
 * adapter's early-allocation skip and the row separator; the annotation
 * here makes a forgotten table entry a compile error (incomplete Record),
 * and the runtime assertions below fail when the registry or the
 * render-decision dispatch lags the union.
 */
const EXPECTED_ROUTES: Record<ToolRoute, true> = {
	compact: true,
	"read-group": true,
	"native-live": true,
};

/**
 * Presentation pin for every route the tool sink can observe. `read-group`
 * is deliberately excluded: it never reaches `decideToolRender` — the
 * adapter routes read-group tools through group binding and
 * `decideReadGroupRender` — so the sink's fallthrough for it is reachable
 * only through a wiring defect, and pinning its accidental output here
 * would bless that defect. A new member MUST be added below with its
 * intended presentation.
 */
const EXPECTED_DECISIONS: Record<
	Exclude<ToolRoute, "read-group">,
	ToolRenderDecision
> = {
	compact: {
		kind: "tool-rows",
		filtered: false,
		summary: false,
		summaryOnly: false,
		includeGit: true,
	},
	"native-live": { kind: "native" },
};

function toolInput(overrides: Partial<ToolRenderInput> = {}): ToolRenderInput {
	return {
		route: "compact",
		mode: "live",
		retainGitLive: false,
		compactSuppressedBySettings: false,
		phase: "working",
		expanded: false,
		isPartial: false,
		streamCollapse: false,
		compactOnExpand: false,
		hasMutations: false,
		hasGit: false,
		hashesLength: 0,
		isAnchor: false,
		...overrides,
	};
}

describe("ToolRoute set stays in step between the union and every dispatch site", () => {
	test("every union member is produced by at least one registry rule", () => {
		const produced = new Set(
			Object.values(TOOL_RULES)
				.filter((rule): rule is NonNullable<typeof rule> => rule !== undefined)
				.map((rule) => rule.route),
		);
		for (const route of Object.keys(EXPECTED_ROUTES) as ToolRoute[]) {
			expect(produced.has(route), route).toBe(true);
		}
	});

	test("every sink-observable union member has its pinned presentation", () => {
		const observed = Object.keys(EXPECTED_DECISIONS) as Array<
			Exclude<ToolRoute, "read-group">
		>;
		for (const route of observed) {
			expect(decideToolRender(toolInput({ route })), route).toEqual(
				EXPECTED_DECISIONS[route],
			);
		}
		// The exclusion is live, not stale: read-group-route tools must stay
		// in the group pipeline this guard documents.
		expect(resolveToolRule("read")?.route).toBe("read-group");
	});
});
