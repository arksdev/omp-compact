import {
	MAX_THRESHOLD_TOKENS,
	type CompactHostSettings,
	type CompactMode,
	type CompactSettings,
	type CompactSettingsPatch,
	type CompactSettingsStore,
	type CompactStatsSettings,
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
 * Count code points rather than UTF-16 units: `.length`/`slice` split
 * surrogate pairs, corrupting astral characters at truncation boundaries.
 * Code points (not wcwidth cells) match the plugin's character-budget
 * display convention; full cell-width fitting stays with pi-tui's
 * `truncateToWidth`.
 */
function codePointLength(value: string): number {
	let length = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.codePointAt(index);
		if (code !== undefined && code > 0xffff) index++;
		length++;
	}
	return length;
}

/**
 * Truncate text to `width` visible columns while keeping ANSI SGR sequences
 * intact and never splitting surrogate pairs. If the cut lands inside styled
 * text, a reset is appended so color never leaks onto subsequent lines.
 */
export function truncateAnsiSafe(text: string, width: number): string {
	if (width <= 0) return "\x1b[0m";
	if (codePointLength(stripAnsi(text)) <= width) return text;
	let out = "";
	let visible = 0;
	let i = 0;
	while (i < text.length && visible < width) {
		const code = text.codePointAt(i) ?? 0;
		if (code === 0x1b) {
			const sequence = ANSI_SGR_PREFIX_RE.exec(text.slice(i));
			if (sequence) {
				out += sequence[0];
				i += sequence[0].length;
				continue;
			}
		}
		out += String.fromCodePoint(code);
		visible++;
		i += code > 0xffff ? 2 : 1;
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
	 * Persist host-facing toggles (set + flush) and return the outcome with
	 * a one-shot compensating rollback that restores the exact raw
	 * persistent pre-image of the changed host paths — never effective
	 * values, which project/runtime overrides can mask.
	 */
	apply(host: CompactHostSettings): Promise<HostBridgeApplyResult>;
}

/**
 * Structural slice of the real bridge's apply outcome: the restart
 * requirement plus a one-shot `rollback()` that restores the exact raw
 * persistent pre-image of the changed host paths (present -> raw value,
 * absent -> key removed) and flushes. No-op when the apply changed nothing;
 * throws when the restore itself cannot be persisted.
 */
export interface HostBridgeApplyResult {
	restartRequired: boolean;
	rollback(): Promise<void>;
}

export interface SaveFlowDeps {
	/** Optional host bridge; omitted when the host config surface is absent. */
	bridge?: HostBridgeLike;
	store: CompactSettingsStore;
	notify?(level: "info" | "warning", message: string): void;
}

/**
 * Per-target serialization of save flows, modeled on `withUpdateQueue` in
 * config.ts: overlapping saves on one target run strictly in order, each
 * seeing the actual state after the previous save settled — including a
 * failed save's compensating rollback, which runs inside ITS queue turn.
 * Without this, two overlapping saves could interleave: the host bridge
 * coalesces concurrent applies (silently dropping the second payload), and
 * a failing save's rollback restores a pre-image that predates the other
 * save's already-successful write.
 *
 * Keyed by the store identity: the store is the per-plugin-instance save
 * pipeline, and each flow couples exactly one host apply to one store
 * update, so serializing per store also serializes the shared host config
 * target (two dialogs build their own bridge but share the store).
 */
const saveFlowQueues = new Map<CompactSettingsStore, Promise<void>>();

async function withSaveFlowQueue<T>(
	store: CompactSettingsStore,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = saveFlowQueues.get(store) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.catch(() => undefined).then(() => current);
	saveFlowQueues.set(store, tail);
	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		release();
		// Only the last queued operation cleans up the entry; earlier
		// operations find a newer tail and correctly skip the delete.
		if (saveFlowQueues.get(store) === tail) saveFlowQueues.delete(store);
	}
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
 *   2. store.update (throws => compensating rollback invokes the apply
 *      result's one-shot rollback, restoring the exact raw persistent
 *      pre-image of the changed host paths — never effective values, which
 *      overrides can mask — so the host side never diverges from the
 *      unchanged plugin JSON; then the original error is rethrown: no
 *      notify, no false success)
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
 *
 * Overlapping calls serialize per target (see {@link saveFlowQueues}): each
 * save runs to completion — bridge apply, JSON persist, and on failure its
 * compensating rollback — before the next one starts, so no call silently
 * loses its arguments to the bridge's concurrent-apply coalescing and a
 * failed save's rollback never restores a state that predates a newer
 * save's successful write.
 */
export async function saveSettingsFlow(
	next: CompactSettings,
	deps: SaveFlowDeps,
): Promise<SaveOutcome> {
	return withSaveFlowQueue(deps.store, () => runSaveSettingsFlow(next, deps));
}

async function runSaveSettingsFlow(
	next: CompactSettings,
	deps: SaveFlowDeps,
): Promise<SaveOutcome> {
	let restartRequired = false;
	let rollbackHost: (() => Promise<void>) | undefined;
	if (deps.bridge) {
		const result = await deps.bridge.apply(next.host);
		restartRequired = result.restartRequired === true;
		// Keep the compensating rollback tied to THIS save: it restores the
		// exact raw persistent pre-image the bridge captured before mutating
		// host config (see context/host-settings-rollback.md) — never
		// effective read() values, which overrides can mask.
		rollbackHost = result.rollback;
	}
	let effective: CompactSettings;
	try {
		effective = await deps.store.update(next);
	} catch (cause) {
		// Compensating rollback: the host bridge already applied AND flushed
		// the new host values, but the plugin JSON persist failed — the two
		// would diverge. Restore the host side through the apply result's
		// one-shot rollback (raw persistent pre-image + flush), then surface
		// the original save error.
		if (rollbackHost) {
			await rollbackHostAfterFailedSave(rollbackHost, cause, deps.notify);
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
 * invokes the apply result's one-shot rollback (restores the exact raw
 * persistent pre-image of the changed host paths and flushes). When the
 * rollback itself fails, warns honestly through notify() and lets the
 * original save error surface — mirroring the bridge's own rollback-failure
 * warn-once pattern (host-settings.ts).
 */
async function rollbackHostAfterFailedSave(
	rollback: () => Promise<void>,
	cause: unknown,
	notify?: SaveFlowDeps["notify"],
): Promise<void> {
	try {
		await rollback();
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
		if (value > MAX_THRESHOLD_TOKENS) {
			this.error = `threshold exceeds max ${MAX_THRESHOLD_TOKENS}`;
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
		// comment on every row. Editing shows its own key hints instead.
		const help = this.editing
			? "digits edit · enter ok · esc cancel"
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

// Re-exported for the store consumers that only need the patch type.
export type { CompactSettingsPatch, CompactSettingsStore };
