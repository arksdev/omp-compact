import { describe, expect, test } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";

import {
	type AnimationFrame,
	type BlockState,
	type FoldCallbacks,
	type HistoryBatch,
	type RenderableBlock,
	TranscriptFold,
	type TranscriptHost,
} from "../../.omp-plugin/transcript-fold";

type Lines = readonly string[];

class FakeBlock implements RenderableBlock {
	render(_width: number): Lines {
		return ["native-block"];
	}

	isTranscriptBlockFinalized(): boolean {
		return false;
	}

	isDisplaceableBlock(): boolean {
		return false;
	}

	seal(): void {}
}

const FRAME: AnimationFrame = { tick: 0, now: 0 };

class FakeTranscript implements TranscriptHost {
	readonly children: unknown[] = [];
	readonly marker = { keep: true };

	addChild(child: unknown): void {
		this.children.push(child);
	}

	render(width: number): Lines {
		const rows: string[] = [];
		for (const child of this.children) {
			if (
				child !== null &&
				typeof child === "object" &&
				"render" in child &&
				typeof child.render === "function"
			) {
				rows.push(...(child as RenderableBlock).render(width));
			}
		}
		return rows;
	}

	renderViewport(width: number, rows: number, _frame: AnimationFrame): Lines {
		return this.render(width).slice(0, rows);
	}

	liveRowCount(width: number, limit?: number): number {
		this.liveRowLimits.push(limit);
		return this.render(width).length;
	}

	/** Budgets the container handed its live-row walk (undefined = unbounded). */
	readonly liveRowLimits: (number | undefined)[] = [];

	peekFinalizedBatch(
		_width: number,
		_capacity: number,
	): HistoryBatch | undefined {
		return this.batch;
	}

	/** What the container would hand the terminal for retirement. */
	batch: HistoryBatch | undefined;

	/** 18.0.6 complete-history replay, driven by the terminal's resetDisplay. */
	peekReplayBatch(width: number): HistoryBatch | undefined {
		this.replayWidths.push(width);
		return this.replay;
	}

	readonly replayWidths: number[] = [];
	replay: HistoryBatch | undefined;

	/** Resize repaint of the trailing rows; renders every child directly. */
	renderTail(width: number, rows: number): Lines {
		this.tailWidths.push(width);
		return this.render(width).slice(0, rows);
	}

	readonly tailWidths: number[] = [];

	/** Shutdown flush of remaining history (zero capacity). */
	peekFlushBatch(width: number): HistoryBatch | undefined {
		this.flushWidths.push(width);
		return this.batch;
	}

	readonly flushWidths: number[] = [];

	acknowledgeFinalizedBatch(_id: number): void {}

	canRemoveBlock(_component: unknown): boolean {
		return true;
	}

	blockStates(): readonly BlockState[] {
		return this.children.map(
			(child) => this.#states.get(child) ?? ("active" as BlockState),
		);
	}

	/** Test seam: the container owns block lifecycle in 18.0.1. */
	setState(child: unknown, state: BlockState): void {
		this.#states.set(child, state);
	}

	readonly #states = new Map<unknown, BlockState>();
}

function callbacks(): FoldCallbacks {
	return {
		isFoldable: (block): block is RenderableBlock =>
			block !== null &&
			typeof block === "object" &&
			"render" in block &&
			typeof block.render === "function",
		render: (_block, width, nativeRender) => nativeRender(width),
		isFinalized: () => true,
		isTerminal: () => true,
		// Default: no block is history mid-run, so these tests keep exercising
		// the whole-run grouping the fold has always planned.
		isRetirable: () => false,
		isPresenting: () => true,
	};
}

describe("TranscriptFold descriptor transactions", () => {
	test("install rolls back partial host patches on a mid-patch failure", () => {
		const transcript = new FakeTranscript();
		const frozen = transcript.peekFinalizedBatch;
		Object.defineProperty(transcript, "peekFinalizedBatch", {
			value: frozen,
			configurable: false,
			writable: true,
		});
		const frozenDescriptor = Object.getOwnPropertyDescriptor(
			transcript,
			"peekFinalizedBatch",
		);
		const marker = transcript.marker;
		const fold = new TranscriptFold(transcript, callbacks());
		expect(() => fold.install()).toThrow();
		// every own wrapper created before the failure is gone
		expect(Object.hasOwn(transcript, "render")).toBe(false);
		expect(Object.hasOwn(transcript, "renderViewport")).toBe(false);
		expect(Object.hasOwn(transcript, "liveRowCount")).toBe(false);
		expect(transcript.render).toBe(FakeTranscript.prototype.render);
		expect(transcript.renderViewport).toBe(
			FakeTranscript.prototype.renderViewport,
		);
		// the incompatible own property keeps its exact descriptor
		expect(
			Object.getOwnPropertyDescriptor(transcript, "peekFinalizedBatch"),
		).toEqual(frozenDescriptor);
		expect(transcript.peekFinalizedBatch).toBe(frozen);
		// unrelated own properties and prototype methods are untouched
		expect(transcript.marker).toBe(marker);
		expect(transcript.canRemoveBlock).toBe(
			FakeTranscript.prototype.canRemoveBlock,
		);
		// native transcript methods still execute
		transcript.addChild(new FakeBlock());
		expect(transcript.render(80)).toEqual(["native-block"]);
		expect(transcript.renderViewport(80, 1, FRAME)).toEqual(["native-block"]);
		// cleanup of a never-installed fold is a no-op
		expect(() => fold.dispose()).not.toThrow();
		expect(Object.hasOwn(transcript, "render")).toBe(false);
	});

	test("a mid-patch block failure restores every block descriptor", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		const block = new FakeBlock();
		const originalFinalized = block.isTranscriptBlockFinalized;
		Object.defineProperty(block, "isTranscriptBlockFinalized", {
			value: originalFinalized,
			configurable: false,
			writable: true,
		});
		const frozenDescriptor = Object.getOwnPropertyDescriptor(
			block,
			"isTranscriptBlockFinalized",
		);
		transcript.addChild(block);
		expect(() => transcript.render(80)).toThrow();
		// the block is back to its exact original shape
		expect(Object.hasOwn(block, "render")).toBe(false);
		expect(block.render).toBe(FakeBlock.prototype.render);
		expect(
			Object.getOwnPropertyDescriptor(block, "isTranscriptBlockFinalized"),
		).toEqual(frozenDescriptor);
		expect(Object.hasOwn(block, "isDisplaceableBlock")).toBe(false);
		expect(Object.hasOwn(block, "seal")).toBe(false);
		expect(block.seal).toBe(FakeBlock.prototype.seal);
		// the failing block still works natively
		expect(block.render(80)).toEqual(["native-block"]);
		expect(block.isTranscriptBlockFinalized()).toBe(false);
		// a compatible block still folds once the failing one is removed
		transcript.children.pop();
		transcript.addChild(new FakeBlock());
		expect(transcript.render(80)).toEqual(["native-block"]);
		fold.dispose();
	});

	test("dispose restores exact descriptors and stays idempotent", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		const block = new FakeBlock();
		transcript.addChild(block);
		expect(transcript.render(80)).toEqual(["native-block"]);
		expect(Object.hasOwn(transcript, "render")).toBe(true);
		expect(Object.hasOwn(block, "render")).toBe(true);
		fold.dispose();
		expect(Object.hasOwn(transcript, "render")).toBe(false);
		expect(Object.hasOwn(transcript, "renderViewport")).toBe(false);
		expect(Object.hasOwn(transcript, "liveRowCount")).toBe(false);
		expect(Object.hasOwn(transcript, "peekFinalizedBatch")).toBe(false);
		expect(transcript.render).toBe(FakeTranscript.prototype.render);
		expect(Object.hasOwn(block, "render")).toBe(false);
		expect(Object.hasOwn(block, "isTranscriptBlockFinalized")).toBe(false);
		expect(Object.hasOwn(block, "seal")).toBe(false);
		expect(block.render).toBe(FakeBlock.prototype.render);
		// native rendering works after disposal
		expect(transcript.render(80)).toEqual(["native-block"]);
		// repeated disposal is a no-op
		expect(() => fold.dispose()).not.toThrow();
		expect(() => fold.dispose()).not.toThrow();
		expect(Object.hasOwn(transcript, "render")).toBe(false);
	});

	test("a second fold on the same transcript fails before wrapping native methods", () => {
		const transcript = new FakeTranscript();
		const passthrough = (): FoldCallbacks => ({
			...callbacks(),
			isFinalized: (_block, nativeFinalized) => nativeFinalized?.() ?? true,
		});
		const first = new TranscriptFold(transcript, passthrough());
		const second = new TranscriptFold(transcript, passthrough());
		const block = new FakeBlock();
		transcript.addChild(block);

		first.install();
		expect(transcript.render(80)).toEqual(["native-block"]);
		expect(() => second.install()).toThrow(
			"transcript already managed by omp-compact",
		);

		// The rejected instance must not compose wrappers with the owner: the
		// original fold remains usable and native finalization stays finite.
		expect(transcript.render(80)).toEqual(["native-block"]);
		expect(block.isTranscriptBlockFinalized()).toBe(false);
		first.dispose();
		expect(() => second.install()).not.toThrow();
		second.dispose();
	});
	test("the live-row walk keeps the host's budget instead of swallowing it", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		// 18.4.2 budgets the walk so a resumed ledger is not rendered whole in
		// one frame (#12933). The composer only compares the height against the
		// viewport, so a wrapper that dropped the budget would silently restore
		// the full walk the host removed.
		const block = new FakeBlock();
		transcript.addChild(block);

		transcript.liveRowCount(96, 12);
		expect(transcript.liveRowLimits).toEqual([12]);
		// Planning happened: the block is fold-owned now.
		expect(Object.hasOwn(block, "render")).toBe(true);
		// Hosts up to 18.4.1 pass one argument; the walk stays unbounded then.
		transcript.liveRowCount(96);
		expect(transcript.liveRowLimits).toEqual([12, undefined]);

		fold.dispose();
		expect(Object.hasOwn(transcript, "liveRowCount")).toBe(false);
	});

	test("the complete-history replay replans the fold before the host renders it", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		// 18.0.6 routes the whole-history replay through its own entry point,
		// and the terminal drives it straight from `resetDisplay` with no
		// frame in between. Unwrapped, the fold would never see the block.
		const block = new FakeBlock();
		transcript.addChild(block);
		transcript.replay = { id: 7, rows: ["history"] };

		expect(transcript.peekReplayBatch(96)).toEqual({
			id: 7,
			rows: ["history"],
		});
		expect(transcript.replayWidths).toEqual([96]);
		// Planning happened: the block is fold-owned now.
		expect(Object.hasOwn(block, "render")).toBe(true);
		expect(Object.hasOwn(transcript, "peekReplayBatch")).toBe(true);

		fold.dispose();
		expect(Object.hasOwn(transcript, "peekReplayBatch")).toBe(false);
		expect(transcript.peekReplayBatch).toBe(
			FakeTranscript.prototype.peekReplayBatch,
		);
	});

	test("a host without the replay entry point installs and disposes cleanly", () => {
		const transcript = new FakeTranscript();
		// An older host simply lacks it; patching a method the host never had
		// would invent a capability the adapter probes for.
		Reflect.deleteProperty(FakeTranscript.prototype, "peekReplayBatch");
		try {
			const fold = new TranscriptFold(transcript, callbacks());
			expect(() => fold.install()).not.toThrow();
			expect(Object.hasOwn(transcript, "peekReplayBatch")).toBe(false);
			transcript.addChild(new FakeBlock());
			expect(transcript.render(80)).toEqual(["native-block"]);
			fold.dispose();
		} finally {
			Object.defineProperty(FakeTranscript.prototype, "peekReplayBatch", {
				configurable: true,
				writable: true,
				value: function (this: FakeTranscript, width: number) {
					this.replayWidths.push(width);
					return this.replay;
				},
			});
		}
	});
});

describe("TranscriptFold committed-row gate (D03)", () => {
	test("hasCommittedRows reads the container's block lifecycle", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		const first = new FakeBlock();
		const second = new FakeBlock();
		transcript.addChild(first);
		transcript.addChild(second);
		// roles form during the first planned render
		expect(transcript.render(80)).toEqual(["native-block", "native-block"]);
		expect(fold.hasCommittedRows()).toBe(false);
		// a settled carrier still lives in the mutable viewport
		transcript.setState(first, "settled");
		expect(fold.hasCommittedRows()).toBe(false);
		// retirement into terminal history is the gate
		transcript.setState(first, "committed");
		expect(fold.hasCommittedRows()).toBe(true);
		// rendered rows alone never flip it (no text inspection)
		transcript.setState(first, "active");
		expect(transcript.render(80)).toEqual(["native-block", "native-block"]);
		expect(fold.hasCommittedRows()).toBe(false);
		// dispose retires every role, so the gate goes silent
		transcript.setState(first, "committed");
		expect(fold.hasCommittedRows()).toBe(true);
		fold.dispose();
		expect(fold.hasCommittedRows()).toBe(false);
	});

	test("only the carrier's state counts for the committed-row gate", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		const first = new FakeBlock();
		const second = new FakeBlock();
		transcript.addChild(first);
		transcript.addChild(second);
		transcript.render(80);
		// A run member never owns the run's commit state; the container retires
		// the whole run through its carrier, so a member-only state (which the
		// stock container's ordered frontier cannot even produce) is ignored.
		transcript.setState(second, "committed");
		expect(fold.hasCommittedRows()).toBe(false);
		transcript.setState(first, "committed");
		expect(fold.hasCommittedRows()).toBe(true);
		fold.dispose();
		expect(fold.hasCommittedRows()).toBe(false);
	});

	test("a same-instance reinstall replans and reads the live lifecycle again", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		const first = new FakeBlock();
		const second = new FakeBlock();
		transcript.addChild(first);
		transcript.addChild(second);
		transcript.render(80);
		transcript.setState(first, "committed");
		expect(fold.hasCommittedRows()).toBe(true);
		// Session/rebuild boundary (C02 pattern): the same fold instance is
		// detached and re-patched onto the same transcript later.
		fold.dispose();
		// No roles, no gate — regardless of what the container still reports.
		expect(fold.hasCommittedRows()).toBe(false);
		fold.install();
		transcript.render(80);
		// The replanned run reads the container, so a block that really is
		// terminal history reports as such again.
		expect(fold.hasCommittedRows()).toBe(true);
		transcript.setState(first, "settled");
		expect(fold.hasCommittedRows()).toBe(false);
		fold.dispose();
	});

	test("an idempotent no-op dispose does not leave stale roles either", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		const first = new FakeBlock();
		transcript.addChild(first);
		transcript.render(80);
		transcript.setState(first, "committed");
		expect(fold.hasCommittedRows()).toBe(true);
		fold.dispose();
		expect(fold.hasCommittedRows()).toBe(false);
		// The second dispose is the early no-op path; it must still reset the
		// fold-owned run state, so a later reinstall replans clean.
		fold.dispose();
		expect(fold.hasCommittedRows()).toBe(false);
		fold.install();
		transcript.render(80);
		expect(fold.hasCommittedRows()).toBe(true);
		fold.dispose();
	});

	test("history already streamed out counts, even with no carrier retired", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		const answer = new FakeBlock();
		transcript.addChild(answer);
		transcript.render(80);
		// A long answer with no tool use retires nothing: the container keeps
		// its block `active` while publishing the prefix row by row. Gating on
		// a retired carrier alone left exactly that turn without its replay,
		// so its leading rows stayed above the viewport and out of reach.
		expect(transcript.blockStates()).toEqual(["active"]);
		expect(fold.hasCommittedRows()).toBe(false);
		transcript.batch = { id: 3, rows: ["line-1"] };
		expect(transcript.peekFinalizedBatch(80, 4)).toBeDefined();
		expect(transcript.blockStates()).toEqual(["active"]);
		expect(fold.hasCommittedRows()).toBe(true);
		// A fresh install starts over: nothing of this transcript's history
		// belongs to the new run's projection.
		fold.dispose();
		expect(fold.hasCommittedRows()).toBe(false);
		fold.install();
		expect(fold.hasCommittedRows()).toBe(false);
		fold.dispose();
	});
});

describe("TranscriptFold: every block-rendering entry point replans", () => {
	// `renderTail` is the terminal's resize repaint and `peekFlushBatch` is
	// the shutdown flush; both call `entry.component.render(width)` directly
	// in stock `TranscriptContainer`. Unplanned, a carrier answers with rows
	// measured for the previous width while its folded members render their
	// native cards again — duplicated tool cards in the resized scrollback and
	// in the last history the user keeps after quitting.
	test("renderTail plans at the requested width and restores on dispose", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		const block = new FakeBlock();
		transcript.addChild(block);

		expect(Object.hasOwn(transcript, "renderTail")).toBe(true);
		expect(transcript.renderTail?.(80, 10)).toEqual(["native-block"]);
		// Planning happened at the repaint width: the block is fold-owned.
		expect(Object.hasOwn(block, "render")).toBe(true);
		expect(transcript.tailWidths).toEqual([80]);

		fold.dispose();
		expect(Object.hasOwn(transcript, "renderTail")).toBe(false);
		expect(transcript.renderTail).toBe(FakeTranscript.prototype.renderTail);
	});

	test("peekFlushBatch plans, counts as committed history, and restores", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		const block = new FakeBlock();
		transcript.addChild(block);

		expect(Object.hasOwn(transcript, "peekFlushBatch")).toBe(true);
		expect(fold.hasCommittedRows()).toBe(false);
		transcript.batch = { id: 7, rows: ["retired"] };
		expect(transcript.peekFlushBatch?.(80)).toEqual({
			id: 7,
			rows: ["retired"],
		});
		expect(Object.hasOwn(block, "render")).toBe(true);
		expect(transcript.flushWidths).toEqual([80]);
		// History left the transcript: the projection must not claim the
		// terminal is still clean.
		expect(fold.hasCommittedRows()).toBe(true);

		fold.dispose();
		expect(Object.hasOwn(transcript, "peekFlushBatch")).toBe(false);
	});

	test("a host without the resize/flush entry points installs and disposes cleanly", () => {
		const transcript = new FakeTranscript();
		Reflect.deleteProperty(FakeTranscript.prototype, "renderTail");
		Reflect.deleteProperty(FakeTranscript.prototype, "peekFlushBatch");
		try {
			const fold = new TranscriptFold(transcript, callbacks());
			expect(() => fold.install()).not.toThrow();
			expect(Object.hasOwn(transcript, "renderTail")).toBe(false);
			expect(Object.hasOwn(transcript, "peekFlushBatch")).toBe(false);
			transcript.addChild(new FakeBlock());
			expect(transcript.render(80)).toEqual(["native-block"]);
			fold.dispose();
		} finally {
			Object.defineProperty(FakeTranscript.prototype, "renderTail", {
				configurable: true,
				writable: true,
				value: function (this: FakeTranscript, width: number, rows: number) {
					this.tailWidths.push(width);
					return this.render(width).slice(0, rows);
				},
			});
			Object.defineProperty(FakeTranscript.prototype, "peekFlushBatch", {
				configurable: true,
				writable: true,
				value: function (this: FakeTranscript, width: number) {
					this.flushWidths.push(width);
					return this.batch;
				},
			});
		}
	});
});

describe("TranscriptFold: the plan does not re-probe what cannot change", () => {
	/**
	 * The block a run stops at: not foldable, so the plan renders it once to
	 * decide whether it belongs to the run. Counts its own native renders.
	 */
	class TerminatorBlock {
		renders = 0;

		readonly #finalized: boolean;
		readonly #rows: Lines;

		constructor(rows: Lines, finalized: boolean) {
			this.#rows = rows;
			this.#finalized = finalized;
		}

		render(_width: number): Lines {
			this.renders++;
			return this.#rows;
		}

		isTranscriptBlockFinalized(): boolean {
			return this.#finalized;
		}
	}

	/**
	 * Host whose own render entry points touch no child: every child render
	 * observed here came from the fold's plan, never from the host.
	 */
	class QuietTranscript extends FakeTranscript {
		override render(_width: number): Lines {
			return [];
		}

		override renderViewport(
			_width: number,
			_rows: number,
			_frame: AnimationFrame,
		): Lines {
			return [];
		}

		override liveRowCount(_width: number): number {
			return 0;
		}
	}

	function installWith(terminator: TerminatorBlock): {
		transcript: QuietTranscript;
		renders: () => number;
	} {
		const transcript = new QuietTranscript();
		const foldable = new FakeBlock();
		transcript.addChild(foldable);
		transcript.addChild(terminator);
		const fold = new TranscriptFold(transcript, {
			...callbacks(),
			isFoldable: (block): block is RenderableBlock => block === foldable,
		});
		fold.install();
		return { transcript, renders: () => terminator.renders };
	}

	const CONTENT: Lines = ["native text"];
	const BLANK: Lines = ["", "   "];
	const FRAME_VIEW = [80, 10, FRAME] as const;

	test("a content-bearing run terminator is probed once, not once per frame", () => {
		// Both a live and a finalized block answer "not blank", and that
		// verdict can only ever end a run — so it never has to be re-rendered.
		for (const finalized of [true, false]) {
			const { transcript, renders } = installWith(
				new TerminatorBlock(CONTENT, finalized),
			);
			transcript.renderViewport(...FRAME_VIEW);
			const afterFirstPlan = renders();
			expect(afterFirstPlan).toBeGreaterThan(0);

			for (let frame = 0; frame < 5; frame++)
				transcript.renderViewport(...FRAME_VIEW);
			expect(renders()).toBe(afterFirstPlan);
		}
	});

	test("a blank terminator is re-probed until the host freezes it", () => {
		// "Blank" makes the block a member of the run in front of it, so it is
		// only kept once the host itself says the rows cannot change.
		const live = installWith(new TerminatorBlock(BLANK, false));
		live.transcript.renderViewport(...FRAME_VIEW);
		const first = live.renders();
		expect(first).toBeGreaterThan(0);
		for (let frame = 0; frame < 3; frame++)
			live.transcript.renderViewport(...FRAME_VIEW);
		expect(live.renders()).toBe(first * 4);

		const settled = installWith(new TerminatorBlock(BLANK, true));
		settled.transcript.renderViewport(...FRAME_VIEW);
		const afterFirstPlan = settled.renders();
		for (let frame = 0; frame < 5; frame++)
			settled.transcript.renderViewport(...FRAME_VIEW);
		expect(settled.renders()).toBe(afterFirstPlan);
	});

	test("a new width re-probes the terminator", () => {
		const { transcript, renders } = installWith(
			new TerminatorBlock(CONTENT, true),
		);
		transcript.renderViewport(...FRAME_VIEW);
		const afterFirstPlan = renders();

		transcript.renderViewport(100, 10, FRAME);
		expect(renders()).toBe(afterFirstPlan + 1);
	});
});

describe("TranscriptFold on a Tern Surface Protocol host", () => {
	/** A stock card that describes itself, as every 18.4.4+ tool card does. */
	class DescribedBlock extends FakeBlock {
		constructor(
			readonly name: string,
			readonly stock = false,
		) {
			super();
		}

		describe(_cx?: unknown): unknown {
			return { k: "card", p: { title: this.name } };
		}
	}

	/** The composer asks for the blocks once per TSP frame. */
	class NativeTranscript extends FakeTranscript {
		nativeBlocks(cx?: { cols: number }): readonly unknown[] {
			// A TSP frame always carries its describe context
			return cx === undefined ? [] : this.children;
		}
	}

	const CX = { cols: 80 };

	/** A block the fold only absorbs because its rows are blank. */
	class ThinkingBlock extends FakeBlock {
		readonly name = "thinking";
		readonly stock = true;

		override render(_width: number): Lines {
			return [""];
		}

		describe(_cx?: unknown): unknown {
			return { k: "section", p: { collapsed: true } };
		}
	}

	/** A tool-only assistant turn: blank rows, an empty description. */
	class EmptyTurnBlock extends ThinkingBlock {
		override describe(_cx?: unknown): unknown {
			return { k: "col", p: { role: "omp.assistant" } };
		}
	}

	/** A stock block with no description of its own, like the stats line. */
	class StatsBlock extends FakeBlock {
		readonly name = "stats";
		readonly stock = true;

		override render(_width: number): Lines {
			return ["[ 3 actions ]"];
		}
	}

	type Block = DescribedBlock | ThinkingBlock | StatsBlock;

	function install(blocks: readonly Block[]): NativeTranscript {
		const transcript = new NativeTranscript();
		for (const block of blocks) transcript.addChild(block);
		const fold = new TranscriptFold(transcript, {
			...callbacks(),
			// Every test block but the blank one the run only absorbs.
			isFoldable: (block): block is RenderableBlock =>
				block instanceof DescribedBlock ||
				block instanceof StatsBlock ||
				block instanceof PaintedContainer,
			// Like the adapter: a card the presentation leaves stock answers
			// with its native rows, every other one with its compact row.
			render: (block, width, nativeRender) =>
				(block as Block).stock
					? nativeRender(width)
					: [`• ${(block as Block).name}`],
		});
		fold.install();
		return transcript;
	}

	/** One TSP frame: the block list, then each block's description. */
	function frame(transcript: NativeTranscript): unknown[] {
		return transcript
			.nativeBlocks(CX)
			.map((block) => (block as DescribedBlock).describe(CX));
	}

	/** The host's `rowsText` node: pre-rendered rows as one unwrapped text. */
	function plain(...lines: string[]): Record<string, unknown> {
		return { k: "text", p: { text: lines.join("\n"), wrap: "none" } };
	}

	/** Compact rows, one clickable text per member's row. */
	function rows(...members: string[]): unknown {
		return {
			k: "col",
			p: {},
			c: members.map((line, index) => ({
				k: "text",
				p: {
					text: line,
					wrap: "none",
					actions: { click: "omp-compact.reveal" },
					title: "Show the full card",
				},
				key: String(index),
			})),
		};
	}

	const HIDDEN = { k: "col", p: { hidden: true } };

	test("a run describes as one text node on its carrier and nothing on its members", () => {
		const transcript = install([
			new DescribedBlock("read a.ts"),
			new DescribedBlock("grep foo"),
			new DescribedBlock("bash: ls"),
		]);
		expect(frame(transcript)).toEqual([
			rows("• read a.ts", "• grep foo", "• bash: ls"),
			HIDDEN,
			HIDDEN,
		]);
	});

	test("a stock card inside a run keeps its own description and splits the rows around it", () => {
		const transcript = install([
			new DescribedBlock("read a.ts"),
			new DescribedBlock("task", true),
			new DescribedBlock("grep foo"),
			new DescribedBlock("bash: ls"),
		]);
		expect(frame(transcript)).toEqual([
			rows("• read a.ts"),
			{ k: "card", p: { title: "task" } },
			rows("• grep foo", "• bash: ls"),
			HIDDEN,
		]);
	});

	test("a blank block absorbed into a run keeps its own description", () => {
		// Its rows are blank, but its description may not be: hiding it
		// would drop what stock Tern shows.
		const transcript = install([
			new DescribedBlock("read a.ts"),
			new ThinkingBlock(),
			new DescribedBlock("grep foo"),
		]);
		expect(frame(transcript)).toEqual([
			rows("• read a.ts"),
			{ k: "section", p: { collapsed: true } },
			rows("• grep foo"),
		]);
	});

	test("a blank block that describes nothing stays inside the stretch", () => {
		// A tool-only assistant turn between two calls must not split their
		// rows into two blocks with a gap between them.
		const transcript = install([
			new DescribedBlock("read a.ts"),
			new EmptyTurnBlock(),
			new DescribedBlock("grep foo"),
		]);
		expect(frame(transcript)).toEqual([
			rows("• read a.ts", "• grep foo"),
			HIDDEN,
			HIDDEN,
		]);
	});

	test("unchanged rows describe as the same node, so the terminal gets no update", () => {
		const transcript = install([
			new DescribedBlock("read a.ts"),
			new DescribedBlock("grep foo"),
		]);
		const [first] = frame(transcript);
		const [second] = frame(transcript);
		expect(second).toBe(first);
	});

	test("a stock block without a description of its own keeps its rows inside a run", () => {
		// The reconciler would paint it through `render`, where a run member
		// answers nothing because the row path's carrier speaks for it.
		const transcript = install([
			new DescribedBlock("write a.ts"),
			new StatsBlock(),
		]);
		expect(frame(transcript)).toEqual([
			rows("• write a.ts"),
			plain("[ 3 actions ]"),
		]);
	});

	/** An extension block painting its own rows on a plain `Container`. */
	class PaintedContainer extends Container {
		readonly name = "custom";
		readonly stock = true;

		override render(_width: number): readonly string[] {
			return ["custom row"];
		}
	}

	test("a Container that paints its own rows describes as those rows, like the reconciler decides", () => {
		// It inherits `Container.prototype.describe`, which the reconciler
		// ignores for such a block; calling it would show its bare children.
		const transcript = install([
			new DescribedBlock("write a.ts"),
			new PaintedContainer() as unknown as Block,
		]);
		expect(frame(transcript)).toEqual([
			rows("• write a.ts"),
			plain("custom row"),
		]);
	});

	/** A write/edit card that takes late diagnostics, as stock 18.4.4+ does. */
	class DiagnosedBlock extends DescribedBlock {
		attached: unknown[] = [];

		attachLateDiagnostics(files: unknown): boolean {
			this.attached.push(files);
			return true;
		}
	}

	test("fold-owned cards refuse late diagnostics, so they keep their own message", () => {
		// A card shown stock now (expanded, still working) may turn compact
		// later, and the host never re-routes what it attached: so even the
		// stock card refuses.
		const compact = new DiagnosedBlock("write a.ts");
		const stock = new DiagnosedBlock("edit b.ts", true);
		const transcript = install([compact, stock]);
		frame(transcript);
		const files = [{ path: "a.ts" }];
		expect(compact.attachLateDiagnostics(files)).toBe(false);
		expect(stock.attachLateDiagnostics(files)).toBe(false);
		expect(compact.attached).toEqual([]);
		expect(stock.attached).toEqual([]);
	});

	test("a card added during a rebuild refuses late diagnostics before the fold is back", () => {
		// A session rebuild disposes the fold, adds every card back and routes
		// its diagnostics, all before the settlement reinstalls the fold.
		let presenting = true;
		const transcript = new NativeTranscript();
		const fold = new TranscriptFold(transcript, {
			...callbacks(),
			isPresenting: () => presenting,
		});
		fold.install();
		fold.dispose();
		const card = new DiagnosedBlock("write a.ts");
		fold.observeChild(card);
		transcript.addChild(card);
		const files = [{ path: "a.ts" }];
		expect(card.attachLateDiagnostics(files)).toBe(false);
		expect(card.attached).toEqual([]);
		// Once the plugin is gone the card takes them like stock again.
		presenting = false;
		expect(card.attachLateDiagnostics(files)).toBe(true);
		expect(card.attached).toEqual([files]);
	});

	test("a block joining a run between frames is planned with it, not shown stock", () => {
		// The row path replans on `render` too, without a new TSP frame.
		const transcript = install([
			new DescribedBlock("read a.ts"),
			new DescribedBlock("grep foo"),
		]);
		frame(transcript);
		transcript.addChild(new DescribedBlock("bash: ls"));
		transcript.render(CX.cols);
		const described = transcript.children.map((block) =>
			(block as DescribedBlock).describe(CX),
		);
		expect(described).toEqual([
			rows("• read a.ts", "• grep foo", "• bash: ls"),
			HIDDEN,
			HIDDEN,
		]);
	});

	test("a released block describes natively again", () => {
		const block = new DescribedBlock("read a.ts");
		const transcript = new NativeTranscript();
		transcript.addChild(block);
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		frame(transcript);
		fold.dispose();
		expect(block.describe(CX)).toEqual({
			k: "card",
			p: { title: "read a.ts" },
		});
	});

	/** A stock card that records the events its stock handler receives. */
	class ClickableBlock extends DescribedBlock {
		events: unknown[] = [];

		handleNativeEvent(event: unknown): void {
			this.events.push(event);
		}
	}

	const click = (key: string, act: string) => ({
		type: "action",
		key,
		act,
		mods: [],
	});

	test("a click on a row reveals that member's stock card under its row, and a second click compacts it", () => {
		const read = new ClickableBlock("read a.ts");
		const grep = new ClickableBlock("grep foo");
		const bash = new ClickableBlock("bash: ls");
		const transcript = install([read, grep, bash]);
		frame(transcript);
		// The click lands on the carrier, at the clicked member's row.
		read.handleNativeEvent(click("1", "omp-compact.reveal"));
		const [first, revealed, rest] = frame(transcript);
		expect(first).toEqual(rows("• read a.ts"));
		expect(rest).toEqual(rows("• bash: ls"));
		const [row, card] = (revealed as { c: unknown[] }).c;
		expect(row).toMatchObject({
			key: "r",
			p: { text: "• grep foo", actions: { click: "omp-compact.conceal" } },
		});
		// The stock card sits in a proxy, so its own events reach the stock
		// handler under its own key paths.
		const proxy = card as unknown as ClickableBlock;
		expect(proxy.describe(CX)).toEqual({ k: "card", p: { title: "grep foo" } });
		proxy.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		expect(grep.events).toEqual([
			{ type: "toggle", key: "", collapsed: false },
		]);
		// The plugin's clicks never reach a stock handler.
		expect(read.events).toEqual([]);

		grep.handleNativeEvent(click("r", "omp-compact.conceal"));
		expect(frame(transcript)).toEqual([
			rows("• read a.ts", "• grep foo", "• bash: ls"),
			HIDDEN,
			HIDDEN,
		]);
	});

	test("other events on a compact block go to its stock handler", () => {
		const read = new ClickableBlock("read a.ts");
		const transcript = install([read]);
		frame(transcript);
		read.handleNativeEvent(click("0", "copy"));
		expect(read.events).toEqual([click("0", "copy")]);
	});
});
