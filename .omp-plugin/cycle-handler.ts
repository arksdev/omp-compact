import type { CompactSettingsStore } from "./config";

import {
	type CycleTheme,
	formatDisplayCycleStatus,
	formatPinnedCycleStatus,
	nextDisplayCycleState,
} from "./display-cycle";

import { type SaveOutcome, saveSettingsFlow } from "./save-flow";

export interface DisplayCycleDeps {
	/** Same store the settings dialog saves through. */
	store: CompactSettingsStore;
	theme: CycleTheme;
	/** Ephemeral status sink (`ctx.ui.notify`). */
	notify(level: "info" | "warning", message: string): void;
}

/**
 * Handle one keypress: read the current settings, take one cycle step, and
 * persist through the shared save flow — never a direct file write, so the
 * keypress inherits the dialog's serialization and env-mask reporting.
 *
 * The flow's own success notification is suppressed here: a keypress reports
 * the one status line the user asked for, not the dialog's "settings saved".
 * A masked save (a hard `OMP_COMPACT_PLUGIN` / `OMP_COMPACT_MODE` override) is
 * reported as the effective state instead of the requested one, so the key
 * never claims a change the environment forbids.
 */
export async function cycleDisplayState(deps: DisplayCycleDeps): Promise<void> {
	let outcome: SaveOutcome;
	try {
		outcome = await saveSettingsFlow(
			(current) => {
				const next = nextDisplayCycleState(current);
				return { ...current, enabled: next.enabled, mode: next.mode };
			},
			// The flow's success line would duplicate the status line below.
			{ store: deps.store },
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
			: formatDisplayCycleStatus(outcome.persisted, deps.theme),
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
