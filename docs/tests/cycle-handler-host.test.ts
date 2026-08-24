import { describe, expect, test } from "bun:test";

import type {
	CompactSettings,
	CompactSettingsStore,
} from "../../.omp-plugin/config";
import { DEFAULT_SETTINGS } from "../../.omp-plugin/config";
import { cycleDisplayState } from "../../.omp-plugin/cycle-handler";
import {
	createHostSettingsBridge,
	type HostSettingsApi,
} from "../../.omp-plugin/host-settings";

/**
 * Display cycle must never write stock host settings. The bridge's `apply`
 * diffs its payload against the live effective `read()` (host-settings.ts
 * runApply), so `cycleDisplayState` must seed the saved payload's host group
 * from `bridge.read()` — exactly like the settings dialog does (index.ts
 * host: hostBridge ? hostBridge.read() : initial.host). A store-snapshot
 * host group would be silently reconciled with the live host on a pure
 * mode-cycle keypress: an install with no persisted host section carries
 * DEFAULT_HOST ({recapEnabled: true, thinkingBlocksVisible: true}) and would
 * re-enable stock recap / un-hide thinking blocks a user had turned off.
 */
describe("display cycle: host settings are never touched", () => {
	function fakeTheme() {
		return {
			fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[39m`,
			bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
			italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
			underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
		};
	}

	/** Live host state that diverges from the plugin's DEFAULT_HOST: recap
	 * disabled, thinking blocks hidden. */
	function makeApi() {
		const hostValues: Record<string, unknown> = {
			"recap.enabled": false,
			hideThinkingBlock: true,
		};
		const writes: Array<{ path: string; value: unknown }> = [];
		let flushes = 0;
		const api: HostSettingsApi = {
			get: (path) => hostValues[path],
			set: (path, value) => {
				writes.push({ path, value });
				hostValues[path] = value;
			},
			flush: async () => {
				flushes += 1;
			},
			persistent: async () => ({
				"recap.enabled": { present: true, value: false },
				hideThinkingBlock: { present: true, value: true },
			}),
		};
		return { api, writes, flushes: () => flushes };
	}

	function cycleHarness(settings: CompactSettings) {
		const notifies: Array<["info" | "warning", string]> = [];
		const saved: CompactSettings[] = [];
		const store = {
			load: async () => settings,
			update: async (next: CompactSettings) => {
				saved.push(next);
				return next;
			},
			overrides: () => ({ enabledBy: [], modeBy: undefined }),
		} as unknown as CompactSettingsStore;
		return {
			notifies,
			saved,
			deps: {
				store,
				theme: fakeTheme(),
				notify: (level: "info" | "warning", message: string) => {
					notifies.push([level, message]);
				},
			},
		};
	}

	test("a keypress with a diverged host still persists the cycle step and writes nothing to the host", async () => {
		const { api, writes, flushes } = makeApi();
		const { deps, saved } = cycleHarness({
			...DEFAULT_SETTINGS,
			enabled: true,
			mode: "clear",
		});
		await cycleDisplayState({
			...deps,
			bridge: createHostSettingsBridge({ api }),
		});

		// The cycle step itself persists.
		expect(saved).toHaveLength(1);
		expect(saved[0]?.enabled).toBe(false);
		expect(saved[0]?.mode).toBe("clear");
		// The saved payload's host group mirrors the live host (recap disabled,
		// thinking blocks hidden) — never the plugin's DEFAULT_HOST.
		expect(saved[0]?.host).toEqual({
			recapEnabled: false,
			thinkingBlocksVisible: false,
		});
		// Observable contract: cycling the display never mutates or flushes
		// stock host settings, even when store host state differs from live.
		expect(writes).toEqual([]);
		expect(flushes()).toBe(0);
	});

	test("without a bridge the host group is carried through untouched", async () => {
		const { deps, saved } = cycleHarness({
			...DEFAULT_SETTINGS,
			enabled: true,
			mode: "clear",
		});
		await cycleDisplayState(deps);
		expect(saved).toHaveLength(1);
		expect(saved[0]?.host).toEqual(DEFAULT_SETTINGS.host);
	});
});
