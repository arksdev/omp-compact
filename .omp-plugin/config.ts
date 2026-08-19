import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

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

export interface ResolveConfigPathOptions {
	/**
	 * Optional diagnostic sink. Fired at most once per call, and only when an
	 * *explicit* `OMP_COMPACT_CONFIG` is set and rejected — never on the
	 * ordinary no-env path. Callers that construct a settings store pass the
	 * store warn seam so a discarded user intent is visible without spamming
	 * absent-env startups.
	 */
	warn?: (message: string) => void;
	/**
	 * Project root used as the second accepted root for explicit config
	 * paths. Defaults to `process.cwd()`. Injectable for tests.
	 */
	cwd?: string;
}

/**
 * Resolve the plugin config file path. Precedence:
 * `OMP_COMPACT_CONFIG` > `PI_CODING_AGENT_DIR/omp-compact/config.json` >
 * `~/<PI_CONFIG_DIR|.omp>[/profiles/<PI_PROFILE>]/agent/omp-compact/config.json`.
 *
 * Env-derived segments are validated before use:
 * - `PI_PROFILE` must be a single path token (no separators, no `..`,
 *   non-empty).
 * - Explicit `OMP_COMPACT_CONFIG` must resolve under the user's home **or**
 *   the current project root (`cwd`). Project-local config is a legitimate
 *   layout (per-repo settings, integration harness temp dirs); the check
 *   only blocks paths that escape both roots.
 * - `PI_CONFIG_DIR` stays home-only: it names the stock agent config *root*
 *   (profile layout under `~/.omp` / `~/.pi`), not a per-project file.
 *   Project-local agent trees use `PI_CODING_AGENT_DIR` instead.
 *
 * Rejected values fall through to the next precedence / default layout.
 * A rejected **explicit** `OMP_COMPACT_CONFIG` also emits one warn when a
 * sink is provided — discarding a path the user named is different from an
 * absent env var. Other rejections stay silent (same fail-open shape as the
 * rest of this module's load path).
 */
export function resolveConfigPath(
	env: EnvLike,
	options: ResolveConfigPathOptions = {},
): string {
	const home = env.HOME ?? env.USERPROFILE ?? homedir();
	const cwd = options.cwd ?? process.cwd();
	const explicit = env.OMP_COMPACT_CONFIG;
	if (explicit) {
		const accepted = resolveAcceptedExplicitConfigPath(explicit, home, cwd);
		if (accepted !== undefined) return accepted;
		// User named a path and we threw it away — one diagnostic, not a throw.
		options.warn?.(
			`OMP_COMPACT_CONFIG path is outside home and project cwd (${explicit}); ignoring`,
		);
	}
	const agentDir = env.PI_CODING_AGENT_DIR;
	if (agentDir) return join(agentDir, "omp-compact", "config.json");
	// Rejected PI_CONFIG_DIR falls back to the stock ".omp" root silently.
	const configRoot =
		env.PI_CONFIG_DIR && isPathInsideHome(env.PI_CONFIG_DIR, home)
			? env.PI_CONFIG_DIR
			: ".omp";
	const profile = sanitizeProfileToken(env.PI_PROFILE);
	const agentBase = profile
		? join(home, configRoot, "profiles", profile, "agent")
		: join(home, configRoot, "agent");
	return join(agentBase, "omp-compact", "config.json");
}

/** Single path segment for PI_PROFILE: no separators, no `..`, non-empty. */
const SAFE_PROFILE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sanitizeProfileToken(profile: string | undefined): string | undefined {
	if (profile === undefined || profile === "") return undefined;
	if (profile.includes("..")) return undefined;
	if (
		profile.includes("/") ||
		profile.includes("\\") ||
		profile.includes(sep)
	) {
		return undefined;
	}
	if (!SAFE_PROFILE_TOKEN.test(profile)) return undefined;
	return profile;
}

/**
 * True when `candidate` resolves to a path at or under `home`. Relative
 * candidates are resolved against `home` (so `PI_CONFIG_DIR=.omp` stays the
 * historical `~/…` layout). Absolute candidates must still live under home.
 */
function isPathInsideHome(candidate: string, home: string): boolean {
	if (candidate === "") return false;
	const homeResolved = resolve(home);
	const resolved = isAbsolute(candidate)
		? resolve(candidate)
		: resolve(homeResolved, candidate);
	return isPathInsideRoot(resolved, homeResolved);
}

/**
 * Explicit `OMP_COMPACT_CONFIG` acceptance: the resolved path must live under
 * home or under the project cwd. Relative candidates are tried against cwd
 * first (project-local layout) and then against home (historical `~/…`
 * relative form). Returns the absolute resolved path on accept, else
 * `undefined` — so a later `readFile` does not depend on process.cwd().
 */
function resolveAcceptedExplicitConfigPath(
	candidate: string,
	home: string,
	cwd: string,
): string | undefined {
	if (candidate === "") return undefined;
	const homeResolved = resolve(home);
	const cwdResolved = resolve(cwd);
	if (isAbsolute(candidate)) {
		const resolved = resolve(candidate);
		if (
			isPathInsideRoot(resolved, homeResolved) ||
			isPathInsideRoot(resolved, cwdResolved)
		) {
			return resolved;
		}
		return undefined;
	}
	const fromCwd = resolve(cwdResolved, candidate);
	if (
		isPathInsideRoot(fromCwd, homeResolved) ||
		isPathInsideRoot(fromCwd, cwdResolved)
	) {
		return fromCwd;
	}
	const fromHome = resolve(homeResolved, candidate);
	if (isPathInsideRoot(fromHome, homeResolved)) return fromHome;
	return undefined;
}

function isPathInsideRoot(resolved: string, root: string): boolean {
	if (resolved === root) return true;
	const prefix = root.endsWith(sep) ? root : root + sep;
	return resolved.startsWith(prefix);
}

type BoundedParseResult =
	| { ok: true; raw: unknown }
	| { ok: false; reason: string };

/**
 * Parse JSON bounded by byte size and nesting depth. Returns `ok: false`
 * with the failure reason on violation; the warning still carries the full
 * `; using defaults` message for load-time diagnostics.
 *
 * Two-pass approach: a linear scan first rejects oversized or over-deep
 * JSON without allocating a parse tree; `JSON.parse` then runs only on
 * input that passed both structural checks. The pre-scan is not a
 * substitute JSON parser — it only counts bytes and brackets; malformed
 * JSON that passes the scan is caught by `JSON.parse` and returns a
 * failure with a warn.
 */
function parseBoundedJson(
	text: string,
	warn: (message: string) => void,
): BoundedParseResult {
	if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
		const reason = `config JSON is oversized (max ${MAX_CONFIG_BYTES} bytes)`;
		warn(`${reason}; using defaults`);
		return { ok: false, reason };
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
				const reason = `config JSON nesting depth exceeds ${MAX_CONFIG_DEPTH}`;
				warn(`${reason}; using defaults`);
				return { ok: false, reason };
			}
		} else if (ch === "}" || ch === "]") {
			depth--;
			if (depth < 0) {
				const reason = "config JSON closes a structure before opening one";
				warn(`${reason}; using defaults`);
				return { ok: false, reason };
			}
		}
	}
	try {
		return { ok: true, raw: JSON.parse(text) as unknown };
	} catch {
		const reason = "config JSON is malformed";
		warn(`${reason}; using defaults`);
		return { ok: false, reason };
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
		// Only the last queued operation cleans up the path entry; earlier
		// operations find a newer tail and correctly skip the delete.
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
 * Apply a leaf patch onto the fresh bounded reread's raw record. Fields
 * absent from the patch keep the latest persisted values, so distinct
 * concurrent edits compose; nested objects are rebuilt leaf-by-leaf.
 * Unknown keys of the raw record — top-level and inside stats/autoShake/
 * host — are carried through untouched, so a save never strips fields a
 * newer host wrote.
 */
function applyLeafPatch(
	latest: Record<string, unknown>,
	patch: SettingsLeafPatch,
): Record<string, unknown> {
	const raw: Record<string, unknown> = { ...latest, ...patch.top };
	const stats = latest.stats;
	if (patch.stats !== undefined) {
		raw.stats = {
			...(stats !== null && typeof stats === "object" ? stats : {}),
			...patch.stats,
		};
	}
	const autoShake = latest.autoShake;
	if (patch.autoShake !== undefined) {
		raw.autoShake = {
			...(autoShake !== null && typeof autoShake === "object" ? autoShake : {}),
			...patch.autoShake,
		};
	}
	const host = latest.host;
	if (patch.host !== undefined) {
		raw.host = {
			...(host !== null && typeof host === "object" ? host : {}),
			...patch.host,
		};
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

/**
 * Thrown by `update()` when the existing persisted config cannot be safely
 * read, parsed, or validated. The save refuses to overwrite a file it cannot
 * merge with — only a genuinely missing file (ENOENT) falls back to
 * defaults. The message is surfaced verbatim by the settings UI error line.
 */
export class ConfigUpdateError extends Error {
	constructor(message: string) {
		super(`omp-compact: ${message}`);
		this.name = "ConfigUpdateError";
	}
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
	/**
	 * Read seam for the persisted config file, injectable so tests can force
	 * deterministic non-ENOENT failures (EACCES/EIO) without chmod. Defaults
	 * to `readFile` from `node:fs/promises`.
	 */
	readFile?: (path: string, encoding: "utf8") => Promise<string>;
}

export function createSettingsStore(
	deps: StoreDeps = {},
): CompactSettingsStore {
	const env = deps.env ?? process.env;
	const warn =
		deps.warn ??
		((message: string) => console.warn(`[omp-compact] ${message}`));
	// Resolve after warn is bound so a rejected explicit OMP_COMPACT_CONFIG
	// can surface one diagnostic through the store warn seam.
	const path = deps.path ?? resolveConfigPath(env, { warn });
	const readConfigFile = deps.readFile ?? readFile;
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
	 * Raw read of the persisted config that distinguishes a genuinely
	 * missing file from any other failure, so load stays fail-open while the
	 * save path can fail closed on everything but ENOENT.
	 */
	type RawConfigRead =
		| { kind: "missing" }
		| { kind: "error"; error: Error }
		| { kind: "ok"; text: string };
	async function readRawConfig(): Promise<RawConfigRead> {
		try {
			const text = await readConfigFile(path, "utf8");
			return { kind: "ok", text };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { kind: "missing" };
			}
			return { kind: "error", error: error as Error };
		}
	}

	/**
	 * Fail-open bounded reread with the same default/warn diagnostics as
	 * `load()`: missing file -> defaults (no warning), malformed/oversized/
	 * over-deep -> defaults with warn-once. Never a lock or retry loop.
	 */
	async function readLatest(): Promise<CompactSettings> {
		const read = await readRawConfig();
		if (read.kind === "missing") return DEFAULT_SETTINGS;
		if (read.kind === "error") {
			warnOnce("read", `failed to read config ${path}: ${read.error.message}`);
			return DEFAULT_SETTINGS;
		}
		const parsed = parseBoundedJson(read.text, (message) =>
			warnOnce("parse", message),
		);
		if (!parsed.ok) return DEFAULT_SETTINGS;
		return normalizeWithDiagnostics(parsed.raw, (message) =>
			warnOnce("normalize", message),
		).settings;
	}

	/**
	 * Fail-closed bounded reread for the save path: only a genuinely missing
	 * file (ENOENT) may fall back to defaults. An existing config that
	 * cannot be read, parsed, or validated throws `ConfigUpdateError`, so an
	 * update never persists defaults+patch over a file it cannot safely
	 * merge with. Returns both the normalized settings and the raw
	 * bounded-parsed record: the raw record preserves unknown keys (fields a
	 * newer host wrote that this schema does not know) through the leaf-patch
	 * merge; a missing file seeds defaults so the first save keeps writing
	 * defaults+patch exactly as before.
	 */
	async function readLatestStrict(): Promise<{
		settings: CompactSettings;
		raw: Record<string, unknown>;
	}> {
		const read = await readRawConfig();
		if (read.kind === "missing")
			return { settings: DEFAULT_SETTINGS, raw: { ...DEFAULT_SETTINGS } };
		if (read.kind === "error") {
			throw new ConfigUpdateError(
				`existing config ${path} could not be read (${read.error.message}); refusing to overwrite it`,
			);
		}
		const parsed = parseBoundedJson(read.text, (message) =>
			warnOnce("parse", message),
		);
		if (!parsed.ok) {
			throw new ConfigUpdateError(
				`existing config ${path} could not be parsed (${parsed.reason}); refusing to overwrite it`,
			);
		}
		const { settings, invalid } = normalizeWithDiagnostics(
			parsed.raw,
			(message) => warnOnce("normalize", message),
		);
		if (invalid.length > 0) {
			throw new ConfigUpdateError(
				`existing config ${path} has invalid field(s): ${invalid.join(", ")}; refusing to overwrite it`,
			);
		}
		return { settings, raw: parsed.raw as Record<string, unknown> };
	}

	async function load(): Promise<CompactSettings> {
		const settings = await readLatest();
		persisted = cloneAndFreeze(settings);
		loaded = true;
		current = cloneAndFreeze(applyEnvOverrides(settings));
		return current;
	}

	/**
	 * Serialize a merged config record the way it is persisted: pretty
	 * printed with a trailing newline. Used by the write-side bound check and
	 * the atomic write so both measure the exact same bytes.
	 */
	function serializeRecord(record: Record<string, unknown>): string {
		return `${JSON.stringify(record, null, 2)}\n`;
	}

	async function persistText(text: string): Promise<void> {
		const tmp = join(
			dirname(path),
			`.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
		);
		try {
			await writeFile(tmp, text, "utf8");
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
			// leaf patch. A genuinely missing file falls back to defaults; an
			// existing file that cannot be read, parsed, or validated fails
			// closed (`ConfigUpdateError`) before anything is written, so a
			// broken config is never replaced by defaults+patch. There is no
			// lock file or retry loop.
			await mkdir(dirname(path), { recursive: true });
			const latest = await readLatestStrict();
			// The leaf patch lands on the RAW bounded-parsed record, not the
			// normalized settings: unknown keys a newer host wrote survive the
			// save verbatim, while known-field validation still runs on the
			// merged record below.
			const mergedRecord = applyLeafPatch(latest.raw, leafPatch);
			// The persisted record must always declare its schema version: a
			// raw record without one (a legacy file that lost the key) would
			// otherwise stay version-less forever, indistinguishable from a v1
			// file once a v2 format appears. readLatestStrict already rejected
			// every non-1 version, so only the absent case reaches this guard
			// and an existing `version: 1` is never rewritten.
			if (mergedRecord.version !== 1) mergedRecord.version = 1;
			const { settings: mergedSettings, invalid: latestInvalid } =
				normalizeWithDiagnostics(mergedRecord, warn);
			if (latestInvalid.length > 0) {
				throw new Error(
					`omp-compact: invalid merged settings (${latestInvalid.join(", ")}); nothing was saved`,
				);
			}
			// Write-side bound: the strict reread was bounded, but preserving
			// unknown keys must never let the merged record escape the bounded
			// JSON contract (size/depth) on the way out. The check measures the
			// exact serialized bytes that will be written.
			const mergedText = serializeRecord(mergedRecord);
			const bounded = parseBoundedJson(mergedText, () => {});
			if (!bounded.ok) {
				throw new ConfigUpdateError(
					`merged config would exceed the bounded JSON contract (${bounded.reason}); nothing was saved`,
				);
			}
			await persistText(mergedText);
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
