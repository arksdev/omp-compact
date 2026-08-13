import {
	type CompactMode,
	type CompactSettings,
	type CompactSettingsStore,
	DEFAULT_SETTINGS,
} from "./config";

/** Immutable runtime-mode snapshot of one logical run. */
export interface RunModeSnapshot {
	mode: CompactMode;
	enabled: boolean;
	retainGitLive: boolean;
}

export const DEFAULT_RUN_MODE: Readonly<RunModeSnapshot> = Object.freeze({
	mode: DEFAULT_SETTINGS.mode,
	enabled: DEFAULT_SETTINGS.enabled,
	retainGitLive: DEFAULT_SETTINGS.retainGitLive,
});

export function runModeFromSettings(
	settings: CompactSettings,
): RunModeSnapshot {
	return {
		mode: settings.mode,
		enabled: settings.enabled,
		retainGitLive: settings.retainGitLive,
	};
}

/**
 * Settings → runtime-mode policy. One immutable snapshot per logical run,
 * captured at `prepareRun` (agent_start) and never mutated mid-run, so
 * toolUse/willContinue continuations keep the mode that started the run.
 * Settings changes (dialog saves, JSON edits, env overrides) apply at the
 * next run boundary; global disable/re-enable is transactional at that
 * boundary (adapter dispose/reinstall) while the settings command stays
 * registered. Fail-open: before the first settings resolution the runtime is
 * enabled with `live` defaults, matching stock behavior.
 */
export class ModePolicy {
	readonly #store: CompactSettingsStore;
	#unsubscribe: () => void;
	#disposed = false;
	#resolved: Promise<CompactSettings> | undefined;
	#current: CompactSettings | undefined;
	#run: RunModeSnapshot | undefined;

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
	 * Called implicitly at the start of prime/ready/prepareRun so callers
	 * never need to invoke it directly.
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
	 * defaults). Session rendering awaits this before installing the runtime
	 * so a persisted `enabled=false` never sees a transient adapter.
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

	/** Immutable snapshot of the active logical run; undefined before the first run. */
	get run(): RunModeSnapshot | undefined {
		return this.#run;
	}

	/** Latest resolved settings (kept fresh by store notifications). */
	get current(): CompactSettings | undefined {
		return this.#current;
	}

	/**
	 * Whether runtime is enabled. While a run is active its frozen snapshot
	 * governs (settings changes never mix into a run); between runs the
	 * latest settings decide; before the first load the default (enabled).
	 */
	get enabled(): boolean {
		const run = this.#run;
		if (run) return run.enabled;
		return (this.#current ?? DEFAULT_SETTINGS).enabled;
	}

	#resolve(): Promise<CompactSettings> {
		// #resolved is cleared by dispose() and re-populated on the next call.
		// A concurrent prepareRun() after dispose() may race to call store.load()
		// twice; both resolve to the same data and the last write to #current wins,
		// so the race is benign. A proper once-guard is not needed here.
		if (!this.#resolved) {
			this.#resolved = this.#store.load().then((settings) => {
				this.#current = settings;
				return settings;
			});
		}
		return this.#resolved;
	}

	/**
	 * Capture the snapshot for the next logical run. Uses the latest settings
	 * (initial load on the first call, store notifications afterwards); the
	 * returned snapshot stays frozen for the whole run.
	 */
	async prepareRun(): Promise<RunModeSnapshot> {
		this.#resubscribe();
		if (!this.#current) await this.#resolve();
		this.#run = runModeFromSettings(this.#current ?? DEFAULT_SETTINGS);
		return this.#run;
	}

	/**
	 * Session teardown: detach the store subscription exactly once so
	 * notifications can never outlive the instance, and drop the resolved/
	 * snapshot state so a reinitialized session re-reads fresh settings at
	 * its first boundary. Idempotent; the policy stays usable afterwards
	 * (prime/ready/prepareRun re-arm the subscription).
	 */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		this.#unsubscribe = () => {};
		this.#resolved = undefined;
		this.#current = undefined;
		this.#run = undefined;
	}
}
