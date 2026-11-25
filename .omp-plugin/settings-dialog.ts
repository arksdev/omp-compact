import {
	batch,
	computed,
	jsx,
	type KeyEvent,
	type PasteEvent,
	signal,
	type UiEvent,
	type UiNode,
	untrack,
} from "@oh-my-pi/pi-tui";
import type {
	TspPrefsProps,
	TspPrefsRow,
	TspPrefsSection,
} from "@oh-my-pi/pi-wire";

import {
	type CompactMode,
	type CompactSettings,
	type CompactSettingsStore,
	type CompactStatsSettings,
	DEFAULT_SETTINGS,
	STATS_STYLES,
	TOOL_DISPLAYS,
	type ToolDisplay,
} from "./config";
import { canonicalize, validateDisplayCycleKey } from "./display-cycle";
import type { SettingsUiLike } from "./host-api";
import {
	notifySaveOutcome,
	type SaveOutcome,
	saveSettingsFlow,
} from "./save-flow";
import { toolDisplayOptions } from "./tool-display";

/** A tool the user can choose a display for, with the display it defaults to. */
export interface ToolDisplayOption {
	/** Canonical tool name, the key of `CompactSettings.tools`. */
	name: string;
	defaultDisplay: ToolDisplay;
}

/** One settings change, as a function of the settings it applies to. */
export type SettingsUpdate = (current: CompactSettings) => CompactSettings;

export interface SettingsDialogDeps {
	/** The settings shown when the dialog opens. */
	settings: CompactSettings;
	/**
	 * Tools listed under "Tool cards", in display order. Absent or empty: the
	 * section is left out.
	 */
	tools?: readonly ToolDisplayOption[];
	/**
	 * Save one change at once and resolve with the settings to show next;
	 * reject when the change was not saved (the row then reverts). The dialog
	 * hands its changes over one at a time, in order.
	 */
	onChange(update: SettingsUpdate): Promise<CompactSettings>;
	/**
	 * Why OMP or another extension already holds a chord, or `undefined`
	 * when it is free (`getShortcutConflict` through
	 * `describeShortcutConflict`). Absent: only the chord syntax is checked.
	 */
	checkShortcut?(chord: string): string | undefined;
	/** Report a change that could not be saved. */
	warn(message: string): void;
	/**
	 * Whether omp draws Tern's native view (`ternNativeView`). The `Tern
	 * style` row is listed only there, where the style shows. Absent: not Tern.
	 */
	ternView?: boolean;
}

const TITLE = "OMP Compact — Settings";
const MODES: readonly CompactMode[] = ["compact", "live", "clear"];

/** One help line per setting, shown under the list for the selected row. */
const ROW_HELP = {
	enabled: "Toggles the compact runtime",
	mode: "compact / live / clear runtime mode",
	compactPaths: "Renders paths relative to the session cwd",
	retainGitLive: "Keeps Git commit rows after the terminal answer",
	compactVibeRows: "Compact rows for vibe tools",
	compactAdvisorNotes: "Compact nit/concern advisor notes; blockers stay full",
	displayCycleKey:
		"Chord cycling compact / live / clear / off; a new chord takes effect after restarting OMP",
	"stats.enabled": "Shows one usage row per completed run",
	"stats.actions": "Action counts in the usage row",
	"stats.sent": "Fresh (uncached) input tokens in the usage row",
	"stats.received": "Received tokens in the usage row",
	"stats.cache":
		"Cached tokens, share, and writes; fresh + cached + written = full prompt",
	"stats.time": "Run time in the usage row",
	"stats.clock": "Local time of the answer, beside the usage row",
	"stats.style":
		"How Tern draws the usage row: rows (terminal line) / text / chips / rule / icons",
} as const;

/**
 * Help for every tool row: what each display means. It is part of each
 * row's search text, so it avoids words a short tool-name query also hits
 * (with "always" in it, `wa` matched every tool, not just `wait`).
 */
const TOOL_ROW_HELP =
	"rows: one-line rows · newest: newest card open while working · open: the full card every time";

type DisplayToggle =
	| "compactPaths"
	| "retainGitLive"
	| "compactVibeRows"
	| "compactAdvisorNotes";

const DISPLAY_TOGGLES: readonly { id: DisplayToggle; label: string }[] = [
	{ id: "compactPaths", label: "Compact paths" },
	{ id: "retainGitLive", label: "Retain Git rows" },
	{ id: "compactVibeRows", label: "vibe-compact" },
	{ id: "compactAdvisorNotes", label: "Advisor nit/concern" },
];

type StatsChild = Exclude<keyof CompactStatsSettings, "enabled" | "style">;

const STATS_CHILDREN: readonly { key: StatsChild; label: string }[] = [
	{ key: "actions", label: "Actions" },
	{ key: "sent", label: "Fresh input" },
	{ key: "received", label: "Received tokens" },
	{ key: "cache", label: "Cached tokens" },
	{ key: "time", label: "Time" },
	{ key: "clock", label: "Add local time" },
];

const STATS_PREFIX = "stats.";
const TOOL_PREFIX = "tools.";

type SectionId = "general" | "display" | "statistics" | "tools";

/**
 * The dialog's sections; each one is a page drawn with the icon of an omp
 * settings tab. Tool rows share one explanation, so it is the page's lead.
 */
const SECTIONS: readonly {
	id: SectionId;
	title: string;
	icon: string;
	lead?: string;
}[] = [
	{ id: "general", title: "General", icon: "interaction" },
	{ id: "display", title: "Display", icon: "appearance" },
	{ id: "statistics", title: "Statistics", icon: "context" },
	{ id: "tools", title: "Tool cards", icon: "tools", lead: TOOL_ROW_HELP },
];

interface DialogRow {
	readonly section: SectionId;
	readonly row: TspPrefsRow;
	readonly searchText: string;
	readonly omitTerminalHint?: boolean;
}

interface LineState {
	readonly text: string;
	readonly cursor: number;
}

const PREFS_NAV_KEYS: Readonly<Record<string, true>> = {
	up: true,
	down: true,
	left: true,
	right: true,
	pageUp: true,
	pageDown: true,
	home: true,
	end: true,
	enter: true,
	return: true,
	space: true,
	escape: true,
};

function booleanRow(
	section: SectionId,
	id: keyof typeof ROW_HELP,
	label: string,
	value: boolean,
	defaultValue: boolean,
): DialogRow {
	const hint = ROW_HELP[id];
	return {
		section,
		searchText: `${label} ${hint}`.toLowerCase(),
		row: {
			id,
			label,
			hint,
			changed: value !== defaultValue || undefined,
			defaultLabel: defaultValue ? "On" : "Off",
			control: { k: "switch", on: value },
		},
	};
}

function choiceRow(
	section: SectionId,
	id: string,
	label: string,
	value: string,
	options: readonly string[],
	defaultValue: string,
	hint: string | undefined,
	changed: boolean,
	omitTerminalHint?: boolean,
): DialogRow {
	return {
		section,
		omitTerminalHint,
		searchText: `${label} ${hint ?? ""}`.toLowerCase(),
		row: {
			id,
			label,
			...(hint ? { hint } : {}),
			changed: changed || undefined,
			defaultLabel: defaultValue,
			control: {
				k: "choice",
				value,
				options: options.map((option) => ({ value: option, label: option })),
				mono: true,
			},
		},
	};
}

/** Remove the per-tool entry for `name`, keeping every other choice. */
function withoutTool(
	tools: Readonly<Record<string, ToolDisplay>>,
	name: string,
): Record<string, ToolDisplay> {
	const { [name]: _, ...rest } = tools;
	return rest;
}

/** Apply single-line editing keys (`backspace`, `delete`, arrows, `home`/`end`, text). */
function editLine(line: LineState, key: KeyEvent): LineState | undefined {
	const { text, cursor } = line;
	if (key.id === "backspace") {
		if (cursor === 0) return line;
		return {
			text: text.slice(0, cursor - 1) + text.slice(cursor),
			cursor: cursor - 1,
		};
	}
	if (key.id === "delete") {
		if (cursor >= text.length) return line;
		return {
			text: text.slice(0, cursor) + text.slice(cursor + 1),
			cursor,
		};
	}
	if (key.id === "left") return { text, cursor: Math.max(0, cursor - 1) };
	if (key.id === "right")
		return { text, cursor: Math.min(text.length, cursor + 1) };
	if (key.id === "home") return { text, cursor: 0 };
	if (key.id === "end") return { text, cursor: text.length };
	if (
		key.text !== undefined &&
		key.text.length > 0 &&
		!key.id.includes("ctrl+") &&
		!key.id.includes("alt+") &&
		!key.id.includes("cmd+")
	) {
		return {
			text: text.slice(0, cursor) + key.text + text.slice(cursor),
			cursor: cursor + key.text.length,
		};
	}
	return undefined;
}

function buildRows(
	shown: CompactSettings,
	deps: Pick<SettingsDialogDeps, "tools" | "ternView">,
): DialogRow[] {
	const rows: DialogRow[] = [
		booleanRow(
			"general",
			"enabled",
			"Global compact",
			shown.enabled,
			DEFAULT_SETTINGS.enabled,
		),
		choiceRow(
			"general",
			"mode",
			"Mode",
			shown.mode,
			MODES,
			DEFAULT_SETTINGS.mode,
			ROW_HELP.mode,
			shown.mode !== DEFAULT_SETTINGS.mode,
		),
		...DISPLAY_TOGGLES.map(({ id, label }) =>
			booleanRow("display", id, label, shown[id], DEFAULT_SETTINGS[id]),
		),
		{
			section: "display",
			searchText: `cycle shortcut ${ROW_HELP.displayCycleKey}`.toLowerCase(),
			row: {
				id: "displayCycleKey",
				label: "Cycle shortcut",
				hint: ROW_HELP.displayCycleKey,
				changed:
					shown.displayCycleKey !== DEFAULT_SETTINGS.displayCycleKey ||
					undefined,
				defaultLabel: DEFAULT_SETTINGS.displayCycleKey,
				control: { k: "text", value: shown.displayCycleKey, mono: true },
			},
		},
		booleanRow(
			"statistics",
			"stats.enabled",
			"Run statistics",
			shown.stats.enabled,
			DEFAULT_SETTINGS.stats.enabled,
		),
	];

	if (shown.stats.enabled) {
		for (const { key, label } of STATS_CHILDREN) {
			rows.push(
				booleanRow(
					"statistics",
					`stats.${key}`,
					label,
					shown.stats[key],
					DEFAULT_SETTINGS.stats[key],
				),
			);
		}
		if (deps.ternView) {
			rows.push(
				choiceRow(
					"statistics",
					"stats.style",
					"Tern style",
					shown.stats.style,
					STATS_STYLES,
					DEFAULT_SETTINGS.stats.style,
					ROW_HELP["stats.style"],
					shown.stats.style !== DEFAULT_SETTINGS.stats.style,
				),
			);
		}
	}

	for (const { name, defaultDisplay } of deps.tools ?? []) {
		const chosen = Object.hasOwn(shown.tools, name)
			? shown.tools[name]
			: undefined;
		rows.push(
			choiceRow(
				"tools",
				`${TOOL_PREFIX}${name}`,
				name,
				chosen ?? defaultDisplay,
				TOOL_DISPLAYS,
				defaultDisplay,
				TOOL_ROW_HELP,
				chosen !== undefined,
				true,
			),
		);
	}
	return rows;
}

/**
 * Create the `/compact-settings` `<prefs>` node tree: sectioned settings with
 * type-to-search, changed markers, chord validation, and sequential saves.
 */
export function createSettingsDialog(
	deps: SettingsDialogDeps,
	done: (result: CompactSettings | undefined) => void,
): UiNode {
	let saved = deps.settings;
	let anySaved = false;
	let closing = false;
	let queue: Promise<void> = Promise.resolve();
	const pending: SettingsUpdate[] = [];
	const revision = signal(0);

	const page = signal<SectionId>("general");
	const searchPage = signal<SectionId>("general");
	const preSearchPage = signal<SectionId>("general");
	const selected = signal<string | undefined>("enabled");
	const query = signal<LineState>({ text: "", cursor: 0 });
	const editing = signal<{
		readonly row: string;
		readonly line: LineState;
		readonly error?: string;
	} | null>(null);

	const shown = computed((): CompactSettings => {
		revision();
		return pending.reduce((acc, update) => update(acc), saved);
	});

	const allRows = computed(() => buildRows(shown(), deps));
	const searching = computed(() => query().text.length > 0);

	const visibleRows = computed(() => {
		const rows = allRows();
		const q = query().text.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter((entry) => entry.searchText.includes(q));
	});

	const pages = computed((): TspPrefsProps["pages"] => {
		const rows = allRows();
		const active = new Set<SectionId>();
		const changed = new Map<SectionId, number>();
		for (const entry of rows) {
			active.add(entry.section);
			if (entry.row.changed)
				changed.set(entry.section, (changed.get(entry.section) ?? 0) + 1);
		}
		return SECTIONS.filter((section) => active.has(section.id)).map(
			({ id, title, icon }) => ({
				id,
				label: title,
				icon,
				changed: changed.get(id),
			}),
		);
	});

	const sections = computed((): TspPrefsSection[] => {
		const isSearch = searching();
		const rows = isSearch
			? visibleRows()
			: allRows().filter((entry) => entry.section === page());
		const grouped = new Map<SectionId, TspPrefsRow[]>();
		for (const entry of rows) {
			const bucket = grouped.get(entry.section) ?? [];
			const row = entry.omitTerminalHint
				? (({ hint: _, ...rest }) => rest)(entry.row)
				: entry.row;
			bucket.push(row);
			grouped.set(entry.section, bucket);
		}
		return SECTIONS.flatMap(({ id, title }) => {
			const groupRows = grouped.get(id);
			if (!groupRows || groupRows.length === 0) return [];
			return [
				isSearch
					? { id, title, page: id, rows: groupRows }
					: { id, title, rows: groupRows },
			];
		});
	});

	const selectedId = computed((): string | undefined => {
		const rows = searching()
			? visibleRows()
			: allRows().filter((entry) => entry.section === page());
		const current = selected();
		if (current && rows.some((entry) => entry.row.id === current))
			return current;
		return rows[0]?.row.id;
	});

	function updateFor(id: string, value: string): SettingsUpdate | undefined {
		const on = value === "true";
		switch (id) {
			case "enabled":
				return (current) => ({ ...current, enabled: on });
			case "mode": {
				const mode = MODES.find((candidate) => candidate === value);
				return mode ? (current) => ({ ...current, mode }) : undefined;
			}
			case "displayCycleKey":
				return (current) => ({ ...current, displayCycleKey: value });
		}
		const toggle = DISPLAY_TOGGLES.find((row) => row.id === id);
		if (toggle) return (current) => ({ ...current, [toggle.id]: on });
		if (id === "stats.style") {
			const style = STATS_STYLES.find((candidate) => candidate === value);
			return style
				? (current) => ({ ...current, stats: { ...current.stats, style } })
				: undefined;
		}
		if (id.startsWith(STATS_PREFIX)) {
			const key = id.slice(STATS_PREFIX.length) as keyof CompactStatsSettings;
			return (current) => ({
				...current,
				stats: { ...current.stats, [key]: on },
			});
		}
		if (id.startsWith(TOOL_PREFIX)) {
			const name = id.slice(TOOL_PREFIX.length);
			const tool = deps.tools?.find((option) => option.name === name);
			const display = TOOL_DISPLAYS.find((candidate) => candidate === value);
			if (!tool || !display) return undefined;
			return (current) => {
				const rest = withoutTool(current.tools, name);
				return {
					...current,
					tools:
						display === tool.defaultDisplay
							? rest
							: { ...rest, [name]: display },
				};
			};
		}
		return undefined;
	}

	function applyChange(id: string, value: string): void {
		const update = closing ? undefined : updateFor(id, value);
		if (!update) return;
		pending.push(update);
		revision.set(untrack(revision) + 1);
		queue = queue.then(async () => {
			try {
				saved = await deps.onChange(update);
				anySaved = true;
			} catch (error) {
				deps.warn(error instanceof Error ? error.message : String(error));
			}
			const index = pending.indexOf(update);
			if (index !== -1) pending.splice(index, 1);
			revision.set(untrack(revision) + 1);
		});
	}

	function defaultValue(id: string): string | undefined {
		const entry = buildRows(DEFAULT_SETTINGS, deps).find(
			(candidate) => candidate.row.id === id,
		);
		if (!entry) return undefined;
		const control = entry.row.control;
		if (control.k === "switch") return String(control.on);
		if (control.k === "choice" || control.k === "text") return control.value;
		return undefined;
	}

	function validateChord(raw: string): {
		chord?: string;
		error?: string;
	} {
		const trimmed = raw.trim();
		const syntaxError = validateDisplayCycleKey(trimmed);
		if (syntaxError) return { error: syntaxError };
		const canonical = canonicalize(trimmed);
		const conflict = deps.checkShortcut?.(canonical);
		if (conflict) return { error: conflict };
		return { chord: canonical };
	}

	function submitChord(raw: string, openOnError: boolean): void {
		const trimmed = raw.trim();
		if (trimmed === "") {
			editing.set(null);
			return;
		}
		const check = validateChord(trimmed);
		if (check.error || !check.chord) {
			if (openOnError) {
				batch(() => {
					if (!untrack(searching)) {
						page.set("display");
						selected.set("displayCycleKey");
					}
					editing.set({
						row: "displayCycleKey",
						line: { text: raw, cursor: raw.length },
						error: check.error,
					});
				});
			}
			return;
		}
		editing.set(null);
		if (check.chord !== untrack(shown).displayCycleKey) {
			applyChange("displayCycleKey", check.chord);
		}
	}

	function showPage(id: string): void {
		const rows = untrack(allRows);
		const first = rows.find((entry) => entry.section === id);
		if (!first) return;
		batch(() => {
			editing.set(null);
			query.set({ text: "", cursor: 0 });
			page.set(first.section);
			selected.set(first.row.id);
		});
	}

	function stepPage(delta: -1 | 1): void {
		const list = untrack(pages);
		if (list.length === 0) return;
		const at = Math.max(
			0,
			list.findIndex((p) => p.id === untrack(page)),
		);
		const next = list[(at + delta + list.length) % list.length];
		if (next) showPage(next.id);
	}

	function endSearch(jumpToSelected: boolean): void {
		const id = jumpToSelected ? untrack(selectedId) : undefined;
		const entry = id
			? untrack(allRows).find((candidate) => candidate.row.id === id)
			: undefined;
		batch(() => {
			query.set({ text: "", cursor: 0 });
			if (entry) {
				page.set(entry.section);
				selected.set(entry.row.id);
			} else {
				page.set(untrack(preSearchPage));
			}
		});
	}

	function jumpSearchPage(delta: -1 | 1): void {
		const rows = untrack(visibleRows);
		const ids = [...new Set(rows.map((entry) => entry.section))];
		if (ids.length === 0) return;
		const current = rows.find(
			(entry) => entry.row.id === untrack(selectedId),
		)?.section;
		const at = Math.max(0, current ? ids.indexOf(current) : 0);
		const next = ids[(at + delta + ids.length) % ids.length];
		const first = rows.find((entry) => entry.section === next);
		if (first) {
			batch(() => {
				selected.set(first.row.id);
				searchPage.set(first.section);
			});
		}
	}

	function closeDialog(): void {
		if (closing) return;
		closing = true;
		void queue.then(() => done(anySaved ? saved : undefined));
	}

	function onKey(key: KeyEvent): boolean {
		if (closing) return true;
		if (key.kind === "release") return false;
		const open = untrack(editing);
		if (open) {
			if (key.id === "escape") {
				editing.set(null);
				return true;
			}
			if (key.id === "enter" || key.id === "return") {
				submitChord(open.line.text, true);
				return true;
			}
			const next = editLine(open.line, key);
			if (next) editing.set({ row: open.row, line: next });
			return true;
		}

		if (untrack(searching)) {
			if (key.id === "escape") {
				endSearch(true);
				return true;
			}
			if (key.id === "tab") {
				jumpSearchPage(1);
				return true;
			}
			if (key.id === "shift+tab") {
				jumpSearchPage(-1);
				return true;
			}
			if (key.id !== "space" && PREFS_NAV_KEYS[key.id]) return false;
			const next = editLine(untrack(query), key);
			if (next) {
				batch(() => {
					query.set(next);
					if (next.text === "") page.set(untrack(preSearchPage));
					const first = untrack(visibleRows)[0];
					if (first) {
						searchPage.set(first.section);
						selected.set(first.row.id);
					}
				});
			}
			return true;
		}

		if (key.id === "tab" || key.id === "shift+tab") {
			stepPage(key.id === "tab" ? 1 : -1);
			return true;
		}
		const text = key.text;
		if (
			text !== undefined &&
			text.trim().length > 0 &&
			key.id !== "space" &&
			!PREFS_NAV_KEYS[key.id] &&
			!key.id.includes("ctrl+") &&
			!key.id.includes("alt+") &&
			!key.id.includes("cmd+")
		) {
			batch(() => {
				preSearchPage.set(untrack(page));
				query.set({ text, cursor: text.length });
				const first = untrack(visibleRows)[0];
				if (first) {
					searchPage.set(first.section);
					selected.set(first.row.id);
				}
			});
			return true;
		}
		return false;
	}

	function onPaste(paste: PasteEvent): boolean {
		if (closing) return true;
		const text = paste.text.replace(/[\r\n]+/g, "");
		if (!text) return false;
		const insert = (line: LineState): LineState => ({
			text:
				line.text.slice(0, line.cursor) + text + line.text.slice(line.cursor),
			cursor: line.cursor + text.length,
		});
		const open = untrack(editing);
		if (open) {
			editing.set({ row: open.row, line: insert(open.line) });
			return true;
		}
		batch(() => {
			if (!untrack(searching)) preSearchPage.set(untrack(page));
			query.set(insert(untrack(query)));
		});
		return true;
	}

	function onEvent(event: UiEvent): void {
		if (closing) return;
		switch (event.type) {
			case "action":
				if (event.act === "page" && event.value) showPage(event.value);
				else if (event.act === "close") {
					if (
						event.value !== undefined &&
						untrack(editing)?.row === event.value
					)
						editing.set(null);
					else closeDialog();
				} else if (event.act === "edit" && event.value === "displayCycleKey") {
					editing.set({
						row: "displayCycleKey",
						line: { text: "", cursor: 0 },
					});
				}
				return;
			case "select": {
				const [rowId] = event.item.split("=");
				if (rowId) {
					selected.set(rowId);
					const entry = untrack(allRows).find(
						(candidate) => candidate.row.id === rowId,
					);
					if (entry && untrack(searching)) searchPage.set(entry.section);
				}
				return;
			}
			case "activate":
				if (event.item === "displayCycleKey") {
					editing.set({
						row: "displayCycleKey",
						line: { text: "", cursor: 0 },
					});
				}
				return;
			case "change":
				if (event.value === null) {
					const reset = defaultValue(event.item);
					if (reset === undefined) return;
					if (event.item === "displayCycleKey") submitChord(reset, true);
					else applyChange(event.item, reset);
					return;
				}
				if (event.item === "displayCycleKey") {
					if (typeof event.value === "string") submitChord(event.value, true);
					return;
				}
				if (
					typeof event.value === "boolean" ||
					typeof event.value === "string"
				) {
					applyChange(event.item, String(event.value));
				}
				return;
		}
	}

	return jsx("prefs", {
		title: "OMP Compact",
		pages,
		page: () => (searching() ? searchPage() : page()),
		lead: () =>
			searching()
				? undefined
				: SECTIONS.find((section) => section.id === page())?.lead,
		query: () => (searching() ? query().text : undefined),
		cursor: () => (searching() ? query().cursor : undefined),
		sections,
		focus: () => selectedId() ?? null,
		editing: () => {
			const open = editing();
			return open
				? {
						row: open.row,
						draft: open.line.text,
						cursor: open.line.cursor,
					}
				: null;
		},
		term: () => ({
			title: TITLE,
			page: searching() ? searchPage() : undefined,
			selected: selectedId(),
			error: editing()?.error,
		}),
		onKey,
		onPaste,
		onAction: (_act: string, event: Extract<UiEvent, { type: "action" }>) =>
			onEvent(event),
		onChange: (event: Extract<UiEvent, { type: "change" }>) => onEvent(event),
		onSelect: (_item: string, event: Extract<UiEvent, { type: "select" }>) =>
			onEvent(event),
		onActivate: (
			_item: string,
			event: Extract<UiEvent, { type: "activate" }>,
		) => onEvent(event),
	}) as UiNode;
}

/**
 * Open the settings dialog through `ui.custom`. When the UI surface is
 * unavailable (headless/RPC), warns and resolves `undefined` without throwing.
 */
export function openSettingsDialog(
	ui: SettingsUiLike,
	deps: SettingsDialogDeps,
): Promise<CompactSettings | undefined> {
	if (typeof ui?.custom !== "function") {
		deps.warn(
			"omp-compact: interactive settings UI unavailable; nothing was changed",
		);
		return Promise.resolve(undefined);
	}
	return ui.custom<CompactSettings | undefined>(
		(_ui, _theme, _keybindings, done) => createSettingsDialog(deps, done),
		{ overlay: true, fullscreen: true },
	);
}

export interface SettingsSessionDeps {
	store: CompactSettingsStore;
	/** Names of the tools omp reports, listed under "Tool cards". */
	toolNames: Iterable<string>;
	/**
	 * The cycle chord omp bound at startup; a session that leaves another
	 * chord on disk adds the restart note. Absent: the chord the session
	 * opened on.
	 */
	boundCycleKey?: string;
	checkShortcut?(chord: string): string | undefined;
	/** Whether omp draws Tern's native view; see `SettingsDialogDeps.ternView`. */
	ternView?: boolean;
	notify(level: "info" | "warning", message: string): void;
}

/**
 * One `/compact-settings` session. The dialog opens on the settings on disk,
 * the layer every save returns, so a row masked by an env override shows the
 * user's own value. Each change is saved at once as the user's own edit of
 * that layer; the session is reported once, at close, from the last save
 * (the final state on disk).
 */
export async function runSettingsSession(
	ui: SettingsUiLike,
	deps: SettingsSessionDeps,
): Promise<void> {
	const effective = await deps.store.load();
	const opened = deps.store.persistedSnapshot?.() ?? effective;
	let last: SaveOutcome | undefined;
	const saved = await openSettingsDialog(ui, {
		settings: opened,
		tools: toolDisplayOptions(deps.toolNames, opened.tools),
		checkShortcut: deps.checkShortcut,
		ternView: deps.ternView,
		onChange: async (update) => {
			last = await saveSettingsFlow(update, {
				store: deps.store,
				explicit: true,
			});
			return last.persisted;
		},
		warn: (message) => deps.notify("warning", message),
	});
	if (saved !== undefined && last !== undefined) {
		notifySaveOutcome(
			last,
			deps.boundCycleKey ?? opened.displayCycleKey,
			deps.notify,
		);
	}
}
