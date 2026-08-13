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

export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

export function stringValue(
	value: Record<string, unknown>,
	key: string,
): string {
	return typeof value[key] === "string"
		? (value[key] as string).slice(0, MAX_ARG_TEXT)
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
			.map((item) => item.slice(0, MAX_ARG_TEXT));
	}
	return typeof candidate === "string" && candidate
		? [candidate.slice(0, MAX_ARG_TEXT)]
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
	for (const match of bounded.matchAll(
		/^\s*\*{3}\s+(?:Add|Update|Delete)\s+File\s*:\s*(\S.*?)\s*$/gm,
	)) {
		const path = match[1];
		if (!path) continue;
		addPath(path);
		if (paths.length >= 8) break;
	}
	return paths;
}

function shortValue(value: unknown): string {
	if (typeof value === "string") return value.slice(0, 160);
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
 * This is a direct helper fallback for unknown/unrecognized tools only.
 * Tool presentation rules live in `tool-presentation-rules.ts`. The runtime
 * adapter MUST NOT route known tools through this function — doing so bypasses
 * specialized presentation logic and bounds.
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
