/**
 * Opt-in diagnostics for every native fail-open.
 *
 * A framed stock card inside a compact session always means the same thing:
 * the plugin could not prove which tool call owns that component, so it fell
 * back to the host renderer. Which branch decided that is invisible
 * afterwards — the session transcript records tool calls and results, never
 * the pairing decisions — so a screenshot of framed chrome costs an
 * archaeology session to explain. `OMP_COMPACT_TRACE=1` turns each fail-open
 * branch into one stderr line naming the reason and the counts behind it.
 *
 * Off by default, and the message is a thunk so a disabled trace neither
 * formats nor allocates.
 */
export function traceNative(reason: () => string): void {
	const flag = process.env.OMP_COMPACT_TRACE;
	if (flag === undefined || flag === "" || flag === "0") return;
	console.warn(`[omp-compact trace] ${reason()}`);
}
