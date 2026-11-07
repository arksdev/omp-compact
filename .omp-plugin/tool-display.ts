/**
 * Per-tool display choice the user can set in `/compact-settings`:
 *
 * - `rows`: one-line rows that follow the mode, like any routine call.
 * - `newest`: the newest call of the tool keeps omp's full card while the run
 *   works; older calls are rows.
 * - `open`: omp's full card in every mode and phase.
 *
 * A tool without a choice uses the default its registry route implies
 * (`wait` and `todo` are `newest`, everything else `rows`).
 */

import type { ToolDisplay } from "./config";
import { objectRecord as record } from "./object-record";
import {
	normalizeToolName,
	resolveToolRule,
	type ToolRoute,
} from "./tool-presentation-rules";
import { writeDeviceName } from "./tool-rule-describers";

/**
 * The `xd://` device a `write` call runs, or `undefined`. omp's
 * `pi.getAllTools()` lists a device under its own name, so a choice for it
 * is keyed by that name.
 */
export function xdDevice(toolName: string, args: unknown): string | undefined {
	if (normalizeToolName(toolName) !== "write") return undefined;
	return writeDeviceName(record(args));
}

/** The name a call's display choice is keyed by. */
export function toolDisplayKey(toolName: string, device?: string): string {
	return normalizeToolName(device ?? toolName);
}

/**
 * Whether the user can choose a display for the tool. Interactive tools
 * (`ask`) need their card to answer, and the vibe tools have their own
 * `compactVibeRows` switch.
 */
export function isConfigurableTool(key: string): boolean {
	return (
		resolveToolRule(key)?.route !== "native-live" &&
		!normalizeToolName(key).startsWith("vibe_")
	);
}

export function defaultToolDisplay(key: string): ToolDisplay {
	const route = resolveToolRule(key)?.route;
	if (route === "native-live") return "open";
	if (route === "live-card") return "newest";
	return "rows";
}

/** The display a run applies to a call: the user's choice, else the default. */
export function effectiveToolDisplay(
	key: string,
	choices: Readonly<Record<string, ToolDisplay>>,
): ToolDisplay {
	const chosen = Object.hasOwn(choices, key) ? choices[key] : undefined;
	return chosen !== undefined && isConfigurableTool(key)
		? chosen
		: defaultToolDisplay(key);
}

/**
 * The tools the settings dialog lists: every tool omp reports plus every
 * tool the config already holds a choice for (so a choice for a tool that is
 * gone can still be reset), configurable ones only, sorted by name.
 */
export function toolDisplayOptions(
	toolNames: Iterable<string>,
	choices: Readonly<Record<string, ToolDisplay>>,
): { name: string; defaultDisplay: ToolDisplay }[] {
	const names = new Set<string>(Object.keys(choices));
	for (const name of toolNames) names.add(normalizeToolName(name));
	return [...names]
		.filter(isConfigurableTool)
		.sort()
		.map((name) => ({ name, defaultDisplay: defaultToolDisplay(name) }));
}

/**
 * The route a call is decided on. `open` uses the native-live route, which
 * draws omp's card in every mode and phase. `newest` uses the live-card route
 * only for the newest working call; every other call takes the tool's row
 * route, so an older call draws exactly as `rows` would draw it (an unknown
 * tool keeps omp's own row).
 */
export function displayRoute(
	base: ToolRoute | undefined,
	display: ToolDisplay,
	liveCard: boolean,
): ToolRoute | undefined {
	if (display === "open") return "native-live";
	if (display === "newest" && liveCard) return "live-card";
	return base === "live-card" || base === "native-live" ? "compact" : base;
}
