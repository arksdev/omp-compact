/**
 * Local duration formatter for compact vibe rows.
 *
 * Byte-identical to `formatDuration` from `@oh-my-pi/pi-utils`, kept local so
 * the plugin holds no runtime dependency on that package. The host bundles
 * `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-tui` and `@oh-my-pi/pi-natives`
 * for extensions, but not `@oh-my-pi/pi-utils`: on a standalone omp install
 * (the binary from omp's own installer, with no Bun global `@oh-my-pi/*`
 * tree on disk) that specifier does not resolve and the whole extension
 * fails to load.
 *
 * Note that `run-stats.ts` exports its own `formatDuration` for the terminal
 * stats row. The two formats differ deliberately — `1h20m` here against
 * `1h 20m 32s` there — so they stay separate functions.
 */

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** `0ms`, `540ms`, `3.2s`, `1m5s`, `1h20m`, `2d3h`. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0ms";
	if (ms < SEC) return `${ms}ms`;
	if (ms < MIN) return `${(ms / SEC).toFixed(1)}s`;
	if (ms < HOUR) {
		const mins = Math.floor(ms / MIN);
		const secs = Math.floor((ms % MIN) / SEC);
		return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
	}
	if (ms < DAY) {
		const hours = Math.floor(ms / HOUR);
		const mins = Math.floor((ms % HOUR) / MIN);
		return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
	}
	const days = Math.floor(ms / DAY);
	const hours = Math.floor((ms % DAY) / HOUR);
	return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}
