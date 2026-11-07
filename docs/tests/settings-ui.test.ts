import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type CompactSettings,
	createSettingsStore,
	DEFAULT_SETTINGS,
	type EnvOverrides,
} from "../../.omp-plugin/config";
import {
	type CycleTheme,
	DEFAULT_DISPLAY_CYCLE_KEY,
	describeShortcutConflict,
	formatDisplayCycleStatus,
	nextDisplayCycleState,
	validateDisplayCycleKey,
} from "../../.omp-plugin/display-cycle";
import {
	type CompactSettingsStore,
	cycleDisplayState,
	chooseSettingsCommandName,
	notifySaveOutcome,
	registerDisplayCycleShortcut,
	registerSettingsCommand,
	type SaveOutcome,
	saveSettingsFlow,
} from "../../.omp-plugin/settings-ui";

function stripAnsi(value: string): string {
	return Bun.stripANSI(value);
}

function fakeTheme(): CycleTheme {
	return {
		fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[39m`,
	};
}

describe("command registration", () => {
	test("prefers compact-settings when free", () => {
		expect(chooseSettingsCommandName([])).toBe("compact-settings");
		expect(chooseSettingsCommandName(["other", "compact"])).toBe(
			"compact-settings",
		);
	});

	test("falls back to omp-compact-settings when compact-settings is taken", () => {
		expect(chooseSettingsCommandName(["compact-settings"])).toBe(
			"omp-compact-settings",
		);
	});

	test("deterministic numbered fallback when both preferred names are taken", () => {
		expect(
			chooseSettingsCommandName(["compact-settings", "omp-compact-settings"]),
		).toBe("omp-compact-settings-2");
		expect(
			chooseSettingsCommandName([
				"compact-settings",
				"omp-compact-settings",
				"omp-compact-settings-2",
				"omp-compact-settings-3",
			]),
		).toBe("omp-compact-settings-4");
		// the whole numbered range occupied still yields a usable name
		const occupied = ["compact-settings", "omp-compact-settings"];
		for (let n = 2; n <= 99; n++) occupied.push(`omp-compact-settings-${n}`);
		expect(chooseSettingsCommandName(occupied)).toBe("omp-compact-settings-99");
	});

	test("registerSettingsCommand registers even when the runtime is globally disabled", () => {
		const registered: string[] = [];
		const pi = {
			getCommands: () => [],
			registerCommand: (name: string) => {
				registered.push(name);
			},
		};
		const name = registerSettingsCommand(pi, {
			description: "d",
			handler: async () => {},
		});
		expect(name).toBe("compact-settings");
		expect(registered).toEqual(["compact-settings"]);
	});

	test("registerSettingsCommand tolerates a throwing getCommands", () => {
		const pi = {
			getCommands: () => {
				throw new Error("not initialized");
			},
			registerCommand: () => {},
		};
		expect(
			registerSettingsCommand(pi, {
				description: "d",
				handler: async () => {},
			}),
		).toBe("compact-settings");
	});
});

/**
 * Save through the real flow, then report the way the settings command does
 * at close; `before` is the settings the session started from.
 */
async function saveAndReport(
	next: CompactSettings,
	deps: { store: CompactSettingsStore; notifies: Array<[string, string]> },
	before: CompactSettings = next,
): Promise<SaveOutcome> {
	const outcome = await saveSettingsFlow(next, { store: deps.store });
	notifySaveOutcome(outcome, before, (level, message) =>
		deps.notifies.push([level, message]),
	);
	return outcome;
}

function flowHarness(overrides: {
	update?: () => Promise<CompactSettings>;
	envOverrides?: EnvOverrides;
}) {
	const order: string[] = [];
	const notifies: Array<[string, string]> = [];
	const store = {
		update: async (next: CompactSettings): Promise<CompactSettings> => {
			order.push("store.update");
			if (overrides.update) return overrides.update();
			return next;
		},
		overrides: () =>
			overrides.envOverrides ?? { enabledBy: [], modeBy: undefined },
	} as unknown as CompactSettingsStore;
	return { deps: { store, notifies }, order, notifies };
}

describe("env override notification on save", () => {
	const draft: CompactSettings = DEFAULT_SETTINGS;

	test("masked enabled emits one info notification naming OMP_COMPACT_PLUGIN and still saves", async () => {
		const { deps, order, notifies } = flowHarness({
			envOverrides: { enabledBy: ["OMP_COMPACT_PLUGIN"] },
			update: async () => ({ ...draft, enabled: false }),
		});
		const result = await saveAndReport(draft, deps);
		// the save itself still succeeds and persists the requested values
		expect(order).toEqual(["store.update"]);
		expect(result.masked).toBe(true);
		expect(result.masks).toEqual([
			{ field: "enabled", effective: false, by: ["OMP_COMPACT_PLUGIN"] },
		]);
		// persisted keeps the requested value; effective stays env-forced
		expect(result.persisted.enabled).toBe(true);
		expect(result.effective.enabled).toBe(false);
		// exactly ONE notification carries both facts — no warning plus a
		// separate generic success
		expect(notifies).toHaveLength(1);
		expect(notifies[0]?.[0]).toBe("info");
		expect(notifies[0]?.[1]).toBe(
			"omp-compact settings saved; effective enabled remains false because OMP_COMPACT_PLUGIN=0",
		);
	});

	test("masked mode emits one info notification naming OMP_COMPACT_MODE", async () => {
		const { deps, notifies } = flowHarness({
			envOverrides: { enabledBy: [], modeBy: "OMP_COMPACT_MODE" },
			update: async () => ({ ...draft, mode: "clear" }),
		});
		const result = await saveAndReport(draft, deps);
		expect(result.masked).toBe(true);
		expect(result.masks).toEqual([
			{ field: "mode", effective: "clear", by: ["OMP_COMPACT_MODE"] },
		]);
		expect(notifies).toHaveLength(1);
		expect(notifies[0]?.[0]).toBe("info");
		expect(notifies[0]?.[1]).toBe(
			"omp-compact settings saved; effective mode remains clear because OMP_COMPACT_MODE=clear",
		);
	});

	test("legacy OMP_COMPACT_MODE=off mask names OMP_COMPACT_MODE, not the plugin var", async () => {
		const { deps, notifies } = flowHarness({
			envOverrides: { enabledBy: ["OMP_COMPACT_MODE"] },
			update: async () => ({ ...draft, enabled: false }),
		});
		const result = await saveAndReport(draft, deps);
		expect(result.masks).toEqual([
			{ field: "enabled", effective: false, by: ["OMP_COMPACT_MODE"] },
		]);
		expect(notifies).toHaveLength(1);
		expect(notifies[0]?.[1]).toBe(
			"omp-compact settings saved; effective enabled remains false because OMP_COMPACT_MODE=off",
		);
		expect(notifies[0]?.[1]).not.toContain("OMP_COMPACT_PLUGIN");
	});

	test("both variables masked emit one info notification naming both", async () => {
		const { deps, notifies } = flowHarness({
			envOverrides: {
				enabledBy: ["OMP_COMPACT_PLUGIN"],
				modeBy: "OMP_COMPACT_MODE",
			},
			update: async () => ({ ...draft, enabled: false, mode: "clear" }),
		});
		const result = await saveAndReport(draft, deps);
		expect(result.masked).toBe(true);
		expect(notifies).toHaveLength(1);
		expect(notifies[0]?.[1]).toBe(
			"omp-compact settings saved; effective enabled remains false because OMP_COMPACT_PLUGIN=0; effective mode remains clear because OMP_COMPACT_MODE=clear",
		);
	});

	test("no mask when requested and effective agree: exactly the plain success", async () => {
		const { deps, notifies } = flowHarness({
			envOverrides: {
				enabledBy: ["OMP_COMPACT_PLUGIN"],
				modeBy: "OMP_COMPACT_MODE",
			},
		});
		const result = await saveAndReport(draft, deps);
		expect(result.masked).toBe(false);
		expect(notifies).toEqual([["info", "omp-compact settings saved"]]);
	});

	test("a masked JSON notifies combined even when the user changed nothing overridden", async () => {
		// Only a display option changes, but the saved JSON's enabled value
		// is still currently masked by the env: the flow must not claim a
		// plain-only success.
		const { deps, notifies } = flowHarness({
			envOverrides: { enabledBy: ["OMP_COMPACT_PLUGIN"] },
			update: async () => ({ ...draft, retainGitLive: false, enabled: false }),
		});
		await saveAndReport(draft, deps);
		expect(notifies).toHaveLength(1);
		expect(notifies[0]?.[0]).toBe("info");
		expect(notifies[0]?.[1]).toBe(
			"omp-compact settings saved; effective enabled remains false because OMP_COMPACT_PLUGIN=0",
		);
	});

	// End-to-end against the REAL store on a temp config: a change runs on
	// the effective snapshot (`store.load()`) and hands that whole snapshot
	// back, so a hard override must neither reach the file nor silence the
	// masking notice.
	test("an unrelated save under OMP_COMPACT_PLUGIN=0 keeps the file's enabled and still reports the mask", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-compact-envbake-"));
		const file = join(dir, "omp-compact", "config.json");
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({ version: 1, enabled: true, mode: "compact" }),
			"utf8",
		);
		const store = createSettingsStore({
			path: file,
			env: { OMP_COMPACT_PLUGIN: "0" },
			warn: () => {},
		});
		const initial = await store.load();
		expect(initial.enabled).toBe(false);
		const notifies: Array<[string, string]> = [];
		const outcome = await saveAndReport(
			{ ...initial, compactPaths: false },
			{ store, notifies },
		);
		// The override never reaches the file…
		const raw = JSON.parse(await readFile(file, "utf8")) as CompactSettings;
		expect(raw.enabled).toBe(true);
		expect(raw.compactPaths).toBe(false);
		// …and the honesty mechanism still fires: the persisted enabled=true
		// cannot take effect while OMP_COMPACT_PLUGIN=0 is set.
		expect(outcome.persisted.enabled).toBe(true);
		expect(outcome.effective.enabled).toBe(false);
		expect(outcome.masks).toEqual([
			{ field: "enabled", effective: false, by: ["OMP_COMPACT_PLUGIN"] },
		]);
		expect(notifies).toEqual([
			[
				"info",
				"omp-compact settings saved; effective enabled remains false because OMP_COMPACT_PLUGIN=0",
			],
		]);
		await rm(dir, { recursive: true, force: true });
	});

	test("an unrelated save under OMP_COMPACT_MODE keeps the file's mode and still reports the mask", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-compact-envbake-"));
		const file = join(dir, "omp-compact", "config.json");
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({ version: 1, enabled: true, mode: "compact" }),
			"utf8",
		);
		const store = createSettingsStore({
			path: file,
			env: { OMP_COMPACT_MODE: "live" },
			warn: () => {},
		});
		const initial = await store.load();
		expect(initial.mode).toBe("live");
		const notifies: Array<[string, string]> = [];
		const outcome = await saveAndReport(
			{ ...initial, compactPaths: false },
			{ store, notifies },
		);
		const raw = JSON.parse(await readFile(file, "utf8")) as CompactSettings;
		expect(raw.mode).toBe("compact");
		expect(raw.compactPaths).toBe(false);
		expect(outcome.persisted.mode).toBe("compact");
		expect(outcome.masks).toEqual([
			{ field: "mode", effective: "live", by: ["OMP_COMPACT_MODE"] },
		]);
		expect(notifies[0]?.[1]).toBe(
			"omp-compact settings saved; effective mode remains live because OMP_COMPACT_MODE=live",
		);
		await rm(dir, { recursive: true, force: true });
	});

	test("without an override the whole snapshot persists verbatim and nothing is masked", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-compact-envbake-"));
		const file = join(dir, "omp-compact", "config.json");
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({ version: 1, enabled: true, mode: "compact" }),
			"utf8",
		);
		const store = createSettingsStore({ path: file, env: {}, warn: () => {} });
		const initial = await store.load();
		const notifies: Array<[string, string]> = [];
		const outcome = await saveAndReport(
			{ ...initial, compactPaths: false },
			{ store, notifies },
		);
		const raw = JSON.parse(await readFile(file, "utf8")) as CompactSettings;
		expect(raw.enabled).toBe(true);
		expect(raw.mode).toBe("compact");
		expect(raw.compactPaths).toBe(false);
		expect(outcome.masked).toBe(false);
		expect(notifies).toEqual([["info", "omp-compact settings saved"]]);
		await rm(dir, { recursive: true, force: true });
	});

	test("a real user edit of an env-masked field persists and is reported as masked", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-compact-envbake-"));
		const file = join(dir, "omp-compact", "config.json");
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({ version: 1, enabled: false, mode: "compact" }),
			"utf8",
		);
		const store = createSettingsStore({
			path: file,
			env: { OMP_COMPACT_PLUGIN: "0" },
			warn: () => {},
		});
		const initial = await store.load();
		const notifies: Array<[string, string]> = [];
		// The user flips the masked row to the opposite of what env forces.
		const outcome = await saveAndReport(
			{ ...initial, enabled: true },
			{ store, notifies },
		);
		const raw = JSON.parse(await readFile(file, "utf8")) as CompactSettings;
		expect(raw.enabled).toBe(true);
		expect(outcome.effective.enabled).toBe(false);
		expect(notifies[0]?.[1]).toBe(
			"omp-compact settings saved; effective enabled remains false because OMP_COMPACT_PLUGIN=0",
		);
		await rm(dir, { recursive: true, force: true });
	});
});

describe("display cycle: state machine", () => {
	test("one keypress walks compact -> live -> clear -> off -> compact", () => {
		// The whole contract in one pass: mode only ever changes between the
		// three enabled steps, enabled only ever flips into and out of off.
		const start = { enabled: true, mode: "compact" } as const;
		const live = nextDisplayCycleState(start);
		expect(live).toEqual({ enabled: true, mode: "live" });
		const clear = nextDisplayCycleState(live);
		expect(clear).toEqual({ enabled: true, mode: "clear" });
		const off = nextDisplayCycleState(clear);
		expect(off).toEqual({ enabled: false, mode: "clear" });
		expect(nextDisplayCycleState(off)).toEqual({
			enabled: true,
			mode: "compact",
		});
	});

	test("turning off keeps the last mode on disk", () => {
		// A stray keypress must not destroy the user's chosen mode: only
		// `enabled` changes on the way out.
		expect(nextDisplayCycleState({ enabled: true, mode: "clear" })).toEqual({
			enabled: false,
			mode: "clear",
		});
	});

	test("re-enabling always lands on compact, whatever mode was stored", () => {
		// The cycle order must not depend on where the user joined it, so the
		// stored mode is deliberately not resurrected.
		for (const mode of ["compact", "live", "clear"] as const) {
			expect(nextDisplayCycleState({ enabled: false, mode })).toEqual({
				enabled: true,
				mode: "compact",
			});
		}
	});
});

describe("display cycle: status line", () => {
	const theme = fakeTheme();

	test("each of the four states prints its exact line", () => {
		expect(
			stripAnsi(
				formatDisplayCycleStatus({ enabled: true, mode: "compact" }, theme),
			),
		).toBe("Compact: compact — takes effect next run");
		expect(
			stripAnsi(
				formatDisplayCycleStatus({ enabled: true, mode: "live" }, theme),
			),
		).toBe("Compact: live — takes effect next run");
		expect(
			stripAnsi(
				formatDisplayCycleStatus({ enabled: true, mode: "clear" }, theme),
			),
		).toBe("Compact: clear — takes effect next run");
		// Off is worded differently on purpose: switching the plugin off must
		// not read as just another mode swap.
		expect(
			stripAnsi(
				formatDisplayCycleStatus({ enabled: false, mode: "clear" }, theme),
			),
		).toBe("Compact: off — from the next run");
	});

	test("the mode name is colored and nothing else on the line is", () => {
		const line = formatDisplayCycleStatus(
			{ enabled: true, mode: "live" },
			theme,
		);
		// fakeTheme() wraps whatever it colors in SGR 31/39.
		expect(line).toContain("\u001b[31mlive\u001b[39m");
		expect(line.startsWith("Compact: \u001b")).toBe(true);
		expect(line.endsWith("— takes effect next run")).toBe(true);
	});

	test("off carries no color of its own", () => {
		// It must inherit the surrounding status color, so the word `off`
		// arrives without any escape sequence around it.
		const line = formatDisplayCycleStatus(
			{ enabled: false, mode: "compact" },
			theme,
		);
		expect(line).toBe("Compact: off — from the next run");
		expect(line).not.toContain("\u001b");
	});
});

describe("display cycle: shortcut validation", () => {
	test("the default chord is free and accepted", () => {
		expect(DEFAULT_DISPLAY_CYCLE_KEY).toBe("alt+c");
		expect(validateDisplayCycleKey("alt+c")).toBeUndefined();
	});

	test("taken chords are the host's answer, worded for the dialog", () => {
		expect(describeShortcutConflict("ctrl+c", { kind: "reserved" })).toBe(
			"ctrl+c is already taken by OMP; pick another shortcut",
		);
		expect(
			describeShortcutConflict("alt+p", {
				kind: "keybinding",
				keybindings: ["app.model.select"],
			}),
		).toBe("alt+p is already bound to app.model.select; pick another shortcut");
		expect(
			describeShortcutConflict("alt+x", {
				kind: "extension",
				extensionPath: "/x.ts",
			}),
		).toBe("alt+x is already used by another extension; pick another shortcut");
		expect(describeShortcutConflict("alt+c", undefined)).toBeUndefined();
	});

	test("free chords are accepted", () => {
		for (const chord of ["alt+c", "alt+shift+d", "ctrl+shift+y", "alt+f7"]) {
			expect(validateDisplayCycleKey(chord)).toBeUndefined();
		}
	});

	test("malformed chords are refused with a readable reason", () => {
		expect(validateDisplayCycleKey("")).toBe("shortcut must not be empty");
		// A bare letter would intercept that letter everywhere in the editor.
		expect(validateDisplayCycleKey("c")).toBe(
			"shortcut needs a modifier, e.g. alt+c",
		);
		expect(validateDisplayCycleKey("meta+c")).toBe(
			'unknown modifier "meta"; use ctrl, shift, alt or super',
		);
		expect(validateDisplayCycleKey("alt+alt+c")).toBe(
			'duplicate modifier "alt"',
		);
		expect(validateDisplayCycleKey("alt+nope")).toBe('unknown key "nope"');
	});
});

describe("display cycle: shortcut registration", () => {
	function shortcutApi() {
		const registered: Array<{ chord: string; description?: string }> = [];
		const pi = {
			registerShortcut: (
				chord: string,
				options: { description?: string; handler: () => void },
			) => {
				registered.push({ chord, description: options.description });
			},
		};
		return { pi, registered };
	}

	test("a free chord from the config file is registered verbatim", () => {
		const { pi, registered } = shortcutApi();
		const used = registerDisplayCycleShortcut(pi, "alt+shift+d", {
			description: "cycle",
			handler: () => {},
		});
		expect(used).toBe("alt+shift+d");
		expect(registered).toEqual([
			{ chord: "alt+shift+d", description: "cycle" },
		]);
	});

	test("a malformed chord falls back to the default instead of dying silently", () => {
		const { pi, registered } = shortcutApi();
		const used = registerDisplayCycleShortcut(pi, "bogus", {
			description: "cycle",
			handler: () => {},
		});
		expect(used).toBe("alt+c");
		expect(registered[0]?.chord).toBe("alt+c");
	});
});

describe("display cycle: keypress handler", () => {
	function cycleHarness(
		settings: CompactSettings,
		envOverrides?: EnvOverrides,
	) {
		const notifies: Array<[string, string]> = [];
		const saved: CompactSettings[] = [];
		const store = {
			load: async () => settings,
			update: async (next: CompactSettings) => {
				saved.push(next);
				// Models the store: a hard env override wins over the file.
				if (envOverrides?.enabledBy.length) {
					return { ...next, enabled: false };
				}
				if (envOverrides?.modeBy) return { ...next, mode: "clear" as const };
				return next;
			},
			overrides: () => envOverrides ?? { enabledBy: [], modeBy: undefined },
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

	test("a keypress persists the next state and reports it once", async () => {
		const { deps, notifies, saved } = cycleHarness({
			...DEFAULT_SETTINGS,
			enabled: true,
			mode: "compact",
		});
		await cycleDisplayState(deps);
		expect(saved).toHaveLength(1);
		expect(saved[0]?.enabled).toBe(true);
		expect(saved[0]?.mode).toBe("live");
		// Exactly one line, and not the dialog's generic "settings saved".
		expect(notifies).toHaveLength(1);
		expect(notifies[0]?.[0]).toBe("info");
		expect(stripAnsi(notifies[0]?.[1] ?? "")).toBe(
			"Compact: live — takes effect next run",
		);
	});

	test("the step into off persists enabled=false and keeps the mode", async () => {
		const { deps, notifies, saved } = cycleHarness({
			...DEFAULT_SETTINGS,
			enabled: true,
			mode: "clear",
		});
		await cycleDisplayState(deps);
		expect(saved[0]?.enabled).toBe(false);
		expect(saved[0]?.mode).toBe("clear");
		expect(stripAnsi(notifies[0]?.[1] ?? "")).toBe(
			"Compact: off — from the next run",
		);
	});

	test("a chord press never rewrites the chord itself", async () => {
		const { deps, saved } = cycleHarness({
			...DEFAULT_SETTINGS,
			displayCycleKey: "alt+shift+d",
		});
		await cycleDisplayState(deps);
		expect(saved[0]?.displayCycleKey).toBe("alt+shift+d");
	});

	test("an env-pinned enabled reports the pinned truth instead of a silent write", async () => {
		const { deps, notifies } = cycleHarness(
			{ ...DEFAULT_SETTINGS, enabled: false, mode: "clear" },
			{ enabledBy: ["OMP_COMPACT_PLUGIN"] },
		);
		await cycleDisplayState(deps);
		expect(notifies).toHaveLength(1);
		expect(stripAnsi(notifies[0]?.[1] ?? "")).toBe(
			"Compact: off — pinned by OMP_COMPACT_PLUGIN, unchanged",
		);
	});

	test("an env-pinned mode names the variable and reports the effective mode", async () => {
		const { deps, notifies } = cycleHarness(
			{ ...DEFAULT_SETTINGS, enabled: true, mode: "compact" },
			{ enabledBy: [], modeBy: "OMP_COMPACT_MODE" },
		);
		await cycleDisplayState(deps);
		expect(stripAnsi(notifies[0]?.[1] ?? "")).toBe(
			"Compact: clear — pinned by OMP_COMPACT_MODE, unchanged",
		);
	});

	test("a failed save is reported and never claims a switch", async () => {
		const notifies: Array<[string, string]> = [];
		const store = {
			load: async () => DEFAULT_SETTINGS,
			update: async () => {
				throw new Error("disk full");
			},
			overrides: () => ({ enabledBy: [], modeBy: undefined }),
		} as unknown as CompactSettingsStore;
		await cycleDisplayState({
			store,
			theme: fakeTheme(),
			notify: (level, message) => notifies.push([level, message]),
		});
		expect(notifies).toHaveLength(1);
		expect(notifies[0]?.[0]).toBe("warning");
		expect(notifies[0]?.[1]).toBe(
			"omp-compact could not switch the display: disk full",
		);
	});
});

describe("save report", () => {
	const store = {
		update: async (next: CompactSettings) => next,
		overrides: () => ({ enabledBy: [], modeBy: undefined }),
	} as unknown as CompactSettingsStore;

	test("a changed chord adds a note that it needs a restart", async () => {
		// The host cannot unregister a shortcut, so the new chord only starts
		// working after OMP restarts.
		const notifies: Array<[string, string]> = [];
		await saveAndReport(
			{ ...DEFAULT_SETTINGS, displayCycleKey: "alt+shift+d" },
			{ store, notifies },
			DEFAULT_SETTINGS,
		);
		expect(notifies).toEqual([
			["info", "omp-compact settings saved"],
			["info", "The cycle shortcut takes effect after restarting OMP"],
		]);
	});

	test("an unchanged chord reports the save alone", async () => {
		const notifies: Array<[string, string]> = [];
		await saveAndReport(
			{ ...DEFAULT_SETTINGS, compactPaths: false },
			{ store, notifies },
			DEFAULT_SETTINGS,
		);
		expect(notifies).toEqual([["info", "omp-compact settings saved"]]);
	});
});
