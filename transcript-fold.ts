import { BLOCK_FOLD_METHODS, TRANSCRIPT_FOLD_METHODS } from "./host-adapter";
import { DescriptorPatch } from "./patch-kit";

type Lines = readonly string[];

export interface RenderableBlock {
	render(width: number): Lines;
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
	renderViewportTail(width: number, maxRows: number): Lines;
	isBlockUncommitted(component: unknown): boolean;
	isBlockInLiveRegion(component: unknown): boolean;
}

interface NativeBlockMethods {
	render: (width: number) => Lines;
	finalized?: () => boolean;
	version?: () => number;
	settledRows?: () => number;
	displaceable?: () => boolean;
	seal?: () => void;
	setCommittedRows?: (rows: number) => void;
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
	settledRows(
		block: RenderableBlock,
		nativeSettledRows: (() => number) | undefined,
	): number;
	version(
		block: RenderableBlock,
		nativeVersion: (() => number) | undefined,
	): number;
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
	version: number;
	settled: number;
	committed: number;
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

function finiteRows(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.trunc(value))
		: 0;
}

function isRenderableBlock(value: unknown): value is RenderableBlock {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof (value as RenderableBlock).render === "function",
	);
}

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
	readonly #roles = new WeakMap<object, FoldRole>();
	readonly #runs = new WeakMap<object, FoldRun>();
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
	 * D03: structured committed-row gate for the terminal scrollback
	 * replay. Reports whether any fold-owned run has a non-zero committed
	 * row count declared through the native
	 * `setNativeScrollbackCommittedRows` seam (stock freezes mutable
	 * live-region rows into native scrollback by declaring them committed).
	 * Pure structured fold state: rendered text and ANSI/native strings are
	 * never inspected.
	 */
	hasCommittedRows(): boolean {
		for (const block of this.#patches.keys()) {
			const role = this.#roles.get(block);
			if (role?.carrier && role.run.committed > 0) return true;
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
			const hostTail = this.#transcript.renderViewportTail;
			const hostUncommitted = this.#transcript.isBlockUncommitted;
			const wrappers: Record<string, PropertyDescriptor> = {
				render: {
					configurable: true,
					writable: true,
					value: (width: number): Lines => {
						this.#plan(width);
						return hostRender.call(this.#transcript, width);
					},
				},
				renderViewportTail: {
					configurable: true,
					writable: true,
					value: (width: number, maxRows: number): Lines => {
						this.#plan(width);
						return hostTail.call(this.#transcript, width, maxRows);
					},
				},
				isBlockUncommitted: {
					configurable: true,
					writable: true,
					value: (component: unknown): boolean => {
						const role =
							component && typeof component === "object"
								? this.#roles.get(component)
								: undefined;
						return role && !role.carrier
							? this.#memberUncommitted(role, component)
							: hostUncommitted.call(this.#transcript, component);
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
		if (
			!this.#installed &&
			this.#patches.size === 0 &&
			this.#transcriptPatch === undefined &&
			Reflect.get(this.#transcript, TRANSCRIPT_FOLD_OWNER) !== this
		)
			return;
		for (const [block, patch] of this.#patches) {
			patch.patch.restore();
			this.#roles.delete(block);
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
			version: inheritedMethod(block, "getTranscriptBlockVersion"),
			settledRows: inheritedMethod(block, "getTranscriptBlockSettledRows"),
			displaceable: inheritedMethod(block, "isDisplaceableBlock"),
			seal: inheritedMethod(block, "seal"),
			setCommittedRows: inheritedMethod(
				block,
				"setNativeScrollbackCommittedRows",
			),
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

	#blockSettledRows(block: RenderableBlock): number {
		const native = this.#native(block);
		return finiteRows(
			this.#callbacks.settledRows(block, native.settledRows?.bind(block)),
		);
	}

	#blockVersion(block: RenderableBlock): number {
		const native = this.#native(block);
		const value = this.#callbacks.version(block, native.version?.bind(block));
		return typeof value === "number" && Number.isFinite(value) ? value : 0;
	}

	#renderRun(run: FoldRun, width: number): Lines {
		const rows: string[] = [];
		const spans: FoldSpan[] = [];
		let settled = 0;
		let settling = true;
		for (const member of run.members) {
			const raw = this.#renderBlock(member, width);
			let lead = 0;
			while (lead < raw.length && !NON_BLANK.test(raw[lead] ?? "")) lead++;
			let end = raw.length;
			while (end > lead && !NON_BLANK.test(raw[end - 1] ?? "")) end--;
			spans.push({ lead, rows: end - lead });
			for (let index = lead; index < end; index++) rows.push(raw[index] ?? "");
			if (!settling) continue;
			if (this.#blockFinalized(member)) settled += end - lead;
			else {
				settled += Math.max(
					0,
					Math.min(end - lead, this.#blockSettledRows(member) - lead),
				);
				settling = false;
			}
		}
		run.spans = spans;
		run.settled = settled;
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
			getTranscriptBlockVersion: {
				configurable: true,
				writable: true,
				value(this: RenderableBlock): number {
					const role = fold.#roles.get(this);
					if (!role?.carrier) return fold.#blockVersion(this);
					let version = role.run.version;
					for (const member of role.run.members)
						version += fold.#blockVersion(member);
					return version;
				},
			},
			getTranscriptBlockSettledRows: {
				configurable: true,
				writable: true,
				value(this: RenderableBlock): number {
					const role = fold.#roles.get(this);
					return role?.carrier
						? role.run.settled
						: fold.#blockSettledRows(this);
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
					let offset = 0;
					for (let index = 0; index < role.run.members.length; index++) {
						const member = role.run.members[index];
						if (!member) continue;
						const rows = role.run.spans[index]?.rows ?? 0;
						if (rows > 0 && offset + rows <= role.run.committed)
							fold.#native(member).seal?.call(member);
						offset += rows;
					}
				},
			},
			setNativeScrollbackCommittedRows: {
				configurable: true,
				writable: true,
				value(this: RenderableBlock, rows: number): void {
					const role = fold.#roles.get(this);
					if (!role) {
						native.setCommittedRows?.call(this, rows);
						return;
					}
					if (!role.carrier) return;
					role.run.committed = finiteRows(rows);
					let offset = 0;
					for (let index = 0; index < role.run.members.length; index++) {
						const member = role.run.members[index];
						if (!member) continue;
						const span = role.run.spans[index];
						const total = span?.rows ?? 0;
						const committed = Math.max(
							0,
							Math.min(total, role.run.committed - offset),
						);
						fold
							.#native(member)
							.setCommittedRows?.call(
								member,
								committed > 0 ? (span?.lead ?? 0) + committed : 0,
							);
						offset += total;
					}
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
					version: 1,
					settled: 0,
					committed: 0,
					width: -1,
					rows: EMPTY_LINES,
				};
				this.#runs.set(carrier, run);
			} else if (!this.#sameMembers(run.members, children, index, end)) {
				run.members = children.slice(index, end + 1) as RenderableBlock[];
				run.version++;
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

	#memberUncommitted(role: FoldRole, component: unknown): boolean {
		let offset = 0;
		for (let index = 0; index < role.run.members.length; index++) {
			const rows = role.run.spans[index]?.rows ?? 0;
			if (role.run.members[index] === component)
				return rows === 0 || offset >= role.run.committed;
			offset += rows;
		}
		return true;
	}
}
