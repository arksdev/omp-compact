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

/**
 * Strip ANSI CSI (ESC[) and OSC (ESC]) sequences. Pure escape stripping: it
 * does not collapse whitespace, enforce a length budget, or reject control
 * characters — those stay in `stripRejectedControls` / `sanitizeOneLine`.
 *
 * Not `Bun.stripANSI`: it reads a lone C1 CSI (U+009B) as a sequence
 * introducer and drops the text after it (`ok\x9B中😀` → `ok`). Here a stray
 * C1 is a control that `stripRejectedControls` drops, and the text stays.
 */
function stripAnsi(value: string): string {
	let result = "";
	let segStart = 0;
	for (let index = 0; index < value.length; ) {
		if (value.charCodeAt(index) !== 27) {
			index++;
			continue;
		}
		// Flush the clean segment before this ESC.
		result += value.slice(segStart, index);
		index++;
		const kind = value.charCodeAt(index);
		if (kind === 91) {
			// CSI ESC[
			index++;
			while (index < value.length) {
				const code = value.charCodeAt(index++);
				if (code >= 64 && code <= 126) break;
			}
		} else if (kind === 93) {
			// OSC ESC]
			index++;
			while (index < value.length) {
				const code = value.charCodeAt(index++);
				if (code === 7) break;
				if (code === 27 && value.charCodeAt(index) === 92) {
					index++;
					break;
				}
			}
		} else {
			index++;
		}
		segStart = index;
	}
	result += value.slice(segStart);
	return result;
}

/** Default code-point budget of one compact description. */
export const MAX_DESCRIPTION = 220;

/**
 * One display line from untrusted text: ANSI and rejected controls dropped,
 * whitespace runs collapsed, and at most `limit` code points (an ellipsis
 * marks the cut). Non-string input yields `""`.
 */
export function sanitizeOneLine(
	value: unknown,
	limit = MAX_DESCRIPTION,
): string {
	const text = typeof value === "string" ? value : "";
	const clean = stripRejectedControls(stripAnsi(text))
		.replace(/\s+/g, " ")
		.trim();
	// The budget counts code points, not UTF-16 units: slicing by UTF-16
	// index would split surrogate pairs (astral emoji) at the boundary.
	if (clean.length <= limit) return clean;
	const chars = Array.from(clean);
	if (chars.length <= limit) return clean;
	return `${chars.slice(0, Math.max(0, limit - 1)).join("")}…`;
}
