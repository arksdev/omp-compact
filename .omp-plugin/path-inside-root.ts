/**
 * Segment-exact containment of an absolute path inside a root directory.
 *
 * Single definition for the plugin (audit confinement + config path
 * acceptance) so the two call sites cannot drift the way the former
 * control-character sanitizers did before `display-control.ts`.
 *
 * ## Contract (POSIX-only)
 *
 * Both sides must already be normalized absolute paths (typically
 * `resolve` / realpath / canonical forms). Trailing slashes on the root
 * are ignored; a path equal to the root counts as inside. Lexical only —
 * callers supply canonical forms when symlink escape must be closed.
 *
 * Fail-closed: any path that cannot be proven inside the root is outside.
 * Prefix-boundary safe: `/foo/barbaz` is not inside `/foo/bar`.
 *
 * **POSIX absolute paths only.** Both arguments must start with `/`
 * (charCode 47). Windows-style roots (`C:\…`, `\\server\share`) and bare
 * relative strings are rejected. On Windows that means write pre-image
 * confinement never claims inside-root evidence, and explicit config-path
 * acceptance never treats a Windows absolute as under home/cwd — both
 * degrade fail-closed rather than guessing. This is intentional: the
 * plugin does not implement Windows path semantics.
 */

/**
 * True when `path` is the root itself or a path strictly under it at a
 * directory-segment boundary.
 */
export function isPathInsideRoot(path: string, root: string): boolean {
	if (path.charCodeAt(0) !== 47 || root.charCodeAt(0) !== 47) return false;
	let end = root.length;
	while (end > 1 && root.charCodeAt(end - 1) === 47) end--;
	const base = root.slice(0, end);
	if (path === base) return true;
	if (base === "/") return path.charCodeAt(0) === 47 && path.length > 1;
	return path.startsWith(base) && path.charCodeAt(base.length) === 47;
}
