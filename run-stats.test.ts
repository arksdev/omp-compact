import { beforeAll, describe, expect, test } from "bun:test";

import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";

import type {
	RunStatsEvidence,
	RunStatsResult,
	StatsCarrier,
} from "./run-stats";
import { loadStockPlugin } from "./test-stock-host";

interface RunStatsModule {
	STATS_MESSAGE_TYPE: string;
	MAX_STATS_ACTIONS: number;
	MAX_STATS_TOKENS: number;
	MAX_STATS_DURATION_MS: number;
	RunStats: new (
		now?: () => number,
	) => {
		active: boolean;
		readonly actions: number;
		start(): void;
		observeAssistantMessage(message: unknown): void;
		recordTool(toolCallId: string): void;
		recordToolError(toolCallId: string): void;
		endRun(terminal: boolean): void;
		abort(): void;
		finalize(): RunStatsResult | undefined;
		hasError(): boolean;
		dispose(): void;
	};
	hasAssistantUsage(message: unknown): boolean;
	formatTokens(value: number): string;
	formatDuration(milliseconds: number): string;
	hitRateOf(sent: number, cacheRead: number): number;
	statsLine(
		result: RunStatsResult,
		stats: {
			enabled: boolean;
			actions: boolean;
			sent: boolean;
			received: boolean;
			cache: boolean;
			time: boolean;
		},
		theme: Theme,
		width?: number,
	): string;
	evidenceFromResult(result: RunStatsResult, runId: string): RunStatsEvidence;
	resultFromEvidence(evidence: RunStatsEvidence): RunStatsResult;
	isRunStatsEvidence(value: unknown): value is RunStatsEvidence;
	createStatsCarrier(line: string): StatsCarrier;
	statsMessageComponent(
		details: RunStatsEvidence | undefined,
		theme: Theme,
	): Component | undefined;
}

let module: RunStatsModule;

beforeAll(async () => {
	// run-stats.ts imports ./config only as a type; @oh-my-pi deps resolve
	// from the pinned runtime install through the plugin tree's node_modules
	// link.
	module = await loadStockPlugin<RunStatsModule>(
		"run-stats.ts",
		"run-stats-test",
	);
});

const GREEN_SEP = "\u001b[38;2;164;215;52m";
const WARNING_SEP = "\u001b[93m";

function fakeTheme(): Theme {
	return {
		fg: (color: string, text: string) => {
			const code = color === "warning" ? "93" : color === "dim" ? "2" : "0";
			return `\x1b[${code}m${text}\x1b[0m`;
		},
	} as unknown as Theme;
}

const ALL_ON = {
	enabled: true,
	actions: true,
	sent: true,
	received: true,
	cache: true,
	time: true,
} as const;

function result(overrides: Partial<RunStatsResult> = {}): RunStatsResult {
	return {
		actions: 27,
		sent: 28_153,
		received: 1_300,
		cacheRead: 480_200,
		cacheWrite: 12_000,
		hitRate: 0.9446,
		durationMs: 4_832_000,
		hasError: false,
		messages: 2,
		completedAt: 1_800_000_000_000,
		...overrides,
	};
}

function assistant(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "hello" },
			{ type: "toolCall", id: "t1", name: "bash" },
			{ type: "toolCall", id: "t2", name: "read" },
		],
		stopReason: "toolUse",
		timestamp: 1_700_000_000_000,
		usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
		...overrides,
	};
}

function stripAnsi(value: string): string {
	return Bun.stripANSI(value);
}

describe("aggregation: unique finalized assistant messages", () => {
	test("one message with several tool calls counts once, never per tool call", () => {
		const stats = new module.RunStats();
		stats.start();
		stats.observeAssistantMessage(assistant());
		stats.observeAssistantMessage(assistant()); // same completion redelivered
		stats.endRun(true);
		const result = stats.finalize();
		expect(result?.sent).toBe(100);
		expect(result?.received).toBe(50);
		expect(result?.cacheRead).toBe(200);
		expect(result?.cacheWrite).toBe(30);
		expect(result?.messages).toBe(1);
	});

	test("multiple completions accumulate per unique message", () => {
		const stats = new module.RunStats();
		stats.start();
		stats.observeAssistantMessage(
			assistant({
				timestamp: 1,
				usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3 },
			}),
		);
		stats.observeAssistantMessage(
			assistant({
				timestamp: 2,
				usage: { input: 90, output: 45, cacheRead: 180, cacheWrite: 27 },
			}),
		);
		stats.endRun(true);
		const result = stats.finalize();
		expect(result?.sent).toBe(100);
		expect(result?.received).toBe(50);
		expect(result?.cacheRead).toBe(200);
		expect(result?.cacheWrite).toBe(30);
		expect(result?.messages).toBe(2);
	});

	test("malformed usage fields fail open to zero but still count the message", () => {
		const stats = new module.RunStats();
		stats.start();
		stats.observeAssistantMessage(
			assistant({ timestamp: 1, usage: { input: "x", output: NaN } }),
		);
		stats.endRun(true);
		const result = stats.finalize();
		expect(result?.sent).toBe(0);
		expect(result?.received).toBe(0);
		expect(result?.messages).toBe(1);
	});

	test("missing or malformed usage objects are ignored entirely", () => {
		const stats = new module.RunStats();
		stats.start();
		// the only structurally valid usage message in this run
		stats.observeAssistantMessage(
			assistant({
				timestamp: 1,
				usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
			}),
		);
		stats.observeAssistantMessage(
			assistant({ timestamp: 2, usage: undefined }),
		);
		stats.observeAssistantMessage(assistant({ timestamp: 3, usage: null }));
		stats.observeAssistantMessage(assistant({ timestamp: 4, usage: "nope" }));
		stats.observeAssistantMessage(assistant({ timestamp: 5, usage: 42 }));
		stats.observeAssistantMessage(assistant({ timestamp: 6, usage: [] }));
		stats.endRun(true);
		const result = stats.finalize();
		expect(result?.sent).toBe(100);
		expect(result?.received).toBe(50);
		expect(result?.messages).toBe(1);
	});

	test("legitimate zero-valued usage is counted once", () => {
		const stats = new module.RunStats();
		stats.start();
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		stats.observeAssistantMessage(assistant({ timestamp: 1, usage: zero }));
		// redelivery of the same zero-usage completion still dedupes
		stats.observeAssistantMessage(assistant({ timestamp: 1, usage: zero }));
		// an empty usage object is legitimate too (provider omitted zeros)
		stats.observeAssistantMessage(assistant({ timestamp: 2, usage: {} }));
		stats.endRun(true);
		const result = stats.finalize();
		expect(result?.sent).toBe(0);
		expect(result?.received).toBe(0);
		expect(result?.messages).toBe(2);
	});

	test("duplicate completion of the same message counts once", () => {
		const stats = new module.RunStats();
		stats.start();
		const message = assistant({ timestamp: 1 });
		stats.observeAssistantMessage(message);
		stats.observeAssistantMessage(message); // same completion redelivered
		stats.endRun(true);
		const result = stats.finalize();
		expect(result?.sent).toBe(100);
		expect(result?.received).toBe(50);
		expect(result?.messages).toBe(1);
	});

	test("messages observed outside a run are ignored", () => {
		const stats = new module.RunStats();
		stats.observeAssistantMessage(assistant());
		stats.start();
		stats.observeAssistantMessage(assistant({ timestamp: 1 }));
		stats.endRun(true);
		const result = stats.finalize();
		expect(result?.messages).toBe(1);
		expect(result?.sent).toBe(100);
	});
});

describe("hasAssistantUsage structural guard", () => {
	test("requires a real usage object; missing/null/primitives/arrays fail", () => {
		expect(module.hasAssistantUsage(assistant())).toBe(true);
		expect(module.hasAssistantUsage(assistant({ usage: {} }))).toBe(true);
		expect(module.hasAssistantUsage(assistant({ usage: { input: 0 } }))).toBe(
			true,
		);
		expect(module.hasAssistantUsage(assistant({ usage: undefined }))).toBe(
			false,
		);
		expect(module.hasAssistantUsage(assistant({ usage: null }))).toBe(false);
		expect(module.hasAssistantUsage(assistant({ usage: "nope" }))).toBe(false);
		expect(module.hasAssistantUsage(assistant({ usage: 42 }))).toBe(false);
		expect(module.hasAssistantUsage(assistant({ usage: [] }))).toBe(false);
		expect(module.hasAssistantUsage(undefined)).toBe(false);
		expect(module.hasAssistantUsage(null)).toBe(false);
		expect(module.hasAssistantUsage("assistant")).toBe(false);
	});
});

describe("cache math", () => {
	test("hit rate is cacheRead over sent + cacheRead", () => {
		expect(module.hitRateOf(28_153, 480_200)).toBeCloseTo(0.94462, 4);
	});

	test("zero denominators yield zero, never NaN", () => {
		expect(module.hitRateOf(0, 0)).toBe(0);
		expect(module.hitRateOf(0, 100)).toBe(1);
		expect(module.hitRateOf(100, 0)).toBe(0);
	});

	test("cacheWrite never inflates sent, hits, or hit rate", () => {
		const stats = new module.RunStats();
		stats.start();
		stats.observeAssistantMessage(
			assistant({
				timestamp: 1,
				usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 9_000 },
			}),
		);
		stats.endRun(true);
		const result = stats.finalize();
		expect(result?.sent).toBe(100);
		expect(result?.cacheRead).toBe(200);
		expect(result?.cacheWrite).toBe(9_000);
		expect(result?.hitRate).toBeCloseTo(200 / 300, 10);
	});
});

describe("formatting and rounding", () => {
	test("formatTokens magnitudes and rounding", () => {
		expect(module.formatTokens(0)).toBe("0");
		expect(module.formatTokens(5)).toBe("5");
		expect(module.formatTokens(950)).toBe("950");
		expect(module.formatTokens(999)).toBe("999");
		expect(module.formatTokens(1_000)).toBe("1k");
		expect(module.formatTokens(1_300)).toBe("1.3k");
		expect(module.formatTokens(28_153)).toBe("28.2k");
		expect(module.formatTokens(480_200)).toBe("480.2k");
		expect(module.formatTokens(1_000_000)).toBe("1M");
		expect(module.formatTokens(1_234_567)).toBe("1.2M");
		expect(module.formatTokens(3_100_000_000)).toBe("3.1B");
		expect(module.formatTokens(-5)).toBe("0");
		expect(module.formatTokens(Number.NaN)).toBe("0");
	});

	test("formatDuration units", () => {
		expect(module.formatDuration(0)).toBe("0s");
		expect(module.formatDuration(500)).toBe("1s");
		expect(module.formatDuration(32_000)).toBe("32s");
		expect(module.formatDuration(65_000)).toBe("1m 5s");
		expect(module.formatDuration(3_600_000)).toBe("1h 0m 0s");
		expect(module.formatDuration(4_832_000)).toBe("1h 20m 32s");
		expect(module.formatDuration(-1_000)).toBe("0s");
	});

	test("full row renders the spec format", () => {
		const line = module.statsLine(result(), ALL_ON, fakeTheme());
		expect(stripAnsi(line)).toBe(
			"[ 27 actions · 28.2k sent · 1.3k received · 94% cache (480.2k hit) · 1h 20m 32s ]",
		);
	});
});

describe("statsLine field subsets and gating", () => {
	test("actions + time only", () => {
		const line = module.statsLine(
			result(),
			{
				enabled: true,
				actions: true,
				sent: false,
				received: false,
				cache: false,
				time: true,
			},
			fakeTheme(),
		);
		expect(stripAnsi(line)).toBe("[ 27 actions · 1h 20m 32s ]");
	});

	test("single segment has no separators", () => {
		const line = module.statsLine(
			result(),
			{
				enabled: true,
				actions: true,
				sent: false,
				received: false,
				cache: false,
				time: false,
			},
			fakeTheme(),
		);
		expect(stripAnsi(line)).toBe("[ 27 actions ]");
	});

	test("stats disabled renders nothing", () => {
		const line = module.statsLine(
			result(),
			{ ...ALL_ON, enabled: false },
			fakeTheme(),
		);
		expect(line).toBe("");
	});

	test("enabled with no segments renders nothing", () => {
		const line = module.statsLine(
			result(),
			{
				enabled: true,
				actions: false,
				sent: false,
				received: false,
				cache: false,
				time: false,
			},
			fakeTheme(),
		);
		expect(line).toBe("");
	});

	test("width truncation stays transparent and clips instead of wrapping", () => {
		const line = module.statsLine(result(), ALL_ON, fakeTheme(), 30);
		expect(stripAnsi(line).length).toBeLessThanOrEqual(30);
		expect(line).not.toContain("\u001b[48;");
	});
});

describe("statsLine coloring", () => {
	test("clean run uses the fixed green separators, dim values and brackets", () => {
		const line = module.statsLine(
			result({ hasError: false }),
			ALL_ON,
			fakeTheme(),
		);
		expect(line).toContain(GREEN_SEP);
		expect(line).not.toContain(WARNING_SEP);
		// values and brackets stay dim neutral
		expect(line).toContain("\u001b[2m[");
		expect(line).toContain("\u001b[2m27 actions");
		expect(line).toContain("\u001b[2m]");
	});

	test("failed tool executions switch separators to theme warning", () => {
		const line = module.statsLine(
			result({ hasError: true }),
			ALL_ON,
			fakeTheme(),
		);
		expect(line).toContain(WARNING_SEP);
		expect(line).not.toContain(GREEN_SEP);
		expect(stripAnsi(line)).toBe(
			"[ 27 actions · 28.2k sent · 1.3k received · 94% cache (480.2k hit) · 1h 20m 32s ]",
		);
	});
});

describe("logical run lifecycle", () => {
	test("duration spans agent_start through terminal agent_end", () => {
		let clock = 1_000;
		const stats = new module.RunStats(() => clock);
		stats.start();
		clock = 1_000 + 4_832_000;
		stats.endRun(true);
		expect(stats.finalize()?.durationMs).toBe(4_832_000);
		expect(stats.finalize()?.completedAt).toBe(4_833_000);
	});

	test("continuations keep the same logical run and accumulate", () => {
		let clock = 0;
		const stats = new module.RunStats(() => clock);
		stats.start();
		stats.observeAssistantMessage(
			assistant({
				timestamp: 1,
				usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0 },
			}),
		);
		clock = 5_000;
		stats.endRun(false); // willContinue
		stats.start(); // continuation agent_start must not reset
		stats.observeAssistantMessage(
			assistant({
				timestamp: 2,
				usage: { input: 90, output: 45, cacheRead: 180, cacheWrite: 0 },
			}),
		);
		clock = 10_000;
		stats.endRun(true);
		const result = stats.finalize();
		expect(result?.sent).toBe(100);
		expect(result?.received).toBe(50);
		expect(result?.messages).toBe(2);
		expect(result?.durationMs).toBe(10_000);
	});

	test("the next user prompt starts a fresh run", () => {
		const stats = new module.RunStats();
		stats.start();
		stats.observeAssistantMessage(
			assistant({
				timestamp: 1,
				usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 0 },
			}),
		);
		stats.endRun(true);
		stats.start();
		stats.observeAssistantMessage(
			assistant({
				timestamp: 2,
				usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		stats.endRun(true);
		expect(stats.finalize()?.sent).toBe(7);
		expect(stats.finalize()?.messages).toBe(1);
	});

	test("an interrupted run without a terminal end produces no result", () => {
		const stats = new module.RunStats();
		stats.start();
		stats.observeAssistantMessage(assistant());
		stats.start(); // new run while previous never ended (abort path)
		stats.endRun(true);
		expect(stats.finalize()?.sent).toBe(0);
		expect(stats.finalize()?.messages).toBe(0);
	});

	test("finalize is idempotent and returns the same locked result", () => {
		const stats = new module.RunStats();
		stats.start();
		stats.observeAssistantMessage(assistant({ timestamp: 1 }));
		stats.endRun(true);
		const first = stats.finalize();
		const second = stats.finalize();
		expect(first).toBe(second);
		expect(first?.messages).toBe(1);
	});

	test("tool errors mark the run dirty without affecting token math", () => {
		const stats = new module.RunStats();
		stats.start();
		stats.recordToolError("bash-1");
		stats.recordToolError("bash-1"); // duplicate id still one error
		stats.observeAssistantMessage(assistant({ timestamp: 1 }));
		stats.endRun(true);
		expect(stats.hasError()).toBe(true);
		expect(stats.finalize()?.hasError).toBe(true);
		expect(stats.finalize()?.sent).toBe(100);
	});

	test("recordTool dedups distinct executions by toolCallId", () => {
		const stats = new module.RunStats();
		stats.start();
		stats.recordTool("bash-1");
		stats.recordTool("bash-1"); // redelivery is one execution
		stats.recordTool("read-2");
		stats.recordTool(""); // empty/provisional ids never count
		expect(stats.actions).toBe(2);
		stats.endRun(true);
		expect(stats.finalize()?.actions).toBe(2);
	});

	test("actions accumulate across continuations and reset on a fresh run", () => {
		const stats = new module.RunStats();
		stats.start();
		stats.recordTool("a");
		stats.endRun(false); // willContinue
		stats.start(); // continuation keeps the run open
		stats.recordTool("a"); // redelivered id still counts once
		stats.recordTool("b");
		stats.endRun(true);
		expect(stats.finalize()?.actions).toBe(2);
		stats.start(); // next user prompt
		stats.recordTool("c");
		stats.endRun(true);
		expect(stats.finalize()?.actions).toBe(1);
	});

	test("abort discards the open run: no result, no leak into the next run", () => {
		const stats = new module.RunStats();
		stats.start();
		stats.recordTool("bash-1");
		stats.recordToolError("bash-1");
		stats.observeAssistantMessage(assistant({ timestamp: 1 }));
		stats.endRun(false); // continuation arm
		stats.abort(); // terminal end WITHOUT an answer (abort/error)
		expect(stats.finalize()).toBeUndefined();
		expect(stats.active).toBe(false);
		// the next run starts clean: the continuation flag was cleared too
		stats.start();
		stats.observeAssistantMessage(
			assistant({ timestamp: 2, usage: { input: 7, output: 3 } }),
		);
		stats.endRun(true);
		const result = stats.finalize();
		expect(result?.actions).toBe(0);
		expect(result?.sent).toBe(7);
		expect(result?.messages).toBe(1);
		expect(result?.hasError).toBe(false);
		// a stale abort after a locked result never erases it
		stats.abort();
		expect(stats.finalize()).toBe(result);
	});

	test("dispose drops partial state; a later run starts clean", () => {
		const stats = new module.RunStats();
		stats.start();
		stats.observeAssistantMessage(assistant({ timestamp: 1 }));
		stats.dispose();
		expect(stats.active).toBe(false);
		expect(stats.finalize()).toBeUndefined();
		stats.start();
		stats.endRun(true);
		expect(stats.finalize()?.messages).toBe(0);
	});
});

describe("persisted evidence", () => {
	test("round-trips through evidence", () => {
		const source = result();
		const evidence = module.evidenceFromResult(source, "omp-compact-run-1");
		expect(evidence.version).toBe(1);
		expect(evidence.runId).toBe("omp-compact-run-1");
		expect(module.resultFromEvidence(evidence)).toEqual(source);
		expect(module.isRunStatsEvidence(evidence)).toBe(true);
	});

	test("cacheWrite survives in evidence but never as a hit", () => {
		const evidence = module.evidenceFromResult(result(), "r1");
		expect(evidence.cacheWrite).toBe(12_000);
		expect(evidence.hitRate).toBeCloseTo(0.9446, 4);
	});

	test("rejects malformed, unbounded, or foreign evidence", () => {
		const good = module.evidenceFromResult(result(), "r1");
		expect(module.isRunStatsEvidence({ ...good, version: 2 })).toBe(false);
		expect(module.isRunStatsEvidence({ ...good, runId: "" })).toBe(false);
		expect(module.isRunStatsEvidence({ ...good, runId: "x".repeat(200) })).toBe(
			false,
		);
		expect(module.isRunStatsEvidence({ ...good, actions: -1 })).toBe(false);
		expect(
			module.isRunStatsEvidence({
				...good,
				actions: module.MAX_STATS_ACTIONS + 1,
			}),
		).toBe(false);
		expect(
			module.isRunStatsEvidence({ ...good, sent: module.MAX_STATS_TOKENS + 1 }),
		).toBe(false);
		expect(module.isRunStatsEvidence({ ...good, hitRate: 1.1 })).toBe(false);
		expect(module.isRunStatsEvidence({ ...good, hitRate: Number.NaN })).toBe(
			false,
		);
		expect(
			module.isRunStatsEvidence({
				...good,
				durationMs: module.MAX_STATS_DURATION_MS + 1,
			}),
		).toBe(false);
		expect(module.isRunStatsEvidence({ ...good, hasError: "yes" })).toBe(false);
		expect(
			module.isRunStatsEvidence({
				...good,
				completedAt: Number.POSITIVE_INFINITY,
			}),
		).toBe(false);
		expect(module.isRunStatsEvidence(undefined)).toBe(false);
		expect(module.isRunStatsEvidence("omp-compact-stats")).toBe(false);
	});

	test("evidence clamps out-of-range result values", () => {
		const evidence = module.evidenceFromResult(
			result({ hitRate: 5, hasError: 1 as never }),
			"r1",
		);
		expect(evidence.hitRate).toBe(1);
		expect(evidence.hasError).toBe(false);
	});
});

describe("transcript carrier", () => {
	test("carrier is a foldable omp-compact custom message", () => {
		const carrier = module.createStatsCarrier("[ 1 actions ]");
		expect(carrier.message.customType).toBe(module.STATS_MESSAGE_TYPE);
		expect(carrier.message.customType.startsWith("omp-compact-")).toBe(true);
	});

	test("carrier renders the line and truncates at narrow widths", () => {
		const line =
			"[ 27 actions · 28.2k sent · 1.3k received · 94% cache (480.2k hit) · 1h 20m 32s ]";
		const carrier = module.createStatsCarrier(line);
		expect(carrier.render(120)).toEqual([line]);
		const narrow = carrier.render(20);
		expect(narrow).toHaveLength(1);
		expect(Bun.stripANSI(narrow[0] ?? "").length).toBeLessThanOrEqual(20);
	});
});

describe("statsMessageComponent", () => {
	test("renders valid evidence, ignores invalid", () => {
		const component = module.statsMessageComponent(
			module.evidenceFromResult(result(), "r1"),
			fakeTheme(),
		);
		expect(component).toBeDefined();
		const rows = component?.render(120) ?? [];
		expect(Bun.stripANSI(rows.join("\n"))).toContain("27 actions");
		expect(Bun.stripANSI(rows.join("\n"))).toContain("28.2k sent");
		expect(
			module.statsMessageComponent(undefined, fakeTheme()),
		).toBeUndefined();
	});
});
