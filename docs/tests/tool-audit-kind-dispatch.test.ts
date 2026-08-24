import { describe, expect, test } from "bun:test";

import {
	type ToolAuditKind,
	TOOL_RULES,
} from "../../.omp-plugin/tool-presentation-rules";

/**
 * ToolAuditKind is dispatched by two hand-written switches in the wiring,
 * and neither has a `default` clause:
 *   - index.ts:842  tool_execution_start — cases `write`, `git-bash` only
 *   - index.ts:897  tool_execution_end   — cases `write`, `edit`, `git-bash`
 * `resolveToolAudit` falls through to native when a case is missing, so a
 * fifth union member compiles clean and is silently unaudited at both sites:
 * a start-site miss means no pre-image capture (write) or no command capture
 * (git-bash); an end-site miss means the kind's mutations never persist, so
 * the rows lose their mutation view and nothing reports it. Extend BOTH
 * switches when adding a kind.
 *
 * The `edit` asymmetry is intentional, not a bug: the start switch has no
 * `edit` case because completeEditMutations (audit-diff.ts) derives the
 * mutations from the result alone, so edit needs no pre-image. Do not make
 * the switches symmetric to "fix" it.
 *
 * This test pins only the union's membership — the strongest assertion
 * reachable while index.ts stays untouched. The annotation on
 * EXPECTED_KINDS makes a fifth member a compile error here (incomplete
 * record), and the runtime assertion fails when a rule's static `.audit`
 * value is not one of the four.
 */
const EXPECTED_KINDS: Record<ToolAuditKind, true> = {
	none: true,
	write: true,
	edit: true,
	"git-bash": true,
};

describe("tool audit kinds stay in step with the dispatch wiring", () => {
	test("the static audit kinds are exactly the union's members", () => {
		const staticKinds: Partial<Record<ToolAuditKind, true>> = { none: true };
		for (const rule of Object.values(TOOL_RULES)) {
			if (rule === undefined) continue;
			staticKinds[rule.audit] = true;
		}
		expect(Object.keys(staticKinds).sort()).toEqual(
			Object.keys(EXPECTED_KINDS).sort(),
		);
	});
});
