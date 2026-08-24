import { describe, expect, test } from "bun:test";

import { DEFAULT_SETTINGS } from "../../.omp-plugin/config";
import {
	type KeybindingsLike,
	SettingsDialog,
	type ThemeLike,
} from "../../.omp-plugin/settings-ui";

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

/** Structural view of the dialog's private `Row` (see settings-dialog.ts). */
interface DialogRow {
	id: string;
	kind: "toggle" | "cycle" | "number" | "text";
	get(): unknown;
	set(value: unknown): void;
	focusable: boolean;
	unavailable: boolean;
}

/**
 * The row set the dialog itself builds — the source of truth for what is
 * editable, not a field list maintained alongside it. Every row's value is
 * flipped below and the dirty flag must react to each one; a row added to
 * `buildRows` without its field reaching `isDirty` fails here instead of
 * silently dropping the user's edit on save.
 */
function dialogRows(dialog: SettingsDialog): DialogRow[] {
	return (dialog as unknown as { buildRows(): DialogRow[] }).buildRows();
}

/** Fresh dialog over the plugin defaults, host rows live (as in settings-ui.test.ts). */
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

/** Replace the row's displayed value with a different one of its kind. */
function flipToDifferentValue(row: DialogRow): void {
	switch (row.kind) {
		case "toggle":
			row.set(row.get() !== true);
			break;
		case "cycle":
			row.set(row.get() === "compact" ? "live" : "compact");
			break;
		case "number":
			row.set((row.get() as number) + 1);
			break;
		case "text":
			row.set(row.get() === "alt+shift+d" ? "alt+shift+c" : "alt+shift+d");
			break;
	}
}

describe("settings dialog dirty flag stays in step with the row set", () => {
	test("every focusable row flip marks the dialog dirty", () => {
		const rows = dialogRows(makeDialog()).filter(
			(row) => row.focusable && !row.unavailable,
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const probe of rows) {
			const fresh = makeDialog();
			const row = dialogRows(fresh).find(
				(candidate) => candidate.id === probe.id,
			);
			if (row === undefined) {
				throw new Error(`row ${probe.id} missing on a fresh dialog`);
			}
			expect(fresh.isDirty).toBe(false);
			flipToDifferentValue(row);
			expect(
				fresh.isDirty,
				`flipping row ${probe.id} must make the dialog dirty`,
			).toBe(true);
		}
	});
});
