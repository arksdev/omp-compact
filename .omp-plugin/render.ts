import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";

import { genericToolDescription } from "./compact";
import { type DisplayPathOptions, displayPathValue } from "./display-path";
import type {
	GitMessageDetails,
	LegacyMutationMessageDetails,
	MutationMessageDetails,
} from "./messages";
import {
	resolveToolRule,
	type ToolPresentationRule,
} from "./tool-presentation-rules";

const ADDED_STAT_COLOR = "#A4D734";
const REMOVED_STAT_COLOR = "#A1471A";
/**
 * Strip ANSI CSI (ESC[) and OSC (ESC]) sequences. Simpler than git-records.ts
 * `oneLine` (which also handles partial escapes and skip logic); this variant
 * is pure stripping for display sanitization.
 */
function stripAnsi(value: string): string {
	let result = "";
	let segStart = 0;
	for (let index = 0; index < value.length; ) {
		if (value.charCodeAt(index) !== 27) {
			index++;
			continue;
		}
		// Flush the clean segment before this ESC.
		result += value.slice(segStart, index);
		index++;
		const kind = value.charCodeAt(index);
		if (kind === 91) {
			// CSI ESC[
			index++;
			while (index < value.length) {
				const code = value.charCodeAt(index++);
				if (code >= 64 && code <= 126) break;
			}
		} else if (kind === 93) {
			// OSC ESC]
			index++;
			while (index < value.length) {
				const code = value.charCodeAt(index++);
				if (code === 7) break;
				if (code === 27 && value.charCodeAt(index) === 92) {
					index++;
					break;
				}
			}
		} else {
			index++;
		}
		segStart = index;
	}
	result += value.slice(segStart);
	return result;
}

function stripControl(value: string): string {
	let output = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code >= 32 || code === 9 || code === 10 || code === 13)
			output += character;
	}
	return output;
}

const MAX_DESCRIPTION = 220;

export interface CompactToolView {
	toolName: string;
	args: unknown;
	result?: unknown;
	isError: boolean;
	isPartial: boolean;
	tick?: number;
	mutationEntries?: readonly (
		| MutationMessageDetails
		| LegacyMutationMessageDetails
	)[];
	git?: GitMessageDetails;
}

export class CompactLines implements Component {
	readonly #lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, width);
		return this.#lines.map((line) => truncateToWidth(line, safeWidth));
	}
}

export function sanitizeOneLine(
	value: unknown,
	limit = MAX_DESCRIPTION,
): string {
	// Non-string inputs (numbers, objects, undefined) are intentionally silenced to "".
	const text = typeof value === "string" ? value : "";
	const clean = stripControl(stripAnsi(text)).replace(/\s+/g, " ").trim();
	// The budget counts code points, not UTF-16 units: slicing by UTF-16
	// index would split surrogate pairs (astral emoji) at the boundary.
	if (clean.length <= limit) return clean;
	const chars = Array.from(clean);
	if (chars.length <= limit) return clean;
	return `${chars.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function resultText(result: unknown): string {
	const content = record(result).content;
	if (!Array.isArray(content)) return "";
	for (const item of content) {
		const text = record(item).text;
		if (typeof text !== "string") continue;
		if (text.trim()) return sanitizeOneLine(text, 120);
	}
	return "";
}

function settledMeta(
	view: CompactToolView,
	rule: ToolPresentationRule | undefined,
): string[] {
	const meta: string[] = [];
	// Tool-specific settled metadata (bash exit code / wall time, grep match
	// count, glob file count) comes from the registry rule. Generic
	// error-result text handling stays here in the renderer.
	if (rule?.resultMeta !== undefined)
		meta.push(...rule.resultMeta(view.result));
	if (view.isError) {
		const text = resultText(view.result);
		if (text) meta.push(text);
	}
	return meta;
}

// Only the foreground is opened, so only the foreground is closed: `[39m`
// keeps any surrounding dim/bold intact and never resets the background,
// matching the transparent-row contract in `fitTransparentLine`.
function fixedForeground(hex: string, text: string): string {
	const ansi = Bun.color(hex, "ansi-16m");
	return ansi ? `${ansi}${text}\u001b[39m` : text;
}

function mutationStat(
	value: number,
	prefix: string,
	hex: string,
	theme: Theme,
): string {
	const text = `${prefix}${value}`;
	return value === 0 ? theme.fg("dim", text) : fixedForeground(hex, text);
}

export function mutationLine(
	entry: MutationMessageDetails | LegacyMutationMessageDetails,
	theme: Theme,
	displayPaths?: DisplayPathOptions,
): string {
	const path = displayPathValue(entry.path, displayPaths);
	const sanitizedPath = theme.fg("muted", sanitizeOneLine(path, 180));
	if (entry.toolName === "delete") {
		// Delete rows are distinct: red "delete" title, gray path, and the
		// removed stat only when an exact count is known. An unknown count
		// renders no stat at all — never an estimate, never a "+0|" pair.
		const title = fixedForeground(
			REMOVED_STAT_COLOR,
			sanitizeOneLine(entry.toolName, 24),
		);
		const removedStat =
			entry.exact && typeof entry.removed === "number"
				? ` ${mutationStat(entry.removed, "-", REMOVED_STAT_COLOR, theme)}`
				: "";
		return `${theme.fg("dim", "•")} ${title}: ${sanitizedPath}${removedStat}`;
	}
	const added = entry.added ?? 0;
	const removed = entry.removed ?? 0;
	const addedStr = mutationStat(added, "+", ADDED_STAT_COLOR, theme);
	const removedStr = mutationStat(removed, "", REMOVED_STAT_COLOR, theme);
	const sep = theme.fg("dim", "|");
	const stats = entry.exact
		? `${addedStr}${sep}${removedStr}`
		: theme.fg("dim", `${entry.lineCount ?? 0} lines`);
	return `${theme.fg("dim", "•")} ${theme.fg("dim", sanitizeOneLine(entry.toolName, 24))}: ${sanitizedPath} ${stats}`;
}

export function gitLine(
	entry: Pick<GitMessageDetails, "text" | "isError">,
	theme: Theme,
): string {
	const text = sanitizeOneLine(entry.text, MAX_DESCRIPTION);
	// A record may already carry the leading error icon (`✗ git …` or a bare
	// `✗`); strip exactly one icon plus any following whitespace so the row
	// never shows a doubled marker.
	if (entry.isError && text.startsWith("✗")) {
		const rest = text.slice(1).trimStart();
		if (rest.length === 0) return theme.fg("error", "✗");
		return `${theme.fg("error", "✗")} ${theme.fg("dim", rest)}`;
	}
	const icon = entry.isError ? theme.fg("error", "✗") : theme.fg("dim", "•");
	return `${icon} ${theme.fg("dim", text)}`;
}

/**
 * One row per invocation of the Bash call, in command order. Entries without
 * a records list are single-invocation rows and render as themselves.
 */
function gitRecordRows(details: GitMessageDetails, theme: Theme): string[] {
	const records =
		Array.isArray(details.records) && details.records.length > 0
			? details.records
			: [details];
	return records.map((record) =>
		gitLine({ text: record.text, isError: record.isError }, theme),
	);
}

const COMMIT_HASH_PREFIX = /^git commit\s+([0-9a-f]{4,64})(?:\s|$)/i;

/**
 * Successful commit hashes of one Bash call, in command order. Only commit
 * records whose own text proves an actually created hash count: failed
 * commits and successful invocations whose result carried no summary line
 * contribute nothing. Legacy single-record entries are read through the same
 * record shape, so their own `subcommand` decides.
 */
export function gitCommitHashes(details: GitMessageDetails): string[] {
	const records =
		Array.isArray(details.records) && details.records.length > 0
			? details.records
			: [details];
	const hashes: string[] = [];
	for (const record of records) {
		if (record.subcommand !== "commit" || record.isError) continue;
		const match = COMMIT_HASH_PREFIX.exec(record.text);
		if (match) hashes.push(match[1]);
	}
	return hashes;
}

/**
 * The single aggregate Git row of a filtered terminal answer:
 * `• git commit: hash1, hash2, hash3`. The last hash keeps the exact added
 * foreground; the label and earlier hashes stay neutral, and the row stays
 * on the ordinary transparent terminal background. At narrow widths the
 * oldest hashes (and finally the label) are dropped with an ellipsis so the
 * newest, colored hash always stays fully visible.
 */
export function terminalGitSummaryLine(
	hashes: readonly string[],
	theme: Theme,
	width?: number,
): string {
	if (hashes.length === 0) return "";
	const label = `${theme.fg("dim", "•")} ${theme.fg("dim", "git commit:")}`;
	const last = fixedForeground(ADDED_STAT_COLOR, hashes[hashes.length - 1]);
	if (width === undefined) {
		const earlier = hashes.slice(0, -1).map((hash) => theme.fg("dim", hash));
		return [label, [...earlier, last].join(", ")].join(" ");
	}
	const safeWidth = Math.max(1, width);
	// Build from the newest hash backwards, prepending older hashes while the
	// whole label + tail still fits; anything dropped becomes an ellipsis.
	let tail = last;
	let kept = 1;
	for (let index = hashes.length - 2; index >= 0; index--) {
		const candidate = `${theme.fg("dim", hashes[index])}, ${tail}`;
		if (visibleWidth(`${label} ${candidate}`) > safeWidth) break;
		tail = candidate;
		kept++;
	}
	const ellipsis = kept < hashes.length ? `${theme.fg("dim", "…")}, ` : "";
	if (visibleWidth(`${label} ${ellipsis}${tail}`) <= safeWidth)
		return `${label} ${ellipsis}${tail}`;
	if (visibleWidth(`${ellipsis}${tail}`) <= safeWidth)
		return `${ellipsis}${tail}`;
	// Narrowest fallback: the colored newest hash alone, still unclipped.
	return visibleWidth(last) <= safeWidth
		? last
		: fitTransparentLine(last, safeWidth);
}

/**
 * Braille frames for the compact "Working…" indicator. The stock TUI's Working
 * loader animates `theme.getSpinnerFrames("activity")` (the dot frames, e.g.
 * ⠦ ⠧ ⠇ ⠏ for the unicode preset), so the compact pending row follows it;
 * unknown shapes fall back to `theme.spinnerFrames` and finally to the bullet.
 */
function pendingFrame(theme: Theme, tick: number): string {
	const activity =
		typeof theme.getSpinnerFrames === "function"
			? theme.getSpinnerFrames("activity")
			: undefined;
	const frames =
		(activity && activity.length > 0 ? activity : undefined) ??
		(Array.isArray(theme.spinnerFrames) && theme.spinnerFrames.length > 0
			? theme.spinnerFrames
			: undefined);
	const frame = frames ? frames[tick % frames.length] : "•";
	return frame ?? "•";
}

// Intentional per-module copy of fitTransparentLine; identical logic in
// render.ts and run-stats.ts.
/**
 * Keep compact rows on the terminal's ordinary transparent background while
 * still fitting overlong content to the component width. Short rows are never
 * padded, and no ANSI background open/reset sequence is introduced.
 */
function fitTransparentLine(line: string, width: number | undefined): string {
	if (width === undefined) return line;
	const safeWidth = Math.max(1, width);
	return visibleWidth(line) > safeWidth
		? `${truncateToWidth(line, safeWidth)}\u001b[39m`
		: line;
}

export function renderCompactToolRows(
	view: CompactToolView,
	theme: Theme,
	width?: number,
	displayPaths?: DisplayPathOptions,
): readonly string[] {
	if (
		view.mutationEntries &&
		view.mutationEntries.length > 0 &&
		!view.isPartial
	) {
		return view.mutationEntries.map((entry) =>
			mutationLine(entry, theme, displayPaths),
		);
	}
	if (view.git && !view.isPartial) {
		return gitRecordRows(view.git, theme).map((line) =>
			fitTransparentLine(line, width),
		);
	}

	// Explicit rule lookup only — render never invents a rule for unknown
	// names. Unknown tools fall back to the bounded generic description; the
	// runtime adapter decides whether an unresolved tool renders natively.
	const rule = resolveToolRule(view.toolName);
	const summary = rule
		? rule.describe(view.args, displayPaths)
		: genericToolDescription(view.toolName, view.args);
	const sanitizedTitle = sanitizeOneLine(summary.title, 40).toLowerCase();
	const title = summary.titleColor
		? fixedForeground(summary.titleColor, sanitizedTitle)
		: theme.fg("dim", sanitizedTitle);
	const description = sanitizeOneLine(summary.description);
	// Read rows drop the colon separator: `• read <path>`.
	const separator = rule?.route === "read-group" ? " " : ": ";
	const suffix = description
		? `${separator}${theme.fg("dim", description)}`
		: "";
	let line: string;
	if (view.isPartial) {
		// One activity indicator: braille frame + "Working…", then the summary
		// so the pending live-log row keeps the tool identity.
		line = `${theme.fg("dim", pendingFrame(theme, view.tick ?? 0))} ${theme.fg(
			"dim",
			"Working…",
		)} ${title}${suffix}`;
	} else {
		const icon = view.isError ? theme.fg("error", "✗") : theme.fg("dim", "•");
		const pieces = [`${icon} ${title}${suffix}`];
		const meta = [
			...summary.meta.map((value) => sanitizeOneLine(value, 100)),
			...settledMeta(view, rule),
		].filter(Boolean);
		if (meta.length > 0) pieces.push(theme.fg("dim", ` · ${meta.join(" · ")}`));
		line = pieces.join("");
	}
	return [fitTransparentLine(line, width)];
}

export function mutationMessageComponent(
	details: MutationMessageDetails | LegacyMutationMessageDetails | undefined,
	theme: Theme,
): Component | undefined {
	return details ? new CompactLines([mutationLine(details, theme)]) : undefined;
}

export function gitMessageComponent(
	details: GitMessageDetails | undefined,
	theme: Theme,
): Component | undefined {
	return details ? new CompactLines(gitRecordRows(details, theme)) : undefined;
}
