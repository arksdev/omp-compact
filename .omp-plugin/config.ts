import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type CompactMode = "compact" | "live" | "clear";

export interface CompactStatsSettings {
	enabled: boolean;
	actions: boolean;
	sent: boolean;
	received: boolean;
	cache: boolean;
	time: boolean;
}

export interface CompactAutoShakeSettings {
	enabled: boolean;
	thresholdTokens: number;
}

export interface CompactHostSettings {
	recapEnabled?: boolean;
	thinkingBlocksVisible?: boolean;
}

export interface CompactSettings {
	version: 1;
	enabled: boolean;
	mode: CompactMode;
	retainGitLive: boolean;
	compactPaths: boolean;
	stats: CompactStatsSettings;
	autoShake: CompactAutoShakeSettings;
	host: CompactHostSettings;
}

export interface CompactSettingsPatch {
	enabled?: boolean;
	mode?: CompactMode;
	retainGitLive?: boolean;
	compactPaths?: boolean;
	stats?: Partial<CompactStatsSettings>;
	autoShake?: Partial<CompactAutoShakeSettings>;
	host?: Partial<CompactHostSettings>;
}

export type EnvLike = Record<string, string | undefined>;

export const MAX_CONFIG_BYTES = 65_536;
export const MAX_CONFIG_DEPTH = 16;
export const MAX_THRESHOLD_TOKENS = 10_000_000;

const DEFAULT_STATS: CompactStatsSettings = Object.freeze({
	enabled: true,
	actions: true,
	sent: true,
	received: true,
	cache: true,
	time: true,
});

const DEFAULT_AUTO_SHAKE: CompactAutoShakeSettings = Object.freeze({
	enabled: false,
	thresholdTokens: 120_000,
});

const DEFAULT_HOST: CompactHostSettings = Object.freeze({
	recapEnabled: true,
	thinkingBlocksVisible: true,
});

export const DEFAULT_SETTINGS: CompactSettings = Object.freeze({
	version: 1,
	enabled: true,
	mode: "live",
	retainGitLive: true,
	compactPaths: true,
	stats: DEFAULT_STATS,
	autoShake: DEFAULT_AUTO_SHAKE,
	host: DEFAULT_HOST,
});

function isCompactMode(value: unknown): value is CompactMode {
	return value === "compact" || value === "live" || value === "clear";
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteInteger(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		Number.isFinite(value)
	);
}

function cloneAndFreeze(settings: CompactSettings): CompactSettings {
	const clone: CompactSettings = {
		version: 1,
		enabled: settings.enabled,
		mode: settings.mode,
		retainGitLive: settings.retainGitLive,
		compactPaths: settings.compactPaths,
		stats: Object.freeze({ ...settings.stats }),
		autoShake: Object.freeze({ ...settings.autoShake }),
		host: Object.freeze({ ...settings.host }),
	};
	return Object.freeze(clone);
}

/**
 * Resolve the plugin config file path. Precedence:
 * `OMP_COMPACT_CONFIG` > `PI_CODING_AGENT_DIR/omp-compact/config.json` >
 * `~/<PI_CONFIG_DIR|.omp>[/profiles/<PI_PROFILE>]/agent/omp-compact/config.json`.
 */
export function resolveConfigPath(env: EnvLike): string {
	const explicit = env.OMP_COMPACT_CONFIG;
	if (explicit) return explicit;
	const agentDir = env.PI_CODING_AGENT_DIR;
	if (agentDir) return join(agentDir, "omp-compact", "config.json");
	const home = env.HOME ?? env.USERPROFILE ?? homedir();
	const configRoot = env.PI_CONFIG_DIR || ".omp";
	const profile = env.PI_PROFILE;
	const agentBase = profile
		? join(home, configRoot, "profiles", profile, "agent")
		: join(home, configRoot, "agent");
	return join(agentBase, "omp-compact", "config.json");
}

/** Parse JSON bounded by byte size and nesting depth. Returns undefined on violation. */
function parseBoundedJson(
	text: string,
	warn: (message: string) => void,
): unknown {
	if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
		warn(
			`config JSON is oversized (max ${MAX_CONFIG_BYTES} bytes); using defaults`,
		);
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "{" || ch === "[") {
			depth++;
			if (depth > MAX_CONFIG_DEPTH) {
				warn(
					`config JSON nesting depth exceeds ${MAX_CONFIG_DEPTH}; using defaults`,
				);
				return undefined;
			}
		} else if (ch === "}" || ch === "]") {
			depth--;
			if (depth < 0) {
				warn(
					"config JSON closes a structure before opening one; using defaults",
				);
				return undefined;
			}
		}
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		warn("config JSON is malformed; using defaults");
		return undefined;
	}
}

interface NormalizeResult {
	settings: CompactSettings;
	invalid: string[];
}

/**
 * Validate and normalize arbitrary JSON into `CompactSettings`, failing open
 * to defaults per field. Only version 1 is accepted; anything else yields
 * full defaults. `warn` receives one message when any field was rejected.
 */
export function normalizeSettings(
	raw: unknown,
	warn?: (message: string) => void,
): CompactSettings {
	return normalizeWithDiagnostics(raw, warn).settings;
}

function normalizeWithDiagnostics(
	raw: unknown,
	warn?: (message: string) => void,
): NormalizeResult {
	if (!isRecord(raw)) {
		warn?.("config is not a JSON object; using defaults");
		return { settings: DEFAULT_SETTINGS, invalid: ["root"] };
	}
	const version = raw.version;
	if (version !== undefined && version !== 1) {
		warn?.(`unsupported config version ${String(version)}; using defaults`);
		return { settings: DEFAULT_SETTINGS, invalid: ["version"] };
	}
	const invalid: string[] = [];
	const field = (name: string, value: unknown, fallback: boolean): boolean => {
		if (value === undefined) return fallback;
		if (isBoolean(value)) return value;
		invalid.push(name);
		return fallback;
	};
	const mode =
		raw.mode === undefined
			? DEFAULT_SETTINGS.mode
			: isCompactMode(raw.mode)
				? raw.mode
				: DEFAULT_SETTINGS.mode;
	if (raw.mode !== undefined && !isCompactMode(raw.mode)) {
		invalid.push("mode");
	}

	const settings: CompactSettings = {
		version: 1,
		enabled: field("enabled", raw.enabled, DEFAULT_SETTINGS.enabled),
		mode,
		retainGitLive: field(
			"retainGitLive",
			raw.retainGitLive,
			DEFAULT_SETTINGS.retainGitLive,
		),
		compactPaths: field(
			"compactPaths",
			raw.compactPaths,
			DEFAULT_SETTINGS.compactPaths,
		),
		stats: { ...DEFAULT_SETTINGS.stats },
		autoShake: { ...DEFAULT_SETTINGS.autoShake },
		host: { ...DEFAULT_SETTINGS.host },
	};

	if (isRecord(raw.stats)) {
		settings.stats = {
			enabled: field(
				"stats.enabled",
				raw.stats.enabled,
				settings.stats.enabled,
			),
			actions: field(
				"stats.actions",
				raw.stats.actions,
				settings.stats.actions,
			),
			sent: field("stats.sent", raw.stats.sent, settings.stats.sent),
			received: field(
				"stats.received",
				raw.stats.received,
				settings.stats.received,
			),
			cache: field("stats.cache", raw.stats.cache, settings.stats.cache),
			time: field("stats.time", raw.stats.time, settings.stats.time),
		};
	} else if (raw.stats !== undefined) {
		invalid.push("stats");
	}

	if (isRecord(raw.autoShake)) {
		const threshold = raw.autoShake.thresholdTokens;
		let thresholdTokens = settings.autoShake.thresholdTokens;
		if (threshold !== undefined) {
			if (
				isFiniteInteger(threshold) &&
				threshold >= 0 &&
				threshold <= MAX_THRESHOLD_TOKENS
			) {
				thresholdTokens = threshold;
			} else {
				invalid.push("autoShake.thresholdTokens");
			}
		}
		settings.autoShake = {
			enabled: field(
				"autoShake.enabled",
				raw.autoShake.enabled,
				settings.autoShake.enabled,
			),
			thresholdTokens,
		};
	} else if (raw.autoShake !== undefined) {
		invalid.push("autoShake");
	}

	if (isRecord(raw.host)) {
		const host: CompactHostSettings = {};
		if (raw.host.recapEnabled !== undefined) {
			if (isBoolean(raw.host.recapEnabled)) {
				host.recapEnabled = raw.host.recapEnabled;
			} else {
				invalid.push("host.recapEnabled");
			}
		}
		if (raw.host.thinkingBlocksVisible !== undefined) {
			if (isBoolean(raw.host.thinkingBlocksVisible)) {
				host.thinkingBlocksVisible = raw.host.thinkingBlocksVisible;
			} else {
				invalid.push("host.thinkingBlocksVisible");
			}
		}
		settings.host = host;
	} else if (raw.host !== undefined) {
		invalid.push("host");
	}

	if (invalid.length > 0) {
		warn?.(`invalid config field(s): ${invalid.join(", ")}; using defaults`);
	}
	return { settings, invalid };
}

// =============================================================================
// Bounded leaf-field patch (E02): concurrent stores with stale snapshots must
// not lose each other's distinct edits. `update()` derives a patch of ONLY
// the leaf fields that differ from this store's loaded snapshot, then applies
// it to a fresh bounded reread immediately before the atomic rename.
// =============================================================================

const TOP_LEVEL_FIELDS = [
	"enabled",
	"mode",
	"retainGitLive",
	"compactPaths",
] as const;

const STATS_FIELDS = [
	"enabled",
	"actions",
	"sent",
	"received",
	"cache",
	"time",
] as const;

const AUTO_SHAKE_FIELDS = ["enabled", "thresholdTokens"] as const;

const HOST_FIELDS = ["recapEnabled", "thinkingBlocksVisible"] as const;

/**
 * In-process update queue per config path. The persisted format remains an
 * ordinary atomic JSON file (no lock file or fsync); serializing writers in
 * this process closes the reread-to-rename race so disjoint stale patches
 * compose even when callers use `Promise.all`.
 */
const updateQueues = new Map<string, Promise<void>>();

async function withUpdateQueue<T>(
	path: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = updateQueues.get(path) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.catch(() => undefined).then(() => current);
	updateQueues.set(path, tail);
	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		release();
		if (updateQueues.get(path) === tail) updateQueues.delete(path);
	}
}

/**
 * The leaf fields an update actually changes. An explicit `undefined` entry
 * (host fields only) expresses removal: normalization drops absent host
 * keys, so `host: { recapEnabled: undefined }` clears the persisted value.
 */
interface SettingsLeafPatch {
	top: Partial<
		Pick<CompactSettings, "enabled" | "mode" | "retainGitLive" | "compactPaths">
	>;
	stats?: Partial<CompactStatsSettings>;
	autoShake?: Partial<CompactAutoShakeSettings>;
	host?: Partial<CompactHostSettings>;
}

/**
 * Only the leaf fields where the desired settings differ from the snapshot.
 * The internal write goes through a `Record` (a union-key write into
 * `Partial<T>` resolves to the property-type intersection); every value is
 * normalized by construction, so the cast is safe.
 */
function diffLeaves<T extends object>(
	base: T,
	desired: T,
	fields: readonly (keyof T)[],
): Partial<T> {
	const changed: Partial<T> = {};
	for (const key of fields) {
		if (desired[key] !== base[key]) {
			(changed as Record<keyof T, unknown>)[key] = desired[key];
		}
	}
	return changed;
}

function deriveLeafPatch(
	base: CompactSettings,
	desired: CompactSettings,
): SettingsLeafPatch {
	const top = diffLeaves(base, desired, TOP_LEVEL_FIELDS);
	const stats = diffLeaves(base.stats, desired.stats, STATS_FIELDS);
	const autoShake = diffLeaves(
		base.autoShake,
		desired.autoShake,
		AUTO_SHAKE_FIELDS,
	);
	const host = diffLeaves(base.host, desired.host, HOST_FIELDS);
	return {
		top,
		...(Object.keys(stats).length > 0 ? { stats } : {}),
		...(Object.keys(autoShake).length > 0 ? { autoShake } : {}),
		...(Object.keys(host).length > 0 ? { host } : {}),
	};
}

/**
 * Apply a leaf patch onto the fresh normalized reread. Fields absent from the
 * patch keep the latest persisted values, so distinct concurrent edits
 * compose; nested objects are rebuilt leaf-by-leaf.
 */
function applyLeafPatch(
	latest: CompactSettings,
	patch: SettingsLeafPatch,
): Record<string, unknown> {
	const raw: Record<string, unknown> = { ...latest, ...patch.top };
	if (patch.stats !== undefined) {
		raw.stats = { ...latest.stats, ...patch.stats };
	}
	if (patch.autoShake !== undefined) {
		raw.autoShake = { ...latest.autoShake, ...patch.autoShake };
	}
	if (patch.host !== undefined) {
		raw.host = { ...latest.host, ...patch.host };
	}
	return raw;
}

/**
 * Hard environment overrides currently in force: `OMP_COMPACT_PLUGIN=0|false`
 * and legacy `OMP_COMPACT_MODE=off` force `enabled` (both may be set at
 * once); an explicit compact/live/clear `OMP_COMPACT_MODE` forces `mode`.
 * The settings save flow uses this to name the variables that mask a
 * just-saved value — it never guesses names from the effective diff alone.
 */
export interface EnvOverrides {
	/** Env vars currently forcing `enabled` (empty when none). */
	enabledBy: ReadonlyArray<"OMP_COMPACT_PLUGIN" | "OMP_COMPACT_MODE">;
	/** Env var currently forcing `mode` (undefined when none). */
	modeBy?: "OMP_COMPACT_MODE";
}

export function resolveEnvOverrides(env: EnvLike): EnvOverrides {
	const enabledBy: Array<"OMP_COMPACT_PLUGIN" | "OMP_COMPACT_MODE"> = [];
	if (env.OMP_COMPACT_PLUGIN === "0" || env.OMP_COMPACT_PLUGIN === "false") {
		enabledBy.push("OMP_COMPACT_PLUGIN");
	}
	if (env.OMP_COMPACT_MODE === "off") {
		enabledBy.push("OMP_COMPACT_MODE");
	}
	return {
		enabledBy,
		modeBy: isCompactMode(env.OMP_COMPACT_MODE)
			? "OMP_COMPACT_MODE"
			: undefined,
	};
}

export interface CompactSettingsStore {
	load(): Promise<CompactSettings>;
	snapshot(): CompactSettings;
	update(patch: CompactSettingsPatch): Promise<CompactSettings>;
	/**
	 * Hard env overrides currently in force (see `resolveEnvOverrides`).
	 * Optional so read-only consumers (e.g. ModePolicy fakes) can implement
	 * the interface without env knowledge; the save flow then degrades to
	 * no warning.
	 */
	overrides?(): EnvOverrides;
	subscribe(fn: (settings: CompactSettings) => void): () => void;
}

export interface StoreDeps {
	env?: EnvLike;
	path?: string;
	warn?: (message: string) => void;
}

export function createSettingsStore(
	deps: StoreDeps = {},
): CompactSettingsStore {
	const env = deps.env ?? process.env;
	const path = deps.path ?? resolveConfigPath(env);
	const warn =
		deps.warn ??
		((message: string) => console.warn(`[omp-compact] ${message}`));
	const warned = new Set<string>();
	const warnOnce = (key: string, message: string): void => {
		if (warned.has(key)) return;
		warned.add(key);
		warn(message);
	};

	// The normalized user config (what load() read / update() persisted).
	// Environment overrides are NEVER written into this layer.
	let persisted: CompactSettings = DEFAULT_SETTINGS;
	// The effective snapshot: persisted settings with hard environment
	// overrides reapplied, kept authoritative until process env changes.
	let current: CompactSettings = DEFAULT_SETTINGS;
	let loaded = false;
	const subscribers = new Set<(settings: CompactSettings) => void>();

	/**
	 * Hard environment overrides (legacy + upgrade2 contracts):
	 * `OMP_COMPACT_PLUGIN=0|false` and legacy `OMP_COMPACT_MODE=off` disable
	 * the runtime (the settings command stays registered); an explicit
	 * `OMP_COMPACT_MODE` of compact/live/clear pins the mode. Reapplied on
	 * every load AND every update, so the settings menu can never bypass a
	 * hard override mid-session. The conditions mirror `resolveEnvOverrides`
	 * exactly — the effective layer and the save-flow warning must never
	 * diverge.
	 */
	function applyEnvOverrides(settings: CompactSettings): CompactSettings {
		const { enabledBy, modeBy } = resolveEnvOverrides(env);
		let next = settings;
		if (enabledBy.length > 0) {
			// `OMP_COMPACT_MODE=off` is the legacy env contract (pre-upgrade
			// shipped behavior): a literal `off` hard-disables the runtime —
			// the same effective state as enabled=false — while the settings
			// command stays registered. The new compact/live/clear values
			// keep their mode meaning; anything else is ignored.
			next = { ...next, enabled: false };
		}
		if (modeBy !== undefined) {
			next = { ...next, mode: env.OMP_COMPACT_MODE as CompactMode };
		}
		return next;
	}

	/**
	 * Bounded reread of the persisted JSON with the same fail-open/default
	 * diagnostics as `load()`: missing file -> defaults (no warning),
	 * malformed/oversized/over-deep -> defaults with warn-once. Never a
	 * lock or retry loop.
	 */
	async function readLatest(): Promise<CompactSettings> {
		let raw: unknown;
		try {
			const text = await readFile(path, "utf8");
			raw = parseBoundedJson(text, (message) => warnOnce("parse", message));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				warnOnce(
					"read",
					`failed to read config ${path}: ${(error as Error).message}`,
				);
			}
		}
		if (raw === undefined) return DEFAULT_SETTINGS;
		return normalizeWithDiagnostics(raw, (message) =>
			warnOnce("normalize", message),
		).settings;
	}

	async function load(): Promise<CompactSettings> {
		const settings = await readLatest();
		persisted = cloneAndFreeze(settings);
		loaded = true;
		current = cloneAndFreeze(applyEnvOverrides(settings));
		return current;
	}

	async function persist(settings: CompactSettings): Promise<void> {
		const tmp = join(
			dirname(path),
			`.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
		);
		try {
			await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
			await rename(tmp, path);
		} catch (error) {
			await rm(tmp, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async function update(patch: CompactSettingsPatch): Promise<CompactSettings> {
		if (!loaded) await load();
		// Merge on top of the PERSISTED layer: a save expresses the user's
		// requested values and must not bake environment overrides into the
		// config file.
		const merged: Record<string, unknown> = {
			...persisted,
			...patch,
			stats: { ...persisted.stats, ...(patch.stats ?? {}) },
			autoShake: { ...persisted.autoShake, ...(patch.autoShake ?? {}) },
			host: { ...persisted.host, ...(patch.host ?? {}) },
		};
		const { settings: desired, invalid } = normalizeWithDiagnostics(
			merged,
			warn,
		);
		if (invalid.length > 0) {
			throw new Error(
				`omp-compact: invalid settings update (${invalid.join(", ")}); nothing was saved`,
			);
		}
		// E02: only the leaf fields this save actually changes relative to
		// this store's snapshot are written. The bounded in-process queue keeps
		// reread and atomic rename ordered for Promise.all callers; a same-field
		// conflict still resolves by queue/rename order (last successful writer).
		const leafPatch = deriveLeafPatch(persisted, desired);
		const next = await withUpdateQueue(path, async () => {
			// Re-read immediately before the atomic rename and apply only this
			// leaf patch. Missing/invalid latest data fails open to defaults with
			// existing diagnostics; there is no lock file or retry loop.
			await mkdir(dirname(path), { recursive: true });
			const latest = await readLatest();
			const { settings: mergedSettings, invalid: latestInvalid } =
				normalizeWithDiagnostics(applyLeafPatch(latest, leafPatch), warn);
			if (latestInvalid.length > 0) {
				throw new Error(
					`omp-compact: invalid merged settings (${latestInvalid.join(", ")}); nothing was saved`,
				);
			}
			await persist(mergedSettings);
			return mergedSettings;
		});
		persisted = cloneAndFreeze(next);
		current = cloneAndFreeze(applyEnvOverrides(next));
		for (const fn of [...subscribers]) {
			fn(current);
		}
		return current;
	}

	function snapshot(): CompactSettings {
		return cloneAndFreeze(current);
	}

	function subscribe(fn: (settings: CompactSettings) => void): () => void {
		subscribers.add(fn);
		return () => {
			subscribers.delete(fn);
		};
	}

	return {
		load,
		snapshot,
		update,
		overrides: () => resolveEnvOverrides(env),
		subscribe,
	};
}
