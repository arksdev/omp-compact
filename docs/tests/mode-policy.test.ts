import { describe, expect, test } from "bun:test";

import {
	type CompactSettings,
	type CompactSettingsPatch,
	type CompactSettingsStore,
	DEFAULT_SETTINGS,
} from "../../.omp-plugin/config";
import {
	DEFAULT_RUN_MODE,
	ModePolicy,
	runModeFromSettings,
} from "../../.omp-plugin/mode-policy";

function fakeStore(initial?: CompactSettings): CompactSettingsStore & {
	current(): CompactSettings;
	loadCount(): number;
	unsubscribed(): number;
} {
	let current = initial ?? DEFAULT_SETTINGS;
	let loads = 0;
	let unsubscribes = 0;
	const subscribers = new Set<(settings: CompactSettings) => void>();
	return {
		current: () => current,
		loadCount: () => loads,
		unsubscribed: () => unsubscribes,
		load: async () => {
			loads++;
			return current;
		},
		snapshot: () => current,
		update: async (patch: CompactSettingsPatch) => {
			current = {
				...current,
				...patch,
				stats: { ...current.stats, ...(patch.stats ?? {}) },
			} as CompactSettings;
			for (const fn of [...subscribers]) fn(current);
			return current;
		},
		subscribe: (fn) => {
			subscribers.add(fn);
			return () => {
				unsubscribes++;
				subscribers.delete(fn);
			};
		},
	};
}

function settings(
	overrides: Partial<
		Pick<CompactSettings, "enabled" | "mode" | "retainGitLive">
	>,
): CompactSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("ModePolicy run snapshots", () => {
	test("fails open to enabled live defaults before any settings resolution", () => {
		const policy = new ModePolicy(fakeStore());
		expect(policy.prepareRun()).toEqual(DEFAULT_RUN_MODE);
	});

	test("captures a snapshot a later settings change cannot touch", async () => {
		const store = fakeStore(settings({ mode: "compact" }));
		const policy = new ModePolicy(store);
		await policy.ready();
		const snapshot = policy.prepareRun();
		expect(snapshot.mode).toBe("compact");
		// A mid-run settings change must never mix into the active run.
		await store.update({ mode: "clear" });
		expect(snapshot.mode).toBe("compact");
		// The next run boundary picks the change up.
		const next = policy.prepareRun();
		expect(next.mode).toBe("clear");
		expect(next).not.toBe(snapshot);
	});

	test("a global disable applies at the next run boundary and can be undone", async () => {
		const store = fakeStore();
		const policy = new ModePolicy(store);
		await policy.ready();
		const running = policy.prepareRun();
		await store.update({ enabled: false });
		expect(running.enabled).toBe(true);
		expect(policy.prepareRun().enabled).toBe(false);
		await store.update({ enabled: true, mode: "compact" });
		const next = policy.prepareRun();
		expect(next.enabled).toBe(true);
		expect(next.mode).toBe("compact");
	});

	test("history uses the settings selected now", async () => {
		const store = fakeStore(settings({ mode: "compact" }));
		const policy = new ModePolicy(store);
		await policy.ready();
		await store.update({ mode: "clear" });
		expect(policy.historical().mode).toBe("clear");
	});

	test("prime resolves once and ready reuses it", async () => {
		const store = fakeStore(settings({ mode: "clear" }));
		const policy = new ModePolicy(store);
		policy.prime();
		await policy.ready();
		await policy.ready();
		expect(store.loadCount()).toBe(1);
		expect(policy.prepareRun().mode).toBe("clear");
	});

	test("ready resolves only after the first settings resolution", async () => {
		const store = fakeStore(settings({ enabled: false }));
		const policy = new ModePolicy(store);
		let settled = false;
		const ready = policy.ready().then(() => {
			settled = true;
		});
		// the resolution starts on ready(); nothing is visible yet
		expect(settled).toBe(false);
		await ready;
		expect(settled).toBe(true);
		expect(store.loadCount()).toBe(1);
		// a persisted disable is now visible before any run starts
		expect(policy.prepareRun().enabled).toBe(false);
	});

	test("ready is fail-open: a rejecting store still settles", async () => {
		const store = fakeStore();
		const policy = new ModePolicy({
			...store,
			load: async () => {
				throw new Error("config unreadable");
			},
		});
		await expect(policy.ready()).resolves.toBeUndefined();
		// defaults govern the first run
		expect(policy.prepareRun()).toEqual(DEFAULT_RUN_MODE);
	});

	test("the store subscription keeps the next boundary fresh", async () => {
		const store = fakeStore();
		const policy = new ModePolicy(store);
		await policy.ready();
		await store.update({ retainGitLive: false });
		expect(policy.prepareRun().retainGitLive).toBe(false);
	});
});

describe("ModePolicy disposal", () => {
	test("dispose unsubscribes exactly once and is idempotent", async () => {
		const store = fakeStore(settings({ mode: "compact" }));
		const policy = new ModePolicy(store);
		await policy.ready();
		policy.dispose();
		policy.dispose();
		expect(store.unsubscribed()).toBe(1);
		// the detached policy observes no further store notifications and
		// keeps no stale settings
		await store.update({ mode: "clear" });
		expect(policy.historical()).toEqual(DEFAULT_RUN_MODE);
	});

	test("ready re-reads settings and re-arms the subscription after dispose", async () => {
		const store = fakeStore(settings({ mode: "compact" }));
		const policy = new ModePolicy(store);
		await policy.ready();
		policy.dispose();
		await store.update({ mode: "clear" });
		await policy.ready();
		expect(policy.prepareRun().mode).toBe("clear");
		await store.update({ mode: "live" });
		expect(policy.prepareRun().mode).toBe("live");
	});

	test("late pre-dispose load does not overwrite post-dispose settings", async () => {
		// Reproduces the cross-session load race: an in-flight store.load()
		// started before dispose() must never write #current after a newer
		// session has already resolved its own load.
		const oldSettings = settings({ mode: "compact" });
		const newSettings = settings({ mode: "clear" });
		const pending: Array<{
			resolve: (value: CompactSettings) => void;
		}> = [];
		const store: CompactSettingsStore = {
			load: () =>
				new Promise<CompactSettings>((resolve) => {
					pending.push({ resolve });
				}),
			snapshot: () => newSettings,
			update: async () => newSettings,
			subscribe: () => () => {},
		};

		const policy = new ModePolicy(store);
		// Session A: fire-and-forget prime starts load #1 and leaves it hanging.
		policy.prime();
		expect(pending.length).toBe(1);

		policy.dispose();

		// Session B resolves a fresh load.
		const ready = policy.ready();
		expect(pending.length).toBe(2);
		pending[1]?.resolve(newSettings);
		await ready;
		expect(policy.prepareRun().mode).toBe("clear");

		// Late settlement of the pre-dispose load must not clobber session B.
		pending[0]?.resolve(oldSettings);
		await Promise.resolve();
		await Promise.resolve();

		expect(policy.prepareRun().mode).toBe("clear");
	});

	test("repeated dispose stays safe across re-arm cycles", async () => {
		const store = fakeStore(settings({ mode: "compact" }));
		const policy = new ModePolicy(store);

		await policy.ready();
		policy.dispose();
		policy.dispose();
		policy.dispose();

		await policy.ready();
		expect(policy.prepareRun().mode).toBe("compact");
		policy.dispose();
		policy.dispose();

		await store.update({ mode: "clear" });
		await policy.ready();
		expect(policy.prepareRun().mode).toBe("clear");
	});
});

describe("runModeFromSettings", () => {
	test("maps the mode subshape used by the runtime", () => {
		expect(runModeFromSettings(settings({}))).toEqual(DEFAULT_RUN_MODE);
		expect(
			runModeFromSettings(
				settings({ enabled: false, mode: "clear", retainGitLive: false }),
			),
		).toEqual({
			mode: "clear",
			enabled: false,
			retainGitLive: false,
			compactVibeRows: true,
		});
	});
});
