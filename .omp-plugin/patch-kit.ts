/**
 * B01: transactional per-instance descriptor patch kit.
 *
 * Every host adaptation in the plugin replaces methods on a *specific
 * instance* (never a prototype or shared shape) by capturing the original
 * own-property descriptors, defining configurable wrappers, and restoring
 * the captured descriptors on rollback. This module is the single
 * implementation of that transaction so runtime-adapter.ts and
 * transcript-fold.ts share exactly-once restore and idempotent rollback.
 *
 * Contract:
 * - `DescriptorPatch` captures descriptors for the given names at
 *   construction time (before any wrapper is installed). Duplicate names are
 *   deduped keeping first-seen order.
 * - `install(wrappers)` defines one wrapper per captured name, in capture
 *   order. It is transactional: when the N-th `defineProperty` throws, the
 *   wrappers defined before it are restored and the original error is
 *   rethrown; the patch is left clean and a later `restore()` is a no-op.
 *   A second `install()` on an already-installed patch throws and leaves the
 *   installed wrappers untouched (symmetric with the restored guard).
 * - `restore()` restores every installed wrapper's captured descriptor and
 *   is idempotent — the second call (or a call after a failed `install`)
 *   does nothing. A single stubborn descriptor never aborts the rest of the
 *   rollback.
 */

export function restoreDescriptor(
	target: object,
	name: string,
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor) Object.defineProperty(target, name, descriptor);
	else Reflect.deleteProperty(target, name);
}

export function restoreDescriptorSafely(
	target: object,
	name: string,
	descriptor: PropertyDescriptor | undefined,
): void {
	try {
		restoreDescriptor(target, name, descriptor);
	} catch {
		// A single stubborn descriptor must not abort the rest of the rollback.
	}
}

function captureDescriptors(
	target: object,
	names: readonly string[],
): Map<string, PropertyDescriptor | undefined> {
	const descriptors = new Map<string, PropertyDescriptor | undefined>();
	for (const name of names)
		descriptors.set(name, Object.getOwnPropertyDescriptor(target, name));
	return descriptors;
}

export class DescriptorPatch {
	readonly target: object;
	readonly names: readonly string[];
	readonly #captured: ReadonlyMap<string, PropertyDescriptor | undefined>;
	#installedNames: string[] = [];
	#restored = false;

	constructor(target: object, names: readonly string[]) {
		this.target = target;
		// Duplicate capture names are deduped keeping first-seen order, so
		// install/restore process each descriptor exactly once.
		this.names = [...new Set(names)];
		this.#captured = captureDescriptors(target, this.names);
	}

	get installed(): boolean {
		return this.#installedNames.length > 0 && !this.#restored;
	}

	install(wrappers: Record<string, PropertyDescriptor>): void {
		if (this.#restored) throw new Error("DescriptorPatch already restored");
		// Symmetric with the restored guard: a second install on an active
		// patch must never silently replace the installed wrappers.
		if (this.installed) throw new Error("DescriptorPatch already installed");
		const defined: string[] = [];
		try {
			for (const name of this.names) {
				const wrapper = wrappers[name];
				if (!wrapper) throw new Error(`no wrapper captured for "${name}"`);
				Object.defineProperty(this.target, name, wrapper);
				defined.push(name);
			}
		} catch (error) {
			for (const name of defined)
				restoreDescriptorSafely(this.target, name, this.#captured.get(name));
			this.#installedNames = [];
			throw error;
		}
		this.#installedNames = defined;
	}

	restore(): void {
		if (this.#restored) return;
		for (const name of this.#installedNames)
			restoreDescriptorSafely(this.target, name, this.#captured.get(name));
		this.#installedNames = [];
		this.#restored = true;
	}
}
