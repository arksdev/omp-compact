import type {
	CompactMode,
	CompactSettings,
	CompactSettingsStore,
} from "./config";
import { createKeyedQueue } from "./keyed-queue";

export interface SaveFlowDeps {
	store: CompactSettingsStore;
	/**
	 * The save is the user's own edit of the settings on disk (the settings
	 * dialog): a functional `next` runs on `store.persistedSnapshot()`, and
	 * the store keeps a value even when it equals a hard env override.
	 * Without it, `next` runs on the effective snapshot and the store drops
	 * such values as echoes of that snapshot.
	 */
	explicit?: boolean;
}

/**
 * Per-store serialization of save flows, modeled on `withUpdateQueue` in
 * config.ts: overlapping saves run strictly in order, each computing its
 * next state from the settings the previous save left behind. The display
 * cycle depends on this: two quick keypresses must advance two steps, not
 * both save the step after the same snapshot.
 */
const withSaveFlowQueue = createKeyedQueue<CompactSettingsStore>();

/**
 * One persisted setting that a hard env override currently masks: the JSON
 * carries the requested value, but `effective` stays in force instead.
 */
export interface EnvMask {
	/** The persisted setting field that cannot take effect. */
	field: "enabled" | "mode";
	/** The value that stays in effect instead of the persisted one. */
	effective: boolean | CompactMode;
	/** Env variables forcing the field (both when enabled is double-masked). */
	by: ReadonlyArray<"OMP_COMPACT_PLUGIN" | "OMP_COMPACT_MODE">;
}

/**
 * Structured outcome of a settings save: what was persisted versus what
 * actually takes effect. Consumers compose their own presentation from the
 * facts; `masks` is empty for an unmasked save.
 */
export interface SaveOutcome {
	/**
	 * The settings now on disk: the requested values minus anything a hard
	 * env override forced (env is never baked in — see `omitEnvEchoes` in
	 * config.ts). Stores without a persisted seam report the request.
	 */
	persisted: CompactSettings;
	/** The effective snapshot with hard env overrides reapplied. */
	effective: CompactSettings;
	/** True when a hard env override masks a persisted enabled/mode value. */
	masked: boolean;
	/** Per-field mask facts; empty when nothing is masked. */
	masks: ReadonlyArray<EnvMask>;
}

/**
 * Persist a settings save: store.update, then the facts of what landed on
 * disk and what an env override keeps in force. Throws when store.update
 * throws. Reporting is the caller's: the settings dialog reports a whole
 * session once through {@link notifySaveOutcome}, the display cycle prints
 * its own status line.
 *
 * `next` may be a function of the current settings; it then runs inside the
 * store's queue turn (see {@link withSaveFlowQueue}).
 */
export async function saveSettingsFlow(
	next: CompactSettings | ((current: CompactSettings) => CompactSettings),
	deps: SaveFlowDeps,
): Promise<SaveOutcome> {
	const { store } = deps;
	return withSaveFlowQueue(store, async () => {
		if (typeof next !== "function") {
			return runSaveSettingsFlow(next, store, deps.explicit === true);
		}
		const effective = await store.load();
		// A store without a persisted layer only offers the effective
		// snapshot, whose env echoes must still be stripped.
		const persisted = deps.explicit ? store.persistedSnapshot?.() : undefined;
		return runSaveSettingsFlow(
			next(persisted ?? effective),
			store,
			persisted !== undefined,
		);
	});
}

async function runSaveSettingsFlow(
	next: CompactSettings,
	store: CompactSettingsStore,
	explicit: boolean,
): Promise<SaveOutcome> {
	const effective = await store.update(next, { explicit });
	const onDisk = store.persistedSnapshot?.() ?? next;
	const masks = maskedByEnv(onDisk, store, effective);
	return { persisted: onDisk, effective, masked: masks.length > 0, masks };
}

/**
 * Report saved settings once:
 *   1. exactly one success notification: the plain `omp-compact settings
 *      saved` for an unmasked save, or a single message carrying both facts
 *      (saved + effective) when a hard env override masks the persisted
 *      enabled/mode — never a separate warning plus a generic success
 *   2. when the cycle chord differs from the one in `before`, an honest note
 *      that it binds after a restart of OMP: the host offers no way to
 *      unregister the old shortcut, so the new one only binds on the next
 *      start.
 *
 * `outcome` is the last save of the session, so it carries the final state
 * on disk; `before` is the settings the session started from.
 */
export function notifySaveOutcome(
	outcome: SaveOutcome,
	before: CompactSettings,
	notify: (level: "info" | "warning", message: string) => void,
): void {
	notify(
		"info",
		outcome.masked
			? maskedSaveMessage(outcome.masks)
			: "omp-compact settings saved",
	);
	if (outcome.persisted.displayCycleKey !== before.displayCycleKey) {
		notify("info", "The cycle shortcut takes effect after restarting OMP");
	}
}

/**
 * Per-field env masks for the `enabled`/`mode` values now on disk.
 * The baseline is `onDisk` — the store's PERSISTED layer, not the values the
 * caller requested: a save built from the effective snapshot (the display
 * cycle's) arrives with a masked field already carrying the forced value,
 * and the store deliberately does not persist that echo (`omitEnvEchoes` in
 * config.ts).
 * Comparing against the request would then find no difference and stay
 * silent in exactly the case the user needs to hear about. Only the
 * variables the store reports as active are named — never inferred from the
 * diff alone.
 */
function maskedByEnv(
	onDisk: CompactSettings,
	store: CompactSettingsStore,
	effective: CompactSettings,
): EnvMask[] {
	const masks: EnvMask[] = [];
	const overrides = store.overrides?.();
	if (onDisk.enabled !== effective.enabled) {
		const enabledBy = overrides?.enabledBy ?? [];
		if (enabledBy.length > 0) {
			masks.push({
				field: "enabled",
				effective: effective.enabled,
				by: [...enabledBy],
			});
		}
	}
	if (onDisk.mode !== effective.mode && overrides?.modeBy !== undefined) {
		masks.push({
			field: "mode",
			effective: effective.mode,
			by: [overrides.modeBy],
		});
	}
	return masks;
}

/**
 * One unambiguous success notification for a masked save: the plain success
 * line plus, per masked field, the effective value that stays in force and
 * the env variable(s) forcing it — the user is never left with a generic
 * success implying the saved value took effect. Values render as the env
 * contract names them (`OMP_COMPACT_PLUGIN=0`, legacy `OMP_COMPACT_MODE=off`,
 * and `OMP_COMPACT_MODE=<effective mode>`).
 */
function maskedSaveMessage(masks: readonly EnvMask[]): string {
	const facts = masks.map((mask) => {
		const value =
			mask.field === "enabled"
				? mask.effective
					? "true"
					: "false"
				: String(mask.effective);
		const by = mask.by
			.map((name) => {
				if (name === "OMP_COMPACT_PLUGIN") return "OMP_COMPACT_PLUGIN=0";
				if (mask.field === "enabled") return "OMP_COMPACT_MODE=off";
				return `OMP_COMPACT_MODE=${value}`;
			})
			.join(" / ");
		return `effective ${mask.field} remains ${value} because ${by}`;
	});
	return `omp-compact settings saved; ${facts.join("; ")}`;
}
