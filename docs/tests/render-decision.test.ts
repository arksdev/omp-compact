import { describe, expect, test } from "bun:test";

import {
	decideReadGroupRender,
	decideToolRender,
	type ReadGroupRenderInput,
	type ToolRenderInput,
} from "../../.omp-plugin/render-decision";

function toolInput(overrides: Partial<ToolRenderInput> = {}): ToolRenderInput {
	return {
		route: "compact",
		mode: "live",
		retainGitLive: false,
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

function groupInput(
	overrides: Partial<ReadGroupRenderInput> = {},
): ReadGroupRenderInput {
	return {
		mode: "live",
		phase: "working",
		expanded: false,
		completelyMapped: true,
		readCount: 1,
		...overrides,
	};
}

describe("decideToolRender: registry routing and native fallback", () => {
	test("unknown route fails open to native in every phase", () => {
		expect(decideToolRender(toolInput({ route: undefined }))).toEqual({
			kind: "native",
		});
		expect(
			decideToolRender(toolInput({ route: undefined, phase: "filtered" })),
		).toEqual({ kind: "native" });
		expect(
			decideToolRender(toolInput({ route: undefined, mode: "clear" })),
		).toEqual({ kind: "native" });
	});

	test("native-live route stays native in every mode and phase", () => {
		// Interactive stock chrome (ask) must never collapse into compact
		// rows or be hidden by filtered/clear retention — phase and mode
		// are irrelevant once the registry marks the tool native-live.
		for (const mode of ["live", "compact", "clear"] as const) {
			for (const phase of ["working", "filtered", "full"] as const) {
				expect(
					decideToolRender(
						toolInput({
							route: "native-live",
							mode,
							phase,
							// Exercise retention traps that previously stole
							// native-live after the run settled.
							hasMutations: false,
							hashesLength: 0,
							hasGit: false,
							expanded: false,
						}),
					),
				).toEqual({ kind: "native" });
			}
		}
	});
});
test("task route uses compact rows instead of native rendering", () => {
	for (const phase of ["working", "full"] as const) {
		expect(decideToolRender(toolInput({ route: "compact", phase }))).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			includeGit: true,
		});
	}
	expect(
		decideToolRender(
			toolInput({ route: "compact", phase: "filtered", hasMutations: true }),
		),
	).toEqual({
		kind: "tool-rows",
		filtered: true,
		summary: false,
		includeGit: false,
	});
});

describe("decideToolRender: clear mode matrix", () => {
	test("clear hides routine rows while working and at the terminal answer", () => {
		expect(decideToolRender(toolInput({ mode: "clear" }))).toEqual({
			kind: "empty",
		});
		expect(
			decideToolRender(toolInput({ mode: "clear", phase: "filtered" })),
		).toEqual({ kind: "empty" });
		// The clear rule precedes the expansion escape hatch.
		expect(
			decideToolRender(toolInput({ mode: "clear", expanded: true })),
		).toEqual({ kind: "empty" });
	});

	test("clear keeps compact diagnostic rows on abort/full", () => {
		expect(
			decideToolRender(toolInput({ mode: "clear", phase: "full" })),
		).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			includeGit: true,
		});
	});
});

describe("decideToolRender: filtered terminal matrix", () => {
	test("routine rows without retained evidence disappear", () => {
		expect(decideToolRender(toolInput({ phase: "filtered" }))).toEqual({
			kind: "empty",
		});
	});

	test("retainGitLive=false suppresses the aggregate summary entirely", () => {
		expect(
			decideToolRender(
				toolInput({
					phase: "filtered",
					hashesLength: 2,
					isAnchor: true,
					retainGitLive: false,
				}),
			),
		).toEqual({ kind: "empty" });
	});

	test("mutations survive without any commit hashes", () => {
		expect(
			decideToolRender(toolInput({ phase: "filtered", hasMutations: true })),
		).toEqual({
			kind: "tool-rows",
			filtered: true,
			summary: false,
			includeGit: false,
		});
	});

	test("the anchor state renders the aggregate summary after mutations", () => {
		expect(
			decideToolRender(
				toolInput({
					phase: "filtered",
					hasMutations: true,
					hashesLength: 2,
					isAnchor: true,
					retainGitLive: true,
				}),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: true,
			summary: true,
			includeGit: false,
		});
	});

	test("non-anchor states never render the summary row", () => {
		expect(
			decideToolRender(
				toolInput({
					phase: "filtered",
					hashesLength: 2,
					isAnchor: false,
					retainGitLive: true,
				}),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: true,
			summary: false,
			includeGit: false,
		});
	});

	test("expanded is not an escape hatch after the terminal answer", () => {
		expect(
			decideToolRender(
				toolInput({ phase: "filtered", expanded: true, hasMutations: true }),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: true,
			summary: false,
			includeGit: false,
		});
	});
});

describe("decideToolRender: working live matrix", () => {
	test("Git rows are visually suppressed in live without retainGitLive", () => {
		expect(
			decideToolRender(toolInput({ phase: "working", hasGit: true })),
		).toEqual({ kind: "empty" });
	});

	test("Git rows stay visible in live with retainGitLive", () => {
		expect(
			decideToolRender(
				toolInput({ phase: "working", hasGit: true, retainGitLive: true }),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			includeGit: true,
		});
	});

	test("expanded uses the native renderer as inspection escape hatch", () => {
		expect(decideToolRender(toolInput({ expanded: true }))).toEqual({
			kind: "native",
		});
		// Ordinary tools keep the hatch even while partial (hub/bash inspect).
		expect(
			decideToolRender(toolInput({ expanded: true, isPartial: true })),
		).toEqual({ kind: "native" });
		// Write/edit stream-collapse keeps compact while partial + expanded.
		expect(
			decideToolRender(
				toolInput({
					expanded: true,
					isPartial: true,
					streamCollapse: true,
				}),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			includeGit: true,
		});
		// After settle, write/edit regain the native hatch unless compactOnExpand.
		expect(
			decideToolRender(
				toolInput({
					expanded: true,
					isPartial: false,
					streamCollapse: true,
				}),
			),
		).toEqual({ kind: "native" });
	});

	test("routine compact rows render with Git evidence while working", () => {
		expect(
			decideToolRender(
				toolInput({ phase: "working", hasGit: true, retainGitLive: true }),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			includeGit: true,
		});
	});
});

describe("decideToolRender: compactOnExpand tools stay compact on expansion", () => {
	test("expanded compactOnExpand tools never fall back to native", () => {
		const base = {
			route: "compact" as const,
			expanded: true,
			compactOnExpand: true,
		};
		// working/live and working/compact render compact rows despite
		// explicit expansion.
		for (const mode of ["live", "compact"] as const) {
			expect(decideToolRender(toolInput({ ...base, mode }))).toEqual({
				kind: "tool-rows",
				filtered: false,
				summary: false,
				includeGit: true,
			});
		}
		// Git evidence stays visible while working when retained live.
		expect(
			decideToolRender(
				toolInput({ ...base, hasGit: true, retainGitLive: true }),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			includeGit: true,
		});
	});

	test("compactOnExpand tools follow clear suppression on expansion", () => {
		// clear working and terminal stay hidden (the clear rule precedes
		// the expansion escape hatch), never native.
		expect(
			decideToolRender(
				toolInput({
					compactOnExpand: true,
					expanded: true,
					mode: "clear",
				}),
			),
		).toEqual({ kind: "empty" });
		expect(
			decideToolRender(
				toolInput({
					compactOnExpand: true,
					expanded: true,
					mode: "clear",
					phase: "filtered",
				}),
			),
		).toEqual({ kind: "empty" });
		// clear abort keeps compact diagnostic rows.
		expect(
			decideToolRender(
				toolInput({
					compactOnExpand: true,
					expanded: true,
					mode: "clear",
					phase: "full",
				}),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			includeGit: true,
		});
	});

	test("compactOnExpand tools stay compact at the terminal and on full", () => {
		// filtered retention keeps mutation rows compact.
		expect(
			decideToolRender(
				toolInput({
					compactOnExpand: true,
					expanded: true,
					phase: "filtered",
					hasMutations: true,
				}),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: true,
			summary: false,
			includeGit: false,
		});
		// routine filtered rows without evidence still disappear.
		expect(
			decideToolRender(
				toolInput({
					compactOnExpand: true,
					expanded: true,
					phase: "filtered",
				}),
			),
		).toEqual({ kind: "empty" });
		// full keeps the complete compact log including Git rows.
		expect(
			decideToolRender(
				toolInput({
					compactOnExpand: true,
					expanded: true,
					phase: "full",
					hasGit: true,
				}),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			includeGit: true,
		});
	});

	test("ordinary compact tools keep the native expansion escape hatch", () => {
		expect(decideToolRender(toolInput({ expanded: true }))).toEqual({
			kind: "native",
		});
		// The escape hatch is scoped to the working phase only.
		expect(
			decideToolRender(
				toolInput({ expanded: true, phase: "full", hasGit: true }),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			includeGit: true,
		});
	});
});

describe("decideToolRender: full (abort/compact-terminal) matrix", () => {
	test("full keeps the complete compact log including Git rows", () => {
		expect(
			decideToolRender(toolInput({ phase: "full", hasGit: true })),
		).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			includeGit: true,
		});
	});

	test("full rows are immune to retainGitLive suppression", () => {
		expect(
			decideToolRender(
				toolInput({ phase: "full", hasGit: true, retainGitLive: false }),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			includeGit: true,
		});
	});
});

describe("decideReadGroupRender", () => {
	test("incompletely mapped groups stay native in every phase", () => {
		expect(
			decideReadGroupRender(groupInput({ completelyMapped: false })),
		).toEqual({ kind: "native" });
		expect(
			decideReadGroupRender(
				groupInput({ completelyMapped: false, phase: "filtered" }),
			),
		).toEqual({ kind: "native" });
		expect(
			decideReadGroupRender(
				groupInput({ completelyMapped: false, mode: "clear" }),
			),
		).toEqual({ kind: "native" });
	});

	test("all-or-nothing: partial mapping never yields compact rows", () => {
		// completelyMapped=false wins over every other compact-friendly input.
		// A future "partial bind" change would break this and reintroduce
		// misattribution of untracked native entries.
		const partial = groupInput({
			completelyMapped: false,
			readCount: 2,
			phase: "working",
			mode: "live",
			expanded: false,
		});
		expect(decideReadGroupRender(partial)).toEqual({ kind: "native" });
		expect(
			decideReadGroupRender({ ...partial, phase: "filtered", mode: "clear" }),
		).toEqual({ kind: "native" });
		expect(
			decideReadGroupRender({ ...partial, phase: "full", mode: "compact" }),
		).toEqual({ kind: "native" });
	});

	test("clear hides mapped read rows while working, keeps them on full", () => {
		expect(decideReadGroupRender(groupInput({ mode: "clear" }))).toEqual({
			kind: "empty",
		});
		expect(
			decideReadGroupRender(groupInput({ mode: "clear", phase: "filtered" })),
		).toEqual({ kind: "empty" });
		expect(
			decideReadGroupRender(groupInput({ mode: "clear", phase: "full" })),
		).toEqual({ kind: "read-rows" });
	});

	test("groups without a bound ledger are never hidden by clear", () => {
		expect(
			decideReadGroupRender(
				groupInput({ mode: "clear", phase: undefined, readCount: 0 }),
			),
		).toEqual({ kind: "native" });
	});

	test("filtered terminal answers remove the whole mapped group", () => {
		expect(decideReadGroupRender(groupInput({ phase: "filtered" }))).toEqual({
			kind: "empty",
		});
	});

	test("expanded groups keep the native renderer", () => {
		expect(decideReadGroupRender(groupInput({ expanded: true }))).toEqual({
			kind: "native",
		});
	});

	test("groups with no mapped reads render natively", () => {
		expect(decideReadGroupRender(groupInput({ readCount: 0 }))).toEqual({
			kind: "native",
		});
	});

	test("fully mapped groups render compact read rows", () => {
		expect(
			decideReadGroupRender(groupInput({ readCount: 3, phase: "full" })),
		).toEqual({ kind: "read-rows" });
	});
});
