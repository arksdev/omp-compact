/**
 * Compact presentation renderer for OMP vibe multi-agent worker sessions.
 *
 * Single source of truth transforming structured vibe tool outcomes
 * (`vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`) into
 * compact one-to-two-line terminal cards. Replaces stock multi-line framed
 * TV walls with high-density status rows preserving live tool progress,
 * worker lifecycle state, queue depths, duration, and settlement evidence.
 *
 * Design constraints:
 * - Pure functions only: no timers, no module-level mutable state, no host calls.
 * - Defensive parsing: unpacks unknown result payloads without throwing or leaking.
 * - Code-point safety: surrogate pairs and wide glyphs are never split.
 * - Single-line trimming: only the final text slot truncates to fit width.
 */
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/schema";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils/format";

import { codePointLength, truncateCodePoints } from "./compact";
import { stripRejectedControls } from "./display-control";
import { fitTransparentLine } from "./fit-transparent-line";
import { objectRecord } from "./object-record";

/** CLI execution mode of a worker session. */
export type VibeCli = "fast" | "good";

/** Lifecycle state of a worker session. */
export type VibeSessionState = "running" | "starting" | "idle" | "dead";

/** Single session screen snapshot. */
export interface VibeScreenSnapshot {
	id: string;
	cli: VibeCli;
	state: VibeSessionState;
	model?: string;
	turns: number;
	queued: number;
	turnStartedAt?: number;
	turnMessage?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	trace: readonly string[];
	outputTail: readonly string[];
	lastActivity?: string;
	lastActivityAt: number;
}

/** Vibe tool operation kind. */
export type VibeOp = "spawn" | "send" | "wait" | "kill" | "list";

/** Outcome of a spawn call. */
export interface VibeSpawnInfo {
	id: string;
	cli: VibeCli;
	jobId: string;
}

/** Outcome of a send call. */
export interface VibeSendInfo {
	id: string;
	mode: "turn" | "steered" | "queued";
	jobId?: string;
}

/** Settled entry in a wait outcome. */
export interface VibeWaitSettled {
	id: string;
	jobId: string;
	status: "completed" | "failed" | "cancelled";
}

/** Outcome of a wait call. */
export interface VibeWaitInfo {
	settled: readonly VibeWaitSettled[];
	stillRunning: readonly string[];
	timedOut: boolean;
	waiting?: boolean;
}

/** Outcome of a kill call. */
export interface VibeKillInfo {
	id: string;
	cancelledTurn: boolean;
}

/** Full structured details payload of a vibe tool call. */
export interface VibeToolDetails {
	op: VibeOp;
	screens: readonly VibeScreenSnapshot[];
	spawned?: VibeSpawnInfo;
	send?: VibeSendInfo;
	wait?: VibeWaitInfo;
	killed?: VibeKillInfo;
}

/** View configuration passed to the compact vibe row renderer. */
export interface CompactVibeView {
	op: VibeOp;
	details?: VibeToolDetails;
	args?: unknown;
	isPartial?: boolean;
	tick?: number;
	now?: number;
	isError?: boolean;
	result?: unknown;
}

const MAX_ID_CODE_POINTS = 24;
const MAX_MODEL_CODE_POINTS = 16;

const DEAD_TTL_MS = 5_000;
const ABORTED_TTL_MS = 5_000;
const FAILED_TTL_MS = 10_000;
const CANCELLED_TTL_MS = 10_000;

const CURSOR_GLYPH = "▌";

/**
 * Sanitize arbitrary input to a single clean line of text.
 */
function sanitizeText(value: unknown, limit?: number): string {
	const text = typeof value === "string" ? value : "";
	const clean = stripRejectedControls(Bun.stripANSI(text))
		.replace(/\s+/g, " ")
		.trim();
	if (limit === undefined || clean.length <= limit) return clean;
	const chars = Array.from(clean);
	if (chars.length <= limit) return clean;
	return `${chars.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

/**
 * Select the active braille spinner frame for a pending animation tick.
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

/**
 * Parse and validate a single session screen snapshot defensively.
 */
function sanitizeScreenSnapshot(
	candidate: unknown,
): VibeScreenSnapshot | undefined {
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
		return undefined;
	}
	const rec = candidate as Record<string, unknown>;
	const id = typeof rec.id === "string" ? rec.id.trim() : "";
	if (!id) return undefined;

	const cli: VibeCli = rec.cli === "good" ? "good" : "fast";
	const stateRaw = rec.state;
	const state: VibeSessionState =
		stateRaw === "running" ||
		stateRaw === "starting" ||
		stateRaw === "idle" ||
		stateRaw === "dead"
			? stateRaw
			: "idle";

	const turns =
		typeof rec.turns === "number" &&
		Number.isFinite(rec.turns) &&
		rec.turns >= 0
			? Math.floor(rec.turns)
			: 0;
	const queued =
		typeof rec.queued === "number" &&
		Number.isFinite(rec.queued) &&
		rec.queued >= 0
			? Math.floor(rec.queued)
			: 0;

	const lastActivityAt =
		typeof rec.lastActivityAt === "number" &&
		Number.isFinite(rec.lastActivityAt)
			? rec.lastActivityAt
			: 0;

	const model =
		typeof rec.model === "string" && rec.model.trim()
			? rec.model.trim()
			: undefined;
	const turnStartedAt =
		typeof rec.turnStartedAt === "number" &&
		Number.isFinite(rec.turnStartedAt) &&
		rec.turnStartedAt > 0
			? rec.turnStartedAt
			: undefined;
	const turnMessage =
		typeof rec.turnMessage === "string" && rec.turnMessage.trim()
			? rec.turnMessage.trim()
			: undefined;
	const currentTool =
		typeof rec.currentTool === "string" && rec.currentTool.trim()
			? rec.currentTool.trim()
			: undefined;
	const currentToolArgs =
		typeof rec.currentToolArgs === "string" && rec.currentToolArgs.trim()
			? rec.currentToolArgs.trim()
			: undefined;
	const lastIntent =
		typeof rec.lastIntent === "string" && rec.lastIntent.trim()
			? rec.lastIntent.trim()
			: undefined;
	const lastActivity =
		typeof rec.lastActivity === "string" && rec.lastActivity.trim()
			? rec.lastActivity.trim()
			: undefined;

	const trace = Array.isArray(rec.trace)
		? rec.trace.filter((s): s is string => typeof s === "string")
		: [];
	const outputTail = Array.isArray(rec.outputTail)
		? rec.outputTail.filter((s): s is string => typeof s === "string")
		: [];

	return {
		id,
		cli,
		state,
		model,
		turns,
		queued,
		turnStartedAt,
		turnMessage,
		currentTool,
		currentToolArgs,
		lastIntent,
		trace,
		outputTail,
		lastActivity,
		lastActivityAt,
	};
}

/**
 * Unpack and validate structured vibe tool details from an unknown value.
 *
 * Accepts either the tool result wrapper `{ details: ... }` or the direct details payload.
 * Never throws exceptions on malformed, unexpected, or cyclic inputs.
 */
export function unpackVibeToolDetails(
	result: unknown,
): VibeToolDetails | undefined {
	if (!result || typeof result !== "object") return undefined;
	try {
		const rec = result as Record<string, unknown>;
		const candidate =
			rec.details !== null &&
			typeof rec.details === "object" &&
			!Array.isArray(rec.details)
				? (rec.details as Record<string, unknown>)
				: rec;

		const opRaw = candidate.op;
		if (
			opRaw !== "spawn" &&
			opRaw !== "send" &&
			opRaw !== "wait" &&
			opRaw !== "kill" &&
			opRaw !== "list"
		) {
			return undefined;
		}
		const op = opRaw as VibeOp;

		if (!Array.isArray(candidate.screens)) {
			return undefined;
		}

		const screens: VibeScreenSnapshot[] = [];
		for (const item of candidate.screens) {
			const sanitized = sanitizeScreenSnapshot(item);
			if (sanitized) screens.push(sanitized);
		}

		let spawned: VibeSpawnInfo | undefined;
		if (
			candidate.spawned &&
			typeof candidate.spawned === "object" &&
			!Array.isArray(candidate.spawned)
		) {
			const s = candidate.spawned as Record<string, unknown>;
			if (
				typeof s.id === "string" &&
				typeof s.jobId === "string" &&
				(s.cli === "fast" || s.cli === "good")
			) {
				spawned = {
					id: s.id,
					cli: s.cli,
					jobId: s.jobId,
				};
			}
		}

		let send: VibeSendInfo | undefined;
		if (
			candidate.send &&
			typeof candidate.send === "object" &&
			!Array.isArray(candidate.send)
		) {
			const s = candidate.send as Record<string, unknown>;
			if (
				typeof s.id === "string" &&
				(s.mode === "turn" || s.mode === "steered" || s.mode === "queued")
			) {
				send = {
					id: s.id,
					mode: s.mode,
					jobId: typeof s.jobId === "string" ? s.jobId : undefined,
				};
			}
		}

		let wait: VibeWaitInfo | undefined;
		if (
			candidate.wait &&
			typeof candidate.wait === "object" &&
			!Array.isArray(candidate.wait)
		) {
			const w = candidate.wait as Record<string, unknown>;
			const settled: VibeWaitSettled[] = [];
			if (Array.isArray(w.settled)) {
				for (const item of w.settled) {
					if (item && typeof item === "object" && !Array.isArray(item)) {
						const entry = item as Record<string, unknown>;
						if (
							typeof entry.id === "string" &&
							typeof entry.jobId === "string" &&
							(entry.status === "completed" ||
								entry.status === "failed" ||
								entry.status === "cancelled")
						) {
							settled.push({
								id: entry.id,
								jobId: entry.jobId,
								status: entry.status,
							});
						}
					}
				}
			}

			const stillRunning = Array.isArray(w.stillRunning)
				? w.stillRunning.filter((s): s is string => typeof s === "string")
				: [];

			wait = {
				settled,
				stillRunning,
				timedOut: w.timedOut === true,
				waiting: w.waiting === true ? true : undefined,
			};
		}

		let killed: VibeKillInfo | undefined;
		if (
			candidate.killed &&
			typeof candidate.killed === "object" &&
			!Array.isArray(candidate.killed)
		) {
			const k = candidate.killed as Record<string, unknown>;
			if (typeof k.id === "string") {
				killed = {
					id: k.id,
					cancelledTurn: k.cancelledTurn === true,
				};
			}
		}

		return {
			op,
			screens,
			spawned,
			send,
			wait,
			killed,
		};
	} catch {
		return undefined;
	}
}

function renderBadge(
	cli: string | undefined,
	role: ThemeColor,
	theme: Theme,
): string {
	const left = theme.format?.bracketLeft ?? "⟦";
	const right = theme.format?.bracketRight ?? "⟧";
	const letter =
		cli === "fast"
			? "f"
			: cli === "good"
				? "g"
				: typeof cli === "string" && cli.length > 0
					? (cli[0]?.toLowerCase() ?? "?")
					: "?";
	return theme.fg(role, `${left}${letter}${right}`);
}

/**
 * Format session ID capped at 24 code points with terminal ellipsis.
 */
function renderName(id: string, theme: Theme): string {
	const sanitized = sanitizeText(id);
	const formatted =
		codePointLength(sanitized) > MAX_ID_CODE_POINTS
			? `${truncateCodePoints(sanitized, MAX_ID_CODE_POINTS - 1)}…`
			: sanitized;
	return theme.fg("muted", formatted);
}

/**
 * Format turn count and queue depth: `{N}t[+{M}q]`.
 */
function renderTurns(turns: number, queued: number, theme: Theme): string {
	const text = `${turns}t${queued > 0 ? `+${queued}q` : ""}`;
	return theme.fg("muted", text);
}

/**
 * Format duration slot if elapsed time is known.
 */
function renderDurationSlot(
	turnStartedAt: number | undefined,
	now: number,
	theme: Theme,
): string | undefined {
	if (turnStartedAt === undefined) return undefined;
	const elapsed = Math.max(0, now - turnStartedAt);
	return theme.fg("dim", formatDuration(elapsed));
}

/**
 * Format short model name (post-slash, pre-colon, max 16 code points).
 */
function renderModelSlot(
	model: string | undefined,
	theme: Theme,
): string | undefined {
	if (!model) return undefined;
	let name = sanitizeText(model);
	const slashIdx = name.lastIndexOf("/");
	if (slashIdx >= 0) name = name.slice(slashIdx + 1);
	const colonIdx = name.indexOf(":");
	if (colonIdx >= 0) name = name.slice(0, colonIdx);
	if (!name) return undefined;
	if (codePointLength(name) > MAX_MODEL_CODE_POINTS) {
		name = `${truncateCodePoints(name, MAX_MODEL_CODE_POINTS - 1)}…`;
	}
	return theme.fg("muted", name);
}

/**
 * Highlight a specific keyword as `error` while rendering the rest as `muted`.
 */
function renderHighlightedActivity(
	text: string,
	keyword: "killed" | "aborted",
	theme: Theme,
): string {
	const parts = text.split(new RegExp(`(${keyword})`, "g"));
	return parts
		.map((part) => {
			if (!part) return "";
			if (part === keyword) return theme.fg("error", part);
			return theme.fg("muted", part);
		})
		.join("");
}

/**
 * Build one rendered line by fitting the final text slot to the remaining width.
 */
function buildRowWithTruncation(
	boxPrefix: string | undefined,
	slots: readonly (string | undefined)[],
	rawText: string,
	formatText: (text: string) => string,
	suffix: string | undefined,
	width: number | undefined,
): string {
	const nonNullSlots = slots.filter((s): s is string => Boolean(s));
	const prefixBody = nonNullSlots.join(" ");
	const box = boxPrefix ?? "";
	const fixedPrefix = rawText
		? `${box}${prefixBody}${prefixBody.length > 0 ? " " : ""}`
		: `${box}${prefixBody}`;
	const fixedSuffix = suffix ?? "";

	if (!rawText) {
		const full = `${fixedPrefix}${fixedSuffix}`;
		return fitTransparentLine(full, width);
	}

	let textContent = rawText;
	if (width !== undefined) {
		const usedWidth = visibleWidth(fixedPrefix) + visibleWidth(fixedSuffix);
		const availableWidth = width - usedWidth;
		if (availableWidth <= 0) {
			textContent = "";
		} else if (visibleWidth(rawText) > availableWidth) {
			textContent = truncateToWidth(rawText, availableWidth);
		}
	}

	const formattedText = textContent ? formatText(textContent) : "";
	const fullLine = `${fixedPrefix}${formattedText}${fixedSuffix}`;
	return fitTransparentLine(fullLine, width);
}

/**
 * Render a single worker card (1 or 2 lines) based on snapshot state or settled wait outcome.
 */
function renderSessionCard(
	screen: VibeScreenSnapshot,
	settledStatus: "completed" | "failed" | "cancelled" | undefined,
	theme: Theme,
	tick: number,
	now: number,
	width: number | undefined,
): readonly string[] {
	const boxRound = theme.boxRound ?? {};
	const topLeft = boxRound.topLeft ?? "╭";
	const bottomLeft = boxRound.bottomLeft ?? "╰";
	const horizontal = boxRound.horizontal ?? "─";

	const topPrefix = `${theme.fg("dim", `${topLeft}${horizontal}`)} `;
	const bottomPrefix = `${theme.fg("dim", `${bottomLeft}${horizontal}`)} `;

	// Settled wait overlay
	if (settledStatus) {
		let glyph = "";
		let badgeRole: ThemeColor = "muted";
		let footerRole: ThemeColor = "success";
		let footerLabel = "turn completed — result delivered";

		if (settledStatus === "completed") {
			glyph = theme.fg("success", "∷");
			badgeRole = "success";
			footerRole = "success";
			footerLabel = "turn completed — result delivered";
		} else if (settledStatus === "failed") {
			glyph = theme.fg("error", "∵");
			badgeRole = "error";
			footerRole = "error";
			footerLabel = "turn failed — result delivered";
		} else {
			glyph = theme.fg("error", "∵");
			badgeRole = "error";
			footerRole = "error";
			footerLabel = "turn cancelled — result delivered";
		}

		const badge = renderBadge(screen.cli, badgeRole, theme);
		const name = renderName(screen.id, theme);
		const turns = renderTurns(screen.turns, screen.queued, theme);
		const duration = renderDurationSlot(screen.turnStartedAt, now, theme);
		const model = renderModelSlot(screen.model, theme);
		const activityRaw = sanitizeText(screen.lastActivity ?? "");

		const formatActivity = (plain: string): string => {
			if (settledStatus === "cancelled") {
				return renderHighlightedActivity(plain, "killed", theme);
			}
			return theme.fg("text", plain);
		};

		const line1 = buildRowWithTruncation(
			topPrefix,
			[glyph, badge, name, turns, duration, model],
			activityRaw,
			formatActivity,
			undefined,
			width,
		);

		const line2 = buildRowWithTruncation(
			bottomPrefix,
			[],
			footerLabel,
			(plain) => theme.fg(footerRole, plain),
			undefined,
			width,
		);

		return [line1, line2];
	}

	// Starting state
	if (screen.state === "starting") {
		const glyph = theme.fg("success", "∴");
		const badge = renderBadge(screen.cli, "muted", theme);
		const name = renderName(screen.id, theme);
		const turns = renderTurns(screen.turns, screen.queued, theme);
		const rawText = sanitizeText(screen.turnMessage ?? "");

		const line = buildRowWithTruncation(
			undefined,
			[glyph, badge, name, turns],
			rawText,
			(plain) => theme.fg("text", plain),
			undefined,
			width,
		);
		return [line];
	}

	// Running state
	if (screen.state === "running") {
		const spinner = pendingFrame(theme, tick);
		const glyph = theme.fg("accent", spinner);
		const badge = renderBadge(screen.cli, "accent", theme);
		const name = renderName(screen.id, theme);
		const turns = renderTurns(screen.turns, screen.queued, theme);
		const duration = renderDurationSlot(screen.turnStartedAt, now, theme);
		const model = renderModelSlot(screen.model, theme);

		// Compute tail line
		let tailRaw: string | undefined;
		if (screen.currentTool) {
			const detail = screen.lastIntent ?? screen.currentToolArgs;
			tailRaw = detail
				? `${screen.currentTool}: ${detail}`
				: screen.currentTool;
		} else if (screen.lastIntent) {
			tailRaw = screen.lastIntent;
		}

		const turnMessageRaw = sanitizeText(screen.turnMessage ?? "");

		if (turnMessageRaw) {
			// Two-line mode if tail exists
			if (tailRaw) {
				const line1 = buildRowWithTruncation(
					topPrefix,
					[glyph, badge, name, turns, duration, model],
					turnMessageRaw,
					(plain) => theme.fg("text", plain),
					undefined,
					width,
				);

				const line2 = buildRowWithTruncation(
					bottomPrefix,
					[theme.fg("accent", spinner)],
					sanitizeText(tailRaw),
					(plain) => theme.fg("muted", plain),
					undefined,
					width,
				);
				return [line1, line2];
			}

			// Single-line mode without tail
			const line = buildRowWithTruncation(
				undefined,
				[glyph, badge, name, turns, duration, model],
				turnMessageRaw,
				(plain) => theme.fg("text", plain),
				undefined,
				width,
			);
			return [line];
		}

		// Line-saving rule: no turn message -> tail lifted to line 1 text slot
		const liftedTail = tailRaw ? sanitizeText(tailRaw) : "";
		const line = buildRowWithTruncation(
			undefined,
			[glyph, badge, name, turns, duration, model],
			liftedTail,
			(plain) => theme.fg("muted", plain),
			undefined,
			width,
		);
		return [line];
	}

	// Dead state
	if (screen.state === "dead") {
		if (now - screen.lastActivityAt >= DEAD_TTL_MS) {
			return [];
		}
		const glyph = theme.fg("error", "∵");
		const badge = renderBadge(screen.cli, "error", theme);
		const name = renderName(screen.id, theme);
		const turns = renderTurns(screen.turns, screen.queued, theme);
		const model = renderModelSlot(screen.model, theme);
		const activityRaw = sanitizeText(screen.lastActivity);

		const line = buildRowWithTruncation(
			undefined,
			[glyph, badge, name, turns, undefined, model],
			activityRaw,
			(plain) => renderHighlightedActivity(plain, "killed", theme),
			undefined,
			width,
		);
		return [line];
	}

	// Idle state (with activity)
	if (!screen.lastActivity) {
		return [];
	}

	// Runtime snapshots only define four lifecycle states ("starting" | "running" | "idle" | "dead")
	// in node_modules/@oh-my-pi/pi-coding-agent/src/vibe/runtime.ts:205-225 (VibeScreenSnapshot / VibeSessionState).
	// An aborted turn transitions the worker to "idle" and records the abort message in lastActivity.
	// Therefore, aborted status must be inferred from the lastActivity text heuristic.
	const isAborted = Boolean(
		screen.lastActivity && /\baborted\b/i.test(screen.lastActivity),
	);
	if (isAborted && now - screen.lastActivityAt >= ABORTED_TTL_MS) {
		return [];
	}

	const glyph = isAborted ? theme.fg("muted", "∷") : theme.fg("text", "∷");
	const badge = renderBadge(screen.cli, "muted", theme);
	const name = renderName(screen.id, theme);
	const turns = renderTurns(screen.turns, screen.queued, theme);
	const duration = renderDurationSlot(screen.turnStartedAt, now, theme);
	const model = renderModelSlot(screen.model, theme);
	const activityRaw = sanitizeText(screen.lastActivity);

	const line = buildRowWithTruncation(
		undefined,
		[glyph, badge, name, turns, duration, model],
		activityRaw,
		(plain) =>
			isAborted
				? renderHighlightedActivity(plain, "aborted", theme)
				: theme.fg("text", plain),
		undefined,
		width,
	);
	return [line];
}

/**
 * Extract target identifier from args for error/status fallbacks.
 */
function extractTargetDescription(op: VibeOp, args: unknown): string {
	const rec = objectRecord(args);
	switch (op) {
		case "spawn": {
			const name = typeof rec.name === "string" ? rec.name.trim() : "";
			return name ? `vibe spawn ${name}` : "vibe spawn";
		}
		case "send": {
			const session = typeof rec.session === "string" ? rec.session.trim() : "";
			return session ? `vibe send ${session}` : "vibe send";
		}
		case "wait": {
			if (Array.isArray(rec.sessions) && rec.sessions.length > 0) {
				const targets = rec.sessions
					.filter(
						(s): s is string => typeof s === "string" && s.trim().length > 0,
					)
					.join(", ");
				if (targets) return `vibe wait ${targets}`;
			}
			const session = typeof rec.session === "string" ? rec.session.trim() : "";
			return session ? `vibe wait ${session}` : "vibe wait";
		}
		case "kill": {
			const session = typeof rec.session === "string" ? rec.session.trim() : "";
			return session ? `vibe kill ${session}` : "vibe kill";
		}
		case "list":
			return "vibe sessions";
	}
}

/**
 * Extract error message text from a raw result or error payload.
 */
function extractErrorText(result: unknown): string {
	if (!result) return "";
	if (typeof result === "string") {
		return sanitizeText(result);
	}
	const rec = objectRecord(result);
	if (Array.isArray(rec.content)) {
		for (const part of rec.content) {
			if (part && typeof part === "object") {
				const item = part as Record<string, unknown>;
				if (typeof item.text === "string" && item.text.trim()) {
					return sanitizeText(item.text);
				}
			}
		}
	}
	if (typeof rec.error === "string" && rec.error.trim()) {
		return sanitizeText(rec.error);
	}
	if (typeof rec.message === "string" && rec.message.trim()) {
		return sanitizeText(rec.message);
	}
	return "";
}

/**
 * Render an error status row when tool execution failed or details are missing.
 */
function renderErrorRow(
	view: CompactVibeView,
	theme: Theme,
	width?: number,
): readonly string[] {
	const icon = theme.fg("error", "✘");
	const prefix = theme.fg(
		"muted",
		extractTargetDescription(view.op, view.args),
	);
	const errorText = extractErrorText(view.result);

	const text = errorText
		? `${icon} ${prefix} — ${theme.fg("error", errorText)}`
		: `${icon} ${prefix}`;

	return [fitTransparentLine(text, width)];
}

/**
 * Main entry point: render structured vibe tool rows into compact terminal lines.
 */
export function renderCompactVibeRows(
	view: CompactVibeView,
	theme: Theme,
	width?: number,
): readonly string[] {
	const now = view.now ?? Date.now();
	const tick = view.tick ?? 0;
	const isPartial = view.isPartial === true;
	const { op, details } = view;

	if (
		view.isError ||
		(!details && !(isPartial && (op === "spawn" || op === "send")))
	) {
		return renderErrorRow(view, theme, width);
	}

	// Operation: kill -> nothing printed
	if (op === "kill") {
		return [];
	}

	// Operation: spawn echo
	if (op === "spawn") {
		const glyph = isPartial ? theme.fg("dim", "∴") : theme.fg("success", "∴");
		const rawArgs = objectRecord(view.args);
		const argCli: VibeCli | undefined =
			rawArgs.cli === "fast" || rawArgs.cli === "good"
				? rawArgs.cli
				: undefined;
		const spawnedCli = details?.spawned?.cli ?? argCli ?? "fast";
		const badge = renderBadge(spawnedCli, "muted", theme);
		const rawName =
			details?.spawned?.id ??
			(typeof rawArgs.name === "string" ? rawArgs.name : "");
		const name = renderName(rawName, theme);
		const turns = renderTurns(0, 0, theme);
		const rawPrompt = sanitizeText(rawArgs.prompt ?? rawArgs.message ?? "");
		const suffix = isPartial ? theme.fg("accent", CURSOR_GLYPH) : undefined;

		const line = buildRowWithTruncation(
			undefined,
			[glyph, badge, name, turns],
			rawPrompt,
			(plain) => theme.fg("text", plain),
			suffix,
			width,
		);
		return [line];
	}

	// Operation: send echo
	if (op === "send") {
		const glyph = isPartial ? theme.fg("dim", "→") : theme.fg("success", "→");
		const rawArgs = objectRecord(view.args);
		const targetId =
			typeof rawArgs.session === "string"
				? rawArgs.session
				: typeof rawArgs.id === "string"
					? rawArgs.id
					: (details?.send?.id ?? "");

		const targetScreen = details?.screens.find((s) => s.id === targetId);
		const badge = targetScreen?.cli
			? renderBadge(targetScreen.cli, "muted", theme)
			: undefined;
		const name = renderName(targetId, theme);
		const rawMessage = sanitizeText(rawArgs.message ?? rawArgs.prompt ?? "");

		let suffix: string | undefined;
		if (isPartial) {
			suffix = theme.fg("accent", CURSOR_GLYPH);
		} else if (details?.send?.mode === "steered") {
			suffix = `  ${theme.fg("muted", "steered")}`;
		} else if (details?.send?.mode === "queued") {
			const q = targetScreen?.queued ?? 0;
			const label = q > 0 ? `queued +${q}q` : "queued";
			suffix = `  ${theme.fg("muted", label)}`;
		}

		const line = buildRowWithTruncation(
			undefined,
			[glyph, badge, name],
			rawMessage,
			(plain) => theme.fg("text", plain),
			suffix,
			width,
		);
		return [line];
	}

	// Operation: wait
	if (op === "wait") {
		const isWaiting = details?.wait?.waiting === true || isPartial;
		const settledRecords: Record<string, "completed" | "failed" | "cancelled"> =
			{};
		if (details?.wait?.settled) {
			for (const s of details.wait.settled) {
				settledRecords[s.id] = s.status;
			}
		}

		const renderedCards: string[] = [];
		let renderedCardCount = 0;

		if (details?.screens) {
			if (isWaiting) {
				for (const screen of details.screens) {
					if (
						screen.state === "running" ||
						screen.state === "starting" ||
						screen.state === "dead"
					) {
						const card = renderSessionCard(
							screen,
							undefined,
							theme,
							tick,
							now,
							width,
						);
						if (card.length > 0) {
							renderedCards.push(...card);
							renderedCardCount++;
						}
					}
				}
			} else {
				for (const screen of details.screens) {
					const settledStatus = settledRecords[screen.id];
					if (!settledStatus) continue;

					// Check TTL for settled outcomes
					if (settledStatus === "failed") {
						if (now - screen.lastActivityAt >= FAILED_TTL_MS) continue;
					} else if (settledStatus === "cancelled") {
						if (now - screen.lastActivityAt >= CANCELLED_TTL_MS) continue;
					}

					const card = renderSessionCard(
						screen,
						settledStatus,
						theme,
						tick,
						now,
						width,
					);
					if (card.length > 0) {
						renderedCards.push(...card);
						renderedCardCount++;
					}
				}
			}
		}

		// Header if 0 cards or 2+ cards (omitted only when renderedCardCount === 1)
		const runningCount =
			details?.screens.filter(
				(s) => s.state === "running" || s.state === "starting",
			).length ?? 0;
		const settledCount = details?.wait?.settled.length ?? 0;
		const timedOut = details?.wait?.timedOut === true;

		if (renderedCardCount !== 1) {
			const metaParts: string[] = [];
			if (runningCount > 0) metaParts.push(`${runningCount} on air`);
			if (settledCount > 0) metaParts.push(`${settledCount} settled`);

			const baseHeader =
				metaParts.length > 0 ? `vibe wait ${metaParts.join(" ")}` : "vibe wait";

			const headerLine = timedOut
				? `${theme.fg("muted", baseHeader)} ${theme.fg("error", "timed out")}`
				: theme.fg("muted", baseHeader);

			return [fitTransparentLine(headerLine, width), ...renderedCards];
		}

		return renderedCards;
	}

	// Operation: list
	if (op === "list") {
		const renderedCards: string[] = [];
		let printedCount = 0;

		if (details?.screens) {
			for (const screen of details.screens) {
				if (screen.state !== "dead") {
					const card = renderSessionCard(
						screen,
						undefined,
						theme,
						tick,
						now,
						width,
					);
					if (card.length > 0) {
						renderedCards.push(...card);
						printedCount++;
					}
				}
			}
		}

		const totalCount = details?.screens.length ?? 0;
		const hiddenCount = totalCount - printedCount;

		const headerText =
			hiddenCount > 0
				? `vibe sessions ${totalCount} (${hiddenCount} hidden)`
				: `vibe sessions ${totalCount}`;

		const headerLine = theme.fg("muted", headerText);
		return [fitTransparentLine(headerLine, width), ...renderedCards];
	}

	return [];
}
