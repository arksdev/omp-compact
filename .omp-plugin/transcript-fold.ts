import {
	BLOCK_FOLD_METHODS,
	BLOCK_PUBLICATION_MEMBERS,
	TRANSCRIPT_FOLD_METHODS,
} from "./host-adapter";
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

/** Width-independent identity of one published row group (18.0.1 contract). */
export interface StableRow {
	readonly key: string;
}

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
	/**
	 * Complete-history replay (18.0.6). The terminal drives it through
	 * `resetDisplay`, and it renders blocks, so the fold replans through it
	 * like every other render entry point. Optional: older hosts replay
	 * through `peekFinalizedBatch` alone.
	 */
	peekReplayBatch?(width: number): HistoryBatch | undefined;
	/**
	 * Resize repaint of the trailing rows. Renders every entry's component at
	 * the new width, so the fold replans through it. Optional: older hosts
	 * repaint through `render`/`renderViewport` alone.
	 */
	renderTail?(width: number, maxRows: number): Lines;
	/**
	 * Shutdown flush of the remaining history (zero capacity). Renders blocks
	 * like `peekFinalizedBatch`, so the fold replans through it too.
	 */
	peekFlushBatch?(width: number): HistoryBatch | undefined;
	acknowledgeFinalizedBatch(id: number): void;
	canRemoveBlock(component: unknown): boolean;
	blockStates(): readonly BlockState[];
	/**
	 * Published row counts per block, in transcript order. Optional: only
	 * hosts with append-only publication report them, and the fold's own
	 * viewport needs them so a published row is never painted twice.
	 */
	emittedStableRows?(): readonly number[];
}

interface NativeBlockMethods {
	render: (width: number) => Lines;
	finalized?: () => boolean;
	displaceable?: () => boolean;
	seal?: () => void;
}

/** Row budget the 18.0.1 transcript hands a block before rendering it. */
interface AllocatableBlock {
	setTranscriptAllocation?(rows: number, frame: AnimationFrame): void;
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
	/**
	 * Whether the block's rows can no longer change, while its run keeps
	 * going. Those rows are history already: the carrier publishes them into
	 * native scrollback so one long turn still grows the terminal's history
	 * instead of holding every row in the mutable viewport.
	 */
	isRetirable(
		block: RenderableBlock,
		nativeFinalized: (() => boolean) | undefined,
	): boolean;
}

interface FoldRun {
	members: RenderableBlock[];
	closed: boolean;
	width: number;
	rows: Lines;
	/**
	 * Published leading members, one key each. Monotonic by contract: a key
	 * once published names bytes the terminal may already own, so the list
	 * only ever grows.
	 */
	stable: readonly StableRow[];
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
const EMPTY_STABLE_ROWS: readonly StableRow[] = Object.freeze([]);
// Cross-module-instance marker: a plugin may be both user-linked and loaded
// explicitly with `-e`. The fold mutates only this exact transcript instance,
// but duplicate module copies must still observe the same ownership key.
const TRANSCRIPT_FOLD_OWNER = Symbol.for("omp-compact.transcript-fold.owner");
const NON_BLANK = /\S/;
const SEPARATOR: Lines = Object.freeze([""]);
const UNBOUNDED_ROWS = Number.MAX_SAFE_INTEGER;

/** Drop the blank rows a block pads its own edges with. */
function trimBlankEdges(raw: Lines): Lines {
	let lead = 0;
	while (lead < raw.length && !NON_BLANK.test(raw[lead] ?? "")) lead++;
	let end = raw.length;
	while (end > lead && !NON_BLANK.test(raw[end - 1] ?? "")) end--;
	return lead === 0 && end === raw.length ? raw : raw.slice(lead, end);
}

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
	/** Native `liveRowCount`, captured while patching the transcript. */
	#hostLiveRows: ((width: number) => number) | undefined;
	/**
	 * Whether a history batch has been handed to the terminal since install.
	 * Set from the fold's own batch wrappers, so an append-only answer whose
	 * prefix streams out row by row is counted even though the container
	 * still reports its block `active`.
	 */
	#emittedHistory = false;
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
	 * Whether any fold-owned row has already reached terminal history, where
	 * it is immutable and a later projection change could never take it off
	 * the screen again.
	 *
	 * Two ways that happens, and both must count. A retired carrier is the
	 * obvious one: `blockStates()` runs parallel to `children`, so its state
	 * is read by position. The other leaves no trace in those states at all —
	 * an append-only answer stays `active` while the container streams its
	 * published prefix into scrollback one row per frame. A long answer with
	 * no tool use retires nothing and yet is mostly written out already, so
	 * gating on carriers alone left exactly that case without its replay:
	 * the leading rows stayed above the viewport and out of reach.
	 *
	 * The fold sees those rows because every history batch passes through its
	 * own wrapper, so `#emittedHistory` records them without asking the
	 * container to render anything. No text and no ANSI is inspected —
	 * structured state only.
	 */
	hasCommittedRows(): boolean {
		if (this.#emittedHistory) return true;
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

	/**
	 * Room to report when the container offers a history batch.
	 *
	 * The host retires by rows but falls back to a one-row-per-block screen
	 * by *block count*: `renderViewport` switches to that fallback as soon
	 * as live blocks outnumber the transcript height, and it renders each
	 * block's first row — an empty string for the folded members that render
	 * nothing. Folding shrinks rows without shrinking blocks, so a long
	 * session parks far below the row pressure that would trigger
	 * retirement while sitting far above the block count that triggers the
	 * fallback: the screen fills with blank rows.
	 *
	 * When live blocks outnumber the height, reporting the live tail's own
	 * height minus one row makes the container retire its settled prefix
	 * into terminal history. Live blocks drop back below the height, the
	 * fallback never engages, and the retired rows are exactly the folded
	 * projection the container itself renders. A run still open retires
	 * nothing this way — its carrier is not settled — but the same pressure
	 * lets the carrier publish the rows that can no longer change, one member
	 * per frame (see `#stableRows`).
	 */
	#retirementRoom(width: number, capacity: number): number {
		const states = this.#transcript.blockStates();
		let live = 0;
		for (const state of states) if (state !== "committed") live++;
		if (live <= capacity) return capacity;
		const liveRows =
			this.#hostLiveRows?.call(this.#transcript, width) ??
			this.#transcript.liveRowCount(width);
		// A screenful or more of live rows is pressure the container already
		// acts on, and the honest room keeps exactly that screenful on screen.
		// Reporting less would hand the whole run to the terminal and leave the
		// viewport empty while the agent is still working.
		if (liveRows >= capacity) return capacity;
		return Math.max(0, Math.min(capacity, liveRows - 1));
	}

	/**
	 * Replacement frame for the host's one-row-per-block fallback.
	 *
	 * That fallback keys on block count: once live blocks outnumber the
	 * transcript height it prints each block's first row, and a folded member
	 * renders nothing, so its slot becomes an empty string. Publication and
	 * retirement shrink the rows a carrier still owns, never the block count,
	 * so one long turn would still paint the viewport with blanks.
	 *
	 * So when the fold is the reason the count is inflated, the fold answers
	 * for the frame: blocks that render nothing take no row, the rest render
	 * their unpublished tail, and the newest rows win the screen. Sessions the
	 * fold does not touch keep the host's own fallback.
	 */
	#silentViewport(
		width: number,
		rows: number,
		frame: AnimationFrame,
	): Lines | undefined {
		const capacity = Math.max(0, Math.trunc(rows));
		if (capacity === 0 || this.#patches.size === 0) return undefined;
		const children = this.#transcript.children;
		const start = this.#liveStart(children);
		if (children.length - start <= capacity) return undefined;
		if (!this.#hasSilentBlock(children, start, width)) return undefined;
		// Newest first, stopping as soon as the screen is full: the folded
		// carrier answers for its whole run from a cached projection, and
		// silent members cost nothing to skip.
		const chunks: Lines[] = [];
		let total = 0;
		for (let index = children.length - 1; index >= start; index--) {
			if (total >= capacity) break;
			const child = children[index];
			if (!isRenderableBlock(child)) continue;
			(child as AllocatableBlock).setTranscriptAllocation?.(
				UNBOUNDED_ROWS,
				frame,
			);
			// Rows the terminal already owns must not be painted again: the
			// container reports how many of a carrier's members it published.
			const block = trimBlankEdges(this.#unpublishedRows(child, index, width));
			if (block.length === 0) continue;
			if (chunks.length > 0) {
				chunks.push(SEPARATOR);
				total++;
			}
			chunks.push(block);
			total += block.length;
		}
		const output: string[] = [];
		for (let index = chunks.length - 1; index >= 0; index--)
			output.push(...(chunks[index] ?? EMPTY_LINES));
		return output.length > capacity
			? output.slice(output.length - capacity)
			: output;
	}

	/**
	 * A block's rows minus the ones the container already published into
	 * native scrollback. Only a carrier publishes, and it publishes whole
	 * members, so the offset is the row count of its published prefix.
	 */
	#unpublishedRows(
		block: RenderableBlock,
		index: number,
		width: number,
	): Lines {
		const rows = block.render(width);
		const role = this.#roles.get(block);
		if (!role?.carrier) return rows;
		const published = this.#transcript.emittedStableRows?.()[index] ?? 0;
		if (published === 0) return rows;
		const skip = this.#renderMembers(role.run, width, 0, published).length;
		return skip >= rows.length ? EMPTY_LINES : rows.slice(skip);
	}

	/**
	 * First child of the mutable live tail.
	 *
	 * Committed blocks are terminal history, and a batch already offered for
	 * retirement is mid-write: both sit outside the viewport. `canRemoveBlock`
	 * is exactly that boundary — false below it, true above — so one probe
	 * settles the common case and a bisection finds the seam while a batch
	 * awaits its acknowledgement.
	 *
	 * A block that published part of its rows also answers false there, and
	 * that one is still live: its unpublished tail is the newest thing on
	 * screen. Published rows are counted per block, so the two cases separate
	 * cleanly.
	 */
	#liveStart(children: readonly unknown[]): number {
		const states = this.#transcript.blockStates();
		const emitted = this.#transcript.emittedStableRows?.();
		let start = 0;
		while (start < children.length && states[start] === "committed") start++;
		if (start >= children.length) return children.length;
		if (this.#isLive(children, emitted, start)) return start;
		let low = start + 1;
		let high = children.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (this.#isLive(children, emitted, mid)) high = mid;
			else low = mid + 1;
		}
		return low;
	}

	#isLive(
		children: readonly unknown[],
		emitted: readonly number[] | undefined,
		index: number,
	): boolean {
		if ((emitted?.[index] ?? 0) > 0) return true;
		return this.#transcript.canRemoveBlock(children[index]);
	}

	/** Whether the live tail holds a block the fold renders as nothing. */
	#hasSilentBlock(
		children: readonly unknown[],
		start: number,
		width: number,
	): boolean {
		for (let index = start; index < children.length; index++) {
			const child = children[index];
			if (!child || typeof child !== "object") continue;
			const role = this.#roles.get(child);
			if (!role) continue;
			// Members always render nothing; a carrier is silent only when its
			// whole run projects to no rows (the `clear` presentation).
			if (!role.carrier) return true;
			if (this.#renderRun(role.run, width).length === 0) return true;
		}
		return false;
	}

	/**
	 * Patch a block the moment it joins the transcript.
	 *
	 * The container captures a block's presentation mode when it first syncs
	 * the child, and a bare `blockStates()` call is enough to do that — well
	 * before any render, so before the first plan. A block the plan patches
	 * later would already be recorded `mutable` and could never publish its
	 * settled rows into scrollback. Roles are still the plan's business: with
	 * no role yet, the wrappers answer exactly as they did before.
	 */
	observeChild(child: unknown): void {
		if (!this.#installed) return;
		if (!this.#callbacks.isFoldable(child)) return;
		// Best effort: a block that cannot take the declaration simply never
		// publishes, and the plan reports real capability skew on its own.
		try {
			this.#declarePublication(child as RenderableBlock);
		} catch {}
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
			this.#hostLiveRows = hostLiveRows;
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
						return (
							this.#silentViewport(width, rows, frame) ??
							hostViewport.call(this.#transcript, width, rows, frame)
						);
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
						const batch = hostPeekBatch.call(
							this.#transcript,
							width,
							this.#retirementRoom(width, capacity),
						);
						// An offered batch is history on its way to the terminal,
						// whatever the container reports about the block it came
						// from: a streaming answer publishes its prefix this way
						// while staying `active`.
						if (batch !== undefined) this.#emittedHistory = true;
						return batch;
					},
				},
			};
			// Optional entry points are patched only when this instance really
			// has them (`TRANSCRIPT_FOLD_OPTIONAL_METHODS` records the full
			// version-dependent set): defining a method the host never had
			// would invent a capability the rest of the adapter probes for.
			const patched: string[] = [...TRANSCRIPT_FOLD_METHODS];
			const hostReplayBatch = this.#transcript.peekReplayBatch;
			if (typeof hostReplayBatch === "function") {
				// 18.0.6 replays the complete history here, and the terminal
				// drives it through `resetDisplay` with no frame in between: an
				// unplanned carrier would answer with the rows of a run that has
				// since grown, and members added after the last frame would
				// render their native cards straight into scrollback.
				wrappers.peekReplayBatch = {
					configurable: true,
					writable: true,
					value: (width: number): HistoryBatch | undefined => {
						this.#plan(width);
						return hostReplayBatch.call(this.#transcript, width);
					},
				};
				patched.push("peekReplayBatch");
			}
			const hostRenderTail = this.#transcript.renderTail;
			if (typeof hostRenderTail === "function") {
				// The terminal repaints the trailing rows on resize, and
				// `renderTail` renders every entry's component directly at the
				// new width. Without a replan at that width a carrier answers
				// with rows measured for the old one and its folded members
				// render their native cards again.
				wrappers.renderTail = {
					configurable: true,
					writable: true,
					value: (width: number, maxRows: number): Lines => {
						this.#plan(width);
						return hostRenderTail.call(this.#transcript, width, maxRows);
					},
				};
				patched.push("renderTail");
			}
			const hostFlushBatch = this.#transcript.peekFlushBatch;
			if (typeof hostFlushBatch === "function") {
				// Shutdown flush: same block-rendering path as
				// `peekFinalizedBatch` with zero capacity, so the last history
				// the user keeps must come from a planned fold rather than a
				// stale one. Capacity is fixed at 0 by the host, so the
				// retirement-room adjustment does not apply here.
				wrappers.peekFlushBatch = {
					configurable: true,
					writable: true,
					value: (width: number): HistoryBatch | undefined => {
						this.#plan(width);
						const batch = hostFlushBatch.call(this.#transcript, width);
						if (batch !== undefined) this.#emittedHistory = true;
						return batch;
					},
				};
				patched.push("peekFlushBatch");
			}
			this.#transcriptPatch = new DescriptorPatch(this.#transcript, patched);
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
		this.#hostLiveRows = undefined;
		this.#emittedHistory = false;
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

	/**
	 * Rows of the members in `[from, to)`, each trimmed of the blank edges a
	 * block pads itself with. The full-run call is what a carrier renders, so
	 * every partial range is a row-exact slice of it — which is what the
	 * append-only publication contract requires of a published prefix.
	 */
	#renderMembers(run: FoldRun, width: number, from: number, to: number): Lines {
		const rows: string[] = [];
		for (let position = from; position < to; position++) {
			const member = run.members[position];
			if (!member) continue;
			const raw = this.#renderBlock(member, width);
			let lead = 0;
			while (lead < raw.length && !NON_BLANK.test(raw[lead] ?? "")) lead++;
			let end = raw.length;
			while (end > lead && !NON_BLANK.test(raw[end - 1] ?? "")) end--;
			for (let index = lead; index < end; index++) rows.push(raw[index] ?? "");
		}
		return rows;
	}

	#renderRun(run: FoldRun, width: number): Lines {
		const rows = this.#renderMembers(run, width, 0, run.members.length);
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

	/**
	 * Published prefix of a run: its leading members whose rows can no longer
	 * change. One key per member, so the identity stays width-independent
	 * even for a member that renders several rows, and the list only grows —
	 * a key already published names bytes the terminal may own.
	 */
	#stableRows(run: FoldRun): readonly StableRow[] {
		let count = 0;
		for (const member of run.members) {
			if (
				!this.#callbacks.isRetirable(
					member,
					this.#native(member).finalized?.bind(member),
				)
			)
				break;
			count++;
		}
		if (count <= run.stable.length) return run.stable;
		const keys = [...run.stable];
		while (keys.length < count) keys.push({ key: `m${String(keys.length)}` });
		run.stable = keys;
		return run.stable;
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
		this.#declarePublication(block);
	}

	/**
	 * Declare the append-only publication members once, and never take them
	 * back.
	 *
	 * The container captures a block's presentation mode the first time it
	 * syncs the child — inside `addChild` — and then keeps calling these for
	 * the block's whole life. So the declaration lands before the block joins
	 * the transcript, and it survives everything the fold does afterwards: a
	 * release to native, a quarantine, a rollback. With no role they report
	 * nothing published, which renders exactly like a mutable block.
	 *
	 * Only these three members are declared this early. The rest of the fold
	 * patch waits for the plan, because `render` and `seal` are part of the
	 * surface the adapter classifies a block by: adding them before the
	 * adapter has seen the block would make a card match a different kind.
	 */
	#declarePublication(block: RenderableBlock): void {
		if (BLOCK_PUBLICATION_MEMBERS[0] in block) return;
		const fold = this;
		Object.defineProperties(block, {
			transcriptBlockMode: {
				configurable: true,
				writable: true,
				value: "appendOnly",
			},
			getTranscriptStableRows: {
				configurable: true,
				writable: true,
				value(this: RenderableBlock): readonly StableRow[] {
					const role = fold.#roles.get(this);
					if (!role?.carrier) return EMPTY_STABLE_ROWS;
					return fold.#stableRows(role.run);
				},
			},
			renderTranscriptStableRows: {
				configurable: true,
				writable: true,
				value(this: RenderableBlock, count: number, width: number): Lines {
					const role = fold.#roles.get(this);
					if (!role?.carrier) return EMPTY_LINES;
					return fold.#renderMembers(role.run, width, 0, count);
				},
			},
		});
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
					closed: false,
					width: -1,
					rows: EMPTY_LINES,
					stable: EMPTY_STABLE_ROWS,
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
