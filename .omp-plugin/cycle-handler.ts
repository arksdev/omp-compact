import type { CompactSettingsStore } from "./config";

import {
	type CycleTheme,
	formatDisplayCycleStatus,
	formatPinnedCycleStatus,
	nextDisplayCycleState,
} from "./display-cycle";

import type { HostBridgeLike } from "./save-flow";

import { type SaveOutcome, saveSettingsFlow } from "./save-flow";

export interface DisplayCycleDeps {
	/** Same store the settings dialog saves through. */
	store: CompactSettingsStore;
	/** Host bridge, when a live host settings instance exists. */
	bridge?: HostBridgeLike;
	theme: CycleTheme;
	/** Ephemeral status sink (`ctx.ui.notify`). */
	notify(level: "info" | "warning", message: string): void;
}

/**
 * Handle one keypress: read the current settings, take one cycle step, and
 * persist through the shared save flow — never a direct file write, so the
 * keypress inherits the dialog's serialization, host-bridge ordering and
 * env-mask reporting for free.
 *
 * The flow's own success notification is suppressed here: a keypress reports
 * the one status line the user asked for, not the dialog's "settings saved".
 * A masked save (a hard `OMP_COMPACT_PLUGIN` / `OMP_COMPACT_MODE` override) is
 * reported as the effective state instead of the requested one, so the key
 * never claims a change the environment forbids.
 */
export async function cycleDisplayState(deps: DisplayCycleDeps): Promise<void> {
	const current = await deps.store.load();
	const next = nextDisplayCycleState(current);
	let outcome: SaveOutcome;
	try {
		outcome = await saveSettingsFlow(
			{ ...current, enabled: next.enabled, mode: next.mode },
			{
				bridge: deps.bridge,
				store: deps.store,
				// The flow's success line would duplicate the status line below;
				// only its failure warnings (a host rollback that could not be
				// restored) are worth surfacing.
				notify: (level, message) => {
					if (level === "warning") deps.notify(level, message);
				},
			},
		);
	} catch (error) {
		deps.notify(
			"warning",
			`omp-compact could not switch the display: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	const pinned = pinnedVariables(outcome);
	deps.notify(
		"info",
		pinned.length > 0
			? formatPinnedCycleStatus(
					{ enabled: outcome.effective.enabled, mode: outcome.effective.mode },
					pinned,
					deps.theme,
				)
			: formatDisplayCycleStatus(next, deps.theme),
	);
}

/**
 * Env variables that masked this save, in mask order and without duplicates:
 * `OMP_COMPACT_MODE=off` masks `enabled` and `mode` at once, and naming it
 * twice in one line reads like a bug.
 */
function pinnedVariables(outcome: SaveOutcome): string[] {
	const names: string[] = [];
	for (const mask of outcome.masks) {
		for (const name of mask.by) {
			if (!names.includes(name)) names.push(name);
		}
	}
	return names;
}
