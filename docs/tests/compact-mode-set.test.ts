import { describe, expect, test } from "bun:test";

import { type CompactMode, DEFAULT_SETTINGS } from "../../.omp-plugin/config";
import {
	KEY_ENTER,
	type KeybindingsLike,
	SettingsDialog,
	type ThemeLike,
} from "../../.omp-plugin/settings-ui";

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
 *   - settings-dialog.ts:61 MODES — the dialog's cycle-row whitelist. The
 *     mode row's set closure (line 270) refuses any value outside it and
 *     the cycle handler (lines 469-470) indexes into it, so a forgotten
 *     member is silently unselectable and unreachable — the defect this
 *     suite guards.
 *   - render-decision.ts 174, 214, 229, 245, 331, 386, 395 —
 *     `mode === "compact"/"live"/"clear"` predicates; a forgotten member
 *     matches no rule and inherits the fallback presentation silently.
 *   - runtime-adapter.ts:910 — `mode === "clear"` animation-suppression
 *     check; a forgotten member just animates.
 *   - settings-dialog.ts 99, 103 — ROW_HELP strings ("compact / live /
 *     clear runtime mode", "Chord cycling compact / live / clear / off");
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

function fakeTheme(): ThemeLike {
	return {
		fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
		underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
	};
}

function noopKeybindings(): KeybindingsLike {
	return { matches: () => false };
}

/** Fresh dialog over the plugin defaults, host rows live (as in settings-dialog-dirty.test.ts). */
function makeDialog(): SettingsDialog {
	return new SettingsDialog(
		{
			settings: DEFAULT_SETTINGS,
			hostAvailable: true,
			onSave: async () => {},
			theme: fakeTheme(),
			keybindings: noopKeybindings(),
		},
		() => {},
	);
}

/** Structural view of the dialog's private `Row` (see settings-dialog.ts). */
interface DialogRow {
	id: string;
	kind: "toggle" | "cycle" | "number" | "text";
	get(): unknown;
	set(value: unknown): void;
	focusable: boolean;
	unavailable: boolean;
}

function modeRowOf(dialog: SettingsDialog): DialogRow {
	// Private-access seam as in settings-dialog-dirty.test.ts: the row shape
	// under test is the dialog's own buildRows output, so cast once, validate
	// the member, then read.
	const buildRows = (dialog as unknown as { buildRows(): DialogRow[] })
		.buildRows;
	if (typeof buildRows !== "function") {
		throw new Error("SettingsDialog.buildRows is not a function");
	}
	const rows = buildRows.call(dialog);
	const row = rows.find((candidate) => candidate.id === "mode");
	if (row === undefined) {
		throw new Error("mode row missing from buildRows");
	}
	if (row.kind !== "cycle") {
		throw new Error("mode row is not a cycle row");
	}
	return row;
}

describe("compact-mode set stays in step between the union and the dialog whitelist", () => {
	test("the dialog's mode row accepts every union member", () => {
		const modeRow = modeRowOf(makeDialog());
		for (const mode of Object.keys(EXPECTED_MODES)) {
			modeRow.set(mode);
			expect(modeRow.get(), mode).toBe(mode);
		}
	});

	test("the mode row cycles through every union member", () => {
		const dialog = makeDialog();
		const modeRow = modeRowOf(dialog);
		// Focus starts on "enabled"; one down-arrow lands on the mode row.
		dialog.handleInput("j");
		const visited = new Set<string>();
		for (let step = 0; step < Object.keys(EXPECTED_MODES).length; step++) {
			dialog.handleInput(KEY_ENTER);
			visited.add(String(modeRow.get()));
		}
		expect([...visited].sort()).toEqual(Object.keys(EXPECTED_MODES).sort());
	});
});
