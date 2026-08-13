import type {
	CompactHostSettings,
	CompactMode,
	CompactSettings,
	CompactSettingsPatch,
	CompactSettingsStore,
	CompactStatsSettings,
} from "./config";

// =============================================================================
// Key codes (raw terminal input data)
// =============================================================================

export const KEY_UP = "\u001b[A";
export const KEY_DOWN = "\u001b[B";
export const KEY_RIGHT = "\u001b[C";
export const KEY_LEFT = "\u001b[D";
export const KEY_ENTER = "\r";
export const KEY_ESCAPE = "\u001b";
export const KEY_SPACE = " ";
export const KEY_BACKSPACE = "\u007f";
export const KEY_CTRL_C = "\u0003";

// =============================================================================
// Structural host types (no runtime dependency on the host packages)
// =============================================================================

export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic?(text: string): string;
	underline?(text: string): string;
}

export interface KeybindingsLike {
	matches(data: string, action: string): boolean;
}

export interface ComponentLike {
	render(width: number): readonly string[];
	handleInput?(data: string): void;
	invalidate?(): void;
	dispose?(): void;
}

export interface SettingsUiLike {
	custom<T>(
		factory: (
			tui: unknown,
			theme: ThemeLike,
			keybindings: KeybindingsLike,
			done: (result: T) => void,
		) => ComponentLike | Promise<ComponentLike>,
	): Promise<T>;
}

export interface CommandApiLike<Ctx> {
	getCommands(): readonly { name: string }[];
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: Ctx) => Promise<void>;
		},
	): void;
}

// =============================================================================
// ANSI-safe width utilities
// =============================================================================

const ESCAPE = String.fromCharCode(27);
const ANSI_SGR_RE = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");
const ANSI_SGR_PREFIX_RE = new RegExp(`^${ESCAPE}\\[[0-9;]*m`);

/**
 * Strip ANSI SGR sequences. Third variant (render.ts and git-records.ts
 * have others); this one is the simplest regex-only version.
 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_SGR_RE, "");
}

/**
 * Truncate text to `width` visible columns while keeping ANSI SGR sequences
 * intact. If the cut lands inside styled text, a reset is appended so color
 * never leaks onto subsequent lines.
 */
export function truncateAnsiSafe(text: string, width: number): string {
	if (width <= 0) return "\x1b[0m";
	if (stripAnsi(text).length <= width) return text;
	let out = "";
	let visible = 0;
	let i = 0;
	while (i < text.length && visible < width) {
		const ch = text[i];
		if (ch === "\u001b") {
			const sequence = ANSI_SGR_PREFIX_RE.exec(text.slice(i));
			if (sequence) {
				out += sequence[0];
				i += sequence[0].length;
				continue;
			}
		}
		out += ch;
		visible++;
		i++;
	}
	return `${out}\x1b[0m`;
}

// =============================================================================
// Command registration
// =============================================================================

const PREFERRED_COMMAND = "compact-settings";
const FALLBACK_COMMAND = "omp-compact-settings";
const MAX_NUMBERED_FALLBACK = 99;

/**
 * Pick the settings command name, avoiding occupied names: the preferred
 * `compact-settings`, else `omp-compact-settings`, else a deterministic
 * numbered `omp-compact-settings-N` (N from 2). Always returns a usable name
 * (last-resort highest number) rather than throwing.
 * When all 99 numbered fallbacks are occupied, returns the highest number
 * as a last resort rather than throwing.
 */
export function chooseSettingsCommandName(
	registered: readonly string[],
): string {
	if (!registered.includes(PREFERRED_COMMAND)) return PREFERRED_COMMAND;
	if (!registered.includes(FALLBACK_COMMAND)) return FALLBACK_COMMAND;
	for (let n = 2; n <= MAX_NUMBERED_FALLBACK; n++) {
		const candidate = `${FALLBACK_COMMAND}-${n}`;
		if (!registered.includes(candidate)) return candidate;
	}
	return `${FALLBACK_COMMAND}-${MAX_NUMBERED_FALLBACK}`;
}

/**
 * Register the settings command. Runs unconditionally — the command must stay
 * available even when the plugin runtime is globally disabled.
 */
export function registerSettingsCommand<Ctx>(
	pi: CommandApiLike<Ctx>,
	options: {
		description: string;
		handler: (args: string, ctx: Ctx) => Promise<void>;
	},
): string {
	let names: readonly string[] = [];
	try {
		names = pi.getCommands().map((command) => command.name);
	} catch {
		// getCommands unavailable (extension runtime not ready): proceed with
		// the preferred name and let the runtime surface a conflict if any.
		names = [];
	}
	const name = chooseSettingsCommandName(names);
	pi.registerCommand(name, options);
	return name;
}

// =============================================================================
// Save flow: host bridge apply -> JSON persist -> optional reload
// =============================================================================

/** Host-configuration bridge seam (wired by HostSettingsBridge's slice). */
export interface HostBridgeLike {
	/**
	 * Live host values before a save. The save flow captures this pre-image
	 * before applying so a failed plugin-JSON persist can restore the exact
	 * pre-save values (the real bridge's read never writes).
	 */
	read(): CompactHostSettings;
	apply(host: CompactHostSettings): Promise<{ restartRequired: boolean }>;
}

export interface SaveFlowDeps {
	/** Optional host bridge; omitted when the host config surface is absent. */
	bridge?: HostBridgeLike;
	store: CompactSettingsStore;
	notify?(level: "info" | "warning", message: string): void;
}

/**
 * One persisted setting that a hard env override currently masks: the JSON
 * carries the requested value, but `effective` stays in force instead.
 */
export interface EnvMask {
	/** The persisted setting field that cannot take effect. */
	field: "enabled" | "mode";
	/** The value that stays in effect instead of the persisted one. */
	effective: boolean | CompactMode;
	/** Env variables forcing the field (both when enabled is double-masked). */
	by: ReadonlyArray<"OMP_COMPACT_PLUGIN" | "OMP_COMPACT_MODE">;
}

/**
 * Structured outcome of a settings save: what was persisted versus what
 * actually takes effect. Consumers compose their own presentation from the
 * facts; `masks` is empty for an unmasked save.
 */
export interface SaveOutcome {
	/** The settings now on disk (the requested values; env is never baked in). */
	persisted: CompactSettings;
	/** The effective snapshot with hard env overrides reapplied. */
	effective: CompactSettings;
	/** Host bridge restart requirement. */
	restartRequired: boolean;
	/** True when a hard env override masks a persisted enabled/mode value. */
	masked: boolean;
	/** Per-field mask facts; empty when nothing is masked. */
	masks: ReadonlyArray<EnvMask>;
}

/**
 * Persist a settings save with strict ordering:
 *   1. host bridge apply (throws => store untouched, no success)
 *   2. store.update (throws => compensating rollback re-applies the pre-save
 *      host values through the bridge — persistent AND in-memory — so the
 *      host side never diverges from the unchanged plugin JSON; then the
 *      original error is rethrown: no notify, no false success)
 *   3. exactly one success notification through notify(): the plain
 *      `omp-compact settings saved` for an unmasked save, or a single
 *      message carrying both facts (saved + effective) when a hard env
 *      override masks the just-persisted enabled/mode — never a separate
 *      warning plus a generic success
 *   4. when the host bridge reports restartRequired, notify honestly that a
 *      restart of OMP is required — no session reload is ever invoked
 *      (thinking visibility has no safe live refresh in stock).
 * Throws when either phase fails so the caller (dialog) surfaces the error
 * and keeps its unsaved state. Returns the structured persisted-versus-
 * effective outcome.
 */
export async function saveSettingsFlow(
	next: CompactSettings,
	deps: SaveFlowDeps,
): Promise<SaveOutcome> {
	let restartRequired = false;
	let previousHost: CompactHostSettings | undefined;
	if (deps.bridge) {
		// Capture the pre-save host values BEFORE any mutation: a failed
		// plugin-JSON persist must restore exactly these (persistent +
		// in-memory), never a stale mirror.
		previousHost = deps.bridge.read();
		const result = await deps.bridge.apply(next.host);
		restartRequired = result.restartRequired === true;
	}
	let effective: CompactSettings;
	try {
		effective = await deps.store.update(next);
	} catch (cause) {
		// Compensating rollback: the host bridge already applied AND flushed
		// the new host values, but the plugin JSON persist failed — the two
		// would diverge. Restore the pre-save values through the same bridge
		// apply (set + flush) so persistent and in-memory host state match
		// the unchanged plugin JSON, then surface the original save error.
		if (deps.bridge && previousHost !== undefined) {
			await restoreHostAfterFailedSave(
				deps.bridge,
				previousHost,
				cause,
				deps.notify,
			);
		}
		throw cause;
	}
	const masks = maskedByEnv(deps.store, next, effective);
	const masked = masks.length > 0;
	deps.notify?.(
		"info",
		masked ? maskedSaveMessage(masks) : "omp-compact settings saved",
	);
	if (restartRequired) {
		deps.notify?.("info", "Thinking blocks take effect after restarting OMP");
	}
	return { persisted: next, effective, restartRequired, masked, masks };
}

/**
 * Best-effort compensating rollback after a failed plugin-JSON persist:
 * re-applies the pre-save host values through the bridge (set + flush), so
 * persistent and in-memory host settings match the unchanged JSON. When the
 * rollback itself fails, warns honestly through notify() and lets the
 * original save error surface — mirroring the bridge's own rollback-failure
 * warn-once pattern (host-settings.ts).
 */
async function restoreHostAfterFailedSave(
	bridge: HostBridgeLike,
	previous: CompactHostSettings,
	cause: unknown,
	notify?: SaveFlowDeps["notify"],
): Promise<void> {
	try {
		await bridge.apply(previous);
	} catch (rollbackCause) {
		notify?.(
			"warning",
			`Host settings could not be restored after the save failed (${cause instanceof Error ? cause.message : String(cause)}): ${rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)}`,
		);
	}
}

/**
 * Per-field env masks for the requested `enabled`/`mode` values on disk.
 * The store persists the requested values and returns the effective snapshot
 * with hard env overrides reapplied, so a difference in `enabled`/`mode`
 * means the saved JSON is currently overridden. Only the variables the store
 * reports as active are named — never inferred from the diff alone.
 */
function maskedByEnv(
	store: CompactSettingsStore,
	requested: CompactSettings,
	effective: CompactSettings,
): EnvMask[] {
	const masks: EnvMask[] = [];
	const overrides = store.overrides?.();
	if (requested.enabled !== effective.enabled) {
		const enabledBy = overrides?.enabledBy ?? [];
		if (enabledBy.length > 0) {
			masks.push({
				field: "enabled",
				effective: effective.enabled,
				by: [...enabledBy],
			});
		}
	}
	if (requested.mode !== effective.mode && overrides?.modeBy !== undefined) {
		masks.push({
			field: "mode",
			effective: effective.mode,
			by: [overrides.modeBy],
		});
	}
	return masks;
}

/**
 * One unambiguous success notification for a masked save: the plain success
 * line plus, per masked field, the effective value that stays in force and
 * the env variable(s) forcing it — the user is never left with a generic
 * success implying the saved value took effect. Values render as the env
 * contract names them (`OMP_COMPACT_PLUGIN=0`, legacy `OMP_COMPACT_MODE=off`,
 * and `OMP_COMPACT_MODE=<effective mode>`).
 */
function maskedSaveMessage(masks: readonly EnvMask[]): string {
	const facts = masks.map((mask) => {
		const value =
			mask.field === "enabled"
				? mask.effective
					? "true"
					: "false"
				: String(mask.effective);
		const by = mask.by
			.map((name) => {
				if (name === "OMP_COMPACT_PLUGIN") return "OMP_COMPACT_PLUGIN=0";
				if (mask.field === "enabled") return "OMP_COMPACT_MODE=off";
				return `OMP_COMPACT_MODE=${value}`;
			})
			.join(" / ");
		return `effective ${mask.field} remains ${value} because ${by}`;
	});
	return `omp-compact settings saved; ${facts.join("; ")}`;
}

// =============================================================================
// Settings dialog
// =============================================================================

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
}

const MODES: readonly CompactMode[] = ["compact", "live", "clear"];
const MAX_EDIT_DIGITS = 10;

// Row groups: one blank line separates the logical menu sections
// (global, display, auto-shake, stats, host) — restrained separation only.
const GROUP_GLOBAL = 0;
const GROUP_DISPLAY = 1;
const GROUP_SHAKE = 2;
const GROUP_STATS = 3;
const GROUP_HOST = 4;

interface Row {
	id: string;
	kind: "toggle" | "cycle" | "number";
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
	private cursor = 0;
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

	private focusedRow(): Row | undefined {
		const rows = this.focusableRows();
		if (rows.length === 0) return undefined;
		return rows[this.cursor % rows.length];
	}

	private move(delta: number): void {
		const rows = this.focusableRows();
		if (rows.length === 0) return;
		this.cursor = (this.cursor + delta + rows.length) % rows.length;
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
		} else {
			this.editing = true;
			this.editBuffer = String(row.get());
			this.error = "";
		}
	}

	private handleEditing(data: string): void {
		if (data >= "0" && data <= "9") {
			if (this.editBuffer.length < MAX_EDIT_DIGITS) {
				this.editBuffer += data;
			}
			return;
		}
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
		}
	}

	private commitEdit(): void {
		const value = Number.parseInt(this.editBuffer, 10);
		if (!Number.isInteger(value) || value < 0) {
			this.error = "threshold must be a non-negative integer";
			return;
		}
		if (value > 10_000_000) {
			this.error = "threshold exceeds max 10000000";
			return;
		}
		const row = this.focusedRow();
		row?.set(value);
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
		this.saving = true;
		this.pending = this.pending.then(async () => {
			try {
				await this.deps.onSave(this.draft);
				this.saving = false;
				this.emitHostChanges();
				this.finish(this.draft);
			} catch (error) {
				this.saving = false;
				const message = error instanceof Error ? error.message : String(error);
				this.error = message;
				this.deps.warn?.(message);
			}
		});
	}

	private emitHostChanges(): void {
		// Host rows must never claim success when unavailable: with no live
		// host settings instance there is nothing to report.
		if (!this.hostAvailable) return;
		const before = this.initial.host;
		const after = this.draft.host;
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
			case KEY_UP:
			case "k":
				this.move(-1);
				return;
			case KEY_DOWN:
			case "j":
				this.move(1);
				return;
			case KEY_LEFT:
				if (this.focusedRow()?.kind === "cycle") {
					this.cycle(-1);
				} else {
					this.move(-1);
				}
				return;
			case KEY_RIGHT:
				if (this.focusedRow()?.kind === "cycle") {
					this.cycle(1);
				} else {
					this.move(1);
				}
				return;
			case KEY_SPACE:
			case KEY_ENTER:
				this.activate();
				return;
		}
	}

	render(width: number): readonly string[] {
		const theme = this.deps.theme;
		const rows = this.buildRows();
		const focusable = rows.filter((row) => row.focusable);
		const focusedId =
			focusable[this.cursor % Math.max(focusable.length, 1)]?.id;

		const lines: string[] = [];
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
			lines.push(`${marker}${label}  ${value}`);
		}

		if (this.error) {
			lines.push(theme.fg("error", this.error));
		}
		// One contextual dim help line for the focused setting — never a
		// comment on every row. Editing shows its own key hints instead.
		const help = this.editing
			? "digits edit · enter ok · esc cancel"
			: `${ROW_HELP[focusedId ?? ""] ?? ""} · ↑↓ move · s save · esc cancel${
					this.isDirty ? " · unsaved" : ""
				}`;
		lines.push(theme.fg("muted", help));

		return lines.map((line) => truncateAnsiSafe(line, width));
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
		(_tui, theme, keybindings, done) =>
			new SettingsDialog({ ...deps, theme, keybindings }, done),
	);
}

// Re-exported for the store consumers that only need the patch type.
export type { CompactSettingsPatch, CompactSettingsStore };
