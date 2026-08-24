import { isRejectedControlCode } from "./display-control";

const ESCAPE = String.fromCharCode(27);
const ANSI_SGR_RE = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");
const ANSI_SGR_PREFIX_RE = new RegExp(`^${ESCAPE}\\[[0-9;]*m`);

/**
 * Strip ANSI SGR sequences. Third variant (render.ts and git-records.ts
 * have others); this one is the simplest regex-only version.
 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_SGR_RE, "");
}

/**
 * Truncate text to `width` visible columns while keeping ANSI SGR sequences
 * intact and never splitting surrogate pairs. Rejected terminal controls
 * (shared `display-control` class: DEL, C1, U+2028/U+2029, other C0 except
 * TAB/LF/CR) are dropped and do not count toward width. If the cut lands
 * inside styled text, a reset is appended so color never leaks onto
 * subsequent lines.
 */
export function truncateAnsiSafe(text: string, width: number): string {
	if (width <= 0) return "\x1b[0m";
	// Single walk: drop rejected controls (they never count toward width),
	// preserve SGR sequences, stop at `width` visible code points. A reset is
	// appended only when the walk truncated — short clean strings return
	// byte-identical so existing callers keep their exact styled output.
	let out = "";
	let visible = 0;
	let i = 0;
	let truncated = false;
	while (i < text.length) {
		const code = text.codePointAt(i) ?? 0;
		if (code === 0x1b) {
			const sequence = ANSI_SGR_PREFIX_RE.exec(text.slice(i));
			if (sequence) {
				if (visible >= width) {
					// Past the cut: keep trailing SGR only when we already
					// started emitting (so color state can still close).
					// Simpler: stop; the final reset covers leakage.
					truncated = true;
					break;
				}
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
		if (visible >= width) {
			truncated = true;
			break;
		}
		out += String.fromCodePoint(code);
		visible++;
		i += widthUnits;
	}
	if (truncated) return `${out}\x1b[0m`;
	return out;
}
