import {
	type Component,
	col,
	type DescribeContext,
	type NativeNode,
	type SettingItem,
	SettingsList,
	span,
	TextFormField,
	text,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { formTheme } from "@oh-my-pi/pi-tui/chrome/form-theme";
import {
	editorKey,
	editorKeys,
} from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { formatKeyHint } from "@oh-my-pi/pi-tui/key-hint-format";
import { getSettingsListTheme, theme } from "@oh-my-pi/pi-tui/theme/theme";

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
/**
 * Rows omp keeps on screen below a `ui.custom` component: its status line.
 * omp shows the bottom of a frame taller than the screen, so a frame that
 * left no room for it would lose its title off the top.
 */
const HOST_ROWS = 1;
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

function heading(id: string, label: string): SettingItem {
	return { id, label, currentValue: "", heading: true };
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

	constructor(
		deps: SettingsDialogDeps,
		done: (result: CompactSettings | undefined) => void,
	) {
		this.#deps = deps;
		this.#done = done;
		this.#saved = deps.settings;
		this.#list = new SettingsList(
			this.#items(),
			DEFAULT_VISIBLE_ROWS,
			getSettingsListTheme(),
			(id, value) => this.#change(id, value),
			() => this.#close(),
			{
				layout: "auto",
				hint: `${editorKey("tui.select.confirm")}/${formatKeyHint("space")} to change · ${editorKeys("tui.select.pageUp", "tui.select.pageDown")} to jump sections · Type to search · ${editorKey("tui.select.cancel")} to close`,
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

	#items(): SettingItem[] {
		const shown = this.#shown();
		const items: SettingItem[] = [
			heading("section.general", "General"),
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
			heading("section.display", "Display"),
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
			heading("section.statistics", "Statistics"),
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
			items.push(heading("section.tools", "Tool cards"));
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
		return new TextFormField({
			theme: formTheme,
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
			hint: `  ${editorKey("tui.input.submit")} to save · ${editorKey("tui.select.cancel")} to go back`,
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
		// Rows the frame may fill above omp's status line; unknown: a fixed
		// list height. Below the list's own minimum the title goes, so the
		// selected row stays on screen.
		const room =
			rows !== undefined && Number.isFinite(rows) && rows > 0
				? Math.floor(rows) - HOST_ROWS - LIST_CHROME_ROWS
				: undefined;
		const titled = room === undefined || room - TITLE_ROWS >= MIN_VISIBLE_ROWS;
		this.#list.setMaxVisible(
			room === undefined
				? DEFAULT_VISIBLE_ROWS
				: Math.max(MIN_VISIBLE_ROWS, titled ? room - TITLE_ROWS : room),
		);
		const list = this.#list.render(width);
		return titled
			? [truncateToWidth(theme.bold(TITLE), width), "", ...list]
			: list;
	}

	/** Tern's native view: the title over the list, which handles its own events. */
	describe(_cx: DescribeContext): NativeNode {
		this.#native ??= col([text([span(TITLE, "strong")]), this.#list], {
			gap: "sm",
		});
		return this.#native;
	}

	invalidate(): void {
		this.#list.invalidate();
	}
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
			),
	);
}

export interface SettingsSessionDeps {
	store: CompactSettingsStore;
	/** Names of the tools omp reports, listed under "Tool cards". */
	toolNames: Iterable<string>;
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
		notifySaveOutcome(last, opened, deps.notify);
	}
}
