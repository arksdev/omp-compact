import { describe, expect, test } from "bun:test";

import {
	type FoldCallbacks,
	type RenderableBlock,
	TranscriptFold,
	type TranscriptHost,
} from "./transcript-fold";

type Lines = readonly string[];

class FakeBlock implements RenderableBlock {
	render(_width: number): Lines {
		return ["native-block"];
	}

	isTranscriptBlockFinalized(): boolean {
		return false;
	}

	getTranscriptBlockVersion(): number {
		return 1;
	}

	getTranscriptBlockSettledRows(): number {
		return 0;
	}

	isDisplaceableBlock(): boolean {
		return false;
	}

	seal(): void {}

	setNativeScrollbackCommittedRows(_rows: number): void {}
}

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

	renderViewportTail(width: number, maxRows: number): Lines {
		return this.render(width).slice(0, maxRows);
	}

	isBlockUncommitted(_component: unknown): boolean {
		return false;
	}

	isBlockInLiveRegion(_component: unknown): boolean {
		return false;
	}
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
		settledRows: () => 0,
		version: () => 1,
		isTerminal: () => true,
	};
}

describe("TranscriptFold descriptor transactions", () => {
	test("install rolls back partial host patches on a mid-patch failure", () => {
		const transcript = new FakeTranscript();
		const frozen = transcript.isBlockUncommitted;
		Object.defineProperty(transcript, "isBlockUncommitted", {
			value: frozen,
			configurable: false,
			writable: true,
		});
		const frozenDescriptor = Object.getOwnPropertyDescriptor(
			transcript,
			"isBlockUncommitted",
		);
		const marker = transcript.marker;
		const fold = new TranscriptFold(transcript, callbacks());
		expect(() => fold.install()).toThrow();
		// every own wrapper created before the failure is gone
		expect(Object.hasOwn(transcript, "render")).toBe(false);
		expect(Object.hasOwn(transcript, "renderViewportTail")).toBe(false);
		expect(transcript.render).toBe(FakeTranscript.prototype.render);
		expect(transcript.renderViewportTail).toBe(
			FakeTranscript.prototype.renderViewportTail,
		);
		// the incompatible own property keeps its exact descriptor
		expect(
			Object.getOwnPropertyDescriptor(transcript, "isBlockUncommitted"),
		).toEqual(frozenDescriptor);
		expect(transcript.isBlockUncommitted).toBe(frozen);
		// unrelated own properties and prototype methods are untouched
		expect(transcript.marker).toBe(marker);
		expect(transcript.isBlockInLiveRegion).toBe(
			FakeTranscript.prototype.isBlockInLiveRegion,
		);
		// native transcript methods still execute
		transcript.addChild(new FakeBlock());
		expect(transcript.render(80)).toEqual(["native-block"]);
		expect(transcript.renderViewportTail(80, 1)).toEqual(["native-block"]);
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
		expect(Object.hasOwn(block, "getTranscriptBlockVersion")).toBe(false);
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
		expect(Object.hasOwn(transcript, "renderViewportTail")).toBe(false);
		expect(Object.hasOwn(transcript, "isBlockUncommitted")).toBe(false);
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
});

describe("TranscriptFold committed-row gate (D03)", () => {
	test("hasCommittedRows follows structured carrier declarations only", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		const first = new FakeBlock();
		const second = new FakeBlock();
		transcript.addChild(first);
		transcript.addChild(second);
		// roles/spans form during the first planned render
		expect(transcript.render(80)).toEqual(["native-block", "native-block"]);
		expect(fold.hasCommittedRows()).toBe(false);
		// a zero declaration never reports committed rows
		first.setNativeScrollbackCommittedRows(0);
		expect(fold.hasCommittedRows()).toBe(false);
		// the carrier's native seam declaration is the structured gate
		first.setNativeScrollbackCommittedRows(1);
		expect(fold.hasCommittedRows()).toBe(true);
		// declaring zero retires the committed state
		first.setNativeScrollbackCommittedRows(0);
		expect(fold.hasCommittedRows()).toBe(false);
		// rendered rows alone never flip the gate (no text inspection)
		expect(transcript.render(80)).toEqual(["native-block", "native-block"]);
		expect(fold.hasCommittedRows()).toBe(false);
		// dispose retires every role, so the gate goes silent
		first.setNativeScrollbackCommittedRows(1);
		expect(fold.hasCommittedRows()).toBe(true);
		fold.dispose();
		expect(fold.hasCommittedRows()).toBe(false);
	});

	test("non-carrier declarations are ignored by the committed-row gate", () => {
		const transcript = new FakeTranscript();
		const fold = new TranscriptFold(transcript, callbacks());
		fold.install();
		const first = new FakeBlock();
		const second = new FakeBlock();
		transcript.addChild(first);
		transcript.addChild(second);
		transcript.render(80);
		// the fold ignores committed declarations on run members: only the
		// carrier (first block of the run) owns the run's commit state
		second.setNativeScrollbackCommittedRows(5);
		expect(fold.hasCommittedRows()).toBe(false);
		first.setNativeScrollbackCommittedRows(5);
		expect(fold.hasCommittedRows()).toBe(true);
		fold.dispose();
		expect(fold.hasCommittedRows()).toBe(false);
	});
});
