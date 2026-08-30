import { afterAll, expect } from "bun:test";
import {
	addAnswer,
	addTool,
	type BootedPlugin,
	beginRun,
	bootWithMode,
	bootWithTranscript,
	type CommittedSeamTranscript,
	cleanupGeneratedDirs,
	dispatch,
	finishRun,
	finishTool,
	groupedRead,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";
import type { TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

// ---------------------------------------------------------------------------
// Folded runs must never turn into blank rows. The container retires history
// by rows, but its pressure fallback keys on block count: once live blocks
// outnumber the transcript height it prints each block's first row, and a
// folded member renders nothing, so its slot becomes an empty string. Folding
// shrinks rows without shrinking blocks, so a long session parks below the row
// pressure that triggers retirement while sitting above the block count that
// triggers the fallback.
// ---------------------------------------------------------------------------

async function foldedRun(
	booted: BootedPlugin & { transcript: TranscriptInstance },
	prefix: string,
	count: number,
): Promise<void> {
	for (let index = 0; index < count; index++) {
		const call = await addTool(
			booted,
			"bash",
			{ command: `printf ${prefix}-${index}` },
			`${prefix}-${index}`,
		);
		await finishTool(booted, call, {
			toolCallId: `${prefix}-${index}`,
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
	}
}

stockTest(
	"a run holding more blocks than the screen has rows renders compact rows, not blanks",
	async () => {
		const booted = await bootWithMode("compact");
		await beginRun(booted);
		// One open run, 24 mapped tools: 24 transcript blocks, of which only
		// the carrier renders anything.
		await foldedRun(booted, "open", 24);
		const transcript = booted.transcript;
		const capacity = 8;
		expect(transcript.children.length).toBeGreaterThan(capacity);
		// The run is still open, so nothing may retire: the viewport has to
		// cope with more blocks than rows on its own.
		expect(transcript.peekFinalizedBatch(120, capacity)).toBeUndefined();
		const tail = transcript
			.renderViewport(120, capacity, { tick: 0, now: 0 })
			.map((line) => Bun.stripANSI(line).trimEnd());
		expect(tail.filter((line) => line.trim().length === 0)).toEqual([]);
		expect(tail.length).toBe(capacity);
		// The newest rows win the screen, and they are the compact projection.
		expect(tail.at(0)).toBe("• bash: printf open-16");
		expect(tail.at(-1)).toBe("• bash: printf open-23");
		await shutdown(booted);
	},
);

stockTest(
	"hidden blocks retire on block pressure alone, without any row pressure",
	async () => {
		// `clear` hides routine rows outright: the run occupies 21 blocks and
		// almost no rows, so row pressure never asks the container to retire
		// anything while block count climbs past the screen height.
		const booted = await bootWithMode("clear");
		await beginRun(booted);
		await foldedRun(booted, "done", 20);
		addAnswer(booted, "first answer");
		await finishRun(booted, "first answer");
		// A second run keeps the transcript live while the first run's blocks
		// sit settled behind it.
		await beginRun(booted);
		await foldedRun(booted, "open", 2);
		const transcript = booted.transcript;
		const capacity = 12;
		// Nothing presses on rows: the hidden run projects to a single row.
		expect(transcript.liveRowCount(120)).toBeLessThan(capacity);
		expect(transcript.children.length).toBeGreaterThan(capacity);
		// Terminal frames, until block count is back under the height. Each
		// frame offers the prefix that still fits and the acknowledgement
		// retires it, exactly as the composer does.
		const history: string[] = [];
		let frames = 0;
		while (
			transcript.blockStates().filter((state) => state !== "committed").length >
			capacity
		) {
			const batch = transcript.peekFinalizedBatch(120, capacity);
			expect(batch).toBeDefined();
			history.push(...(batch as { rows: readonly string[] }).rows);
			transcript.acknowledgeFinalizedBatch((batch as { id: number }).id);
			frames++;
			expect(frames).toBeLessThan(transcript.children.length);
		}
		// Hidden rows retire as nothing, so history holds only what `clear`
		// shows: the run's summary line and the answer.
		const retired = history
			.map((line) => Bun.stripANSI(line).trimEnd())
			.filter((line) => line.trim().length > 0);
		expect(retired).toEqual([
			"[ 20 actions · 0 prompt · 0 received · 0s ]",
			"first answer",
		]);
		const tail = transcript
			.renderViewport(120, capacity, { tick: 0, now: 0 })
			.map((line) => Bun.stripANSI(line).trimEnd());
		expect(tail.filter((line) => line.trim().length === 0)).toEqual([]);
		await shutdown(booted);
	},
);

stockTest(
	"every compact row reaches the screen exactly once across retiring frames",
	async () => {
		const booted = await bootWithMode("compact");
		await beginRun(booted);
		await foldedRun(booted, "done", 24);
		addAnswer(booted, "an answer");
		await finishRun(booted, "an answer");
		await beginRun(booted);
		await foldedRun(booted, "open", 2);
		const transcript = booted.transcript;
		const capacity = 8;
		// Frames until retirement settles: history accumulates, the viewport
		// keeps the live tail. A row printed in both would show up twice in
		// the terminal's scrollback; a row printed in neither would be lost.
		const history: string[] = [];
		for (let frame = 0; frame < 40; frame++) {
			const batch = transcript.peekFinalizedBatch(120, capacity);
			if (!batch) break;
			history.push(...batch.rows);
			transcript.acknowledgeFinalizedBatch(batch.id);
		}
		const plain = (rows: readonly string[]): string[] =>
			rows
				.map((line) => Bun.stripANSI(line).trimEnd())
				.filter((line) => line.trim().length > 0);
		const printed = [
			...plain(history),
			...plain(transcript.renderViewport(120, capacity, { tick: 0, now: 0 })),
		];
		const expected = [
			...Array.from(
				{ length: 24 },
				(_, index) => `• bash: printf done-${index}`,
			),
			"[ 24 actions · 0 prompt · 0 received · 0s ]",
			"an answer",
			"• bash: printf open-0",
			"• bash: printf open-1",
		];
		expect(printed).toEqual(expected);
		await shutdown(booted);
	},
);

stockTest(
	"multi-response runs: early and late group rows follow the frozen mode at terminal; assistant texts keep order",
	async () => {
		const EXPECTED_COMPACT_ROWS = [
			"• bash: printf early",
			"• read src/early.ts",
			"• read src/a.ts",
			"• read src/b.ts",
			"• read src/c.ts",
			"• bash: printf late",
			"[ 6 actions · 0 prompt · 0 received · 0s ]",
			"final answer",
		];
		const EXPECTED_FILTERED_ROWS = [
			"[ 6 actions · 0 prompt · 0 received · 0s ]",
			"final answer",
		];
		for (const mode of ["live", "compact", "clear"] as const) {
			const booted = await bootWithMode(mode);
			await beginRun(booted);

			// Group 1 (early): a routine tool and a read, then a toolUse
			// continuation (agent_end willContinue).
			const bashEarly = await addTool(
				booted,
				"bash",
				{ command: "printf early" },
				"early-bash",
			);
			await finishTool(booted, bashEarly, {
				toolCallId: "early-bash",
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			});
			await groupedRead(booted, "src/early.ts", "early-read");
			await finishRun(booted, "early group text", "toolUse", true);

			// Group 2 (late): three parallel reads in ONE group; results
			// arrive out of call order (b, c) with the last delayed until
			// after the next continuation agent_end; then a routine tool.
			const lateGroup = new booted.host.ReadToolGroupComponent();
			booted.transcript.addChild(lateGroup);
			lateGroup.updateArgs({ path: "src/a.ts" }, "late-a");
			lateGroup.updateArgs({ path: "src/b.ts" }, "late-b");
			lateGroup.updateArgs({ path: "src/c.ts" }, "late-c");
			await dispatch(booted, {
				type: "tool_execution_start",
				toolCallId: "late-a",
				toolName: "read",
				args: { path: "src/a.ts" },
			});
			await dispatch(booted, {
				type: "tool_execution_start",
				toolCallId: "late-b",
				toolName: "read",
				args: { path: "src/b.ts" },
			});
			await dispatch(booted, {
				type: "tool_execution_start",
				toolCallId: "late-c",
				toolName: "read",
				args: { path: "src/c.ts" },
			});
			const settleLateRead = async (id: string): Promise<void> => {
				await dispatch(booted, {
					type: "tool_execution_end",
					toolCallId: id,
					toolName: "read",
					result: { content: [{ type: "text", text: id }], details: {} },
					isError: false,
				});
				lateGroup.updateResult(
					{ content: [{ type: "text", text: id }], details: {} },
					false,
					id,
				);
			};
			await settleLateRead("late-b");
			await settleLateRead("late-c");
			await finishRun(booted, "late group text", "toolUse", true);
			await settleLateRead("late-a");
			const bashLate = await addTool(
				booted,
				"bash",
				{ command: "printf late" },
				"late-bash",
			);
			await finishTool(booted, bashLate, {
				toolCallId: "late-bash",
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			});

			// While working, the committed-row seam is observable: every
			// mapped member is still live (uncommitted), and declaring the
			// run's rows committed through the carrier seam flips the
			// transcript report for members below the boundary.
			const liveRows = visibleRows(booted.transcript).join("\n");
			if (mode === "clear") {
				// `clear` hides ordinary rows from the very first phase.
				expect(liveRows).toBe("");
			} else {
				expect(liveRows).toContain("printf early");
				expect(liveRows).toContain("src/c.ts");
			}
			const transcript = booted.transcript as CommittedSeamTranscript;
			const span = visibleRows(booted.transcript).length;
			if (mode === "clear") {
				// `clear` never projects ordinary rows, so there is nothing to
				// retire: no batch is offered and the projection stays hidden.
				expect(span).toBe(0);
				expect(transcript.canRemoveBlock?.(lateGroup)).toBe(true);
				expect(transcript.peekFinalizedBatch?.(120, 100)).toBeUndefined();
				expect(visibleRows(booted.transcript).join("\n")).toBe("");
			} else {
				expect(span).toBeGreaterThan(0);
				// An open run belongs to the mutable viewport: its members are
				// removable and no history batch may claim them.
				expect(transcript.canRemoveBlock?.(lateGroup)).toBe(true);
				expect(transcript.canRemoveBlock?.(bashLate)).toBe(true);
				expect(transcript.peekFinalizedBatch?.(120, 100)).toBeUndefined();
				expect(visibleRows(booted.transcript).join("\n")).toContain(
					"printf late",
				);
			}

			// Terminal answer: the assistant text is unchanged and last, and
			// every mapped row from both groups follows the frozen mode.
			addAnswer(booted, "final answer");
			await finishRun(booted, "final answer");
			const terminalRows = visibleRows(booted.transcript);
			if (mode === "compact") {
				expect(terminalRows).toEqual(EXPECTED_COMPACT_ROWS);
			} else {
				// `live` filters every routine row; `clear` hides ordinary rows.
				expect(terminalRows).toEqual(EXPECTED_FILTERED_ROWS);
			}
			// Both groups finalized: with the run closed the container may retire
			// the whole span, and what it retires is the folded projection.
			expect(bashEarly.isTranscriptBlockFinalized()).toBe(true);
			expect(bashLate.isTranscriptBlockFinalized()).toBe(true);
			await shutdown(booted);
		}
	},
);

stockTest(
	"global disable disposes the runtime but keeps the settings command",
	async () => {
		const booted = await bootWithMode("live", { enabled: false });
		// the settings command stays registered even when runtime is disabled
		expect(booted.commands).toContain("compact-settings");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"write",
			{ path: "off.ts", content: "x" },
			"write-off",
		);
		await finishTool(booted, call, {
			toolCallId: "write-off",
			toolName: "write",
			result: { content: [{ type: "text", text: "written" }] },
			isError: false,
		});
		// no adapter: no compact rows, no audit evidence, no timers
		expect(visibleRows(booted.transcript).join("\n")).not.toContain("• write");
		expect(booted.appendedEntries).toEqual([]);
		expect(booted.intervalCallbacks).toEqual([]);
		await shutdown(booted);
	},
);

stockTest(
	"re-enable after a disabled session reinstalls the runtime cleanly",
	async () => {
		const disabled = await bootWithMode("live", { enabled: false });
		await beginRun(disabled);
		expect(disabled.intervalCallbacks).toEqual([]);
		await shutdown(disabled);
		// a fresh session with the runtime enabled reinstalls the adapter
		const enabled = await bootWithTranscript();
		await beginRun(enabled);
		const call = await addTool(
			enabled,
			"bash",
			{ command: "printf reenabled" },
			"bash-re",
		);
		await finishTool(enabled, call, {
			toolCallId: "bash-re",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(visibleRows(enabled.transcript).join("\n")).toContain(
			"bash: printf reenabled",
		);
		await shutdown(enabled);
	},
);
