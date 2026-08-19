import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

/**
 * Keep compact rows on the terminal's ordinary transparent background while
 * still fitting overlong content to the component width. Short rows are never
 * padded, and no ANSI background open/reset sequence is introduced.
 *
 * Single definition for the plugin: render.ts and run-stats.ts previously
 * each kept an intentional copy of this helper; they were character-identical
 * in the function body, so they share one export here and cannot drift.
 */
export function fitTransparentLine(
	line: string,
	width: number | undefined,
): string {
	if (width === undefined) return line;
	const safeWidth = Math.max(1, width);
	return visibleWidth(line) > safeWidth
		? `${truncateToWidth(line, safeWidth)}\u001b[39m`
		: line;
}
