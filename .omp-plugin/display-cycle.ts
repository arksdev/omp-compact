import { KEYBINDINGS } from "@oh-my-pi/pi-coding-agent/config/keybindings";

import type { CompactMode } from "./config";

// =============================================================================
// Display-cycle shortcut: one keypress walks compact -> live -> clear -> off
// =============================================================================

/**
 * Default chord for the display-cycle shortcut. `alt+c` is free in the stock
 * keymap: absent from the host's built-in defaults (read live from
 * `KEYBINDINGS`, see {@link occupiedShortcuts}) and from the reserved copy.
 */
export const DEFAULT_DISPLAY_CYCLE_KEY = "alt+c";

/**
 * The runtime state the shortcut walks: the persisted `enabled` / `mode` pair.
 */
export interface DisplayCycleState {
	enabled: boolean;
	mode: CompactMode;
}

/**
 * One step of the cycle: compact -> live -> clear -> off -> compact.
 *
 * `mode` changes only between the three enabled steps; `enabled` flips only on
 * the step into `off` and the step out of it. Turning off keeps the last mode
 * on disk, so nothing is lost by a stray keypress; turning back on always
 * lands on `compact` rather than resurrecting the stored mode, so the cycle
 * order is the same no matter where the user joined it.
 */
export function nextDisplayCycleState(
	state: DisplayCycleState,
): DisplayCycleState {
	if (!state.enabled) return { enabled: true, mode: "compact" };
	if (state.mode === "compact") return { enabled: true, mode: "live" };
	if (state.mode === "live") return { enabled: true, mode: "clear" };
	return { enabled: false, mode: state.mode };
}

// =============================================================================
// Occupied chords
// =============================================================================

/**
 * COPY of `ExtensionRunner.#RESERVED_SHORTCUTS`
 * (`@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts`), taken
 * from version 18.0.6 — the version this repository pins.
 *
 * The host field is a `static readonly #RESERVED_SHORTCUTS` private class
 * member: it cannot be imported or read at runtime, so keeping this copy is
 * the only way to warn a user before they pick a dead chord. A shortcut that
 * lands on a reserved chord is dropped with nothing but a log line ("Extension
 * shortcut conflicts with built-in shortcut"), so the key would silently never
 * fire.
 *
 * MUST be re-checked against `runner.ts` whenever the
 * `@oh-my-pi/pi-coding-agent` pin moves. Declaration order matches the host.
 * Background: `context/display-cycle-reserved-copy.md`.
 */
export const RESERVED_SHORTCUTS: readonly string[] = Object.freeze([
	"ctrl+c",
	"ctrl+d",
	"ctrl+z",
	"ctrl+k",
	"ctrl+p",
	"ctrl+l",
	"ctrl+o",
	"ctrl+t",
	"ctrl+g",
	"alt+m",
	"ctrl+q",
	"shift+tab",
	"shift+ctrl+p",
	"alt+enter",
	"escape",
	"enter",
]);

/**
 * Modifier order used for canonical spelling — the host's own order
 * (`@oh-my-pi/pi-tui` `keybindings.ts` `MODIFIER_ORDER`), so `alt+ctrl+x` and
 * `ctrl+alt+x` collide here exactly as they do in the host key table.
 */
const MODIFIER_ORDER: readonly string[] = ["ctrl", "shift", "alt", "super"];

/** Non-single-character base keys (`@oh-my-pi/pi-tui` `keys.ts` `SpecialKey`). */
const SPECIAL_KEYS: Record<string, true> = {
	escape: true,
	esc: true,
	enter: true,
	return: true,
	tab: true,
	space: true,
	backspace: true,
	delete: true,
	insert: true,
	clear: true,
	home: true,
	end: true,
	pageup: true,
	pagedown: true,
	up: true,
	down: true,
	left: true,
	right: true,
	f1: true,
	f2: true,
	f3: true,
	f4: true,
	f5: true,
	f6: true,
	f7: true,
	f8: true,
	f9: true,
	f10: true,
	f11: true,
	f12: true,
};

/** Single-character base keys beyond letters and digits (same `keys.ts` union). */
const SYMBOL_KEYS = "`-=[]\\;',./!@#$%^&*()_+|~{}:<>?";

/**
 * Platform-specific paste chords: `KEYBINDINGS` only carries the chord set for
 * the platform currently running (`getDefaultPasteImageKeys`), but a config
 * file travels between machines, so a chord that works here and dies on
 * Windows is not a chord worth accepting.
 */
const CROSS_PLATFORM_PASTE_KEYS: readonly string[] = [
	"ctrl+v",
	"alt+v",
	"super+v",
];

function canonicalize(key: string): string {
	const parts = key.toLowerCase().split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	modifiers.sort(
		(left, right) =>
			MODIFIER_ORDER.indexOf(left) - MODIFIER_ORDER.indexOf(right),
	);
	return [...modifiers, base].join("+");
}

function isBaseKey(base: string): boolean {
	if (base.length !== 1) return SPECIAL_KEYS[base] === true;
	return (
		(base >= "a" && base <= "z") ||
		(base >= "0" && base <= "9") ||
		SYMBOL_KEYS.includes(base)
	);
}

let occupiedCache: ReadonlySet<string> | undefined;

/**
 * Every chord already taken: the host's live default keymap plus the reserved
 * copy above. The default keymap is read from the exported `KEYBINDINGS` table
 * rather than copied — that table is public, so there is nothing to keep in
 * sync. Computed once; the host table is module-level constant data.
 */
export function occupiedShortcuts(): ReadonlySet<string> {
	if (occupiedCache) return occupiedCache;
	const keys = new Set<string>();
	for (const definition of Object.values(KEYBINDINGS)) {
		const declared = definition.defaultKeys;
		for (const key of Array.isArray(declared) ? declared : [declared]) {
			if (key.length > 0) keys.add(canonicalize(key));
		}
	}
	for (const key of CROSS_PLATFORM_PASTE_KEYS) keys.add(key);
	for (const key of RESERVED_SHORTCUTS) keys.add(canonicalize(key));
	occupiedCache = keys;
	return keys;
}

/**
 * Why a chord cannot be used, or `undefined` when it can. The message is shown
 * verbatim on the dialog's error line, so the wording is user-facing.
 *
 * A chord without a modifier is refused even when unoccupied: a bare letter
 * registered as an extension shortcut intercepts that letter everywhere in the
 * prompt editor, which reads as a broken keyboard rather than as a shortcut.
 */
export function validateDisplayCycleKey(key: string): string | undefined {
	if (key.length === 0) return "shortcut must not be empty";
	const parts = key.toLowerCase().split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length === 0) return "shortcut needs a modifier, e.g. alt+c";
	const seen = new Set<string>();
	for (const modifier of modifiers) {
		if (!MODIFIER_ORDER.includes(modifier)) {
			return `unknown modifier "${modifier}"; use ctrl, shift, alt or super`;
		}
		if (seen.has(modifier)) return `duplicate modifier "${modifier}"`;
		seen.add(modifier);
	}
	if (!isBaseKey(base)) return `unknown key "${base}"`;
	if (occupiedShortcuts().has(canonicalize(key))) {
		return `${key} is already taken by OMP; pick another shortcut`;
	}
	return undefined;
}

/**
 * Narrowing guard for the persisted JSON field: a chord is usable only when it
 * parses AND is unoccupied, because an occupied chord is dropped by the host
 * with a log line and would silently never fire.
 */
export function isDisplayCycleKey(value: unknown): value is string {
	return (
		typeof value === "string" && validateDisplayCycleKey(value) === undefined
	);
}

// =============================================================================
// Status line
// =============================================================================

/** Minimal theme slice: the status line colors the mode name and nothing else. */
export interface CycleTheme {
	fg(color: string, text: string): string;
}

/**
 * The single line printed after a keypress. The mode name is green
 * (`success`); `off` carries no color of its own, so it stays the color of the
 * surrounding status text, and its wording differs from the mode wording on
 * purpose — switching the plugin off must not read as just another mode swap.
 *
 * Both variants speak about the next run because the runtime captures one
 * settings snapshot per logical run (`mode-policy.ts` `prepareRun`): a
 * keypress can never change the run already in flight.
 */
export function formatDisplayCycleStatus(
	state: DisplayCycleState,
	theme: CycleTheme,
): string {
	if (!state.enabled) return "Compact: off — from the next run";
	return `Compact: ${theme.fg("success", state.mode)} — takes effect next run`;
}

/**
 * Status line for a keypress whose requested value cannot take effect because a
 * hard environment override pins it. The effective state is reported instead of
 * the requested one, naming the variables in force — the same honesty the
 * settings dialog already applies to a masked save, never a silent write.
 */
export function formatPinnedCycleStatus(
	state: DisplayCycleState,
	pinnedBy: readonly string[],
	theme: CycleTheme,
): string {
	const suffix = `— pinned by ${pinnedBy.join(" / ")}, unchanged`;
	if (!state.enabled) return `Compact: off ${suffix}`;
	return `Compact: ${theme.fg("success", state.mode)} ${suffix}`;
}
