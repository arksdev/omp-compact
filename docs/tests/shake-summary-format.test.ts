import { describe, expect, test } from "bun:test";

import {
	formatShakeSummary,
	type ShakeResultLike,
} from "../../.omp-plugin/post-turn-shake";

function shakeResult(
	overrides: Partial<ShakeResultLike> = {},
): ShakeResultLike {
	return {
		mode: "elide",
		toolResultsDropped: 3,
		blocksDropped: 1,
		tokensFreed: 12_000,
		...overrides,
	};
}

describe("formatShakeSummary thinking mode", () => {
	test("thinking mode drops blocks with the stock plural form", () => {
		expect(
			formatShakeSummary(
				shakeResult({ mode: "thinking", thinkingBlocksDropped: 2 }),
			),
		).toBe(
			"Dropped 2 thinking blocks from this session (~12000 tokens freed).",
		);
	});

	test("thinking mode keeps the singular at exactly one block", () => {
		expect(
			formatShakeSummary(
				shakeResult({ mode: "thinking", thinkingBlocksDropped: 1 }),
			),
		).toBe("Dropped 1 thinking block from this session (~12000 tokens freed).");
	});

	test("thinking mode omits the token suffix when nothing was freed", () => {
		expect(
			formatShakeSummary(
				shakeResult({
					mode: "thinking",
					thinkingBlocksDropped: 2,
					tokensFreed: 0,
				}),
			),
		).toBe("Dropped 2 thinking blocks from this session.");
	});

	test("thinking mode with no blocks reports the stock no-op line", () => {
		expect(
			formatShakeSummary(
				shakeResult({ mode: "thinking", thinkingBlocksDropped: 0 }),
			),
		).toBe("No thinking blocks found in this session.");
	});
});
