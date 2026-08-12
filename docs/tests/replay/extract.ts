/**
 * Replay-fixture extractor (offline maintenance tool, not a test).
 *
 * Reads real OMP session JSONL files from `~/.omp/agent/sessions` (or
 * `OMP_SESSIONS_DIR`) and emits bounded, redacted, structurally-normalized
 * replay fixtures consumed by `replay.test.ts` / `replay-inventory.test.ts`.
 *
 * Raw transcripts are never copied: each fixture keeps only the normalized
 * event stream (tool starts/results, assistant continuations/answers,
 * run/session boundaries) with deterministic path/token placeholders and
 * per-event size caps. Provenance (source file, capture date, redaction
 * notes) lives in each fixture's `meta`.
 *
 * Subagent sessions end at the yield tool without a terminal assistant
 * message; their fixtures end in the live working phase (documented in
 * `meta.terminal`). Main-session runs carry real terminal answers and are
 * replayed through the terminal filter.
 *
 * Usage:
 *   bun run docs/tests/replay/extract.ts --list          # print run summaries for the corpus
 *   bun run docs/tests/replay/extract.ts                 # regenerate docs/tests/replay/fixtures/*.json
 *   OMP_SESSIONS_DIR=/path bun run docs/tests/replay/extract.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface StartRecord {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
}

interface ResultRecord {
	toolCallId: string;
	toolName: string;
	content: unknown[];
	details: unknown;
	isError: boolean;
	pruned: boolean;
}

interface AssistantRecord {
	text: string;
	stopReason: string;
	usage?: Record<string, unknown>;
}

interface Run {
	index: number;
	events: Array<
		| { kind: "start"; start: StartRecord }
		| { kind: "result"; result: ResultRecord }
		| { kind: "assistant"; assistant: AssistantRecord }
	>;
	compactions: number;
	terminal: "stop" | "aborted" | "error" | "toolUse" | "none";
	userPrefix: string;
}

// ---------------------------------------------------------------------------
// Corpus definition. `source` is the session file basename under
// `~/.omp/agent/sessions/<encoded-cwd>/`; every entry is real data from the
// agent sessions that produced this plugin. `runs` selects 0-based run
// indexes (user-message boundaries); `maxTools` caps the tool event pairs
// per run (prefix window); `maxContinue` caps assistant toolUse messages.
// `mode` is a replay parameter (the plugin mode is not recoverable from a
// session file) and `stats` mirrors whether the run carries usage worth
// asserting.
// ---------------------------------------------------------------------------

interface FixtureSpec {
	outId: string;
	file: string;
	dir: string;
	runs: number[];
	maxTools: number;
	maxContinue: number;
	mode: "live" | "compact" | "clear";
	stats: boolean;
	note: string;
}

const ORCA_PLUGINS_DIR =
	"abs-orca-plugins-b4c65499b73e1c6e7bf74c1eea305af696d0fb94431bdb170e7d3b38cce9afcf";

const FIXTURES: FixtureSpec[] = [
	{
		outId: "git-compound-main",
		// Main-session runs that exercised real `git add … && git commit -m …`
		// compound calls and `git status --short --untracked-files=all`, plus
		// the provisional|real composite toolCallId shape.
		file: "2026-08-10T17-50-32-859Z_019feccc-319b-7000-8623-b23e831714bf.jsonl",
		dir: ORCA_PLUGINS_DIR,
		runs: [3, 5],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "real git add/commit compound + status; composite call_U…|fc_… toolCallIds; two terminal runs",
	},
	{
		outId: "git-commit-only-retention",
		// Subagent that implemented git-commit retention: real edit diffs
		// (carrier rows), a failed test run (exit 2), reads with selectors,
		// hub and yield. Session ends at yield: working-phase projection.
		file: "2026-08-10T17-50-32-859Z_019feccc-319b-7000-8623-b23e831714bf/GitCommitOnlyRetention.jsonl",
		dir: ORCA_PLUGINS_DIR,
		runs: [2],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "real edit details.diff carriers; failed bash (exit 2); read path selectors; ends at yield (working phase)",
	},
	{
		outId: "compact-read-groups",
		// Read-group regression subagent: dense read/grep/edit stream with
		// line-selector paths. Replayed in compact mode; the run has no
		// terminal answer in the source, so rows assert the live compact
		// projection.
		file: "2026-08-10T17-50-32-859Z_019feccc-319b-7000-8623-b23e831714bf/CompactReadGroups.jsonl",
		dir: ORCA_PLUGINS_DIR,
		runs: [3],
		maxTools: 16,
		maxContinue: 4,
		mode: "compact",
		stats: false,
		note: "dense read-group stream with selectors; compact mode; no terminal answer in source",
	},
	{
		outId: "write-audit-lifecycle",
		// Write-audit lifecycle subagent: write/read/bash/edit mix with a
		// compaction label in the source run. Replayed in live mode; write
		// targets do not exist in the replay sandbox, so their audit
		// completes as a no-op (no carrier) — the honest sandbox outcome.
		file: "2026-08-10T17-50-32-859Z_019feccc-319b-7000-8623-b23e831714bf/WriteAuditLifecycle.jsonl",
		dir: ORCA_PLUGINS_DIR,
		runs: [3],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "write events audited against an empty sandbox (no-op evidence path); compaction label in source",
	},
	{
		outId: "relative-paths",
		// Display-path subagent: relative and absolute read paths, writes,
		// bash with absolute repo paths; `compactPaths` relativizes against
		// the replay cwd placeholder `/repo`.
		file: "2026-08-10T17-50-32-859Z_019feccc-319b-7000-8623-b23e831714bf/RelativePaths.jsonl",
		dir: ORCA_PLUGINS_DIR,
		runs: [2],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "absolute repo paths normalized to /repo; cwd-relative display under replay",
	},
	{
		outId: "multi-git-retention",
		// Multi-Git bookkeeping subagent; includes an eval call, reads of
		// the git-records internals and a real terminal stop answer.
		file: "2026-08-10T17-50-32-859Z_019feccc-319b-7000-8623-b23e831714bf/MultiGitRetention.jsonl",
		dir: ORCA_PLUGINS_DIR,
		runs: [1],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "terminal stop answer; eval + edit + read mix",
	},
	{
		outId: "async-race-contracts",
		// Fire-and-forget race regression subagent: two real runs (one
		// working, one terminal), hub coordination, bash test loops; session
		// continuity across runs.
		file: "2026-08-10T17-50-32-859Z_019feccc-319b-7000-8623-b23e831714bf/AsyncRaceContracts.jsonl",
		dir: ORCA_PLUGINS_DIR,
		runs: [3, 5],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "multi-run continuity; hub calls; bash with ANSI test output; mixed terminal states",
	},
	{
		outId: "run-stats",
		// RunStats subagent: real usage-bearing assistant messages, eval and
		// write events; stats enabled so the terminal row and evidence entry
		// project from real usage.
		file: "2026-08-10T17-50-32-859Z_019feccc-319b-7000-8623-b23e831714bf/RunStats.jsonl",
		dir: ORCA_PLUGINS_DIR,
		runs: [2],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: true,
		note: "real usage sums across toolUse continuations (capped at 4); stats row + persisted evidence",
	},
	{
		outId: "post-turn-shake",
		// PostTurnShake subagent: bash-heavy run with a write and edits.
		file: "2026-08-10T17-50-32-859Z_019feccc-319b-7000-8623-b23e831714bf/PostTurnShake.jsonl",
		dir: ORCA_PLUGINS_DIR,
		runs: [2],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "bash-heavy run; edit carriers from details.diff; ends at yield (working phase)",
	},
	{
		outId: "main-session-abort-unicode",
		// Long-lived main session window: an aborted terminal run (full
		// projection, Russian Unicode text) preceded by an ask-bearing stop
		// run (interactive native-live tool). Clear mode: routine rows hide
		// at terminal while abort keeps diagnostics.
		file: "2026-08-09T10-46-10-781Z_019fe621-505d-7000-b228-aeb7a66bf268.jsonl",
		dir: ORCA_PLUGINS_DIR,
		runs: [7, 24],
		maxTools: 12,
		maxContinue: 4,
		mode: "clear",
		stats: false,
		note: "aborted terminal (full log); Unicode; ask native-live shapes; clear mode; compaction labels present in source",
	},
];

// ---------------------------------------------------------------------------
// Redaction + normalization (deterministic; order matters).
// ---------------------------------------------------------------------------

const MAX_ARG_STRING = 200;
const MAX_RESULT_TEXT = 300;
const MAX_ARRAY_ITEMS = 5;

const secretPatterns: Array<[RegExp, string]> = [
	[/sk-[A-Za-z0-9_-]{8,}/g, "<secret>"],
	[/ghp_[A-Za-z0-9]{20,}/g, "<secret>"],
	[/xox[baprs]-[A-Za-z0-9-]{10,}/g, "<secret>"],
	[/AKIA[0-9A-Z]{16}/g, "<secret>"],
	[/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g, "Bearer <secret>"],
	[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
	// Shaken-output markers reference the original session's artifact ids;
	// keep only the token count.
	[/\[shaken[^\]]*\]/g, "[shaken]"],
	[/[0-9a-f]{40,}/g, "<hash>"],
	// Short hex runs in prose (commit hashes) — assistant texts only.
	[/(?<![A-Za-z0-9])[0-9a-f]{7,40}(?![A-Za-z0-9])/g, "<hash>"],
	// Session-transcript provenance paths (session dirs, subagent names).
	[
		/\/home\/\.omp\/agent\/sessions\/[^"\\]*/g,
		"/home/.omp/agent/sessions/<session>",
	],
	// Shared coordination URIs keep the scheme but drop the file name.
	[/local:\/\/[A-Za-z0-9._-]+/g, "local://<file>"],
];

function normalizeToolCallId(value: string): string {
	// Composite `call_<base62>|fc_<sha1>` ids: keep the structure (the
	// provisional|real migration shape) but drop the content hash.
	return value.replace(/\|fc_[0-9a-f]{40}/g, "|fc_<hash>");
}

const pathReplacements: Array<[RegExp, string]> = [
	[/\/Volumes\/Storage2T\/Projects\/orca-plugins/g, "/repo"],
	[/\/Users\/admin/g, "/home"],
	[/\/private\/tmp/g, "/tmp"],
	// Runtime-ellipsized absolute roots (args snapshotting truncates with
	// `…`, so the full-path patterns above never match).
	[/\/(?:Volumes|Users|private)\/[A-Za-z0-9._/-]*…/g, "/abs/truncated…"],
];

let otherProjects = 0;
let otherAbs = 0;
const seenPaths = new Map<string, string>();

function redactPath(value: string): string {
	let out = value;
	for (const [pattern, replacement] of pathReplacements) {
		out = out.replace(pattern, replacement);
	}
	// Other project roots and remaining absolute roots get deterministic
	// numbered placeholders (first-seen order per extraction run).
	out = out.replace(/\/Volumes\/Storage2T\/Projects\/([^/\s]+)/g, (match) => {
		const key = match;
		let slot = seenPaths.get(key);
		if (!slot) {
			slot = `/projects/${++otherProjects}`;
			seenPaths.set(key, slot);
		}
		return slot;
	});
	out = out.replace(
		/\/(?:Volumes|Users|private)\/[A-Za-z0-9._-]+/g,
		(match) => {
			const key = match;
			let slot = seenPaths.get(key);
			if (!slot) {
				slot = `/abs/${++otherAbs}`;
				seenPaths.set(key, slot);
			}
			return slot;
		},
	);
	return out;
}

function redactString(value: string): string {
	let out = redactPath(value);
	for (const [pattern, replacement] of secretPatterns) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

function capString(value: string, limit: number): string {
	// Redact FIRST, then slice: slicing before redaction can cut an
	// absolute path mid-way and leave an unredacted `/Volumes/…` prefix
	// (paths span the truncation boundary).
	const redacted = redactString(value);
	if (redacted.length <= limit) return redacted;
	return `${redacted.slice(0, limit)}…<+${redacted.length - limit} chars>`;
}

/**
 * Structural text cap for result payloads: short strings pass through
 * redacted; long strings (raw tool output bodies, source snippets, file
 * contents) are replaced entirely by a deterministic size placeholder.
 * The plugin never renders result text (rows show paths/commands/status),
 * so the raw body is not structurally necessary — only its size is.
 * `details.diff` is exempt: the mutation carriers parse added/removed
 * lines from it (still capped+redacted via `capString`).
 */
function capResultText(value: string, limit: number): string {
	const redacted = redactString(value);
	if (redacted.length <= limit) return redacted;
	// Recover the true original size when the value already carries a
	// truncation marker from an earlier pass.
	const marker = redacted.match(/…<\+(\d+) chars>$/);
	const original =
		marker !== null
			? Number(marker[1]) + (redacted.length - marker[0].length)
			: value.length;
	return `[output ${original} chars]`;
}

function normalizeScalar(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return capString(value, MAX_ARG_STRING);
	if (typeof value === "number" || typeof value === "boolean" || value === null)
		return value;
	if (Array.isArray(value)) {
		const out = value
			.slice(0, MAX_ARRAY_ITEMS)
			.map((item) => normalizeScalar(item, depth + 1));
		if (value.length > MAX_ARRAY_ITEMS)
			out.push(`<+${value.length - MAX_ARRAY_ITEMS} items>`);
		return out;
	}
	if (typeof value === "object" && depth < 6) {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(record)) {
			if (item === undefined) continue;
			out[key] = normalizeScalar(item, depth + 1);
		}
		return out;
	}
	return undefined;
}

function normalizeResult(result: ResultRecord): {
	result: unknown;
	isError: boolean;
} {
	const content = (result.content ?? []).map((block) => {
		if (!block || typeof block !== "object") return block;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			return {
				type: "text",
				text: capResultText(record.text, MAX_RESULT_TEXT),
			};
		}
		return normalizeScalar(record);
	});
	const details = normalizeScalar(result.details) as Record<
		string,
		unknown
	> | null;
	if (details !== null && details !== undefined) {
		// Recursively replace every long nested text payload (displayContent
		// bodies, truncation excerpts, old/new file text, meta provenance)
		// with a size placeholder — except `diff`, which the mutation
		// carriers parse (it stays capped+redacted via normalizeScalar).
		for (const [key, value] of Object.entries(details)) {
			if (key === "diff") continue;
			details[key] = placeholderizeLongText(value, 200, key);
		}
	}
	return {
		result: {
			content,
			...(details !== null && details !== undefined ? { details } : {}),
		},
		isError: result.isError,
	};
}

function placeholderizeLongText(
	value: unknown,
	limit: number,
	key: string,
	depth = 0,
): unknown {
	if (typeof value === "string") {
		if (key === "diff") return capString(value, limit);
		return capResultText(value, limit);
	}
	if (value === null || typeof value !== "object" || depth > 6) return value;
	if (Array.isArray(value)) {
		return value.map((item) =>
			placeholderizeLongText(item, limit, key, depth + 1),
		);
	}
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [childKey, item] of Object.entries(record)) {
		out[childKey] = placeholderizeLongText(item, limit, childKey, depth + 1);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Session parsing.
// ---------------------------------------------------------------------------

function parseSession(path: string): Array<Record<string, unknown>> {
	const text = readFileSync(path, "utf8");
	const out: Array<Record<string, unknown>> = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// malformed trailing lines are ignored (never fabricated)
		}
	}
	return out;
}

function splitRuns(records: Array<Record<string, unknown>>): Run[] {
	const runs: Run[] = [];
	let current: Run | undefined;
	let currentCompactions = 0;
	for (const rec of records) {
		if (rec.type === "compaction") {
			if (current) current.compactions++;
			else currentCompactions++;
			continue;
		}
		if (rec.type === "message") {
			const message = rec.message as Record<string, unknown> | undefined;
			if (!message) continue;
			const role = message.role;
			if (role === "user") {
				if (current) runs.push(current);
				current = {
					index: runs.length,
					events: [],
					compactions: currentCompactions,
					terminal: "none",
					userPrefix: userTextPrefix(message),
				};
				currentCompactions = 0;
				continue;
			}
			if (role === "assistant" && current) {
				const stopReason =
					typeof message.stopReason === "string" ? message.stopReason : "";
				const text = assistantText(message);
				const usage =
					message.usage && typeof message.usage === "object"
						? (message.usage as Record<string, unknown>)
						: undefined;
				current.events.push({
					kind: "assistant",
					assistant: { text, stopReason, usage },
				});
				if (
					stopReason === "stop" ||
					stopReason === "aborted" ||
					stopReason === "error"
				) {
					current.terminal = stopReason === "stop" ? "stop" : stopReason;
				}
				continue;
			}
			if (role === "toolResult" && current) {
				const toolName = message.toolName;
				const toolCallId = message.toolCallId;
				if (typeof toolName === "string" && typeof toolCallId === "string") {
					current.events.push({
						kind: "result",
						result: {
							toolCallId,
							toolName,
							content: Array.isArray(message.content) ? message.content : [],
							details: message.details,
							isError: message.isError === true,
							pruned:
								message.prunedAt !== undefined || message.useless === true,
						},
					});
				}
				continue;
			}
			continue;
		}
		if (rec.type === "custom" && current) {
			if (rec.customType === "tool_execution_start") {
				const data = rec.data as Record<string, unknown> | undefined;
				const toolCallId = data?.toolCallId;
				const toolName = data?.toolName;
				if (typeof toolCallId === "string" && typeof toolName === "string") {
					current.events.push({
						kind: "start",
						start: {
							toolCallId,
							toolName,
							args: data?.args,
							intent:
								typeof data?.intent === "string" ? data.intent : undefined,
						},
					});
				}
			}
		}
	}
	if (current) runs.push(current);
	return runs;
}

function assistantText(message: Record<string, unknown>): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const record = block as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string"
				? record.text
				: "";
		})
		.join("");
}

function userTextPrefix(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return capString(content, 80);
	if (!Array.isArray(content)) return "";
	const parts = content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const record = block as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string"
				? record.text
				: "";
		})
		.filter(Boolean);
	return capString(parts.join(" "), 80);
}

// ---------------------------------------------------------------------------
// Fixture emission.
// ---------------------------------------------------------------------------

interface FixtureEvent {
	t: string;
	id?: string;
	name?: string;
	args?: unknown;
	intent?: string;
	result?: unknown;
	isError?: boolean;
	pruned?: boolean;
	text?: string;
	stop?: string;
	usage?: Record<string, unknown>;
}
function buildFixtureEvents(
	run: Run,
	maxTools: number,
	maxContinue: number,
	answerLabel: () => string,
): { events: FixtureEvent[]; toolCount: number; terminal: Run["terminal"] } {
	const events: FixtureEvent[] = [];
	let startCount = 0;
	let toolCount = 0;
	let continueCount = 0;
	// The window is the run's prefix up to `maxTools` tool pairs, always
	// terminated by the run's real terminal assistant message (answer or
	// abort) when one exists — the terminal projection is the observable
	// contract. Assistant prose is NOT structural: texts are replaced by
	// deterministic placeholders (`<answer N>`), while the presence of text
	// (which drives filtered-vs-full classification) is preserved.
	let capped = false;
	let terminal: Run["terminal"] = "none";
	// Past the tool window only the run's final terminal message is kept
	// (the plugin projects from the last `agent_end`; intermediate
	// error/abort messages in the tail add no observable contract).
	let tailTerminal: FixtureEvent | undefined;
	// Assistant toolUse messages map to `agent_end(willContinue)`, which the
	// stock runtime emits only after every `tool_execution_end` of the
	// round-trip ("stock emits every end before agent_end" — the audit
	// drain contract). The message's `continue` is therefore deferred until
	// the following tool result has been emitted.
	let pendingUsage: Record<string, unknown> | undefined;
	let lastRunEndIndex = -1;
	const flushPendingContinue = (): void => {
		if (!pendingUsage) return;
		events.push({
			t: "continue",
			usage: normalizeScalar(pendingUsage) as Record<string, unknown>,
		});
		pendingUsage = undefined;
	};
	const pushRunEnd = (stop: string): void => {
		if (lastRunEndIndex >= 0 && events[lastRunEndIndex]?.t === "run_end") {
			// Consecutive terminal stops are projection-equivalent (any
			// non-stop/non-length stopReason classifies "full"); keep the last.
			events[lastRunEndIndex] = { t: "run_end", stop };
			return;
		}
		events.push({ t: "run_end", stop });
		lastRunEndIndex = events.length - 1;
	};
	for (const event of run.events) {
		if (capped) {
			// Complete every round-trip whose start was admitted — a late
			// result must not be dropped just because the window is full.
			if (event.kind === "result") {
				if (
					!events.some(
						(e) =>
							e.t === "tool_start" &&
							e.id === normalizeToolCallId(event.result.toolCallId),
					)
				)
					continue;
				const normalized = normalizeResult(event.result);
				events.push({
					t: "tool_result",
					id: normalizeToolCallId(event.result.toolCallId),
					name: event.result.toolName,
					result: normalized.result,
					isError: normalized.isError,
					...(event.result.pruned ? { pruned: true } : {}),
				});
				flushPendingContinue();
				continue;
			}
			if (event.kind !== "assistant") continue;
			const stopReason = event.assistant.stopReason;
			if (stopReason === "stop") {
				tailTerminal = { t: "answer", text: answerLabel(), stop: "stop" };
				terminal = "stop";
			} else if (stopReason === "aborted" || stopReason === "error") {
				tailTerminal = { t: "run_end", stop: stopReason };
				terminal = stopReason;
			} else if (
				stopReason === "toolUse" &&
				event.assistant.usage !== undefined &&
				continueCount < maxContinue
			) {
				continueCount++;
				pendingUsage = event.assistant.usage;
			}
			continue;
		}
		if (event.kind === "start") {
			if (startCount >= maxTools) {
				capped = true;
				continue;
			}
			startCount++;
			events.push({
				t: "tool_start",
				id: normalizeToolCallId(event.start.toolCallId),
				name: event.start.toolName,
				...(event.start.args !== undefined
					? { args: normalizeScalar(event.start.args) }
					: {}),
				...(event.start.intent !== undefined
					? { intent: capString(event.start.intent, 160) }
					: {}),
			});
			continue;
		}
		if (event.kind === "result") {
			// The window bounds admitted STARTS; every result of an admitted
			// start is admitted too, even when it arrives late (delayed tool
			// results after the start cap) — otherwise the fixture fabricates
			// dangling tools.
			if (
				!events.some(
					(e) =>
						e.t === "tool_start" &&
						e.id === normalizeToolCallId(event.result.toolCallId),
				)
			)
				continue;
			toolCount++;
			const normalized = normalizeResult(event.result);
			events.push({
				t: "tool_result",
				id: normalizeToolCallId(event.result.toolCallId),
				name: event.result.toolName,
				result: normalized.result,
				isError: normalized.isError,
				...(event.result.pruned ? { pruned: true } : {}),
			});
			flushPendingContinue();
			continue;
		}
		if (event.kind === "assistant") {
			const assistant = event.assistant;
			if (assistant.stopReason === "stop") {
				flushPendingContinue();
				events.push({ t: "answer", text: answerLabel(), stop: "stop" });
				terminal = "stop";
				continue;
			}
			if (
				assistant.stopReason === "aborted" ||
				assistant.stopReason === "error"
			) {
				flushPendingContinue();
				pushRunEnd(assistant.stopReason);
				terminal = assistant.stopReason;
				continue;
			}
			// toolUse continuation: stock emits agent_end(willContinue) after
			// the round-trip's ends (see flushPendingContinue); usage sums
			// into the run's stats row. Silent continuations without usage
			// are dropped; the rest are capped per run.
			if (assistant.usage === undefined) continue;
			if (continueCount >= maxContinue) continue;
			continueCount++;
			pendingUsage = assistant.usage;
		}
	}
	flushPendingContinue();
	if (tailTerminal !== undefined) events.push(tailTerminal);
	return { events, toolCount, terminal };
}

function emitFixture(spec: FixtureSpec, runs: Run[]): string {
	const selected = runs.filter((run) => spec.runs.includes(run.index));
	const events: FixtureEvent[] = [];
	let answerCount = 0;
	let toolCount = 0;
	const toolNames = new Map<string, number>();
	let lastTerminal: Run["terminal"] = "none";
	for (const run of selected) {
		events.push({ t: "run_start" });
		const built = buildFixtureEvents(
			run,
			spec.maxTools,
			spec.maxContinue,
			() => {
				answerCount += 1;
				return `<answer ${answerCount}>`;
			},
		);
		events.push(...built.events);
		for (const event of built.events) {
			if (event.t === "tool_start" && event.name) {
				toolNames.set(event.name, (toolNames.get(event.name) ?? 0) + 1);
			}
		}
		toolCount += built.toolCount;
		lastTerminal = built.terminal;
	}
	events.push({ t: "session_shutdown" });

	const tools = Object.fromEntries(
		[...toolNames.entries()].sort((a, b) => b[1] - a[1]),
	);
	return `${JSON.stringify(
		{
			meta: {
				id: spec.outId,
				source: spec.file,
				sourceKind: "session-jsonl",
				captureDate: new Date().toISOString().slice(0, 10),
				cwd: "/repo",
				mode: spec.mode,
				stats: spec.stats,
				terminal: lastTerminal,
				events: events.length,
				tools: toolCount,
				toolNames: tools,
				redaction:
					"absolute repo paths -> /repo; other absolute roots -> /projects/N|/abs/N; secrets/emails/hashes -> <placeholders>; assistant prose -> deterministic <answer N>/dropped; shaken markers -> [shaken]; strings capped (args 200, result 300, arrays 5); entry envelope fields (ids/timestamps) dropped",
				note: spec.note,
			},
			events,
		},
		null,
		2,
	)}\n`;
}

function main(): void {
	const sessionsDir =
		process.env.OMP_SESSIONS_DIR ??
		join(homedir(), ".omp", "agent", "sessions");
	const outDir =
		process.env.OMP_FIXTURES_DIR ?? resolve(import.meta.dir, "fixtures");
	const listOnly = process.argv.includes("--list");

	const parsed: Array<{ spec: FixtureSpec; runs: Run[] }> = [];
	for (const spec of FIXTURES) {
		const path = join(sessionsDir, spec.dir, spec.file);
		const records = parseSession(path);
		const runs = splitRuns(records);
		parsed.push({ spec, runs });
	}

	if (listOnly) {
		for (const { spec, runs } of parsed) {
			console.log(`\n=== ${spec.outId} <- ${spec.file}`);
			for (const run of runs) {
				const counts = new Map<string, number>();
				for (const event of run.events) {
					if (event.kind === "start") {
						counts.set(
							event.start.toolName,
							(counts.get(event.start.toolName) ?? 0) + 1,
						);
					}
				}
				const tools = [...counts.entries()]
					.map(([name, count]) => `${name}x${count}`)
					.join(" ");
				console.log(
					`run ${run.index}: terminal=${run.terminal} events=${run.events.length} compaction=${run.compactions} tools=[${tools}] user=${run.userPrefix}`,
				);
			}
		}
		return;
	}

	mkdirSync(outDir, { recursive: true });
	for (const { spec, runs } of parsed) {
		const fixture = emitFixture(spec, runs);
		const path = join(outDir, `${spec.outId}.json`);
		writeFileSync(path, fixture);
		console.log(`wrote ${path} (${fixture.length} bytes)`);
	}
}

main();
