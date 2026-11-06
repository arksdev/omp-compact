import type {
	CompactMode,
	CompactSettings,
	CompactSettingsStore,
} from "./config";
import { createKeyedQueue } from "./keyed-queue";

export interface SaveFlowDeps {
	store: CompactSettingsStore;
	/**
	 * Settings as they were before this save, when the caller knows them. Used
	 * only to notice a changed display-cycle chord: the host cannot unregister
	 * a shortcut, so a new chord starts working only after a restart, and the
	 * user has to be told. Omitted by callers that change no chord.
	 */
	previous?: CompactSettings;
	notify?(level: "info" | "warning", message: string): void;
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
	/** True when the save changed the cycle chord, which needs a restart. */
	restartRequired: boolean;
	/** True when a hard env override masks a persisted enabled/mode value. */
	masked: boolean;
	/** Per-field mask facts; empty when nothing is masked. */
	masks: ReadonlyArray<EnvMask>;
}

/**
 * Persist a settings save and report it once:
 *   1. store.update (throws => no notification, the caller surfaces the
 *      error and keeps its unsaved state)
 *   2. exactly one success notification through notify(): the plain
 *      `omp-compact settings saved` for an unmasked save, or a single
 *      message carrying both facts (saved + effective) when a hard env
 *      override masks the just-persisted enabled/mode — never a separate
 *      warning plus a generic success
 *   3. when the cycle chord changed, an honest note that it binds after a
 *      restart of OMP.
 *
 * `next` may be a function of the current settings; it then runs inside the
 * store's queue turn (see {@link withSaveFlowQueue}).
 */
export async function saveSettingsFlow(
	next: CompactSettings | ((current: CompactSettings) => CompactSettings),
	deps: SaveFlowDeps,
): Promise<SaveOutcome> {
	return withSaveFlowQueue(deps.store, async () =>
		runSaveSettingsFlow(
			typeof next === "function" ? next(await deps.store.load()) : next,
			deps,
		),
	);
}

async function runSaveSettingsFlow(
	next: CompactSettings,
	deps: SaveFlowDeps,
): Promise<SaveOutcome> {
	const effective = await deps.store.update(next);
	const onDisk = deps.store.persistedSnapshot?.() ?? next;
	const masks = maskedByEnv(onDisk, deps.store, effective);
	const masked = masks.length > 0;
	deps.notify?.(
		"info",
		masked ? maskedSaveMessage(masks) : "omp-compact settings saved",
	);
	// The chord changed: the host offers no way to unregister the old shortcut,
	// so the new one only binds on the next start.
	const chordChanged =
		deps.previous !== undefined &&
		deps.previous.displayCycleKey !== next.displayCycleKey;
	if (chordChanged) {
		deps.notify?.(
			"info",
			"The cycle shortcut takes effect after restarting OMP",
		);
	}
	return {
		persisted: onDisk,
		effective,
		restartRequired: chordChanged,
		masked,
		masks,
	};
}

/**
 * Per-field env masks for the `enabled`/`mode` values now on disk.
 * The baseline is `onDisk` — the store's PERSISTED layer, not the values the
 * caller requested: the dialog is seeded from the effective snapshot, so a
 * masked field arrives already carrying the forced value and the store
 * deliberately does not persist that echo (`omitEnvEchoes` in config.ts).
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
