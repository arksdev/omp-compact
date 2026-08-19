/**
 * B02: pinned OMP host capability adapter.
 *
 * Single module tree for every private host shape, method name and
 * argument-position mapping the plugin knows about:
 * - transcript container surface (`children`, `addChild`, `clear`,
 *   render/live-region methods);
 * - tool execution component and read group surfaces;
 * - transcript block fold surface (native render/version/seal methods);
 * - exact TUI surface (optional `resetDisplay` for rebuild);
 * - optional leaf fingerprints (TTSR, todo reminder, skill, late
 *   diagnostics, user bash/eval execution).
 *
 * ## Version story (do not "fix" the apparent skew)
 *
 * `HostAdapter1731.hostVersion` (`"17.3.1"`) is the **verified contract**
 * this module was written and tested against for the critical private
 * surfaces (tool/read-group/transcript/TUI method names and argument
 * positions). Comments that cite 17.3.4 mark leaf fingerprints whose
 * shapes were confirmed against that newer host (todo reminder, skill,
 * late diagnostics, user bash/eval). Neither string is a runtime gate:
 * every decision is a capability probe on the live instance.
 *
 * `marketplace.json` still advertises the public floor `OMP 17.2.12+`.
 * That floor is release metadata (oldest host whose *critical* private
 * signatures were believed to match when the floor was set). It is **not**
 * re-validated here and must not be silently raised from this file.
 *
 * Local cache check (this workstation): `@oh-my-pi/pi-coding-agent@17.2.12`,
 * `17.3.1`, and `17.3.4` are all present under the bun install cache.
 * Activity-gated leaves (`setToolActivityVisible`) exist on 17.3.1/17.3.4
 * TTSR, todo-reminder, and late-diagnostics components, and are **absent**
 * on the same files in 17.2.12. Fingerprints that require that method
 * therefore miss cleanly on 17.2.12 and leave the stock card native —
 * they do not misclassify into tool/read-group paths. User bash/eval and
 * skill-card fingerprints do not require the activity method and match
 * the 17.2.12 public surfaces when those components appear; their compact
 * rows still fail open to native when content extraction fails.
 *
 * Honest summary: critical tool/read-group/transcript compaction is
 * capability-probed and intended to work from the declared floor upward;
 * the optional inject/reminder/diagnostics compact chrome is **verified**
 * against 17.3.1/17.3.4 and **unverified** (native via probe miss) below
 * 17.3.1. Raising the marketplace floor is a release decision, not an
 * adapter edit.
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

/** OMP 17.3.1 tool execution component surface. */
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

/** OMP 17.3.1 read group component surface. */
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
 * OMP 17.3.1 transcript block fold surface. All optional: the fold reads
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
 * Stock TTSR notification fingerprint (OMP 17.3.1 `TtsrNotificationComponent`):
 * `addRules` + expand/activity controls, without the tool execution surface.
 * Todo reminders share `setToolActivityVisible` but never expose `addRules`.
 */
export function isTtsrNotificationComponent(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.render !== "function") return false;
	if (typeof candidate.addRules !== "function") return false;
	if (typeof candidate.setExpanded !== "function") return false;
	if (typeof candidate.setToolActivityVisible !== "function") return false;
	// Tool leaves also expose setToolActivityVisible; the call surface is the
	// discriminator so a future host method mix-in cannot misclassify a tool.
	if (typeof candidate.updateArgs === "function") return false;
	if (typeof candidate.updateResult === "function") return false;
	return true;
}

/**
 * Stock todo-reminder fingerprint (OMP 17.3.4 `TodoReminderComponent`):
 * activity visibility + render only. Rejects TTSR (`addRules`/`setExpanded`/
 * `isExpanded`), tool leaves, and read groups so only the yellow incomplete-
 * todo card is matched among those surfaces. Note: `StrippedToolCallsPlaceholder`
 * collides on methods alone; `#patchTodoReminder` contains that by probing
 * `todoReminderFromComponent` before any DescriptorPatch install.
 */
export function isTodoReminderComponent(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.render !== "function") return false;
	if (typeof candidate.setToolActivityVisible !== "function") return false;
	// TTSR and late-diagnostics expose expand controls; tools expose the
	// execution surface. Any of those means this is not a todo reminder.
	if (typeof candidate.addRules === "function") return false;
	if (typeof candidate.setExpanded === "function") return false;
	if (typeof candidate.isExpanded === "function") return false;
	if (typeof candidate.updateArgs === "function") return false;
	if (typeof candidate.updateResult === "function") return false;
	if (typeof candidate.setArgsComplete === "function") return false;
	if (typeof candidate.seal === "function") return false;
	if (typeof candidate.removeEntry === "function") return false;
	if (typeof candidate.renameEntry === "function") return false;
	return true;
}

/**
 * Shared public surface of stock user-initiated bash/eval execution blocks
 * (OMP 17.3.4 `BashExecutionComponent` / `EvalExecutionComponent`): streaming
 * output + completion + transcript finalization + expand. Neither leaf exposes
 * the tool/TTSR/todo activity surfaces; those rejects keep the fingerprints
 * out of the tool/read-group/inject/reminder paths.
 */
function hasUserExecutionSurface(candidate: Record<string, unknown>): boolean {
	if (typeof candidate.render !== "function") return false;
	if (typeof candidate.appendOutput !== "function") return false;
	if (typeof candidate.setComplete !== "function") return false;
	if (typeof candidate.isTranscriptBlockFinalized !== "function") return false;
	if (typeof candidate.getOutput !== "function") return false;
	if (typeof candidate.setExpanded !== "function") return false;
	// Tool / TTSR / todo activity controls never appear on user executions.
	if (typeof candidate.updateArgs === "function") return false;
	if (typeof candidate.updateResult === "function") return false;
	if (typeof candidate.setArgsComplete === "function") return false;
	if (typeof candidate.seal === "function") return false;
	if (typeof candidate.addRules === "function") return false;
	if (typeof candidate.setToolActivityVisible === "function") return false;
	if (typeof candidate.renameEntry === "function") return false;
	if (typeof candidate.removeEntry === "function") return false;
	return true;
}

/**
 * Stock user bash execution fingerprint (`!` / `!!` → `BashExecutionComponent`):
 * shared execution surface + `getCommand`, without `getCode`. Host components
 * under `src/modes/components/` were checked: only `bash-execution.ts` exposes
 * `appendOutput`+`setComplete`+`getCommand`; no other leaf collides.
 */
export function isBashExecutionComponent(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (!hasUserExecutionSurface(candidate)) return false;
	if (typeof candidate.getCommand !== "function") return false;
	// Eval uses getCode; mutual exclusion keeps the two paths distinct.
	if (typeof candidate.getCode === "function") return false;
	return true;
}

/**
 * Stock user eval/python execution fingerprint (`$` / `$$` →
 * `EvalExecutionComponent`, transcript role `pythonExecution`): shared
 * execution surface + `getCode`, without `getCommand`. Host scan: only
 * `eval-execution.ts` exposes `appendOutput`+`setComplete`+`getCode`.
 */
export function isEvalExecutionComponent(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (!hasUserExecutionSurface(candidate)) return false;
	if (typeof candidate.getCode !== "function") return false;
	if (typeof candidate.getCommand === "function") return false;
	return true;
}

/**
 * Stock skill card fingerprint (OMP 17.3.4 `SkillMessageComponent`):
 * expand + render, with the host parameter-property `message` carrying
 * `customType === "skill-prompt"` (session/messages.ts:42,
 * `SKILL_PROMPT_MESSAGE_TYPE`). TS `private readonly message` is a runtime
 * own field — same seam as `isCompactCustomMessage`. Rejects tool/TTSR/
 * activity surfaces so a method mix-in cannot misclassify those leaves.
 */
export function isSkillMessageComponent(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.render !== "function") return false;
	if (typeof candidate.setExpanded !== "function") return false;
	// Tools / TTSR / late-diagnostics / todo activity never appear on skill.
	if (typeof candidate.setToolActivityVisible === "function") return false;
	if (typeof candidate.addRules === "function") return false;
	if (typeof candidate.updateArgs === "function") return false;
	if (typeof candidate.updateResult === "function") return false;
	if (typeof candidate.setArgsComplete === "function") return false;
	if (typeof candidate.seal === "function") return false;
	if (typeof candidate.removeEntry === "function") return false;
	if (typeof candidate.renameEntry === "function") return false;
	const message = objectRecord(candidate.message);
	// Pin literal to OMP 17.3.4 session/messages.ts:42 SKILL_PROMPT_MESSAGE_TYPE.
	return message.customType === "skill-prompt";
}

/**
 * Stock late-LSP-diagnostics fingerprint (OMP 17.3.4
 * `LateDiagnosticsMessageComponent`): expand + activity + render, with the
 * host parameter-property `files` array (late-diagnostics-message.ts:21).
 * The transcript message's customType `"lsp-late-diagnostic"`
 * (session/messages.ts:43) is NOT retained on the component — only `files`.
 * Rejects tool/TTSR execution surfaces; `ToolActivityContainer` collides on
 * methods but never exposes `files`.
 */
export function isLateDiagnosticsMessageComponent(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.render !== "function") return false;
	if (typeof candidate.setExpanded !== "function") return false;
	if (typeof candidate.setToolActivityVisible !== "function") return false;
	if (!Array.isArray(candidate.files)) return false;
	// Tool / TTSR / read-group execution surface.
	if (typeof candidate.addRules === "function") return false;
	if (typeof candidate.updateArgs === "function") return false;
	if (typeof candidate.updateResult === "function") return false;
	if (typeof candidate.setArgsComplete === "function") return false;
	if (typeof candidate.seal === "function") return false;
	if (typeof candidate.removeEntry === "function") return false;
	if (typeof candidate.renameEntry === "function") return false;
	return true;
}

/**
 * OMP 17.3.1 argument positions. `updateArgs` carries
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
 * Pinned host adapter for stock OMP. Instance-scoped to the host root of
 * one session; all patching is exact-instance and transactional.
 *
 * `hostVersion` documents the verified critical-surface contract (see the
 * module header). It is never read for dispatch — probes decide.
 */
export class HostAdapter1731 {
	/**
	 * Verified host release for critical private surfaces (tool / read-group
	 * / transcript / TUI). Not a runtime minimum; marketplace floor stays
	 * independent release metadata. See module header "Version story".
	 */
	static readonly hostVersion = "17.3.1";

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
	 * Build a wrapper descriptor for `addChild` that calls the original
	 * then `onChildAdded`. Used by both transcript and discovery-container
	 * patching; the observer must not throw (rollback policy is the caller's).
	 */
	#makeAddChildWrapper(
		original: (...args: unknown[]) => unknown,
		onChildAdded: (child: unknown) => void,
	): PropertyDescriptor {
		return {
			configurable: true,
			writable: true,
			value(this: object, child: unknown, ...rest: unknown[]): unknown {
				const result = original.call(this, child, ...rest);
				onChildAdded(child);
				return result;
			},
		};
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
			[ADD_CHILD]: this.#makeAddChildWrapper(original, onChildAdded),
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
