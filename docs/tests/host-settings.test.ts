import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createHostSettingsBridge,
	createSessionSettingsApi,
	createSessionSettingsResolver,
	type HostSettingPath,
	type HostSettingsApi,
	HostSettingsApplyError,
	type PersistentPreImage,
	type SessionSettingsLike,
} from "../../.omp-plugin/host-settings";

// ────────────────────────────────────────────────────────────────────────────
// Fake stock Settings API
// ────────────────────────────────────────────────────────────────────────────

class FakeHostSettingsApi implements HostSettingsApi {
	/** Raw persistent values as stored in the active profile YAML. */
	persistentValues = new Map<HostSettingPath, unknown>();
	/** Runtime overrides masking the persistent values (never persisted). */
	overrides = new Map<HostSettingPath, unknown>();
	setCalls: Array<[HostSettingPath, unknown]> = [];
	flushCalls = 0;
	persistentCalls = 0;
	/** Errors consumed in order by successive flush() calls. */
	flushErrors: Error[] = [];
	/** Errors consumed in order by successive persistent() calls. */
	persistentErrors: Error[] = [];

	get(path: HostSettingPath): unknown {
		if (this.overrides.has(path)) return this.overrides.get(path);
		return this.persistentValues.has(path)
			? this.persistentValues.get(path)
			: undefined;
	}

	set(path: HostSettingPath, value: unknown): void {
		this.setCalls.push([path, value]);
		// Mirrors stock Settings: set(path, undefined) drops the key from the
		// persisted YAML (bun YAML.stringify omits undefined leaves), so absence
		// is restored by deleting rather than storing undefined.
		if (value === undefined) this.persistentValues.delete(path);
		else this.persistentValues.set(path, value);
	}

	async persistent(): Promise<PersistentPreImage> {
		this.persistentCalls += 1;
		const error = this.persistentErrors.shift();
		if (error) throw error;
		return {
			"recap.enabled": this.persistentValues.has("recap.enabled")
				? { present: true, value: this.persistentValues.get("recap.enabled") }
				: { present: false, value: undefined },
			hideThinkingBlock: this.persistentValues.has("hideThinkingBlock")
				? { present: true, value: this.persistentValues.get("hideThinkingBlock") }
				: { present: false, value: undefined },
		};
	}

	async flush(): Promise<void> {
		this.flushCalls += 1;
		const error = this.flushErrors.shift();
		if (error) throw error;
	}
}

function makeHarness(
	opts: {
		persistent?: Partial<Record<HostSettingPath, unknown>>;
		runtimeOverrides?: Partial<Record<HostSettingPath, unknown>>;
		flushErrors?: Error[];
		persistentErrors?: Error[];
		warn?: (msg: string) => void;
	} = {},
) {
	const api = new FakeHostSettingsApi();
	for (const [path, value] of Object.entries(opts.persistent ?? {})) {
		api.persistentValues.set(path as HostSettingPath, value);
	}
	for (const [path, value] of Object.entries(opts.runtimeOverrides ?? {})) {
		api.overrides.set(path as HostSettingPath, value);
	}
	api.flushErrors = opts.flushErrors ?? [];
	api.persistentErrors = opts.persistentErrors ?? [];
	const warns: string[] = [];
	const bridge = createHostSettingsBridge({
		api,
		warn: opts.warn ?? ((msg) => warns.push(msg)),
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
		const { bridge } = makeHarness({ persistent: { "recap.enabled": false } });
		expect(bridge.read()).toEqual({
			recapEnabled: false,
			thinkingBlocksVisible: true,
		});
	});

	test("inverts hideThinkingBlock into thinkingBlocksVisible", () => {
		const hidden = makeHarness({ persistent: { hideThinkingBlock: true } });
		expect(hidden.bridge.read().thinkingBlocksVisible).toBe(false);

		const shown = makeHarness({ persistent: { hideThinkingBlock: false } });
		expect(shown.bridge.read().thinkingBlocksVisible).toBe(true);
	});

	test("malformed values fail open to schema defaults with warn-once", () => {
		const { bridge, warns } = makeHarness({
			persistent: { "recap.enabled": "yes", hideThinkingBlock: 1 },
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
			persistent: { "recap.enabled": "yes", hideThinkingBlock: true },
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
		const { bridge, api } = makeHarness({ persistent: { "recap.enabled": true } });
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
			persistent: { "recap.enabled": false, hideThinkingBlock: false },
		});
		const result = await bridge.apply({ recapEnabled: true });
		expect(api.setCalls).toEqual([["recap.enabled", true]]);
		expect(result.changed).toEqual(["recapEnabled"]);
	});

	test("no-op apply writes nothing", async () => {
		const { bridge, api } = makeHarness({
			persistent: { "recap.enabled": false, hideThinkingBlock: true },
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
			persistent: { "recap.enabled": true, hideThinkingBlock: false },
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
			persistent: { "recap.enabled": true },
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

	test("failed flush restores the raw persistent pre-image, not an override-masked effective value", async () => {
		// Persistent global config: hideThinkingBlock=false. A runtime override
		// masks the effective value to true (menu shows thinking hidden). A
		// failed flush must restore the persistent false — never write the
		// masked effective true into the global config.
		const { bridge, api } = makeHarness({
			persistent: { "recap.enabled": true, hideThinkingBlock: false },
			runtimeOverrides: { hideThinkingBlock: true },
			flushErrors: [flushError()],
		});
		// Menu mirror shows the masked effective value.
		expect(bridge.read()).toEqual({
			recapEnabled: true,
			thinkingBlocksVisible: false,
		});

		let caught: unknown;
		try {
			await bridge.apply({ thinkingBlocksVisible: true });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(HostSettingsApplyError);

		// Forward write of the requested value, then rollback to the RAW
		// persistent value (false) — never the masked effective value (true).
		expect(api.setCalls).toEqual([
			["hideThinkingBlock", false],
			["hideThinkingBlock", false],
		]);
		expect(api.persistentValues.get("hideThinkingBlock")).toBe(false);
		expect(api.flushCalls).toBe(2);
		// The runtime override still masks the effective view after rollback.
		expect(bridge.read()).toEqual({
			recapEnabled: true,
			thinkingBlocksVisible: false,
		});
	});

	test("failed flush restores absence for a path absent from the persistent config", async () => {
		// hideThinkingBlock is not in the global config (schema default
		// applies). A failed flush must remove the key again so the default
		// keeps applying — not write any value into the global config.
		const { bridge, api } = makeHarness({
			persistent: { "recap.enabled": true },
			flushErrors: [flushError()],
		});
		let caught: unknown;
		try {
			await bridge.apply({ thinkingBlocksVisible: false });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(HostSettingsApplyError);
		// Forward write, then rollback removes the key (set undefined).
		expect(api.setCalls).toEqual([
			["hideThinkingBlock", true],
			["hideThinkingBlock", undefined],
		]);
		expect(api.persistentValues.has("hideThinkingBlock")).toBe(false);
		expect(bridge.read().thinkingBlocksVisible).toBe(true);
	});

	test("failed flush restores a malformed raw persistent value exactly", async () => {
		// The persistent value is a non-boolean string; effective reads fail
		// open to the schema default (existing semantics). Rollback must
		// restore the exact raw "yes", not the normalized default.
		const { bridge, api } = makeHarness({
			persistent: { "recap.enabled": "yes" },
			flushErrors: [flushError()],
		});
		expect(bridge.read().recapEnabled).toBe(true);
		let caught: unknown;
		try {
			await bridge.apply({ recapEnabled: false });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(HostSettingsApplyError);
		expect(api.setCalls).toEqual([
			["recap.enabled", false],
			["recap.enabled", "yes"],
		]);
		expect(api.persistentValues.get("recap.enabled")).toBe("yes");
	});

	test("fails closed before any mutation when the persistent pre-image cannot be read", async () => {
		// Without a trustworthy raw pre-image, an apply that later fails could
		// not be rolled back exactly. The bridge must refuse before set() —
		// never mutate, never flush, never claim rollback safety.
		const { bridge, api } = makeHarness({
			persistent: { "recap.enabled": true },
			persistentErrors: [new Error("EACCES: permission denied")],
		});
		let caught: unknown;
		try {
			await bridge.apply({ recapEnabled: false });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(HostSettingsApplyError);
		expect((caught as HostSettingsApplyError).message).toMatch(
			/refusing to apply/i,
		);
		expect(api.setCalls).toEqual([]);
		expect(api.flushCalls).toBe(0);
		expect(api.persistentCalls).toBe(1);
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
			getAgentDir: () => "/tmp/fake-agent",
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

	test("a throwing session.settings getter fails open to undefined without throwing", () => {
		const session: { sessionManager: unknown; settings?: SessionSettingsLike } =
			{ sessionManager: mainManager };
		Object.defineProperty(session, "settings", {
			configurable: true,
			get() {
				throw new Error("session settings unavailable");
			},
		});
		const resolve = createSessionSettingsResolver(
			registryWith({ id: "Main", session }),
		);
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
			getAgentDir: () => "/tmp/fake-agent",
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
			getAgentDir: () => "/tmp/fake-agent",
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
			getAgentDir: () => "/tmp/fake-agent",
		};
		const api = createSessionSettingsApi(sessionSettings);
		await expect(api.flush()).rejects.toThrow("disk full");
	});

	test("persistent() reads the raw active profile YAML including key absence", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "omp-host-settings-"));
		try {
			await writeFile(
				join(agentDir, "config.yml"),
				"recap:\n  enabled: false\nhideThinkingBlock: true\n",
			);
			const api = createSessionSettingsApi({
				getAgentDir: () => agentDir,
				get: () => undefined,
				set: () => {},
				flush: async () => {},
			});
			await expect(api.persistent()).resolves.toEqual({
				"recap.enabled": { present: true, value: false },
				hideThinkingBlock: { present: true, value: true },
			});
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	test("persistent() falls back to config.yaml when config.yml is absent", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "omp-host-settings-"));
		try {
			await writeFile(join(agentDir, "config.yaml"), "hideThinkingBlock: true\n");
			const api = createSessionSettingsApi({
				getAgentDir: () => agentDir,
				get: () => undefined,
				set: () => {},
				flush: async () => {},
			});
			await expect(api.persistent()).resolves.toEqual({
				"recap.enabled": { present: false, value: undefined },
				hideThinkingBlock: { present: true, value: true },
			});
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	test("persistent() treats a missing profile as all-absent (trustworthy pre-image)", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "omp-host-settings-"));
		try {
			const api = createSessionSettingsApi({
				getAgentDir: () => agentDir,
				get: () => undefined,
				set: () => {},
				flush: async () => {},
			});
			await expect(api.persistent()).resolves.toEqual({
				"recap.enabled": { present: false, value: undefined },
				hideThinkingBlock: { present: false, value: undefined },
			});
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	test("persistent() rejects invalid profile YAML (fail-closed seam)", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "omp-host-settings-"));
		try {
			await writeFile(join(agentDir, "config.yml"), "::: not yaml :::\n- ]\n");
			const api = createSessionSettingsApi({
				getAgentDir: () => agentDir,
				get: () => undefined,
				set: () => {},
				flush: async () => {},
			});
			await expect(api.persistent()).rejects.toThrow(/not valid YAML/i);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});
