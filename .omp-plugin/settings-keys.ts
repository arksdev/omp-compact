export const KEY_ENTER = "\r";
export const KEY_ESCAPE = "\u001b";
export const KEY_SPACE = " ";
export const KEY_BACKSPACE = "\u007f";
export const KEY_CTRL_C = "\u0003";

/**
 * CSI/SS3 final byte → direction. Partial: every other final byte belongs to
 * some non-arrow key, so indexing must surface `undefined` on its own rather
 * than relying on `noUncheckedIndexedAccess` staying enabled.
 */
const ARROW_FINAL_BYTES: Partial<Record<string, ArrowDirection>> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
};

/**
 * Parameter bytes of an *unmodified* arrow in the kitty parameterized form:
 * the modifier field is exactly `1` (no modifiers held), with an optional
 * event-type sub-field restricted to `1` (press) and `2` (repeat).
 */
const KITTY_UNMODIFIED_ARROW_PARAMS = /^1;1(?::[12])?$/;

export type ArrowDirection = "up" | "down" | "left" | "right";

/**
 * Terminals emit arrows in three families: plain CSI (`ESC [ A`), SS3
 * (`ESC O A`, delivered while the TTY sits in DECCKM application-cursor-keys
 * mode — the host writes `rmkx` on entry, so SS3 only survives as a leftover
 * from a program that ran before it), and the kitty keyboard-protocol
 * parameterized form (`ESC [ 1;1 A`, `ESC [ 1;1:2 A`). Stock TUI components
 * decode all three, so comparing raw bytes against the plain-CSI spelling
 * alone drops every arrow that arrives in one of the other two encodings, on
 * terminals OMP itself fully supports.
 *
 * Only unmodified press and repeat events count as arrows:
 * - With no modifiers held the kitty protocol omits the parameter field and
 *   sends the short form, so a parameterized arrow carries either a real
 *   modifier (`ESC [ 1;3 B` is alt+down, `ESC [ 1;2 C` is shift+right) or an
 *   event-type sub-field the terminal adds once event reporting was asked
 *   for. Accepting any modifier mask would let shift+up move the cursor and
 *   ctrl+right rewrite a value, which no stock component does.
 * - Release events (event type `3`) are rejected right here. The host's TUI
 *   also filters them for components that do not opt into key-release
 *   delivery, but this dialog does not lean on that: a release must never
 *   count as a second press.
 *
 * Which levels report event types is the host's decision, not this module's:
 * it pushes `CSI > 1 u`, `CSI > 3 u`, `CSI > 5 u` or `CSI > 7 u` depending on
 * the flags the terminal reports and on whether the session is ConPTY-hosted
 * (`pi-tui` `terminal.ts`), and only the levels carrying flag `0b10` turn
 * event types on. Both shapes are therefore accepted unconditionally.
 */
export function normalizeArrowKey(data: string): ArrowDirection | undefined {
	if (data.length < 3 || data[0] !== KEY_ESCAPE) return undefined;
	const direction = ARROW_FINAL_BYTES[data[data.length - 1] ?? ""];
	if (direction === undefined) return undefined;
	// Plain CSI and SS3 carry no parameters; anything longer must be the
	// parameterized CSI form, so its parameter bytes are validated rather
	// than assumed (`ESC [ 1;2 H` is Home, `ESC [ 1;3 B` is alt+down).
	if (data.length === 3) {
		return data[1] === "[" || data[1] === "O" ? direction : undefined;
	}
	if (data[1] !== "[") return undefined;
	return KITTY_UNMODIFIED_ARROW_PARAMS.test(data.slice(2, -1))
		? direction
		: undefined;
}
