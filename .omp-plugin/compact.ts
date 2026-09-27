import { objectRecord as record } from "./object-record";

export interface ToolDescription {
	title: string;
	description: string;
	meta: string[];
	/**
	 * Optional raw hex color (e.g. "#8D2A88") for the sanitized title segment
	 * only. The renderer applies it to the title alone and resets before the
	 * separator; an absent value keeps the ordinary dim title.
	 */
	titleColor?: string;
}

const MAX_ARG_TEXT = 4_096;

/**
 * First `limit` Unicode code points of a string, never splitting a surrogate
 * pair. Mirrors the code-point budget of `sanitizeOneLine` in render.ts:
 * the UTF-16 `.slice` would land mid-pair on astral characters (emoji),
 * corrupting the boundary with a lone surrogate. Returns the original string
 * when it already fits, so the common short path allocates nothing.
 */
export function truncateCodePoints(value: string, limit: number): string {
	if (value.length <= limit) return value;
	const chars = Array.from(value);
	return chars.length <= limit ? value : chars.slice(0, limit).join("");
}

/**
 * Count Unicode code points without intermediate allocations by walking
 * UTF-16 code units and skipping low surrogates of valid surrogate pairs.
 */
export function codePointLength(value: string): number {
	let length = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
			const next = value.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				i++;
			}
		}
		length++;
	}
	return length;
}

export function stringValue(
	value: Record<string, unknown>,
	key: string,
): string {
	return typeof value[key] === "string"
		? truncateCodePoints(value[key] as string, MAX_ARG_TEXT)
		: "";
}

export function listValue(
	value: Record<string, unknown>,
	key: string,
): string[] {
	const candidate = value[key];
	if (Array.isArray(candidate)) {
		return candidate
			.filter((item): item is string => typeof item === "string")
			.slice(0, 8)
			.map((item) => truncateCodePoints(item, MAX_ARG_TEXT));
	}
	return typeof candidate === "string" && candidate
		? [truncateCodePoints(candidate, MAX_ARG_TEXT)]
		: [];
}

export function editPathsFromInput(input: string): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	const bounded = input.slice(0, 16_384);
	const addPath = (path: string): void => {
		if (!seen.has(path)) {
			seen.add(path);
			paths.push(path);
		}
	};
	for (const match of bounded.matchAll(/^\[([^\]\r\n]+)\]\s*$/gm)) {
		const header = match[1];
		if (!header) continue;
		const tagStart = header.lastIndexOf("#");
		const path =
			tagStart > 0 && /^[a-f\d]{4}$/i.test(header.slice(tagStart + 1))
				? header.slice(0, tagStart)
				: header;
		addPath(path);
		if (paths.length >= 8) return paths;
	}
	// Header scans stay on one line and stay linear: `[^\S\r\n]` is
	// whitespace that is not a line break, and a path ends on a non-space
	// character, so no whitespace run can be split two ways between the
	// path and its trailing space.
	for (const match of bounded.matchAll(
		/^[^\S\r\n]*\*{3}[^\S\r\n]+(?:Add|Update|Delete)[^\S\r\n]+File[^\S\r\n]*:[^\S\r\n]*(\S(?:.*\S)?)[^\S\r\n]*$/gm,
	)) {
		const path = match[1];
		if (!path) continue;
		addPath(path);
		if (paths.length >= 8) break;
	}
	// Sloppy-edit payloads: 18.3.0 opens a file with `*** Edit File: <path>`,
	// hosts up to 18.2.11 spelled the same opener `*** SM:EDIT <path>`. A bare
	// opener continues the previous file and carries no path, and a trailing
	// ` all` is the match-all modifier rather than part of the path.
	for (const match of bounded.matchAll(
		/^[^\S\r\n]*\*{3}[ \t]+(?:Edit[ \t]+File[ \t]*:[ \t]*|SM:EDIT[ \t]+)(\S(?:.*\S)?)[^\S\r\n]*$/gim,
	)) {
		const raw = match[1];
		if (!raw) continue;
		const path = unquoteHeaderPath(stripMatchAllModifier(raw));
		if (!path) continue;
		addPath(path);
		if (paths.length >= 8) break;
	}
	return paths;
}

/**
 * Drop a trailing match-all modifier: whitespace, then `all` in any case, at
 * the very end. By hand because `/\s+all$/i` retries from every position of
 * a long whitespace run inside the path. `trimEnd` removes exactly the
 * characters `\s` matches.
 */
function stripMatchAllModifier(raw: string): string {
	if (!/^all$/i.test(raw.slice(-3))) return raw;
	const head = raw.slice(0, -3);
	const kept = head.trimEnd();
	return kept.length < head.length ? kept : raw;
}

/**
 * Sloppy openers JSON-quote a path that would otherwise be ambiguous
 * (`*** Edit File: "src/a b.ts"`); plain paths come through unquoted.
 */
function unquoteHeaderPath(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"'))
		return trimmed;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === "string" ? parsed : trimmed;
	} catch {
		return trimmed;
	}
}

function shortValue(value: unknown): string {
	if (typeof value === "string") return truncateCodePoints(value, 160);
	if (typeof value === "number" || typeof value === "boolean" || value === null)
		return String(value);
	if (Array.isArray(value)) return `[${value.length} items]`;
	return value && typeof value === "object" ? "{…}" : "";
}

function unknownArgs(value: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, item] of Object.entries(value)) {
		// Convention: skip keys starting with "__" (internal/private fields)
		// and undefined values (unset optionals).
		if (key.startsWith("__") || item === undefined) continue;
		parts.push(`${key}: ${shortValue(item)}`);
		if (parts.length >= 4) break;
	}
	return parts.join(" ");
}

/**
 * Bounded generic tool description: lowercase label (underscore and hyphen
 * spellings share one title) plus at most four compact `key: value` pairs.
 *
 * This is the generic form for tools WITHOUT a specialized describe:
 * registered routine/interactive tools (hub, todo, eval, yield, web_search,
 * ask, task, hus) route here through `genericDescribe` in
 * `tool-presentation-rules.ts`, and the renderer falls back to it for
 * unresolved tool names. Tools WITH a specialized describe keep it —
 * substituting the generic form would bypass their presentation logic and
 * bounds.
 *
 * @internal
 */
export function genericToolDescription(
	name: string,
	args: unknown,
): ToolDescription {
	return {
		title: name.replaceAll("_", " ").replaceAll("-", " ").toLowerCase(),
		description: unknownArgs(record(args)),
		meta: [],
	};
}
