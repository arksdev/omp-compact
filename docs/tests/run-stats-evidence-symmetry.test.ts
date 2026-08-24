import { describe, expect, test } from "bun:test";

import {
	evidenceFromResult,
	isRunStatsEvidence,
	MAX_STATS_ACTIONS,
	MAX_STATS_DURATION_MS,
	MAX_STATS_TOKENS,
	resultFromEvidence,
	type RunStatsResult,
} from "../../.omp-plugin/run-stats";

/**
 * Persistence contract of the stats row: evidenceFromResult (run-stats.ts:312)
 * writes the evidence object, isRunStatsEvidence (347) validates what the
 * replay path reads back, and resultFromEvidence (332) restores the display
 * result. Invariant: anything the write side produces must satisfy the read
 * side — otherwise the persisted replay row silently vanishes (the entry is
 * skipped at rebuild-lifecycle.ts:647 and statsMessageComponent returns
 * undefined) with no diagnostic.
 *
 * Today the two sides disagree in strictness and the invariant is UNENFORCED:
 * the write side goes through nonNegativeNumber (75 — finite, `>= 0`, no
 * integer check, no cap), the read side through isBoundedCount
 * (hydration-bounds.ts — `Number.isInteger` + `0..max`). Normal and boundary
 * values round-trip; a fractional or over-cap token count is written and then
 * rejected (pinned in the gap test below). Unreachable with stock hosts —
 * token counts are integral and 1e12 tokens in one run is far beyond real
 * usage — so this suite states the contract and records the gap rather than
 * changing behavior.
 *
 * Note: completedAt reuses MAX_STATS_DURATION_MS (2**53 - 1) as its cap.
 * Epoch milliseconds (~1.7e12) sit far below that bound, so a completedAt can
 * never be rejected — the cap name is misleading for a timestamp field, but
 * there is no write/read asymmetry there. The real exposure is the integer
 * check plus MAX_STATS_TOKENS on sent/received/cacheRead/cacheWrite.
 */
function result(values: Partial<RunStatsResult> = {}): RunStatsResult {
	return {
		actions: 27,
		sent: 28_200,
		received: 1_300,
		cacheRead: 480_200,
		cacheWrite: 12_000,
		hitRate: 0.9445,
		durationMs: 4_832_000,
		hasError: false,
		messages: 3,
		completedAt: 1_752_000_000_123,
		...values,
	};
}

describe("stats evidence round-trips between write and read sides", () => {
	test("ordinary values survive evidenceFromResult -> isRunStatsEvidence -> resultFromEvidence", () => {
		const source = result();
		const evidence = evidenceFromResult(source, "run-abc");
		expect(isRunStatsEvidence(evidence)).toBe(true);
		expect(resultFromEvidence(evidence)).toEqual(source);
	});

	test("the caps round-trip: zeros and exactly-max counts are valid evidence", () => {
		const zeroSource = result({
			actions: 0,
			sent: 0,
			received: 0,
			cacheRead: 0,
			cacheWrite: 0,
			hitRate: 0,
			durationMs: 0,
			hasError: false,
			messages: 0,
			completedAt: 0,
		});
		const zeroEvidence = evidenceFromResult(zeroSource, "run-zero");
		expect(isRunStatsEvidence(zeroEvidence)).toBe(true);
		expect(resultFromEvidence(zeroEvidence)).toEqual(zeroSource);

		const maxSource = result({
			actions: MAX_STATS_ACTIONS,
			sent: MAX_STATS_TOKENS,
			received: MAX_STATS_TOKENS,
			cacheRead: MAX_STATS_TOKENS,
			cacheWrite: MAX_STATS_TOKENS,
			hitRate: 1,
			durationMs: MAX_STATS_DURATION_MS,
			hasError: true,
			messages: MAX_STATS_ACTIONS,
		});
		const maxEvidence = evidenceFromResult(maxSource, "run-max");
		expect(isRunStatsEvidence(maxEvidence)).toBe(true);
		expect(resultFromEvidence(maxEvidence)).toEqual(maxSource);
	});

	/**
	 * Records the current write/read strictness gap instead of pretending
	 * symmetry exists: the write side does not enforce integer-ness or the
	 * caps, so these inputs produce evidence that the read side rejects —
	 * a replay row that is written and then silently dropped. Unreachable
	 * with stock hosts (token counts are integral and 1e12 is far beyond a
	 * real run). If it ever becomes reachable, the fix is to clamp on the
	 * write side — never to loosen the read side.
	 */
	test("fractional and over-cap token counts are written but rejected on read (documented gap)", () => {
		const fractional = evidenceFromResult(result({ sent: 1.5 }), "run-frac");
		expect(fractional.sent).toBe(1.5);
		expect(isRunStatsEvidence(fractional)).toBe(false);

		const overCap = evidenceFromResult(
			result({ received: MAX_STATS_TOKENS + 1 }),
			"run-over",
		);
		expect(overCap.received).toBe(MAX_STATS_TOKENS + 1);
		expect(isRunStatsEvidence(overCap)).toBe(false);
	});
});
