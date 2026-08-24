import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/schema";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

import { fitTransparentLine } from "./fit-transparent-line";
import { objectRecord } from "./object-record";
import type {
	VibeCli,
	VibeOp,
	VibeScreenSnapshot,
	VibeToolDetails,
} from "./vibe-cards-decode";
import {
	renderBadge,
	renderDurationSlot,
	renderHighlightedActivity,
	renderModelSlot,
	renderName,
	renderTurns,
	sanitizeText,
} from "./vibe-cards-slots";

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

const DEAD_TTL_MS = 5_000;
const ABORTED_TTL_MS = 5_000;
const FAILED_TTL_MS = 10_000;
const CANCELLED_TTL_MS = 10_000;

const CURSOR_GLYPH = "▌";

/**
 * Select the active braille spinner frame for a pending animation tick.
 *
 * Uses `theme.getSpinnerFrames("activity")` when available, falls back to
 * `theme.spinnerFrames`, then defaults to the bullet `"•"`. This is the
 * canonical fallback chain used across compact renderers.
 */
export function pendingFrame(theme: Theme, tick: number): string {
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
