import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";

import { genericToolDescription } from "./compact";
import { stripRejectedControls } from "./display-control";
import { type DisplayPathOptions, displayPathValue } from "./display-path";
import { fitTransparentLine } from "./fit-transparent-line";
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
/** Green marker for the literal `inject` title — same ink as resolve/stats. */
const INJECT_TITLE_COLOR = "#A4D734";

/**
 * Strip ANSI CSI (ESC[) and OSC (ESC]) sequences. Unlike git-records.ts
 * `oneLine`, this is pure escape stripping: it does not collapse whitespace,
 * enforce a length budget, or reject control characters — those stay in
 * `stripControl` / `sanitizeOneLine` so multi-line inject and todo recovery
 * can keep TAB/LF/CR structure after ANSI is gone.
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

// Re-export the shared control class so existing render tests and any
// external pin of the rejected ranges keep a stable import path.
export {
	isRejectedControlCode,
	stripRejectedControls,
} from "./display-control";

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

/** One injected rule as presented by the compact inject row. */
export interface InjectRuleView {
	name: string;
	/** Optional rule description/content; may be multi-line. */
	body?: string;
}

/** One incomplete-todo reminder recovered from a stock TodoReminder card. */
export interface TodoReminderView {
	count: number;
	attempt: number;
	maxAttempts: number;
	items: readonly string[];
}

/** Compact view of a stock skill-prompt card (structured message.details). */
export interface SkillMessageView {
	name: string;
	args?: string;
	path?: string;
	lineCount?: number;
	/** Observed via patched setExpanded; #expanded is host-private. */
	expanded?: boolean;
}

/** Compact view of a stock late-diagnostics card (structured files[]). */
export interface LateDiagnosticsView {
	errored: boolean;
	summary?: string;
	count: number;
	firstMessage?: string;
	/** Observed via patched setExpanded; #expanded is host-private. */
	expanded?: boolean;
}

/** Observed expand state for skill / late-diagnostics cards. */
export interface ExpandObservedState {
	expanded?: boolean;
}

/**
 * Compact view of a user-initiated bash (`!`/`!!`) or python (`$`/`$$`)
 * execution block. Labels follow the host triggers, not the agent `eval` tool:
 * bash rows match agent `bash` chrome; python rows use `python` because the
 * user path is `handlePythonCommand` / role `pythonExecution`.
 */
export interface UserExecutionView {
	kind: "bash" | "python";
	source: string;
	running: boolean;
	exitCode?: number;
	cancelled?: boolean;
	/** When true the adapter falls back to the native multi-line frame. */
	expanded?: boolean;
}

/** Optional state observed by wrapping `setComplete` / `setExpanded`. */
export interface UserExecutionObservedState {
	exitCode?: number;
	cancelled?: boolean;
	expanded?: boolean;
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
	const clean = stripRejectedControls(stripAnsi(text))
		.replace(/\s+/g, " ")
		.trim();
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

function collectComponentTexts(node: unknown, out: string[]): void {
	if (!node || typeof node !== "object") return;
	const candidate = node as {
		getText?: () => unknown;
		children?: unknown;
	};
	if (typeof candidate.getText === "function") {
		const text = candidate.getText();
		if (typeof text === "string" && text.length > 0) out.push(text);
	}
	if (Array.isArray(candidate.children)) {
		for (const child of candidate.children) collectComponentTexts(child, out);
	}
}

/**
 * Recover the injected rule name(s) and body text from a live stock TTSR
 * notification component. Walks public `children` / `getText()` only — never
 * touches private fields. Returns `undefined` when the tree is not the
 * expected inject card so callers can fail open to native rendering.
 */
export function injectRulesFromTtsrComponent(
	block: unknown,
): readonly InjectRuleView[] | undefined {
	const texts: string[] = [];
	collectComponentTexts(block, texts);
	if (texts.length === 0) return undefined;
	// Keep the raw header long enough to split name from the trailing rewind
	// icon (stock uses two spaces); only then collapse residual whitespace.
	const rawHeader = stripRejectedControls(stripAnsi(texts[0] ?? "")).trim();
	const single = rawHeader.match(/Injecting rule:\s*(.+)$/i);
	if (single?.[1] !== undefined) {
		const name = sanitizeOneLine(single[1].split(/\s{2,}/)[0] ?? single[1], 80);
		if (!name) return undefined;
		const body = texts
			.slice(1)
			.map((line) => stripRejectedControls(stripAnsi(line)))
			.join("\n")
			.replace(/\s*\(ctrl\+o to expand\)\s*/gi, "\n")
			.trim();
		return Object.freeze([{ name, body: body || undefined }]);
	}
	const header = rawHeader.replace(/\s+/g, " ");
	if (!/Injecting\s+\d+\s+rules:/i.test(header)) return undefined;
	const rules: InjectRuleView[] = [];
	for (const raw of texts.slice(1)) {
		const plain = stripRejectedControls(stripAnsi(raw))
			.replace(/\s+/g, " ")
			.trim();
		if (!plain) continue;
		if (/\(ctrl\+o to expand\)/i.test(plain)) continue;
		if (
			/^…\s*\+\d+\s+more/i.test(plain) ||
			/^\.\.\.\s*\+\d+\s+more/i.test(plain)
		)
			continue;
		const split = plain.indexOf(": ");
		if (split === -1) {
			const name = sanitizeOneLine(plain, 80);
			if (name) rules.push({ name });
			continue;
		}
		const name = sanitizeOneLine(plain.slice(0, split), 80);
		if (!name) continue;
		const body = sanitizeOneLine(plain.slice(split + 2), MAX_DESCRIPTION);
		rules.push(body ? { name, body } : { name });
	}
	return rules.length > 0 ? Object.freeze(rules.slice()) : undefined;
}

const TODO_REMINDER_HEADER =
	/(\d+)\s+incomplete\s+todos?\s*-\s*reminder\s+(\d+)\s*\/\s*(\d+)/i;

/**
 * Recover incomplete-todo counts and item text from a live stock
 * `TodoReminderComponent`. Walks public `children` / `getText()` only — never
 * touches private constructor fields. Returns `undefined` when the tree is
 * not the expected reminder card so callers can fail open to native rendering.
 */
export function todoReminderFromComponent(
	block: unknown,
): TodoReminderView | undefined {
	const texts: string[] = [];
	collectComponentTexts(block, texts);
	if (texts.length === 0) return undefined;
	const header = stripRejectedControls(stripAnsi(texts[0] ?? ""))
		.replace(/\s+/g, " ")
		.trim();
	const match = header.match(TODO_REMINDER_HEADER);
	if (!match) return undefined;
	const count = Number(match[1]);
	const attempt = Number(match[2]);
	const maxAttempts = Number(match[3]);
	if (
		!Number.isFinite(count) ||
		!Number.isFinite(attempt) ||
		!Number.isFinite(maxAttempts) ||
		count < 1 ||
		attempt < 1 ||
		maxAttempts < 1
	) {
		return undefined;
	}
	const items: string[] = [];
	for (const raw of texts.slice(1)) {
		const plain = stripRejectedControls(stripAnsi(raw));
		for (const segment of plain.split(/\r\n|\n|\r/)) {
			// Stock body lines are "  <checkbox> <content>"; the checkbox glyph
			// is theme-dependent, so drop one leading non-space token only.
			const trimmed = segment.replace(/^\s+/, "").trimEnd();
			if (!trimmed) continue;
			const content = sanitizeOneLine(
				trimmed.replace(/^\S+\s+/, ""),
				MAX_DESCRIPTION,
			);
			if (content) items.push(content);
		}
	}
	if (items.length === 0) return undefined;
	return Object.freeze({
		count,
		attempt,
		maxAttempts,
		items: Object.freeze(items.slice()),
	});
}

function readAccessorString(
	candidate: Record<string, unknown>,
	name: string,
): string | undefined {
	const fn = candidate[name];
	if (typeof fn !== "function") return undefined;
	try {
		const value = (fn as () => unknown).call(candidate);
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

function readAccessorBoolean(
	candidate: Record<string, unknown>,
	name: string,
): boolean | undefined {
	const fn = candidate[name];
	if (typeof fn !== "function") return undefined;
	try {
		return (fn as () => unknown).call(candidate) === true;
	} catch {
		return undefined;
	}
}

/**
 * Best-effort recovery of exit/cancel markers from the stock status footer
 * when `setComplete` was not observed (e.g. hydrated history). Prefer
 * observed `setComplete` args; this is only a fallback.
 */
function scrapeExecutionFooter(
	block: unknown,
): Pick<UserExecutionView, "exitCode" | "cancelled"> | undefined {
	const texts: string[] = [];
	collectComponentTexts(block, texts);
	let exitCode: number | undefined;
	let cancelled: boolean | undefined;
	for (const raw of texts) {
		const plain = stripRejectedControls(stripAnsi(raw))
			.replace(/\s+/g, " ")
			.trim();
		if (!plain) continue;
		if (/\(cancelled\)/i.test(plain)) cancelled = true;
		const exit = plain.match(/\(exit\s+(-?\d+)\)/i);
		if (exit?.[1] !== undefined) {
			const code = Number(exit[1]);
			if (Number.isFinite(code)) exitCode = code;
		}
	}
	if (cancelled === undefined && exitCode === undefined) return undefined;
	const out: Pick<UserExecutionView, "exitCode" | "cancelled"> = {};
	if (cancelled) out.cancelled = true;
	if (exitCode !== undefined) out.exitCode = exitCode;
	return out;
}

function userExecutionFromAccessors(
	block: unknown,
	kind: "bash" | "python",
	sourceAccessor: "getCommand" | "getCode",
	observed?: UserExecutionObservedState,
): UserExecutionView | undefined {
	if (!block || typeof block !== "object") return undefined;
	const candidate = block as Record<string, unknown>;
	// Require the full public accessor set; never invent a view from text alone.
	if (typeof candidate[sourceAccessor] !== "function") return undefined;
	if (typeof candidate.getOutput !== "function") return undefined;
	if (typeof candidate.isTranscriptBlockFinalized !== "function")
		return undefined;
	// Mutual exclusion: bash has getCommand only; python has getCode only.
	if (
		sourceAccessor === "getCommand" &&
		typeof candidate.getCode === "function"
	)
		return undefined;
	if (
		sourceAccessor === "getCode" &&
		typeof candidate.getCommand === "function"
	)
		return undefined;

	const sourceRaw = readAccessorString(candidate, sourceAccessor);
	if (sourceRaw === undefined) return undefined;
	const source = sanitizeOneLine(sourceRaw);
	if (!source) return undefined;

	// getOutput is required as a presence probe even when unused: a leaf
	// missing it is not a stock execution component.
	if (readAccessorString(candidate, "getOutput") === undefined)
		return undefined;

	const finalized = readAccessorBoolean(
		candidate,
		"isTranscriptBlockFinalized",
	);
	if (finalized === undefined) return undefined;
	const running = !finalized;

	const view: UserExecutionView = { kind, source, running };
	if (observed?.expanded === true) view.expanded = true;
	if (observed?.expanded === false) view.expanded = false;

	if (!running) {
		if (observed && "cancelled" in observed && observed.cancelled === true) {
			view.cancelled = true;
		} else if (
			observed &&
			"exitCode" in observed &&
			typeof observed.exitCode === "number"
		) {
			view.exitCode = observed.exitCode;
			if (observed.cancelled === false) view.cancelled = false;
		} else if (observed && observed.cancelled === false) {
			view.cancelled = false;
			if (typeof observed.exitCode === "number")
				view.exitCode = observed.exitCode;
		} else {
			const scraped = scrapeExecutionFooter(block);
			if (scraped?.cancelled) view.cancelled = true;
			if (typeof scraped?.exitCode === "number")
				view.exitCode = scraped.exitCode;
		}
	}
	return Object.freeze(view);
}

/**
 * Recover a compact bash-execution view from a live stock
 * `BashExecutionComponent` via public accessors. Returns `undefined` on any
 * mismatch so callers fail open to native rendering.
 */
export function userBashExecutionFromComponent(
	block: unknown,
	observed?: UserExecutionObservedState,
): UserExecutionView | undefined {
	const view = userExecutionFromAccessors(
		block,
		"bash",
		"getCommand",
		observed,
	);
	return view?.kind === "bash" ? view : undefined;
}

/**
 * Recover a compact python-execution view from a live stock
 * `EvalExecutionComponent` (user `$`/`$$` path, role `pythonExecution`) via
 * public accessors. Returns `undefined` on any mismatch.
 */
export function userEvalExecutionFromComponent(
	block: unknown,
	observed?: UserExecutionObservedState,
): UserExecutionView | undefined {
	const view = userExecutionFromAccessors(block, "python", "getCode", observed);
	return view?.kind === "python" ? view : undefined;
}

/**
 * One compact row for a user-initiated bash/python execution, matching the
 * plugin's agent `bash` tool chrome (`• bash: …` / Working… / ✗ + exit meta).
 * No background/inverse sequences — transparent terminal row only.
 */
export function renderUserExecutionRow(
	view: UserExecutionView,
	theme: Theme,
	width?: number,
): readonly string[] {
	const title = theme.fg("dim", view.kind);
	const description = sanitizeOneLine(view.source);
	const suffix = description ? `: ${theme.fg("dim", description)}` : "";
	if (view.running) {
		const line = `${theme.fg("dim", pendingFrame(theme, 0))} ${theme.fg(
			"dim",
			"Working…",
		)} ${title}${suffix}`;
		return [fitTransparentLine(line, width)];
	}
	const isError =
		view.cancelled === true ||
		(typeof view.exitCode === "number" && view.exitCode !== 0);
	const icon = isError ? theme.fg("error", "✗") : theme.fg("dim", "•");
	const pieces = [`${icon} ${title}${suffix}`];
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
 * Recover a compact skill view from a live stock `SkillMessageComponent`
 * via the public parameter-property `message` (customType skill-prompt +
 * SkillPromptDetails). Returns `undefined` on any mismatch so callers fail
 * open to native rendering. Does not scrape children/getText.
 */
export function skillMessageFromComponent(
	block: unknown,
	observed?: ExpandObservedState,
): SkillMessageView | undefined {
	if (!block || typeof block !== "object") return undefined;
	const candidate = block as Record<string, unknown>;
	const message = record(candidate.message);
	// Pin literal to OMP 17.3.4 session/messages.ts:42 SKILL_PROMPT_MESSAGE_TYPE.
	if (message.customType !== "skill-prompt") return undefined;

	const details = record(message.details);
	const rawName = typeof details.name === "string" ? details.name.trim() : "";
	const name = sanitizeOneLine(rawName || "unknown", 80);
	if (!name) return undefined;

	const view: SkillMessageView = { name };
	if (typeof details.args === "string") {
		const args = sanitizeOneLine(details.args.replace(/\s+/g, " ").trim(), 120);
		if (args) view.args = args;
	}
	if (typeof details.path === "string") {
		const path = sanitizeOneLine(details.path, 120);
		if (path) view.path = path;
	}
	if (
		typeof details.lineCount === "number" &&
		Number.isFinite(details.lineCount) &&
		details.lineCount >= 0
	) {
		view.lineCount = Math.trunc(details.lineCount);
	}
	if (observed?.expanded === true) view.expanded = true;
	if (observed?.expanded === false) view.expanded = false;
	return Object.freeze(view);
}

/**
 * Recover a compact late-diagnostics view from a live stock
 * `LateDiagnosticsMessageComponent` via the public `files` array. Mirrors
 * host `#rebuild` flattening (late-diagnostics-message.ts:51-59): zero
 * diagnostic messages → `undefined` (native empty / no patch).
 */
export function lateDiagnosticsFromComponent(
	block: unknown,
	observed?: ExpandObservedState,
): LateDiagnosticsView | undefined {
	if (!block || typeof block !== "object") return undefined;
	const candidate = block as Record<string, unknown>;
	if (!Array.isArray(candidate.files)) return undefined;

	const messages: string[] = [];
	const summaries: string[] = [];
	let errored = false;
	for (const entry of candidate.files) {
		const file = record(entry);
		if (Array.isArray(file.messages)) {
			for (const msg of file.messages) {
				if (typeof msg === "string" && msg.length > 0) messages.push(msg);
			}
		}
		if (typeof file.summary === "string" && file.summary.length > 0) {
			summaries.push(file.summary);
		}
		if (file.errored === true) errored = true;
	}
	// Host early-return when messages.length === 0 — refuse the view so the
	// install probe leaves empty leaves fully native.
	if (messages.length === 0) return undefined;

	const view: LateDiagnosticsView = {
		errored,
		count: messages.length,
	};
	const summary = sanitizeOneLine(summaries.join(", "), 80);
	if (summary) view.summary = summary;
	const first = sanitizeOneLine(messages[0], MAX_DESCRIPTION);
	if (first) view.firstMessage = first;
	if (observed?.expanded === true) view.expanded = true;
	if (observed?.expanded === false) view.expanded = false;
	return Object.freeze(view);
}

/**
 * Compact skill row: ordinary gray-tool bullet chrome with custom-message
 * identity colors on the marker/name (no customMessageBg card fill).
 * Expanded is handled by the runtime adapter (native card), not here.
 */
export function renderSkillMessageRow(
	view: SkillMessageView,
	theme: Theme,
	width?: number,
): readonly string[] {
	const bullet = theme.fg("dim", "•");
	const marker = theme.fg("customMessageLabel", "skill");
	const name = theme.fg("customMessageText", sanitizeOneLine(view.name, 80));
	let line = `${bullet} ${marker} ${name}`;
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
): readonly string[] {
	const bullet = theme.fg("dim", "•");
	const title = theme.fg("toolTitle", "late diagnostics");
	const summary = view.summary
		? theme.fg("dim", ` (${sanitizeOneLine(view.summary, 60)})`)
		: "";
	const first = view.firstMessage
		? sanitizeOneLine(view.firstMessage, 120)
		: "";
	const extra = view.count > 1 ? ` · +${view.count - 1} more` : "";
	const body = first ? ` · ${first}${extra}` : extra;
	const payloadColor = view.errored ? "error" : "warning";
	const payload = body ? theme.fg(payloadColor, body) : "";
	const line = `${bullet} ${title}${summary}${payload}`;
	return [fitTransparentLine(line, width)];
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
	width?: number,
): string {
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
		const head = `${theme.fg("dim", "•")} ${title}: `;
		const fittedPath = fitMutationPath(
			pathText,
			head,
			removedStat,
			theme,
			width,
		);
		return `${head}${fittedPath}${removedStat}`;
	}
	const added = entry.added ?? 0;
	const removed = entry.removed ?? 0;
	const addedStr = mutationStat(added, "+", ADDED_STAT_COLOR, theme);
	const removedStr = mutationStat(removed, "", REMOVED_STAT_COLOR, theme);
	const sep = theme.fg("dim", "|");
	const stats = entry.exact
		? `${addedStr}${sep}${removedStr}`
		: theme.fg("dim", `${entry.lineCount ?? 0} lines`);
	const head = `${theme.fg("dim", "•")} ${theme.fg("dim", sanitizeOneLine(entry.toolName, 24))}: `;
	const tail = ` ${stats}`;
	const fittedPath = fitMutationPath(pathText, head, tail, theme, width);
	return `${head}${fittedPath}${tail}`;
}

/**
 * Shorten only the path portion of a mutation row so the trailing stats
 * (`+N|M`, `-N`, or `N lines`) always remain fully visible. A plain
 * `fitTransparentLine` / `truncateToWidth` would clip the tail — worse than
 * wrapping, because the counts are the evidence the row exists to convey.
 */
function fitMutationPath(
	pathText: string,
	head: string,
	tail: string,
	theme: Theme,
	width: number | undefined,
): string {
	const muted = (text: string) => theme.fg("muted", text);
	if (width === undefined) return muted(pathText);
	const safeWidth = Math.max(1, width);
	const fixed = visibleWidth(head) + visibleWidth(tail);
	const pathBudget = Math.max(1, safeWidth - fixed);
	if (visibleWidth(muted(pathText)) <= pathBudget) return muted(pathText);
	// truncateToWidth counts visible columns of the styled string; feed it the
	// muted path so the budget matches what the row will actually paint.
	return `${truncateToWidth(muted(pathText), pathBudget)}\u001b[39m`;
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
			mutationLine(entry, theme, displayPaths, width),
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
