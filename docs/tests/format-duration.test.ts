import { describe, expect, test } from "bun:test";

import { formatDuration } from "../../.omp-plugin/format-duration";

/**
 * The local formatter must stay byte-identical to `formatDuration` from
 * `@oh-my-pi/pi-utils`, which the vibe duration slot used to import at
 * runtime. Every unit boundary is pinned here, so a drift in either
 * direction fails instead of silently reshaping the slot.
 */
describe("formatDuration unit boundaries", () => {
	test("sub-second values keep whole milliseconds", () => {
		expect(formatDuration(1)).toBe("1ms");
		expect(formatDuration(540)).toBe("540ms");
		expect(formatDuration(999)).toBe("999ms");
	});

	test("seconds carry one decimal", () => {
		expect(formatDuration(1_000)).toBe("1.0s");
		expect(formatDuration(3_200)).toBe("3.2s");
		expect(formatDuration(59_999)).toBe("60.0s");
	});

	test("minutes drop a zero seconds part", () => {
		expect(formatDuration(60_000)).toBe("1m");
		expect(formatDuration(65_000)).toBe("1m5s");
		expect(formatDuration(3_599_000)).toBe("59m59s");
	});

	test("hours drop a zero minutes part and never show seconds", () => {
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(4_832_000)).toBe("1h20m");
		expect(formatDuration(86_399_000)).toBe("23h59m");
	});

	test("days drop a zero hours part", () => {
		expect(formatDuration(86_400_000)).toBe("1d");
		expect(formatDuration(183_600_000)).toBe("2d3h");
	});
});

describe("formatDuration degenerate input", () => {
	test("zero, negative and non-finite values collapse to 0ms", () => {
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(-1)).toBe("0ms");
		expect(formatDuration(Number.NaN)).toBe("0ms");
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
	});
});
