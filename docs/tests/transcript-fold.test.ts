import { describe, expect, test } from "bun:test";

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

	liveRowCount(width: number): number {
		return this.render(width).length;
	}

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
