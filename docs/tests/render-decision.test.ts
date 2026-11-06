import { describe, expect, test } from "bun:test";

import {
	type BackgroundCompletionRenderInput,
	decideBackgroundCompletionRender,
	decideToolRender,
	type ToolRenderInput,
} from "../../.omp-plugin/render-decision";

function toolInput(overrides: Partial<ToolRenderInput> = {}): ToolRenderInput {
	return {
		route: "compact",
		mode: "live",
		retainGitLive: false,
		compactSuppressedBySettings: false,
		phase: "working",
		hasMutations: false,
		hasGit: false,
		hashesLength: 0,
		isAnchor: false,
		...overrides,
	};
}

describe("decideToolRender: registry routing and native fallback", () => {
	test("an unknown tool gets omp's own row in every mode and phase", () => {
		for (const mode of ["live", "compact", "clear"] as const) {
			for (const phase of ["working", "filtered", "full"] as const) {
				expect(
					decideToolRender(toolInput({ route: undefined, mode, phase })),
				).toEqual({ kind: "host-compact" });
			}
		}
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
						}),
					),
				).toEqual({ kind: "native" });
			}
		}
	});
});

describe("decideToolRender: settings opt-out for a tool family", () => {
	test("suppressed tools render natively in every mode and phase", () => {
		// The user switched the family's compact rows off: the block must
		// reach the stock renderer exactly like an unregistered tool, so no
		// mode and no phase may divert it into rows or hide it.
		for (const mode of ["live", "compact", "clear"] as const) {
			for (const phase of ["working", "filtered", "full"] as const) {
				expect(
					decideToolRender(
						toolInput({
							route: "compact",
							compactSuppressedBySettings: true,
							mode,
							phase,
							hasMutations: true,
							hasGit: true,
							hashesLength: 2,
							isAnchor: true,
							retainGitLive: true,
						}),
					),
				).toEqual({ kind: "native" });
			}
		}
	});

	test("the same input renders compact rows while the setting is on", () => {
		expect(
			decideToolRender(
				toolInput({ route: "compact", compactSuppressedBySettings: false }),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			summaryOnly: false,
			includeGit: true,
		});
		expect(
			decideToolRender(
				toolInput({
					route: "compact",
					compactSuppressedBySettings: false,
					phase: "filtered",
					hasMutations: true,
				}),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: true,
			summary: false,
			summaryOnly: false,
			includeGit: false,
		});
	});

	test("suppression never resurrects a native-live tool as rows", () => {
		// Belt and braces on rule order: native-live already wins, and the
		// opt-out agrees with it instead of reordering the head rules.
		expect(
			decideToolRender(
				toolInput({
					route: "native-live",
					compactSuppressedBySettings: true,
				}),
			),
		).toEqual({ kind: "native" });
	});
});
test("task route uses compact rows instead of native rendering", () => {
	for (const phase of ["working", "full"] as const) {
		expect(decideToolRender(toolInput({ route: "compact", phase }))).toEqual({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			summaryOnly: false,
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
		summaryOnly: false,
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
	});

	test("clear hides routine rows on abort and error too", () => {
		// An interrupted or failed turn used to keep its diagnostic rows here.
		// That broke the promise of the quiet view, which is the whole reason
		// the mode exists; diagnostics belong to `live` and `compact`.
		expect(
			decideToolRender(toolInput({ mode: "clear", phase: "full" })),
		).toEqual({ kind: "empty" });
	});

	test("clear keeps the commit summary of an interrupted turn", () => {
		// The commits exist whether or not the turn reached an answer, and the
		// quiet view gets no second chance to show them.
		expect(
			decideToolRender(
				toolInput({
					mode: "clear",
					phase: "full",
					retainGitLive: true,
					hasMutations: true,
					hasGit: true,
					hashesLength: 1,
					isAnchor: true,
				}),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: true,
			summary: true,
			summaryOnly: true,
			includeGit: false,
		});
	});

	test("clear keeps the commit summary when the Git toggle is on", () => {
		// Created commits are the one thing the quiet view must not swallow:
		// the anchor renders the aggregate hash line and nothing else — no
		// mutation rows, no individual Git rows.
		expect(
			decideToolRender(
				toolInput({
					mode: "clear",
					phase: "filtered",
					retainGitLive: true,
					hasMutations: true,
					hasGit: true,
					hashesLength: 2,
					isAnchor: true,
				}),
			),
		).toEqual({
			kind: "tool-rows",
			filtered: true,
			summary: true,
			summaryOnly: true,
			includeGit: false,
		});
	});

	test("clear drops the commit summary when the Git toggle is off", () => {
		// The toggle zeroes the effective hash count, so the exception
		// collapses back to plain hiding.
		expect(
			decideToolRender(
				toolInput({
					mode: "clear",
					phase: "filtered",
					retainGitLive: false,
					hasMutations: true,
					hasGit: true,
					hashesLength: 2,
					isAnchor: true,
				}),
			),
		).toEqual({ kind: "empty" });
	});

	test("clear hides a non-anchor row even when the run created commits", () => {
		// Only the anchor carries the aggregate line; every other row of the
		// run stays hidden, mutations included.
		expect(
			decideToolRender(
				toolInput({
					mode: "clear",
					phase: "filtered",
					retainGitLive: true,
					hasMutations: true,
					hashesLength: 2,
					isAnchor: false,
				}),
			),
		).toEqual({ kind: "empty" });
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
			summaryOnly: false,
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
			summaryOnly: false,
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
			summaryOnly: false,
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
			summaryOnly: false,
			includeGit: true,
		});
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
			summaryOnly: false,
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
			summaryOnly: false,
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
			summaryOnly: false,
			includeGit: true,
		});
	});
});

function completionInput(
	overrides: Partial<BackgroundCompletionRenderInput> = {},
): BackgroundCompletionRenderInput {
	return { mode: "live", phase: "working", ...overrides };
}

describe("decideBackgroundCompletionRender", () => {
	test("a working run shows the host's own completion line", () => {
		expect(decideBackgroundCompletionRender(completionInput())).toEqual({
			kind: "native",
		});
		expect(
			decideBackgroundCompletionRender(completionInput({ mode: "compact" })),
		).toEqual({ kind: "native" });
	});

	test("the terminal answer drops the notice in every mode", () => {
		expect(
			decideBackgroundCompletionRender(completionInput({ phase: "filtered" })),
		).toEqual({ kind: "empty" });
		expect(
			decideBackgroundCompletionRender(
				completionInput({ phase: "filtered", mode: "compact" }),
			),
		).toEqual({ kind: "empty" });
	});

	test("clear hides the notice in every phase", () => {
		expect(
			decideBackgroundCompletionRender(completionInput({ mode: "clear" })),
		).toEqual({ kind: "empty" });
		expect(
			decideBackgroundCompletionRender(
				completionInput({ mode: "clear", phase: "full" }),
			),
		).toEqual({ kind: "empty" });
	});

	test("a notice outside any run follows how history is presented", () => {
		// No run owns a restored notice, so it matches its surroundings:
		// `compact` shows restored history in full, the other modes fold it
		// away. Showing the line unconditionally left it as the single
		// surviving row of an otherwise folded history.
		expect(
			decideBackgroundCompletionRender(
				completionInput({ phase: undefined, mode: "compact" }),
			),
		).toEqual({ kind: "native" });
		expect(
			decideBackgroundCompletionRender(completionInput({ phase: undefined })),
		).toEqual({ kind: "empty" });
		expect(
			decideBackgroundCompletionRender(
				completionInput({ phase: undefined, mode: "clear" }),
			),
		).toEqual({ kind: "empty" });
	});
});
