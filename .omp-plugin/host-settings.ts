import { join } from "node:path";
import { YAML } from "bun";

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
 * Stock seam (OMP 17.3.1, oh-my-pi reference):
 * - Every live `AgentSession` owns an initialized `session.settings`
 *   (`session/agent-session.ts`: `readonly settings: Settings`), whose
 *   `get`/`set`/`flush` act on the live per-session Settings instance and
 *   persist through stock `config/settings.ts`.
 * - `Settings.getAgentDir()` is public and locates the profile directory;
 *   stock persists global settings to `<agentDir>/config.yml` (falling back
 *   to `config.yaml`; pi-utils `MAIN_CONFIG_FILENAMES`). The bridge reads
 *   that file for the raw persistent pre-image, so project/runtime overrides
 *   can never mask rollback values.
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
 *
 * Rollback safety: before any mutation the bridge captures the raw persistent
 * pre-image of the changed paths via {@link HostSettingsApi.persistent} — the
 * active profile YAML (`<agentDir>/config.yml` / `config.yaml`, the same files
 * stock persists to), never the effective values that project/runtime
 * overrides can mask. A failed flush then restores each path verbatim
 * (present -> exact raw value, absent -> key removed via
 * `Settings.set(path, undefined)`, which drops the leaf from the YAML on
 * save). If the pre-image cannot be read or parsed, the bridge fails closed
 * BEFORE `set()` with an actionable error rather than risking config
 * corruption. Concurrency tradeoff: the pre-image read is lock-free (stock
 * writes atomically, so no torn reads) but an external edit to one of these
 * paths between capture and flush is a last-writer-wins race — rollback
 * restores the captured pre-image over that concurrent edit, matching stock's
 * own per-path overwrite semantics.
 */

/** The two stock settings this bridge is allowed to touch. */
export type HostSettingPath = "recap.enabled" | "hideThinkingBlock";

/**
 * Raw persistent (global config) state of one host path before an apply.
 * Reads come from the active profile YAML (`<agentDir>/config.yml` or
 * `config.yaml`), never from effective values, so project/runtime overrides
 * cannot mask the pre-image that a failed flush must restore.
 */
export interface PersistentSettingState {
	/** True when the path is explicitly present in the profile YAML. */
	present: boolean;
	/** Raw stored value (boolean, null, malformed string…); undefined when absent. */
	value: unknown;
}

/** Exact persistent pre-image of every host path, captured before mutation. */
export type PersistentPreImage = Record<
	HostSettingPath,
	PersistentSettingState
>;

/** Minimal surface of the stock Settings singleton (public package export). */
export interface HostSettingsApi {
	/** Raw effective value (schema default when unset); may be malformed. */
	get(path: HostSettingPath): unknown;
	/**
	 * Persist a whole-value through the stock Settings layer: boolean on
	 * forward applies; the exact raw persistent value (or `undefined` to
	 * remove the key — stock YAML.stringify drops undefined leaves) on
	 * rollback.
	 */
	set(path: HostSettingPath, value: unknown): void;
	/** Flush pending stock saves; rethrows on persistence failure. */
	flush(): Promise<void>;
	/**
	 * Raw persistent pre-image of the host paths from the active profile YAML
	 * (global config only — never masked by project/runtime overrides). Must
	 * be captured before any mutation so a failed flush can restore the exact
	 * persisted values. Rejects (fail closed) when the config cannot be read
	 * or parsed, or when the resolved path cannot be trusted.
	 */
	persistent(): Promise<PersistentPreImage>;
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
	/**
	 * One-shot compensating rollback for a failure that happens AFTER this
	 * apply succeeded and flushed (e.g. the plugin JSON persist failing):
	 * restores the exact raw persistent pre-image of the changed paths —
	 * present -> raw value verbatim, absent -> key removed via
	 * `Settings.set(path, undefined)` — and flushes. Harmless no-op when the
	 * apply changed nothing. Must be invoked before the next apply; a second
	 * invocation rejects. Throws when the restore itself cannot be persisted.
	 */
	rollback(): Promise<void>;
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
	/** Stock `Settings.getAgentDir()`: directory holding config.yml/config.yaml. */
	getAgentDir(): string;
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

/**
 * Stock main config filenames (pi-utils `MAIN_CONFIG_FILENAMES`), tried in
 * order exactly like stock `Settings.#loadExistingMainYaml`.
 */
const MAIN_CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;

/** YAML-path segments for each host path, matching stock `setByPath`. */
const HOST_SETTING_SEGMENTS: Record<HostSettingPath, readonly string[]> = {
	"recap.enabled": ["recap", "enabled"],
	hideThinkingBlock: ["hideThinkingBlock"],
};

/**
 * Extract the raw persistent state of a path from a parsed profile YAML,
 * mirroring stock `getByPath` resolution: a non-object or absent segment at
 * any intermediate level makes the path "absent" (schema default applies),
 * while an explicitly present leaf — even `null` or a malformed string — is
 * preserved verbatim so rollback can restore it exactly.
 */
function rawPersistentState(
	root: unknown,
	segments: readonly string[],
): PersistentSettingState {
	let current: unknown = root;
	for (const segment of segments) {
		if (
			current === null ||
			current === undefined ||
			typeof current !== "object" ||
			Array.isArray(current) ||
			!Object.hasOwn(current as Record<string, unknown>, segment)
		) {
			return { present: false, value: undefined };
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return { present: true, value: current };
}

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
	// Serial apply queue (same shape as config.ts `withUpdateQueue`): each
	// call waits for the previous tail, then runs its own payload. Failures
	// must not poison the chain — later applies still run with a fresh
	// pre-image captured at their turn.
	let applyQueue: Promise<unknown> = Promise.resolve();

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
		changes: Array<{ path: HostSettingPath; value: unknown }>,
	): void {
		for (const change of changes) {
			api.set(change.path, change.value);
		}
	}

	/**
	 * Restore the exact raw persistent pre-image for exactly the changed
	 * paths and flush: a present path is restored verbatim (including
	 * malformed values); an absent path is restored by removing the key
	 * (stock `Settings.set(path, undefined)` drops the leaf from the YAML on
	 * save) so the schema default applies again. Shared by the bridge's own
	 * flush-failure rollback and the one-shot compensating rollback handed
	 * to the caller. Throws when the restore cannot be persisted.
	 */
	async function restorePreImage(
		changes: ReadonlyArray<{ path: HostSettingPath; value: unknown }>,
		preImage: PersistentPreImage,
	): Promise<void> {
		setBoth(
			changes.map((change) => {
				const state = preImage[change.path];
				return {
					path: change.path,
					value: state.present ? state.value : undefined,
				};
			}),
		);
		await api.flush();
	}

	/**
	 * Wrap a rollback action in the one-shot contract shared by every apply
	 * result rollback: the first invocation runs the action, a second
	 * rejects — the closure's pre-image (or no-op) is only valid for the
	 * save it belongs to, and restoring twice could clobber a newer save.
	 */
	function createOneShotRollback(
		action: () => Promise<void>,
	): () => Promise<void> {
		let used = false;
		return async () => {
			if (used) {
				throw new Error("Host settings rollback already invoked");
			}
			used = true;
			await action();
		};
	}

	/**
	 * One-shot compensating rollback bound to ONE apply: restores the raw
	 * persistent pre-image captured before that apply's mutation.
	 */
	function createCompensatingRollback(
		changes: ReadonlyArray<{ path: HostSettingPath; value: unknown }>,
		preImage: PersistentPreImage,
	): () => Promise<void> {
		return createOneShotRollback(() => restorePreImage(changes, preImage));
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
			return {
				changed: [],
				restartRequired: false,
				// No-op apply: the compensating rollback is a harmless no-op,
				// but still one-shot like every apply-result rollback.
				rollback: createOneShotRollback(async () => undefined),
			};
		}

		// Capture the raw persistent pre-image BEFORE any mutation. Rollback
		// must restore the exact persisted values — never effective values,
		// which project/runtime overrides can mask. If the pre-image cannot be
		// read, fail closed before set(): an unverifiable rollback could
		// corrupt the global config.
		let preImage: PersistentPreImage;
		try {
			preImage = await api.persistent();
		} catch (cause) {
			throw new HostSettingsApplyError(
				`Refusing to apply host settings (${changes.map((c) => c.path).join(", ")}): cannot read the persistent pre-image required for rollback safety: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
				{ cause },
			);
		}

		setBoth(changes);
		try {
			await api.flush();
		} catch (cause) {
			// Exact rollback of the raw persistent pre-image (never effective
			// values, which project/runtime overrides can mask). Best-effort
			// flush; a failed restore is reported on the error, not thrown.
			let rollbackFailed = false;
			try {
				await restorePreImage(changes, preImage);
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
			// One-shot compensating rollback for a LATER failure (e.g. the
			// plugin JSON persist): restores the raw persistent pre-image
			// captured before this apply's mutation.
			rollback: createCompensatingRollback(changes, preImage),
		};
	}

	return {
		read,
		/**
		 * Persist host-facing toggles; flush; roll back on flush failure.
		 * Concurrent calls are serialized (not coalesced): each apply waits
		 * for the previous one, then captures its own persistent pre-image
		 * and writes its own `host` payload. A failed prior apply does not
		 * drop or block a queued successor.
		 */
		apply(host: CompactHostSettings): Promise<HostApplyResult> {
			const previous = applyQueue;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			// Next callers await this gate; failures must not poison the tail.
			applyQueue = previous.catch(() => undefined).then(() => gate);
			return (async () => {
				await previous.catch(() => undefined);
				try {
					return await runApply(host);
				} finally {
					release();
				}
			})();
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
		let settings: SessionSettingsLike | undefined;
		try {
			settings = (session as { settings?: SessionSettingsLike } | null)
				?.settings;
		} catch {
			// A throwing session.settings getter must fail open to unavailable,
			// exactly like every other resolution failure.
			return undefined;
		}
		if (
			!settings ||
			typeof settings.get !== "function" ||
			typeof settings.set !== "function" ||
			typeof settings.flush !== "function" ||
			typeof settings.getAgentDir !== "function"
		) {
			// Without getAgentDir the adapter cannot read the raw persistent
			// pre-image, so rollback safety cannot be guaranteed. Fail open to
			// "host settings unavailable" rather than expose an unsafe bridge.
			return undefined;
		}
		return settings;
	};
}

/**
 * Adapt an initialized per-session `Settings` instance (resolved from the
 * live main AgentSession) to {@link HostSettingsApi}. Values flow through
 * that exact instance's get/set/flush — never through any exported global.
 *
 * `persistent()` is the raw pre-image seam: it reads the active profile YAML
 * (`<getAgentDir()>/config.yml`, falling back to `config.yaml`, the same
 * files and order stock `Settings.#loadExistingMainYaml` uses) and extracts
 * the exact persisted values of the host paths, including key absence.
 * Stock writes config atomically (temp file + rename), so a plain read never
 * observes torn content; a missing profile is a trustworthy all-absent
 * pre-image. Unreadable or invalid YAML rejects so the bridge can fail closed
 * before mutating.
 */
export function createSessionSettingsApi(
	sessionSettings: SessionSettingsLike,
): HostSettingsApi {
	return {
		get: (path) => sessionSettings.get(path),
		set: (path, value) => sessionSettings.set(path, value),
		flush: () => sessionSettings.flush(),
		persistent: async () => {
			const preImage: PersistentPreImage = {
				"recap.enabled": { present: false, value: undefined },
				hideThinkingBlock: { present: false, value: undefined },
			};
			const agentDir = sessionSettings.getAgentDir();
			let root: unknown;
			let configPath: string | undefined;
			for (const filename of MAIN_CONFIG_FILENAMES) {
				const candidate = join(agentDir, filename);
				let content: string;
				try {
					const file = Bun.file(candidate);
					if (!(await file.exists())) continue;
					content = await file.text();
				} catch (error) {
					throw new Error(
						`Cannot read persistent host settings config ${candidate}: ${
							error instanceof Error ? error.message : String(error)
						}`,
						error instanceof Error ? { cause: error } : undefined,
					);
				}
				configPath = candidate;
				try {
					root = YAML.parse(content);
				} catch (error) {
					throw new Error(
						`Persistent host settings config ${candidate} is not valid YAML: ${
							error instanceof Error ? error.message : String(error)
						}`,
						error instanceof Error ? { cause: error } : undefined,
					);
				}
				break;
			}
			// No profile yet: nothing is persisted, every path is absent.
			if (configPath === undefined || root === null || root === undefined) {
				return preImage;
			}
			if (typeof root !== "object" || Array.isArray(root)) {
				throw new Error(
					`Persistent host settings config ${configPath} must contain a YAML mapping at the root`,
				);
			}
			for (const hostPath of Object.keys(
				HOST_SETTING_SEGMENTS,
			) as HostSettingPath[]) {
				preImage[hostPath] = rawPersistentState(
					root,
					HOST_SETTING_SEGMENTS[hostPath],
				);
			}
			return preImage;
		},
	};
}
