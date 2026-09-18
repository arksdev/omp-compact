import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { replaceTabs, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { stripRejectedControls } from "./display-control";
import { fitTransparentLine } from "./fit-transparent-line";
import {
	isBoundedString,
	MAX_EVIDENCE_TEXT_LENGTH,
	MAX_PAYLOAD_BYTES,
} from "./hydration-bounds";
import { objectRecord } from "./object-record";
import type { RenderableBlock } from "./transcript-fold";

/** Wide enough not to clip chrome; stock still wraps bodies at 110 columns. */
export const ADVISOR_PROBE_WIDTH = 8_192;
const MAX_NOTES = 64;
const MAX_CARDS = 512;
const MAX_BRANCH_ENTRIES = 100_000;

type Note = Readonly<{
	note: string;
	severity: string | undefined;
	advisor: string | undefined;
}>;
type Candidate = Readonly<{ notes: readonly Note[]; safe: boolean }>;

/** Parse only display metadata. Never retain or rewrite a session message. */
function parseAdvisorDetails(value: unknown): Candidate | undefined {
	const raw = objectRecord(value).notes;
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_NOTES)
		return undefined;
	const notes: Note[] = [];
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
			(severity !== undefined &&
				severity !== "nit" &&
				severity !== "concern") ||
			!note.trim() ||
			stripRejectedControls(note) !== note ||
			(advisor !== undefined &&
				(stripRejectedControls(advisor) !== advisor || /[\r\n]/u.test(advisor)))
		)
			safe = false;
		notes.push(Object.freeze({ note, severity, advisor }));
	}
	return Object.freeze({ notes: Object.freeze(notes), safe });
}

/** Same varying first/continuation widths used by the stock advisor card. */
function wrapNote(
	text: string,
	firstWidth: number,
	restWidth: number,
): string[] {
	const firstWrap = wrapTextWithAnsi(text, firstWidth);
	if (firstWrap.length <= 1) return firstWrap;
	const firstLine = firstWrap[0];
	if (firstLine === undefined) return [];
	const index = text.indexOf(firstLine);
	if (index === -1) return wrapTextWithAnsi(text, restWidth);
	return [
		firstLine,
		...wrapTextWithAnsi(
			text.slice(index + firstLine.length).trimStart(),
			restWidth,
		),
	];
}

function candidateSignature(
	candidate: Candidate,
	theme: Theme,
	expanded: boolean,
): string {
	const notes = candidate.notes;
	const blockers = notes.filter((note) => note.severity === "blocker").length;
	const meta = [`${notes.length} ${notes.length === 1 ? "note" : "notes"}`];
	if (blockers) meta.push(`${blockers} blocker${blockers === 1 ? "" : "s"}`);
	const rows = [`${theme.status.info} Advisor ${meta.join(theme.sep.dot)}`];
	const rail = theme.symbol("advisor.rail");
	const quoteWidth = visibleWidth(`  ${rail} `);
	for (const entry of expanded ? notes : notes.slice(0, 3)) {
		const badge = entry.severity
			? `${theme.format.bracketLeft}${entry.severity}${theme.format.bracketRight} `
			: "";
		const who =
			entry.advisor && entry.advisor !== "default"
				? `[${replaceTabs(entry.advisor)}] `
				: "";
		const firstWidth = Math.max(
			10,
			110 - quoteWidth - visibleWidth(badge) - visibleWidth(who),
		);
		const restWidth = Math.max(10, 110 - quoteWidth);
		const body: string[] = [];
		for (const [index, paragraph] of entry.note
			.split("\n")
			.filter((line) => line.trim())
			.entries()) {
			body.push(
				...(index === 0
					? wrapNote(paragraph, firstWidth, restWidth)
					: wrapTextWithAnsi(paragraph, restWidth)),
			);
		}
		for (const [index, line] of body.entries()) {
			rows.push(
				`  ${rail} ${index === 0 ? `${badge}${who}` : ""}${replaceTabs(line)}`,
			);
		}
	}
	if (!expanded && notes.length > 3) {
		const hidden = notes.length - 3;
		rows.push(`  ${rail} … +${hidden} more ${hidden === 1 ? "note" : "notes"}`);
	}
	return JSON.stringify(rows.map((row) => Bun.stripANSI(` ${row} `)));
}

/** Check all visible rows, not just an Advisor-looking header or severity badge. */
function nativeSignature(
	lines: readonly string[],
	theme: Theme,
): string | undefined {
	if (lines.length > MAX_PAYLOAD_BYTES / 8) return undefined;
	const rows: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		bytes += line.length;
		if (bytes > MAX_PAYLOAD_BYTES) return undefined;
		rows.push(Bun.stripANSI(line));
	}
	if (!rows[0]?.startsWith(` ${theme.status.info} Advisor `)) return undefined;
	return JSON.stringify(rows);
}

/** Anonymous stock card shapes, not a claim that any such component is an advisor. */
export function isOpaqueAdvisorSurface(
	value: unknown,
): value is RenderableBlock {
	if (
		!value ||
		typeof value !== "object" ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		return false;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== 2 && keys.length !== 4) return false;
	const allowed =
		keys.length === 2
			? ["render", "invalidate"]
			: ["render", "invalidate", "dispose", "setIgnoreTight"];
	return allowed.every(
		(key) =>
			typeof Object.getOwnPropertyDescriptor(value, key)?.value === "function",
	);
}

/** Per-adapter metadata/signature index; rebuilt on hydration, never per frame. */
export class AdvisorNotes {
	#candidates: Candidate[] = [];
	#uncertain = false;
	#bytes = 0;
	#theme: Theme | undefined;
	#signatures = new Map<string, Candidate | undefined>();
	#cards = new Map<object, string>();
	#owners = new Map<string, Set<object>>();

	get hasCandidates(): boolean {
		return !this.#uncertain && this.#candidates.length > 0;
	}

	hydrate(entries: readonly unknown[]): void {
		this.#candidates = [];
		this.#uncertain = entries.length > MAX_BRANCH_ENTRIES;
		this.#bytes = 0;
		this.#theme = undefined;
		try {
			for (
				let index = 0;
				index < Math.min(entries.length, MAX_BRANCH_ENTRIES);
				index++
			) {
				const entry = objectRecord(entries[index]);
				if (entry.type === "custom_message") this.#observe(entry);
				else if (entry.type === "message") this.observeMessage(entry.message);
			}
		} catch {
			this.#uncertain = true;
		}
	}

	observeMessage(value: unknown): boolean {
		try {
			const message = objectRecord(value);
			return message.role === "custom" && this.#observe(message);
		} catch {
			this.#uncertain = true;
			return true;
		}
	}

	#observe(message: Record<string, unknown>): boolean {
		if (message.customType !== "advisor" || message.display === false)
			return false;
		this.#theme = undefined;
		const candidate =
			message.display === true
				? parseAdvisorDetails(message.details)
				: undefined;
		if (!candidate || this.#candidates.length >= MAX_CARDS) {
			// An unrepresentable card could collide with any safe card. Do not
			// silently discard the only evidence that a hidden note is unsafe.
			this.#uncertain = true;
			return true;
		}
		this.#bytes += candidate.notes.reduce(
			(sum, note) =>
				sum +
				note.note.length +
				(note.advisor?.length ?? 0) +
				(note.severity?.length ?? 0),
			0,
		);
		if (this.#bytes > MAX_PAYLOAD_BYTES) this.#uncertain = true;
		else this.#candidates.push(candidate);
		return true;
	}

	clearCards(): void {
		this.#cards.clear();
		this.#owners.clear();
	}

	observeCard(
		component: object,
		lines: readonly string[],
		theme: Theme,
	): boolean {
		const signature = nativeSignature(lines, theme);
		const previous = this.#cards.get(component);
		if (previous !== undefined) this.#owners.get(previous)?.delete(component);
		this.#cards.delete(component);
		if (signature === undefined) return false;
		this.#cards.set(component, signature);
		let owners = this.#owners.get(signature);
		if (!owners) {
			owners = new Set();
			this.#owners.set(signature, owners);
		}
		owners.add(component);
		return true;
	}

	#refreshSignatures(theme: Theme): void {
		if (this.#theme === theme) return;
		this.#theme = theme;
		this.#signatures.clear();
		for (const candidate of this.#candidates) {
			// De-duplicate a card's identical full/collapsed signatures, not
			// distinct cards with equal visible output.
			for (const signature of new Set([
				candidateSignature(candidate, theme, false),
				candidateSignature(candidate, theme, true),
			])) {
				this.#signatures.set(
					signature,
					this.#signatures.has(signature) ? undefined : candidate,
				);
			}
		}
	}

	match(
		component: object,
		lines: readonly string[],
		theme: Theme,
	): Candidate | undefined {
		if (this.#uncertain) return undefined;
		this.#refreshSignatures(theme);
		const signature = nativeSignature(lines, theme);
		if (
			signature === undefined ||
			this.#cards.get(component) !== signature ||
			this.#owners.get(signature)?.size !== 1
		)
			return undefined;
		const candidate = this.#signatures.get(signature);
		return candidate?.safe ? candidate : undefined;
	}
}

export function renderAdvisorRows(
	candidate: Candidate,
	theme: Theme,
	width: number,
): readonly string[] {
	const rows = candidate.notes.slice(0, 3).map((entry) => {
		const summary =
			entry.note
				.split("\n")
				.find((line) => line.trim())
				?.trim()
				.replace(/\s+/gu, " ") ?? "";
		const who =
			entry.advisor && entry.advisor !== "default"
				? ` [${entry.advisor.replace(/\s+/gu, " ")}]`
				: "";
		const label = theme.fg(
			entry.severity === "concern" ? "warning" : "muted",
			`[${entry.severity ?? "nit"}]`,
		);
		return fitTransparentLine(
			`${theme.fg("dim", "• advisor")} ${label}${theme.fg("dim", who)} ${theme.fg("dim", summary)}`,
			width,
		);
	});
	const hidden = candidate.notes.length - 3;
	if (hidden > 0)
		rows.push(
			fitTransparentLine(
				theme.fg(
					"dim",
					`  … +${hidden} more ${hidden === 1 ? "note" : "notes"}`,
				),
				width,
			),
		);
	return rows;
}
