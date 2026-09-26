import { stripRejectedControls } from "./display-control";

/**
 * Scraping of compact tool views from live stock host component instances.
 *
 * Walks public `children` / `getText()` only and probes public accessors —
 * never touches private fields. Every probe returns `undefined` on any shape
 * mismatch so callers fail open to native rendering. This half depends on
 * stock's internal component shape and is the part that needs re-verification
 * on every host upgrade; row rendering lives in render.ts.
 */

/**
 * Strip ANSI CSI (ESC[) and OSC (ESC]) sequences. Unlike git-records.ts
 * `oneLine`, this is pure escape stripping: it does not collapse whitespace,
 * enforce a length budget, or reject control characters — those stay in
 * `stripRejectedControls` / `sanitizeOneLine` so multi-line inject and todo
 * recovery can keep TAB/LF/CR structure after ANSI is gone.
 *
 * Not `Bun.stripANSI`: it reads a lone C1 CSI (U+009B) as a sequence
 * introducer and drops the text after it (`ok\x9B中😀` → `ok`). Here a stray
 * C1 is a control that `stripRejectedControls` drops, and the text stays.
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

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_FILE_RE = new RegExp(
	`${ESC}\\]8;[^;]*;file://([^${ESC}${BEL}]+?)(?:${ESC}\\\\|${BEL})`,
);

export const MAX_DESCRIPTION = 220;

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

export function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
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
 * Checkbox glyphs for every built-in symbol preset (stock
 * `modes/theme/symbols.ts` `SYMBOL_PRESETS`): unicode "☑"/"☐", nerd
 * "\uf14a"/"\uf096", ascii "[x]"/"[ ]". The ASCII glyphs contain a space, so
 * a generic leading-token strip cannot work for them.
 */
const CHECKBOX_GLYPHS = ["☑", "☐", "\uf14a", "\uf096", "[x]", "[ ]"];

/**
 * Strip the leading checkbox glyph (and the separator space) from a stock
 * todo-reminder body line. Built-in presets are matched exactly; a custom
 * theme with a single-token glyph falls back to dropping one leading token.
 */
function stripCheckboxGlyph(line: string): string {
	for (const glyph of CHECKBOX_GLYPHS) {
		if (line.startsWith(glyph)) {
			return line.slice(glyph.length).replace(/^\s+/, "");
		}
	}
	return line.replace(/^\S+\s+/, "");
}

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
			// Stock body lines are "  <checkbox> <content>"; the checkbox
			// glyph varies per symbol preset, and the ASCII preset's "[ ]"
			// contains a space, so strip the known glyph rather than a
			// generic leading token.
			const trimmed = segment.replace(/^\s+/, "").trimEnd();
			if (!trimmed) continue;
			const content = sanitizeOneLine(
				stripCheckboxGlyph(trimmed),
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
 * Marker lines emitted by the stock status footer (stock
 * `modes/components/execution-shared.ts` `buildStatusFooter`): the
 * hidden-line hint, the exit/cancel marker, and the truncation notice.
 */
const FOOTER_MARKER_LINES = [
	/^…\s+\d+\s+more lines \(ctrl\+o to expand\)$/i,
	/^\(cancelled\)$/i,
	/^\(exit\s+-?\d+\)$/i,
	/^Showing\b/i,
];

/**
 * Best-effort recovery of exit/cancel markers from the stock status footer
 * when `setComplete` was not observed (e.g. hydrated history). Prefer
 * observed `setComplete` args; this is only a fallback.
 *
 * Both execution components append the footer as the LAST text-bearing
 * child of their content container (`#updateDisplay`, after header and
 * output), and every line of it belongs to the marker vocabulary above. A
 * text node qualifies only when both hold, so unrelated leaves — the
 * command header (`$ echo "build failed (exit 3)"`), the output text —
 * fail closed instead of faking an exit code from their content.
 */
function scrapeExecutionFooter(
	block: unknown,
): Pick<UserExecutionView, "exitCode" | "cancelled"> | undefined {
	const texts: string[] = [];
	collectComponentTexts(block, texts);
	const raw = texts[texts.length - 1];
	if (raw === undefined) return undefined;
	const plain = stripRejectedControls(stripAnsi(raw)).trim();
	if (!plain) return undefined;
	const lines = plain
		.split(/\r\n|\n|\r/)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line !== "");
	if (lines.length === 0) return undefined;
	if (lines.some((line) => !FOOTER_MARKER_LINES.some((re) => re.test(line)))) {
		// Not the stock status footer: recover nothing rather than guess.
		return undefined;
	}
	let exitCode: number | undefined;
	let cancelled: boolean | undefined;
	for (const line of lines) {
		if (/^\(cancelled\)$/i.test(line)) cancelled = true;
		const exit = line.match(/^\(exit\s+(-?\d+)\)$/i);
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

interface RenderableChild {
	render(width: number): readonly string[];
}

function getRenderableChild(value: unknown): RenderableChild | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (
		"render" in value &&
		typeof (value as { render?: unknown }).render === "function"
	) {
		return value as RenderableChild;
	}
	return undefined;
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
	if (candidate.message) {
		const message = record(candidate.message);
		// Pin literal to OMP 17.3.4 session/messages.ts:42 SKILL_PROMPT_MESSAGE_TYPE.
		if (message.customType !== "skill-prompt") return undefined;

		const details = record(message.details);
		const rawName = typeof details.name === "string" ? details.name.trim() : "";
		const name = sanitizeOneLine(rawName || "unknown", 80);
		if (!name) return undefined;

		const view: SkillMessageView = { name };
		if (typeof details.args === "string") {
			const args = sanitizeOneLine(
				details.args.replace(/\s+/g, " ").trim(),
				120,
			);
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

	// OMP >= 18.2.5: #message is private. Scrape from the callout child.
	const child = getRenderableChild(
		Array.isArray(candidate.children) ? candidate.children[0] : undefined,
	);
	if (!child) return undefined;
	const rows = child.render(120);
	let name: string | undefined;
	let lineCount: number | undefined;
	let path: string | undefined;
	for (const raw of rows) {
		if (!path) {
			const om = raw.match(OSC_FILE_RE);
			if (om?.[1]) path = om[1];
		}
		const stripped = stripAnsi(raw);
		if (!name) {
			const m =
				stripped.match(/[✦*]\s*([^\s]+)/) ?? stripped.match(/\/skill:([^\s]+)/);
			if (m?.[1]) name = m[1];
		}
		if (lineCount === undefined) {
			const lm = stripped.match(/(\d+)\s+lines?\b/i);
			if (lm?.[1]) lineCount = parseInt(lm[1], 10);
		}
	}
	if (!name) return undefined;
	const view: SkillMessageView = { name: sanitizeOneLine(name, 80) };
	if (path) {
		const cleanPath = sanitizeOneLine(path, 120);
		if (cleanPath) view.path = cleanPath;
	}
	if (lineCount !== undefined && Number.isFinite(lineCount) && lineCount >= 0) {
		view.lineCount = Math.trunc(lineCount);
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
	if (Array.isArray(candidate.files)) {
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

	// OMP >= 18.2.5: files moved to #files private field. Scrape from Disclosure child.
	const disclosure = getRenderableChild(
		Array.isArray(candidate.children) ? candidate.children[0] : undefined,
	);
	if (!disclosure) return undefined;
	const rows = disclosure.render(120).map(stripAnsi);
	if (rows.length === 0) return undefined;
	const r0 = rows[0];
	if (!r0?.includes("Late diagnostics")) return undefined;
	const errored = r0.includes("✘");
	const summaryMatch = r0.match(/\(([^)]+)\)/);
	const summary = summaryMatch?.[1] ? summaryMatch[1].trim() : undefined;
	let firstMessage: string | undefined;
	for (let i = 1; i < rows.length; i++) {
		const line = rows[i];
		if (!line) continue;
		const trimmed = line.trim();
		const m = trimmed.match(/^└─\s*(.+)$/);
		if (m?.[1]) {
			firstMessage = m[1].trim();
			break;
		}
	}
	let count = 1;
	if (summary) {
		const cm = summary.match(
			/(\d+)\s+(?:error|warning|problem|issue|diagnostic)/i,
		);
		if (cm?.[1]) count = parseInt(cm[1], 10);
	}
	const view: LateDiagnosticsView = {
		errored,
		count,
	};
	if (summary) {
		const cleanSummary = sanitizeOneLine(summary, 80);
		if (cleanSummary) view.summary = cleanSummary;
	}
	if (firstMessage) {
		const cleanFirst = sanitizeOneLine(firstMessage, MAX_DESCRIPTION);
		if (cleanFirst) view.firstMessage = cleanFirst;
	}
	if (observed?.expanded === true) view.expanded = true;
	if (observed?.expanded === false) view.expanded = false;
	return Object.freeze(view);
}
