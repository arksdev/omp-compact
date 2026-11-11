import {
	type Component,
	col,
	type DescribeContext,
	type NativeChild,
	type NativeNode,
	type NativeUiEvent,
	node,
	type OverlayOptions,
	type SettingItem,
	SettingsList,
	span,
	TextFormField,
	text,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import type {
	TspPrefsControl,
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
	TOOL_DISPLAYS,
	type ToolDisplay,
} from "./config";
import { canonicalize, validateDisplayCycleKey } from "./display-cycle";
import type { SettingsUiLike } from "./host-api";
import { type SettingsDialogHost, settingsDialogHost } from "./host-modules";
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
	 * The terminal height in rows, read at every render, so the dialog never
	 * outgrows a short terminal. Absent or unusable: a fixed list height.
	 */
	getTerminalRows?(): number | undefined;
	/** Ask the host for a frame after a save settled outside an input event. */
	requestRender?(): void;
}

const TITLE = "OMP Compact — Settings";
/** Rows above the list: the title and one blank line. */
const TITLE_ROWS = 2;
/**
 * Rows the list draws besides its viewport: a blank and three description
 * rows, the search line, a blank and the hint (`SettingsList` stable height).
 */
const LIST_CHROME_ROWS = 7;
/** List viewport when the terminal height is unknown. */
const DEFAULT_VISIBLE_ROWS = 12;
/**
 * Smallest viewport: the section sidebar draws one row per section and never
 * fewer, so a shorter viewport would let the frame grow with the sidebar.
 */
const MIN_VISIBLE_ROWS = 4;

const BOOLEAN_VALUES = ["true", "false"];
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

type StatsChild = Exclude<keyof CompactStatsSettings, "enabled">;

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

/** omp's role for an editor drawn over a native settings page. */
const PREFS_EDITOR_ROLE = "omp.prefs.editor";

type SectionId = "general" | "display" | "statistics" | "tools";

/**
 * The dialog's sections; on Tern's native settings page each one is a page,
 * drawn with the icon of an omp settings tab (Tern knows only those names).
 * Tool rows share one explanation, so it is the page's lead, not 40 copies.
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

const HEADING_PREFIX = "section.";

function sectionTitle(section: SectionId): string {
	return SECTIONS.find(({ id }) => id === section)?.title ?? section;
}

function heading(section: SectionId): SettingItem {
	return {
		id: `${HEADING_PREFIX}${section}`,
		label: sectionTitle(section),
		currentValue: "",
		heading: true,
	};
}

function booleanItem(
	id: keyof typeof ROW_HELP,
	label: string,
	value: boolean,
	defaultValue: boolean,
): SettingItem {
	return {
		id,
		label,
		description: ROW_HELP[id],
		currentValue: String(value),
		values: BOOLEAN_VALUES,
		changed: value !== defaultValue,
		// omp names a boolean default On/Off, as its own settings do.
		defaultLabel: defaultValue ? "On" : "Off",
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

/**
 * The settings dialog: omp's own settings list (sections, type-to-search,
 * changed markers) under a title. Each change is saved at once, like omp's
 * `/settings`; Esc closes once every change has settled.
 */
export class SettingsDialog implements Component {
	readonly #deps: SettingsDialogDeps;
	readonly #host: SettingsDialogHost;
	readonly #done: (result: CompactSettings | undefined) => void;
	readonly #list: SettingsList;
	/** The settings the last successful save returned. */
	#saved: CompactSettings;
	/** Changes handed to `onChange` that have not settled yet, in order. */
	readonly #pending: SettingsUpdate[] = [];
	#queue: Promise<void> = Promise.resolve();
	#anySaved = false;
	#closing = false;
	#native?: NativeNode;

	/** `host`: omp's settings-list chrome (`settingsDialogHost`). */
	constructor(
		deps: SettingsDialogDeps,
		done: (result: CompactSettings | undefined) => void,
		host: SettingsDialogHost,
	) {
		this.#host = host;
		this.#deps = deps;
		this.#done = done;
		this.#saved = deps.settings;
		this.#list = new SettingsList(
			this.#items(),
			DEFAULT_VISIBLE_ROWS,
			host.getSettingsListTheme(),
			(id, value) => this.#change(id, value),
			() => this.#close(),
			{
				layout: "auto",
				hint: `${host.editorKey("tui.select.confirm")}/${host.formatKeyHint("space")} to change · ${host.editorKeys("tui.select.pageUp", "tui.select.pageDown")} to jump sections · Type to search · ${host.editorKey("tui.select.cancel")} to close`,
			},
		);
	}

	/** The saved settings with every pending change applied on top. */
	#shown(): CompactSettings {
		return this.#pending.reduce(
			(settings, update) => update(settings),
			this.#saved,
		);
	}

	/** The rows for `shown`: by default the saved settings plus pending changes. */
	#items(shown: CompactSettings = this.#shown()): SettingItem[] {
		const items: SettingItem[] = [
			heading("general"),
			booleanItem(
				"enabled",
				"Global compact",
				shown.enabled,
				DEFAULT_SETTINGS.enabled,
			),
			{
				id: "mode",
				label: "Mode",
				description: ROW_HELP.mode,
				currentValue: shown.mode,
				values: [...MODES],
				changed: shown.mode !== DEFAULT_SETTINGS.mode,
				defaultLabel: DEFAULT_SETTINGS.mode,
			},
			heading("display"),
			...DISPLAY_TOGGLES.map(({ id, label }) =>
				booleanItem(id, label, shown[id], DEFAULT_SETTINGS[id]),
			),
			{
				id: "displayCycleKey",
				label: "Cycle shortcut",
				description: ROW_HELP.displayCycleKey,
				currentValue: shown.displayCycleKey,
				changed: shown.displayCycleKey !== DEFAULT_SETTINGS.displayCycleKey,
				defaultLabel: DEFAULT_SETTINGS.displayCycleKey,
				submenu: (current, done) => this.#chordEditor(current, done),
			},
			heading("statistics"),
			booleanItem(
				"stats.enabled",
				"Run statistics",
				shown.stats.enabled,
				DEFAULT_SETTINGS.stats.enabled,
			),
		];
		// Like omp's conditional settings: the parts of the usage row are
		// hidden while the row itself is off.
		if (shown.stats.enabled) {
			for (const { key, label } of STATS_CHILDREN) {
				items.push(
					booleanItem(
						`stats.${key}`,
						label,
						shown.stats[key],
						DEFAULT_SETTINGS.stats[key],
					),
				);
			}
		}
		const tools = this.#deps.tools ?? [];
		if (tools.length > 0) {
			items.push(heading("tools"));
			for (const { name, defaultDisplay } of tools) {
				const chosen = Object.hasOwn(shown.tools, name)
					? shown.tools[name]
					: undefined;
				items.push({
					id: `${TOOL_PREFIX}${name}`,
					label: name,
					description: TOOL_ROW_HELP,
					currentValue: chosen ?? defaultDisplay,
					values: [...TOOL_DISPLAYS],
					changed: chosen !== undefined,
					defaultLabel: defaultDisplay,
				});
			}
		}
		return items;
	}

	/**
	 * The cycle-shortcut editor. A chord OMP or another extension already
	 * holds is refused rather than saved: a reserved chord is never bound and
	 * an app keybinding takes the key first. An accepted chord is saved in
	 * canonical form (host modifier order and the shift an uppercase base
	 * implies), the spelling the store persists and the host registers.
	 */
	#chordEditor(current: string, done: (value?: string) => void): TextFormField {
		const host = this.#host;
		return new TextFormField({
			theme: host.formTheme,
			label: "Cycle shortcut",
			description: ROW_HELP.displayCycleKey,
			// Empty, not prefilled: a chord is typed whole, and an empty
			// submit leaves the shortcut as it is.
			empty: "cancel",
			validate: (value) => {
				const chord = value.trim();
				return (
					validateDisplayCycleKey(chord) ??
					this.#deps.checkShortcut?.(canonicalize(chord))
				);
			},
			onSubmit: (value) => {
				const chord = canonicalize(value.trim());
				done(chord === current ? undefined : chord);
			},
			onCancel: () => done(),
			hint: `  ${host.editorKey("tui.input.submit")} to save · ${host.editorKey("tui.select.cancel")} to go back`,
		});
	}

	/** The change a row's new value stands for; `undefined` for no change. */
	#updateFor(id: string, value: string): SettingsUpdate | undefined {
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
		if (id.startsWith(STATS_PREFIX)) {
			const key = id.slice(STATS_PREFIX.length) as keyof CompactStatsSettings;
			return (current) => ({
				...current,
				stats: { ...current.stats, [key]: on },
			});
		}
		if (id.startsWith(TOOL_PREFIX)) {
			const name = id.slice(TOOL_PREFIX.length);
			const tool = this.#deps.tools?.find((option) => option.name === name);
			const display = TOOL_DISPLAYS.find((candidate) => candidate === value);
			if (!tool || !display) return undefined;
			// A choice equal to the tool's default is stored as no entry, so
			// the config keeps only real overrides and a changed default still
			// reaches the tool.
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

	/**
	 * Show the change at once and save it after the changes before it. A
	 * failed save drops the change, so its row shows the saved value again.
	 */
	#change(id: string, value: string): void {
		// Tern's native events reach the list directly, past `handleInput`,
		// so a change can still arrive while the dialog is closing.
		const update = this.#closing ? undefined : this.#updateFor(id, value);
		if (!update) {
			this.#list.setItems(this.#items());
			return;
		}
		this.#pending.push(update);
		this.#list.setItems(this.#items());
		this.#queue = this.#queue.then(async () => {
			try {
				this.#saved = await this.#deps.onChange(update);
				this.#anySaved = true;
			} catch (error) {
				this.#deps.warn(error instanceof Error ? error.message : String(error));
			}
			this.#pending.splice(this.#pending.indexOf(update), 1);
			this.#list.setItems(this.#items());
			this.#deps.requestRender?.();
		});
	}

	/** Close once every change has settled; resolve with what was saved. */
	#close(): void {
		if (this.#closing) return;
		this.#closing = true;
		void this.#queue.then(() =>
			this.#done(this.#anySaved ? this.#saved : undefined),
		);
	}

	handleInput(data: string): void {
		if (this.#closing) return;
		this.#list.handleInput(data);
	}

	render(width: number): readonly string[] {
		const rows = this.#deps.getTerminalRows?.();
		// Rows the fullscreen frame may fill; unknown: a fixed list height.
		// Below the list's own minimum the title goes, so the selected row
		// stays on screen.
		const room =
			rows !== undefined && Number.isFinite(rows) && rows > 0
				? Math.floor(rows) - LIST_CHROME_ROWS
				: undefined;
		const titled = room === undefined || room - TITLE_ROWS >= MIN_VISIBLE_ROWS;
		this.#list.setMaxVisible(
			room === undefined
				? DEFAULT_VISIBLE_ROWS
				: Math.max(MIN_VISIBLE_ROWS, titled ? room - TITLE_ROWS : room),
		);
		const list = this.#list.render(width);
		const frame = titled
			? [truncateToWidth(this.#host.theme().bold(TITLE), width), "", ...list]
			: list;
		// The list never draws fewer than its minimum viewport plus its
		// chrome. On a terminal shorter than that the rows below the viewport
		// (help, search, hint) go, so the selected row stays on screen rather
		// than scrolling off the top.
		return rows !== undefined && room !== undefined && frame.length > rows
			? frame.slice(0, Math.floor(rows))
			: frame;
	}

	/**
	 * Tern's native view. A terminal that draws native settings pages gets
	 * one (`prefs`: switches, segmented choices, a text field for the chord,
	 * one page per section); any other gets the title over the list.
	 */
	describe(cx: DescribeContext): NativeNode {
		if (cx.supports("prefs")) return this.#describePrefs();
		this.#native ??= col([text([span(TITLE, "strong")]), this.#list], {
			gap: "sm",
		});
		return this.#native;
	}

	/** Over a live session the native page is its own sheet, as omp's `/settings` is. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("prefs") && cx.feature("aside");
	}

	/** The page the native view shows: the section of the focused row. */
	#page: SectionId = "general";
	#prefs?: { signature: string; children: NativeChild[]; node: NativeNode };

	#describePrefs(): NativeNode {
		const items = this.#items();
		const sectionOf = sectionsOf(items);
		const query = this.#list.getSearchQuery();
		const searching = query.length > 0;
		const focusRow = this.#list.prefsFocus().row;
		const focusSection = focusRow ? sectionOf.get(focusRow) : undefined;
		// A search lists every section; the page stays the one it started on.
		if (focusSection && !searching) this.#page = focusSection;

		// The section comes from the full item list: a filtered list carries
		// no headings, so the heading above a search result is not its own.
		const all = this.#list.prefsSections(
			(item) => {
				const id = sectionOf.get(item.id) ?? "general";
				const title = sectionTitle(id);
				return searching ? { id, title, page: id } : { id, title };
			},
			(item) => this.#prefsControl(item),
		);
		const sections: TspPrefsSection[] = (
			searching ? all : all.filter((section) => section.id === this.#page)
		).map((section) =>
			section.id === "tools"
				? { ...section, rows: section.rows.map(withoutHint) }
				: section,
		);

		const editing = this.#list.prefsEditing(() => true);
		const children: NativeChild[] = [];
		const open = this.#list.openSubmenu;
		// A chord the field refused shows its error in the field itself.
		if (open && !editing) {
			children.push(col([open.component], { role: PREFS_EDITOR_ROLE }));
		}

		const listed = new Set(sectionOf.values());
		const changed = new Map<SectionId, number>();
		for (const item of items) {
			const section = sectionOf.get(item.id);
			if (item.changed && section) {
				changed.set(section, (changed.get(section) ?? 0) + 1);
			}
		}
		const props: TspPrefsProps = {
			title: "OMP Compact",
			pages: SECTIONS.filter(({ id }) => listed.has(id)).map(
				({ id, title, icon }) => ({
					id,
					label: title,
					icon,
					changed: changed.get(id),
				}),
			),
			page: this.#page,
			lead: searching
				? undefined
				: SECTIONS.find((section) => section.id === this.#page)?.lead,
			query: searching ? query : undefined,
			cursor: searching ? query.length : undefined,
			sections,
			focus: focusRow ?? null,
			editing,
		};
		const signature = JSON.stringify(props);
		const cached = this.#prefs;
		if (
			cached?.signature === signature &&
			cached.children.length === children.length &&
			cached.children.every((child, index) => child === children[index])
		) {
			return cached.node;
		}
		const root = node("prefs", props, children);
		this.#prefs = { signature, children, node: root };
		return root;
	}

	/** A row's native control: a switch, a segmented choice, or the chord's text field. */
	#prefsControl(item: SettingItem): TspPrefsControl | undefined {
		const value = String(item.currentValue ?? "");
		if (item.id === "displayCycleKey") return { k: "text", value, mono: true };
		if (item.values === BOOLEAN_VALUES)
			return { k: "switch", on: value === "true" };
		if (item.values === undefined) return undefined;
		return {
			k: "choice",
			value,
			options: item.values.map((option) => ({ value: option, label: option })),
			style: "segmented",
			mono: true,
		};
	}

	/**
	 * The value a row resets to: its value in the rows the defaults draw, so
	 * a row added to `#items` needs no second table here.
	 */
	#defaultValue(id: string): string | undefined {
		const item = this.#items(DEFAULT_SETTINGS).find(
			(candidate) => candidate.id === id && !candidate.heading,
		);
		return item === undefined ? undefined : String(item.currentValue);
	}

	/**
	 * Pointer actions on the native page, each through the path the keys
	 * take: a page click shows that section (leaving a search), a row click
	 * selects it, a switch or choice applies its value, a typed chord goes
	 * through the chord field's checks, and a reset applies the default.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#closing || event.key !== "") return;
		const list = this.#list;
		switch (event.type) {
			case "action":
				if (event.act === "page" && event.value) {
					this.#showPage(event.value);
				} else if (event.act === "close") {
					if (event.value === undefined) this.#close();
					else if (list.openSubmenu?.id === event.value)
						list.handleInput(ESCAPE);
				} else if (event.act === "edit" && event.value) {
					list.openSubmenuFor(event.value);
				}
				return;
			case "select":
				if (list.openSubmenu) list.handleInput(ESCAPE);
				list.selectItem(event.item);
				return;
			case "activate":
				list.openSubmenuFor(event.item);
				return;
			case "change":
				this.#applyNativeChange(event.item, event.value);
				return;
		}
	}

	#showPage(id: string): void {
		const items = this.#items();
		const sectionOf = sectionsOf(items);
		const first = items.find((item) => sectionOf.get(item.id) === id);
		// A page without rows (no tools listed) is not one the view offers.
		if (!first) return;
		this.#list.clearSearch();
		this.#page = sectionOf.get(first.id) ?? this.#page;
		this.#list.selectItem(first.id);
	}

	#applyNativeChange(
		id: string,
		value: boolean | number | string | readonly string[] | null,
	): void {
		const list = this.#list;
		if (value === null) {
			if (list.openSubmenu) list.handleInput(ESCAPE);
			const reset = this.#defaultValue(id);
			if (reset === undefined || !list.selectItem(id)) return;
			// The default chord passes the same checks a typed one does: it
			// may be held by another extension.
			if (id === "displayCycleKey") this.#submitChord(reset);
			else this.#change(id, reset);
			return;
		}
		if (id === "displayCycleKey") {
			if (typeof value === "string") this.#submitChord(value);
			return;
		}
		if (typeof value === "boolean" || typeof value === "string") {
			list.applyValue(id, String(value));
		}
	}

	/** Enter a chord through the chord field, so its checks decide. */
	#submitChord(chord: string): void {
		const field = this.#list.openSubmenuFor("displayCycleKey");
		if (field instanceof TextFormField) {
			field.setValue(chord);
			field.submit();
		}
	}

	invalidate(): void {
		this.#list.invalidate();
	}
}

const ESCAPE = "\x1b";

/** The section a heading item opens; `general` when there is none. */
function sectionIdOf(head: SettingItem | undefined): SectionId {
	const id = head?.id.slice(HEADING_PREFIX.length);
	return SECTIONS.find((section) => section.id === id)?.id ?? "general";
}

/** The section of every row: the heading above it. One pass over the rows. */
function sectionsOf(items: readonly SettingItem[]): Map<string, SectionId> {
	const sections = new Map<string, SectionId>();
	let section: SectionId | undefined;
	for (const item of items) {
		if (item.heading) section = sectionIdOf(item);
		else if (section !== undefined) sections.set(item.id, section);
	}
	return sections;
}

function withoutHint(row: TspPrefsRow): TspPrefsRow {
	const { hint: _, ...rest } = row;
	return rest;
}

/**
 * Open the settings dialog through `ui.custom`. When the UI surface is
 * unavailable (headless/RPC), warns and resolves `undefined` without throwing.
 */
export function openSettingsDialog(
	ui: SettingsUiLike,
	deps: Omit<SettingsDialogDeps, "getTerminalRows" | "requestRender">,
): Promise<CompactSettings | undefined> {
	if (typeof ui?.custom !== "function") {
		deps.warn(
			"omp-compact: interactive settings UI unavailable; nothing was changed",
		);
		return Promise.resolve(undefined);
	}
	const host = settingsDialogHost;
	if (!host) {
		deps.warn(
			"omp-compact: /compact-settings is off because this omp lacks the settings-list helpers it draws with; edit the config file instead",
		);
		return Promise.resolve(undefined);
	}
	return ui.custom<CompactSettings | undefined>(
		(tui, _theme, _keybindings, done) =>
			new SettingsDialog(
				{
					...deps,
					// TUI.terminal.rows is a live getter: the dialog learns the
					// current height at each render, no resize hooks needed.
					getTerminalRows: () => tui?.terminal?.rows,
					requestRender: () => tui?.requestRender?.(),
				},
				done,
				host,
			),
		// The path omp's own `/settings` takes: a fullscreen overlay. In Tern
		// that makes the page a sheet of fixed size; in the editor's place it
		// was sized to the open page and changed height with every page.
		{ overlay: true, overlayOptions: FULLSCREEN },
	);
}

const FULLSCREEN: OverlayOptions = {
	anchor: "bottom-center",
	width: "100%",
	maxHeight: "100%",
	margin: 0,
	fullscreen: true,
};

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
