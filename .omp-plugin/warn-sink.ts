/**
 * The plugin's default warning sink: `console.warn` carrying the
 * `[omp-compact]` brand prefix — the user-visible diagnostic identity. One
 * home for the prefix and the sink so every defaulting caller emits
 * identically-branded warnings; callers keep their own `warn` injection seam
 * and fall back to this.
 */
export function defaultWarn(message: string): void {
	// eslint-disable-next-line no-console
	console.warn(`[omp-compact] ${message}`);
}
