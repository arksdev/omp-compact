/**
 * B02: pinned OMP host capability adapter.
 *
 * The behavioral half of the pinned-host adapter: live capability
 * probes (fail open to native rendering when a surface is absent),
 * transcript carrier placement, and exact-instance wrapper
 * transactions. The pinned shape sheet — every method-name manifest,
 * component fingerprint and argument-position decoder — lives in
 * host-surface.ts, whose module header carries the version story.
 *
 * Every decision below is a capability probe on the live instance; the
 * pinned version strings are records, never runtime gates. Probes
 * report "capability absent" instead of throwing, so the plugin
 * degrades to native rendering and never takes a host down.
 *
 * Patching is exact-instance only: wrappers are installed on the specific
 * host objects of the current session through the transactional
 * `DescriptorPatch` kit, never on prototypes or shared shapes.
 */

import { objectRecord } from "./object-record";
import { DescriptorPatch } from "./patch-kit";
import {
	BLOCK_FOLD_METHODS,
	READ_GROUP_METHODS,
	READ_GROUP_PATCH_METHODS,
	TOOL_METHODS,
	TOOL_PATCH_METHODS,
} from "./host-surface";
import type { RenderableBlock, TranscriptHost } from "./transcript-fold";

// The pinned stock-host surface sheet moved to host-surface.ts. These
// re-exports keep host-adapter.ts the caller-facing module: existing
// importers resolve the same names and types from the same path.
export {
	BLOCK_FOLD_METHODS,
	BLOCK_PUBLICATION_MEMBERS,
	READ_GROUP_METHODS,
	READ_GROUP_PATCH_METHODS,
	TOOL_METHODS,
	TOOL_PATCH_METHODS,
	TRANSCRIPT_CRITICAL_METHODS,
	TRANSCRIPT_FOLD_METHODS,
	TRANSCRIPT_FOLD_OPTIONAL_METHODS,
	TRANSCRIPT_OPTIONAL_METHODS,
	TUI_OPTIONAL_METHODS,
	isBackgroundCompletionBlock,
	isBashExecutionComponent,
	isEvalExecutionComponent,
	isLateDiagnosticsMessageComponent,
	isReadGroupComponent,
	isSkillMessageComponent,
	isTodoReminderComponent,
	isToolComponent,
	isTtsrNotificationComponent,
	readArgsCollapseIntoGroup,
	readArgsTarget,
	removeEntryToolCallId,
	renameEntryIds,
	setExpandedValue,
	updateArgsPayload,
	updateArgsToolCallId,
	updateResultIsPartial,
	updateResultPayload,
	updateResultToolCallId,
} from "./host-surface";

const ADD_CHILD = "addChild" as const;
const MAX_DISCOVERY_DEPTH = 12;

function resolveMethod(
	value: object,
	name: string,
): ((...args: unknown[]) => unknown) | undefined {
	const method = (value as Record<string, unknown>)[name];
	return typeof method === "function"
		? (method as (...args: unknown[]) => unknown)
		: undefined;
}

export interface TranscriptCapabilities {
	readonly children: boolean;
	readonly addChild: boolean;
	readonly render: boolean;
	readonly renderViewport: boolean;
	readonly liveRowCount: boolean;
	readonly peekFinalizedBatch: boolean;
	readonly acknowledgeFinalizedBatch: boolean;
	readonly canRemoveBlock: boolean;
	readonly blockStates: boolean;
	/** Optional rebuild-phase capability: exact transcript `clear`. */
	readonly clear: boolean;
	/**
	 * Optional 18.0.6 capability: the complete-history replay entry point
	 * the terminal drives through `resetDisplay`.
	 */
	readonly peekReplayBatch: boolean;
}

export function transcriptCapabilities(value: unknown): TranscriptCapabilities {
	const candidate = objectRecord(value);
	return {
		children: Array.isArray(candidate.children),
		addChild: typeof candidate.addChild === "function",
		render: typeof candidate.render === "function",
		renderViewport: typeof candidate.renderViewport === "function",
		liveRowCount: typeof candidate.liveRowCount === "function",
		peekFinalizedBatch: typeof candidate.peekFinalizedBatch === "function",
		acknowledgeFinalizedBatch:
			typeof candidate.acknowledgeFinalizedBatch === "function",
		canRemoveBlock: typeof candidate.canRemoveBlock === "function",
		blockStates: typeof candidate.blockStates === "function",
		clear: typeof candidate.clear === "function",
		peekReplayBatch: typeof candidate.peekReplayBatch === "function",
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
		// LEAF_METHODS always seeds methods.render via the loop above.
		render: methods.render === true,
		methods,
	};
}

export function isTranscriptHost(value: unknown): value is TranscriptHost {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	// Short-circuit form of transcriptCapabilities critical keys. Optional
	// `clear` is intentionally omitted — same as the record-based check.
	return (
		Array.isArray(candidate.children) &&
		typeof candidate.addChild === "function" &&
		typeof candidate.render === "function" &&
		typeof candidate.renderViewport === "function" &&
		typeof candidate.liveRowCount === "function" &&
		typeof candidate.peekFinalizedBatch === "function" &&
		typeof candidate.acknowledgeFinalizedBatch === "function" &&
		typeof candidate.canRemoveBlock === "function" &&
		typeof candidate.blockStates === "function"
	);
}

/**
 * Version-pinned stats-carrier placement seam. Stats must sit before the
 * native terminal answer (or immediately after a bound block), so append-only
 * `addChild` is insufficient.
 *
 * Placement is identity-first when an anchor is supplied:
 * - `before` / `after` is re-resolved with `indexOf` immediately before the
 *   splice. A detached or cleared anchor is a hard miss — return false and
 *   leave the transcript untouched. Never invent a fallback index on a miss
 *   (appending at the end would put the row under the wrong answer or under
 *   a later run's content after a rebuild/clear).
 * - A bare numeric `index` remains for callers that already own a verified
 *   position (tests, capability probes). Bounds and mutability are still
 *   checked; any throw is swallowed so a host invariant never escalates into
 *   a session-wide compact rollback.
 */
export interface InsertTranscriptChildOptions {
	/** Insert immediately before this transcript child (identity re-checked). */
	readonly before?: unknown;
	/** Insert immediately after this transcript child (identity re-checked). */
	readonly after?: unknown;
}

export function insertTranscriptChildAt(
	transcript: unknown,
	index: number,
	child: unknown,
	options?: InsertTranscriptChildOptions,
): boolean {
	try {
		if (!isTranscriptHost(transcript)) return false;
		const children = transcript.children;
		if (
			!Array.isArray(children) ||
			!Object.isExtensible(children) ||
			Object.isSealed(children)
		)
			return false;

		let at = index;
		const before = options?.before;
		const after = options?.after;
		if (before !== undefined || after !== undefined) {
			// Exactly one anchor mode. Conflicting hints are a caller bug; fail
			// open rather than pick an arbitrary position.
			if (before !== undefined && after !== undefined) return false;
			if (before !== undefined) {
				const resolved = children.indexOf(before);
				if (resolved < 0) return false;
				at = resolved;
			} else {
				const resolved = children.indexOf(after as unknown);
				if (resolved < 0) return false;
				at = resolved + 1;
			}
		} else if (!Number.isSafeInteger(at) || at < 0 || at > children.length) {
			return false;
		}

		if (at < 0 || at > children.length) return false;
		children.splice(at, 0, child);
		return true;
	} catch {
		return false;
	}
}

/**
 * Pinned host adapter for stock OMP. Instance-scoped to the host root of
 * one session; all patching is exact-instance and transactional.
 *
 * `hostVersion` documents the verified critical-surface contract (see the
 * host-surface.ts module header). It is never read for dispatch — probes decide.
 */
export class StockHostAdapter {
	/**
	 * Verified host release for critical private surfaces (tool / read-group
	 * / transcript / TUI). Not a runtime minimum; marketplace floor stays
	 * independent release metadata. See host-surface.ts module header
	 * "Version story".
	 */
	static readonly hostVersion = "18.2.9";

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

	/**
	 * Full-tree transcript discovery (used by collectTranscriptCandidates).
	 * Visits every reachable children-bearing node; does NOT stop at first
	 * match, so callers can detect multiple transcript candidates and
	 * treat that as a hard failure. Contrast with `observeTree`, which
	 * stops at the first transcript and returns true.
	 */
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
	 * Build a wrapper descriptor for `addChild` that calls `onChildAdding`,
	 * then the original, then `onChildAdded`. Used by both transcript and
	 * discovery-container patching; observers must not throw (rollback policy
	 * is the caller's).
	 */
	#makeAddChildWrapper(
		original: (...args: unknown[]) => unknown,
		onChildAdded: (child: unknown) => void,
		onChildAdding?: (child: unknown) => void,
	): PropertyDescriptor {
		return {
			configurable: true,
			writable: true,
			value(this: object, child: unknown, ...rest: unknown[]): unknown {
				onChildAdding?.(child);
				const result = original.call(this, child, ...rest);
				onChildAdded(child);
				return result;
			},
		};
	}

	/**
	 * Exact-instance transcript `addChild` wrapper: calls `onChildAdding`,
	 * the original, then `onChildAdded(child)`.
	 *
	 * The pre-hook exists because the stock container captures a block's
	 * presentation mode inside `addChild` itself, so a declaration installed
	 * afterwards would arrive one step too late and the block would count as
	 * mutable for its whole life.
	 *
	 * Observers must not throw; rollback policy is the caller's. Throws
	 * (transactionally clean) when the transcript is unpatchable.
	 */
	patchAddChild(
		transcript: TranscriptHost,
		onChildAdded: (child: unknown) => void,
		onChildAdding?: (child: unknown) => void,
	): DescriptorPatch {
		if (!Object.isExtensible(transcript))
			throw new Error("unpatchable transcript");
		const original = resolveMethod(transcript, ADD_CHILD);
		if (!original) throw new Error("transcript addChild missing");
		const patch = new DescriptorPatch(transcript, [ADD_CHILD]);
		patch.install({
			[ADD_CHILD]: this.#makeAddChildWrapper(
				original,
				onChildAdded,
				onChildAdding,
			),
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

	/**
	 * Capability-checked insertion for plugin-owned terminal carriers.
	 * Delegates to the module-level `insertTranscriptChildAt` function;
	 * exposed as an instance method so callers can use the adapter as a
	 * single dependency surface without importing the free function.
	 * Prefer `before`/`after` identity anchors so a cleared transcript cannot
	 * land the carrier on a stale numeric index.
	 */
	insertTranscriptChildAt(
		transcript: unknown,
		index: number,
		child: unknown,
		options?: InsertTranscriptChildOptions,
	): boolean {
		return insertTranscriptChildAt(transcript, index, child, options);
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
			[ADD_CHILD]: this.#makeAddChildWrapper(original, onChildAdded),
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
