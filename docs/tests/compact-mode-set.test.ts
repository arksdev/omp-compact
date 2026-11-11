import { beforeAll, describe, expect, test } from "bun:test";
import { ensureThemeSync } from "@oh-my-pi/pi-coding-agent";

import {
	type CompactMode,
	type CompactSettings,
	DEFAULT_SETTINGS,
} from "../../.omp-plugin/config";
import { settingsDialogHost } from "../../.omp-plugin/host-modules";
import { SettingsDialog } from "../../.omp-plugin/settings-dialog";

const host =
	settingsDialogHost ??
	((): never => {
		throw new Error("omp's settings-list chrome did not load");
	})();

/**
 * CompactMode is a hand-maintained string union whose members are enumerated
 * again by hand at the sites below. None of them is a checked `switch` (the
 * mode dispatches are equality predicates, and `readonly CompactMode[]` is
 * satisfied by a shorter array), so a fourth member added to the union but
 * forgotten at one site compiles clean and degrades silently:
 *
 *   - config.ts:117 isCompactMode guard — a forgotten member is rejected
 *     by config normalization (warned at config.ts:423-425) and the
 *     `OMP_COMPACT_MODE` env override is ignored without a word
 *     (config.ts:680-682, 835).
 *   - display-cycle.ts:36-39 nextDisplayCycleState chain — a forgotten
 *     member falls through into the terminal `off` branch, so the cycle
 *     shortcut turns the plugin off instead of stepping into the new mode.
 *   - settings-dialog.ts MODES — the mode row's values. The row cycles
 *     through them and the change for a value outside them is dropped, so
 *     a forgotten member is silently unselectable and unreachable — the
 *     defect this suite guards.
 *   - render-decision.ts 174, 214, 229, 245, 331, 386, 395 —
 *     `mode === "compact"/"live"/"clear"` predicates; a forgotten member
 *     matches no rule and inherits the fallback presentation silently.
 *   - runtime-adapter.ts:910 — `mode === "clear"` animation-suppression
 *     check; a forgotten member just animates.
 *   - settings-dialog.ts ROW_HELP strings ("compact / live / clear
 *     runtime mode", "Chord cycling compact / live / clear / off");
 *     cosmetic, but the help text must name every mode.
 *
 * Single-value sites (defaults, not enumerations; nothing to extend):
 *
 * config.ts:106 (default "live"), turn-ledger.ts:188 (default parameter).
 * Same literal spelling, different type/meaning (NOT CompactMode):
 * tool-presentation-rules.ts:43 (ToolRoute "compact"),
 * host-surface.ts:87 / host-adapter.ts:395-400 (transcript `clear` method),
 * marketplace.json:22 (marketplace tag).
 *
 * Extend-all rule: adding a union member MUST also extend every site above
 * and this EXPECTED_MODES table together. A new mode is a behavioral
 * contract spanning the config guard, the cycle shortcut, the dialog
 * whitelist, the render rules and the ledger finalization; the annotation
 * here makes a forgotten table entry a compile error (incomplete Record),
 * and the runtime assertions below fail when the dialog whitelist lags the
 * union.
 */
const EXPECTED_MODES: Record<CompactMode, true> = {
	compact: true,
	live: true,
	clear: true,
};

beforeAll(() => ensureThemeSync());

describe("compact-mode set stays in step between the union and the dialog whitelist", () => {
	test("the mode row cycles through every union member", async () => {
		let stored: CompactSettings = DEFAULT_SETTINGS;
		const visited = new Set<string>();
		const dialog = new SettingsDialog(
			{
				settings: stored,
				onChange: async (update) => {
					stored = update(stored);
					visited.add(stored.mode);
					return stored;
				},
				warn: () => {},
			},
			() => {},
			host,
		);
		// The list opens on "Global compact"; one down-arrow lands on Mode.
		dialog.handleInput("\u001b[B");
		for (let step = 0; step < Object.keys(EXPECTED_MODES).length; step++) {
			dialog.handleInput("\r");
			for (let i = 0; i < 20; i++) await Promise.resolve();
		}
		expect([...visited].sort()).toEqual(Object.keys(EXPECTED_MODES).sort());
	});
});
