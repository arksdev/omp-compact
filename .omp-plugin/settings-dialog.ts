import { truncateAnsiSafe } from "./ansi-width";

import {
	type CompactMode,
	type CompactSettings,
	type CompactStatsSettings,
	TOOL_DISPLAYS,
	type ToolDisplay,
} from "./config";

import { canonicalize, validateDisplayCycleKey } from "./display-cycle";

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

/** A tool the user can choose a display for, with the display it defaults to. */
export interface ToolDisplayOption {
	/** Canonical tool name, the key of `CompactSettings.tools`. */
	name: string;
	defaultDisplay: ToolDisplay;
}

export interface SettingsDialogDeps {
	/** Initial immutable snapshot shown when the dialog opens. */
	settings: CompactSettings;
	/**
	 * Tools listed under "Tool cards", in display order. Absent or empty: the
	 * section is left out.
	 */
	tools?: readonly ToolDisplayOption[];
	/** Persist the merged draft; awaited before the dialog resolves. */
	onSave(next: CompactSettings): Promise<void>;
	/**
	 * Why OMP or another extension already holds a chord, or `undefined`
	 * when it is free (`getShortcutConflict` through
	 * `describeShortcutConflict`). Absent: only the chord syntax is checked.
	 */
	checkShortcut?(chord: string): string | undefined;
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
/**
 * Cap for the free-text chord editor: the longest legal chord is
 * `ctrl+shift+alt+super+backspace` (30 characters), so 40 leaves room to
 * mistype without letting a paste run away.
 */
const MAX_EDIT_CHARS = 40;

// Row groups: one blank line separates the logical menu sections
// (global, display, stats) — restrained separation only.
const GROUP_GLOBAL = 0;
const GROUP_DISPLAY = 1;
const GROUP_STATS = 2;
const GROUP_TOOLS = 3;

const TOOL_ROW_PREFIX = "tools.";

interface Row {
	id: string;
	/** `heading` titles a section: never focusable, drawn without a value. */
	kind: "toggle" | "cycle" | "text" | "heading";
	label: string;
	/** Tree decoration for nested rows ("" for top-level rows). */
	prefix: string;
	/** Menu section used for blank-line separation between groups. */
	group: number;
	get(): unknown;
	set(value: unknown): void;
	focusable: boolean;
	/** Values a `cycle` row steps through. */
	options?: readonly string[];
	/** Shown dim after the value, e.g. that the value is the default. */
	note?(): string;
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
	compactAdvisorNotes: "Compact nit/concern advisor notes; blockers stay full",
	displayCycleKey: "Chord cycling compact / live / clear / off (needs restart)",
	"stats.enabled": "Shows one usage row per completed run",
	"stats.actions": "Action counts in the usage row",
	"stats.sent": "Fresh (uncached) input tokens in the usage row",
	"stats.received": "Received tokens in the usage row",
	"stats.cache":
		"Cached tokens, share, and writes; fresh + cached + written = full prompt",
	"stats.time": "Run time in the usage row",
	"stats.clock": "Local time of the answer, beside the usage row",
};

/** Help for every tool row: what each display means. */
const TOOL_ROW_HELP =
	"rows: one-line rows · newest: newest card open while working · open: always the full card";

function helpFor(rowId: string | undefined): string {
	if (rowId?.startsWith(TOOL_ROW_PREFIX)) return TOOL_ROW_HELP;
	return ROW_HELP[rowId ?? ""] ?? "";
}

const STATS_CHILD_IDS = [
	"stats.actions",
	"stats.sent",
	"stats.received",
	"stats.cache",
	"stats.time",
	"stats.clock",
] as const;

/**
 * Shallow field-wise copy of a settings value: fresh top-level sub-objects,
 * same leaves. The dialog's working draft and the snapshot it hands to
 * onSave are both built from this shape — when a new sub-object joins
 * CompactSettings, copy it here, not at either call site.
 */
function cloneSettings(settings: CompactSettings): CompactSettings {
	return {
		...settings,
		stats: { ...settings.stats },
		tools: { ...settings.tools },
	};
}

/** Whether two per-tool choice maps hold the same entries. */
function sameToolChoices(
	a: Readonly<Record<string, ToolDisplay>>,
	b: Readonly<Record<string, ToolDisplay>>,
): boolean {
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
	);
}

export class SettingsDialog implements ComponentLike {
	private readonly initial: CompactSettings;
	private readonly deps: SettingsDialogDeps;
	private readonly done: (result: CompactSettings | undefined) => void;
	private readonly draft: CompactSettings;
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
		this.draft = cloneSettings(this.initial);
	}

	/** The mutable working draft (read-only by convention). */
	get current(): CompactSettings {
		return this.draft;
	}

	get isDirty(): boolean {
		const draft = this.draft;
		const initial = this.initial;
		return (
			draft.enabled !== initial.enabled ||
			draft.mode !== initial.mode ||
			draft.retainGitLive !== initial.retainGitLive ||
			draft.compactPaths !== initial.compactPaths ||
			draft.compactVibeRows !== initial.compactVibeRows ||
			draft.compactAdvisorNotes !== initial.compactAdvisorNotes ||
			draft.displayCycleKey !== initial.displayCycleKey ||
			draft.stats.enabled !== initial.stats.enabled ||
			draft.stats.actions !== initial.stats.actions ||
			draft.stats.sent !== initial.stats.sent ||
			draft.stats.received !== initial.stats.received ||
			draft.stats.cache !== initial.stats.cache ||
			draft.stats.time !== initial.stats.time ||
			draft.stats.clock !== initial.stats.clock ||
			!sameToolChoices(draft.tools, initial.tools)
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
		): Row => ({
			id,
			kind: "toggle",
			label,
			prefix,
			group,
			get,
			set: (value) => set(value === true),
			focusable,
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
				options: MODES,
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
			toggle(
				"compactAdvisorNotes",
				"Advisor nit/concern",
				() => draft.compactAdvisorNotes,
				(v) => {
					draft.compactAdvisorNotes = v;
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
							? "Fresh input"
							: id === "stats.received"
								? "Received tokens"
								: id === "stats.cache"
									? "Cached tokens"
									: id === "stats.time"
										? "Time"
										: "Add local time";
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
			...this.toolRows(),
		];
	}

	/**
	 * One cycle row per configurable tool under a "Tool cards" heading. A
	 * choice equal to the tool's default is stored as no entry, so the config
	 * keeps only real overrides and a changed default still reaches the tool.
	 */
	private toolRows(): Row[] {
		const tools = this.deps.tools ?? [];
		if (tools.length === 0) return [];
		const draft = this.draft;
		const chosen = (name: string): ToolDisplay | undefined =>
			Object.hasOwn(draft.tools, name) ? draft.tools[name] : undefined;
		return [
			{
				id: "tools",
				kind: "heading",
				label: "Tool cards",
				prefix: "",
				group: GROUP_TOOLS,
				get: () => undefined,
				set: () => undefined,
				focusable: false,
			},
			...tools.map(
				({ name, defaultDisplay }, index): Row => ({
					id: `${TOOL_ROW_PREFIX}${name}`,
					kind: "cycle",
					label: name,
					prefix: index === tools.length - 1 ? "└─ " : "├─ ",
					group: GROUP_TOOLS,
					get: () => chosen(name) ?? defaultDisplay,
					set: (value) => {
						if (!TOOL_DISPLAYS.includes(value as ToolDisplay)) return;
						const { [name]: _, ...rest } = draft.tools;
						draft.tools =
							value === defaultDisplay
								? rest
								: { ...rest, [name]: value as ToolDisplay };
					},
					focusable: true,
					options: TOOL_DISPLAYS,
					note: () => (chosen(name) === undefined ? "default" : ""),
				}),
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
		if (row?.kind !== "cycle" || row.options === undefined) return;
		const { options } = row;
		const index = options.indexOf(String(row.get()));
		const next = options[(index + delta + options.length) % options.length];
		row.set(next);
	}

	private activate(): void {
		const row = this.focusedRow();
		if (!row) return;
		if (row.kind === "toggle") {
			row.set(row.get() !== true);
		} else if (row.kind === "cycle") {
			this.cycle(1);
		} else {
			// The chord editor starts empty: a chord is typed whole, not
			// composed character by character, so pre-filling would force the
			// user to erase the old chord before typing the new one.
			this.editing = true;
			this.editBuffer = "";
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
		// Chord text: printable ASCII only, whole-chunk. Every legal chord
		// spells out as `modifier+base` in that range, so anything else is
		// either a control sequence or a paste that cannot be a chord.
		if (!/^[\x20-\x7e]+$/.test(data)) return;
		if (this.editBuffer.length < MAX_EDIT_CHARS) {
			const room = MAX_EDIT_CHARS - this.editBuffer.length;
			this.editBuffer += data.slice(0, room);
		}
	}

	private commitEdit(): void {
		const row = this.focusedRow();
		if (row?.kind === "text") this.commitChordEdit(row);
	}

	/**
	 * Commit the chord row. A chord OMP or another extension already holds is
	 * refused here rather than saved: a reserved chord is never bound and an
	 * app keybinding takes the key first, so accepting one would hand the user
	 * a key that never fires. The rejection keeps the editor open with the
	 * typed text intact. An accepted chord is committed in canonical form
	 * (host modifier order and the shift an uppercase base implies), so the
	 * row shows the spelling the store persists and the host registers — one
	 * spelling on all surfaces.
	 */
	private commitChordEdit(row: Row): void {
		const chord = this.editBuffer.trim();
		const rejection =
			validateDisplayCycleKey(chord) ??
			this.deps.checkShortcut?.(canonicalize(chord));
		if (rejection !== undefined) {
			this.error = rejection;
			return;
		}
		// Validate the typed text (the error line mirrors what the user
		// typed), then commit the canonical spelling.
		row.set(canonicalize(chord));
		this.editing = false;
		this.editBuffer = "";
		this.error = "";
	}

	private save(): void {
		if (this.saving || this.editing) return;
		if (!this.isDirty) {
			this.finish(undefined);
			return;
		}
		// Capture an immutable snapshot at confirmation time. Input may keep
		// mutating the live draft while a slow onSave is pending; the queued
		// payload and the dialog's resolved value must stay the confirmed
		// draft, not whatever the working copy holds when the write runs.
		const confirmed = cloneSettings(this.draft);
		this.saving = true;
		this.pending = this.pending.then(async () => {
			try {
				await this.deps.onSave(confirmed);
				this.saving = false;
				this.finish(confirmed);
			} catch (error) {
				this.saving = false;
				const message = error instanceof Error ? error.message : String(error);
				this.error = message;
				this.deps.warn?.(message);
			}
		});
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
		// menu sections (global, display, stats).
		let previousGroup = rows[0]?.group;
		for (const row of rows) {
			if (row.group !== previousGroup) lines.push("");
			previousGroup = row.group;
			if (row.kind === "heading") {
				lines.push(`  ${theme.bold(row.label)}`);
				continue;
			}
			const isFocused = row.id === focusedId;
			const muted = !row.focusable;
			const marker = isFocused ? theme.fg("accent", "› ") : "  ";
			const label = muted
				? theme.fg("muted", `${row.prefix}${row.label}`)
				: `${row.prefix}${row.label}`;
			let value: string;
			if (row.kind === "toggle") {
				const on = row.get() === true;
				// Disabled rows are fully muted — values included.
				value = muted
					? theme.fg("muted", on ? "on" : "off")
					: on
						? theme.fg("success", "on")
						: theme.fg("muted", "off");
			} else if (row.kind === "cycle") {
				value = theme.fg("accent", `[${String(row.get())}]`);
				const note = row.note?.();
				if (note) value += theme.fg("muted", ` ${note}`);
			} else if (this.editing && isFocused) {
				value = `[${
					theme.underline ? theme.underline(this.editBuffer) : this.editBuffer
				}]`;
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
		// comment on every row. Editing the chord shows its own key hints
		// instead, in the same telegraphic style.
		const help = this.editing
			? "chord edit · enter ok · esc cancel"
			: `${helpFor(focusedId)} · ↑↓ move · s save · esc cancel${
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
	 * focused row off the screen. Below `2 + tail` rows the pinned chrome
	 * alone overflows, so the window degenerates to the focused row plus
	 * whatever tail fits.
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
		// Heights too small for the header, one content row and the pinned tail
		// at once: windowing has nothing left to shrink, and the host drops
		// rows off the *top* of the composed frame (windowTop = frame.length -
		// height), so an oversized frame would cut the focused row and leave
		// the user staring at the help line alone. Emit the focused row and as
		// much of the tail as fits — the focused row is what the keyboard acts
		// on, so it outranks the header, the clip markers and the error line.
		if (terminalRows < 2 + tail) {
			const focused =
				focusLine >= middleStart && focusLine < middleEnd
					? lines[focusLine]
					: lines[middleStart];
			return [focused ?? "", ...lines.slice(middleEnd)].slice(0, terminalRows);
		}
		const viewport = Math.max(1, terminalRows - 1 - tail);
		if (middleCount <= viewport) return [...lines];
		const focusInMiddle =
			focusLine >= middleStart && focusLine < middleEnd
				? focusLine - middleStart
				: -1;

		// Window start that keeps the focused row centered for a given
		// content height. Shared by the initial placement and the indicator
		// pass below, where the content shrinks and the start must follow.
		const clampStart = (content: number): number =>
			focusInMiddle >= 0
				? Math.max(
						0,
						Math.min(
							focusInMiddle - Math.floor(content / 2),
							middleCount - content,
						),
					)
				: 0;

		let content = Math.min(viewport, middleCount);
		let start = clampStart(content);
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
				start = clampStart(content);
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
