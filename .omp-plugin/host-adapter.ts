/**
 * B02: pinned OMP 17.2.12 host capability adapter.
 *
 * Single module tree for every private host shape, method name and
 * argument-position mapping the plugin knows about:
 * - transcript container surface (`children`, `addChild`, `clear`,
 *   render/live-region methods);
 * - tool execution component and read group surfaces;
 * - transcript block fold surface (native render/version/seal methods);
 * - exact TUI surface (optional `resetDisplay` for the future rebuild
 *   phase).
 *
 * The host release is pinned in `hostVersion` for documentation only:
 * every decision is a runtime capability probe, never a version-string
 * dispatch. Capabilities are split into transcript-critical (required for
 * the current presentation) and optional (consumed by the future
 * clear/addChild/resetDisplay rebuild with native fail-open on missing or
 * incompatible capabilities).
 *
 * Patching is exact-instance only: wrappers are installed on the specific
 * host objects of the current session through the transactional
 * `DescriptorPatch` kit, never on prototypes or shared shapes.
 */

import { DescriptorPatch } from "./patch-kit";
import type { RenderableBlock, TranscriptHost } from "./transcript-fold";

/**
 * Transcript methods required for discovery/install. A container missing
 * any of these is not a transcript host and stays entirely native.
 */
export const TRANSCRIPT_CRITICAL_METHODS = [
	"addChild",
	"render",
	"renderViewportTail",
	"isBlockUncommitted",
	"isBlockInLiveRegion",
] as const;

/**
 * Transcript methods the rebuild phase consumes (stock `clear` on the
 * exact transcript instance). Optional: the current presentation never
 * calls them, and a missing/incompatible capability fails open to native.
 */
export const TRANSCRIPT_OPTIONAL_METHODS = ["clear"] as const;

/**
 * Transcript methods the fold patches (`TranscriptFold`). A strict subset
 * of the critical surface.
 */
export const TRANSCRIPT_FOLD_METHODS = [
	"render",
	"renderViewportTail",
	"isBlockUncommitted",
] as const;

/** OMP 17.2.12 tool execution component surface. */
export const TOOL_METHODS = [
	"updateArgs",
	"updateResult",
	"setArgsComplete",
	"setExpanded",
	"seal",
	"setToolActivityVisible",
] as const;

/** Tool component methods the adapter wraps (subset of TOOL_METHODS). */
export const TOOL_PATCH_METHODS = [
	"updateArgs",
	"updateResult",
	"setArgsComplete",
	"setExpanded",
] as const;

/** OMP 17.2.12 read group component surface. */
export const READ_GROUP_METHODS = [
	"updateArgs",
	"updateResult",
	"removeEntry",
	"renameEntry",
] as const;

/** Read group methods the adapter wraps (superset incl. `setExpanded`). */
export const READ_GROUP_PATCH_METHODS = [
	"updateArgs",
	"updateResult",
	"setExpanded",
	"renameEntry",
	"removeEntry",
] as const;

/**
 * OMP 17.2.12 transcript block fold surface. All optional: the fold reads
 * them through the prototype chain and falls back to native behavior when
 * absent.
 */
export const BLOCK_FOLD_METHODS = [
	"render",
	"isTranscriptBlockFinalized",
	"getTranscriptBlockVersion",
	"getTranscriptBlockSettledRows",
	"isDisplaceableBlock",
	"seal",
	"setNativeScrollbackCommittedRows",
] as const;

/**
 * Exact TUI methods the rebuild phase consumes. Optional: consumed only
 * with native fail-open when absent.
 */
export const TUI_OPTIONAL_METHODS = ["resetDisplay"] as const;

const ADD_CHILD = "addChild" as const;
const MAX_DISCOVERY_DEPTH = 12;

function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function resolveMethod(
	value: object,
	name: string,
): ((...args: unknown[]) => unknown) | undefined {
	const method = (value as Record<string, unknown>)[name];
	return typeof method === "function"
		? (method as (...args: unknown[]) => unknown)
		: undefined;
}

function stringAt(args: readonly unknown[], index: number): string | undefined {
	const value = args[index];
	return typeof value === "string" ? value : undefined;
}

export interface TranscriptCapabilities {
	readonly children: boolean;
	readonly addChild: boolean;
	readonly render: boolean;
	readonly renderViewportTail: boolean;
	readonly isBlockUncommitted: boolean;
	readonly isBlockInLiveRegion: boolean;
	/** Optional rebuild-phase capability: exact transcript `clear`. */
	readonly clear: boolean;
}

export function transcriptCapabilities(value: unknown): TranscriptCapabilities {
	const candidate = objectRecord(value);
	return {
		children: Array.isArray(candidate.children),
		addChild: typeof candidate.addChild === "function",
		render: typeof candidate.render === "function",
		renderViewportTail: typeof candidate.renderViewportTail === "function",
		isBlockUncommitted: typeof candidate.isBlockUncommitted === "function",
		isBlockInLiveRegion: typeof candidate.isBlockInLiveRegion === "function",
		clear: typeof candidate.clear === "function",
	};
}

export interface TuiCapabilities {
	/** Exact TUI `resetDisplay` (rebuild phase only; optional). */
	readonly resetDisplay: boolean;
}

export function tuiCapabilities(value: unknown): TuiCapabilities {
	const candidate = objectRecord(value);
	return { resetDisplay: typeof candidate.resetDisplay === "function" };
}

export type LeafKind = "tool" | "readGroup" | "none";

export interface LeafCapabilities {
	readonly kind: LeafKind;
	readonly render: boolean;
	/** Per-method presence over the full known leaf surface. */
	readonly methods: Readonly<Record<string, boolean>>;
}

const LEAF_METHODS = [
	"render",
	...TOOL_METHODS,
	...READ_GROUP_METHODS,
	...BLOCK_FOLD_METHODS,
] as const;

export function leafCapabilities(value: unknown): LeafCapabilities {
	const candidate = objectRecord(value);
	const methods: Record<string, boolean> = {};
	for (const name of LEAF_METHODS)
		methods[name] = typeof candidate[name] === "function";
	const tool = TOOL_METHODS.every((name) => methods[name]);
	const readGroup = READ_GROUP_METHODS.every((name) => methods[name]);
	return {
		// Read groups expose the generic tool surface too; their rename/remove
		// methods are the more specific discriminator and must win.
		kind: readGroup ? "readGroup" : tool ? "tool" : "none",
		render: methods.render,
		methods,
	};
}

export function isTranscriptHost(value: unknown): value is TranscriptHost {
	if (!value || typeof value !== "object") return false;
	const capabilities = transcriptCapabilities(value);
	return (
		capabilities.children &&
		capabilities.addChild &&
		capabilities.render &&
		capabilities.renderViewportTail &&
		capabilities.isBlockUncommitted &&
		capabilities.isBlockInLiveRegion
	);
}

/**
 * Version-pinned stats-carrier placement seam. Stats must be inserted before
 * the native terminal answer, so append-only `addChild` is insufficient.
 * Validate the exact mutable transcript array and bounded index; any changed
 * or read-only host shape leaves native rendering untouched.
 */
export function insertTranscriptChildAt(
	transcript: unknown,
	index: number,
	child: unknown,
): boolean {
	try {
		if (!isTranscriptHost(transcript) || !Number.isSafeInteger(index))
			return false;
		const children = transcript.children;
		if (
			!Array.isArray(children) ||
			index < 0 ||
			index > children.length ||
			!Object.isExtensible(children) ||
			Object.isSealed(children)
		)
			return false;
		children.splice(index, 0, child);
		return true;
	} catch {
		return false;
	}
}

export function isToolComponent(value: unknown): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const capabilities = leafCapabilities(value);
	return capabilities.render && capabilities.kind === "tool";
}

export function isReadGroupComponent(value: unknown): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const capabilities = leafCapabilities(value);
	return capabilities.render && capabilities.kind === "readGroup";
}

/**
 * OMP 17.2.12 argument positions. `updateArgs` carries
 * `(payload, toolCallId)`; the read group's `updateResult` carries
 * `(result, isPartial, toolCallId)` while the tool component's
 * `updateResult` carries `(result, isPartial)`. `renameEntry` takes
 * `(oldId, newId)`, `removeEntry` takes `(toolCallId)` and `setExpanded`
 * takes a single boolean.
 */
export function updateArgsToolCallId(
	args: readonly unknown[],
): string | undefined {
	return stringAt(args, 1);
}

export function updateArgsPayload(args: readonly unknown[]): unknown {
	return args[0];
}

export function updateResultToolCallId(
	args: readonly unknown[],
): string | undefined {
	return stringAt(args, 2);
}

export function updateResultPayload(args: readonly unknown[]): unknown {
	return args[0];
}

export function updateResultIsPartial(args: readonly unknown[]): boolean {
	return args[1] === true;
}

export function renameEntryIds(args: readonly unknown[]): {
	oldId: string | undefined;
	newId: string | undefined;
} {
	return { oldId: stringAt(args, 0), newId: stringAt(args, 1) };
}

export function removeEntryToolCallId(
	args: readonly unknown[],
): string | undefined {
	return stringAt(args, 0);
}

export function setExpandedValue(args: readonly unknown[]): boolean {
	return args[0] === true;
}

/**
 * Pinned host adapter for stock OMP 17.2.12. Instance-scoped to the host
 * root of one session; all patching is exact-instance and transactional.
 */
export class HostAdapter17212 {
	/**
	 * Pinned host release this adapter targets. Capability probes, not
	 * this string, drive every decision.
	 */
	static readonly hostVersion = "17.2.12";

	readonly #root: unknown;

	constructor(root: unknown) {
		this.#root = root;
	}

	get root(): unknown {
		return this.#root;
	}

	/** Exact TUI capability fingerprint of this session's host root. */
	tuiCapabilities(): TuiCapabilities {
		return tuiCapabilities(this.#root);
	}

	/**
	 * Bounded discovery over the host tree: every transcript-shaped
	 * container, or an empty list. The caller owns multiplicity policy
	 * (the adapter treats more than one as a hard failure).
	 */
	collectTranscriptCandidates(): TranscriptHost[] {
		const candidates: TranscriptHost[] = [];
		this.#collect(this.#root, 0, new Set<object>(), candidates);
		return candidates;
	}

	#collect(
		value: unknown,
		depth: number,
		seen: Set<object>,
		candidates: TranscriptHost[],
	): void {
		if (depth > MAX_DISCOVERY_DEPTH || !value || typeof value !== "object")
			return;
		if (seen.has(value)) return;
		seen.add(value);
		if (isTranscriptHost(value)) {
			candidates.push(value);
			return;
		}
		const candidate = value as Record<string, unknown>;
		if (!Array.isArray(candidate.children)) return;
		for (const child of candidate.children)
			this.#collect(child, depth + 1, seen, candidates);
	}

	/**
	 * Incremental discovery over a live tree: stops at the first
	 * transcript-shaped node (and does not visit anything else), otherwise
	 * reports every children+addChild container so the caller can watch
	 * future `addChild` calls. Bounded by depth; the caller's callbacks own
	 * install/rollback policy and must not throw (the observer error policy
	 * belongs to the caller). Returns true when a transcript was found.
	 */
	observeTree(
		value: unknown,
		depth: number,
		onTranscript: (transcript: TranscriptHost) => void,
		onContainer: (container: Record<string, unknown>) => void,
	): boolean {
		if (depth > MAX_DISCOVERY_DEPTH || !value || typeof value !== "object")
			return false;
		if (isTranscriptHost(value)) {
			onTranscript(value);
			return true;
		}
		const candidate = value as Record<string, unknown>;
		if (
			!Array.isArray(candidate.children) ||
			typeof candidate.addChild !== "function"
		)
			return false;
		onContainer(candidate);
		for (const child of candidate.children)
			if (this.observeTree(child, depth + 1, onTranscript, onContainer))
				return true;
		return false;
	}

	/**
	 * Exact-instance transcript `addChild` wrapper: calls the original,
	 * then `onChildAdded(child)`. The observer must not throw; rollback
	 * policy is the caller's. Throws (transactionally clean) when the
	 * transcript is unpatchable.
	 */
	patchAddChild(
		transcript: TranscriptHost,
		onChildAdded: (child: unknown) => void,
	): DescriptorPatch {
		if (!Object.isExtensible(transcript))
			throw new Error("unpatchable transcript");
		const original = resolveMethod(transcript, ADD_CHILD);
		if (!original) throw new Error("transcript addChild missing");
		const patch = new DescriptorPatch(transcript, [ADD_CHILD]);
		patch.install({
			[ADD_CHILD]: {
				configurable: true,
				writable: true,
				value(this: object, child: unknown, ...rest: unknown[]): unknown {
					const result = original.call(this, child, ...rest);
					onChildAdded(child);
					return result;
				},
			},
		});
		return patch;
	}

	/**
	 * Exact-instance transcript `clear` wrapper (C02 rebuild boundary):
	 * runs `onBeforeClear()` before calling the native `clear` exactly
	 * once. The observer must not throw (rollback policy is the caller's);
	 * a clear while the adapter is disposed is still forwarded to native.
	 * Throws (transactionally clean) when the transcript is unpatchable or
	 * the method is missing — the caller fails open to native presentation.
	 */
	patchClear(
		transcript: TranscriptHost,
		onBeforeClear: () => void,
	): DescriptorPatch {
		if (!Object.isExtensible(transcript))
			throw new Error("unpatchable transcript");
		const original = resolveMethod(transcript, "clear");
		if (!original) throw new Error("transcript clear missing");
		const patch = new DescriptorPatch(transcript, ["clear"]);
		patch.install({
			clear: {
				configurable: true,
				writable: true,
				value(this: object, ...args: unknown[]): unknown {
					onBeforeClear();
					return original.call(this, ...args);
				},
			},
		});
		return patch;
	}

	/** Capability-checked insertion for plugin-owned terminal carriers. */
	insertTranscriptChildAt(
		transcript: unknown,
		index: number,
		child: unknown,
	): boolean {
		return insertTranscriptChildAt(transcript, index, child);
	}

	/**
	 * Capability-checked exact-root `resetDisplay` invocation (C07 full
	 * scrollback replay). Returns true when the capability exists and was
	 * invoked; false when absent. A throwing host method is treated as an
	 * incompatible capability by the caller (fail open) — this method does
	 * not catch, so the caller owns the error policy.
	 */
	resetDisplay(): boolean {
		if (!this.#root || typeof this.#root !== "object") return false;
		const method = resolveMethod(this.#root, "resetDisplay");
		if (!method) return false;
		method.call(this.#root);
		return true;
	}

	/**
	 * Pre-transcript container probe: wraps `addChild` on a non-transcript
	 * container so later additions can be observed until the transcript is
	 * found. Same observer contract as `patchAddChild`.
	 */
	patchDiscoveryContainer(
		container: Record<string, unknown>,
		onChildAdded: (child: unknown) => void,
	): DescriptorPatch {
		const original = resolveMethod(container, ADD_CHILD);
		if (!original || !Object.isExtensible(container))
			throw new Error("unpatchable TUI container");
		const patch = new DescriptorPatch(container, [ADD_CHILD]);
		patch.install({
			[ADD_CHILD]: {
				configurable: true,
				writable: true,
				value(this: object, child: unknown, ...rest: unknown[]): unknown {
					const result = original.call(this, child, ...rest);
					onChildAdded(child);
					return result;
				},
			},
		});
		return patch;
	}

	/**
	 * Exact-instance tool component wrapper transaction. `onBefore` runs
	 * before the native method and must not throw (rollback policy is the
	 * caller's). Throws transactionally clean when the component is
	 * unpatchable or a wrapped method is missing.
	 */
	patchToolComponent(
		component: RenderableBlock,
		onBefore: (name: string, args: unknown[]) => void,
	): DescriptorPatch {
		if (!Object.isExtensible(component))
			throw new Error("unpatchable tool component");
		const wrappers: Record<string, PropertyDescriptor> = {};
		for (const name of TOOL_PATCH_METHODS) {
			const original = resolveMethod(component, name);
			if (!original) throw new Error(`tool component missing ${name}`);
			wrappers[name] = {
				configurable: true,
				writable: true,
				value(this: object, ...args: unknown[]): unknown {
					onBefore(name, args);
					return original.apply(this, args);
				},
			};
		}
		const patch = new DescriptorPatch(component, TOOL_PATCH_METHODS);
		patch.install(wrappers);
		return patch;
	}

	/**
	 * Exact-instance read group wrapper transaction, same contract as
	 * `patchToolComponent`.
	 */
	patchReadGroup(
		component: RenderableBlock,
		onBefore: (name: string, args: unknown[]) => void,
	): DescriptorPatch {
		if (!Object.isExtensible(component))
			throw new Error("unpatchable read group");
		const wrappers: Record<string, PropertyDescriptor> = {};
		for (const name of READ_GROUP_PATCH_METHODS) {
			const original = resolveMethod(component, name);
			if (!original) throw new Error(`read group missing ${name}`);
			wrappers[name] = {
				configurable: true,
				writable: true,
				value(this: object, ...args: unknown[]): unknown {
					onBefore(name, args);
					return original.apply(this, args);
				},
			};
		}
		const patch = new DescriptorPatch(component, READ_GROUP_PATCH_METHODS);
		patch.install(wrappers);
		return patch;
	}
}
