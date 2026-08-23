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
		return undefined;
	}

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
});
