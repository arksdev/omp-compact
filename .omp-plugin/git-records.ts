import { codePointLength, truncateCodePoints } from "./compact";
import { isRejectedControlCode } from "./display-control";
import { MAX_GIT_SUBCOMMAND_LENGTH } from "./hydration-bounds";

export interface GitEvidence {
	command: string;
	resultText: string;
	isError: boolean;
}

export interface GitCommand {
	subcommand: string;
	/** True when the command followed exactly one `cd <path> &&` prefix. */
	gated: boolean;
}

export interface GitRecordResult {
	subcommand: string;
	/** Bounded, display-safe row for this single invocation. */
	text: string;
	isError: boolean;
}

interface GitSegment {
	tokens: readonly string[];
	subcommand: string;
	subcommandIndex: number;
	/** True when the invocation followed exactly one `cd <path> &&` prefix. */
	cdGated: boolean;
}

interface GitChain {
	segments: GitSegment[];
}

const MAX_COMMAND_LENGTH = 16_384;
const MAX_COMMANDS = 8;
const MAX_TOKENS = 96;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_RECORD_LENGTH = 240;
const MAX_RESULT_SCAN_LENGTH = 2_048;

const MAX_SUBSTITUTION_DEPTH = 1;

function isBlank(character: string | undefined): boolean {
	return (
		character === undefined ||
		character === " " ||
		character === "\t" ||
		character === "\f" ||
		character === "\v" ||
		character === "\n" ||
		character === "\r"
	);
}

/**
 * Decode the backslash escapes `printf` applies to its format string. Only
 * escapes that stand for one literal character are accepted; anything else
 * (`\0NNN`, `\xHH`, `\c`, …) fails recognition closed rather than guessing
 * what the shell wrote.
 */
function decodePrintfEscapes(value: string): string | undefined {
	if (!value.includes("\\")) return value;
	const parts: string[] = [];
	let start = 0;
	for (let index = 0; index < value.length; index++) {
		if (value[index] !== "\\") continue;
		let literal: string;
		switch (value[index + 1]) {
			case "n":
				literal = "\n";
				break;
			case "t":
				literal = "\t";
				break;
			case "r":
				literal = "\r";
				break;
			case "\\":
				literal = "\\";
				break;
			default:
				return undefined;
		}
		parts.push(value.slice(start, index), literal);
		index++;
		start = index + 1;
	}
	parts.push(value.slice(start));
	return parts.join("");
}

interface InertSubstitution {
	value: string;
	/** Offset just past the closing paren. */
	end: number;
}

/**
 * Read a `"$( … )"` substitution that provably produces text without running
 * anything of consequence: one `printf` or `echo` with a single literal
 * argument, the form an agent writes for a commit message with a body. The
 * inner source goes through this same tokenizer, so pipes, redirects,
 * backticks and further substitutions fail there; the depth bound stops the
 * recursion one level in. A `printf` conversion (`%s`) is refused as well —
 * resolving it needs the operands this parser must not evaluate.
 */
function readInertSubstitution(
	source: string,
	start: number,
	depth: number,
): InertSubstitution | undefined {
	if (depth >= MAX_SUBSTITUTION_DEPTH) return undefined;
	let cursor = start + 2;
	let quote: string | undefined;
	while (cursor < source.length) {
		const character = source[cursor];
		if (character === "\n" || character === "\r") return undefined;
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			cursor++;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			cursor++;
			continue;
		}
		// A nested paren or an unquoted backslash needs shell semantics this
		// scan does not have.
		if (character === "(" || character === "\\") return undefined;
		if (character === ")") break;
		cursor++;
	}
	if (source[cursor] !== ")") return undefined;
	const commands = tokenizeCommands(source.slice(start + 2, cursor), depth + 1);
	const tokens = commands?.length === 1 ? commands[0] : undefined;
	if (!tokens || tokens.length !== 2) return undefined;
	const argument = tokens[1];
	if (argument === undefined) return undefined;
	const end = cursor + 1;
	if (tokens[0] === "printf") {
		if (argument.includes("%")) return undefined;
		const value = decodePrintfEscapes(argument);
		return value === undefined ? undefined : { value, end };
	}
	if (tokens[0] === "echo") {
		// Flags change what echo writes, and shells disagree about whether it
		// decodes escapes at all.
		if (argument.startsWith("-") || argument.includes("\\")) return undefined;
		return { value: argument, end };
	}
	return undefined;
}

/**
 * Tokenize a deliberately small, non-evaluating shell grammar. Only `&&` and
 * `;` are accepted as command separators; other shell syntax that could expand
 * or add a command is rejected rather than interpreted. The two exceptions are
 * text the grammar can carry without evaluating anything: a brace list inside
 * a word (`src/{a,b}` — kept verbatim, never expanded) and a double-quoted
 * substitution that only prints its own argument (see readInertSubstitution).
 */
function tokenizeCommands(source: string, depth = 0): string[][] | undefined {
	if (!source || source.length > MAX_COMMAND_LENGTH) return undefined;

	const commands: string[][] = [];
	let command: string[] = [];
	let tokenStarted = false;
	let rawStart = 0;
	let pieces: string[] | undefined;

	const appendRaw = (end: number): void => {
		if (!pieces) pieces = [];
		if (rawStart < end) pieces.push(source.slice(rawStart, end));
	};

	const appendLiteral = (value: string): void => {
		if (!pieces) pieces = [];
		pieces.push(value);
	};

	const finishWord = (end: number): boolean => {
		if (!tokenStarted) return true;
		let token: string;
		if (pieces) {
			if (rawStart < end) pieces.push(source.slice(rawStart, end));
			token = pieces.join("");
		} else {
			token = source.slice(rawStart, end);
		}
		if (token.length > MAX_TOKEN_LENGTH || command.length >= MAX_TOKENS)
			return false;
		command.push(token);
		tokenStarted = false;
		rawStart = end;
		pieces = undefined;
		return true;
	};

	const finishCommand = (end: number): boolean => {
		if (
			!finishWord(end) ||
			command.length === 0 ||
			commands.length >= MAX_COMMANDS
		)
			return false;
		commands.push(command);
		command = [];
		return true;
	};

	for (let index = 0; index < source.length; ) {
		const character = source[index];
		if (
			character === " " ||
			character === "\t" ||
			character === "\f" ||
			character === "\v"
		) {
			if (!finishWord(index)) return undefined;
			index++;
			rawStart = index;
			continue;
		}
		if (character === "\n" || character === "\r") return undefined;

		if (character === "'" || character === '"') {
			if (!tokenStarted) {
				tokenStarted = true;
				rawStart = index;
			}
			appendRaw(index);
			const quote = character;
			index++;
			let quotedStart = index;
			let closed = false;

			while (index < source.length) {
				const quoted = source[index];
				if (quoted === "\n" || quoted === "\r") return undefined;
				if (quoted === quote) {
					if (quotedStart < index)
						appendLiteral(source.slice(quotedStart, index));
					index++;
					rawStart = index;
					closed = true;
					break;
				}

				if (quote === '"') {
					if (quoted === "$") {
						if (source[index + 1] !== "(") return undefined;
						const inert = readInertSubstitution(source, index, depth);
						if (!inert) return undefined;
						if (quotedStart < index)
							appendLiteral(source.slice(quotedStart, index));
						appendLiteral(inert.value);
						index = inert.end;
						quotedStart = index;
						continue;
					}
					if (quoted === "`") return undefined;
					if (quoted === "\\") {
						const escaped = source[index + 1];
						if (!escaped || escaped === "\n" || escaped === "\r")
							return undefined;
						if (
							escaped === '"' ||
							escaped === "\\" ||
							escaped === "$" ||
							escaped === "`"
						) {
							if (quotedStart < index)
								appendLiteral(source.slice(quotedStart, index));
							appendLiteral(escaped);
							index += 2;
							quotedStart = index;
							continue;
						}
					}
				}
				index++;
			}

			if (!closed) return undefined;
			continue;
		}

		if (character === "\\") {
			if (!tokenStarted) {
				tokenStarted = true;
				rawStart = index;
			}
			const escaped = source[index + 1];
			if (!escaped || escaped === "\n" || escaped === "\r") return undefined;
			appendRaw(index);
			appendLiteral(escaped);
			index += 2;
			rawStart = index;
			continue;
		}

		if (character === "&") {
			if (source[index + 1] !== "&" || !finishCommand(index)) return undefined;
			index += 2;
			rawStart = index;
			continue;
		}

		if (character === ";") {
			if (!finishCommand(index)) return undefined;
			index++;
			rawStart = index;
			continue;
		}

		// A brace list inside a word (`src/hud/{a,b}`) is expansion the parser
		// keeps verbatim: it cannot add a command, and the row shows exactly
		// what was typed. A brace command GROUP (`{ list; }`) would change the
		// command boundaries, so an opening brace followed by blank space, or
		// a closing brace at command position, still fails the parse closed.
		if (character === "{" && !isBlank(source[index + 1])) {
			if (!tokenStarted) {
				tokenStarted = true;
				rawStart = index;
			}
			index++;
			continue;
		}
		if (character === "}" && tokenStarted) {
			index++;
			continue;
		}

		if (
			character === "|" ||
			character === "<" ||
			character === ">" ||
			character === "(" ||
			character === ")" ||
			character === "{" ||
			character === "}" ||
			character === "$" ||
			character === "`" ||
			character === "#" ||
			character === "!"
		)
			return undefined;

		if (!tokenStarted) {
			tokenStarted = true;
			rawStart = index;
		}
		index++;
	}

	if (
		!finishWord(source.length) ||
		command.length === 0 ||
		commands.length >= MAX_COMMANDS
	)
		return undefined;
	commands.push(command);
	return commands;
}

function isCdPrefix(tokens: readonly string[]): boolean {
	const head = tokens[0];
	if (head !== "cd") return false;
	if (tokens.length === 2) {
		const path = tokens[1];
		return path !== undefined && path.length > 0;
	}
	if (tokens.length === 3) {
		const dd = tokens[1];
		const path = tokens[2];
		return dd === "--" && path !== undefined && path.length > 0;
	}
	return false;
}

function takesGitOptionValue(token: string): boolean {
	switch (token) {
		case "-C":
		case "-c":
		case "--config-env":
		case "--exec-path":
		case "--git-dir":
		case "--work-tree":
		case "--namespace":
		case "--super-prefix":
		case "--attr-source":
			return true;
		default:
			return false;
	}
}

function hasInlineGitOptionValue(token: string): boolean {
	return (
		(token.startsWith("-C") && token.length > 2) ||
		(token.startsWith("-c") && token.length > 2) ||
		token.startsWith("--config-env=") ||
		token.startsWith("--exec-path=") ||
		token.startsWith("--git-dir=") ||
		token.startsWith("--work-tree=") ||
		token.startsWith("--namespace=") ||
		token.startsWith("--super-prefix=") ||
		token.startsWith("--attr-source=")
	);
}

function isValueFreeGitOption(token: string): boolean {
	switch (token) {
		case "--bare":
		case "--no-replace-objects":
		case "--literal-pathspecs":
		case "--glob-pathspecs":
		case "--noglob-pathspecs":
		case "--icase-pathspecs":
		case "--no-optional-locks":
		case "--no-lazy-fetch":
		case "--paginate":
		case "--no-pager":
		case "-p":
		case "-P":
		case "--version":
		case "--help":
		case "--html-path":
		case "--man-path":
		case "--info-path":
		case "--build-options":
			return true;
		default:
			return false;
	}
}

function gitSubcommandIndex(
	tokens: readonly string[],
	start: number,
): number | undefined {
	for (let index = start; index < tokens.length; ) {
		const token = tokens[index];
		if (token === undefined) return undefined;
		if (token === "--") {
			index++;
			const next = tokens[index];
			return next !== undefined && next.length > 0 ? index : undefined;
		}
		if (takesGitOptionValue(token)) {
			if (index + 1 >= tokens.length) return undefined;
			index += 2;
			continue;
		}
		if (hasInlineGitOptionValue(token) || isValueFreeGitOption(token)) {
			index++;
			continue;
		}
		if (token.startsWith("-")) return undefined;
		return token.length > 0 ? index : undefined;
	}
	return undefined;
}

function parseGitInvocationTokens(
	tokens: readonly string[],
): Omit<GitSegment, "cdGated"> | undefined {
	let gitIndex = 0;
	if (tokens[gitIndex] === "command") {
		gitIndex++;
		if (tokens[gitIndex] === "--") gitIndex++;
	}
	if (tokens[gitIndex] !== "git") return undefined;

	const subcommandIndex = gitSubcommandIndex(tokens, gitIndex + 1);
	if (subcommandIndex === undefined) return undefined;
	const subcommand = tokens[subcommandIndex];
	// gitSubcommandIndex only returns an in-range index of a non-empty token.
	if (subcommand === undefined) return undefined;
	// The hydration gate (isGitRecordDetails in messages.ts, via isBoundedString
	// with MAX_GIT_SUBCOMMAND_LENGTH in hydration-bounds.ts) rejects persisted
	// subcommands longer than the bound; the tokenizer's own cap is
	// MAX_TOKEN_LENGTH (4_096 — an input-budget concern, not a field-width
	// one). Emitting a record here would write a carrier that the replay
	// path silently drops (rebuild-lifecycle.ts #hydrateEvidence skips it),
	// so fail closed at recognition instead — a subcommand the hydration
	// gate would reject is never a recognized Git invocation.
	if (subcommand.length > MAX_GIT_SUBCOMMAND_LENGTH) return undefined;
	return {
		tokens,
		subcommand,
		subcommandIndex,
	};
}

/**
 * Parse every `&&`- or `;`-joined segment of one bounded, non-evaluating shell
 * command. A leading `cd <path> &&` or `cd <path>;` is shell bookkeeping, not
 * an invocation; every other segment must itself be a proven simple Git
 * invocation. Any other shell text (echo, pipes, control flow, …) fails the
 * whole chain closed so arbitrary compound shell is never turned into a Git
 * audit.
 */
function parseGitChain(command: string): GitChain | undefined {
	const commands = tokenizeCommands(command);
	if (!commands || commands.length === 0) return undefined;

	const head = commands[0];
	if (head === undefined) return undefined;
	const start = isCdPrefix(head) ? 1 : 0;
	const segments: GitSegment[] = [];
	for (let index = start; index < commands.length; index++) {
		const segmentTokens = commands[index];
		if (segmentTokens === undefined) return undefined;
		const parsed = parseGitInvocationTokens(segmentTokens);
		if (!parsed) return undefined;
		segments.push({ ...parsed, cdGated: start === 1 && index === 1 });
	}
	return segments.length > 0 ? { segments } : undefined;
}

/**
 * Recognize every proven Git invocation of one shell-simple command joined by
 * `&&` or `;`, in command order. The parser intentionally has no execution
 * path.
 */
export function recognizeGitCommands(
	command: string,
): GitCommand[] | undefined {
	const chain = parseGitChain(command);
	if (!chain) return undefined;
	return chain.segments.map((segment) => ({
		subcommand: segment.subcommand,
		gated: segment.cdGated,
	}));
}

function skipEscapeSequence(value: string, index: number): number {
	if (value.charCodeAt(index + 1) !== 0x5b) return index;
	for (let cursor = index + 2; cursor < value.length; cursor++) {
		const code = value.charCodeAt(cursor);
		if (code >= 0x40 && code <= 0x7e) return cursor;
	}
	return value.length;
}

/**
 * Collapse whitespace and strip ANSI escapes into a single bounded line.
 * Uses array accumulation to avoid O(n²) string concatenation for long
 * inputs near MAX_RECORD_LENGTH. Rejected controls share the class in
 * `display-control` (DEL, C1, U+2028/U+2029, other C0); TAB/LF/CR are
 * treated as whitespace here and collapsed into a single space — unlike
 * render's multi-line path, which keeps those structural breaks.
 */
function oneLine(value: string, limit = MAX_RECORD_LENGTH): string {
	const parts: string[] = [];
	let length = 0;
	let pendingSpace = false;
	for (let index = 0; index < value.length && length < limit; ) {
		const unit = value.charCodeAt(index);
		if (unit === 0x1b) {
			index = skipEscapeSequence(value, index) + 1;
			continue;
		}
		// Advance by code point so astral pairs stay intact and the class
		// check never sees a lone high surrogate as a separate character.
		const code = value.codePointAt(index) ?? unit;
		const width = code > 0xffff ? 2 : 1;
		// Shared rejected class, plus TAB/LF/CR/space which oneLine collapses
		// (row shaping — render keeps those structural breaks instead).
		const isWhitespace =
			code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20;
		if (isWhitespace || isRejectedControlCode(code)) {
			if (parts.length > 0 || length > 0) pendingSpace = true;
			index += width;
			continue;
		}
		if (pendingSpace) {
			if (length >= limit) break;
			parts.push(" ");
			length++;
			pendingSpace = false;
		}
		parts.push(value.slice(index, index + width));
		length++;
		index += width;
	}
	return parts.join("");
}

function appendDetail(base: string, detail: string): string {
	if (!detail) return base;
	if (base.length + 1 + detail.length <= MAX_RECORD_LENGTH) {
		return `${base} ${detail}`;
	}
	// Budget counts code points to match oneLine and prevent surrogate splits.
	const baseLength = codePointLength(base);
	if (baseLength >= MAX_RECORD_LENGTH) return base;
	const available = MAX_RECORD_LENGTH - baseLength - 1;
	const detailLength = codePointLength(detail);
	if (detailLength <= available) return `${base} ${detail}`;
	if (available <= 1) return `${base}…`;
	return `${base} ${truncateCodePoints(detail, available - 1)}…`;
}

function renderInvocation(invocation: GitSegment): string {
	let rendered = "git";
	for (
		let index = invocation.subcommandIndex;
		index < invocation.tokens.length;
		index++
	) {
		const raw = invocation.tokens[index];
		if (raw === undefined) continue;
		const token = oneLine(raw);
		if (!token) continue;
		const next = appendDetail(rendered, token);
		if (next === rendered) break;
		rendered = next;
		if (rendered.endsWith("…")) break;
	}
	return rendered;
}

function firstResultLine(resultText: string): string {
	const end = Math.min(resultText.length, MAX_RESULT_SCAN_LENGTH);
	let start = 0;
	while (start < end) {
		let lineEnd = start;
		while (
			lineEnd < end &&
			resultText[lineEnd] !== "\n" &&
			resultText[lineEnd] !== "\r"
		)
			lineEnd++;
		const line = oneLine(resultText.slice(start, lineEnd));
		if (line) return line;
		while (
			lineEnd < end &&
			(resultText[lineEnd] === "\n" || resultText[lineEnd] === "\r")
		)
			lineEnd++;
		start = lineEnd;
	}
	return "";
}

function commitSummary(
	resultText: string,
): { hash: string; subject: string } | undefined {
	const end = Math.min(resultText.length, MAX_RESULT_SCAN_LENGTH);
	let start = 0;
	let banner: RegExpExecArray | undefined;
	for (let lines = 0; start < end && lines < 8; lines++) {
		let lineEnd = start;
		while (
			lineEnd < end &&
			resultText[lineEnd] !== "\n" &&
			resultText[lineEnd] !== "\r"
		)
			lineEnd++;
		const line = oneLine(resultText.slice(start, lineEnd));
		const match = COMMIT_SUMMARY_LINE.exec(line);
		// A second banner-shaped line makes the capture ambiguous: hook
		// output can sit on either side of the real banner depending on the
		// git version, so no first/last ordering rule discriminates. Fail
		// closed instead of picking one (see the pattern's comment).
		if (match) {
			if (banner) return undefined;
			banner = match;
		}
		while (
			lineEnd < end &&
			(resultText[lineEnd] === "\n" || resultText[lineEnd] === "\r")
		)
			lineEnd++;
		start = lineEnd;
	}
	if (!banner) return undefined;
	// Both capturing groups are required by the pattern; a successful
	// match always populates them (subject may be the empty string).
	const hash = banner[1];
	const subject = banner[2];
	if (hash === undefined || subject === undefined) return undefined;
	return { hash, subject: oneLine(subject) };
}

/**
 * The banner git prints after a successful commit: `[<branch> <hash>]
 * <subject>`, `[<branch> (root-commit) <hash>] <subject>` for the initial
 * commit, or `[detached HEAD <hash>] <subject>` outside a branch.
 *
 * The branch token is restricted to git's ref-name characters
 * (git-check-ref-format: no space, `~ ^ : ? * [ \` or control bytes, and no
 * `]`). That alone stops a bracket-labeled line whose token is not a legal
 * ref name — `[a[b 0badf00d]  …`, `[hook chatter deadbeef] …`. It does NOT
 * stop a line whose content is a legal ref name plus a hex blob: `pre-commit`
 * and `main` are legal ref names, so `[pre-commit a1b2c3d] …` and, after ANSI
 * stripping, a wrapped `[main deadbeef] …` match the same character class as
 * a genuine banner. No ordering rule discriminates either — on git 2.50 the
 * pre-commit, commit-msg AND post-commit hooks all print before the summary
 * line, but that is an implementation detail rather than a contract, and the
 * capture is a whole Bash call's output, not git's stdout alone.
 * commitSummary therefore attributes only when the scan window holds EXACTLY
 * ONE banner-shaped line; two or more mean the capture is ambiguous and
 * nothing is attributed — the same fail-closed stance this file already
 * takes for several commit segments. Accepted ceiling: a lone banner-shaped
 * line with the real banner absent from the capture is indistinguishable
 * from the genuine article and is attributed.
 */
const COMMIT_SUMMARY_LINE =
	/^\[(?:detached HEAD|[^\]\s~^:?*\\[\p{Cc}]+)(?:\s\(root-commit\))?\s([\da-f]{4,64})\]\s*(.*)$/iu;

const LINE_BREAK = /[\n\r]/u;

/**
 * The subject `git commit` writes for one recognized invocation: the first
 * line of its `-m`/`--message` value. Messages that live outside the command
 * (`-F file`, an editor session) have no subject here.
 */
function commitMessageSubject(segment: GitSegment): string | undefined {
	const tokens = segment.tokens;
	for (
		let index = segment.subcommandIndex + 1;
		index < tokens.length;
		index++
	) {
		const token = tokens[index];
		if (token === undefined || !token.startsWith("-")) continue;
		// Everything past `--` is a pathspec, message flags included.
		if (token === "--") return undefined;
		let value: string | undefined;
		if (token.startsWith("--message=")) value = token.slice(10);
		else if (token === "--message") value = tokens[index + 1];
		else if (token.startsWith("--")) continue;
		else if (token.length > 2 && token.startsWith("-m")) value = token.slice(2);
		// A single-dash cluster ending in `m` takes the next word: `-m`, `-qm`.
		else if (token.endsWith("m")) value = tokens[index + 1];
		else continue;
		if (value === undefined) return undefined;
		const breakIndex = value.search(LINE_BREAK);
		return (
			oneLine(breakIndex < 0 ? value : value.slice(0, breakIndex)) || undefined
		);
	}
	return undefined;
}

/** A `git log --oneline` line: abbreviated hash plus the commit subject. */
const ONELINE_LOG_LINE = /^([\da-f]{4,64})\s+(.+)$/iu;

/**
 * `git commit -q` prints no banner, so the hash it created can only come from
 * a later invocation of the same call. A `git log` right after the commit
 * prints HEAD first, and HEAD after a successful commit IS that commit — a
 * successful call proves every segment ran. The hash is therefore taken only
 * when the leading line of the capture carries one together with exactly the
 * committed subject. A `git log` anywhere before the commit could have printed
 * the pre-commit HEAD under that same subject (an amend, a retried commit), so
 * its presence fails the proof closed.
 */
function quietCommitHash(
	segments: readonly GitSegment[],
	commitIndex: number,
	resultText: string,
): { hash: string; subject: string } | undefined {
	const commit = segments[commitIndex];
	if (!commit || segments[commitIndex + 1]?.subcommand !== "log")
		return undefined;
	for (let index = 0; index < commitIndex; index++)
		if (segments[index]?.subcommand === "log") return undefined;
	const subject = commitMessageSubject(commit);
	if (subject === undefined) return undefined;
	const match = ONELINE_LOG_LINE.exec(firstResultLine(resultText));
	const hash = match?.[1];
	if (hash === undefined || match?.[2] !== subject) return undefined;
	return { hash, subject };
}

/**
 * Produce bounded, display-safe Git rows for every proven invocation of one
 * Bash call, in command order, using only the already captured command and
 * result text. A failed Git command never borrows success output.
 *
 * Attribution is deliberately conservative:
 * - A successful call proves every segment ran; each gets its own row.
 * - A failed call can only prove a lone direct Git invocation ran (and
 *   failed); cd-gated commands and compounds fail closed rather than guess
 *   which segment the shell stopped at.
 * - Output evidence goes only to the single commit of a chain (via its
 *   `[branch hash] subject` summary, or a following `git log` when `-q`
 *   suppressed that summary) or the final bare segment — a commit summary
 *   line is never attributed to a non-commit invocation.
 */
export function formatGitRecords(
	evidence: GitEvidence,
): GitRecordResult[] | undefined {
	if (
		!evidence ||
		typeof evidence.command !== "string" ||
		typeof evidence.resultText !== "string"
	)
		return undefined;

	const chain = parseGitChain(evidence.command);
	if (!chain) return undefined;
	const segments = chain.segments;

	if (evidence.isError) {
		// A failed gated command cannot prove Git ever ran: the shell may have
		// stopped at the `cd` itself. A failed compound cannot attribute the
		// failure to a specific segment. Both fail closed rather than retain
		// a row that may not have executed.
		const only = segments[0];
		if (segments.length !== 1 || only === undefined || only.cdGated)
			return undefined;
		return [
			{
				subcommand: only.subcommand,
				text: `✗ ${renderInvocation(only)}`,
				isError: true,
			},
		];
	}

	const commitSegments = segments.filter(
		(segment) => segment.subcommand === "commit",
	);
	// A commit summary line identifies exactly one commit; with several
	// commit segments the evidence cannot be attributed to a specific one.
	const soleCommit =
		commitSegments.length === 1 ? commitSegments[0] : undefined;
	const soleCommitIndex = soleCommit ? segments.indexOf(soleCommit) : -1;
	const last = segments[segments.length - 1];

	const records: GitRecordResult[] = [];
	for (const segment of segments) {
		const rendered = renderInvocation(segment);
		let text = rendered;
		if (segment === soleCommit) {
			const summary =
				commitSummary(evidence.resultText) ??
				quietCommitHash(segments, soleCommitIndex, evidence.resultText);
			if (summary) {
				text = appendDetail(`git commit ${summary.hash}`, summary.subject);
			}
		} else if (
			segment === last &&
			segment.subcommandIndex + 1 === segment.tokens.length
		) {
			// The final bare invocation may own the call's output — but never
			// a commit summary line produced by an earlier segment.
			const line = firstResultLine(evidence.resultText);
			if (line && !COMMIT_SUMMARY_LINE.test(line)) {
				text = appendDetail(rendered, line);
			}
		}
		records.push({ subcommand: segment.subcommand, text, isError: false });
	}
	return records;
}
