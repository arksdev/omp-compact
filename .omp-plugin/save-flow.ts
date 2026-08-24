import type {
	CompactHostSettings,
	CompactMode,
	CompactSettings,
	CompactSettingsStore,
} from "./config";

/** Host-configuration bridge seam (wired by HostSettingsBridge's slice). */
export interface HostBridgeLike {
	/**
	 * Persist host-facing toggles (set + flush) and return the outcome with
	 * a one-shot compensating rollback that restores the exact raw
	 * persistent pre-image of the changed host paths — never effective
	 * values, which project/runtime overrides can mask.
	 */
	apply(host: CompactHostSettings): Promise<HostBridgeApplyResult>;
}

/**
 * Structural slice of the real bridge's apply outcome: the restart
 * requirement plus a one-shot `rollback()` that restores the exact raw
 * persistent pre-image of the changed host paths (present -> raw value,
 * absent -> key removed) and flushes. No-op when the apply changed nothing;
 * throws when the restore itself cannot be persisted.
 */
export interface HostBridgeApplyResult {
	restartRequired: boolean;
	rollback(): Promise<void>;
}

export interface SaveFlowDeps {
	/** Optional host bridge; omitted when the host config surface is absent. */
	bridge?: HostBridgeLike;
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
 * Per-target serialization of save flows, modeled on `withUpdateQueue` in
 * config.ts: overlapping saves on one target run strictly in order, each
 * seeing the actual state after the previous save settled — including a
 * failed save's compensating rollback, which runs inside ITS queue turn.
 * Without this, two overlapping saves could interleave: the host bridge
 * coalesces concurrent applies (silently dropping the second payload), and
 * a failing save's rollback restores a pre-image that predates the other
 * save's already-successful write.
 *
 * Keyed by the store identity: the store is the per-plugin-instance save
 * pipeline, and each flow couples exactly one host apply to one store
 * update, so serializing per store also serializes the shared host config
 * target (two dialogs build their own bridge but share the store).
 */
const saveFlowQueues = new Map<CompactSettingsStore, Promise<void>>();

async function withSaveFlowQueue<T>(
	store: CompactSettingsStore,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = saveFlowQueues.get(store) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.catch(() => undefined).then(() => current);
	saveFlowQueues.set(store, tail);
	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		release();
		// Only the last queued operation cleans up the entry; earlier
		// operations find a newer tail and correctly skip the delete.
		if (saveFlowQueues.get(store) === tail) saveFlowQueues.delete(store);
	}
}

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
	/** The settings now on disk (the requested values; env is never baked in). */
	persisted: CompactSettings;
	/** The effective snapshot with hard env overrides reapplied. */
	effective: CompactSettings;
	/** Host bridge restart requirement. */
	restartRequired: boolean;
	/** True when a hard env override masks a persisted enabled/mode value. */
	masked: boolean;
	/** Per-field mask facts; empty when nothing is masked. */
	masks: ReadonlyArray<EnvMask>;
}

/**
 * Persist a settings save with strict ordering:
 *   1. host bridge apply (throws => store untouched, no success)
 *   2. store.update (throws => compensating rollback invokes the apply
 *      result's one-shot rollback, restoring the exact raw persistent
 *      pre-image of the changed host paths — never effective values, which
 *      overrides can mask — so the host side never diverges from the
 *      unchanged plugin JSON; then the original error is rethrown: no
 *      notify, no false success)
 *   3. exactly one success notification through notify(): the plain
 *      `omp-compact settings saved` for an unmasked save, or a single
 *      message carrying both facts (saved + effective) when a hard env
 *      override masks the just-persisted enabled/mode — never a separate
 *      warning plus a generic success
 *   4. when the host bridge reports restartRequired, notify honestly that a
 *      restart of OMP is required — no session reload is ever invoked
 *      (thinking visibility has no safe live refresh in stock).
 * Throws when either phase fails so the caller (dialog) surfaces the error
 * and keeps its unsaved state. Returns the structured persisted-versus-
 * effective outcome.
 *
 * Overlapping calls serialize per target (see {@link saveFlowQueues}): each
 * save runs to completion — bridge apply, JSON persist, and on failure its
 * compensating rollback — before the next one starts, so no call silently
 * loses its arguments to the bridge's concurrent-apply coalescing and a
 * failed save's rollback never restores a state that predates a newer
 * save's successful write.
 */
export async function saveSettingsFlow(
	next: CompactSettings,
	deps: SaveFlowDeps,
): Promise<SaveOutcome> {
	return withSaveFlowQueue(deps.store, () => runSaveSettingsFlow(next, deps));
}

async function runSaveSettingsFlow(
	next: CompactSettings,
	deps: SaveFlowDeps,
): Promise<SaveOutcome> {
	let restartRequired = false;
	let rollbackHost: (() => Promise<void>) | undefined;
	if (deps.bridge) {
		const result = await deps.bridge.apply(next.host);
		restartRequired = result.restartRequired === true;
		// Keep the compensating rollback tied to THIS save: it restores the
		// exact raw persistent pre-image the bridge captured before mutating
		// host config (see context/host-settings-rollback.md) — never
		// effective read() values, which overrides can mask.
		rollbackHost = result.rollback;
	}
	let effective: CompactSettings;
	try {
		effective = await deps.store.update(next);
	} catch (cause) {
		// Compensating rollback: the host bridge already applied AND flushed
		// the new host values, but the plugin JSON persist failed — the two
		// would diverge. Restore the host side through the apply result's
		// one-shot rollback (raw persistent pre-image + flush), then surface
		// the original save error.
		if (rollbackHost) {
			await rollbackHostAfterFailedSave(rollbackHost, cause, deps.notify);
		}
		throw cause;
	}
	const masks = maskedByEnv(deps.store, next, effective);
	const masked = masks.length > 0;
	deps.notify?.(
		"info",
		masked ? maskedSaveMessage(masks) : "omp-compact settings saved",
	);
	// The chord changed: the host offers no way to unregister the old shortcut,
	// so the new one only binds on the next start. Reuses the same honest
	// restart channel as thinking visibility rather than a second mechanism.
	const chordChanged =
		deps.previous !== undefined &&
		deps.previous.displayCycleKey !== next.displayCycleKey;
	if (restartRequired) {
		deps.notify?.("info", "Thinking blocks take effect after restarting OMP");
	}
	if (chordChanged) {
		deps.notify?.(
			"info",
			"The cycle shortcut takes effect after restarting OMP",
		);
	}
	return {
		persisted: next,
		effective,
		restartRequired: restartRequired || chordChanged,
		masked,
		masks,
	};
}

/**
 * Best-effort compensating rollback after a failed plugin-JSON persist:
 * invokes the apply result's one-shot rollback (restores the exact raw
 * persistent pre-image of the changed host paths and flushes). When the
 * rollback itself fails, warns honestly through notify() and lets the
 * original save error surface — mirroring the bridge's own rollback-failure
 * warn-once pattern (host-settings.ts).
 */
async function rollbackHostAfterFailedSave(
	rollback: () => Promise<void>,
	cause: unknown,
	notify?: SaveFlowDeps["notify"],
): Promise<void> {
	try {
		await rollback();
	} catch (rollbackCause) {
		notify?.(
			"warning",
			`Host settings could not be restored after the save failed (${cause instanceof Error ? cause.message : String(cause)}): ${rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)}`,
		);
	}
}

/**
 * Per-field env masks for the requested `enabled`/`mode` values on disk.
 * The store persists the requested values and returns the effective snapshot
 * with hard env overrides reapplied, so a difference in `enabled`/`mode`
 * means the saved JSON is currently overridden. Only the variables the store
 * reports as active are named — never inferred from the diff alone.
 */
function maskedByEnv(
	store: CompactSettingsStore,
	requested: CompactSettings,
	effective: CompactSettings,
): EnvMask[] {
	const masks: EnvMask[] = [];
	const overrides = store.overrides?.();
	if (requested.enabled !== effective.enabled) {
		const enabledBy = overrides?.enabledBy ?? [];
		if (enabledBy.length > 0) {
			masks.push({
				field: "enabled",
				effective: effective.enabled,
				by: [...enabledBy],
			});
		}
	}
	if (requested.mode !== effective.mode && overrides?.modeBy !== undefined) {
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
