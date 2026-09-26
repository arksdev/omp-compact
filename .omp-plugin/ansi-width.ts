import { Ellipsis, truncateToWidth } from "@oh-my-pi/pi-tui";

import { isRejectedControlCode } from "./display-control";

const ESCAPE = String.fromCharCode(27);
const ANSI_SGR_PREFIX_RE = new RegExp(`^${ESCAPE}\\[[0-9;]*m`);

/**
 * Drop rejected terminal controls (shared `display-control` class) while
 * keeping ANSI SGR sequences intact, so escape bytes are never mistaken for
 * lone C0 controls before the host truncator measures the string.
 */
function dropRejectedControls(value: string): string {
	let out = "";
	let i = 0;
	while (i < value.length) {
		const code = value.codePointAt(i) ?? 0;
		if (code === 0x1b) {
			const sequence = ANSI_SGR_PREFIX_RE.exec(value.slice(i));
			if (sequence) {
				out += sequence[0];
				i += sequence[0].length;
				continue;
			}
		}
		const widthUnits = code > 0xffff ? 2 : 1;
		if (isRejectedControlCode(code)) {
			i += widthUnits;
			continue;
		}
		out += String.fromCodePoint(code);
		i += widthUnits;
	}
	return out;
}

/**
 * Truncate text to `width` visible terminal cells while keeping ANSI SGR
 * sequences intact and never splitting a grapheme (wide CJK/emoji glyphs are
 * dropped rather than half-emitted at the boundary; combining marks stay
 * with their base). Rejected terminal controls (shared `display-control`
 * class: DEL, C1, U+2028/U+2029, other C0 except TAB/LF/CR) are dropped
 * first and do not count toward width.
 *
 * Cell counting is the host's own authority (`@oh-my-pi/pi-tui`
 * `truncateToWidth`, the same engine the host TUI and the rest of this
 * plugin's render path use). The host truncator restores the color state
 * with a reset when it cuts styled text, and short clean strings come back
 * byte-identical.
 */
export function truncateAnsiSafe(text: string, width: number): string {
	if (width <= 0) return "\x1b[0m";
	const clean = dropRejectedControls(text);
	return truncateToWidth(clean, width, Ellipsis.Omit);
}
