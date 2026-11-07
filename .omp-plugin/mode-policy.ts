import {
	type CompactMode,
	type CompactSettings,
	type CompactSettingsStore,
	DEFAULT_SETTINGS,
	type ToolDisplay,
} from "./config";

/** Immutable runtime-mode snapshot of one logical run. */
export interface RunModeSnapshot {
	mode: CompactMode;
	enabled: boolean;
	retainGitLive: boolean;
	compactVibeRows: boolean;
	/** Per-tool display choices (settings are frozen, so shared, not copied). */
	tools: Readonly<Record<string, ToolDisplay>>;
}

export const DEFAULT_RUN_MODE: Readonly<RunModeSnapshot> = Object.freeze({
	mode: DEFAULT_SETTINGS.mode,
	enabled: DEFAULT_SETTINGS.enabled,
	retainGitLive: DEFAULT_SETTINGS.retainGitLive,
	compactVibeRows: DEFAULT_SETTINGS.compactVibeRows,
	tools: DEFAULT_SETTINGS.tools,
});

export function runModeFromSettings(
	settings: CompactSettings,
): RunModeSnapshot {
	return {
		mode: settings.mode,
		enabled: settings.enabled,
		retainGitLive: settings.retainGitLive,
		compactVibeRows: settings.compactVibeRows,
		tools: settings.tools,
	};
}

/**
 * Settings → runtime-mode policy. One immutable snapshot per logical run,
 * captured at `prepareRun` (agent_start); the ledger keeps it for the whole
 * run, so toolUse/willContinue continuations keep the mode that started the
 * run. Dialog saves and env overrides reach `#current` through the store
 * subscription and apply at the next run boundary. External JSON file edits
 * that bypass the store are picked up at the next session boundary
 * (`dispose` clears state, then `ready` re-resolves). Fail-open: before the
 * first settings resolution the runtime is enabled with `live` defaults.
 */
export class ModePolicy {
	readonly #store: CompactSettingsStore;
	#unsubscribe: () => void;
	#disposed = false;
	/** Bumped on every dispose so in-flight loads cannot write after teardown. */
	#generation = 0;
	#resolved: Promise<CompactSettings> | undefined;
	#current: CompactSettings | undefined;

	constructor(store: CompactSettingsStore) {
		this.#store = store;
		this.#unsubscribe = store.subscribe((settings) => {
			this.#current = settings;
		});
	}

	/**
	 * Re-arm the store subscription after `dispose()` (session reinit): the
	 * policy object is reused across session switches, so the first
	 * prime/ready/prepareRun of the new session must observe store
	 * notifications again. No-op while subscribed.
	 */
	#resubscribe(): void {
		if (!this.#disposed) return;
		this.#disposed = false;
		this.#unsubscribe = this.#store.subscribe((settings) => {
			this.#current = settings;
		});
	}

	/** Start resolving settings immediately so the first run boundary is cheap. */
	prime(): void {
		this.#resubscribe();
		void this.#resolve();
	}

	/**
	 * Resolves once the FIRST settings resolution has settled (fail-open:
	 * never rejects — the store normalizes malformed/missing config to
	 * defaults).
	 */
	async ready(): Promise<void> {
		this.#resubscribe();
		if (this.#current) return;
		try {
			await this.#resolve();
		} catch {
			// Fail open: the defaults below govern the first run.
		}
	}

	/**
	 * The snapshot a run restored from the session's history freezes: the
	 * currently selected settings, so a resumed session presents its past
	 * runs the way the user has chosen to see runs now. Persisted settings
	 * are never modified.
	 */
	historical(): RunModeSnapshot {
		return runModeFromSettings(this.#current ?? DEFAULT_SETTINGS);
	}

	#resolve(): Promise<CompactSettings> {
		// #resolved is cleared by dispose() and re-populated on the next call.
		// Across a session boundary store.load() re-reads the config file and
		// env overrides, which can differ — capture the generation at start
		// and only commit #current when that generation is still live.
		if (!this.#resolved) {
			const generation = this.#generation;
			this.#resolved = this.#store.load().then((settings) => {
				if (generation !== this.#generation) return settings;
				this.#current = settings;
				return settings;
			});
		}
		return this.#resolved;
	}

	/**
	 * Capture the snapshot for the next logical run from the latest settings
	 * (resolved by `ready()` at `session_start`, store notifications
	 * afterwards; the defaults until the first load lands). Synchronous so the
	 * run exists before its first tool event.
	 */
	prepareRun(): RunModeSnapshot {
		this.#resubscribe();
		return runModeFromSettings(this.#current ?? DEFAULT_SETTINGS);
	}

	/**
	 * Session teardown: detach the store subscription exactly once so
	 * notifications can never outlive the instance, and drop the resolved
	 * state so a reinitialized session re-reads fresh settings at its first
	 * boundary. Idempotent; the policy stays usable afterwards
	 * (prime/ready/prepareRun re-arm the subscription).
	 */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#generation++;
		this.#unsubscribe();
		this.#unsubscribe = () => {};
		this.#resolved = undefined;
		this.#current = undefined;
	}
}
