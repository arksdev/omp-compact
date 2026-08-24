import { truncateAnsiSafe } from "./ansi-width";

import {
	type CompactHostSettings,
	type CompactMode,
	type CompactSettings,
	type CompactStatsSettings,
	MAX_THRESHOLD_TOKENS,
} from "./config";

import { validateDisplayCycleKey } from "./display-cycle";

import type {
	ComponentLike,
	KeybindingsLike,
	SettingsUiLike,
	ThemeLike,
} from "./host-api";

import {
	type ArrowDirection,
	KEY_BACKSPACE,
	KEY_CTRL_C,
	KEY_ENTER,
	KEY_ESCAPE,
	KEY_SPACE,
	normalizeArrowKey,
} from "./settings-keys";

export interface SettingsDialogDeps {
	/** Initial immutable snapshot shown when the dialog opens. */
	settings: CompactSettings;
	/**
	 * False when no verified live host settings instance exists: the host
	 * rows are rendered `n/a`, are non-focusable, and a host change attempted
	 * any other way fails visibly without reaching the store.
	 */
	hostAvailable?: boolean;
	/** Persist the merged draft; awaited before the dialog resolves. */
	onSave(next: CompactSettings): Promise<void>;
	/**
	 * Seam for host-configuration slices: fired after a successful save with
	 * only the host fields that actually changed. The command handler may
	 * omit it and compose host apply + persist itself (see saveSettingsFlow).
	 */
	onHostSettingsChanged?(host: CompactHostSettings): void;
	warn?(message: string): void;
	theme: ThemeLike;
	keybindings: KeybindingsLike;
	/**
	 * Live provider of the current terminal height in rows. The host hands
	 * its TUI to `ui.custom`'s factory and `TUI.terminal.rows` is a live
	 * getter (the same value the host's own window math reads), so the dialog
	 * can keep the focused row visible on short terminals. Absent or
	 * non-positive: the dialog renders every row (no viewport).
	 */
	getTerminalRows?(): number | undefined;
}

const MODES: readonly CompactMode[] = ["compact", "live", "clear"];
const MAX_EDIT_DIGITS = 10;
/**
 * Cap for the free-text chord editor: the longest legal chord is
 * `ctrl+shift+alt+super+backspace` (30 characters), so 40 leaves room to
 * mistype without letting a paste run away.
 */
const MAX_EDIT_CHARS = 40;

// Row groups: one blank line separates the logical menu sections
// (global, display, auto-shake, stats, host) — restrained separation only.
const GROUP_GLOBAL = 0;
const GROUP_DISPLAY = 1;
const GROUP_SHAKE = 2;
const GROUP_STATS = 3;
const GROUP_HOST = 4;

interface Row {
	id: string;
	kind: "toggle" | "cycle" | "number" | "text";
	label: string;
	/** Tree decoration for nested rows ("" for top-level rows). */
	prefix: string;
	/** Menu section used for blank-line separation between groups. */
	group: number;
	get(): unknown;
	set(value: unknown): void;
	focusable: boolean;
	/** Row locked because its backing surface is unavailable (host settings). */
	unavailable: boolean;
}

/**
 * One contextual help line per focusable setting, shown dim under the rows
 * for the row currently focused — deliberately not a comment on every row.
 */
const ROW_HELP: Readonly<Record<string, string>> = {
	enabled: "Toggles the compact runtime",
	mode: "compact / live / clear runtime mode",
	compactPaths: "Renders paths relative to the session cwd",
	retainGitLive: "Keeps Git commit rows after the terminal answer",
	compactVibeRows: "Compact rows for vibe tools",
	displayCycleKey: "Chord cycling compact / live / clear / off (needs restart)",
	"autoShake.enabled": "Shakes the log after a successful answer",
	"autoShake.thresholdTokens": "Shakes once the run passes this many tokens",
	"stats.enabled": "Shows one usage row per completed run",
	"stats.actions": "Action counts in the usage row",
	"stats.sent": "Sent tokens in the usage row",
	"stats.received": "Received tokens in the usage row",
	"stats.cache": "Cache hits in the usage row",
	"stats.time": "Run time in the usage row",
	"host.recapEnabled": "Stock recap summary visibility",
	"host.thinkingBlocksVisible": "Stock thinking block visibility",
};

const STATS_CHILD_IDS = [
	"stats.actions",
	"stats.sent",
	"stats.received",
	"stats.cache",
	"stats.time",
] as const;

/**
 * Display a shake threshold in human units: `2m tokens`, `200k tokens`, and
 * `0 (every run)` for zero. Display-only — editing always shows the raw
 * validated digits.
 */
export function humanizeThreshold(tokens: number): string {
	if (tokens === 0) return "0 (every run)";
	if (tokens >= 1_000_000) return `${trimUnit(tokens / 1_000_000)}m tokens`;
	if (tokens >= 1_000) return `${trimUnit(tokens / 1_000)}k tokens`;
	return `${tokens} tokens`;
}

function trimUnit(value: number): string {
	return Number.isInteger(value)
		? String(value)
		: String(Math.round(value * 10) / 10);
}

export class SettingsDialog implements ComponentLike {
	private readonly initial: CompactSettings;
	private readonly deps: SettingsDialogDeps;
	private readonly done: (result: CompactSettings | undefined) => void;
	private readonly draft: CompactSettings;
	/** False when no verified live host settings instance exists. */
	private readonly hostAvailable: boolean;
	/** Stable id of the focused row; resolved against the live focusable set. */
	private focusedId = "enabled";
	private editing = false;
	private editBuffer = "";
	private error = "";
	private saving = false;
	private finished = false;
	private pending: Promise<void> = Promise.resolve();

	constructor(
		deps: SettingsDialogDeps,
		done: (result: CompactSettings | undefined) => void,
	) {
		this.deps = deps;
		this.done = done;
		this.initial = deps.settings;
		this.hostAvailable = deps.hostAvailable !== false;
		this.draft = {
			...this.initial,
			stats: { ...this.initial.stats },
			autoShake: { ...this.initial.autoShake },
			host: { ...this.initial.host },
		};
	}

	/** The mutable working draft (read-only by convention). */
	get current(): CompactSettings {
		return this.draft;
	}

	get isDirty(): boolean {
		const draft = this.draft;
		const initial = this.initial;
		const hostDirty =
			this.hostAvailable &&
			((draft.host.recapEnabled ?? true) !==
				(initial.host.recapEnabled ?? true) ||
				(draft.host.thinkingBlocksVisible ?? true) !==
					(initial.host.thinkingBlocksVisible ?? true));
		return (
			draft.enabled !== initial.enabled ||
			draft.mode !== initial.mode ||
			draft.retainGitLive !== initial.retainGitLive ||
			draft.compactPaths !== initial.compactPaths ||
			draft.compactVibeRows !== initial.compactVibeRows ||
			draft.displayCycleKey !== initial.displayCycleKey ||
			draft.stats.enabled !== initial.stats.enabled ||
			draft.stats.actions !== initial.stats.actions ||
			draft.stats.sent !== initial.stats.sent ||
			draft.stats.received !== initial.stats.received ||
			draft.stats.cache !== initial.stats.cache ||
			draft.stats.time !== initial.stats.time ||
			draft.autoShake.enabled !== initial.autoShake.enabled ||
			draft.autoShake.thresholdTokens !== initial.autoShake.thresholdTokens ||
			hostDirty
		);
	}

	/** Resolves once every queued save attempt has settled. */
	settled(): Promise<void> {
		return this.pending;
	}

	private buildRows(): Row[] {
		const draft = this.draft;
		const toggle = (
			id: string,
			label: string,
			get: () => boolean,
			set: (value: boolean) => void,
			group = GROUP_GLOBAL,
			prefix = "",
			focusable = true,
			unavailable = false,
		): Row => ({
			id,
			kind: "toggle",
			label,
			prefix,
			group,
			get,
			set: (value) => set(value === true),
			focusable,
			unavailable,
		});
		return [
			toggle(
				"enabled",
				"Global compact",
				() => draft.enabled,
				(v) => {
					draft.enabled = v;
				},
			),
			{
				id: "mode",
				kind: "cycle",
				label: "Mode",
				prefix: "",
				group: GROUP_GLOBAL,
				get: () => draft.mode,
				set: (value) => {
					if (MODES.includes(value as CompactMode)) {
						draft.mode = value as CompactMode;
					}
				},
				focusable: true,
				unavailable: false,
			},
			toggle(
				"compactPaths",
				"Compact paths",
				() => draft.compactPaths,
				(v) => {
					draft.compactPaths = v;
				},
				GROUP_DISPLAY,
			),
			toggle(
				"retainGitLive",
				"Retain Git rows",
				() => draft.retainGitLive,
				(v) => {
					draft.retainGitLive = v;
				},
				GROUP_DISPLAY,
			),
			toggle(
				"compactVibeRows",
				"vibe-compact",
				() => draft.compactVibeRows,
				(v) => {
					draft.compactVibeRows = v;
				},
				GROUP_DISPLAY,
			),
			{
				id: "displayCycleKey",
				kind: "text",
				label: "Cycle shortcut",
				prefix: "",
				group: GROUP_DISPLAY,
				get: () => draft.displayCycleKey,
				set: (value) => {
					if (typeof value === "string") draft.displayCycleKey = value;
				},
				focusable: true,
				unavailable: false,
			},
			toggle(
				"autoShake.enabled",
				"Auto-shake",
				() => draft.autoShake.enabled,
				(v) => {
					draft.autoShake.enabled = v;
				},
				GROUP_SHAKE,
			),
			{
				id: "autoShake.thresholdTokens",
				kind: "number",
				label: "Shake threshold",
				prefix: "",
				group: GROUP_SHAKE,
				get: () => draft.autoShake.thresholdTokens,
				set: (value) => {
					if (typeof value === "number") {
						draft.autoShake.thresholdTokens = value;
					}
				},
				focusable: true,
				unavailable: false,
			},
			toggle(
				"stats.enabled",
				"Run statistics",
				() => draft.stats.enabled,
				(v) => {
					draft.stats.enabled = v;
				},
				GROUP_STATS,
			),
			...STATS_CHILD_IDS.map((id, index) => {
				// Row ids keep the dotted form; the draft fields are plain
				// keys, so the accessor must strip the "stats." prefix.
				const key = id.slice("stats.".length) as keyof CompactStatsSettings;
				const label =
					id === "stats.actions"
						? "Actions"
						: id === "stats.sent"
							? "Sent tokens"
							: id === "stats.received"
								? "Received tokens"
								: id === "stats.cache"
									? "Cache stats"
									: "Time";
				const prefix = index === STATS_CHILD_IDS.length - 1 ? "└─ " : "├─ ";
				return toggle(
					id,
					label,
					() => draft.stats[key],
					(v) => {
						draft.stats[key] = v;
					},
					GROUP_STATS,
					prefix,
					draft.stats.enabled,
				);
			}),
			toggle(
				"host.recapEnabled",
				"Recap summary",
				() => draft.host.recapEnabled ?? true,
				(v) => {
					draft.host.recapEnabled = v;
				},
				GROUP_HOST,
				"",
				this.hostAvailable,
				!this.hostAvailable,
			),
			toggle(
				"host.thinkingBlocksVisible",
				"Thinking blocks",
				() => draft.host.thinkingBlocksVisible ?? true,
				(v) => {
					draft.host.thinkingBlocksVisible = v;
				},
				GROUP_HOST,
				"",
				this.hostAvailable,
				!this.hostAvailable,
			),
		];
	}

	private focusableRows(): Row[] {
		return this.buildRows().filter((row) => row.focusable);
	}

	/**
	 * Resolve `focusedId` against the current focusable rows. When the id is
	 * still present it wins. When the focused row itself has disappeared
	 * (stats children collapsing under their parent), walk the full row order
	 * backwards for the nearest still-focusable ancestor/neighbour — for the
	 * stats subtree that is the "Run statistics" toggle — and repair the
	 * stored id so the next render keeps it. Falls forward, then to the first
	 * focusable row, only if nothing earlier survives.
	 */
	private resolveFocusIndex(focusable: readonly Row[]): number {
		if (focusable.length === 0) return -1;
		const current = focusable.findIndex((row) => row.id === this.focusedId);
		if (current >= 0) return current;

		const all = this.buildRows();
		const lostAt = all.findIndex((row) => row.id === this.focusedId);
		const adopt = (row: Row): number => {
			this.focusedId = row.id;
			return focusable.findIndex((candidate) => candidate.id === row.id);
		};
		if (lostAt >= 0) {
			for (let index = lostAt - 1; index >= 0; index--) {
				const row = all[index];
				if (row?.focusable) return adopt(row);
			}
			for (let index = lostAt + 1; index < all.length; index++) {
				const row = all[index];
				if (row?.focusable) return adopt(row);
			}
		}
		const first = focusable[0];
		// focusable.length > 0 is guaranteed by the early return above.
		if (first === undefined) return -1;
		this.focusedId = first.id;
		return 0;
	}

	private focusedRow(): Row | undefined {
		const rows = this.focusableRows();
		const index = this.resolveFocusIndex(rows);
		return index >= 0 ? rows[index] : undefined;
	}

	private move(delta: number): void {
		const rows = this.focusableRows();
		if (rows.length === 0) return;
		const index = this.resolveFocusIndex(rows);
		const next = (index + delta + rows.length) % rows.length;
		const row = rows[next];
		// next is always in [0, rows.length) after the length guard above.
		if (row === undefined) return;
		this.focusedId = row.id;
		this.error = "";
	}

	private cycle(delta: 1 | -1): void {
		const row = this.focusedRow();
		if (row?.kind !== "cycle") return;
		const current = row.get() as CompactMode;
		const index = MODES.indexOf(current);
		const next = MODES[(index + delta + MODES.length) % MODES.length];
		row.set(next);
	}

	private activate(): void {
		const row = this.focusedRow();
		if (!row) return;
		if (row.kind === "toggle") {
			row.set(row.get() !== true);
		} else if (row.kind === "cycle") {
			this.cycle(1);
		} else if (row.kind === "text") {
			// The chord editor starts empty: a chord is typed whole, not
			// composed digit by digit, so pre-filling would force the user to
			// erase the old chord before typing the new one.
			this.editing = true;
			this.editBuffer = "";
			this.error = "";
		} else {
			// The number editor keeps the current value so a small correction
			// does not mean retyping the whole threshold.
			this.editing = true;
			this.editBuffer = String(row.get());
			this.error = "";
		}
	}

	private handleEditing(data: string): void {
		if (data === KEY_BACKSPACE || data === "\b") {
			this.editBuffer = this.editBuffer.slice(0, -1);
			return;
		}
		if (data === KEY_ENTER) {
			this.commitEdit();
			return;
		}
		if (data === KEY_ESCAPE) {
			this.editing = false;
			this.editBuffer = "";
			this.error = "";
			return;
		}
		if (this.focusedRow()?.kind === "text") {
			// Chord text: printable ASCII only, whole-chunk. Every legal chord
			// spells out as `modifier+base` in that range, so anything else is
			// either a control sequence or a paste that cannot be a chord.
			if (!/^[\x20-\x7e]+$/.test(data)) return;
			if (this.editBuffer.length < MAX_EDIT_CHARS) {
				const room = MAX_EDIT_CHARS - this.editBuffer.length;
				this.editBuffer += data.slice(0, room);
			}
			return;
		}
		// Whole-chunk classification: a paste must be entirely digits or it is
		// ignored the same way a single non-digit keystroke is. A string-range
		// check (`data >= "0" && data <= "9"`) lets mixed chunks like "1a"
		// through because lexicographic order only looks at the first differing
		// character, and parseInt would then silently keep the leading digits.
		if (/^[0-9]+$/.test(data)) {
			if (this.editBuffer.length < MAX_EDIT_DIGITS) {
				const room = MAX_EDIT_DIGITS - this.editBuffer.length;
				this.editBuffer += data.slice(0, room);
			}
		}
	}

	private commitEdit(): void {
		const row = this.focusedRow();
		if (row?.kind === "text") {
			this.commitChordEdit(row);
			return;
		}
		// Reject anything that is not a pure digit string. parseInt("1a", 10)
		// is 1 and Number.isInteger(1) is true, so leaning on parseInt alone
		// would silently persist a value the user never typed.
		if (this.editBuffer.length === 0 || !/^[0-9]+$/.test(this.editBuffer)) {
			this.error = "threshold must be a non-negative integer";
			return;
		}
		const value = Number(this.editBuffer);
		if (!Number.isInteger(value) || value < 0) {
			this.error = "threshold must be a non-negative integer";
			return;
		}
		if (value > MAX_THRESHOLD_TOKENS) {
			this.error = `threshold exceeds max ${MAX_THRESHOLD_TOKENS}`;
			return;
		}
		row?.set(value);
		this.editing = false;
		this.editBuffer = "";
		this.error = "";
	}

	/**
	 * Commit the chord row. A chord occupied by OMP is refused here rather
	 * than saved: the host drops a conflicting extension shortcut with only a
	 * log line, so accepting one would hand the user a key that never fires.
	 * The rejection keeps the editor open with the typed text intact.
	 */
	private commitChordEdit(row: Row): void {
		const chord = this.editBuffer.trim();
		const rejection = validateDisplayCycleKey(chord);
		if (rejection !== undefined) {
			this.error = rejection;
			return;
		}
		row.set(chord);
		this.editing = false;
		this.editBuffer = "";
		this.error = "";
	}

	/**
	 * True when the draft carries host changes that cannot be persisted: the
	 * rows are locked when no verified live host settings instance exists, so
	 * this can only arise from direct draft mutation.
	 */
	private hostChangesBlocked(): boolean {
		if (this.hostAvailable) return false;
		return (
			(this.draft.host.recapEnabled ?? true) !==
				(this.initial.host.recapEnabled ?? true) ||
			(this.draft.host.thinkingBlocksVisible ?? true) !==
				(this.initial.host.thinkingBlocksVisible ?? true)
		);
	}

	private save(): void {
		if (this.saving || this.editing) return;
		const hostBlocked = this.hostChangesBlocked();
		if (!this.isDirty && !hostBlocked) {
			this.finish(undefined);
			return;
		}
		if (hostBlocked) {
			// Host rows must never claim success when unavailable: fail
			// visibly and leave the plugin JSON untouched for host prefs.
			const message =
				"Host settings are unavailable; recap and thinking block changes cannot be saved";
			this.error = message;
			this.deps.warn?.(message);
			return;
		}
		// Capture an immutable snapshot at confirmation time. Input may keep
		// mutating the live draft while a slow onSave is pending; the queued
		// payload and the dialog's resolved value must stay the confirmed
		// draft, not whatever the working copy holds when the write runs.
		const confirmed: CompactSettings = {
			...this.draft,
			stats: { ...this.draft.stats },
			autoShake: { ...this.draft.autoShake },
			host: { ...this.draft.host },
		};
		this.saving = true;
		this.pending = this.pending.then(async () => {
			try {
				await this.deps.onSave(confirmed);
				this.saving = false;
				this.emitHostChanges(confirmed.host);
				this.finish(confirmed);
			} catch (error) {
				this.saving = false;
				const message = error instanceof Error ? error.message : String(error);
				this.error = message;
				this.deps.warn?.(message);
			}
		});
	}

	private emitHostChanges(after: CompactHostSettings = this.draft.host): void {
		// Host rows must never claim success when unavailable: with no live
		// host settings instance there is nothing to report.
		if (!this.hostAvailable) return;
		const before = this.initial.host;
		const changed: CompactHostSettings = {};
		let any = false;
		if ((after.recapEnabled ?? true) !== (before.recapEnabled ?? true)) {
			changed.recapEnabled = after.recapEnabled;
			any = true;
		}
		if (
			(after.thinkingBlocksVisible ?? true) !==
			(before.thinkingBlocksVisible ?? true)
		) {
			changed.thinkingBlocksVisible = after.thinkingBlocksVisible;
			any = true;
		}
		if (any) this.deps.onHostSettingsChanged?.(changed);
	}

	private finish(result: CompactSettings | undefined): void {
		if (this.finished) return;
		this.finished = true;
		this.done(result);
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (this.editing) {
			this.handleEditing(data);
			return;
		}
		if (
			data === KEY_CTRL_C ||
			this.deps.keybindings.matches(data, "app.interrupt")
		) {
			this.finish(undefined);
			return;
		}
		switch (data) {
			case KEY_ESCAPE:
			case "c":
				this.finish(undefined);
				return;
			case "s":
				this.save();
				return;
			case "k":
				this.move(-1);
				return;
			case "j":
				this.move(1);
				return;
			case KEY_SPACE:
			case KEY_ENTER:
				this.activate();
				return;
			default: {
				// Arrows never reach the cases above: normalizeArrowKey owns
				// every spelling the host may deliver (plain CSI, SS3, and the
				// kitty parameterized form for unmodified press/repeat).
				const arrow = normalizeArrowKey(data);
				if (arrow !== undefined) this.moveOrCycle(arrow);
				return;
			}
		}
	}

	/**
	 * Vertical arrows move the focus; horizontal arrows cycle the focused
	 * option when it has one and otherwise move the focus, so left/right stay
	 * usable on rows with nothing to cycle.
	 */
	private moveOrCycle(direction: ArrowDirection): void {
		if (direction === "up") {
			this.move(-1);
			return;
		}
		if (direction === "down") {
			this.move(1);
			return;
		}
		const delta = direction === "left" ? -1 : 1;
		if (this.focusedRow()?.kind === "cycle") this.cycle(delta);
		else this.move(delta);
	}

	render(width: number): readonly string[] {
		const theme = this.deps.theme;
		const rows = this.buildRows();
		const focusable = rows.filter((row) => row.focusable);
		const focusedIndex = this.resolveFocusIndex(focusable);
		const focusedId =
			focusedIndex >= 0 ? focusable[focusedIndex]?.id : undefined;

		const lines: string[] = [];
		// Line index of the focused row, so the viewport can keep the row the
		// cursor rests on visible on short terminals.
		let focusLine = -1;
		const header = `${theme.bold("OMP Compact — Settings")}${
			this.isDirty ? theme.fg("warning", " *") : ""
		}`;
		lines.push(header);

		// Restrained blank group separation: one empty line between logical
		// menu sections (global, display, auto-shake, stats, host).
		let previousGroup = rows[0]?.group;
		for (const row of rows) {
			if (row.group !== previousGroup) lines.push("");
			previousGroup = row.group;
			const isFocused = row.id === focusedId;
			const muted = !row.focusable;
			const marker = isFocused ? theme.fg("accent", "› ") : "  ";
			const label = muted
				? theme.fg("muted", `${row.prefix}${row.label}`)
				: `${row.prefix}${row.label}`;
			let value: string;
			if (row.unavailable) {
				// No verified live host settings: show nothing as a value.
				value = theme.fg("muted", "n/a");
			} else if (row.kind === "toggle") {
				const on = row.get() === true;
				// Disabled/unavailable rows are fully muted — values included.
				value = muted
					? theme.fg("muted", on ? "on" : "off")
					: on
						? theme.fg("success", "on")
						: theme.fg("muted", "off");
			} else if (row.kind === "cycle") {
				value = theme.fg("accent", `[${String(row.get())}]`);
			} else if (this.editing && isFocused) {
				// Editing keeps the raw validated digits, never the human form.
				value = `[${
					theme.underline ? theme.underline(this.editBuffer) : this.editBuffer
				}]`;
			} else if (row.kind === "number") {
				value = `[${humanizeThreshold(row.get() as number)}]`;
			} else {
				value = `[${String(row.get())}]`;
			}
			if (isFocused) focusLine = lines.length;
			lines.push(`${marker}${label}  ${value}`);
		}

		if (this.error) {
			lines.push(theme.fg("error", this.error));
		}
		// One contextual dim help line for the focused setting — never a
		// comment on every row. Editing shows its own key hints instead, in the
		// same telegraphic style, naming what this row accepts.
		const editingChord =
			this.editing && focusable[focusedIndex]?.kind === "text";
		const help = this.editing
			? editingChord
				? "chord edit · enter ok · esc cancel"
				: "digits edit · enter ok · esc cancel"
			: `${ROW_HELP[focusedId ?? ""] ?? ""} · ↑↓ move · s save · esc cancel${
					this.isDirty ? " · unsaved" : ""
				}`;
		lines.push(theme.fg("muted", help));

		const rendered = lines.map((line) => truncateAnsiSafe(line, width));
		const terminalRows = this.deps.getTerminalRows?.();
		if (
			terminalRows === undefined ||
			!Number.isFinite(terminalRows) ||
			terminalRows <= 0 ||
			lines.length <= terminalRows
		) {
			return rendered;
		}
		return this.windowed(rendered, focusLine, Math.floor(terminalRows));
	}

	/**
	 * Focus-centered viewport for short terminals, following the host's own
	 * scroll model (pi-tui settings-list.ts: `selectedIndex -
	 * floor(viewportHeight / 2)` clamped): the header, the error line, and
	 * the help line stay pinned; only the rows between them scroll, with the
	 * focused row always visible and holding a stable window position under
	 * one-step cursor moves. Clipped edges get the project's dim ellipsis
	 * marker (the same truncation indicator render.ts uses). The emitted
	 * frame never exceeds `terminalRows`, because the host shows only the
	 * bottom `height` rows of the composed frame (windowTop = frame.length -
	 * height, pi-tui tui.ts:2545) — a taller frame would silently cut the
	 * focused row off the screen.
	 */
	private windowed(
		lines: readonly string[],
		focusLine: number,
		terminalRows: number,
	): string[] {
		const theme = this.deps.theme;
		// Pinned chrome: header on top; the error line and the help line at
		// the bottom (the tail). Everything between them is windowable.
		const tail = (this.error ? 1 : 0) + 1;
		const middleStart = 1;
		const middleEnd = lines.length - tail;
		const middleCount = middleEnd - middleStart;
		if (middleCount <= 0) return [...lines];
		const viewport = Math.max(1, terminalRows - 1 - tail);
		if (middleCount <= viewport) return [...lines];
		const focusInMiddle =
			focusLine >= middleStart && focusLine < middleEnd
				? focusLine - middleStart
				: -1;

		let content = Math.min(viewport, middleCount);
		let start = 0;
		if (focusInMiddle >= 0) {
			start = Math.max(
				0,
				Math.min(
					focusInMiddle - Math.floor(content / 2),
					middleCount - content,
				),
			);
		}
		// Indicator rows (dim "…" at the clipped edges) replace content rows
		// so the frame still fits the terminal; the focused row keeps priority
		// over the markers.
		let topClipped = start > 0;
		let bottomClipped = start + content < middleCount;
		const indicatorRows = (topClipped ? 1 : 0) + (bottomClipped ? 1 : 0);
		if (indicatorRows > 0) {
			const fit = Math.max(1, viewport - indicatorRows);
			if (fit < content) {
				content = Math.min(fit, middleCount);
				if (focusInMiddle >= 0) {
					start = Math.max(
						0,
						Math.min(
							focusInMiddle - Math.floor(content / 2),
							middleCount - content,
						),
					);
				}
				topClipped = start > 0;
				bottomClipped = start + content < middleCount;
			}
		}
		// Extremely short terminals (viewport == 1): the focused row wins
		// over the indicator rows.
		let overflow =
			(topClipped ? 1 : 0) + (bottomClipped ? 1 : 0) + content - viewport;
		if (overflow > 0 && topClipped) {
			topClipped = false;
			overflow--;
		}
		if (overflow > 0 && bottomClipped) bottomClipped = false;

		const out: string[] = [lines[0] ?? ""];
		if (topClipped) out.push(theme.fg("dim", "…"));
		out.push(
			...lines.slice(middleStart + start, middleStart + start + content),
		);
		if (bottomClipped) out.push(theme.fg("dim", "…"));
		out.push(...lines.slice(middleEnd));
		return out;
	}

	invalidate(): void {
		// Stateless render: nothing to invalidate.
	}
}

/**
 * Open the settings dialog through `ui.custom`. When the UI surface is
 * unavailable (headless/RPC), warns and resolves `undefined` without throwing.
 */
export function openSettingsDialog(
	ui: SettingsUiLike,
	deps: Omit<SettingsDialogDeps, "theme" | "keybindings">,
): Promise<CompactSettings | undefined> {
	const custom = ui?.custom;
	if (typeof custom !== "function") {
		(deps.warn ?? console.warn)(
			"omp-compact: interactive settings UI unavailable; nothing was changed",
		);
		return Promise.resolve(undefined);
	}
	return custom<CompactSettings | undefined>(
		(tui, theme, keybindings, done) =>
			new SettingsDialog(
				{
					...deps,
					theme,
					keybindings,
					// The host passes its live TUI through ui.custom's factory.
					// TUI.terminal.rows is a live getter (reads the terminal
					// size at every call), so the dialog learns the current
					// height at each render — no caching, no resize hooks.
					getTerminalRows: () =>
						(tui as { terminal?: { rows?: number } } | null | undefined)
							?.terminal?.rows,
				},
				done,
			),
	);
}
