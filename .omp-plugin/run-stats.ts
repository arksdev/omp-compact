import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";

import type { CompactStatsSettings } from "./config";

export const STATS_MESSAGE_TYPE = "omp-compact-stats";
export const STATS_EVIDENCE_VERSION = 1;

/**
 * Bounds for persisted evidence and aggregation sanity. The row is a summary
 * surface, never a billing ledger: caps are generous but finite so persisted
 * evidence stays bounded and typed.
 */
export const MAX_STATS_ACTIONS = 1_000_000;
export const MAX_STATS_TOKENS = 1e12;
export const MAX_STATS_DURATION_MS = 2 ** 53 - 1;
export const MAX_STATS_RUN_ID_LENGTH = 128;

export interface RunStatsResult {
	/**
	 * Distinct tool executions of the logical run (failures included),
	 * deduplicated by toolCallId from `tool_execution_start` — the
	 * authoritative execution source. Never derived from adapter-mapped
	 * ledger entries, so late-bound or unmapped tools still count.
	 */
	actions: number;
	/** usage.input summed over unique finalized assistant messages. */
	sent: number;
	/** usage.output summed over unique finalized assistant messages. */
	received: number;
	/** usage.cacheRead summed — the cache-hit bucket. */
	cacheRead: number;
	/** usage.cacheWrite summed — tracked and persisted, never a hit. */
	cacheWrite: number;
	/** cacheRead / (sent + cacheRead), 0 when the denominator is zero. */
	hitRate: number;
	/** Authoritative run wall time, agent_start → terminal agent_end. */
	durationMs: number;
	/** True when any tool execution of the run reported an error. */
	hasError: boolean;
	/** Unique finalized assistant messages aggregated. */
	messages: number;
	/** Epoch ms of the terminal agent_end. */
	completedAt: number;
}

/** Bounded, typed, non-context persisted evidence for replay. */
export interface RunStatsEvidence {
	version: 1;
	runId: string;
	actions: number;
	sent: number;
	received: number;
	cacheRead: number;
	cacheWrite: number;
	hitRate: number;
	durationMs: number;
	hasError: boolean;
	messages: number;
	completedAt: number;
}

/** The plugin-owned foldable transcript block that carries the stats line. */
export interface StatsCarrier {
	render(width: number): readonly string[];
	readonly message: { readonly customType: string };
}

const STATS_SEPARATOR_COLOR = "#A4D734";

function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function nonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
}

function isBoundedCount(value: unknown, max: number): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= max
	);
}

function usageOf(message: unknown): {
	sent: number;
	received: number;
	cacheRead: number;
	cacheWrite: number;
} {
	const usage = objectRecord(objectRecord(message).usage);
	return {
		sent: nonNegativeNumber(usage.input),
		received: nonNegativeNumber(usage.output),
		cacheRead: nonNegativeNumber(usage.cacheRead),
		cacheWrite: nonNegativeNumber(usage.cacheWrite),
	};
}

/**
 * Structural assistant-usage check for `message_end` filtering: the message
 * must carry a REAL usage record. Missing/null/primitives/arrays fail (the
 * completion has no usage to aggregate and is ignored entirely), while an
 * empty or all-zero usage object is legitimate and counts once. Never uses
 * `objectRecord` — it would mask null/primitives as `{}`.
 */
export function hasAssistantUsage(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const usage = (message as Record<string, unknown>).usage;
	return usage !== null && typeof usage === "object" && !Array.isArray(usage);
}

/**
 * Stable identity for one finalized assistant completion. Streaming hosts
 * redeliver the same completion as fresh objects, so object identity is
 * unusable; `timestamp` uniquely identifies a provider completion in stock
 * OMP. A content/usage fingerprint backs up hosts that omit it.
 */
function messageKey(message: unknown): string {
	const record = objectRecord(message);
	const usage = usageOf(message);
	const totals = `${usage.sent}:${usage.received}:${usage.cacheRead}:${usage.cacheWrite}`;
	const timestamp = record.timestamp;
	if (typeof timestamp === "number" && Number.isFinite(timestamp))
		return `t:${timestamp}:${String(record.stopReason ?? "")}:${totals}`;
	let textLength = 0;
	const content = record.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			const text = objectRecord(block).text;
			if (typeof text === "string") textLength += Math.min(text.length, 4_096);
		}
	}
	return `c:${Array.isArray(content) ? content.length : 0}:${textLength}:${totals}`;
}

export function hitRateOf(sent: number, cacheRead: number): number {
	const input = nonNegativeNumber(sent);
	const cached = nonNegativeNumber(cacheRead);
	const total = input + cached;
	return total > 0 ? cached / total : 0;
}

function trimTrailingZero(value: string): string {
	return value.replace(/\.0$/, "");
}

/**
 * Compact token magnitude: `0`, `950`, `1.3k`, `28.2k`, `480.2k`, `1.2M`,
 * `3.1B`. One decimal for magnitudes, trailing `.0` dropped.
 */
export function formatTokens(value: number): string {
	const n = nonNegativeNumber(value);
	if (n >= 1_000_000_000)
		return `${trimTrailingZero((n / 1_000_000_000).toFixed(1))}B`;
	if (n >= 1_000_000) return `${trimTrailingZero((n / 1_000_000).toFixed(1))}M`;
	if (n >= 1_000) return `${trimTrailingZero((n / 1_000).toFixed(1))}k`;
	return `${Math.round(n)}`;
}

/** `0s`, `32s`, `1m 5s`, `1h 20m 32s`. Leading zero units are dropped. */
export function formatDuration(milliseconds: number): string {
	const total = Math.max(0, Math.round(nonNegativeNumber(milliseconds) / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

// Only the foreground is opened, so only the foreground is closed: `[39m`
// keeps any surrounding dim/bold intact and never resets the background,
// matching the transparent-row contract in `fitTransparentLine`.
function fixedForeground(hex: string, text: string): string {
	const ansi = Bun.color(hex, "ansi-16m");
	return ansi ? `${ansi}${text}\u001b[39m` : text;
}

// Intentional per-module copy of fitTransparentLine; identical logic in
// render.ts and run-stats.ts.
/**
 * Keep the row on the terminal's ordinary transparent background while still
 * fitting overlong content to the component width. Short rows are never
 * padded, and no ANSI background open/reset sequence is introduced.
 */
function fitTransparentLine(line: string, width: number | undefined): string {
	if (width === undefined) return line;
	const safeWidth = Math.max(1, width);
	return visibleWidth(line) > safeWidth
		? `${truncateToWidth(line, safeWidth)}\u001b[39m`
		: line;
}

/**
 * Render the configurable terminal stats row:
 * `[ 27 actions · 28.2k sent · 1.3k received · 95% cache (480.2k hit) · 1h 20m 32s ]`
 * Values and brackets stay dim neutral; the `·` separators are
 * `#A4D734` on a clean run and theme warning otherwise. Segments follow the
 * `stats` settings; `stats.enabled === false` or an all-disabled field set
 * renders nothing.
 */
export function statsLine(
	result: RunStatsResult,
	stats: CompactStatsSettings,
	theme: Theme,
	width?: number,
): string {
	if (!stats.enabled) return "";
	const segments: string[] = [];
	if (stats.actions) segments.push(`${result.actions} actions`);
	if (stats.sent) segments.push(`${formatTokens(result.sent)} sent`);
	if (stats.received)
		segments.push(`${formatTokens(result.received)} received`);
	if (stats.cache) {
		// cacheWrite is tracked separately and never counted as a hit.
		const percent = Math.round(result.hitRate * 100);
		segments.push(`${percent}% cache (${formatTokens(result.cacheRead)} hit)`);
	}
	if (stats.time) segments.push(formatDuration(result.durationMs));
	if (segments.length === 0) return "";
	const separator = result.hasError
		? theme.fg("warning", " · ")
		: fixedForeground(STATS_SEPARATOR_COLOR, " · ");
	const content = segments
		.map((segment) => theme.fg("dim", segment))
		.join(separator);
	return fitTransparentLine(
		`${theme.fg("dim", "[")} ${content} ${theme.fg("dim", "]")}`,
		width,
	);
}

export function evidenceFromResult(
	result: RunStatsResult,
	runId: string,
): RunStatsEvidence {
	return {
		version: STATS_EVIDENCE_VERSION,
		runId,
		actions: nonNegativeNumber(result.actions),
		sent: nonNegativeNumber(result.sent),
		received: nonNegativeNumber(result.received),
		cacheRead: nonNegativeNumber(result.cacheRead),
		cacheWrite: nonNegativeNumber(result.cacheWrite),
		hitRate: Math.min(1, Math.max(0, nonNegativeNumber(result.hitRate))),
		durationMs: nonNegativeNumber(result.durationMs),
		hasError: result.hasError === true,
		messages: nonNegativeNumber(result.messages),
		completedAt: nonNegativeNumber(result.completedAt),
	};
}

export function resultFromEvidence(evidence: RunStatsEvidence): RunStatsResult {
	return {
		actions: evidence.actions,
		sent: evidence.sent,
		received: evidence.received,
		cacheRead: evidence.cacheRead,
		cacheWrite: evidence.cacheWrite,
		hitRate: evidence.hitRate,
		durationMs: evidence.durationMs,
		hasError: evidence.hasError,
		messages: evidence.messages,
		completedAt: evidence.completedAt,
	};
}

export function isRunStatsEvidence(value: unknown): value is RunStatsEvidence {
	if (!value || typeof value !== "object") return false;
	const evidence = value as Partial<RunStatsEvidence>;
	return (
		evidence.version === STATS_EVIDENCE_VERSION &&
		typeof evidence.runId === "string" &&
		evidence.runId.length > 0 &&
		evidence.runId.length <= MAX_STATS_RUN_ID_LENGTH &&
		isBoundedCount(evidence.actions, MAX_STATS_ACTIONS) &&
		isBoundedCount(evidence.sent, MAX_STATS_TOKENS) &&
		isBoundedCount(evidence.received, MAX_STATS_TOKENS) &&
		isBoundedCount(evidence.cacheRead, MAX_STATS_TOKENS) &&
		isBoundedCount(evidence.cacheWrite, MAX_STATS_TOKENS) &&
		typeof evidence.hitRate === "number" &&
		Number.isFinite(evidence.hitRate) &&
		evidence.hitRate >= 0 &&
		evidence.hitRate <= 1 &&
		isBoundedCount(evidence.durationMs, MAX_STATS_DURATION_MS) &&
		typeof evidence.hasError === "boolean" &&
		isBoundedCount(evidence.messages, MAX_STATS_ACTIONS) &&
		isBoundedCount(evidence.completedAt, MAX_STATS_DURATION_MS)
	);
}

/**
 * The foldable transcript carrier for the stats row. `message.customType`
 * starts with `omp-compact-`, so the fold treats it as a terminal foldable
 * block: with tool rows it joins the trailing run (row lands after mutation
 * rows and the optional Git summary, directly above the native answer); on
 * no-tool answers it is a single-member run in the same position.
 */
export function createStatsCarrier(line: string): StatsCarrier {
	return {
		message: { customType: STATS_MESSAGE_TYPE },
		render: (width: number) => [fitTransparentLine(line, width)],
	};
}

const ALL_STATS_SEGMENTS: CompactStatsSettings = {
	enabled: true,
	actions: true,
	sent: true,
	received: true,
	cache: true,
	time: true,
};

class StatsMessageLines implements Component {
	readonly #lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, width);
		return this.#lines.map((line) => truncateToWidth(line, safeWidth));
	}
}

/**
 * Component for the persisted evidence entry, so viewers that render custom
 * entries through registered message renderers can show the run row too.
 */
export function statsMessageComponent(
	details: RunStatsEvidence | undefined,
	theme: Theme,
): Component | undefined {
	if (!details || !isRunStatsEvidence(details)) return undefined;
	return new StatsMessageLines([
		statsLine(resultFromEvidence(details), ALL_STATS_SEGMENTS, theme),
	]);
}

/**
 * Per-logical-run usage aggregator. `start()` at agent_start, finalized
 * assistant completions via `observeAssistantMessage`, tool error marks via
 * `recordToolError`, then `endRun(terminal)` locks the terminal result.
 * The plugin synchronously freezes/persists that result before asynchronous
 * audit projection work; visual placement may follow after the drain.
 * Continuations (`endRun(false)` followed by another `start()`) keep
 * accumulating into the same logical run; the next user prompt starts fresh.
 */
export class RunStats {
	readonly #now: () => number;
	#state: "idle" | "running" | "finalized" = "idle";
	#continuationPending = false;
	#startedAt = 0;
	#completedAt = 0;
	#sent = 0;
	#received = 0;
	#cacheRead = 0;
	#cacheWrite = 0;
	#messages = 0;
	#actions = new Set<string>();
	#errorToolIds = new Set<string>();
	#seenMessages = new Set<string>();
	#result: RunStatsResult | undefined;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	get active(): boolean {
		return this.#state === "running";
	}

	hasError(): boolean {
		return this.#errorToolIds.size > 0;
	}

	/**
	 * Authoritative logical-run start. A `start()` while the previous
	 * agent_end was a continuation (`endRun(false)`) keeps the run open.
	 */
	start(): void {
		if (this.#state === "running" && this.#continuationPending) {
			this.#continuationPending = false;
			return;
		}
		this.#continuationPending = false;
		this.#state = "running";
		this.#startedAt = this.#now();
		this.#sent = 0;
		this.#received = 0;
		this.#cacheRead = 0;
		this.#cacheWrite = 0;
		this.#messages = 0;
		this.#actions.clear();
		this.#errorToolIds.clear();
		this.#seenMessages.clear();
		this.#result = undefined;
	}

	/**
	 * Observe one finalized assistant completion (message_update `done`/
	 * `error` payloads only — never partial deltas). Each unique completion
	 * with a structural usage record is aggregated once, regardless of how
	 * many tool calls it carries; completions without one are ignored.
	 */
	observeAssistantMessage(message: unknown): void {
		if (this.#state !== "running") return;
		if (!hasAssistantUsage(message)) return;
		const key = messageKey(message);
		if (this.#seenMessages.has(key)) return;
		this.#seenMessages.add(key);
		const usage = usageOf(message);
		this.#sent += usage.sent;
		this.#received += usage.received;
		this.#cacheRead += usage.cacheRead;
		this.#cacheWrite += usage.cacheWrite;
		this.#messages++;
	}

	/** Mark a tool execution as failed (tool_execution_end with isError). */
	recordToolError(toolCallId: string): void {
		if (this.#state !== "running") return;
		if (typeof toolCallId === "string" && toolCallId.length > 0)
			this.#errorToolIds.add(toolCallId);
	}

	/**
	 * Count one distinct tool execution (tool_execution_start). Deduplicated
	 * by toolCallId; empty/provisional ids are skipped. The count is locked
	 * into the result at the terminal `endRun`, so continuations accumulate
	 * and a fresh run resets it.
	 */
	recordTool(toolCallId: string): void {
		if (this.#state !== "running") return;
		if (typeof toolCallId === "string" && toolCallId.length > 0)
			this.#actions.add(toolCallId);
	}

	/** Distinct tool executions observed so far in the open run. */
	get actions(): number {
		return this.#actions.size;
	}

	/**
	 * agent_end signal. A non-terminal end (`willContinue`/toolUse) leaves the
	 * run open for the continuation; a terminal end locks the result.
	 */
	endRun(terminal: boolean): void {
		if (this.#state !== "running") return;
		if (!terminal) {
			this.#continuationPending = true;
			return;
		}
		this.#completedAt = this.#now();
		this.#result = {
			actions: this.#actions.size,
			sent: this.#sent,
			received: this.#received,
			cacheRead: this.#cacheRead,
			cacheWrite: this.#cacheWrite,
			hitRate: hitRateOf(this.#sent, this.#cacheRead),
			durationMs: Math.max(0, this.#completedAt - this.#startedAt),
			hasError: this.#errorToolIds.size > 0,
			messages: this.#messages,
			completedAt: this.#completedAt,
		};
		this.#state = "finalized";
	}

	/**
	 * A terminal end WITHOUT an answer (abort/error, classified full):
	 * discard the open run so its partial usage never leaks into the next
	 * run's row and never renders one itself. Unlike `endRun(false)` this
	 * also clears the continuation flag, so the next `start()` opens fresh.
	 * Only acts on an open run: a stale abort never erases a locked result.
	 */
	abort(): void {
		if (this.#state !== "running") return;
		this.#state = "idle";
		this.#continuationPending = false;
		this.#actions.clear();
		this.#errorToolIds.clear();
		this.#seenMessages.clear();
		this.#result = undefined;
	}

	/**
	 * The locked result of the last terminal endRun. Idempotent: repeated
	 * calls return the same object until the next `start()`.
	 */
	finalize(): RunStatsResult | undefined {
		return this.#result;
	}

	/** Session teardown: drop partial state so a later session starts clean. */
	dispose(): void {
		this.#state = "idle";
		this.#continuationPending = false;
		this.#actions.clear();
		this.#seenMessages.clear();
		this.#errorToolIds.clear();
		this.#result = undefined;
	}
}
