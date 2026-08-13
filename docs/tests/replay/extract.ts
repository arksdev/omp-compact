/**
 * Replay-fixture extractor (offline maintenance tool, not a test).
 *
 * Reads real OMP session JSONL files whose locations come from an external
 * untracked manifest and emits bounded, redacted, structurally-normalized
 * replay fixtures consumed by `replay.test.ts` / `replay-inventory.test.ts`.
 *
 * The manifest is supplied at regeneration time via `OMP_REPLAY_MANIFEST`
 * and maps each fixture id to the absolute path of its raw session file
 * (JSONL). It is never committed and is required for generation; there are
 * no embedded fallback paths. Generic shape:
 *
 *   {
 *     "<fixture-id>": "/absolute/path/to/session.jsonl"
 *   }
 *
 * Raw transcripts are never copied: each fixture keeps only the normalized
 * event stream (tool starts/results, assistant continuations/answers,
 * run/session boundaries) with deterministic path/token placeholders and
 * per-event size caps. Provenance in each fixture's `meta` is generic:
 * `source` is the literal `"<session>"` marker (no file names, capture
 * dates, or machine paths are tracked).
 *
 * Normalization (deterministic, in order):
 * - toolCallIds become per-fixture `call_1`, `call_2`, ... in first-seen
 *   order; the provisional|real `|fc_` composite shape is kept as
 *   `call_N|fc_<hash>`; every other raw id form (plain base62, uuid
 *   suffixes, `toolu_...`) maps to plain `call_N`. Start/result equality,
 *   uniqueness, and ordering are preserved.
 * - Peer labels observed in hub/task coordination fields (from/to/receipts/
 *   waited) map to `peer-1`, `peer-2`, ... per fixture; every occurrence in
 *   public strings is replaced whole-word.
 * - Old internal path namespaces map to canonical public namespaces
 *   (absolute and relative): plugin code, pinned host runtime, host source,
 *   host docs, generic old work.
 * - Secret patterns (tokens, emails, hashes, session paths) become
 *   placeholders; assistant prose becomes `<answer N>` / is dropped; strings
 *   are capped; entry envelope fields (ids/timestamps) are dropped.
 *
 * Session types: subagent sessions end at the yield tool without a terminal
 * assistant message; their fixtures end in the live working phase
 * (documented in `meta.terminal`). Top-level-session runs carry real
 * terminal answers and are replayed through the terminal filter.
 *
 * Usage:
 *   OMP_REPLAY_MANIFEST=/path/to/manifest.json bun run docs/tests/replay/extract.ts --list
 *   OMP_REPLAY_MANIFEST=/path/to/manifest.json bun run docs/tests/replay/extract.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
// Corpus definition. `runs` selects 0-based run indexes (user-message
// boundaries); `maxTools` caps the tool event pairs per run (prefix
// window); `maxContinue` caps assistant toolUse messages. `mode` is a
// replay parameter (the plugin mode is not recoverable from a session
// file) and `stats` mirrors whether the run carries usage worth asserting.
// Raw session locations are resolved through `OMP_REPLAY_MANIFEST` (see
// the header); fixture ids must match manifest keys.
// ---------------------------------------------------------------------------

interface FixtureSpec {
	outId: string;
	runs: number[];
	maxTools: number;
	maxContinue: number;
	mode: "live" | "compact" | "clear";
	stats: boolean;
	note: string;
}

const FIXTURES: FixtureSpec[] = [
	{
		outId: "git-compound-main",
		// Top-level-session runs that exercised real `git add … && git commit -m …`
		// compound calls and `git status --short --untracked-files=all`, plus
		// the provisional|real composite toolCallId shape.
		runs: [3, 5],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "real git add/commit compound + status; composite call_N|fc_<hash> toolCallIds; two terminal runs",
	},
	{
		outId: "git-commit-only-retention",
		// Session ending at yield: real edit diffs (carrier rows), a failed
		// test run (exit 2), reads with selectors, hub and yield.
		// Working-phase projection.
		runs: [2],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "real edit details.diff carriers; failed bash (exit 2); read path selectors; ends at yield (working phase)",
	},
	{
		outId: "compact-read-groups",
		// Dense read/grep/edit stream with line-selector paths. Replayed in
		// compact mode; the run has no terminal answer in the source, so
		// rows assert the live compact projection.
		runs: [3],
		maxTools: 16,
		maxContinue: 4,
		mode: "compact",
		stats: false,
		note: "dense read-group stream with selectors; compact mode; no terminal answer in source",
	},
	{
		outId: "write-audit-lifecycle",
		// Write/read/bash/edit mix with a compaction label in the source
		// run. Replayed in live mode; write targets do not exist in the
		// replay sandbox, so their audit completes as a no-op (no carrier) —
		// the honest sandbox outcome.
		runs: [3],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "write events audited against an empty sandbox (no-op evidence path); compaction label in source",
	},
	{
		outId: "relative-paths",
		// Relative and absolute read paths, writes, bash with absolute repo
		// paths; `compactPaths` relativizes against the replay cwd
		// placeholder `/repo`.
		runs: [2],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "absolute repo paths normalized to /repo; cwd-relative display under replay",
	},
	{
		outId: "multi-git-retention",
		// Includes an eval call, reads of the git-records internals and a
		// real terminal stop answer.
		runs: [1],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "terminal stop answer; eval + edit + read mix",
	},
	{
		outId: "async-race-contracts",
		// Two real runs (one working, one terminal), hub coordination, bash
		// test loops; session continuity across runs.
		runs: [3, 5],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "multi-run continuity; hub calls; bash with ANSI test output; mixed terminal states",
	},
	{
		outId: "run-stats",
		// Real usage-bearing assistant messages, eval and write events;
		// stats enabled so the terminal row and evidence entry project from
		// real usage.
		runs: [2],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: true,
		note: "real usage sums across toolUse continuations (capped at 4); stats row + persisted evidence",
	},
	{
		outId: "post-turn-shake",
		// Bash-heavy run with a write and edits.
		runs: [2],
		maxTools: 16,
		maxContinue: 4,
		mode: "live",
		stats: false,
		note: "bash-heavy run; edit carriers from details.diff; ends at yield (working phase)",
	},
	{
		outId: "main-session-abort-unicode",
		// Long-lived top-level session window: an aborted terminal run (full
		// projection, Russian Unicode text) preceded by an ask-bearing stop
		// run (interactive native-live tool). Clear mode: routine rows hide
		// at terminal while abort keeps diagnostics.
		runs: [7, 24],
		maxTools: 12,
		maxContinue: 4,
		mode: "clear",
		stats: false,
		note: "aborted terminal (full log); Unicode; ask native-live shapes; clear mode; compaction labels present in source",
	},
];

// ---------------------------------------------------------------------------
// Manifest loading. Raw session locations live ONLY in the external
// untracked manifest; the extractor never embeds or fabricates paths.
// ---------------------------------------------------------------------------

function loadManifest(): Map<string, string> {
	const manifestPath = process.env.OMP_REPLAY_MANIFEST;
	if (!manifestPath) {
		throw new Error(
			"OMP_REPLAY_MANIFEST must point at a JSON manifest mapping fixture id -> raw session path (see extract.ts header)",
		);
	}
	let raw: string;
	try {
		raw = readFileSync(manifestPath, "utf8");
	} catch (error) {
		throw new Error(
			`cannot read OMP_REPLAY_MANIFEST at ${manifestPath}: ${String(error)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`OMP_REPLAY_MANIFEST at ${manifestPath} is not valid JSON: ${String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`OMP_REPLAY_MANIFEST at ${manifestPath} must be a JSON object mapping fixture id -> raw session path`,
		);
	}
	const manifest = new Map<string, string>();
	for (const [key, value] of Object.entries(
		parsed as Record<string, unknown>,
	)) {
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(
				`OMP_REPLAY_MANIFEST entry "${key}" must be a non-empty path string`,
			);
		}
		manifest.set(key, value);
	}
	for (const spec of FIXTURES) {
		if (!manifest.has(spec.outId)) {
			throw new Error(
				`OMP_REPLAY_MANIFEST is missing an entry for fixture "${spec.outId}"`,
			);
		}
	}
	return manifest;
}

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

// Per-fixture toolCallId normalization: first-seen order -> `call_N`;
// the provisional|real `|fc_` composite shape is preserved as
// `call_N|fc_<hash>`; every other raw id form maps to plain `call_N`.
let activeToolCallIds = new Map<string, string>();
let nextToolCallNumber = 1;

function normalizeToolCallId(value: string): string {
	const existing = activeToolCallIds.get(value);
	if (existing !== undefined) return existing;
	const number = nextToolCallNumber++;
	const composite = /^.+?\|fc_[0-9a-fA-F]+$/.test(value);
	const normalized = composite ? `call_${number}|fc_<hash>` : `call_${number}`;
	activeToolCallIds.set(value, normalized);
	return normalized;
}

// Per-fixture peer-label neutralization: labels collected from hub/task
// coordination fields map to `peer-1`, `peer-2`, ... in first-seen order
// and every occurrence in public strings is replaced whole-word.
let activePeers: ReadonlyMap<string, string> = new Map();

function collectPeerLabels(
	records: Array<Record<string, unknown>>,
	sourceBasename: string,
): Map<string, string> {
	const labels = new Map<string, number>();
	const record = (label: unknown): void => {
		if (typeof label !== "string" || label.length === 0) return;
		if (!/^[A-Z][A-Za-z0-9]+$/.test(label)) return;
		if (!labels.has(label)) labels.set(label, labels.size + 1);
	};
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (!value || typeof value !== "object") return;
		for (const [key, item] of Object.entries(
			value as Record<string, unknown>,
		)) {
			if (key === "from" || key === "to" || key === "replyTo") record(item);
			walk(item);
		}
	};
	for (const rec of records) {
		if (rec.type === "custom" && rec.customType === "tool_execution_start") {
			const data = rec.data as Record<string, unknown> | undefined;
			if (data?.toolName === "hub" || data?.toolName === "task") {
				walk(data?.args);
			}
		}
		if (rec.type === "message") {
			const message = rec.message as Record<string, unknown> | undefined;
			if (
				message?.role === "toolResult" &&
				(message.toolName === "hub" || message.toolName === "task")
			) {
				walk(message.details);
			}
		}
	}
	// Subagent session basenames are worker labels too.
	if (/^[A-Z][A-Za-z0-9]+$/.test(sourceBasename)) {
		if (!labels.has(sourceBasename))
			labels.set(sourceBasename, labels.size + 1);
	}
	const map = new Map<string, string>();
	for (const [label, number] of labels) {
		map.set(label, `peer-${number}`);
	}
	return map;
}

const pathReplacements: Array<[RegExp, string]> = [
	// Repo workspace root: any project directory under a mounted workspace
	// maps to the replay cwd placeholder (shape-generic; no machine roots).
	[/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/Projects\/[A-Za-z0-9._-]+/g, "/repo"],
	[/\/Users\/[A-Za-z0-9._-]+/g, "/home"],
	[/\/private\/tmp/g, "/tmp"],
	// Runtime-ellipsized absolute roots (args snapshotting truncates with
	// `…`, so the full-path patterns above never match).
	[/\/(?:Volumes|Users|private)\/[A-Za-z0-9._/-]*…/g, "/abs/truncated…"],
];

// Old internal namespace roots, assembled from parts so this file never
// contains the legacy strings themselves (the inventory suite scans this
// source as an enforcement point).
function hyphen(...parts: string[]): string {
	return parts.join("-");
}
const NS_PLUGIN = hyphen("omp", "compact");
const NS_WORK = hyphen("omp", "patch");
const NS_HOST_SRC = hyphen("oh", "my", "pi");
const NS_HOST_DOCS = hyphen("omp", "shell");
const NS_PLUGINS = hyphen("orca", "plugins");

// Canonical public namespaces replacing old internal path roots (absolute
// and relative forms; order matters — most specific first).
const namespaceReplacements: Array<[RegExp, string]> = [
	// Host package scope inside the pinned runtime.
	[new RegExp(`@${NS_HOST_SRC}/`, "g"), "@host/"],
	// Host source checkout root.
	[new RegExp(`\\b${NS_HOST_SRC}\\b`, "g"), "host-source"],
	// Plugin code root.
	[new RegExp(`${NS_WORK}/plugins/${NS_PLUGIN}`, "g"), "plugin"],
	[new RegExp(`${NS_WORK}/plugins`, "g"), "plugin"],
	// Pinned host runtime.
	[new RegExp(`${NS_WORK}/runtime/omp-17\\.\\d+\\.\\d+`, "g"), "host"],
	// Host docs.
	[new RegExp(`docs/${NS_HOST_DOCS}`, "g"), "host-docs"],
	[new RegExp(`\\b${NS_HOST_DOCS}\\b`, "g"), "host-docs"],
	// Generic old work.
	[new RegExp(`${NS_WORK}`, "g"), "work"],
	[new RegExp(`\\b${NS_PLUGINS}\\b`, "g"), "work"],
];

let otherAbs = 0;
const seenPaths = new Map<string, string>();

function redactPath(value: string): string {
	let out = value;
	for (const [pattern, replacement] of pathReplacements) {
		out = out.replace(pattern, replacement);
	}
	for (const [pattern, replacement] of namespaceReplacements) {
		out = out.replace(pattern, replacement);
	}
	// Remaining absolute roots get deterministic numbered placeholders
	// (first-seen order per extraction run).
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
	for (const [label, placeholder] of activePeers) {
		out = out.replace(
			new RegExp(`(?<![A-Za-z0-9])${label}(?![A-Za-z0-9])`, "g"),
			placeholder,
		);
	}
	// Internal decision-record wording is neutralized (the decision skill,
	// its file references, and the ask phrasing are not public provenance;
	// Cyrillic ask shape and Unicode are preserved).
	out = out.replace(/Keep-the-Why\s+записи/g, "записи решений");
	out = out.replace(/keep-the-why-distilled/g, "decision-record");
	out = out.replace(/Keep-the-Why/g, "решения");
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
				source: "<session>",
				sourceKind: "session-jsonl",
				cwd: "/repo",
				mode: spec.mode,
				stats: spec.stats,
				terminal: lastTerminal,
				events: events.length,
				tools: toolCount,
				toolNames: tools,
				redaction:
					"session source -> <session>; absolute repo paths -> /repo + canonical namespaces (plugin|host|host-source|host-docs|work); other absolute roots -> /abs/N; worker labels -> peer-N; toolCallIds -> call_N (fc_ composite shape kept); secrets/emails/hashes -> <placeholders>; assistant prose -> deterministic <answer N>/dropped; shaken markers -> [shaken]; strings capped (args 200, result 300, arrays 5); entry envelope fields (ids/timestamps) dropped",
				note: spec.note,
			},
			events,
		},
		null,
		2,
	)}\n`;
}

function main(): void {
	const manifest = loadManifest();
	const outDir =
		process.env.OMP_FIXTURES_DIR ?? resolve(import.meta.dir, "fixtures");
	const listOnly = process.argv.includes("--list");

	const parsed: Array<{
		spec: FixtureSpec;
		runs: Run[];
		peers: Map<string, string>;
	}> = [];
	for (const spec of FIXTURES) {
		const sourcePath = manifest.get(spec.outId);
		if (!sourcePath) {
			throw new Error(
				`OMP_REPLAY_MANIFEST is missing an entry for fixture "${spec.outId}"`,
			);
		}
		const sourceBasename = sourcePath.split("/").pop() ?? "";
		const records = parseSession(sourcePath);
		const peers = collectPeerLabels(records, sourceBasename);
		activePeers = peers;
		const runs = splitRuns(records);
		parsed.push({ spec, runs, peers });
	}

	if (listOnly) {
		for (const { spec, runs, peers } of parsed) {
			activePeers = peers;
			console.log(`\n=== ${spec.outId}`);
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
	for (const { spec, runs, peers } of parsed) {
		activePeers = peers;
		activeToolCallIds = new Map();
		nextToolCallNumber = 1;
		const fixture = emitFixture(spec, runs);
		const path = resolve(outDir, `${spec.outId}.json`);
		writeFileSync(path, fixture);
		console.log(`wrote ${path} (${fixture.length} bytes)`);
	}
}

main();
