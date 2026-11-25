/**
 * The plugin's ANSI-styled rows as escape-free text for omp's transcript
 * presenter and Tern's native view.
 *
 * Rows are painted with theme colours (`theme.fg`), which omp's `ansiSpans`
 * maps back to theme tokens, plus a few fixed colours (`fixedForeground` in
 * render.ts) that are no theme colour and would be dropped. Those are first
 * rewritten to the basic SGR colours that map to the semantic tokens keeping
 * their meaning: green additions, resolve and stats ink (`success`), rust
 * removals and reject (`error`), purple computer use (`accent`).
 *
 * Without omp's span conversion (`nativeSpans` in host-modules.ts) a row
 * reaches omp as plain text, and a rows node is no node at all: omp then
 * draws the component from its rendered ANSI lines.
 */

import type { TspText } from "@oh-my-pi/pi-wire";

import { nativeSpans } from "./host-modules";

const FIXED_COLOR_SGR = (
	[
		["#A4D734", 32],
		["#A1471A", 31],
		["#8D2A88", 35],
	] as const
).flatMap(([hex, sgr]) => {
	const truecolor = Bun.color(hex, "ansi-16m");
	return truecolor ? [[truecolor, `\x1b[${sgr}m`] as const] : [];
});

function themed(line: string): string {
	let themed = line;
	for (const [truecolor, basic] of FIXED_COLOR_SGR)
		themed = themed.replaceAll(truecolor, basic);
	return themed;
}

/** One ANSI row as presenter text: plain or styled, one line. */
export function nativeText(line: string): TspText {
	const single = line.replace(/\r?\n/g, " ");
	if (!nativeSpans) return Bun.stripANSI(single);
	return nativeSpans.ansiSpans(themed(single));
}
