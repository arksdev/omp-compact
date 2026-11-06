import type { Theme } from "./theme-types";
import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import type { Component } from "@oh-my-pi/pi-tui";

import { genericToolDescription } from "./compact";
import { type DisplayPathOptions, displayPathValue } from "./display-path";
import { fitTransparentLine } from "./fit-transparent-line";
import type {
	GitMessageDetails,
	LegacyMutationMessageDetails,
	MutationMessageDetails,
} from "./messages";
import { objectRecord as record } from "./object-record";
import { MAX_DESCRIPTION, sanitizeOneLine } from "./display-control";
import {
	normalizeToolName,
	resolveToolRule,
	type ToolPresentationRule,
} from "./tool-presentation-rules";
import {
	type CompactVibeView,
	renderCompactVibeRows,
	unpackVibeToolDetails,
	type VibeOp,
	pendingFrame,
} from "./vibe-cards";

export { sanitizeOneLine } from "./display-control";

/** One injected rule as presented by the compact inject row. */
export interface InjectRuleView {
	name: string;
	/** Optional rule description/content; may be multi-line. */
	body?: string;
}

/** One incomplete-todo reminder. */
export interface TodoReminderView {
	count: number;
	attempt: number;
	maxAttempts: number;
	items: readonly string[];
}

/** Compact view of a skill-prompt message (structured message.details). */
export interface SkillMessageView {
	name: string;
	args?: string;
	path?: string;
	lineCount?: number;
}

/** Compact view of a late-diagnostics message (structured files[]). */
export interface LateDiagnosticsView {
	errored: boolean;
	summary?: string;
	count: number;
	firstMessage?: string;
}

/**
 * Compact view of a user-initiated bash (`!`/`!!`) or python (`$`/`$$`)
 * execution block. Labels follow the host triggers, not the agent `eval` tool:
 * bash rows match agent `bash` chrome; python rows use `python` because the
 * user path is role `pythonExecution`.
 */
export interface UserExecutionView {
	kind: "bash" | "python";
	source: string;
	running: boolean;
	exitCode?: number;
	cancelled?: boolean;
}

/**
 * How a row is drawn as the label of omp's compact answer. omp draws the
 * row's glyph itself, and in Tern's native view the block's own title
 * stands before the label, so a row whose leading title is that same word
 * leaves it out (`read src.txt` after `Read` shows `src.txt`).
 */
export interface RowHead {
	/** The stock title shown before the label; `undefined` keeps the row's own. */
	readonly stockTitle?: string;
}

/** Whether a row's title and a stock title name the same thing (`edit:` / `Edit`). */
function sameTitle(own: string, stock: string | undefined): boolean {
	if (stock === undefined) return false;
	const key = (title: string) =>
		title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
	const ownKey = key(own);
	return ownKey !== "" && ownKey === key(stock);
}

const ADDED_STAT_COLOR = "#A4D734";
const REMOVED_STAT_COLOR = "#A1471A";
/** Green marker for the literal `inject` title — same ink as resolve/stats. */
const INJECT_TITLE_COLOR = "#A4D734";

// Re-export the shared control class so existing render tests and any
// external pin of the rejected ranges keep a stable import path.
export {
	isRejectedControlCode,
	stripRejectedControls,
} from "./display-control";

export interface CompactToolView {
	toolName: string;
	args: unknown;
	result?: unknown;
	isError: boolean;
	isPartial: boolean;
	tick?: number;
	/**
	 * Wall clock of the settling tool result; undefined while in flight.
	 * Row grammars measuring elapsed time use it as the frame clock so a
	 * repaint (resize replay, fold re-render) reproduces the committed frame
	 * instead of aging its content out.
	 */
	settledAt?: number;
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
		meta.push(...rule.resultMeta(view.result, view.args));
	if (view.isError) {
		const text = resultText(view.result);
		if (text) meta.push(text);
	}
	return meta;
}

// Only the foreground is opened, so only the foreground is closed: `[39m`
// keeps any surrounding dim/bold intact and never resets the background,
// matching the transparent-row contract in `fitTransparentLine`.
export function fixedForeground(hex: string, text: string): string {
	const ansi = Bun.color(hex, "ansi-16m");
	return ansi ? `${ansi}${text}\u001b[39m` : text;
}

/**
 * One compact row for a user-initiated bash/python execution, matching the
 * plugin's agent `bash` tool chrome (`• bash: …` / Working… / ✗ + exit meta).
 * No background/inverse sequences — transparent terminal row only. As a
 * label (`head`), a running row leaves its frame to omp's own glyph.
 */
export function renderUserExecutionRow(
	view: UserExecutionView,
	theme: Theme,
	width?: number,
	head?: RowHead,
): readonly string[] {
	const description = sanitizeOneLine(view.source);
	const dim = description ? theme.fg("dim", description) : "";
	const subject =
		description && sameTitle(view.kind, head?.stockTitle)
			? dim
			: `${theme.fg("dim", view.kind)}${dim ? `: ${dim}` : ""}`;
	if (view.running) {
		const working = `${theme.fg("dim", "Working…")} ${subject}`;
		const line = head
			? working
			: `${theme.fg("dim", pendingFrame(theme, 0))} ${working}`;
		return [fitTransparentLine(line, width)];
	}
	const isError =
		view.cancelled === true ||
		(typeof view.exitCode === "number" && view.exitCode !== 0);
	const icon = isError ? theme.fg("error", "✗") : theme.fg("dim", "•");
	const pieces = [`${icon} ${subject}`];
	const meta: string[] = [];
	if (view.cancelled === true) meta.push("cancelled");
	else if (typeof view.exitCode === "number" && view.exitCode !== 0)
		meta.push(`exit ${view.exitCode}`);
	if (meta.length > 0) pieces.push(theme.fg("dim", ` · ${meta.join(" · ")}`));
	return [fitTransparentLine(pieces.join(""), width)];
}

/**
 * Compact todo-reminder row: ordinary gray-tool bullet chrome with one yellow
 * warning payload (reminder fraction + first incomplete item). No background/
 * inverse sequences — only theme warning foreground on the transparent
 * terminal background.
 */
export function renderTodoReminderRow(
	view: TodoReminderView,
	theme: Theme,
	width?: number,
): readonly string[] {
	const label = view.count === 1 ? "todo" : "todos";
	const header = `${view.count} incomplete ${label} - reminder ${view.attempt}/${view.maxAttempts}`;
	const first = view.items[0] ? sanitizeOneLine(view.items[0], 120) : "";
	const extra =
		view.items.length > 1 ? ` · +${view.items.length - 1} more` : "";
	const body = first ? ` · ${first}${extra}` : extra;
	const bullet = theme.fg("dim", "•");
	const line = `${bullet} ${theme.fg("warning", `${header}${body}`)}`;
	return [fitTransparentLine(line, width)];
}

/**
 * Compact skill row: ordinary gray-tool bullet chrome with custom-message
 * identity colors on the marker/name (no customMessageBg card fill).
 * An expanded block is omp's full card, not drawn here.
 */
export function renderSkillMessageRow(
	view: SkillMessageView,
	theme: Theme,
	width?: number,
	head?: RowHead,
): readonly string[] {
	const bullet = theme.fg("dim", "•");
	const name = theme.fg("customMessageText", sanitizeOneLine(view.name, 80));
	let line = sameTitle("skill", head?.stockTitle)
		? `${bullet} ${name}`
		: `${bullet} ${theme.fg("customMessageLabel", "skill")} ${name}`;
	if (view.args) {
		line += ` ${theme.fg("dim", sanitizeOneLine(view.args, 120))}`;
	}
	const meta: string[] = [];
	if (view.path) meta.push(theme.fg("accent", sanitizeOneLine(view.path, 80)));
	if (typeof view.lineCount === "number") {
		const n = view.lineCount;
		meta.push(theme.fg("muted", `${n} ${n === 1 ? "line" : "lines"}`));
	}
	if (meta.length > 0) {
		const sep = theme.fg("dim", " · ");
		line += sep + meta.join(sep);
	}
	return [fitTransparentLine(line, width)];
}

/**
 * Compact late-diagnostics row: tool-title marker with warning/error payload
 * for severity. Transparent background only.
 */
export function renderLateDiagnosticsRow(
	view: LateDiagnosticsView,
	theme: Theme,
	width?: number,
	head?: RowHead,
): readonly string[] {
	const bullet = theme.fg("dim", "•");
	const summaryText = view.summary
		? `(${sanitizeOneLine(view.summary, 60)})`
		: "";
	const first = view.firstMessage
		? sanitizeOneLine(view.firstMessage, 120)
		: "";
	const extra = view.count > 1 ? ` · +${view.count - 1} more` : "";
	const body = first ? ` · ${first}${extra}` : extra;
	const payloadColor = view.errored ? "error" : "warning";
	const payload = body ? theme.fg(payloadColor, body) : "";
	// Without its title the row starts at the summary, else at the payload.
	if (sameTitle("late diagnostics", head?.stockTitle) && (summaryText || body))
		return [
			fitTransparentLine(
				summaryText
					? `${bullet} ${theme.fg("dim", summaryText)}${payload}`
					: `${bullet} ${theme.fg(payloadColor, body.replace(/^ · /, ""))}`,
				width,
			),
		];
	const title = theme.fg("toolTitle", "late diagnostics");
	const summary = summaryText ? theme.fg("dim", ` ${summaryText}`) : "";
	return [fitTransparentLine(`${bullet} ${title}${summary}${payload}`, width)];
}

/**
 * Compact inject rows: ordinary gray tool chrome (`•` + dim payload) with only
 * the literal marker `inject` in green. No background/card sequences.
 */
export function renderInjectRuleRows(
	rules: readonly InjectRuleView[],
	theme: Theme,
	width?: number,
): readonly string[] {
	if (rules.length === 0) return [];
	const rows: string[] = [];
	const bullet = theme.fg("dim", "•");
	const title = fixedForeground(INJECT_TITLE_COLOR, "inject");
	for (const rule of rules) {
		const name = sanitizeOneLine(rule.name, 80);
		const suffix = name ? theme.fg("dim", `: ${name}`) : "";
		rows.push(fitTransparentLine(`${bullet} ${title}${suffix}`, width));
		const body = typeof rule.body === "string" ? rule.body : "";
		if (!body) continue;
		// Preserve author line breaks; strip host ANSI/control per line so a
		// hostile rule body cannot reintroduce a card background or spoof ink.
		for (const segment of body.split(/\r\n|\n|\r/)) {
			const line = sanitizeOneLine(segment, MAX_DESCRIPTION);
			if (!line) continue;
			rows.push(fitTransparentLine(theme.fg("dim", line), width));
		}
	}
	return rows;
}

/** One non-blocking advisor note as the compact advisor rows show it. */
export interface AdvisorNoteView {
	readonly note: string;
	/** `undefined` is omp's plain nit. */
	readonly severity: "nit" | "concern" | undefined;
	readonly advisor: string | undefined;
}

/** omp's collapsed advisor card shows this many notes. */
const COLLAPSED_ADVISOR_NOTES = 3;

/**
 * Compact advisor rows: one `• advisor [severity]` row per note omp's
 * collapsed card shows, then its hidden-note count. The full card is one
 * expansion away.
 */
export function renderAdvisorRows(
	notes: readonly AdvisorNoteView[],
	theme: Theme,
	width?: number,
	head?: RowHead,
): readonly string[] {
	const rows: string[] = [];
	for (const [index, entry] of notes
		.slice(0, COLLAPSED_ADVISOR_NOTES)
		.entries()) {
		const severity = entry.severity ?? "nit";
		const label = theme.fg(
			severity === "concern" ? "warning" : "muted",
			`[${severity}]`,
		);
		const who =
			entry.advisor && entry.advisor !== "default"
				? ` ${theme.fg("dim", `[${sanitizeOneLine(entry.advisor, 80)}]`)}`
				: "";
		// The note's first non-blank line, whitespace-collapsed and bounded.
		const summary = sanitizeOneLine(
			entry.note.split("\n").find((line) => line.trim()) ?? "",
			MAX_DESCRIPTION,
		);
		const marker =
			index === 0 && sameTitle("advisor", head?.stockTitle)
				? theme.fg("dim", "•")
				: theme.fg("dim", "• advisor");
		rows.push(fitTransparentLine(`${marker} ${label}${who} ${summary}`, width));
	}
	const hidden = notes.length - COLLAPSED_ADVISOR_NOTES;
	if (hidden > 0)
		rows.push(
			fitTransparentLine(
				theme.fg(
					"dim",
					`  … +${hidden} more ${hidden === 1 ? "note" : "notes"}`,
				),
				width,
			),
		);
	return rows;
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

export function mutationRows(
	entry: MutationMessageDetails | LegacyMutationMessageDetails,
	theme: Theme,
	displayPaths?: DisplayPathOptions,
	width?: number,
	head?: RowHead,
): readonly string[] {
	const bullet = `${theme.fg("dim", "•")} `;
	const titled = !sameTitle(entry.toolName, head?.stockTitle);
	const path = displayPathValue(entry.path, displayPaths);
	// Cap the path before width-fitting so an absurd path cannot dominate the
	// row; the width pass below may shorten it further to protect the stats.
	const pathText = sanitizeOneLine(path, 180);
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
		const lead = titled ? `${bullet}${title}: ` : bullet;
		return fitMutationRows(pathText, lead, removedStat, theme, width);
	}
	const added = entry.added ?? 0;
	const removed = entry.removed ?? 0;
	const addedStr = mutationStat(added, "+", ADDED_STAT_COLOR, theme);
	const removedStr = mutationStat(removed, "", REMOVED_STAT_COLOR, theme);
	const sep = theme.fg("dim", "|");
	const stats = entry.exact
		? `${addedStr}${sep}${removedStr}`
		: theme.fg("dim", `${entry.lineCount ?? 0} lines`);
	const lead = titled
		? `${bullet}${theme.fg("dim", sanitizeOneLine(entry.toolName, 24))}: `
		: bullet;
	const tail = ` ${stats}`;
	return fitMutationRows(pathText, lead, tail, theme, width);
}

/**
 * Shorten the path on normal widths. If even head + stats cannot fit, put
 * the stats on their own wrapped rows rather than let host truncation lose
 * evidence. Each returned string is one terminal row, never an embedded LF.
 */
function fitMutationRows(
	pathText: string,
	head: string,
	tail: string,
	theme: Theme,
	width: number | undefined,
): readonly string[] {
	const path = theme.fg("muted", pathText);
	if (width === undefined) return [`${head}${path}${tail}`];
	const safeWidth = Math.max(1, width);
	const pathBudget = safeWidth - visibleWidth(head) - visibleWidth(tail);
	if (pathBudget < 1) {
		const row = fitTransparentLine(`${head}${path}`, safeWidth);
		return tail
			? [row, ...wrapTextWithAnsi(tail.trimStart(), safeWidth)]
			: [row];
	}
	const fittedPath =
		visibleWidth(path) <= pathBudget
			? path
			: `${truncateToWidth(path, pathBudget)}\u001b[39m`;
	return [`${head}${fittedPath}${tail}`];
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
		// Group 1 is required by COMMIT_HASH_PREFIX; a successful match
		// always populates it.
		const hash = match?.[1];
		if (hash !== undefined) hashes.push(hash);
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
	const newest = hashes[hashes.length - 1];
	// Guarded by hashes.length > 0 above.
	if (newest === undefined) return "";
	const last = fixedForeground(ADDED_STAT_COLOR, newest);
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
		const older = hashes[index];
		if (older === undefined) continue;
		const candidate = `${theme.fg("dim", older)}, ${tail}`;
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
 * Canonical vibe tool name → builder operation. Keys are the canonical
 * underscore spellings of the five stock devices (`VIBE_TOOL_NAMES` in
 * `node_modules/.../src/tools/vibe.ts`); lookups go through
 * `normalizeToolName` like every other registry access. Null prototype: a
 * prototype-collision name must index to `undefined`, never a function.
 */
const VIBE_OPS: Readonly<Partial<Record<string, VibeOp>>> = Object.freeze(
	Object.assign(Object.create(null), {
		vibe_spawn: "spawn",
		vibe_send: "send",
		vibe_wait: "wait",
		vibe_kill: "kill",
		vibe_list: "list",
	}) as Partial<Record<string, VibeOp>>,
);

/**
 * Whether a tool name is one of the five stock vibe worker-session devices.
 * `VIBE_OPS` above stays the single source of truth for that set — the
 * presenter pairs this predicate with the run's frozen `compactVibeRows`
 * snapshot to decide compact vs stock presentation.
 */
export function isVibeToolName(name: string): boolean {
	return VIBE_OPS[normalizeToolName(name)] !== undefined;
}

/**
 * The compact rows of one tool call. With `head`, the first row is drawn
 * as omp's label (see {@link RowHead}); the rest keep their own titles.
 */
export function renderCompactToolRows(
	view: CompactToolView,
	theme: Theme,
	width?: number,
	displayPaths?: DisplayPathOptions,
	head?: RowHead,
): readonly string[] {
	if (
		view.mutationEntries &&
		view.mutationEntries.length > 0 &&
		!view.isPartial
	) {
		return view.mutationEntries.flatMap((entry, index) =>
			mutationRows(
				entry,
				theme,
				displayPaths,
				width,
				index === 0 ? head : undefined,
			),
		);
	}
	if (view.git && !view.isPartial) {
		return gitRecordRows(view.git, theme).map((line) =>
			fitTransparentLine(line, width),
		);
	}

	// Vibe worker-session devices own their row grammar (TV-wall cards, not a
	// `title: description` summary), so they resolve before the generic
	// registry description path. An empty builder result is a legal outcome
	// (`vibe_kill` prints nothing, a wait with no live worker prints nothing):
	// the block then renders zero rows, exactly like the `empty` decision.
	const vibeOp = VIBE_OPS[normalizeToolName(view.toolName)];
	if (vibeOp !== undefined) {
		const vibeView: CompactVibeView = {
			op: vibeOp,
			details: unpackVibeToolDetails(view.result),
			args: view.args,
			isPartial: view.isPartial,
			tick: view.tick,
			// Settled blocks render against the settle-time clock so a resize
			// or fold repaint reproduces the committed cards; in-flight frames
			// keep the live clock for spinner/age movement.
			now: view.settledAt,
			isError: view.isError,
			result: view.result,
		};
		return renderCompactVibeRows(vibeView, theme, width);
	}

	// Explicit rule lookup only — render never invents a rule for unknown
	// names. Unknown tools fall back to the bounded generic description; the
	// presenter decides whether an unresolved tool gets omp's own row. A call
	// still in flight paints the same row without settled metadata: omp draws
	// the spinner beside it.
	return paintCompactRow(
		compactRowSpec(view, displayPaths),
		theme,
		width,
		head,
	);
}

/**
 * The theme-free content of one generic compact tool row: everything
 * `renderCompactToolRows` derives from the call's arguments and result,
 * already sanitized and bounded, so it can outlive them. Mutation, Git and
 * vibe rows are not described here; a vibe call gets the generic summary.
 */
interface CompactRowSpec {
	readonly title: string;
	readonly titleColor?: string;
	readonly separator: string;
	readonly description: string;
	/** Settled metadata; empty while the call is still in flight. */
	readonly meta: readonly string[];
	readonly isError: boolean;
}

function compactRowSpec(
	view: CompactToolView,
	displayPaths?: DisplayPathOptions,
): CompactRowSpec {
	const rule = resolveToolRule(view.toolName);
	const summary = rule
		? rule.describe(view.args, displayPaths)
		: genericToolDescription(view.toolName, view.args);
	return {
		title: sanitizeOneLine(summary.title, 40).toLowerCase(),
		...(summary.titleColor && { titleColor: summary.titleColor }),
		// Read rows drop the colon separator: `• read <path>`.
		separator: rule?.route === "read-group" ? " " : ": ",
		description: sanitizeOneLine(summary.description),
		meta: view.isPartial
			? []
			: [
					...summary.meta.map((value) => sanitizeOneLine(value, 100)),
					...settledMeta(view, rule),
				].filter(Boolean),
		isError: view.isError,
	};
}

function paintSummary(
	spec: CompactRowSpec,
	theme: Theme,
	head?: RowHead,
): string {
	const description = theme.fg("dim", spec.description);
	if (spec.description && sameTitle(spec.title, head?.stockTitle))
		return description;
	const title = spec.titleColor
		? fixedForeground(spec.titleColor, spec.title)
		: theme.fg("dim", spec.title);
	const suffix = spec.description ? `${spec.separator}${description}` : "";
	return `${title}${suffix}`;
}

/** The settled row a spec describes, at the current theme and width. */
function paintCompactRow(
	spec: CompactRowSpec,
	theme: Theme,
	width?: number,
	head?: RowHead,
): readonly string[] {
	const icon = spec.isError ? theme.fg("error", "✗") : theme.fg("dim", "•");
	const meta =
		spec.meta.length > 0 ? theme.fg("dim", ` · ${spec.meta.join(" · ")}`) : "";
	return [
		fitTransparentLine(
			`${icon} ${paintSummary(spec, theme, head)}${meta}`,
			width,
		),
	];
}

export function mutationMessageComponent(
	details: MutationMessageDetails | LegacyMutationMessageDetails | undefined,
	theme: Theme,
): Component | undefined {
	return details
		? { render: (width) => mutationRows(details, theme, undefined, width) }
		: undefined;
}

export function gitMessageComponent(
	details: GitMessageDetails | undefined,
	theme: Theme,
): Component | undefined {
	return details ? new CompactLines(gitRecordRows(details, theme)) : undefined;
}
