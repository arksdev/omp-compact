import type { CompactHostSettings } from "./config";
import {
	createSessionResolver,
	MAIN_AGENT_ID,
	type ShakeableSession,
} from "./post-turn-shake";

/**
 * Host-settings bridge (upgrade2 item 6): menu controls for stock
 * `recap.enabled` and `hideThinkingBlock`.
 *
 * Stock seam (OMP 17.2.12, oh-my-pi reference):
 * - Every live `AgentSession` owns an initialized `session.settings`
 *   (`session/agent-session.ts`: `readonly settings: Settings`), whose
 *   `get`/`set`/`flush` act on the live per-session Settings instance and
 *   persist through stock `config/settings.ts`.
 * - The exported global `settings` Proxy (`config/settings.ts` `export const
 *   settings = new Proxy(...)`) throws `Settings not initialized. Call
 *   Settings.init() first.` on ANY property access until `Settings.init()`
 *   is called. This OMP runtime initializes per-AgentSession Settings
 *   instances and never calls `Settings.init()` on the global, so the plugin
 *   MUST NOT touch the exported global. The bridge resolves the live main
 *   session through the public SDK registry
 *   (`pi.pi.AgentRegistry.global().get(MAIN_AGENT_ID)`), verifies by identity
 *   that the session belongs to the invoking command context
 *   (`session.sessionManager === ctx.sessionManager`, the same check
 *   post-turn-shake uses), and adapts THAT instance's get/set/flush.
 * - Schema defaults: `recap.enabled` -> true, `hideThinkingBlock` -> false
 *   (`config/settings-schema.ts`). Reading never writes.
 * - `settings.set(path, value)` queues one debounced background save;
 *   `settings.flush()` awaits it and rethrows on failure. Persistence
 *   (`config/settings.ts` `#saveNow`) re-reads the config file under lock and
 *   applies only the modified whole-value paths, then writes atomically —
 *   unrelated settings and external edits are preserved (comments are not
 *   preserved by stock YAML.stringify; that is stock behavior, not ours).
 * - Live effect without restart: `recap.enabled` is re-read on every
 *   `agent_end` (`modes/controllers/event-controller.ts` `#scheduleIdleRecap`),
 *   so it applies immediately. `hideThinkingBlock` is cached by
 *   InteractiveMode at startup (`modes/interactive-mode.ts`:
 *   `this.hideThinkingBlock = settings.get("hideThinkingBlock")`) and has no
 *   public live-update seam, so it takes effect at the next session start.
 *   `ctx.reload()` would tear down the interactive session and is a
 *   disruptive no-op for this toggle: the bridge never reloads. It reports
 *   `restartRequired` so the caller can notify honestly
 *   ("restart OMP to apply").
 *
 * Contract: loading the plugin / opening the menu / cancelling never writes
 * host config. On explicit save only the two paths above are changed, flushed
 * through stock persistence; on flush failure both are rolled back and the
 * error is rethrown (the plugin JSON must not claim host-save success). A
 * no-op apply writes nothing; concurrent applies coalesce so save and flush
 * each happen at most once per logical save.
 */

/** The two stock settings this bridge is allowed to touch. */
export type HostSettingPath = "recap.enabled" | "hideThinkingBlock";

/** Minimal surface of the stock Settings singleton (public package export). */
export interface HostSettingsApi {
	/** Raw effective value (schema default when unset); may be malformed. */
	get(path: HostSettingPath): unknown;
	/** Persist a whole-value boolean through the stock Settings layer. */
	set(path: HostSettingPath, value: boolean): void;
	/** Flush pending stock saves; rethrows on persistence failure. */
	flush(): Promise<void>;
}

export interface HostApplyResult {
	/** Host-facing toggles that actually changed on disk. */
	changed: Array<keyof CompactHostSettings>;
	/**
	 * True when thinking visibility changed: stock caches `hideThinkingBlock`
	 * at InteractiveMode startup, so restarting OMP is required for the live
	 * transcript to reflect it. There is no safe live refresh in stock, so
	 * the caller only reports this honestly — the bridge never reloads.
	 */
	restartRequired: boolean;
}

export interface HostSettingsBridge {
	/** Effective host values for menu mirroring. Never writes. */
	read(): CompactHostSettings;
	/** Persist host-facing toggles; flush; roll back on flush failure. Throws on failure. */
	apply(host: CompactHostSettings): Promise<HostApplyResult>;
	/** Clear warn-once state (session disposal). */
	dispose(): void;
}

export interface HostSettingsBridgeDeps {
	api: HostSettingsApi;
	/** Warn callback; defaults to console.warn. Warn-once per failure class. */
	warn?: (msg: string) => void;
}

/**
 * Minimal structural surface of the stock `AgentSession.settings` (an
 * initialized per-session `Settings` instance). Never the exported global.
 */
export interface SessionSettingsLike {
	get(path: string): unknown;
	set(path: string, value: unknown): void;
	flush(): Promise<void>;
}

/** The parts of the command context the resolver verifies against. */
export interface HostSettingsContext {
	sessionManager: unknown;
}

/** Stock schema default for `recap.enabled` (settings-schema.ts). */
const DEFAULT_RECAP_ENABLED = true;
/** Stock schema default for `hideThinkingBlock` (settings-schema.ts). */
const DEFAULT_HIDE_THINKING_BLOCK = false;

const HOST_SETTING_DEFAULTS: Record<HostSettingPath, boolean> = {
	"recap.enabled": DEFAULT_RECAP_ENABLED,
	hideThinkingBlock: DEFAULT_HIDE_THINKING_BLOCK,
};

/** Flush failed AND restoring the previous values also failed to persist. */
export class HostSettingsApplyError extends Error {
	readonly rollbackFailed: boolean;
	constructor(
		message: string,
		options: { cause: unknown; rollbackFailed?: boolean },
	) {
		super(
			message,
			options.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.name = "HostSettingsApplyError";
		this.rollbackFailed = options.rollbackFailed === true;
	}
}

function defaultWarn(message: string): void {
	// eslint-disable-next-line no-console
	console.warn(`[omp-compact] ${message}`);
}

export function createHostSettingsBridge(
	deps: HostSettingsBridgeDeps,
): HostSettingsBridge {
	const api = deps.api;
	const warn = deps.warn ?? defaultWarn;
	const warned = new Set<string>();
	let inFlight: Promise<HostApplyResult> | null = null;

	function warnOnce(key: string, message: string): void {
		if (warned.has(key)) return;
		warned.add(key);
		warn(message);
	}

	function effectiveBoolean(path: HostSettingPath): boolean {
		try {
			const value = api.get(path);
			// Absent means the schema default applies (stock semantics) — no warning.
			if (value === undefined) return HOST_SETTING_DEFAULTS[path];
			if (typeof value === "boolean") return value;
			warnOnce(
				`non-boolean:${path}`,
				`Host setting "${path}" is not a boolean (${JSON.stringify(value)}); using default ${HOST_SETTING_DEFAULTS[path]}.`,
			);
			return HOST_SETTING_DEFAULTS[path];
		} catch (error) {
			warnOnce(
				`unreadable:${path}`,
				`Failed to read host setting "${path}": ${error instanceof Error ? error.message : String(error)}; using default ${HOST_SETTING_DEFAULTS[path]}.`,
			);
			return HOST_SETTING_DEFAULTS[path];
		}
	}

	function read(): CompactHostSettings {
		return {
			recapEnabled: effectiveBoolean("recap.enabled"),
			thinkingBlocksVisible: !effectiveBoolean("hideThinkingBlock"),
		};
	}

	function setBoth(
		changes: Array<{ path: HostSettingPath; value: boolean }>,
	): void {
		for (const change of changes) {
			api.set(change.path, change.value);
		}
	}

	async function runApply(host: CompactHostSettings): Promise<HostApplyResult> {
		const previous = read();
		const changes: Array<{ path: HostSettingPath; value: boolean }> = [];
		const changed: Array<keyof CompactHostSettings> = [];

		if (
			host.recapEnabled !== undefined &&
			host.recapEnabled !== previous.recapEnabled
		) {
			changes.push({ path: "recap.enabled", value: host.recapEnabled });
			changed.push("recapEnabled");
		}
		if (
			host.thinkingBlocksVisible !== undefined &&
			host.thinkingBlocksVisible !== previous.thinkingBlocksVisible
		) {
			changes.push({
				path: "hideThinkingBlock",
				value: !host.thinkingBlocksVisible,
			});
			changed.push("thinkingBlocksVisible");
		}

		// Nothing to persist: cancel/load/unchanged save never writes host config.
		if (changes.length === 0) {
			return { changed: [], restartRequired: false };
		}

		setBoth(changes);
		try {
			await api.flush();
		} catch (cause) {
			// Exact rollback of the values this apply changed, best-effort flush.
			const rollbackChanges = changes.map((change) => ({
				path: change.path,
				value:
					change.path === "recap.enabled"
						? (previous.recapEnabled ?? DEFAULT_RECAP_ENABLED)
						: !(previous.thinkingBlocksVisible ?? true),
			}));
			let rollbackFailed = false;
			try {
				setBoth(rollbackChanges);
				await api.flush();
			} catch (rollbackCause) {
				rollbackFailed = true;
				warnOnce(
					"rollback-flush",
					`Host settings rollback flush failed: ${rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)}.`,
				);
			}
			throw new HostSettingsApplyError(
				`Failed to persist host settings (${changes.map((c) => c.path).join(", ")}): ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
				{ cause, rollbackFailed },
			);
		}

		// Persisted. Thinking visibility has no safe live refresh in stock:
		// `ctx.reload()` would tear down the interactive session and is a
		// disruptive no-op for this toggle, so nothing is reloaded here. The
		// caller reports restartRequired honestly instead.
		return {
			changed,
			restartRequired: changed.includes("thinkingBlocksVisible"),
		};
	}

	return {
		read,
		apply(host: CompactHostSettings): Promise<HostApplyResult> {
			// Coalesce concurrent applies (double-save guard): the in-flight
			// save owns the single set + single flush.
			if (inFlight) return inFlight;
			inFlight = runApply(host).finally(() => {
				inFlight = null;
			});
			return inFlight;
		},
		dispose(): void {
			warned.clear();
		},
	};
}

/**
 * Build the default host-settings resolver: resolve the live main agent
 * session through the public `AgentRegistry` (same registry + identity seam
 * as post-turn-shake's `createSessionResolver`) and return its initialized
 * `session.settings` instance. The exported global `settings` Proxy is never
 * touched: in this OMP runtime it is not initialized and throws on any
 * access, while every live AgentSession owns an initialized Settings
 * instance. Every failure mode (absent registry, detached session, identity
 * mismatch, throwing getter, missing settings surface) resolves to
 * `undefined` — the caller fails open to "host settings unavailable".
 */
export function createSessionSettingsResolver(
	registry: unknown,
	mainAgentId: string = MAIN_AGENT_ID,
): (ctx: HostSettingsContext) => SessionSettingsLike | undefined {
	// Reuses the public identity-checked registry seam from post-turn-shake:
	// registry.global().get(mainAgentId), then
	// `session.sessionManager === ctx.sessionManager`.
	const resolveSession = createSessionResolver(registry, mainAgentId);
	return (ctx) => {
		let session: ShakeableSession | undefined;
		try {
			session = resolveSession(ctx);
		} catch {
			// A hostile/broken registry must never propagate.
			return undefined;
		}
		const settings = (session as { settings?: SessionSettingsLike } | null)
			?.settings;
		if (
			!settings ||
			typeof settings.get !== "function" ||
			typeof settings.set !== "function" ||
			typeof settings.flush !== "function"
		) {
			return undefined;
		}
		return settings;
	};
}

/**
 * Adapt an initialized per-session `Settings` instance (resolved from the
 * live main AgentSession) to {@link HostSettingsApi}. Values flow through
 * that exact instance's get/set/flush — never through any exported global.
 */
export function createSessionSettingsApi(
	sessionSettings: SessionSettingsLike,
): HostSettingsApi {
	return {
		get: (path) => sessionSettings.get(path),
		set: (path, value) => sessionSettings.set(path, value),
		flush: () => sessionSettings.flush(),
	};
}
