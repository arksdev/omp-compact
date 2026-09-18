import type { DescriptorPatch } from "./patch-kit";
import type { ExpandObservedState, UserExecutionObservedState } from "./render";

/**
 * Owns the exact-instance descriptor-patch registries `RuntimeAdapter`
 * installs on host components — the per-component render/method wraps, the
 * transcript addChild/clear wrappers and the discovery tree-watcher
 * container patches — plus their restore/clear teardown.
 *
 * Two teardown scopes exist, deliberately:
 * - `restorePerComponent()` is the detach scope (`#detachPresentation`):
 *   every per-component patch is restored to native and cleared so strong
 *   references to retired component instances are released. The
 *   transcript's own addChild/clear patches survive — they define the
 *   rebuild boundary.
 * - `restoreTranscript()` is dispose-only: the transcript wrappers are
 *   recorded for dispose so a failing clear probe still rolls the adapter
 *   back transactionally. `restoreDiscovery()` likewise undoes the
 *   fail-closed discovery tree watcher, and is also called when a
 *   transcript is found (the watcher's job is done).
 *
 * The per-component restore used to live in two near-identical loops
 * (dispose and detach), so a seventh patch kind meant editing both, and
 * forgetting one leaked patched components across a rebuild. It now runs
 * from exactly one `#perComponentPatches` list shared by both teardown
 * paths: a new kind is a new field plus one entry in that list.
 */
export class PresentationPatches {
	/** Exact-instance tool/read-group component patches (fold-owned blocks). */
	readonly components = new Map<object, DescriptorPatch>();
	/** Exact-instance TTSR notification render overrides (not fold-owned). */
	readonly ttsr = new Map<object, DescriptorPatch>();
	/** Exact-instance todo-reminder render overrides (not fold-owned). */
	readonly todoReminder = new Map<object, DescriptorPatch>();
	/**
	 * Exact-instance user bash/python execution overrides (not fold-owned).
	 * Tracks observed setComplete/setExpanded state because exit codes live
	 * in private fields on the stock components.
	 */
	readonly userExecution = new Map<object, DescriptorPatch>();
	readonly userExecutionState = new WeakMap<
		object,
		UserExecutionObservedState
	>();
	/** Exact-instance skill-prompt render overrides (not fold-owned). */
	readonly skill = new Map<object, DescriptorPatch>();
	readonly skillExpandState = new WeakMap<object, ExpandObservedState>();
	/** Exact-instance late-diagnostics render overrides (not fold-owned). */
	readonly lateDiagnostics = new Map<object, DescriptorPatch>();
	/** Exact-instance advisor render overrides, deliberately not fold-owned. */
	readonly advisor = new Map<object, DescriptorPatch>();
	readonly lateDiagnosticsExpandState = new WeakMap<
		object,
		ExpandObservedState
	>();
	/** Exact-instance discovery container patches (fail-closed tree watcher). */
	readonly discovery = new Map<object, DescriptorPatch>();
	/** Exact-instance transcript patches (addChild observer + clear boundary). */
	readonly transcript: DescriptorPatch[] = [];
	/** The per-component scope, restored by both teardown paths. */
	#perComponentPatches: readonly Map<object, DescriptorPatch>[] = [
		this.components,
		this.ttsr,
		this.todoReminder,
		this.userExecution,
		this.skill,
		this.lateDiagnostics,
		this.advisor,
	];

	/** Restore and clear every per-component registry (detach and dispose). */
	restorePerComponent(): void {
		for (const patches of this.#perComponentPatches) {
			for (const patch of patches.values()) patch.restore();
			patches.clear();
		}
	}

	/** Restore and clear the transcript addChild/clear wrappers (dispose only). */
	restoreTranscript(): void {
		for (const patch of this.transcript) patch.restore();
		this.transcript.length = 0;
	}

	/** Restore and clear the discovery container patches (dispose only). */
	restoreDiscovery(): void {
		for (const patch of this.discovery.values()) patch.restore();
		this.discovery.clear();
	}
}

/**
 * Resolve a callable instance method through the prototype chain. Stock
 * `BashExecutionComponent` overrides `render` on its own class;
 * `EvalExecutionComponent` does not and inherits `Container.render`
 * several levels up. A one-level own-then-prototype lookup would miss
 * eval, so we walk until we find a function value (never patching a
 * shared prototype — only capturing the function to wrap as an own
 * instance property). TTSR / todo-reminder also use this walk; for those
 * surfaces it is a pure superset of the former one-level lookup.
 */
export function resolveInstanceMethod(
	component: object,
	name: string,
): ((...args: never[]) => unknown) | undefined {
	let current: object | null = component;
	while (current && current !== Object.prototype) {
		const descriptor = Object.getOwnPropertyDescriptor(current, name);
		if (typeof descriptor?.value === "function") {
			return descriptor.value as (...args: never[]) => unknown;
		}
		current = Object.getPrototypeOf(current) as object | null;
	}
	return undefined;
}
