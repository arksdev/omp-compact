import { afterAll, expect } from "bun:test";
import {
	addTool,
	type BootedPlugin,
	beginRun,
	bootWithMode,
	bootWithTranscript,
	cleanupGeneratedDirs,
	dispatch,
	finishTool,
	screenRows,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";
import type { TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

// ---------------------------------------------------------------------------
// Vibe worker-session devices: the five stock `vibe_*` tools route compact
// and their rows come from the plugin's vibe builder, never from the stock
// framed TV-wall/composer chrome. The rows below are pinned exactly (ANSI
// stripped): a settled `vibe_list` prints its `vibe sessions N` header plus
// one card per live worker, and an in-flight `vibe_wait` prints its interim
// progress frame from `tool_execution_update` — the timer-driven partial
// result the wait tool emits while it blocks. No row depends on the current
// moment: every snapshot below omits `turnStartedAt`, so no duration slot
// (and no settled-outcome TTL) is evaluated against the clock.
// ---------------------------------------------------------------------------

stockTest(
	"vibe list and vibe wait print compact plugin rows, never the stock cards",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);

		// Settled vibe_list: one idle worker with recorded activity.
		const list = await addTool(booted, "vibe_list", {}, "vibe-list-1");
		list.render = () => ["native-vibe-list"];
		await finishTool(booted, list, {
			toolCallId: "vibe-list-1",
			toolName: "vibe_list",
			result: {
				content: [{ type: "text", text: "- `audit-worker` [good] idle" }],
				details: {
					op: "list",
					screens: [
						{
							id: "audit-worker",
							cli: "good",
							state: "idle",
							model: "AuraPass/grok-4.5:medium",
							turns: 2,
							queued: 0,
							trace: [],
							outputTail: [],
							lastActivity: "Reported the registry diff",
							lastActivityAt: 1_000,
						},
					],
				},
			},
			isError: false,
		});

		// In-flight vibe_wait: the interim progress emission (waiting: true)
		// carries two starting workers, so the builder prints its header.
		const wait = await addTool(
			booted,
			"vibe_wait",
			{ sessions: ["wire-vibe", "cards-impl"], timeout: 30 },
			"vibe-wait-1",
		);
		wait.render = () => ["native-vibe-wait"];
		await dispatch(booted, {
			type: "tool_execution_update",
			toolCallId: "vibe-wait-1",
			toolName: "vibe_wait",
			args: { sessions: ["wire-vibe", "cards-impl"], timeout: 30 },
			partialResult: {
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					screens: [
						{
							id: "wire-vibe",
							cli: "fast",
							state: "starting",
							turns: 0,
							queued: 0,
							turnMessage: "Wire the vibe rows",
							trace: [],
							outputTail: [],
							lastActivityAt: 1_000,
						},
						{
							id: "cards-impl",
							cli: "good",
							state: "starting",
							turns: 1,
							queued: 2,
							turnMessage: "Build the row grammar",
							trace: [],
							outputTail: [],
							lastActivityAt: 1_000,
						},
					],
					wait: {
						settled: [],
						stillRunning: ["wire-vibe", "cards-impl"],
						timedOut: false,
						waiting: true,
					},
				},
			},
		});

		expect(visibleRows(booted.transcript)).toEqual([
			"vibe sessions 1",
			"∷ ⟦g⟧ audit-worker 2t grok-4.5 Reported the registry diff",
			"vibe wait 2 on air",
			"∴ ⟦f⟧ wire-vibe 0t Wire the vibe rows",
			"∴ ⟦g⟧ cards-impl 1t+2q Build the row grammar",
		]);
		const live = visibleRows(booted.transcript).join("\n");
		// Neither stock card is printed, and the vibe branch resolves before
		// the generic registry description: no `Working…` summary row and no
		// `vibe list: …` / `vibe wait: …` title row anywhere.
		expect(live).not.toContain("native-vibe-list");
		expect(live).not.toContain("native-vibe-wait");
		expect(live).not.toContain("Working…");
		expect(live).not.toContain("vibe wait:");
		expect(live).not.toContain("vibe list:");

		// The wait tool's live frame keeps animating: a running worker's
		// braille glyph comes from the pending tick, and the spinner
		// interval advances it while the partial result stays in place.
		const theme = booted.host.getTheme() as unknown as {
			getSpinnerFrames?: (name: string) => readonly string[];
			spinnerFrames?: readonly string[];
		};
		const frames =
			theme.getSpinnerFrames?.("activity") ?? theme.spinnerFrames ?? [];
		expect(frames.length).toBeGreaterThan(0);
		await dispatch(booted, {
			type: "tool_execution_update",
			toolCallId: "vibe-wait-1",
			toolName: "vibe_wait",
			args: { sessions: ["wire-vibe"], timeout: 30 },
			partialResult: {
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					screens: [
						{
							id: "wire-vibe",
							cli: "fast",
							state: "running",
							turns: 3,
							queued: 0,
							currentTool: "edit",
							lastIntent: "Wiring the vibe rows",
							trace: [],
							outputTail: [],
							lastActivityAt: 1_000,
						},
					],
					wait: {
						settled: [],
						stillRunning: ["wire-vibe"],
						timedOut: false,
						waiting: true,
					},
				},
			},
		});
		const beforeTick = visibleRows(booted.transcript);
		// A single rendered card prints no header row.
		expect(beforeTick).toHaveLength(3);
		const runningRow = beforeTick[2] ?? "";
		expect(runningRow).toContain("⟦f⟧ wire-vibe 3t edit: Wiring the vibe rows");
		expect(frames.some((frame) => runningRow.startsWith(frame))).toBe(true);
		const spinnerTick = booted.intervalCallbacks.at(-1);
		expect(spinnerTick).toBeDefined();
		spinnerTick?.();
		const afterTick = visibleRows(booted.transcript);
		expect(afterTick[2]).not.toEqual(runningRow);
		expect(afterTick[2]).toContain(
			"⟦f⟧ wire-vibe 3t edit: Wiring the vibe rows",
		);
		await shutdown(booted);
	},
);

// ---------------------------------------------------------------------------
// `compactVibeRows` settings toggle: the compact vibe rows are a preference,
// so switching it off must hand the five devices back to the stock framed
// card — not hide them, and not print a generic summary row. The flag is
// frozen per run alongside the mode, so both halves below boot their own
// plugin instance with the persisted value they exercise.
// ---------------------------------------------------------------------------

/** Settle one `vibe_list` card and return the transcript rows it produced. */
async function vibeListRows(
	booted: BootedPlugin & { transcript: TranscriptInstance },
): Promise<string[]> {
	await beginRun(booted);
	const list = await addTool(booted, "vibe_list", {}, "vibe-toggle-list");
	list.render = () => ["native-vibe-list-card"];
	await finishTool(booted, list, {
		toolCallId: "vibe-toggle-list",
		toolName: "vibe_list",
		result: {
			content: [{ type: "text", text: "- `audit-worker` [good] idle" }],
			details: {
				op: "list",
				screens: [
					{
						id: "audit-worker",
						cli: "good",
						state: "idle",
						model: "AuraPass/grok-4.5:medium",
						turns: 2,
						queued: 0,
						trace: [],
						outputTail: [],
						lastActivity: "Reported the registry diff",
						lastActivityAt: 1_000,
					},
				],
			},
		},
		isError: false,
	});
	return visibleRows(booted.transcript);
}

stockTest(
	"compactVibeRows=false gives the worker-session tools back their stock card",
	async () => {
		const booted = await bootWithMode("live", { compactVibeRows: false });
		const rows = await vibeListRows(booted);
		// The stock card renders verbatim, exactly as for an unknown tool.
		expect(rows).toEqual(["native-vibe-list-card"]);
		const live = rows.join("\n");
		// Neither the plugin's vibe grammar nor the generic registry summary
		// replaces it, and the row is not hidden either.
		expect(live).not.toContain("vibe sessions");
		expect(live).not.toContain("audit-worker 2t");
		expect(live).not.toContain("vibe list:");
		await shutdown(booted);
	},
);

stockTest(
	"compactVibeRows=true keeps the compact worker-session rows",
	async () => {
		const booted = await bootWithMode("live", { compactVibeRows: true });
		const rows = await vibeListRows(booted);
		expect(rows).toEqual([
			"vibe sessions 1",
			"∷ ⟦g⟧ audit-worker 2t grok-4.5 Reported the registry diff",
		]);
		expect(rows.join("\n")).not.toContain("native-vibe-list-card");
		await shutdown(booted);
	},
);

stockTest(
	"a vibe row set that is legally empty prints nothing and never falls back",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		// vibe_kill prints no row by design; the block must render zero rows
		// instead of the stock card or a synthesized generic summary row.
		const kill = await addTool(
			booted,
			"vibe_kill",
			{ session: "audit-worker" },
			"vibe-kill-1",
		);
		kill.render = () => ["native-vibe-kill"];
		await finishTool(booted, kill, {
			toolCallId: "vibe-kill-1",
			toolName: "vibe_kill",
			result: {
				content: [{ type: "text", text: "Killed session `audit-worker`." }],
				details: {
					op: "kill",
					screens: [],
					killed: { id: "audit-worker", cancelledTurn: true },
				},
			},
			isError: false,
		});
		expect(screenRows(booted.transcript)).toEqual([]);

		// A wait whose watched worker is idle without activity renders no
		// card, so the builder's bare `vibe wait` header is the entire row
		// set (the header is omitted only for exactly one rendered card).
		// Still the plugin's row, never the stock framed card.
		const wait = await addTool(
			booted,
			"vibe_wait",
			{ sessions: ["quiet-worker"] },
			"vibe-wait-empty",
		);
		wait.render = () => ["native-vibe-wait-empty"];
		await finishTool(booted, wait, {
			toolCallId: "vibe-wait-empty",
			toolName: "vibe_wait",
			result: {
				content: [{ type: "text", text: "No turns in flight to wait for." }],
				details: {
					op: "wait",
					screens: [
						{
							id: "quiet-worker",
							cli: "fast",
							state: "idle",
							turns: 0,
							queued: 0,
							trace: [],
							outputTail: [],
							lastActivityAt: 1_000,
						},
					],
					wait: { settled: [], stillRunning: [], timedOut: false },
				},
			},
			isError: false,
		});
		expect(visibleRows(booted.transcript)).toEqual(["vibe wait"]);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).not.toContain("native-vibe-kill");
		expect(live).not.toContain("native-vibe-wait-empty");
		expect(live).not.toContain("Working…");

		// The empty kill row set never breaks the surrounding transcript: an
		// ordinary compact row added after it still renders in order.
		const bash = await addTool(
			booted,
			"bash",
			{ command: "printf after-vibe" },
			"vibe-after-bash",
		);
		await finishTool(booted, bash, {
			toolCallId: "vibe-after-bash",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		expect(visibleRows(booted.transcript)).toEqual([
			"vibe wait",
			"• bash: printf after-vibe",
		]);
		await shutdown(booted);
	},
);

stockTest(
	"a late vibe wait progress update re-arms the pending spinner",
	async () => {
		// The wait tool emits interim progress on a 500 ms timer while it
		// blocks (`WAIT_PROGRESS_INTERVAL_MS` in the stock vibe tool) and
		// stock delivers extension events fire-and-forget, so the last queued
		// progress emission can land AFTER tool_execution_end. That update
		// makes the state pending again; without a spinner re-arm its running
		// card would freeze on one braille frame forever.
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const wait = await addTool(
			booted,
			"vibe_wait",
			{ sessions: ["late-worker"] },
			"vibe-wait-late",
		);
		wait.render = () => ["native-vibe-wait-late"];
		expect(booted.intervalCallbacks).toHaveLength(1);
		const runningScreen = {
			id: "late-worker",
			cli: "fast",
			state: "running",
			turns: 1,
			queued: 0,
			currentTool: "bash",
			lastIntent: "Running the suite",
			trace: [],
			outputTail: [],
			lastActivityAt: 1_000,
		};
		await finishTool(booted, wait, {
			toolCallId: "vibe-wait-late",
			toolName: "vibe_wait",
			result: {
				content: [{ type: "text", text: "Still running: `late-worker`." }],
				details: {
					op: "wait",
					screens: [runningScreen],
					wait: {
						settled: [],
						stillRunning: ["late-worker"],
						timedOut: true,
					},
				},
			},
			isError: false,
		});
		// Idle tick after the settle clears the interval.
		booted.intervalCallbacks[0]?.();
		expect(booted.clearedTimers).toEqual([booted.intervalCallbacks[0]]);

		// The trailing timer emission arrives now, after the end event.
		await dispatch(booted, {
			type: "tool_execution_update",
			toolCallId: "vibe-wait-late",
			toolName: "vibe_wait",
			args: { sessions: ["late-worker"] },
			partialResult: {
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					screens: [runningScreen],
					wait: {
						settled: [],
						stillRunning: ["late-worker"],
						timedOut: false,
						waiting: true,
					},
				},
			},
		});
		const beforeTick = visibleRows(booted.transcript);
		expect(beforeTick).toHaveLength(1);
		expect(beforeTick[0]).toContain(
			"⟦f⟧ late-worker 1t bash: Running the suite",
		);
		// A fresh interval must exist for the re-pended state, and ticking it
		// must advance the braille frame instead of leaving the row frozen.
		expect(booted.intervalCallbacks).toHaveLength(2);
		booted.intervalCallbacks[1]?.();
		const afterTick = visibleRows(booted.transcript);
		expect(afterTick[0]).not.toEqual(beforeTick[0]);
		expect(afterTick[0]).toContain(
			"⟦f⟧ late-worker 1t bash: Running the suite",
		);
		await shutdown(booted);
	},
);

stockTest(
	"a settled vibe card renders identically on a later repaint",
	async () => {
		// End-to-end cover for the adapter -> renderer frame clock: the tool
		// state stamps `settledAt` at its end event, `#renderBlock` threads it
		// into the view, and the vibe renderer measures its TTLs against that
		// instead of paint time. Without the wiring the host's own repaint
		// paths (resize `renderTail`, replay, shutdown flush) re-measure
		// against a later wall clock and the settlement card disappears from
		// committed scrollback while the rows above it stay intact.
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const wait = await addTool(
			booted,
			"vibe_wait",
			{ sessions: ["ttl-worker"] },
			"vibe-wait-ttl",
		);
		wait.render = () => ["native-vibe-wait-ttl"];
		await finishTool(booted, wait, {
			toolCallId: "vibe-wait-ttl",
			toolName: "vibe_wait",
			result: {
				content: [{ type: "text", text: "Worker failed." }],
				details: {
					op: "wait",
					screens: [
						{
							id: "ttl-worker",
							cli: "fast",
							state: "idle",
							turns: 1,
							queued: 0,
							lastIntent: "boom",
							trace: [],
							outputTail: [],
							lastActivityAt: Date.now(),
						},
					],
					wait: {
						settled: [{ id: "ttl-worker", jobId: "job-ttl", status: "failed" }],
						stillRunning: [],
						timedOut: false,
					},
				},
			},
			isError: false,
		});

		const settled = visibleRows(booted.transcript);
		expect(settled.join("\n")).toContain("turn failed");

		// Repaint the same committed block well past the settlement TTL. The
		// frozen clock makes the rows a pure function of the evidence, so the
		// failure card must still be there.
		const realNow = Date.now;
		Date.now = () => realNow() + 3_600_000;
		try {
			expect(visibleRows(booted.transcript)).toEqual(settled);
		} finally {
			Date.now = realNow;
		}
		await shutdown(booted);
	},
);
