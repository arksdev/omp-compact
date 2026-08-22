import { beforeAll, describe, expect, test } from "bun:test";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { formatDuration } from "@oh-my-pi/pi-utils/format";
import type {
	CompactVibeView,
	VibeScreenSnapshot,
	VibeToolDetails,
} from "../../.omp-plugin/vibe-cards";
import { loadStockPlugin } from "./test-stock-host";

interface VibeCardsModule {
	renderCompactVibeRows(
		view: CompactVibeView,
		theme: Theme,
		width?: number,
	): readonly string[];
	unpackVibeToolDetails(result: unknown): VibeToolDetails | undefined;
}

let vibeCardsModule: VibeCardsModule;

beforeAll(async () => {
	vibeCardsModule = await loadStockPlugin<VibeCardsModule>(
		"vibe-cards.ts",
		"vibe-cards-test",
	);
});

function fakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		getFgAnsi: () => "",
		getBgAnsi: () => "",
		spinnerFrames: ["⠦", "⠧", "⠇", "⠏"],
		getSpinnerFrames: (type: string) =>
			type === "activity" ? ["⠦", "⠧", "⠇", "⠏"] : ["⣾", "⣽", "⣻", "⢿"],
		boxRound: {
			topLeft: "╭",
			bottomLeft: "╰",
			horizontal: "─",
			vertical: "│",
		},
		format: {
			bracketLeft: "⟦",
			bracketRight: "⟧",
		},
	} as unknown as Theme;
}

function stripAnsi(value: string): string {
	return Bun.stripANSI(value);
}

function routineSnapshot(
	overrides: Partial<VibeScreenSnapshot> = {},
): VibeScreenSnapshot {
	return {
		id: "worker-1",
		cli: "fast",
		state: "running",
		model: undefined,
		turns: 1,
		queued: 0,
		turnStartedAt: undefined,
		turnMessage: undefined,
		currentTool: undefined,
		currentToolArgs: undefined,
		lastIntent: undefined,
		trace: [],
		outputTail: [],
		lastActivity: undefined,
		lastActivityAt: 1_000,
		...overrides,
	};
}

function routineDetails(
	overrides: Partial<VibeToolDetails> = {},
): VibeToolDetails {
	return {
		op: "wait",
		screens: [routineSnapshot()],
		...overrides,
	};
}

function routineView(
	overrides: Partial<CompactVibeView> = {},
): CompactVibeView {
	return {
		op: "wait",
		details: routineDetails(),
		isPartial: true,
		tick: 0,
		now: 2_500,
		...overrides,
	};
}

describe("vibe-cards grammar and presentation", () => {
	test("running worker row grammar with full set of slots", () => {
		const screen = routineSnapshot({
			id: "audit-worker",
			cli: "fast",
			state: "running",
			turns: 2,
			queued: 1,
			turnStartedAt: 10_000,
			model: "AuraPass/grok-4.5:medium",
			turnMessage: "Scan host adapter",
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				details: routineDetails({ screens: [screen] }),
				now: 22_300,
				tick: 0,
			}),
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe(
			"⠦ ⟦f⟧ audit-worker 2t+1q 12.3s grok-4.5 Scan host adapter",
		);
	});

	test("running worker lifts tail to text slot when turnMessage is absent", () => {
		const screen = routineSnapshot({
			id: "b",
			cli: "good",
			state: "running",
			turns: 2,
			queued: 0,
			turnStartedAt: 10_000,
			currentTool: "grep",
			currentToolArgs: "z",
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				details: routineDetails({ screens: [screen] }),
				now: 11_000,
				tick: 0,
			}),
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe("⠦ ⟦g⟧ b 2t 1.0s grep: z");
	});

	test("running worker with turnMessage and tool tail produces two-line card with box frame", () => {
		const screen = routineSnapshot({
			id: "audit-diff-review",
			cli: "fast",
			state: "running",
			turns: 2,
			queued: 0,
			turnStartedAt: 10_000,
			model: "AuraPass/grok-4.5:medium",
			turnMessage: "Scan host-adapter for vibe renderer seams",
			currentTool: "read",
			currentToolArgs: "src/tools/vibe.ts",
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				details: routineDetails({ screens: [screen] }),
				now: 22_300,
				tick: 0,
			}),
			fakeTheme(),
		);

		expect(rows).toHaveLength(2);
		expect(stripAnsi(rows[0] ?? "")).toBe(
			"╭─ ⠦ ⟦f⟧ audit-diff-review 2t 12.3s grok-4.5 Scan host-adapter for vibe renderer seams",
		);
		expect(stripAnsi(rows[1] ?? "")).toBe("╰─ ⠦ read: src/tools/vibe.ts");
	});

	test("single-line card has no box frame prefixes", () => {
		const screen = routineSnapshot({
			id: "worker-single",
			cli: "fast",
			state: "starting",
			turns: 0,
			queued: 0,
			turnMessage: "Bootstrapping worker task",
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				details: routineDetails({ screens: [screen] }),
			}),
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe(
			"∴ ⟦f⟧ worker-single 0t Bootstrapping worker task",
		);
		expect(rows[0]).not.toContain("╭─");
		expect(rows[0]).not.toContain("╰─");
	});

	test("idle worker without activity is hidden", () => {
		const screen = routineSnapshot({
			id: "idle-quiet",
			cli: "good",
			state: "idle",
			turns: 1,
			lastActivity: undefined,
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "list",
				isPartial: false,
				details: routineDetails({ op: "list", screens: [screen] }),
			}),
			fakeTheme(),
		);

		// Header is shown, but no session card
		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe("vibe sessions 1 (1 hidden)");
	});

	test("idle worker with activity renders one line with text glyph", () => {
		const screen = routineSnapshot({
			id: "vibe-catalogue-doc",
			cli: "good",
			state: "idle",
			turns: 1,
			queued: 0,
			turnStartedAt: 10_000,
			model: "AuraPass/grok-4.5:high",
			lastActivity: "Verify line count, gitignore, clean tree",
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "list",
				isPartial: false,
				details: routineDetails({ op: "list", screens: [screen] }),
				now: 22_300,
			}),
			fakeTheme(),
		);

		expect(rows).toHaveLength(2);
		expect(stripAnsi(rows[0] ?? "")).toBe("vibe sessions 1");
		expect(stripAnsi(rows[1] ?? "")).toBe(
			"∷ ⟦g⟧ vibe-catalogue-doc 1t 12.3s grok-4.5 Verify line count, gitignore, clean tree",
		);
	});

	test("aborted worker renders muted glyph and red aborted keyword", () => {
		const screen = routineSnapshot({
			id: "aborted-worker",
			cli: "fast",
			state: "idle",
			turns: 1,
			queued: 0,
			model: undefined,
			lastActivity: "turn 1 aborted: signal",
			lastActivityAt: 10_000,
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "list",
				isPartial: false,
				details: routineDetails({ op: "list", screens: [screen] }),
				now: 12_000,
			}),
			fakeTheme(),
		);

		expect(rows).toHaveLength(2);
		expect(stripAnsi(rows[1] ?? "")).toBe(
			"∷ ⟦f⟧ aborted-worker 1t turn 1 aborted: signal",
		);
	});

	test("TTL threshold: dead and aborted hidden at and after 5000ms, visible before 5000ms", () => {
		const deadScreen = routineSnapshot({
			id: "dead-worker",
			cli: "fast",
			state: "dead",
			turns: 1,
			lastActivity: "killed",
			lastActivityAt: 10_000,
		});

		// Before 5000ms: visible in wait settled
		const rowsBefore = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "wait",
				isPartial: false,
				details: routineDetails({
					op: "wait",
					screens: [deadScreen],
					wait: {
						settled: [
							{ id: "dead-worker", jobId: "job-1", status: "completed" },
						],
						stillRunning: [],
						timedOut: false,
					},
				}),
				now: 14_999,
			}),
			fakeTheme(),
		);
		// 1 settled card = 2 lines (line 1 + footer)
		expect(rowsBefore).toHaveLength(2);

		// Aborted session in list: visible before 5000ms, hidden at 5000ms
		const abortedScreen = routineSnapshot({
			id: "aborted-worker",
			cli: "fast",
			state: "idle",
			turns: 1,
			lastActivity: "turn 1 aborted: signal",
			lastActivityAt: 10_000,
		});

		const listBefore = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "list",
				isPartial: false,
				details: routineDetails({ op: "list", screens: [abortedScreen] }),
				now: 14_999,
			}),
			fakeTheme(),
		);
		expect(listBefore).toHaveLength(2);

		const listAfter = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "list",
				isPartial: false,
				details: routineDetails({ op: "list", screens: [abortedScreen] }),
				now: 15_000,
			}),
			fakeTheme(),
		);
		expect(listAfter).toHaveLength(1);
		expect(stripAnsi(listAfter[0] ?? "")).toBe("vibe sessions 1 (1 hidden)");
	});

	test("dead worker renders model when known", () => {
		const deadScreen = routineSnapshot({
			id: "dead-harvest",
			cli: "fast",
			state: "dead",
			turns: 1,
			model: "AuraPass/grok-4.5:medium",
			lastActivity: "killed",
			lastActivityAt: 10_000,
		});

		const deadRows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "wait",
				isPartial: false,
				details: {
					op: "wait",
					screens: [deadScreen],
					wait: {
						settled: [{ id: "dead-harvest", jobId: "j1", status: "completed" }],
						stillRunning: [],
						timedOut: false,
					},
				},
				now: 12_000,
			}),
			fakeTheme(),
		);

		expect(deadRows).toHaveLength(2);
		expect(stripAnsi(deadRows[0] ?? "")).toBe(
			"╭─ ∷ ⟦f⟧ dead-harvest 1t grok-4.5 killed",
		);
	});

	test("dead worker without activity renders state, name, turns, and model without text slot or trailing space", () => {
		const deadScreen = routineSnapshot({
			id: "dead-silent",
			cli: "good",
			state: "dead",
			turns: 0,
			model: "AuraPass/grok-4.5:medium",
			lastActivity: undefined,
			lastActivityAt: 10_000,
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "wait",
				isPartial: true,
				details: {
					op: "wait",
					screens: [deadScreen],
				},
				now: 12_000,
			}),
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe("∵ ⟦g⟧ dead-silent 0t grok-4.5");
		expect(rows[0]?.endsWith(" ")).toBe(false);
	});

	test("TTL threshold: wait failed and cancelled hidden at and after 10000ms, visible before 10000ms", () => {
		const failedScreen = routineSnapshot({
			id: "flaky-worker",
			cli: "fast",
			state: "idle",
			turns: 2,
			lastActivity: "turn 2 failed: exit 1",
			lastActivityAt: 10_000,
		});

		const details: VibeToolDetails = {
			op: "wait",
			screens: [failedScreen],
			wait: {
				settled: [{ id: "flaky-worker", jobId: "job-1", status: "failed" }],
				stillRunning: [],
				timedOut: false,
			},
		};

		// 9999ms elapsed: visible (1 card = 2 lines)
		const rowsBefore = vibeCardsModule.renderCompactVibeRows(
			routineView({ details, isPartial: false, now: 19_999 }),
			fakeTheme(),
		);
		expect(rowsBefore).toHaveLength(2);
		expect(stripAnsi(rowsBefore[0] ?? "")).toContain("flaky-worker");
		expect(stripAnsi(rowsBefore[1] ?? "")).toBe(
			"╰─ turn failed — result delivered",
		);

		// 10000ms elapsed: card expired, but 0 cards means single wait wall header line
		const rowsAfter = vibeCardsModule.renderCompactVibeRows(
			routineView({ details, isPartial: false, now: 20_000 }),
			fakeTheme(),
		);
		expect(rowsAfter).toHaveLength(1);
		expect(stripAnsi(rowsAfter[0] ?? "")).toBe("vibe wait 1 settled");
	});

	test("wait operation filters for settled sessions only and applies settled footer", () => {
		const screenA = routineSnapshot({
			id: "worker-a",
			cli: "fast",
			state: "idle",
			turns: 1,
			turnStartedAt: 5_000,
			lastActivity: "done with A",
			lastActivityAt: 9_100,
		});
		const screenB = routineSnapshot({
			id: "worker-b",
			cli: "good",
			state: "idle",
			turns: 2,
			lastActivity: "still listed",
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "wait",
				isPartial: false,
				details: {
					op: "wait",
					screens: [screenA, screenB],
					wait: {
						settled: [{ id: "worker-a", jobId: "job-a", status: "completed" }],
						stillRunning: [],
						timedOut: false,
					},
				},
				now: 9_100,
			}),
			fakeTheme(),
		);

		// Only worker-a is rendered because worker-b did not settle (1 card = 2 lines, no header)
		expect(rows).toHaveLength(2);
		expect(stripAnsi(rows[0] ?? "")).toBe(
			"╭─ ∷ ⟦f⟧ worker-a 1t 4.1s done with A",
		);
		expect(stripAnsi(rows[1] ?? "")).toBe(
			"╰─ turn completed — result delivered",
		);
	});

	test("wait operation during interim waiting frame renders running/starting sessions", () => {
		const screenRunning = routineSnapshot({
			id: "worker-a",
			cli: "fast",
			state: "running",
			turns: 1,
			turnStartedAt: 10_000,
			turnMessage: "Running job",
		});
		const screenStarting = routineSnapshot({
			id: "worker-b",
			cli: "good",
			state: "starting",
			turns: 0,
			turnMessage: "Starting job",
		});
		const screenIdle = routineSnapshot({
			id: "worker-c",
			cli: "fast",
			state: "idle",
			turns: 1,
			lastActivity: "done",
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "wait",
				isPartial: true,
				details: {
					op: "wait",
					screens: [screenRunning, screenStarting, screenIdle],
					wait: {
						settled: [],
						stillRunning: ["worker-a"],
						timedOut: false,
						waiting: true,
					},
				},
				now: 13_200,
			}),
			fakeTheme(),
		);

		// Header + 2 cards (worker-a and worker-b); idle worker-c excluded
		expect(rows).toHaveLength(3);
		expect(stripAnsi(rows[0] ?? "")).toBe("vibe wait 2 on air");
		expect(stripAnsi(rows[1] ?? "")).toBe("⠦ ⟦f⟧ worker-a 1t 3.2s Running job");
		expect(stripAnsi(rows[2] ?? "")).toBe("∴ ⟦g⟧ worker-b 0t Starting job");
	});

	test("absence of wait header with 1 card and presence with 2 cards", () => {
		const screen1 = routineSnapshot({
			id: "worker-1",
			cli: "fast",
			state: "idle",
			turns: 1,
			lastActivity: "finished slice 1",
			lastActivityAt: 10_000,
		});
		const screen2 = routineSnapshot({
			id: "worker-2",
			cli: "good",
			state: "idle",
			turns: 2,
			lastActivity: "finished slice 2",
			lastActivityAt: 10_000,
		});

		// 1 card -> no wall header (card has 2 lines)
		const rows1 = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "wait",
				isPartial: false,
				details: {
					op: "wait",
					screens: [screen1],
					wait: {
						settled: [{ id: "worker-1", jobId: "j1", status: "completed" }],
						stillRunning: [],
						timedOut: false,
					},
				},
				now: 10_000,
			}),
			fakeTheme(),
		);
		expect(rows1).toHaveLength(2);
		expect(stripAnsi(rows1[0] ?? "")).toContain("worker-1");

		// 2 cards -> wall header present (1 header + 2 cards * 2 lines = 5 lines)
		const rows2 = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "wait",
				isPartial: false,
				details: {
					op: "wait",
					screens: [screen1, screen2],
					wait: {
						settled: [
							{ id: "worker-1", jobId: "j1", status: "completed" },
							{ id: "worker-2", jobId: "j2", status: "completed" },
						],
						stillRunning: [],
						timedOut: false,
					},
				},
				now: 10_000,
			}),
			fakeTheme(),
		);
		expect(rows2).toHaveLength(5);
		expect(stripAnsi(rows2[0] ?? "")).toBe("vibe wait 2 settled");
	});

	test("wait operation with zero cards and timeout renders single header line", () => {
		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "wait",
				isPartial: false,
				details: {
					op: "wait",
					screens: [],
					wait: {
						settled: [],
						stillRunning: [],
						timedOut: true,
					},
				},
				now: 10_000,
			}),
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe("vibe wait timed out");
	});

	test("list operation displays header with total and hidden counts", () => {
		const active = routineSnapshot({
			id: "live-worker",
			cli: "fast",
			state: "running",
			turns: 1,
			turnMessage: "Working",
		});
		const quietIdle = routineSnapshot({
			id: "quiet-worker",
			cli: "good",
			state: "idle",
			turns: 1,
			lastActivity: undefined,
		});
		const dead = routineSnapshot({
			id: "dead-worker",
			cli: "fast",
			state: "dead",
			turns: 0,
			lastActivity: "killed",
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "list",
				isPartial: false,
				details: {
					op: "list",
					screens: [active, quietIdle, dead],
				},
			}),
			fakeTheme(),
		);

		expect(rows).toHaveLength(2);
		expect(stripAnsi(rows[0] ?? "")).toBe("vibe sessions 3 (2 hidden)");
		expect(stripAnsi(rows[1] ?? "")).toContain("live-worker");
	});

	test("kill operation produces empty output", () => {
		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				op: "kill",
				details: {
					op: "kill",
					screens: [routineSnapshot()],
					killed: { id: "worker-1", cancelledTurn: true },
				},
			}),
			fakeTheme(),
		);

		expect(rows).toEqual([]);
	});

	test("error result produces single line with ✘, muted prefix, and error text", () => {
		const rows = vibeCardsModule.renderCompactVibeRows(
			{
				op: "wait",
				isError: true,
				args: { sessions: ["a", "b"] },
				result: {
					content: [{ type: "text", text: "something broke" }],
				},
			},
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe("✘ vibe wait a, b — something broke");
	});

	test("error without details or text produces fallback status line", () => {
		const rows = vibeCardsModule.renderCompactVibeRows(
			{
				op: "spawn",
				isError: true,
				args: { name: "my-worker" },
				result: {},
			},
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe("✘ vibe spawn my-worker");
	});

	test("spawn echo renders ∴ glyph and cursor when partial, clean row when settled", () => {
		const args = {
			name: "my-worker",
			cli: "fast",
			prompt: "Build the registry prototype end to end",
		};

		// Partial preview
		const partialRows = vibeCardsModule.renderCompactVibeRows(
			{
				op: "spawn",
				isPartial: true,
				args,
				details: {
					op: "spawn",
					screens: [],
				},
			},
			fakeTheme(),
		);

		expect(partialRows).toHaveLength(1);
		expect(stripAnsi(partialRows[0] ?? "")).toBe(
			"∴ ⟦f⟧ my-worker 0t Build the registry prototype end to end▌",
		);

		// Settled echo
		const settledRows = vibeCardsModule.renderCompactVibeRows(
			{
				op: "spawn",
				isPartial: false,
				args,
				details: {
					op: "spawn",
					screens: [],
					spawned: {
						id: "my-worker",
						cli: "fast",
						jobId: "job_abc",
					},
				},
			},
			fakeTheme(),
		);

		expect(settledRows).toHaveLength(1);
		expect(stripAnsi(settledRows[0] ?? "")).toBe(
			"∴ ⟦f⟧ my-worker 0t Build the registry prototype end to end",
		);
	});

	test("spawn echo renders without details structure when partial", () => {
		const rows = vibeCardsModule.renderCompactVibeRows(
			{
				op: "spawn",
				isPartial: true,
				args: {
					name: "in-flight-worker",
					cli: "fast",
					prompt: "Initialize background slice",
				},
			},
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe(
			"∴ ⟦f⟧ in-flight-worker 0t Initialize background slice▌",
		);
	});

	test("send echo renders → glyph and cursor when partial, steered marker when mode is steered, queued marker when queued", () => {
		const args = {
			session: "worker-a",
			message: "Continue with the next slice",
		};

		// Partial preview (no target screen -> no CLI badge)
		const partialRows = vibeCardsModule.renderCompactVibeRows(
			{
				op: "send",
				isPartial: true,
				args,
				details: {
					op: "send",
					screens: [],
				},
			},
			fakeTheme(),
		);
		expect(partialRows).toHaveLength(1);
		expect(stripAnsi(partialRows[0] ?? "")).toBe(
			"→ worker-a Continue with the next slice▌",
		);

		// Steered outcome with target screen present
		const steeredRows = vibeCardsModule.renderCompactVibeRows(
			{
				op: "send",
				isPartial: false,
				args,
				details: {
					op: "send",
					screens: [routineSnapshot({ id: "worker-a", cli: "fast" })],
					send: {
						id: "worker-a",
						mode: "steered",
					},
				},
			},
			fakeTheme(),
		);
		expect(steeredRows).toHaveLength(1);
		expect(stripAnsi(steeredRows[0] ?? "")).toBe(
			"→ ⟦f⟧ worker-a Continue with the next slice  steered",
		);

		// Queued outcome with target screen present
		const queuedRows = vibeCardsModule.renderCompactVibeRows(
			{
				op: "send",
				isPartial: false,
				args,
				details: {
					op: "send",
					screens: [
						routineSnapshot({ id: "worker-a", cli: "fast", queued: 2 }),
					],
					send: {
						id: "worker-a",
						mode: "queued",
					},
				},
			},
			fakeTheme(),
		);
		expect(queuedRows).toHaveLength(1);
		expect(stripAnsi(queuedRows[0] ?? "")).toBe(
			"→ ⟦f⟧ worker-a Continue with the next slice  queued +2q",
		);
	});

	test("send echo renders queued marker without queue count when depth is zero or unknown", () => {
		const rows = vibeCardsModule.renderCompactVibeRows(
			{
				op: "send",
				isPartial: false,
				args: {
					session: "worker-b",
					message: "Later slice",
				},
				details: {
					op: "send",
					screens: [
						routineSnapshot({ id: "worker-b", cli: "fast", queued: 0 }),
					],
					send: {
						id: "worker-b",
						mode: "queued",
					},
				},
			},
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe("→ ⟦f⟧ worker-b Later slice  queued");
	});

	test("send echo renders without CLI badge when target screen snapshot is missing in result", () => {
		const rows = vibeCardsModule.renderCompactVibeRows(
			{
				op: "send",
				isPartial: false,
				args: {
					session: "worker-unknown",
					message: "Dispatch task",
				},
				details: {
					op: "send",
					screens: [],
					send: {
						id: "worker-unknown",
						mode: "steered",
					},
				},
			},
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe(
			"→ worker-unknown Dispatch task  steered",
		);
	});

	test("send echo renders without details structure when partial", () => {
		const rows = vibeCardsModule.renderCompactVibeRows(
			{
				op: "send",
				isPartial: true,
				args: {
					session: "worker-b",
					message: "Provide progress report",
				},
			},
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe(
			"→ worker-b Provide progress report▌",
		);
	});

	test("truncation cuts long session ID to 24 code points with ellipsis", () => {
		const longId = "very-long-session-id-that-exceeds-twenty-four-chars";
		const screen = routineSnapshot({
			id: longId,
			cli: "good",
			state: "starting",
			turns: 0,
			turnMessage: "Starting",
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				details: routineDetails({ screens: [screen] }),
			}),
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		// 23 code points + … = 24 code points
		expect(stripAnsi(rows[0] ?? "")).toBe(
			"∴ ⟦g⟧ very-long-session-id-th… 0t Starting",
		);
	});

	test("truncation formats short model name and cuts to 16 code points with ellipsis", () => {
		const longModel =
			"provider/very-long-model-name-that-is-way-too-long:reasoning";
		const screen = routineSnapshot({
			id: "worker-m",
			cli: "fast",
			state: "running",
			turns: 1,
			model: longModel,
			turnStartedAt: 10_000,
			turnMessage: "Processing",
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				details: routineDetails({ screens: [screen] }),
				now: 12_000,
			}),
			fakeTheme(),
		);

		expect(rows).toHaveLength(1);
		// "very-long-model-name-that-is-way-too-long" -> 15 chars + "…" = 16 code points
		expect(stripAnsi(rows[0] ?? "")).toBe(
			"⠦ ⟦f⟧ worker-m 1t 2.0s very-long-model… Processing",
		);
	});

	test("width constraint truncates only the last text slot with ellipsis", () => {
		const screen = routineSnapshot({
			id: "short",
			cli: "fast",
			state: "running",
			turns: 1,
			turnStartedAt: 10_000,
			model: "grok-4.5",
			turnMessage:
				"A very long turn message that must be truncated to fit the width",
		});

		const rows = vibeCardsModule.renderCompactVibeRows(
			routineView({
				details: routineDetails({ screens: [screen] }),
				now: 12_000,
			}),
			fakeTheme(),
			40,
		);

		expect(rows).toHaveLength(1);
		const plain = stripAnsi(rows[0] ?? "");
		expect(plain.length).toBeLessThanOrEqual(40);
		expect(plain).toBe("⠦ ⟦f⟧ short 1t 2.0s grok-4.5 A very lon…");
	});

	test("formatDuration matches all range tiers (0ms, ms, s, m/s, h/m, d/h)", () => {
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(-100)).toBe("0ms");
		expect(formatDuration(500)).toBe("500ms");
		expect(formatDuration(12_300)).toBe("12.3s");
		expect(formatDuration(65_000)).toBe("1m5s");
		expect(formatDuration(120_000)).toBe("2m");
		expect(formatDuration(3_720_000)).toBe("1h2m");
		expect(formatDuration(7_200_000)).toBe("2h");
		expect(formatDuration(90_000_000)).toBe("1d1h");
		expect(formatDuration(172_800_000)).toBe("2d");
	});

	test("defensive unpack: non-object inputs return undefined and render does not throw", () => {
		const nonObjects = [
			null,
			undefined,
			123,
			NaN,
			Infinity,
			"not an object",
			"",
			[],
			[1, 2, 3],
			true,
			false,
		];

		for (const input of nonObjects) {
			expect(vibeCardsModule.unpackVibeToolDetails(input)).toBeUndefined();
			expect(() => {
				const rows = vibeCardsModule.renderCompactVibeRows(
					{
						op: "wait",
						result: input,
					} as unknown as CompactVibeView,
					fakeTheme(),
				);
				expect(rows).toBeArray();
			}).not.toThrow();
		}
	});

	test("defensive unpack: missing or nonexistent op field returns undefined and render does not throw", () => {
		const invalidOps = [
			{},
			{ foo: "bar" },
			{ screens: [] },
			{ op: "unknown", screens: [] },
			{ op: "destroy", screens: [] },
			{ op: 123, screens: [] },
			{ op: null, screens: [] },
			{ op: true, screens: [] },
		];

		for (const input of invalidOps) {
			expect(vibeCardsModule.unpackVibeToolDetails(input)).toBeUndefined();
			expect(() => {
				const rows = vibeCardsModule.renderCompactVibeRows(
					{
						op: "wait",
						result: input,
					} as unknown as CompactVibeView,
					fakeTheme(),
				);
				expect(rows).toBeArray();
			}).not.toThrow();
		}
	});

	test("defensive unpack: missing or non-array screens returns undefined and render does not throw", () => {
		const invalidScreens = [
			{ op: "wait" },
			{ op: "wait", screens: "invalid" },
			{ op: "wait", screens: 123 },
			{ op: "wait", screens: null },
			{ op: "wait", screens: undefined },
			{ op: "wait", screens: {} },
			{ op: "wait", screens: true },
		];

		for (const input of invalidScreens) {
			expect(vibeCardsModule.unpackVibeToolDetails(input)).toBeUndefined();
			expect(() => {
				const rows = vibeCardsModule.renderCompactVibeRows(
					{
						op: "wait",
						result: input,
					} as unknown as CompactVibeView,
					fakeTheme(),
				);
				expect(rows).toBeArray();
			}).not.toThrow();
		}
	});

	test("defensive unpack: screens array with garbage elements filters to empty array and render does not throw", () => {
		const input = {
			op: "wait",
			screens: [123, "text", null, undefined, [], true, false, {}],
		};

		const unpacked = vibeCardsModule.unpackVibeToolDetails(input);
		expect(unpacked).toBeDefined();
		expect(unpacked?.op).toBe("wait");
		expect(unpacked?.screens).toEqual([]);

		expect(() => {
			const rows = vibeCardsModule.renderCompactVibeRows(
				routineView({
					op: "wait",
					details: unpacked,
				}),
				fakeTheme(),
			);
			expect(rows).toBeArray();
		}).not.toThrow();
	});

	test("defensive unpack: screens missing required id or with non-string id are dropped", () => {
		const input = {
			op: "wait",
			screens: [
				{ cli: "fast", state: "running", turns: 1, queued: 0 },
				{ id: "   ", cli: "fast", state: "running", turns: 1, queued: 0 },
				{ id: 123, cli: "fast", state: "running", turns: 1, queued: 0 },
				{ id: null, cli: "fast", state: "running", turns: 1, queued: 0 },
				{ id: {}, cli: "fast", state: "running", turns: 1, queued: 0 },
				{ id: "valid-w", cli: "good", state: "running", turns: 1, queued: 0 },
			],
		};

		const unpacked = vibeCardsModule.unpackVibeToolDetails(input);
		expect(unpacked).toBeDefined();
		expect(unpacked?.screens).toHaveLength(1);
		expect(unpacked?.screens[0]?.id).toBe("valid-w");

		expect(() => {
			const rows = vibeCardsModule.renderCompactVibeRows(
				routineView({
					op: "wait",
					details: unpacked,
				}),
				fakeTheme(),
			);
			expect(rows).toHaveLength(1);
		}).not.toThrow();
	});

	test("defensive unpack: invalid types and negative counters in snapshot are normalized safely", () => {
		const input = {
			op: "list",
			screens: [
				{
					id: "worker-dirty",
					cli: "invalid_cli",
					state: "invalid_state",
					turns: -5,
					queued: -2,
					turnStartedAt: -100,
					lastActivityAt: "invalid_time",
					model: 123,
					turnMessage: true,
					currentTool: [],
					lastActivity: "valid last activity text",
				},
			],
		};

		const unpacked = vibeCardsModule.unpackVibeToolDetails(input);
		expect(unpacked).toBeDefined();
		expect(unpacked?.screens).toHaveLength(1);
		const s = unpacked?.screens[0];
		expect(s?.id).toBe("worker-dirty");
		expect(s?.cli).toBe("fast");
		expect(s?.state).toBe("idle");
		expect(s?.turns).toBe(0);
		expect(s?.queued).toBe(0);
		expect(s?.turnStartedAt).toBeUndefined();
		expect(s?.lastActivityAt).toBe(0);
		expect(s?.model).toBeUndefined();
		expect(s?.turnMessage).toBeUndefined();
		expect(s?.currentTool).toBeUndefined();
		expect(s?.lastActivity).toBe("valid last activity text");

		expect(() => {
			const rows = vibeCardsModule.renderCompactVibeRows(
				routineView({
					op: "list",
					isPartial: false,
					details: unpacked,
					now: 1_000,
				}),
				fakeTheme(),
			);
			expect(rows).toHaveLength(2);
			expect(stripAnsi(rows[1] ?? "")).toBe(
				"∷ ⟦f⟧ worker-dirty 0t valid last activity text",
			);
		}).not.toThrow();
	});

	test("defensive unpack: non-array trace and outputTail are normalized safely", () => {
		const input = {
			op: "wait",
			screens: [
				{
					id: "worker-trace",
					cli: "fast",
					state: "running",
					turns: 1,
					queued: 0,
					lastActivityAt: 1_000,
					trace: "not-an-array",
					outputTail: 12345,
				},
				{
					id: "worker-trace-mixed",
					cli: "good",
					state: "running",
					turns: 1,
					queued: 0,
					lastActivityAt: 1_000,
					trace: [123, null, "read src/file.ts", true, {}],
					outputTail: [null, "first line", 456],
				},
			],
		};

		const unpacked = vibeCardsModule.unpackVibeToolDetails(input);
		expect(unpacked).toBeDefined();
		expect(unpacked?.screens).toHaveLength(2);
		expect(unpacked?.screens[0]?.trace).toEqual([]);
		expect(unpacked?.screens[0]?.outputTail).toEqual([]);
		expect(unpacked?.screens[1]?.trace).toEqual(["read src/file.ts"]);
		expect(unpacked?.screens[1]?.outputTail).toEqual(["first line"]);

		expect(() => {
			const rows = vibeCardsModule.renderCompactVibeRows(
				routineView({
					op: "wait",
					isPartial: true,
					details: unpacked,
				}),
				fakeTheme(),
			);
			expect(rows).toHaveLength(3);
		}).not.toThrow();
	});

	test("defensive unpack: wait outcome with malformed settled entries preserves only valid records", () => {
		const input = {
			op: "wait",
			screens: [
				{
					id: "w1",
					cli: "fast",
					state: "idle",
					turns: 1,
					queued: 0,
					lastActivityAt: 1_000,
					lastActivity: "done",
				},
			],
			wait: {
				settled: [
					{ id: "w1", jobId: "j1", status: "completed" },
					{ id: "w2", jobId: "j2", status: "unknown_status" },
					{ id: 123, jobId: "j3", status: "completed" },
					null,
					"garbage",
					[],
				],
				stillRunning: [123, "w-running", null, {}],
				timedOut: "yes",
				waiting: "no",
			},
		};

		const unpacked = vibeCardsModule.unpackVibeToolDetails(input);
		expect(unpacked).toBeDefined();
		expect(unpacked?.wait?.settled).toEqual([
			{ id: "w1", jobId: "j1", status: "completed" },
		]);
		expect(unpacked?.wait?.stillRunning).toEqual(["w-running"]);
		expect(unpacked?.wait?.timedOut).toBe(false);
		expect(unpacked?.wait?.waiting).toBeUndefined();

		expect(() => {
			const rows = vibeCardsModule.renderCompactVibeRows(
				routineView({
					op: "wait",
					isPartial: false,
					details: unpacked,
					now: 2_000,
				}),
				fakeTheme(),
			);
			expect(rows).toHaveLength(2);
		}).not.toThrow();
	});

	test("defensive unpack: send outcome with unknown delivery mode is dropped", () => {
		const inputUnknown = {
			op: "send",
			screens: [],
			send: { id: "w1", mode: "telepathic" },
		};
		const unpackedUnknown = vibeCardsModule.unpackVibeToolDetails(inputUnknown);
		expect(unpackedUnknown?.send).toBeUndefined();

		const inputInvalidId = {
			op: "send",
			screens: [],
			send: { id: 123, mode: "steered" },
		};
		const unpackedInvalidId =
			vibeCardsModule.unpackVibeToolDetails(inputInvalidId);
		expect(unpackedInvalidId?.send).toBeUndefined();

		const inputNotObject = {
			op: "send",
			screens: [],
			send: "not-an-object",
		};
		const unpackedNotObject =
			vibeCardsModule.unpackVibeToolDetails(inputNotObject);
		expect(unpackedNotObject?.send).toBeUndefined();

		const inputValid = {
			op: "send",
			screens: [],
			send: { id: "w1", mode: "queued", jobId: 456 },
		};
		const unpackedValid = vibeCardsModule.unpackVibeToolDetails(inputValid);
		expect(unpackedValid?.send).toEqual({
			id: "w1",
			mode: "queued",
			jobId: undefined,
		});

		expect(() => {
			const rows = vibeCardsModule.renderCompactVibeRows(
				{
					op: "send",
					isPartial: false,
					args: { session: "w1", message: "Hello" },
					details: unpackedValid,
				},
				fakeTheme(),
			);
			expect(rows).toHaveLength(1);
		}).not.toThrow();
	});

	test("defensive unpack: extra unknown fields alongside known valid fields are ignored", () => {
		const input = {
			op: "wait",
			screens: [
				{
					id: "w1",
					cli: "good",
					state: "running",
					turns: 1,
					queued: 0,
					lastActivityAt: 1_000,
					rogueField1: "test",
					rogueField2: { x: 1 },
					extraList: [1, 2, 3],
				},
			],
			extraTop1: true,
			extraTop2: [1, 2, 3],
			extraTop3: { a: 1 },
		};

		const unpacked = vibeCardsModule.unpackVibeToolDetails(input);
		expect(unpacked).toBeDefined();
		expect(unpacked?.op).toBe("wait");
		expect(unpacked?.screens).toHaveLength(1);
		expect(unpacked?.screens[0]?.id).toBe("w1");
		expect(unpacked?.screens[0]?.cli).toBe("good");
		const topRecord = unpacked as unknown as
			| Record<string, unknown>
			| undefined;
		expect(topRecord?.extraTop1).toBeUndefined();
		const screenRecord = unpacked?.screens[0] as unknown as
			| Record<string, unknown>
			| undefined;
		expect(screenRecord?.rogueField1).toBeUndefined();

		expect(() => {
			const rows = vibeCardsModule.renderCompactVibeRows(
				routineView({
					op: "wait",
					isPartial: true,
					details: unpacked,
					now: 2_000,
				}),
				fakeTheme(),
			);
			expect(rows).toHaveLength(1);
		}).not.toThrow();
	});

	test("defensive unpack: partially valid input preserves valid part and drops invalid part", () => {
		const input = {
			op: "wait",
			screens: [
				{
					id: "valid-1",
					cli: "fast",
					state: "running",
					turns: 1,
					queued: 0,
					lastActivityAt: 1_000,
				},
				123,
				{ id: "   ", cli: "fast", state: "running", turns: 1, queued: 0 },
				{
					id: "valid-2",
					cli: "good",
					state: "starting",
					turns: 0,
					queued: 0,
					lastActivityAt: 1_000,
				},
				null,
			],
		};

		const unpacked = vibeCardsModule.unpackVibeToolDetails(input);
		expect(unpacked).toBeDefined();
		expect(unpacked?.screens).toHaveLength(2);
		expect(unpacked?.screens[0]?.id).toBe("valid-1");
		expect(unpacked?.screens[1]?.id).toBe("valid-2");

		expect(() => {
			const rows = vibeCardsModule.renderCompactVibeRows(
				routineView({
					op: "wait",
					isPartial: true,
					details: unpacked,
					now: 2_000,
				}),
				fakeTheme(),
			);
			expect(rows).toHaveLength(3);
		}).not.toThrow();
	});

	test("defensive unpack: circular object references do not throw and are handled safely", () => {
		const circular: Record<string, unknown> = {
			op: "wait",
			screens: [],
		};
		circular.self = circular;
		const unpackedCircular = vibeCardsModule.unpackVibeToolDetails(circular);
		expect(unpackedCircular).toBeDefined();
		expect(unpackedCircular?.op).toBe("wait");
		expect(unpackedCircular?.screens).toEqual([]);
	});

	test("width edge cases: very narrow terminal widths and undefined width render robustly", () => {
		const screen = routineSnapshot({
			id: "audit-worker-wide",
			cli: "fast",
			state: "running",
			turns: 2,
			queued: 1,
			turnStartedAt: 10_000,
			model: "AuraPass/grok-4.5:medium",
			turnMessage: "Scan host adapter for wide rendering boundaries",
		});

		const view = routineView({
			details: routineDetails({ screens: [screen] }),
			now: 22_300,
		});

		// Very narrow widths: 20, 15, 5, 0
		for (const w of [20, 15, 5, 0]) {
			const rows = vibeCardsModule.renderCompactVibeRows(view, fakeTheme(), w);
			expect(rows).toHaveLength(1);
			const row = rows[0] ?? "";
			const plain = stripAnsi(row);
			if (w > 0) {
				expect(plain.length).toBeLessThanOrEqual(w);
			}
		}

		// Width undefined
		const unconstrainedRows = vibeCardsModule.renderCompactVibeRows(
			view,
			fakeTheme(),
			undefined,
		);
		expect(unconstrainedRows).toHaveLength(1);
		expect(stripAnsi(unconstrainedRows[0] ?? "")).toBe(
			"⠦ ⟦f⟧ audit-worker-wide 2t+1q 12.3s grok-4.5 Scan host adapter for wide rendering boundaries",
		);
	});
});
