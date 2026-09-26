/**
 * The plugin's fallback warning sink: `console.warn` carrying the
 * `[omp-compact]` brand prefix — the user-visible diagnostic identity. The
 * plugin entry routes warnings to the session UI or the host file log once a
 * session event has arrived; this sink covers the time before that and
 * modules constructed without an injected `warn`.
 */
export function defaultWarn(message: string): void {
	console.warn(`[omp-compact] ${message}`);
}
