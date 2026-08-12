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
 * Lexical relativization of one absolute path against a cwd. Returns
 * `undefined` when the path is not absolute, is not strictly inside the cwd
 * (segment-exact boundary check), or would need `..` resolution to express
 * relatively. `.` and empty segments normalize away; `..` segments are never
 * resolved and disqualify the path.
 */
export function relativizePath(path: string, cwd: string): string | undefined {
	if (!path.startsWith("/") || !cwd.startsWith("/")) return undefined;
	const pathSegments = path
		.split("/")
		.filter((segment) => segment !== "" && segment !== ".");
	const cwdSegments = cwd
		.split("/")
		.filter((segment) => segment !== "" && segment !== ".");
	if (pathSegments.length < cwdSegments.length) return undefined;
	for (let index = 0; index < cwdSegments.length; index++) {
		if (pathSegments[index] !== cwdSegments[index]) return undefined;
	}
	const remainder = pathSegments.slice(cwdSegments.length);
	if (remainder.some((segment) => segment === "..")) return undefined;
	if (remainder.length === 0) return ".";
	return remainder.join("/");
}

/**
 * Display form of one path-bearing label value. Selector suffixes (line
 * ranges, `:raw`, `:conflicts`, archive members, sqlite tables/keys, query
 * strings) trail the base after the first `:` and stay attached verbatim;
 * only the leading absolute filesystem base is relativized. With the setting
 * off (or no options), the value is returned unchanged.
 */
export function displayPathValue(
	value: string,
	options: DisplayPathOptions | undefined,
): string {
	if (!options?.enabled) return value;
	const cwd = options.cwd;
	if (!cwd || !value.startsWith("/")) return value;
	const colon = value.indexOf(":");
	const base = colon === -1 ? value : value.slice(0, colon);
	const suffix = colon === -1 ? "" : value.slice(colon);
	const relative = relativizePath(base, cwd);
	return relative === undefined ? value : `${relative}${suffix}`;
}
