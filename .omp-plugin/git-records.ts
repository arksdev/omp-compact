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

/**
 * Tokenize a deliberately small, non-evaluating shell grammar. Shell syntax
 * that could expand or add a command is rejected rather than interpreted.
 */
function tokenizeCommands(source: string): string[][] | undefined {
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
					if (quoted === "$" || quoted === "`") return undefined;
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

		if (
			character === ";" ||
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
	return (
		(tokens.length === 2 && tokens[0] === "cd" && tokens[1].length > 0) ||
		(tokens.length === 3 &&
			tokens[0] === "cd" &&
			tokens[1] === "--" &&
			tokens[2].length > 0)
	);
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
		if (token === "--") {
			index++;
			return index < tokens.length && tokens[index].length > 0
				? index
				: undefined;
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
	return {
		tokens,
		subcommand: tokens[subcommandIndex],
		subcommandIndex,
	};
}

/**
 * Parse every `&&`-joined segment of one bounded, non-evaluating shell
 * command. A leading `cd <path> &&` is shell bookkeeping, not an invocation;
 * every other segment must itself be a proven simple Git invocation. Any
 * other shell text (echo, pipes, control flow, …) fails the whole chain
 * closed so arbitrary compound shell is never turned into a Git audit.
 */
function parseGitChain(command: string): GitChain | undefined {
	const commands = tokenizeCommands(command);
	if (!commands || commands.length === 0) return undefined;

	const start = isCdPrefix(commands[0]) ? 1 : 0;
	const segments: GitSegment[] = [];
	for (let index = start; index < commands.length; index++) {
		const parsed = parseGitInvocationTokens(commands[index]);
		if (!parsed) return undefined;
		segments.push({ ...parsed, cdGated: start === 1 && index === 1 });
	}
	return segments.length > 0 ? { segments } : undefined;
}

/**
 * Recognize every proven Git invocation of one shell-simple command, in
 * command order. The parser intentionally has no execution path.
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

/**
 * Recognize one shell-simple Git command, optionally preceded by exactly one
 * `cd <path> &&`. For compound chains this returns the first invocation; use
 * `recognizeGitCommands` for the full ordered set. The parser intentionally
 * has no execution path.
 */
export function recognizeGitCommand(command: string): GitCommand | undefined {
	const chain = parseGitChain(command);
	if (!chain) return undefined;
	const first = chain.segments[0];
	return { subcommand: first.subcommand, gated: first.cdGated };
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
 * inputs near MAX_RECORD_LENGTH.
 */
function oneLine(value: string, limit = MAX_RECORD_LENGTH): string {
	const parts: string[] = [];
	let length = 0;
	let pendingSpace = false;
	for (let index = 0; index < value.length && length < limit; index++) {
		const code = value.charCodeAt(index);
		if (code === 0x1b) {
			index = skipEscapeSequence(value, index);
			continue;
		}
		if (code <= 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
			if (parts.length > 0 || length > 0) pendingSpace = true;
			continue;
		}
		if (pendingSpace) {
			if (length >= limit) break;
			parts.push(" ");
			length++;
			pendingSpace = false;
		}
		parts.push(value[index]);
		length++;
	}
	return parts.join("");
}

function appendDetail(base: string, detail: string): string {
	if (!detail || base.length >= MAX_RECORD_LENGTH) return base;
	const available = MAX_RECORD_LENGTH - base.length - 1;
	if (detail.length <= available) return `${base} ${detail}`;
	if (available <= 1) return `${base}…`;
	return `${base} ${detail.slice(0, available - 1)}…`;
}

function renderInvocation(invocation: GitSegment): string {
	let rendered = "git";
	for (
		let index = invocation.subcommandIndex;
		index < invocation.tokens.length;
		index++
	) {
		const token = oneLine(invocation.tokens[index]);
		if (!token) continue;
		rendered = appendDetail(rendered, token);
		if (rendered.length >= MAX_RECORD_LENGTH) break;
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
	for (let lines = 0; start < end && lines < 8; lines++) {
		let lineEnd = start;
		while (
			lineEnd < end &&
			resultText[lineEnd] !== "\n" &&
			resultText[lineEnd] !== "\r"
		)
			lineEnd++;
		const line = oneLine(resultText.slice(start, lineEnd));
		const match = /^\[[^\]]*\s([\da-f]{4,64})\]\s*(.*)$/i.exec(line);
		if (match) {
			return { hash: match[1], subject: oneLine(match[2]) };
		}
		while (
			lineEnd < end &&
			(resultText[lineEnd] === "\n" || resultText[lineEnd] === "\r")
		)
			lineEnd++;
		start = lineEnd;
	}
	return undefined;
}

const COMMIT_SUMMARY_LINE = /^\[[^\]]*\s[\da-f]{4,64}\]/i;

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
 *   `[branch hash] subject` summary) or the final bare segment — a commit
 *   summary line is never attributed to a non-commit invocation.
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
		if (segments.length !== 1 || segments[0].cdGated) return undefined;
		return [
			{
				subcommand: segments[0].subcommand,
				text: `✗ ${renderInvocation(segments[0])}`,
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
	const last = segments[segments.length - 1];

	const records: GitRecordResult[] = [];
	for (const segment of segments) {
		const rendered = renderInvocation(segment);
		let text = rendered;
		if (segment === soleCommit) {
			const summary = commitSummary(evidence.resultText);
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

/**
 * Produce one bounded, display-safe Git row using only the already captured
 * command and result text. A failed Git command never borrows success output.
 * For compound commands this returns the first invocation's row; use
 * `formatGitRecords` for the full ordered set.
 */
export function formatGitRecord(evidence: GitEvidence): string | undefined {
	const records = formatGitRecords(evidence);
	return records && records.length > 0 ? records[0].text : undefined;
}
