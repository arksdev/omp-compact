/**
 * Shared terminal-control character class for compact display text.
 *
 * Callers keep their own *row shaping* (whitespace collapse, length budgets,
 * multi-line TAB/LF/CR retention). This module owns only the rejected class
 * decision so render, git-records, and settings-ui cannot drift apart.
 *
 * Rejected: C0 controls other than TAB/LF/CR, DEL (0x7F), the C1 range
 * (0x80–0x9F), and Unicode line/paragraph separators (U+2028/U+2029).
 * Preserved: TAB/LF/CR (multi-line inject/todo rows), printable ASCII, and
 * every code point above C1 except U+2028/U+2029.
 *
 * Iteration is by Unicode code point (`for...of` / `codePointAt`). When a
 * caller hands `charCodeAt(0)` of an astral character, it sees the high
 * surrogate (0xD800–0xDBFF), which sits outside every rejected range — so
 * emoji and CJK extension B stay intact.
 */

/**
 * True when `code` is a terminal-effect control the compact UI must drop.
 * Accepts either a full code point or a UTF-16 code unit (high surrogates
 * of astral characters are not rejected).
 */
export function isRejectedControlCode(code: number): boolean {
	if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
	if (code < 0x20) return true;
	if (code === 0x7f) return true;
	if (code >= 0x80 && code <= 0x9f) return true;
	if (code === 0x2028 || code === 0x2029) return true;
	return false;
}

/**
 * Drop rejected control characters while preserving TAB/LF/CR and every
 * non-control code point (including astral characters). Does not strip
 * ANSI escape *sequences* — callers that need that run their own ESC
 * scanner first (or afterward). Does not collapse whitespace or enforce
 * a length budget.
 */
export function stripRejectedControls(value: string): string {
	let output = "";
	for (const character of value) {
		// charCodeAt(0) on an astral code point is the high surrogate, which
		// isRejectedControlCode leaves alone; the full pair is appended.
		if (!isRejectedControlCode(character.charCodeAt(0))) {
			output += character;
		}
	}
	return output;
}
