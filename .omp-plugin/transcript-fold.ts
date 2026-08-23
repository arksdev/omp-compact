import { BLOCK_FOLD_METHODS, TRANSCRIPT_FOLD_METHODS } from "./host-adapter";
import { DescriptorPatch } from "./patch-kit";

type Lines = readonly string[];

export interface RenderableBlock {
	render(width: number): Lines;
}

/** Shared animation clock the 18.0.1 transcript passes to live blocks. */
export interface AnimationFrame {
	readonly tick: number;
	readonly now: number;
}

/** History batch the 18.0.1 transcript offers the terminal for retirement. */
export interface HistoryBatch {
	readonly id: number;
	readonly rows: readonly string[];
}

export type BlockState = "active" | "settled" | "committed";

export interface TranscriptHost extends RenderableBlock {
	children: unknown[];
	addChild(child: unknown): void;
	/**
	 * Optional rebuild-phase capability (stock `TranscriptContainer`
	 * provides it): the adapter's exact-instance clear wrapper calls the
	 * native method when present and fails open to native presentation
	 * when missing.
	 */
	clear?(): void;
	renderViewport(width: number, rows: number, frame: AnimationFrame): Lines;
	liveRowCount(width: number): number;
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined;
	acknowledgeFinalizedBatch(id: number): void;
	canRemoveBlock(component: unknown): boolean;
	blockStates(): readonly BlockState[];
}

interface NativeBlockMethods {
	render: (width: number) => Lines;
	finalized?: () => boolean;
	displaceable?: () => boolean;
	seal?: () => void;
}

export interface FoldCallbacks {
	isFoldable(block: unknown): block is RenderableBlock;
	render(
		block: RenderableBlock,
		width: number,
		nativeRender: (width: number) => Lines,
	): Lines;
	isFinalized(
		block: RenderableBlock,
		nativeFinalized: (() => boolean) | undefined,
	): boolean;
	isTerminal(block: RenderableBlock): boolean;
}

interface FoldSpan {
	lead: number;
	rows: number;
}

interface FoldRun {
	members: RenderableBlock[];
	spans: FoldSpan[];
	closed: boolean;
	width: number;
	rows: Lines;
}

interface FoldRole {
	run: FoldRun;
	carrier: boolean;
}

interface BlockPatch {
	patch: DescriptorPatch;
	native: NativeBlockMethods;
}

const EMPTY_LINES: Lines = Object.freeze([]);
// Cross-module-instance marker: a plugin may be both user-linked and loaded
// explicitly with `-e`. The fold mutates only this exact transcript instance,
// but duplicate module copies must still observe the same ownership key.
const TRANSCRIPT_FOLD_OWNER = Symbol.for("omp-compact.transcript-fold.owner");
const NON_BLANK = /\S/;

function isRenderableBlock(value: unknown): value is RenderableBlock {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof (value as RenderableBlock).render === "function",
	);
}

// Prototype chain walk: assumes no cycles (Object.setPrototypeOf cycles are
// caller responsibility). Stock host objects have acyclic prototypes; the
// fold fails closed on any method-wrapping exception.
function inheritedMethod<T extends (...args: never[]) => unknown>(
	block: object,
	name: string,
): T | undefined {
	let cursor: object | null = block;
	while (cursor && cursor !== Object.prototype) {
		const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
		if (typeof descriptor?.value === "function") return descriptor.value as T;
		cursor = Object.getPrototypeOf(cursor) as object | null;
	}
	return undefined;
}

export class TranscriptFold {
	readonly #callbacks: FoldCallbacks;
	readonly #transcript: TranscriptHost;
	// runs/roles are replaceable so dispose can reset the fold-owned
	// state wholesale — stale run state must never survive a session or
	// rebuild boundary even when the same instance re-patches the same
	// transcript (the adapter's rebuild detach/reinstall cycle).
	#roles = new WeakMap<object, FoldRole>();
	#runs = new WeakMap<object, FoldRun>();
	readonly #patches = new Map<RenderableBlock, BlockPatch>();
	#transcriptPatch: DescriptorPatch | undefined;
	#installed = false;

	constructor(transcript: TranscriptHost, callbacks: FoldCallbacks) {
		this.#transcript = transcript;
		this.#callbacks = callbacks;
	}

	/** Whether the fold's transcript wrappers are currently installed. */
	get installed(): boolean {
		return this.#installed;
	}

	/**
	 * Structured committed-row gate for the terminal scrollback replay.
	 * Reports whether any fold-owned carrier already retired into terminal
	 * history, where its rows are immutable and a later projection change
	 * could never take them off the screen again.
	 *
	 * 18.0.1 keeps that lifecycle in the container: `blockStates()` runs
	 * parallel to `children`, so a carrier's state is read by position. No
	 * rendered text and no ANSI is inspected — pure structured state.
	 */
	hasCommittedRows(): boolean {
		if (this.#patches.size === 0) return false;
		const states = this.#transcript.blockStates();
		const children = this.#transcript.children;
		for (let index = 0; index < children.length; index++) {
			if (states[index] !== "committed") continue;
			const child = children[index];
			if (!child || typeof child !== "object") continue;
			if (this.#roles.get(child)?.carrier === true) return true;
		}
		return false;
	}

	install(): void {
		if (this.#installed) return;
		if (Reflect.get(this.#transcript, TRANSCRIPT_FOLD_OWNER) !== undefined)
			throw new Error("transcript already managed by omp-compact");
		let ownsTranscript = false;
		try {
			Object.defineProperty(this.#transcript, TRANSCRIPT_FOLD_OWNER, {
				configurable: true,
				value: this,
			});
			ownsTranscript = true;
			const hostRender = this.#transcript.render;
			const hostViewport = this.#transcript.renderViewport;
			const hostLiveRows = this.#transcript.liveRowCount;
			const hostPeekBatch = this.#transcript.peekFinalizedBatch;
			// Every host entry point that renders blocks replans first: a
			// carrier answers for its whole run, so a stale plan would size the
			// viewport (or a retiring history batch) from members that render
			// nothing.
			const wrappers: Record<string, PropertyDescriptor> = {
				render: {
					configurable: true,
					writable: true,
					value: (width: number): Lines => {
						this.#plan(width);
						return hostRender.call(this.#transcript, width);
					},
				},
				renderViewport: {
					configurable: true,
					writable: true,
					value: (
						width: number,
						rows: number,
						frame: AnimationFrame,
					): Lines => {
						this.#plan(width);
						return hostViewport.call(this.#transcript, width, rows, frame);
					},
				},
				liveRowCount: {
					configurable: true,
					writable: true,
					value: (width: number): number => {
						this.#plan(width);
						return hostLiveRows.call(this.#transcript, width);
					},
				},
				peekFinalizedBatch: {
					configurable: true,
					writable: true,
					value: (
						width: number,
						capacity: number,
					): HistoryBatch | undefined => {
						this.#plan(width);
						return hostPeekBatch.call(this.#transcript, width, capacity);
					},
				},
			};
			this.#transcriptPatch = new DescriptorPatch(
				this.#transcript,
				TRANSCRIPT_FOLD_METHODS,
			);
			this.#transcriptPatch.install(wrappers);
			this.#installed = true;
		} catch (error) {
			if (
				ownsTranscript &&
				Reflect.get(this.#transcript, TRANSCRIPT_FOLD_OWNER) === this
			)
				Reflect.deleteProperty(this.#transcript, TRANSCRIPT_FOLD_OWNER);
			throw error;
		}
	}

	dispose(): void {
		// Reset the fold-owned run/role state unconditionally — before
		// the idempotent early return — so no dispose path (including a
		// repeated no-op) can leave stale runs behind for a later
		// reinstall/replan of the same instance.
		this.#runs = new WeakMap();
		this.#roles = new WeakMap();
		if (
			!this.#installed &&
			this.#patches.size === 0 &&
			this.#transcriptPatch === undefined &&
			Reflect.get(this.#transcript, TRANSCRIPT_FOLD_OWNER) !== this
		)
			return;
		for (const [, patch] of this.#patches) {
			patch.patch.restore();
		}
		this.#patches.clear();
		this.#transcriptPatch?.restore();
		this.#transcriptPatch = undefined;
		if (Reflect.get(this.#transcript, TRANSCRIPT_FOLD_OWNER) === this)
			Reflect.deleteProperty(this.#transcript, TRANSCRIPT_FOLD_OWNER);
		this.#installed = false;
	}

	#native(block: RenderableBlock): NativeBlockMethods {
		const patch = this.#patches.get(block);
		if (patch) return patch.native;
		return {
			render: inheritedMethod(block, "render") ?? (() => EMPTY_LINES),
			finalized: inheritedMethod(block, "isTranscriptBlockFinalized"),
			displaceable: inheritedMethod(block, "isDisplaceableBlock"),
			seal: inheritedMethod(block, "seal"),
		};
	}

	#renderBlock(block: RenderableBlock, width: number): Lines {
		const native = this.#native(block);
		return this.#callbacks.render(block, width, native.render.bind(block));
	}

	#blockFinalized(block: RenderableBlock): boolean {
		const native = this.#native(block);
		return this.#callbacks.isFinalized(block, native.finalized?.bind(block));
	}

	#renderRun(run: FoldRun, width: number): Lines {
		const rows: string[] = [];
		const spans: FoldSpan[] = [];
		for (const member of run.members) {
			const raw = this.#renderBlock(member, width);
			let lead = 0;
			while (lead < raw.length && !NON_BLANK.test(raw[lead] ?? "")) lead++;
			let end = raw.length;
			while (end > lead && !NON_BLANK.test(raw[end - 1] ?? "")) end--;
			spans.push({ lead, rows: end - lead });
			for (let index = lead; index < end; index++) rows.push(raw[index] ?? "");
		}
		run.spans = spans;
		if (
			run.width === width &&
			run.rows.length === rows.length &&
			run.rows.every((line, index) => line === rows[index])
		) {
			return run.rows;
		}
		run.width = width;
		run.rows = rows;
		return rows;
	}

	#installBlock(block: RenderableBlock): void {
		if (this.#patches.has(block)) return;
		const native = this.#native(block);
		const fold = this;
		const wrappers: Record<string, PropertyDescriptor> = {
			render: {
				configurable: true,
				writable: true,
				value(this: RenderableBlock, width: number): Lines {
					const role = fold.#roles.get(this);
					if (!role)
						return fold.#callbacks.render(
							this,
							width,
							native.render.bind(this),
						);
					return role.carrier ? fold.#renderRun(role.run, width) : EMPTY_LINES;
				},
			},
			isTranscriptBlockFinalized: {
				configurable: true,
				writable: true,
				value(this: RenderableBlock): boolean {
					const role = fold.#roles.get(this);
					if (!role?.carrier) return fold.#blockFinalized(this);
					const terminalTail = role.run.members.some((member) =>
						fold.#callbacks.isTerminal(member),
					);
					return (
						(role.run.closed || terminalTail) &&
						role.run.members.every((member) => fold.#blockFinalized(member))
					);
				},
			},
			isDisplaceableBlock: {
				configurable: true,
				writable: true,
				value(this: RenderableBlock): boolean {
					const role = fold.#roles.get(this);
					if (!role?.carrier) return native.displaceable?.call(this) === true;
					return role.run.members.some(
						(member) =>
							fold.#native(member).displaceable?.call(member) === true,
					);
				},
			},
			seal: {
				configurable: true,
				writable: true,
				value(this: RenderableBlock): void {
					const role = fold.#roles.get(this);
					if (!role?.carrier) {
						native.seal?.call(this);
						return;
					}
					// A carrier speaks for the whole run: the container retires
					// every member of it in one history batch, so freezing the
					// carrier freezes them all.
					for (const member of role.run.members)
						fold.#native(member).seal?.call(member);
				},
			},
		};
		const patch = new DescriptorPatch(block, BLOCK_FOLD_METHODS);
		patch.install(wrappers);
		this.#patches.set(block, { patch, native });
	}

	#restoreBlock(block: RenderableBlock): void {
		const patch = this.#patches.get(block);
		if (!patch) return;
		patch.patch.restore();
		this.#patches.delete(block);
		this.#roles.delete(block);
	}

	#sameMembers(
		members: readonly RenderableBlock[],
		children: readonly unknown[],
		start: number,
		end: number,
	): boolean {
		if (members.length !== end - start + 1) return false;
		for (let index = 0; index < members.length; index++)
			if (members[index] !== children[start + index]) return false;
		return true;
	}

	#nativeRows(value: unknown, width: number): Lines {
		if (
			!value ||
			typeof value !== "object" ||
			typeof (value as RenderableBlock).render !== "function"
		)
			return EMPTY_LINES;
		const block = value as RenderableBlock;
		return this.#native(block).render.call(block, width);
	}

	#plan(width: number): void {
		const children = this.#transcript.children;
		const planned = new Set<RenderableBlock>();
		let index = 0;
		while (index < children.length) {
			if (!this.#callbacks.isFoldable(children[index])) {
				index++;
				continue;
			}
			let end = index;
			while (end + 1 < children.length) {
				const next = children[end + 1];
				if (
					this.#callbacks.isFoldable(next) ||
					(isRenderableBlock(next) &&
						this.#nativeRows(next, width).every(
							(line) => !NON_BLANK.test(line),
						))
				) {
					end++;
					continue;
				}
				break;
			}
			const carrier = children[index] as RenderableBlock;
			let run = this.#runs.get(carrier);
			if (!run) {
				run = {
					members: children.slice(index, end + 1) as RenderableBlock[],
					spans: [],
					closed: false,
					width: -1,
					rows: EMPTY_LINES,
				};
				this.#runs.set(carrier, run);
			} else if (!this.#sameMembers(run.members, children, index, end)) {
				run.members = children.slice(index, end + 1) as RenderableBlock[];
				run.width = -1;
			}
			run.closed = end < children.length - 1;
			for (let position = 0; position < run.members.length; position++) {
				const member = run.members[position];
				if (!member) continue;
				planned.add(member);
				this.#installBlock(member);
				this.#roles.set(member, { run, carrier: position === 0 });
			}
			index = end + 1;
		}
		for (const block of [...this.#patches.keys()])
			if (!planned.has(block)) this.#restoreBlock(block);
	}
}
