import type { Theme, ThemeColor } from "./theme-types";

import { codePointLength, truncateCodePoints } from "./compact";
import { sanitizeOneLine } from "./render-scrape";
import { formatDuration } from "./format-duration";

/**
 * Slot formatters for compact vibe rows.
 *
 * Pure per-slot text shaping — input sanitization plus the badge, name,
 * turns, duration, model, and highlighted-activity slots. Row composition
 * (width fitting, truncation, card assembly) stays in vibe-cards-render.ts.
 */

const MAX_ID_CODE_POINTS = 24;
const MAX_MODEL_CODE_POINTS = 16;

/** Sanitize arbitrary input to a single clean line, without a length budget. */
export function sanitizeText(value: unknown): string {
	return sanitizeOneLine(value, Number.POSITIVE_INFINITY);
}

export function renderBadge(
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
export function renderName(id: string, theme: Theme): string {
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
export function renderTurns(
	turns: number,
	queued: number,
	theme: Theme,
): string {
	const text = `${turns}t${queued > 0 ? `+${queued}q` : ""}`;
	return theme.fg("muted", text);
}

/**
 * Format duration slot if elapsed time is known.
 */
export function renderDurationSlot(
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
export function renderModelSlot(
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
export function renderHighlightedActivity(
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
