import { visibleWidth } from "@oh-my-pi/pi-tui";

import { stripRejectedControls } from "./display-control";
import { fitTransparentLine } from "./fit-transparent-line";
import {
	isBoundedString,
	MAX_EVIDENCE_TEXT_LENGTH,
	MAX_PAYLOAD_BYTES,
} from "./hydration-bounds";
import { objectRecord } from "./object-record";
import { MAX_DESCRIPTION, sanitizeOneLine } from "./render-scrape";
import type { Theme } from "./theme-types";

/**
 * Opt-in compaction of non-blocking advisor notes.
 *
 * The stock card (`createAdvisorMessageCard`) is an opaque object literal over
 * its `details` — it exposes `render` (plus `invalidate`, and `dispose` /
 * `setIgnoreTight` from OMP 18.2.5 on) and keeps the notes in a closure, so a
 * patched transcript child cannot be read back to its message. Binding the
 * card by child order or by an "Advisor" header alone could hide a card whose
 * notes the plugin never saw, which is exactly the risk this module removes:
 * a card is only claimed when its *entire* stripped native layout equals the
 * layout the stock renderer produces for one parsed `details` payload.
 *
 * Therefore:
 * - Candidates are parsed from structured, bounded metadata only (live
 *   `message_end` messages and restored branch entries); the original payload
 *   is never retained, rewritten or re-emitted.
 * - The expected rows are reconstructed with the live theme and the stock
 *   card's own layout rules (header meta, per-severity rail, badge, advisor
 *   attribution, 110-column body cap, three-note collapsed limit, hidden-count
 *   row).
 * - Anything the reconstruction cannot prove — blockers, unknown severities,
 *   malformed or oversized metadata, rejected control characters, lines the
 *   stock wrapper would wrap, two candidates producing the same rows — stays
 *   native. Failure is always "leave the stock card alone", never a guess.
 */

/**
 * Probe width of the native-layout signature. Fixed, so a card's stripped rows
 * are comparable between frames and safe to probe outside a real paint; wide
 * enough that only the stock card's own 110-column body cap decides wrapping.
 */
export const ADVISOR_PROBE_WIDTH = 8_192;

/** Stock `COLLAPSED_NOTES` / `NOTE_LINE_WIDTH` (advisor-message.ts). */
const COLLAPSED_NOTES = 3;
const NOTE_LINE_WIDTH = 110;

/** Bounded evidence budgets; mirrors the hydration bounds the plugin uses. */
const MAX_NOTES = 64;
const MAX_CARDS = 512;
const MAX_BRANCH_ENTRIES = 100_000;

export interface AdvisorNoteEntry {
	readonly note: string;
	/** `undefined` is the host's documented plain nit. */
	readonly severity: string | undefined;
	readonly advisor: string | undefined;
}

export interface AdvisorCard {
	readonly notes: readonly AdvisorNoteEntry[];
	/** False when any note is blocking, unknown or otherwise unrepresentable. */
	readonly safe: boolean;
}

/** Only `nit` and `concern` are non-blocking per the host's advisor schema. */
function isNonBlocking(severity: string | undefined): boolean {
	// The host treats an omitted severity as a plain nit (`severity ?? "nit"`).
	return severity === undefined || severity === "nit" || severity === "concern";
}

function parseNotes(value: unknown): AdvisorCard | undefined {
	const raw = objectRecord(value).notes;
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_NOTES)
		return undefined;
	const notes: AdvisorNoteEntry[] = [];
	let safe = true;
	for (const value of raw) {
		const entry = objectRecord(value);
		if (
			!isBoundedString(entry.note, MAX_EVIDENCE_TEXT_LENGTH) ||
			(entry.severity !== undefined && !isBoundedString(entry.severity, 128)) ||
			(entry.advisor !== undefined && !isBoundedString(entry.advisor, 256))
		)
			return undefined;
		const note = entry.note;
		const severity = entry.severity;
		const advisor = entry.advisor;
		if (
			!isNonBlocking(severity) ||
			!note.trim() ||
			stripRejectedControls(note) !== note ||
			(advisor !== undefined &&
				(stripRejectedControls(advisor) !== advisor || /[\r\n]/u.test(advisor)))
		)
			safe = false;
		notes.push({ note, severity, advisor });
	}
	return { notes: Object.freeze(notes), safe };
}

/**
 * Whitespace-normalized stripped rows. Both sides of a match are compared in
 * this form: the reconstruction cannot and must not re-implement the native
 * wrapper's tab expansion or whitespace handling, and every difference it
 * erases (spaces, tabs, leading/trailing padding) is invisible to the reader.
 * Row *count*, badges, attributions and note text still have to match exactly.
 */
function normalizeRows(rows: readonly string[]): string[] | undefined {
	if (rows.length === 0) return undefined;
	let bytes = 0;
	const normalized: string[] = [];
	for (const row of rows) {
		bytes += row.length;
		if (bytes > MAX_PAYLOAD_BYTES) return undefined;
		normalized.push(Bun.stripANSI(row).replace(/\s+/gu, " ").trim());
	}
	return normalized;
}

/** True when `value` is the anonymous object literal the stock factory returns. */
export function isAdvisorCardSurface(value: unknown): value is object {
	if (
		!value ||
		typeof value !== "object" ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		return false;
	// OMP <= 18.2.0: `{ render, invalidate }`. OMP >= 18.2.5: the same factory
	// wraps a Disclosure and adds `dispose` + `setIgnoreTight`.
	const keys = Reflect.ownKeys(value);
	const allowed =
		keys.length === 2
			? ["render", "invalidate"]
			: keys.length === 4
				? ["render", "invalidate", "dispose", "setIgnoreTight"]
				: undefined;
	return (
		allowed?.every(
			(key) =>
				typeof Object.getOwnPropertyDescriptor(value, key)?.value ===
				"function",
		) ?? false
	);
}

interface CardChrome {
	readonly info: string;
	readonly dot: string;
	readonly rail: string;
	readonly bracketLeft: string;
	readonly bracketRight: string;
}

/** Stock chrome the reconstruction needs; a theme missing any of it is unsupported. */
function cardChrome(theme: Theme): CardChrome | undefined {
	const info = theme.status?.info;
	const dot = theme.sep?.dot;
	const bracketLeft = theme.format?.bracketLeft;
	const bracketRight = theme.format?.bracketRight;
	const rail =
		typeof theme.symbol === "function" ? theme.symbol("advisor.rail") : "";
	if (!info || !dot || !bracketLeft || !bracketRight || !rail) return undefined;
	return { info, dot, rail, bracketLeft, bracketRight };
}

/**
 * The stock card's visible rows for one payload, or `undefined` when the
 * payload cannot be laid out without the native wrapper (a paragraph wider
 * than the stock body width wraps into rows this reconstruction does not
 * model).
 */
function expectedRows(
	card: AdvisorCard,
	chromium: CardChrome,
	expanded: boolean,
): string[] | undefined {
	const notes = card.notes;
	const blockers = notes.filter((note) => note.severity === "blocker").length;
	const meta = [`${notes.length} ${notes.length === 1 ? "note" : "notes"}`];
	if (blockers > 0)
		meta.push(`${blockers} blocker${blockers === 1 ? "" : "s"}`);
	const rows = [`${chromium.info} Advisor ${meta.join(chromium.dot)}`];
	const shown = expanded ? notes : notes.slice(0, COLLAPSED_NOTES);
	const quoteWidth = visibleWidth(`  ${chromium.rail} `);
	for (const entry of shown) {
		const badge = entry.severity
			? `${chromium.bracketLeft}${entry.severity}${chromium.bracketRight} `
			: "";
		const who =
			entry.advisor && entry.advisor !== "default" ? `[${entry.advisor}] ` : "";
		const firstWidth = Math.max(
			10,
			NOTE_LINE_WIDTH - quoteWidth - visibleWidth(badge) - visibleWidth(who),
		);
		const restWidth = Math.max(10, NOTE_LINE_WIDTH - quoteWidth);
		const paragraphs = entry.note.split("\n").filter((line) => line.trim());
		for (const [index, paragraph] of paragraphs.entries()) {
			if (visibleWidth(paragraph) > (index === 0 ? firstWidth : restWidth))
				return undefined;
			rows.push(
				`  ${chromium.rail} ${index === 0 ? `${badge}${who}` : ""}${paragraph}`,
			);
		}
	}
	const hidden = notes.length - shown.length;
	if (hidden > 0) {
		rows.push(
			`  ${chromium.rail} … +${hidden} more ${hidden === 1 ? "note" : "notes"}`,
		);
	}
	return rows;
}

/** Card-matching index over one generation of parsed candidates. */
export class AdvisorNotes {
	#cards: AdvisorCard[] = [];
	/** Chosen signature → its candidate, or `undefined` for a collision. */
	#signatures: Map<string, AdvisorCard | undefined> | undefined;
	#signatureTheme: Theme | undefined;
	#bytes = 0;
	#uncertain = false;

	/** True when matching may be attempted at all. */
	get usable(): boolean {
		return !this.#uncertain && this.#cards.length > 0;
	}

	/** Replace the candidate set with one branch walk (hydration/rebuild). */
	hydrate(entries: readonly unknown[]): void {
		this.clear();
		if (entries.length > MAX_BRANCH_ENTRIES) {
			this.#uncertain = true;
			return;
		}
		try {
			for (const value of entries) {
				const entry = objectRecord(value);
				const type = entry.type;
				if (type === "custom_message") this.#observeEntry(entry);
				else if (type === "message")
					this.#observeEntry(objectRecord(entry.message));
			}
		} catch {
			// A malformed branch fails the whole generation open.
			this.#uncertain = true;
		}
	}

	/**
	 * Observe one live message. Returns true when the message was an advisor
	 * card and the candidate set changed, so the caller may re-probe cards
	 * that were added before their message reached the plugin.
	 */
	observeMessage(message: unknown): boolean {
		const entry = objectRecord(message);
		if (entry.role !== "custom" || entry.customType !== "advisor") return false;
		return this.#observeEntry(entry);
	}

	clear(): void {
		this.#cards = [];
		this.#signatures = undefined;
		this.#signatureTheme = undefined;
		this.#bytes = 0;
		this.#uncertain = false;
	}

	/**
	 * Candidate whose reconstructed native rows equal these rows. `undefined`
	 * for every uncertainty: unknown chrome, a collision with another
	 * candidate, an unsafe candidate, or an over-budget payload.
	 */
	match(rows: readonly string[], theme: Theme): AdvisorCard | undefined {
		if (!this.usable) return undefined;
		const chrome = cardChrome(theme);
		const head = rows[0];
		if (!chrome || head === undefined) return undefined;
		// Cheap header probe before any index work: a leaf that does not open
		// with the stock advisor tag is not an advisor card.
		const header = normalizeRows([head]);
		if (!header?.[0]?.startsWith(`${chrome.info} Advisor `)) return undefined;
		const signature = this.#signatureOf(rows);
		if (signature === undefined) return undefined;
		const card = this.#index(theme, chrome).get(signature);
		return card?.safe ? card : undefined;
	}

	#signatureOf(rows: readonly string[]): string | undefined {
		const normalized = normalizeRows(rows);
		return normalized ? JSON.stringify(normalized) : undefined;
	}

	#observeEntry(entry: Record<string, unknown>): boolean {
		// `display: false` cards never reach the transcript; they carry no
		// presentation risk and no candidate.
		if (entry.customType !== "advisor" || entry.display === false) return false;
		if (this.#cards.length >= MAX_CARDS) {
			this.#uncertain = true;
			return true;
		}
		const card = parseNotes(entry.details);
		if (!card) return false;
		this.#bytes += card.notes.reduce(
			(sum, note) => sum + note.note.length + (note.advisor?.length ?? 0),
			0,
		);
		if (this.#bytes > MAX_PAYLOAD_BYTES) {
			this.#uncertain = true;
			return true;
		}
		this.#cards.push(card);
		// A new candidate can claim rows that an earlier membership decided
		// differently: the index (and any collision it recorded) is stale.
		this.#signatures = undefined;
		return true;
	}

	/**
	 * Signature index for the theme currently in use. Built lazily and kept
	 * until the candidate set or the theme instance changes (stock replaces
	 * the theme object wholesale on `/theme`).
	 */
	#index(
		theme: Theme,
		chrome: CardChrome,
	): Map<string, AdvisorCard | undefined> {
		const cached = this.#signatures;
		if (cached && this.#signatureTheme === theme) return cached;
		const index = new Map<string, AdvisorCard | undefined>();
		for (const card of this.#cards) {
			const rows = new Set<string>();
			for (const expanded of [false, true]) {
				const signature = expectedRows(card, chrome, expanded);
				if (!signature) continue;
				const key = this.#signatureOf(signature);
				// A collision (this card's own collapsed/expanded pair included)
				// means the rows alone cannot identify one payload: stay native.
				if (key !== undefined && !rows.has(key)) rows.add(key);
			}
			for (const key of rows) {
				index.set(key, index.has(key) ? undefined : card);
			}
		}
		this.#signatures = index;
		this.#signatureTheme = theme;
		return index;
	}
}

/**
 * Compact rows for a proven non-blocking card: one `• advisor [severity]`
 * row per collapsed note plus the stock hidden-note count. Expansion is the
 * caller's business — the wrapper returns the native card then, so the full
 * text is always one tool-output toggle away.
 */
export function renderAdvisorRows(
	card: AdvisorCard,
	theme: Theme,
	width: number | undefined,
): readonly string[] {
	const marker = theme.fg("dim", "• advisor");
	const rows: string[] = [];
	for (const entry of card.notes.slice(0, COLLAPSED_NOTES)) {
		const severity = entry.severity ?? "nit";
		const label = theme.fg(
			severity === "concern" ? "warning" : "muted",
			`[${severity}]`,
		);
		const who =
			entry.advisor && entry.advisor !== "default"
				? ` ${theme.fg("dim", `[${entry.advisor}]`)}`
				: "";
		// Same collapsed-preview contract as every other compact row: the
		// note's first non-blank line, whitespace-collapsed and bounded. The
		// rest of the note is what expansion restores.
		const summary = sanitizeOneLine(
			entry.note.split("\n").find((line) => line.trim()) ?? "",
			MAX_DESCRIPTION,
		);
		rows.push(fitTransparentLine(`${marker} ${label}${who} ${summary}`, width));
	}
	const hidden = card.notes.length - COLLAPSED_NOTES;
	if (hidden > 0) {
		rows.push(
			fitTransparentLine(
				theme.fg(
					"dim",
					`  … +${hidden} more ${hidden === 1 ? "note" : "notes"}`,
				),
				width,
			),
		);
	}
	return rows;
}
