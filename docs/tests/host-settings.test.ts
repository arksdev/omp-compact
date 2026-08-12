import { describe, expect, test } from "bun:test";

import {
	createHostSettingsBridge,
	createSessionSettingsApi,
	createSessionSettingsResolver,
	type HostSettingPath,
	type HostSettingsApi,
	HostSettingsApplyError,
	type SessionSettingsLike,
} from "../../.omp-plugin/host-settings";

// ────────────────────────────────────────────────────────────────────────────
// Fake stock Settings API
// ────────────────────────────────────────────────────────────────────────────

class FakeHostSettingsApi implements HostSettingsApi {
	values = new Map<HostSettingPath, unknown>();
	setCalls: Array<[HostSettingPath, boolean]> = [];
	flushCalls = 0;
	/** Errors consumed in order by successive flush() calls. */
	flushErrors: Error[] = [];

	get(path: HostSettingPath): unknown {
		return this.values.has(path) ? this.values.get(path) : undefined;
	}

	set(path: HostSettingPath, value: boolean): void {
		this.setCalls.push([path, value]);
		this.values.set(path, value);
	}

	async flush(): Promise<void> {
		this.flushCalls += 1;
		const error = this.flushErrors.shift();
		if (error) throw error;
	}
}

function makeHarness(
	overrides: {
		values?: Partial<Record<HostSettingPath, unknown>>;
		flushErrors?: Error[];
		warn?: (msg: string) => void;
	} = {},
) {
	const api = new FakeHostSettingsApi();
	for (const [path, value] of Object.entries(overrides.values ?? {})) {
		api.values.set(path as HostSettingPath, value);
	}
	api.flushErrors = overrides.flushErrors ?? [];
	const warns: string[] = [];
	const bridge = createHostSettingsBridge({
		api,
		warn: overrides.warn ?? ((msg) => warns.push(msg)),
	});
	return { api, bridge, warns };
}

const flushError = (message = "disk full") => new Error(message);

// ────────────────────────────────────────────────────────────────────────────
// Reading effective host settings (menu mirroring)
// ────────────────────────────────────────────────────────────────────────────

describe("readHostSettings: effective host values", () => {
	test("absent recap defaults to enabled, absent thinking block defaults to visible", () => {
		const { bridge, api, warns } = makeHarness();
		expect(bridge.read()).toEqual({
			recapEnabled: true,
			thinkingBlocksVisible: true,
		});
		// Reading is pure: no host writes, no warnings for absent keys.
		expect(api.setCalls).toEqual([]);
		expect(api.flushCalls).toBe(0);
		expect(warns).toEqual([]);
	});

	test("maps recap.enabled directly", () => {
		const { bridge } = makeHarness({ values: { "recap.enabled": false } });
		expect(bridge.read()).toEqual({
			recapEnabled: false,
			thinkingBlocksVisible: true,
		});
	});

	test("inverts hideThinkingBlock into thinkingBlocksVisible", () => {
		const hidden = makeHarness({ values: { hideThinkingBlock: true } });
		expect(hidden.bridge.read().thinkingBlocksVisible).toBe(false);

		const shown = makeHarness({ values: { hideThinkingBlock: false } });
		expect(shown.bridge.read().thinkingBlocksVisible).toBe(true);
	});

	test("malformed values fail open to schema defaults with warn-once", () => {
		const { bridge, warns } = makeHarness({
			values: { "recap.enabled": "yes", hideThinkingBlock: 1 },
		});
		expect(bridge.read()).toEqual({
			recapEnabled: true,
			thinkingBlocksVisible: true,
		});
		expect(warns).toHaveLength(2);
		// Warn-once: a second read of the same malformed config stays silent.
		bridge.read();
		expect(warns).toHaveLength(2);
	});

	test("malformed one field does not mask the other's real value", () => {
		const { bridge } = makeHarness({
			values: { "recap.enabled": "yes", hideThinkingBlock: true },
		});
		expect(bridge.read()).toEqual({
			recapEnabled: true,
			thinkingBlocksVisible: false,
		});
	});

	test("unreadable host settings API fails open with warn-once instead of crashing", () => {
		const api = new FakeHostSettingsApi();
		api.get = () => {
			throw new Error("Settings not initialized");
		};
		const warns: string[] = [];
		const bridge = createHostSettingsBridge({
			api,
			warn: (msg) => warns.push(msg),
		});
		expect(bridge.read()).toEqual({
			recapEnabled: true,
			thinkingBlocksVisible: true,
		});
		expect(warns).toHaveLength(2);
		bridge.read();
		expect(warns).toHaveLength(2);
	});

	test("loading and cancelling never write host config", () => {
		const { bridge, api } = makeHarness();
		bridge.read();
		bridge.read();
		expect(api.setCalls).toEqual([]);
		expect(api.flushCalls).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Applying host settings (explicit save)
// ────────────────────────────────────────────────────────────────────────────

describe("applyHostSettings: save, flush, no reload", () => {
	test("applies both toggles with exactly one flush and no reload mechanism", async () => {
		const { bridge, api } = makeHarness();
		const result = await bridge.apply({
			recapEnabled: false,
			thinkingBlocksVisible: false,
		});
		expect(api.setCalls).toEqual([
			["recap.enabled", false],
			["hideThinkingBlock", true],
		]);
		expect(api.flushCalls).toBe(1);
		expect(result).toEqual({
			changed: ["recapEnabled", "thinkingBlocksVisible"],
			restartRequired: true,
		});
	});

	test("changes only the paths that differ from the effective host values", async () => {
		const { bridge, api } = makeHarness({ values: { "recap.enabled": true } });
		const result = await bridge.apply({
			recapEnabled: false,
			thinkingBlocksVisible: true, // unchanged: hideThinkingBlock already false
		});
		expect(api.setCalls).toEqual([["recap.enabled", false]]);
		expect(api.flushCalls).toBe(1);
		expect(result.changed).toEqual(["recapEnabled"]);
		expect(result.restartRequired).toBe(false);
	});

	test("partial patch leaves the untouched field alone", async () => {
		const { bridge, api } = makeHarness({
			values: { "recap.enabled": false, hideThinkingBlock: false },
		});
		const result = await bridge.apply({ recapEnabled: true });
		expect(api.setCalls).toEqual([["recap.enabled", true]]);
		expect(result.changed).toEqual(["recapEnabled"]);
	});

	test("no-op apply writes nothing", async () => {
		const { bridge, api } = makeHarness({
			values: { "recap.enabled": false, hideThinkingBlock: true },
		});
		const result = await bridge.apply({
			recapEnabled: false,
			thinkingBlocksVisible: false,
		});
		expect(api.setCalls).toEqual([]);
		expect(api.flushCalls).toBe(0);
		expect(result).toEqual({ changed: [], restartRequired: false });
	});

	test("flush failure rolls back to previous values and reports error", async () => {
		const { bridge, api, warns } = makeHarness({
			values: { "recap.enabled": true, hideThinkingBlock: false },
			flushErrors: [flushError()],
		});
		let caught: unknown;
		try {
			await bridge.apply({ recapEnabled: false, thinkingBlocksVisible: false });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(HostSettingsApplyError);
		// New values first, then exact rollback of both paths.
		expect(api.setCalls).toEqual([
			["recap.enabled", false],
			["hideThinkingBlock", true],
			["recap.enabled", true],
			["hideThinkingBlock", false],
		]);
		expect(api.flushCalls).toBe(2);
		expect(warns).toEqual([]);
		// In-memory effective values are restored to the pre-apply state.
		expect(bridge.read()).toEqual({
			recapEnabled: true,
			thinkingBlocksVisible: true,
		});
	});

	test("failed rollback flush is reported on the error", async () => {
		const { bridge, api } = makeHarness({
			values: { "recap.enabled": true },
			flushErrors: [flushError("first"), flushError("second")],
		});
		let caught: unknown;
		try {
			await bridge.apply({ recapEnabled: false });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(HostSettingsApplyError);
		const applyError = caught as HostSettingsApplyError;
		expect((applyError.cause as Error | undefined)?.message).toBe("first");
		expect(applyError.rollbackFailed).toBe(true);
		expect(api.flushCalls).toBe(2);
	});

	test("thinking change reports restartRequired with no reload surface at all", async () => {
		// There is no reload dependency on the bridge: thinking visibility has
		// no safe live refresh in stock, so the caller only learns it must
		// report restartRequired honestly.
		const api = new FakeHostSettingsApi();
		const bridge = createHostSettingsBridge({ api });
		const result = await bridge.apply({
			recapEnabled: false,
			thinkingBlocksVisible: false,
		});
		expect(api.setCalls).toEqual([
			["recap.enabled", false],
			["hideThinkingBlock", true],
		]);
		expect(api.flushCalls).toBe(1);
		expect(result.restartRequired).toBe(true);
		expect(result).not.toHaveProperty("reloaded");
	});

	test("concurrent applies coalesce to one save and one flush", async () => {
		const { bridge, api } = makeHarness();
		const [first, second] = await Promise.all([
			bridge.apply({ recapEnabled: false, thinkingBlocksVisible: false }),
			bridge.apply({ recapEnabled: false, thinkingBlocksVisible: false }),
		]);
		expect(first).toEqual(second);
		expect(api.setCalls).toEqual([
			["recap.enabled", false],
			["hideThinkingBlock", true],
		]);
		expect(api.flushCalls).toBe(1);
	});

	test("session switch after apply never re-applies", async () => {
		const { bridge, api } = makeHarness();
		const result = await bridge.apply({
			recapEnabled: false,
			thinkingBlocksVisible: false,
		});
		expect(result.changed).toEqual(["recapEnabled", "thinkingBlocksVisible"]);
		// Simulated new session: menu re-reads effective values, nothing writes.
		expect(bridge.read()).toEqual({
			recapEnabled: false,
			thinkingBlocksVisible: false,
		});
		bridge.dispose();
		expect(bridge.read()).toEqual({
			recapEnabled: false,
			thinkingBlocksVisible: false,
		});
		expect(api.setCalls).toEqual([
			["recap.enabled", false],
			["hideThinkingBlock", true],
		]);
		expect(api.flushCalls).toBe(1);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Live main-session Settings resolution (never the exported global proxy)
// ────────────────────────────────────────────────────────────────────────────

describe("createSessionSettingsResolver", () => {
	const mainManager = { id: "main-manager" };
	const subManager = { id: "sub-manager" };

	function sessionWith(
		manager: unknown,
		settings: SessionSettingsLike | undefined,
	) {
		return { sessionManager: manager, settings };
	}

	function registryWith(
		ref:
			| {
					id?: string;
					kind?: string;
					status?: string;
					session:
						| ReturnType<typeof sessionWith>
						| { sessionManager: unknown; settings?: SessionSettingsLike }
						| null;
			  }
			| undefined,
	) {
		return {
			global: () => ({
				get: (id: string) =>
					ref && ref.id === id
						? {
								id: ref.id ?? "Main",
								kind: ref.kind ?? "main",
								status: ref.status ?? "idle",
								session: ref.session,
							}
						: undefined,
			}),
		};
	}

	test("resolves session.settings of the main session only when its manager matches the context", () => {
		const sessionSettings: SessionSettingsLike = {
			get: () => undefined,
			set: () => {},
			flush: async () => {},
		};
		const resolve = createSessionSettingsResolver(
			registryWith({
				id: "Main",
				session: sessionWith(mainManager, sessionSettings),
			}),
		);
		expect(resolve({ sessionManager: mainManager })).toBe(sessionSettings);
		// A subagent command context must never resolve the main session's
		// settings: identity mismatch fails open to unavailable.
		expect(resolve({ sessionManager: subManager })).toBeUndefined();
	});

	test("returns undefined when the registry has no session attached", () => {
		const resolve = createSessionSettingsResolver(
			registryWith({ id: "Main", session: null }),
		);
		expect(resolve({ sessionManager: mainManager })).toBeUndefined();
	});

	test("returns undefined when the session exposes no settings surface", () => {
		const resolve = createSessionSettingsResolver(
			registryWith({
				id: "Main",
				session: sessionWith(mainManager, undefined),
			}),
		);
		expect(resolve({ sessionManager: mainManager })).toBeUndefined();
	});

	test("returns undefined when the registry is absent or not callable", () => {
		expect(
			createSessionSettingsResolver(undefined)({ sessionManager: mainManager }),
		).toBeUndefined();
		expect(
			createSessionSettingsResolver({ global: undefined } as never)({
				sessionManager: mainManager,
			}),
		).toBeUndefined();
	});

	test("returns undefined when the registry getter throws", () => {
		const resolve = createSessionSettingsResolver({
			global: () => {
				throw new Error("registry broken");
			},
		});
		expect(resolve({ sessionManager: mainManager })).toBeUndefined();
	});

	test("never accesses an exported-global settings proxy (reported failure path)", () => {
		// Stock `settings` is a Proxy that throws on ANY property access while
		// `Settings.init()` has not been called. The resolver must fail open
		// to unavailable and must never touch such a global.
		const throwingGlobal = new Proxy({} as Record<string, never>, {
			get() {
				throw new Error(
					"Settings not initialized. Call Settings.init() first.",
				);
			},
		});
		const resolve = createSessionSettingsResolver(throwingGlobal);
		expect(() => resolve({ sessionManager: mainManager })).not.toThrow();
		expect(resolve({ sessionManager: mainManager })).toBeUndefined();
	});

	test("healthy resolution routes values through session.settings only", () => {
		const getCalls: string[] = [];
		const sessionSettings: SessionSettingsLike = {
			get: (path) => {
				getCalls.push(path);
				return true;
			},
			set: () => {},
			flush: async () => {},
		};
		const resolve = createSessionSettingsResolver(
			registryWith({
				id: "Main",
				session: sessionWith(mainManager, sessionSettings),
			}),
		);
		const api = createSessionSettingsApi(
			resolve({ sessionManager: mainManager }) as SessionSettingsLike,
		);
		expect(api.get("recap.enabled")).toBe(true);
		expect(getCalls).toEqual(["recap.enabled"]);
	});
});

describe("createSessionSettingsApi", () => {
	test("delegates get/set/flush to the exact injected instance", async () => {
		const getCalls: string[] = [];
		const setCalls: Array<[string, unknown]> = [];
		let flushCalls = 0;
		const sessionSettings: SessionSettingsLike = {
			get: (path) => {
				getCalls.push(path);
				return undefined;
			},
			set: (path, value) => {
				setCalls.push([path, value]);
			},
			flush: async () => {
				flushCalls += 1;
			},
		};
		const api = createSessionSettingsApi(sessionSettings);
		api.get("recap.enabled");
		api.set("recap.enabled", false);
		api.set("hideThinkingBlock", true);
		await api.flush();
		expect(getCalls).toEqual(["recap.enabled"]);
		expect(setCalls).toEqual([
			["recap.enabled", false],
			["hideThinkingBlock", true],
		]);
		expect(flushCalls).toBe(1);
	});

	test("flush failures propagate to the caller", async () => {
		const sessionSettings: SessionSettingsLike = {
			get: () => undefined,
			set: () => {},
			flush: async () => {
				throw new Error("disk full");
			},
		};
		const api = createSessionSettingsApi(sessionSettings);
		await expect(api.flush()).rejects.toThrow("disk full");
	});
});
