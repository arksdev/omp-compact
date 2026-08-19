/**
 * Optional project-relative display paths (upgrade2 item 3).
 *
 * Pure, display-only relabeling: given the session cwd captured for a logical
 * run, an absolute filesystem path strictly inside that cwd renders as a
 * normalized relative path (the cwd itself as `.`). Everything else — paths
 * outside the cwd, boundary lookalikes, parent escapes, other volumes,
 * already-relative paths, URIs, archive/SQLite/line selectors, and non-file
 * arguments — passes through byte-for-byte. Nothing here ever touches the
 * filesystem or the values the tools actually execute against.
 */

export interface DisplayPathOptions {
	/** Session cwd captured for the logical run. */
	cwd: string;
	/** The `compactPaths` setting snapshot for the run. */
	enabled: boolean;
}

/**
 * Live session cwd for display-path snapshots.
 *
 * Host `ExtensionContext.cwd` is a string snapshot taken when the event
 * context object is built (`createContext` copies `runner.cwd` once). Mid-
 * session `/move` and persistent user-bash `cd` update
 * `SessionManager.#cwd` without rebuilding the adapter or disposing the
 * construction-time context capture — so reading `context.cwd` forever
 * shortens paths against the pre-move root.
 *
 * Resolve through the construction-time `sessionManager` reference
 * (`getCwd()` is live). Fail open to the snapshot field (or `""`) when the
 * manager/method is missing, throws, or returns a non-string — never throw
 * into render or the event stream. Never consult process/globals.
 */
export function resolveSessionCwd(context: unknown): string {
	let fallback = "";
	if (context && typeof context === "object" && "cwd" in context) {
		const snapshot = context.cwd;
		if (typeof snapshot === "string") fallback = snapshot;
	}
	try {
		if (
			!context ||
			typeof context !== "object" ||
			!("sessionManager" in context)
		)
			return fallback;
		const manager = context.sessionManager;
		if (!manager || typeof manager !== "object" || !("getCwd" in manager))
			return fallback;
		const getCwd = manager.getCwd;
		if (typeof getCwd !== "function") return fallback;
		const live = getCwd.call(manager);
		return typeof live === "string" ? live : fallback;
	} catch {
		return fallback;
	}
}

/**
 * Lexical relativization of one absolute value against a cwd. The cwd prefix
 * is anchored segment-exactly FIRST (trailing slashes trimmed, `/` cwd
 * special-cased); only the remainder is then split at the first `:` into
 * base and selector. Returns `undefined` when the value is not absolute, is
 * not strictly inside the cwd (segment-exact boundary check), or the base
 * part would need `..` resolution to express relatively. `.` and empty
 * segments normalize away; `..` in the base part is never resolved and
 * disqualifies the value, while a selector (everything after the first `:`
 * in the remainder) stays attached verbatim — never resolved, never
 * disqualifying.
 */
export function relativizePath(value: string, cwd: string): string | undefined {
	if (value.charCodeAt(0) !== 47 || cwd.charCodeAt(0) !== 47) return undefined;
	let end = cwd.length;
	while (end > 1 && cwd.charCodeAt(end - 1) === 47) end--;
	const base = cwd.slice(0, end);
	let rest: string;
	if (base === "/") rest = value;
	else {
		if (!value.startsWith(base)) return undefined;
		rest = value.slice(base.length);
		if (rest !== "" && rest.charCodeAt(0) !== 47) return undefined; // segment-exact
	}
	const colon = rest.indexOf(":");
	const head = colon === -1 ? rest : rest.slice(0, colon);
	const segments: string[] = [];
	for (const segment of head.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") return undefined;
		segments.push(segment);
	}
	const relative = segments.length === 0 ? "." : segments.join("/");
	return colon === -1 ? relative : `${relative}${rest.slice(colon)}`;
}

/**
 * Display form of one path-bearing label value. The cwd prefix is anchored
 * first and only the remaining suffix is split at the first `:`; selector
 * suffixes (line ranges, `:raw`, `:conflicts`, archive members, sqlite
 * tables/keys, query strings) trail the base and stay attached verbatim —
 * only the leading absolute filesystem base is relativized. A colon inside
 * the cwd itself or in a sibling name never truncates the boundary check.
 * With the setting off (or no options), the value is returned unchanged.
 */
export function displayPathValue(
	value: string,
	options: DisplayPathOptions | undefined,
): string {
	if (!options?.enabled) return value;
	if (!options.cwd || value.charCodeAt(0) !== 47) return value;
	return relativizePath(value, options.cwd) ?? value;
}
