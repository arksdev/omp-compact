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
				autoShake: { ...current.autoShake, ...(patch.autoShake ?? {}) },
				host: { ...current.host, ...(patch.host ?? {}) },
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
	test("fails open to enabled live defaults before any settings resolution", async () => {
		const policy = new ModePolicy(fakeStore());
		expect(policy.enabled).toBe(true);
		expect(policy.run).toBeUndefined();
		await expect(policy.prepareRun()).resolves.toEqual(DEFAULT_RUN_MODE);
		expect(policy.enabled).toBe(true);
	});

	test("captures one immutable snapshot per logical run", async () => {
		const store = fakeStore(settings({ mode: "compact" }));
		const policy = new ModePolicy(store);
		policy.prime();
		const snapshot = await policy.prepareRun();
		expect(snapshot.mode).toBe("compact");
		// A mid-run settings change must never mix into the active run.
		await store.update({ mode: "clear" });
		expect(policy.run?.mode).toBe("compact");
		expect(policy.enabled).toBe(true);
		// The next run boundary picks the change up.
		const next = await policy.prepareRun();
		expect(next.mode).toBe("clear");
		expect(next).not.toBe(snapshot);
	});

	test("mid-run global disable applies only at the next run boundary", async () => {
		const store = fakeStore();
		const policy = new ModePolicy(store);
		await policy.prepareRun();
		expect(policy.enabled).toBe(true);
		await store.update({ enabled: false });
		// The frozen run snapshot keeps the runtime alive mid-run.
		expect(policy.enabled).toBe(true);
		const next = await policy.prepareRun();
		expect(next.enabled).toBe(false);
		expect(policy.enabled).toBe(false);
	});

	test("re-enable reinstalls cleanly at a later boundary", async () => {
		const store = fakeStore();
		const policy = new ModePolicy(store);
		await policy.prepareRun();
		await store.update({ enabled: false });
		await policy.prepareRun();
		expect(policy.enabled).toBe(false);
		await store.update({ enabled: true, mode: "compact" });
		const next = await policy.prepareRun();
		expect(next.enabled).toBe(true);
		expect(next.mode).toBe("compact");
	});

	test("prime resolves once and later prepareRun calls reuse it", async () => {
		const store = fakeStore(settings({ mode: "clear" }));
		const policy = new ModePolicy(store);
		policy.prime();
		await policy.prepareRun();
		await policy.prepareRun();
		expect(store.loadCount()).toBe(1);
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
		expect(policy.enabled).toBe(false);
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
		expect(policy.enabled).toBe(true);
	});

	test("ready is idempotent and resolves immediately once loaded", async () => {
		const store = fakeStore();
		const policy = new ModePolicy(store);
		await policy.ready();
		await policy.ready();
		expect(store.loadCount()).toBe(1);
	});

	test("subscribe keeps current fresh for the next boundary", async () => {
		const store = fakeStore();
		const policy = new ModePolicy(store);
		await policy.prepareRun();
		await store.update({ retainGitLive: false });
		expect(policy.current?.retainGitLive).toBe(false);
		expect((await policy.prepareRun()).retainGitLive).toBe(false);
	});
});

describe("ModePolicy disposal", () => {
	test("dispose unsubscribes exactly once and is idempotent", async () => {
		const store = fakeStore(settings({ mode: "compact" }));
		const policy = new ModePolicy(store);
		await policy.prepareRun();
		policy.dispose();
		policy.dispose();
		expect(store.unsubscribed()).toBe(1);
		// the detached policy observes no further store notifications and
		// keeps no stale settings or run snapshot
		await store.update({ mode: "clear" });
		expect(policy.current).toBeUndefined();
		expect(policy.run).toBeUndefined();
	});

	test("prime re-arms the subscription after dispose", async () => {
		const store = fakeStore(settings({ mode: "compact" }));
		const policy = new ModePolicy(store);
		policy.prime();
		await policy.ready();
		policy.dispose();
		expect(store.unsubscribed()).toBe(1);
		// a store change after dispose is invisible to the detached policy
		await store.update({ mode: "clear" });
		expect(policy.current).toBeUndefined();
		// prime re-arms: a fresh resolve + a live subscription again
		policy.prime();
		await policy.ready();
		expect(policy.current?.mode).toBe("clear");
		await store.update({ mode: "live" });
		expect(policy.current?.mode).toBe("live");
	});

	test("ready and prepareRun stay usable after dispose", async () => {
		const store = fakeStore(settings({ enabled: false }));
		const policy = new ModePolicy(store);
		await policy.prepareRun();
		policy.dispose();
		// a new session re-reads fresh settings without an explicit prime
		await expect(policy.ready()).resolves.toBeUndefined();
		expect(policy.enabled).toBe(false);
		expect((await policy.prepareRun()).enabled).toBe(false);
		// the re-armed subscription observes later updates again
		await store.update({ enabled: true });
		expect(policy.current?.enabled).toBe(true);
	});

	test("dispose clears the frozen run snapshot", async () => {
		const store = fakeStore();
		const policy = new ModePolicy(store);
		await policy.prepareRun();
		expect(policy.run).toBeDefined();
		policy.dispose();
		expect(policy.run).toBeUndefined();
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

		// Session B: prepareRun starts a fresh load and freezes from it.
		const prepared = policy.prepareRun();
		expect(pending.length).toBe(2);
		pending[1]?.resolve(newSettings);
		await expect(prepared).resolves.toMatchObject({ mode: "clear" });
		expect(policy.current?.mode).toBe("clear");
		expect(policy.enabled).toBe(true);

		// Late settlement of the pre-dispose load must not clobber session B.
		pending[0]?.resolve(oldSettings);
		await Promise.resolve();
		await Promise.resolve();

		expect(policy.current?.mode).toBe("clear");
		await expect(policy.prepareRun()).resolves.toMatchObject({
			mode: "clear",
		});
	});

	test("in-session load still populates current after settling", async () => {
		let resolveLoad!: (value: CompactSettings) => void;
		const loaded = settings({ mode: "live" });
		const store: CompactSettingsStore = {
			load: () =>
				new Promise<CompactSettings>((resolve) => {
					resolveLoad = resolve;
				}),
			snapshot: () => loaded,
			update: async () => loaded,
			subscribe: () => () => {},
		};

		const policy = new ModePolicy(store);
		const prepared = policy.prepareRun();
		expect(policy.current).toBeUndefined();
		resolveLoad(loaded);
		await expect(prepared).resolves.toMatchObject({ mode: "live" });
		expect(policy.current?.mode).toBe("live");
	});

	test("dispose then prepareRun re-reads fresh settings", async () => {
		let current = settings({ mode: "compact" });
		const store: CompactSettingsStore = {
			load: async () => current,
			snapshot: () => current,
			update: async () => current,
			subscribe: () => () => {},
		};
		const policy = new ModePolicy(store);

		await expect(policy.prepareRun()).resolves.toMatchObject({
			mode: "compact",
		});
		policy.dispose();
		current = settings({ mode: "clear" });
		await expect(policy.prepareRun()).resolves.toMatchObject({
			mode: "clear",
		});
		expect(policy.current?.mode).toBe("clear");
	});

	test("repeated dispose stays safe across re-arm cycles", async () => {
		const store = fakeStore(settings({ mode: "compact" }));
		const policy = new ModePolicy(store);

		await policy.prepareRun();
		policy.dispose();
		policy.dispose();
		policy.dispose();

		await expect(policy.prepareRun()).resolves.toMatchObject({
			mode: "compact",
		});
		policy.dispose();
		policy.dispose();

		await store.update({ mode: "clear" });
		expect(policy.current).toBeUndefined();

		await expect(policy.prepareRun()).resolves.toMatchObject({
			mode: "clear",
		});
		expect(policy.current?.mode).toBe("clear");
	});
});

describe("runModeFromSettings", () => {
	test("maps the mode subshape used by the runtime", () => {
		expect(runModeFromSettings(settings({}))).toEqual(DEFAULT_RUN_MODE);
		expect(
			runModeFromSettings(
				settings({ enabled: false, mode: "clear", retainGitLive: false }),
			),
		).toEqual({ mode: "clear", enabled: false, retainGitLive: false });
	});
});
