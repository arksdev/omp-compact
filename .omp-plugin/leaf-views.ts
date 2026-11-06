/**
 * Compact views of the non-tool transcript blocks omp hands the presenter
 * (TTSR hits, todo reminders, skill prompts, late diagnostics, `!`/`$` runs,
 * advisor cards), read from the block's structured data. The data is omp's
 * live session data and may come from any session file, so every reader
 * checks types, bounds what it reads, and answers `undefined` when the block
 * cannot be shown compact: omp then draws its own card.
 */

import {
	MAX_DESCRIPTION,
	sanitizeOneLine,
	stripRejectedControls,
} from "./display-control";
import { isBoundedString, MAX_EVIDENCE_TEXT_LENGTH } from "./messages";
import { objectRecord } from "./object-record";
import type {
	AdvisorNoteView,
	InjectRuleView,
	LateDiagnosticsView,
	SkillMessageView,
	TodoReminderView,
	UserExecutionView,
} from "./render";

/** Characters of untrusted text read before sanitizing it to one row. */
const MAX_SOURCE_TEXT = 4_096;
/** omp's collapsed TTSR card lists this many rules (`MAX_COLLAPSED_RULES`). */
const COLLAPSED_RULES = 4;
/** omp's collapsed single-rule card shows this many description lines. */
const COLLAPSED_RULE_LINES = 2;
/** Advisor notes one card may carry and still be shown compact. */
const MAX_ADVISOR_NOTES = 64;

function boundedText(value: unknown): string {
	return typeof value === "string" ? value.slice(0, MAX_SOURCE_TEXT) : "";
}

/** The first `count` lines of `text`, and whether more followed. */
function leadingLines(
	text: string,
	count: number,
): { lines: string[]; more: boolean } {
	const lines: string[] = [];
	let start = 0;
	while (lines.length < count) {
		const end = text.indexOf("\n", start);
		if (end === -1) {
			lines.push(text.slice(start));
			return { lines, more: false };
		}
		lines.push(text.slice(start, end));
		start = end + 1;
	}
	return { lines, more: true };
}

/** A rule's text as omp's card shows it: the description, else the content. */
function ruleText(rule: Record<string, unknown>): string {
	const description = boundedText(rule.description);
	return (description || boundedText(rule.content)).trim();
}

/**
 * The rules of a TTSR hit as omp's collapsed card lists them: one rule with
 * up to two description lines, or up to four rules with the first line of
 * each.
 */
export function injectRuleViews(
	rules: readonly unknown[],
): readonly InjectRuleView[] | undefined {
	if (!Array.isArray(rules) || rules.length === 0) return undefined;
	if (rules.length === 1) {
		const rule = objectRecord(rules[0]);
		const name = sanitizeOneLine(boundedText(rule.name), 80);
		if (!name) return undefined;
		const { lines, more } = leadingLines(ruleText(rule), COLLAPSED_RULE_LINES);
		const body = `${lines.join("\n")}${more ? "…" : ""}`;
		return [body ? { name, body } : { name }];
	}
	const views: InjectRuleView[] = [];
	for (const value of rules.slice(0, COLLAPSED_RULES)) {
		const rule = objectRecord(value);
		const name = sanitizeOneLine(boundedText(rule.name), 80);
		if (!name) continue;
		const { lines, more } = leadingLines(ruleText(rule), 1);
		const first = lines[0] ?? "";
		const body = sanitizeOneLine(
			more ? `${first.trimEnd()}…` : first,
			MAX_DESCRIPTION,
		);
		views.push(body ? { name, body } : { name });
	}
	return views.length > 0 ? views : undefined;
}

function positiveCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
		? value
		: undefined;
}

/** An incomplete-todo reminder: its fraction and the open items. */
export function todoReminderView(event: {
	readonly todos: readonly unknown[];
	readonly attempt: unknown;
	readonly maxAttempts: unknown;
}): TodoReminderView | undefined {
	if (!Array.isArray(event.todos)) return undefined;
	const count = positiveCount(event.todos.length);
	const attempt = positiveCount(event.attempt);
	const maxAttempts = positiveCount(event.maxAttempts);
	if (count === undefined || attempt === undefined || maxAttempts === undefined)
		return undefined;
	const items: string[] = [];
	for (const todo of event.todos) {
		const content = sanitizeOneLine(
			boundedText(objectRecord(todo).content),
			MAX_DESCRIPTION,
		);
		if (content) items.push(content);
	}
	if (items.length === 0) return undefined;
	return { count, attempt, maxAttempts, items };
}

/** A skill prompt's name, arguments, file and size (`SkillPromptDetails`). */
export function skillMessageView(details: unknown): SkillMessageView {
	const record = objectRecord(details);
	const name = sanitizeOneLine(boundedText(record.name), 80) || "unknown";
	const view: SkillMessageView = { name };
	const args = sanitizeOneLine(boundedText(record.args), 120);
	if (args) view.args = args;
	const path = sanitizeOneLine(boundedText(record.path), 120);
	if (path) view.path = path;
	if (
		typeof record.lineCount === "number" &&
		Number.isFinite(record.lineCount) &&
		record.lineCount >= 0
	)
		view.lineCount = Math.trunc(record.lineCount);
	return view;
}

/** Late LSP diagnostics: severity, summary, count and the first message. */
export function lateDiagnosticsView(
	details: unknown,
): LateDiagnosticsView | undefined {
	const files = objectRecord(details).files;
	if (!Array.isArray(files)) return undefined;
	let count = 0;
	let first: string | undefined;
	const summaries: string[] = [];
	let errored = false;
	for (const value of files) {
		const file = objectRecord(value);
		if (Array.isArray(file.messages))
			for (const message of file.messages) {
				if (typeof message !== "string" || message.length === 0) continue;
				count++;
				first ??= message;
			}
		if (typeof file.summary === "string" && file.summary.length > 0)
			summaries.push(boundedText(file.summary));
		if (file.errored === true) errored = true;
	}
	// omp's own card draws nothing without messages.
	if (count === 0) return undefined;
	const view: LateDiagnosticsView = { errored, count };
	const summary = sanitizeOneLine(
		summaries.join(", ").slice(0, MAX_SOURCE_TEXT),
		80,
	);
	if (summary) view.summary = summary;
	const firstMessage = sanitizeOneLine(boundedText(first), MAX_DESCRIPTION);
	if (firstMessage) view.firstMessage = firstMessage;
	return view;
}

/**
 * A user `!`/`$` run. A run still going is omp's provisional message: no
 * exit code and not cancelled (a cancelled or timed-out run records
 * `cancelled`).
 */
export function userExecutionView(message: {
	readonly role: "bashExecution" | "pythonExecution";
	readonly exitCode: unknown;
	readonly cancelled: unknown;
	readonly command?: unknown;
	readonly code?: unknown;
}): UserExecutionView | undefined {
	const bash = message.role === "bashExecution";
	const source = sanitizeOneLine(
		boundedText(bash ? message.command : message.code),
	);
	if (!source) return undefined;
	const cancelled = message.cancelled === true;
	const exitCode =
		typeof message.exitCode === "number" && Number.isFinite(message.exitCode)
			? message.exitCode
			: undefined;
	const view: UserExecutionView = {
		kind: bash ? "bash" : "python",
		source,
		running: exitCode === undefined && !cancelled,
	};
	if (cancelled) view.cancelled = true;
	else if (exitCode !== undefined) view.exitCode = exitCode;
	return view;
}

/**
 * The notes of an advisor card when every one of them is non-blocking and
 * shows cleanly in one row; `undefined` keeps omp's card: a blocker or an
 * unknown severity, malformed or oversized details, a blank note, or text
 * carrying control characters.
 */
export function advisorNoteViews(
	details: unknown,
): readonly AdvisorNoteView[] | undefined {
	const raw = objectRecord(details).notes;
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ADVISOR_NOTES)
		return undefined;
	const notes: AdvisorNoteView[] = [];
	for (const value of raw) {
		const entry = objectRecord(value);
		const { note, severity, advisor } = entry;
		if (
			!isBoundedString(note, MAX_EVIDENCE_TEXT_LENGTH) ||
			!note.trim() ||
			stripRejectedControls(note) !== note
		)
			return undefined;
		// omp draws an omitted severity as a plain nit.
		if (severity !== undefined && severity !== "nit" && severity !== "concern")
			return undefined;
		if (
			advisor !== undefined &&
			(!isBoundedString(advisor, 256) ||
				stripRejectedControls(advisor) !== advisor ||
				/[\r\n\t]/u.test(advisor))
		)
			return undefined;
		notes.push({ note, severity, advisor });
	}
	return notes;
}
