import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type CompactHostSettings,
	type CompactSettings,
	createSettingsStore,
	DEFAULT_SETTINGS,
	type EnvOverrides,
	MAX_THRESHOLD_TOKENS,
} from "../../.omp-plugin/config";
import {
	createHostSettingsBridge,
	type HostSettingsApi,
} from "../../.omp-plugin/host-settings";
import {
	type CompactSettingsStore,
	type ComponentLike,
	chooseSettingsCommandName,
	type HostBridgeLike,
	humanizeThreshold,
	KEY_BACKSPACE,
	KEY_DOWN,
	KEY_ENTER,
	KEY_ESCAPE,
	KEY_LEFT,
	KEY_RIGHT,
	KEY_SPACE,
	KEY_UP,
	type KeybindingsLike,
	openSettingsDialog,
	registerSettingsCommand,
	SettingsDialog,
	saveSettingsFlow,
	stripAnsi,
	type ThemeLike,
	truncateAnsiSafe,
} from "../../.omp-plugin/settings-ui";

const KEY_J = "j";
const KEY_K = "k";
const KEY_S = "s";
const KEY_C = "c";

/** Focusable row order when the stats row is enabled (the default). */
const FOCUSABLE_LABELS = [
	"Global compact",
	"Mode",
	"Compact paths",
	"Retain Git rows",
	"Auto-shake",
	"Shake threshold",
	"Run statistics",
	"Actions",
	"Sent tokens",
	"Received tokens",
	"Cache stats",
	"Time",
	"Recap summary",
	"Thinking blocks",
];

function fakeTheme(): ThemeLike {
	return {
		fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
		underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
	};
}

function noopKeybindings(): KeybindingsLike {
	return { matches: () => false };
}

interface Harness {
	dialog: SettingsDialog;
	doneResult: CompactSettings | undefined;
	saves: CompactSettings[];
	hostCalls: Array<{ recapEnabled?: boolean; thinkingBlocksVisible?: boolean }>;
	warnings: string[];
}

function makeDialog(
	settings: CompactSettings = DEFAULT_SETTINGS,
	hostAvailable = true,
	getTerminalRows?: () => number | undefined,
): Harness {
	const harness: Harness = {
		dialog: undefined as never,
		doneResult: undefined,
		saves: [],
		hostCalls: [],
		warnings: [],
	};
	const dialog = new SettingsDialog(
		{
			settings,
			hostAvailable,
			onSave: async (next) => {
				harness.saves.push(next);
			},
			onHostSettingsChanged: (host) => harness.hostCalls.push(host),
			warn: (message) => harness.warnings.push(message),
			theme: fakeTheme(),
			keybindings: noopKeybindings(),
			getTerminalRows,
		},
		(result) => {
			harness.doneResult = result;
		},
	);
	harness.dialog = dialog;
	return harness;
}

function lines(dialog: SettingsDialog, width = 80): string[] {
	return dialog.render(width).map((line) => stripAnsi(line));
}

function cursorIndexFor(label: string): number {
	const index = FOCUSABLE_LABELS.indexOf(label);
	if (index < 0) throw new Error(`unknown row ${label}`);
	return index;
}

/** Move the cursor to the row with the given label (stats row enabled). */
function focus(dialog: SettingsDialog, label: string): void {
	// Normalize to the top first so repeated focus() calls are absolute.
	for (let i = 0; i < FOCUSABLE_LABELS.length; i++) {
		if (focusedRow(dialog).includes("Global compact")) break;
		dialog.handleInput(KEY_UP);
	}
	for (let i = 0; i < cursorIndexFor(label); i++) {
		dialog.handleInput(KEY_DOWN);
	}
}

function focusedRow(dialog: SettingsDialog, width = 80): string {
	const line = lines(dialog, width).find((l) => l.includes("›"));
	expect(line, "a focused row marker must be rendered").toBeDefined();
	return line ?? "";
}

function renderedValue(
	dialog: SettingsDialog,
	label: string,
): string | undefined {
	for (const line of lines(dialog)) {
		const match = line.match(new RegExp(`${label}\\s+\\[?([^\\]]*)\\]?\\s*$`));
		const value = match?.[1];
		if (value !== undefined) return value.trim();
	}
	return undefined;
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

describe("keyboard navigation", () => {
	test("starts on Global compact and moves down with arrow/j, wrapping at the end", () => {
		const { dialog } = makeDialog();
		expect(focusedRow(dialog)).toContain("Global compact");
		dialog.handleInput(KEY_DOWN);
		expect(focusedRow(dialog)).toContain("Mode");
		dialog.handleInput(KEY_J);
		expect(focusedRow(dialog)).toContain("Compact paths");
		dialog.handleInput(KEY_J);
		expect(focusedRow(dialog)).toContain("Retain Git rows");
		dialog.handleInput(KEY_DOWN);
		expect(focusedRow(dialog)).toContain("Auto-shake");
		// wrap from the bottom back to the top
		for (let i = 0; i < FOCUSABLE_LABELS.length - 4; i++) {
			dialog.handleInput(KEY_DOWN);
		}
		expect(focusedRow(dialog)).toContain("Global compact");
	});

	test("up/k move backwards and wrap from the top", () => {
		const { dialog } = makeDialog();
		dialog.handleInput(KEY_UP);
		expect(focusedRow(dialog)).toContain("Thinking blocks");
		dialog.handleInput(KEY_K);
		expect(focusedRow(dialog)).toContain("Recap summary");
	});

	test("navigation skips stats children when the stats row is off", () => {
		const { dialog } = makeDialog();
		focus(dialog, "Run statistics");
		dialog.handleInput(KEY_SPACE); // stats off
		dialog.handleInput(KEY_DOWN);
		expect(focusedRow(dialog)).toContain("Recap summary");
		// children are still rendered, just not navigable
		expect(lines(dialog).some((l) => l.includes("Actions"))).toBe(true);
		expect(dialog.current.stats.actions).toBe(true);
	});

	test("focus stays on the same row when stats children collapse under it", () => {
		const { dialog } = makeDialog();
		// Land on a trailing host row while the five stats children are still
		// focusable (cursor index 13 of 14). Shrinking the focusable set must
		// not remap that high index onto an unrelated earlier row.
		focus(dialog, "Thinking blocks");
		expect(focusedRow(dialog)).toContain("Thinking blocks");
		// Collapse via the draft so the focusable set shrinks without move()
		// rewriting the cursor — the same length change activate() causes when
		// the stats parent is toggled, isolated from navigation side effects.
		dialog.current.stats.enabled = false;
		expect(focusedRow(dialog)).toContain("Thinking blocks");
		// Re-expanding must still leave focus on Thinking blocks by id.
		dialog.current.stats.enabled = true;
		expect(focusedRow(dialog)).toContain("Thinking blocks");
	});

	test("focus on a stats child retreats to the parent when children collapse", () => {
		const { dialog } = makeDialog();
		focus(dialog, "Sent tokens");
		expect(focusedRow(dialog)).toContain("Sent tokens");
		dialog.current.stats.enabled = false;
		// The focused row itself disappeared; land on the toggle that owns the
		// collapsed subtree rather than an unrelated neighbour.
		expect(focusedRow(dialog)).toContain("Run statistics");
		dialog.current.stats.enabled = true;
		// Id was repaired to the parent and must survive the re-render.
		expect(focusedRow(dialog)).toContain("Run statistics");
	});

	test("toggling a stats child flips the real draft field", () => {
		const { dialog } = makeDialog();
		focus(dialog, "Actions");
		dialog.handleInput(KEY_SPACE);
		expect(dialog.current.stats.actions).toBe(false);
		expect(dialog.isDirty).toBe(true);
		focus(dialog, "Sent tokens");
		dialog.handleInput(KEY_SPACE);
		expect(dialog.current.stats.sent).toBe(false);
	});
});

describe("mode cycling", () => {
	test("space cycles compact -> live -> clear and wraps", () => {
		const { dialog } = makeDialog({ ...DEFAULT_SETTINGS, mode: "compact" });
		dialog.handleInput(KEY_DOWN); // Mode row
		expect(renderedValue(dialog, "Mode")).toBe("compact");
		dialog.handleInput(KEY_SPACE);
		expect(renderedValue(dialog, "Mode")).toBe("live");
		dialog.handleInput(KEY_SPACE);
		expect(renderedValue(dialog, "Mode")).toBe("clear");
		dialog.handleInput(KEY_SPACE);
		expect(renderedValue(dialog, "Mode")).toBe("compact");
	});

	test("left/right cycle in reverse and forward", () => {
		const { dialog } = makeDialog({ ...DEFAULT_SETTINGS, mode: "live" });
		dialog.handleInput(KEY_DOWN);
		dialog.handleInput(KEY_RIGHT);
		expect(renderedValue(dialog, "Mode")).toBe("clear");
		dialog.handleInput(KEY_LEFT);
		expect(renderedValue(dialog, "Mode")).toBe("live");
		dialog.handleInput(KEY_LEFT);
		expect(renderedValue(dialog, "Mode")).toBe("compact");
	});

	test("enter also cycles the mode row", () => {
		const { dialog } = makeDialog({ ...DEFAULT_SETTINGS, mode: "live" });
		dialog.handleInput(KEY_DOWN);
		dialog.handleInput(KEY_ENTER);
		expect(renderedValue(dialog, "Mode")).toBe("clear");
	});
});

describe("threshold editing", () => {
	const zeroThreshold = {
		...DEFAULT_SETTINGS,
		autoShake: { enabled: false, thresholdTokens: 0 },
	};

	test("enter starts editing, digits commit via enter", async () => {
		const { dialog, saves } = makeDialog(zeroThreshold);
		focus(dialog, "Shake threshold");
		dialog.handleInput(KEY_ENTER);
		for (const digit of "25000") dialog.handleInput(digit);
		dialog.handleInput(KEY_ENTER);
		expect(dialog.current.autoShake.thresholdTokens).toBe(25000);
		dialog.handleInput(KEY_S);
		await dialog.settled();
		expect(saves[0]?.autoShake.thresholdTokens).toBe(25000);
	});

	test("non-digit input is ignored while editing", () => {
		const { dialog } = makeDialog(zeroThreshold);
		focus(dialog, "Shake threshold");
		dialog.handleInput(KEY_ENTER);
		dialog.handleInput("a");
		dialog.handleInput("-");
		dialog.handleInput("1");
		dialog.handleInput(KEY_ENTER);
		expect(dialog.current.autoShake.thresholdTokens).toBe(1);
	});

	test("multi-character paste with non-digits is ignored entirely", () => {
		const { dialog } = makeDialog(zeroThreshold);
		focus(dialog, "Shake threshold");
		dialog.handleInput(KEY_ENTER);
		// String-range checks accept chunks that merely start below "9"
		// ("1a" >= "0" && "1a" <= "9"), then parseInt silently keeps the
		// leading digits. The whole chunk must be rejected instead.
		dialog.handleInput("1a");
		dialog.handleInput("12x3");
		dialog.handleInput(KEY_ENTER);
		expect(dialog.current.autoShake.thresholdTokens).toBe(0);
		expect(lines(dialog).some((l) => l.includes("threshold must"))).toBe(false);
	});

	test("all-digit paste is accepted as a single chunk", () => {
		const { dialog } = makeDialog(zeroThreshold);
		focus(dialog, "Shake threshold");
		dialog.handleInput(KEY_ENTER);
		dialog.handleInput("25000");
		dialog.handleInput(KEY_ENTER);
		expect(dialog.current.autoShake.thresholdTokens).toBe(25000);
	});

	test("commit rejects a buffer that is not entirely digits", () => {
		const { dialog } = makeDialog(zeroThreshold);
		focus(dialog, "Shake threshold");
		dialog.handleInput(KEY_ENTER);
		// SettingsDialog keeps editBuffer private. Force a polluted buffer past
		// the keystroke gate so commitEdit's whole-buffer check is exercised
		// in isolation from the all-digits paste guard.
		const privateState = dialog as unknown as { editBuffer: string };
		privateState.editBuffer = "1a";
		dialog.handleInput(KEY_ENTER);
		expect(dialog.current.autoShake.thresholdTokens).toBe(0);
		expect(
			lines(dialog).some((l) =>
				l.includes("threshold must be a non-negative integer"),
			),
		).toBe(true);
		// Still editing after the rejected commit — same as oversized.
		expect(lines(dialog).some((l) => l.includes("[1a]"))).toBe(true);
	});

	test("oversized threshold is rejected and editing continues", () => {
		const { dialog } = makeDialog();
		focus(dialog, "Shake threshold");
		dialog.handleInput(KEY_ENTER);
		for (const digit of "9999999999") dialog.handleInput(digit);
		dialog.handleInput(KEY_ENTER);
		expect(dialog.current.autoShake.thresholdTokens).toBe(
			DEFAULT_SETTINGS.autoShake.thresholdTokens,
		);
		expect(
			lines(dialog).some((l) => l.includes("threshold") && l.includes("max")),
		).toBe(true);
		dialog.handleInput(KEY_ESCAPE); // cancel editing, clear the error
		expect(
			lines(dialog).some((l) => l.includes("threshold") && l.includes("max")),
		).toBe(false);
	});

	test("backspace removes digits, zero is accepted", () => {
		const { dialog } = makeDialog(zeroThreshold);
		focus(dialog, "Shake threshold");
		dialog.handleInput(KEY_ENTER);
		dialog.handleInput("1");
		dialog.handleInput(KEY_ENTER);
		expect(dialog.current.autoShake.thresholdTokens).toBe(1);
		dialog.handleInput(KEY_ENTER);
		dialog.handleInput(KEY_BACKSPACE);
		dialog.handleInput("0");
		dialog.handleInput(KEY_ENTER);
		expect(dialog.current.autoShake.thresholdTokens).toBe(0);
	});

	test("the max threshold boundary is pinned to MAX_THRESHOLD_TOKENS", () => {
		const { dialog } = makeDialog(zeroThreshold);
		// The exact config maximum is accepted…
		focus(dialog, "Shake threshold");
		dialog.handleInput(KEY_ENTER);
		for (const digit of String(MAX_THRESHOLD_TOKENS)) dialog.handleInput(digit);
		dialog.handleInput(KEY_ENTER);
		expect(dialog.current.autoShake.thresholdTokens).toBe(MAX_THRESHOLD_TOKENS);
		// …one token over is rejected with the derived message, and the
		// draft keeps the previous value.
		dialog.handleInput(KEY_ENTER);
		for (const digit of String(MAX_THRESHOLD_TOKENS + 1))
			dialog.handleInput(digit);
		dialog.handleInput(KEY_ENTER);
		expect(dialog.current.autoShake.thresholdTokens).toBe(MAX_THRESHOLD_TOKENS);
		expect(
			lines(dialog).some((l) =>
				l.includes(`threshold exceeds max ${MAX_THRESHOLD_TOKENS}`),
			),
		).toBe(true);
	});
});

describe("save vs cancel", () => {
	test("save persists the draft through onSave and resolves with it", async () => {
		const harness = makeDialog();
		const { dialog } = harness;
		dialog.handleInput(KEY_SPACE); // toggle Global compact off
		expect(dialog.current.enabled).toBe(false);
		expect(dialog.isDirty).toBe(true);
		expect(lines(dialog).some((l) => l.includes("*"))).toBe(true);
		dialog.handleInput(KEY_S);
		await dialog.settled();
		expect(harness.saves).toHaveLength(1);
		expect(harness.saves[0]?.enabled).toBe(false);
		expect(harness.doneResult?.enabled).toBe(false);
	});

	test("cancel skips onSave and resolves undefined", async () => {
		const harness = makeDialog();
		const { dialog } = harness;
		dialog.handleInput(KEY_SPACE);
		expect(dialog.isDirty).toBe(true);
		dialog.handleInput(KEY_ESCAPE);
		expect(harness.doneResult).toBeUndefined();
		expect(harness.saves).toHaveLength(0);
		await dialog.settled();
	});

	test("c key and ctrl+c cancel", () => {
		const first = makeDialog();
		first.dialog.handleInput(KEY_C);
		expect(first.doneResult).toBeUndefined();
		const second = makeDialog();
		second.dialog.handleInput("\u0003");
		expect(second.doneResult).toBeUndefined();
	});

	test("saving without changes resolves undefined and writes nothing", async () => {
		const harness = makeDialog();
		harness.dialog.handleInput(KEY_S);
		await harness.dialog.settled();
		expect(harness.saves).toHaveLength(0);
		expect(harness.doneResult).toBeUndefined();
	});

	test("save failure surfaces the error and stays open", async () => {
		const warnings: string[] = [];
		let resolved = false;
		const dialog = new SettingsDialog(
			{
				settings: DEFAULT_SETTINGS,
				onSave: async () => {
					throw new Error("disk full");
				},
				warn: (m) => warnings.push(m),
				theme: fakeTheme(),
				keybindings: noopKeybindings(),
			},
			() => {
				resolved = true;
			},
		);
		dialog.handleInput(KEY_SPACE);
		dialog.handleInput(KEY_S);
		await dialog.settled();
		expect(resolved).toBe(false);
		expect(warnings.some((w) => w.includes("disk full"))).toBe(true);
		expect(lines(dialog).some((l) => l.includes("disk full"))).toBe(true);
	});

	test("queued save persists the draft snapshot from save invocation, not later draft mutations", async () => {
		// m11: save() must capture an immutable snapshot at confirmation time.
		// Input may keep mutating the live draft while a slow onSave is pending;
		// the already-confirmed payload must not observe those later edits.
		let releaseSave!: () => void;
		const saveStarted = new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		const saves: CompactSettings[] = [];
		let doneResult: CompactSettings | undefined;
		const dialog = new SettingsDialog(
			{
				settings: DEFAULT_SETTINGS,
				onSave: async (next) => {
					saves.push(next);
					await saveStarted;
				},
				theme: fakeTheme(),
				keybindings: noopKeybindings(),
			},
			(result) => {
				doneResult = result;
			},
		);

		// Confirm: Global compact off.
		dialog.handleInput(KEY_SPACE);
		expect(dialog.current.enabled).toBe(false);
		dialog.handleInput(KEY_S);

		// While the write is pending, keep editing the live draft (mode +
		// re-enable). These must not rewrite the already-queued payload.
		dialog.handleInput(KEY_DOWN); // Mode
		dialog.handleInput(KEY_RIGHT); // live -> clear
		expect(dialog.current.mode).toBe("clear");
		dialog.handleInput(KEY_UP); // Global compact
		dialog.handleInput(KEY_SPACE); // re-enable
		expect(dialog.current.enabled).toBe(true);

		releaseSave();
		await dialog.settled();

		expect(saves).toHaveLength(1);
		expect(saves[0]?.enabled).toBe(false);
		expect(saves[0]?.mode).toBe(DEFAULT_SETTINGS.mode);
		// Nested objects are snapshots too: mutating the live draft after
		// confirmation must not rewrite the queued payload by reference.
		expect(saves[0]?.stats).not.toBe(dialog.current.stats);
		expect(saves[0]?.autoShake).not.toBe(dialog.current.autoShake);
		expect(saves[0]?.host).not.toBe(dialog.current.host);
		// Successful save still resolves with the confirmed snapshot.
		expect(doneResult?.enabled).toBe(false);
		expect(doneResult?.mode).toBe(DEFAULT_SETTINGS.mode);
		expect(doneResult).not.toBe(dialog.current);
	});
});

function flowHarness(overrides: {
	apply?: () => Promise<{ restartRequired: boolean }>;
	/** Failure injection for the one-shot compensating rollback. */
	rollback?: () => Promise<void>;
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
	const deps = {
		bridge: {
			apply: async (host: CompactHostSettings) => {
				order.push(`bridge.apply:${host.recapEnabled}`);
				const applied = overrides.apply
					? await overrides.apply()
					: { restartRequired: false };
				return {
					restartRequired: applied.restartRequired,
					// Models the real bridge's one-shot compensating rollback
					// (restores the raw persistent pre-image captured before
					// the forward mutation).
					rollback: async () => {
						order.push("bridge.rollback");
						if (overrides.rollback) return overrides.rollback();
					},
				};
			},
		},
		store,
		notify: (level: "info" | "warning", message: string) => {
			notifies.push([level, message]);
		},
	};
	return { deps, order, notifies };
}

describe("save flow ordering and failure contract", () => {
	const draft: CompactSettings = {
		...DEFAULT_SETTINGS,
		host: { recapEnabled: false, thinkingBlocksVisible: false },
	};

	test("host apply runs before store.update; unmasked save emits the plain success", async () => {
		const { deps, order, notifies } = flowHarness({});
		const result = await saveSettingsFlow(draft, deps);
		expect(order).toEqual(["bridge.apply:false", "store.update"]);
		expect(result.restartRequired).toBe(false);
		expect(result.masked).toBe(false);
		expect(result.masks).toEqual([]);
		// unmasked save: exactly the plain success, nothing else
		expect(notifies).toEqual([["info", "omp-compact settings saved"]]);
	});

	test("thinking change persists JSON then notifies honestly without reloading", async () => {
		// Stock has no safe live refresh for hideThinkingBlock; the flow must
		// NOT invoke any session reload. It persists host first, then JSON,
		// then reports the honest restart requirement through notify().
		const { deps, order, notifies } = flowHarness({
			apply: async () => ({ restartRequired: true }),
		});
		const result = await saveSettingsFlow(draft, deps);
		expect(order).toEqual(["bridge.apply:false", "store.update"]);
		expect(result.restartRequired).toBe(true);
		expect(notifies).toEqual([
			["info", "omp-compact settings saved"],
			["info", "Thinking blocks take effect after restarting OMP"],
		]);
	});

	test("host apply failure leaves the store untouched and skips notify", async () => {
		const { deps, order, notifies } = flowHarness({
			apply: async () => {
				throw new Error("host flush failed");
			},
		});
		await expect(saveSettingsFlow(draft, deps)).rejects.toThrow(
			"host flush failed",
		);
		expect(order).toEqual(["bridge.apply:false"]);
		expect(notifies).toEqual([]);
	});

	test("JSON persist failure rolls host settings back, skips the notify and reports no success", async () => {
		const { deps, order, notifies } = flowHarness({
			apply: async () => ({ restartRequired: true }),
			update: async () => {
				throw new Error("disk full");
			},
		});
		await expect(saveSettingsFlow(draft, deps)).rejects.toThrow("disk full");
		// The failed save's apply ran, the store rejected, and the
		// compensating rollback from the apply result ran — the host side
		// never diverges from the JSON.
		expect(order).toEqual([
			"bridge.apply:false",
			"store.update",
			"bridge.rollback",
		]);
		expect(notifies).toEqual([]);
	});

	test("rollback failure warns and preserves the original store error", async () => {
		const { deps, order, notifies } = flowHarness({
			update: async () => {
				throw new Error("disk full");
			},
			rollback: async () => {
				throw new Error("restore failed");
			},
		});
		// The ORIGINAL store error must surface — never the rollback error —
		// with exactly one honest warning naming both.
		await expect(saveSettingsFlow(draft, deps)).rejects.toThrow("disk full");
		expect(order).toEqual([
			"bridge.apply:false",
			"store.update",
			"bridge.rollback",
		]);
		expect(notifies).toEqual([
			[
				"warning",
				expect.stringContaining("Host settings could not be restored"),
			],
		]);
		expect(notifies[0]?.[1]).toContain("disk full");
		expect(notifies[0]?.[1]).toContain("restore failed");
	});

	test("without a bridge only the store is touched", async () => {
		const { deps, order, notifies } = flowHarness({});
		const result = await saveSettingsFlow(draft, {
			...deps,
			bridge: undefined,
		});
		expect(order).toEqual(["store.update"]);
		expect(result.restartRequired).toBe(false);
		expect(notifies).toEqual([["info", "omp-compact settings saved"]]);
	});

	test("store write failure after host apply rolls host settings back; JSON unchanged, no success notice", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-compact-flow-"));
		const configDir = join(dir, "omp-compact");
		const configPath = join(configDir, "config.json");
		const store = createSettingsStore({ path: configPath, warn: () => {} });
		const order: string[] = [];
		const notifies: Array<[string, string]> = [];
		// Stateful fake of the real bridge: apply() performs set (in-memory)
		// + flush (persistent), and its result carries a one-shot rollback
		// that restores the exact pre-apply state captured before mutation.
		let live: CompactHostSettings = { recapEnabled: true };
		const applied: CompactHostSettings[] = [];
		const bridge: HostBridgeLike = {
			apply: async (host) => {
				order.push("bridge.apply");
				applied.push(host);
				const previous = { ...live };
				live = { ...host };
				return {
					restartRequired: false,
					rollback: async () => {
						order.push("bridge.rollback");
						live = previous;
					},
				};
			},
		};
		const saveDraft: CompactSettings = {
			...DEFAULT_SETTINGS,
			host: { recapEnabled: false, thinkingBlocksVisible: true },
		};
		try {
			// Seed a real JSON so "unchanged" is observable, then make the
			// config dir read-only: host apply succeeds, plugin persist fails.
			await store.update({ host: { recapEnabled: true } });
			const before = await readFile(configPath, "utf8");
			await chmod(configDir, 0o500);
			await expect(
				saveSettingsFlow(saveDraft, {
					bridge,
					store,
					notify: (level, message) => notifies.push([level, message]),
				}),
			).rejects.toThrow();
			await chmod(configDir, 0o700);
			// The host apply ran, the store rejected, and the compensating
			// rollback from the apply result restored the pre-save state.
			expect(order).toEqual(["bridge.apply", "bridge.rollback"]);
			expect(applied).toEqual([
				{ recapEnabled: false, thinkingBlocksVisible: true },
			]);
			expect(notifies).toEqual([]);
			// Persistent (plugin JSON) is byte-identical: the new host
			// values were never recorded.
			expect(await readFile(configPath, "utf8")).toBe(before);
			expect(store.snapshot().host.recapEnabled).toBe(true);
			// In-memory host settings restored to the pre-save values too:
			// host state and plugin JSON agree again.
			expect(live).toEqual({ recapEnabled: true });
		} finally {
			await chmod(configDir, 0o700).catch(() => undefined);
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("store update failure restores the RAW persistent pre-image, never effective read values", async () => {
		// Simulated project/runtime override: the live effective value
		// (recapEnabled false) differs from the raw persistent global config
		// (recap.enabled true). The bridge's rollback closure is bound to the
		// RAW pre-image captured before the forward apply — a rollback built
		// from read() would write the masked effective value into the global
		// config and corrupt it (see context/host-settings-rollback.md).
		const rawBefore: CompactHostSettings = { recapEnabled: true };
		const effectiveBefore: CompactHostSettings = { recapEnabled: false };
		const order: string[] = [];
		const notifies: Array<[string, string]> = [];
		let raw: CompactHostSettings = { ...rawBefore };
		let effective: CompactHostSettings = { ...effectiveBefore };
		const bridge: HostBridgeLike = {
			apply: async (host) => {
				order.push("bridge.apply");
				// Forward mutation changes BOTH layers to the request.
				raw = { ...host };
				effective = { ...host };
				return {
					restartRequired: false,
					// Models the real bridge's one-shot rollback: restores the
					// RAW persistent pre-image captured before the apply; the
					// override then masks the effective view again.
					rollback: async () => {
						order.push("bridge.rollback");
						raw = { ...rawBefore };
						effective = { ...effectiveBefore };
					},
				};
			},
		};
		const store = {
			update: async () => {
				order.push("store.update");
				throw new Error("disk full");
			},
			overrides: () => ({ enabledBy: [], modeBy: undefined }),
		} as unknown as CompactSettingsStore;
		const saveDraft: CompactSettings = {
			...DEFAULT_SETTINGS,
			host: { recapEnabled: false },
		};
		await expect(
			saveSettingsFlow(saveDraft, {
				bridge,
				store,
				notify: (level, message) => notifies.push([level, message]),
			}),
		).rejects.toThrow("disk full");
		// 1. the failed save applied and flushed the new host values,
		// 2. the plugin JSON persist rejected,
		// 3. the one-shot compensating rollback restored the pre-image.
		expect(order).toEqual(["bridge.apply", "store.update", "bridge.rollback"]);
		// The RAW persistent layer is back to its exact pre-image — NOT the
		// effective values a read()-based rollback would have written.
		expect(raw).toEqual({ recapEnabled: true });
		// The simulated override still masks the effective view, as before.
		expect(effective).toEqual({ recapEnabled: false });
		// No success notification for a failed save.
		expect(notifies).toEqual([]);
	});

	test("overlapping saves on one bridge apply each save's own payload in order", async () => {
		// One bridge, two overlapping flows with different host payloads.
		// The bridge coalesces concurrent applies; without serialization the
		// second flow's payload is silently dropped while both callers report
		// success, leaving host config and plugin JSON divergent.
		const order: string[] = [];
		const notifies: Array<[string, string]> = [];
		const values = new Map<string, unknown>([
			["recap.enabled", true],
			["hideThinkingBlock", false],
		]);
		const bridge = createHostSettingsBridge({
			api: {
				get: (path) => values.get(path),
				set: (path, value) => values.set(path, value),
				flush: async () => {
					order.push("flush");
				},
				persistent: async () => ({
					"recap.enabled": {
						present: true,
						value: values.get("recap.enabled"),
					},
					hideThinkingBlock: {
						present: true,
						value: values.get("hideThinkingBlock"),
					},
				}),
			} satisfies HostSettingsApi,
		});
		const persistedHost: CompactHostSettings = {};
		const store = {
			update: async (next: CompactSettings) => {
				order.push(`store.update:${next.host.recapEnabled}`);
				Object.assign(persistedHost, next.host);
				return next;
			},
			overrides: () => ({ enabledBy: [], modeBy: undefined }),
		} as unknown as CompactSettingsStore;
		const first: CompactSettings = {
			...DEFAULT_SETTINGS,
			host: { recapEnabled: false, thinkingBlocksVisible: true },
		};
		const second: CompactSettings = {
			...DEFAULT_SETTINGS,
			host: { recapEnabled: true, thinkingBlocksVisible: false },
		};
		const notify = (level: string, message: string) =>
			notifies.push([level, message]);
		await Promise.all([
			saveSettingsFlow(first, { bridge, store, notify }),
			saveSettingsFlow(second, { bridge, store, notify }),
		]);
		const hostState: CompactHostSettings = {
			recapEnabled: values.get("recap.enabled") === true,
			thinkingBlocksVisible: values.get("hideThinkingBlock") !== true,
		};
		// Neither call lost its payload: host config and plugin JSON agree on
		// the second save's values, and both callers reported success.
		expect(hostState).toEqual(second.host);
		expect(persistedHost).toEqual(second.host);
		const saved = notifies.filter(
			([level, message]) =>
				level === "info" && message === "omp-compact settings saved",
		);
		expect(saved).toHaveLength(2);
	});

	test("a failed save never rolls back another save's successful write", async () => {
		// Two bridge instances (two dialogs) over one shared host config.
		// Without serialization both capture the same pre-image, the failing
		// save's compensating rollback restores a state that predates the
		// other save's already-successful write — host and JSON diverge.
		const order: string[] = [];
		const notifies: Array<[string, string]> = [];
		const values = new Map<string, unknown>([
			["recap.enabled", true],
			["hideThinkingBlock", false],
		]);
		const makeApi = (tag: string): HostSettingsApi => ({
			get: (path) => values.get(path),
			set: (path, value) => {
				order.push(`${tag}.set`);
				values.set(path, value);
			},
			flush: async () => {
				order.push(`${tag}.flush`);
			},
			persistent: async () => ({
				"recap.enabled": { present: true, value: values.get("recap.enabled") },
				hideThinkingBlock: {
					present: true,
					value: values.get("hideThinkingBlock"),
				},
			}),
		});
		let updateCount = 0;
		const persistedHost: CompactHostSettings = {};
		const store = {
			update: async (next: CompactSettings) => {
				updateCount++;
				order.push(`store.update:${next.host.recapEnabled}`);
				// The first (earlier) save fails its JSON persist; the second
				// succeeds after the host side already applied.
				if (updateCount === 1) throw new Error("disk full");
				Object.assign(persistedHost, next.host);
				return next;
			},
			overrides: () => ({ enabledBy: [], modeBy: undefined }),
		} as unknown as CompactSettingsStore;
		const first: CompactSettings = {
			...DEFAULT_SETTINGS,
			host: { recapEnabled: false, thinkingBlocksVisible: true },
		};
		const second: CompactSettings = {
			...DEFAULT_SETTINGS,
			host: { recapEnabled: true, thinkingBlocksVisible: false },
		};
		const notify = (level: string, message: string) =>
			notifies.push([level, message]);
		const [firstOutcome, secondOutcome] = await Promise.allSettled([
			saveSettingsFlow(first, {
				bridge: createHostSettingsBridge({ api: makeApi("A") }),
				store,
				notify,
			}),
			saveSettingsFlow(second, {
				bridge: createHostSettingsBridge({ api: makeApi("B") }),
				store,
				notify,
			}),
		]);
		// The failed save surfaced its error honestly — no success
		// notification for it.
		expect(firstOutcome.status).toBe("rejected");
		const saved = notifies.filter(
			([level, message]) =>
				level === "info" && message === "omp-compact settings saved",
		);
		expect(saved).toHaveLength(1);
		// Its compensating rollback restored only ITS pre-image: the second
		// save's successful write survives and host + JSON agree.
		const hostState: CompactHostSettings = {
			recapEnabled: values.get("recap.enabled") === true,
			thinkingBlocksVisible: values.get("hideThinkingBlock") !== true,
		};
		expect(hostState).toEqual(second.host);
		expect(persistedHost).toEqual(second.host);
		expect(secondOutcome.status).toBe("fulfilled");
	});
});

describe("env override notification on save", () => {
	const draft: CompactSettings = {
		...DEFAULT_SETTINGS,
		host: { recapEnabled: false, thinkingBlocksVisible: false },
	};

	test("masked enabled emits one info notification naming OMP_COMPACT_PLUGIN and still saves", async () => {
		const { deps, order, notifies } = flowHarness({
			envOverrides: { enabledBy: ["OMP_COMPACT_PLUGIN"] },
			update: async () => ({ ...draft, enabled: false }),
		});
		const result = await saveSettingsFlow(draft, deps);
		// the save itself still succeeds and persists the requested values
		expect(order).toEqual(["bridge.apply:false", "store.update"]);
		expect(result.restartRequired).toBe(false);
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
		const result = await saveSettingsFlow(draft, deps);
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
		const result = await saveSettingsFlow(draft, deps);
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
		const result = await saveSettingsFlow(draft, deps);
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
		const result = await saveSettingsFlow(draft, deps);
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
		await saveSettingsFlow(draft, deps);
		expect(notifies).toHaveLength(1);
		expect(notifies[0]?.[0]).toBe("info");
		expect(notifies[0]?.[1]).toBe(
			"omp-compact settings saved; effective enabled remains false because OMP_COMPACT_PLUGIN=0",
		);
	});
});

describe("dialog save notification contract", () => {
	interface FlowDialog {
		dialog: SettingsDialog;
		notifies: Array<[string, string]>;
		warnings: string[];
		doneResult: CompactSettings | undefined;
	}

	/**
	 * Dialog whose save runs the real saveSettingsFlow against a stub store,
	 * exactly the composition the command handler wires in index.ts.
	 */
	function dialogWithFlow(overrides: {
		envOverrides?: EnvOverrides;
		/** Effective snapshot the store returns after persisting `next`. */
		update?: (next: CompactSettings) => CompactSettings;
		/** Effective snapshot the menu opens with (store.load contract). */
		initial?: CompactSettings;
		/** Optional host bridge, as the command handler wires in index.ts. */
		bridge?: HostBridgeLike;
	}): FlowDialog {
		const harness: FlowDialog = {
			dialog: undefined as never,
			notifies: [],
			warnings: [],
			doneResult: undefined,
		};
		const store = {
			update: async (next: CompactSettings): Promise<CompactSettings> => {
				if (overrides.update) return overrides.update(next);
				return next;
			},
			overrides: () =>
				overrides.envOverrides ?? { enabledBy: [], modeBy: undefined },
		} as unknown as CompactSettingsStore;
		const dialog = new SettingsDialog(
			{
				settings: overrides.initial ?? DEFAULT_SETTINGS,
				onSave: async (next) => {
					await saveSettingsFlow(next, {
						bridge: overrides.bridge,
						store,
						notify: (level, message) => {
							harness.notifies.push([level, message]);
						},
					});
				},
				warn: (message) => harness.warnings.push(message),
				theme: fakeTheme(),
				keybindings: noopKeybindings(),
			},
			(result) => {
				harness.doneResult = result;
			},
		);
		harness.dialog = dialog;
		return harness;
	}

	test("masked save through the dialog emits exactly one notification carrying both facts", async () => {
		const harness = dialogWithFlow({
			// The menu opens on the effective snapshot: OMP_COMPACT_PLUGIN=0
			// has the runtime off even though the JSON says enabled.
			envOverrides: { enabledBy: ["OMP_COMPACT_PLUGIN"] },
			initial: { ...DEFAULT_SETTINGS, enabled: false },
			update: (next) => ({ ...next, enabled: false }),
		});
		harness.dialog.handleInput(KEY_SPACE); // re-enable in the draft
		expect(harness.dialog.current.enabled).toBe(true);
		harness.dialog.handleInput(KEY_S);
		await harness.dialog.settled();
		// The dialog resolves with the requested (persisted) value…
		expect(harness.doneResult?.enabled).toBe(true);
		// …and exactly one notification carries saved + effective facts.
		expect(harness.notifies).toEqual([
			[
				"info",
				"omp-compact settings saved; effective enabled remains false because OMP_COMPACT_PLUGIN=0",
			],
		]);
	});

	test("unmasked save through the dialog emits exactly the plain success", async () => {
		const harness = dialogWithFlow({});
		harness.dialog.handleInput(KEY_SPACE); // Global compact off
		harness.dialog.handleInput(KEY_S);
		await harness.dialog.settled();
		expect(harness.doneResult?.enabled).toBe(false);
		expect(harness.notifies).toEqual([["info", "omp-compact settings saved"]]);
	});

	test("failed save after a flushed host apply rolls the host back and keeps the dialog open with the error shown", async () => {
		// Stateful fake of the real bridge: apply() = set (in-memory) +
		// flush (persistent); its result carries a one-shot rollback that
		// restores the exact pre-apply state.
		let live: CompactHostSettings = {
			recapEnabled: true,
			thinkingBlocksVisible: true,
		};
		const bridge: HostBridgeLike = {
			apply: async (host) => {
				const previous = { ...live };
				live = { ...host };
				return {
					restartRequired: false,
					rollback: async () => {
						live = previous;
					},
				};
			},
		};
		const harness = dialogWithFlow({
			bridge,
			initial: {
				...DEFAULT_SETTINGS,
				host: { recapEnabled: true, thinkingBlocksVisible: true },
			},
			// The host bridge applied and flushed, then the plugin JSON
			// persist fails — the compensating rollback must restore the
			// pre-save host values and the dialog must surface the error.
			update: () => {
				throw new Error("disk full");
			},
		});
		focus(harness.dialog, "Recap summary");
		harness.dialog.handleInput(KEY_SPACE); // recap off in the draft
		harness.dialog.handleInput(KEY_S);
		await harness.dialog.settled();
		// Host settings restored: persistent (apply re-flushed the pre-save
		// values) and in-memory (read() mirrors them again).
		expect(live).toEqual({ recapEnabled: true, thinkingBlocksVisible: true });
		// UI stayed consistent: the dialog did NOT finish with the failed
		// draft — unsaved state is kept and the error is shown.
		expect(harness.doneResult).toBeUndefined();
		expect(lines(harness.dialog).some((l) => l.includes("disk full"))).toBe(
			true,
		);
		expect(harness.warnings.some((w) => w.includes("disk full"))).toBe(true);
		// No success notification for a failed save.
		expect(harness.notifies).toEqual([]);
	});
});

describe("host settings seam", () => {
	test("onHostSettingsChanged fires with changed fields after save", async () => {
		const harness = makeDialog({
			...DEFAULT_SETTINGS,
			host: { recapEnabled: true, thinkingBlocksVisible: true },
		});
		const { dialog } = harness;
		focus(dialog, "Recap summary");
		dialog.handleInput(KEY_SPACE); // recap off
		focus(dialog, "Thinking blocks");
		dialog.handleInput(KEY_SPACE); // thinking hidden
		dialog.handleInput(KEY_S);
		await dialog.settled();
		expect(harness.hostCalls).toEqual([
			{ recapEnabled: false, thinkingBlocksVisible: false },
		]);
	});

	test("no host callback when host fields unchanged", async () => {
		const harness = makeDialog();
		harness.dialog.handleInput(KEY_SPACE); // toggle Global compact only
		harness.dialog.handleInput(KEY_S);
		await harness.dialog.settled();
		expect(harness.hostCalls).toEqual([]);
	});
});

describe("unavailable host settings", () => {
	const HOST_UNAVAILABLE_ROW = /Recap summary|Thinking blocks/;

	test("host rows render n/a, are non-focusable, and are skipped by navigation", () => {
		const { dialog } = makeDialog(DEFAULT_SETTINGS, false);
		const output = lines(dialog);
		const recap = output.find((l) => l.includes("Recap summary"));
		expect(recap).toBeDefined();
		expect(recap).toContain("n/a");
		const thinking = output.find((l) => l.includes("Thinking blocks"));
		expect(thinking).toBeDefined();
		expect(thinking).toContain("n/a");
		// Navigation never lands on an unavailable host row.
		for (let i = 0; i < FOCUSABLE_LABELS.length + 2; i++) {
			expect(focusedRow(dialog)).not.toMatch(HOST_UNAVAILABLE_ROW);
			dialog.handleInput(KEY_DOWN);
		}
	});

	test("space on unavailable host rows cannot change the draft", () => {
		const { dialog } = makeDialog(DEFAULT_SETTINGS, false);
		for (let i = 0; i < 40; i++) {
			dialog.handleInput(KEY_DOWN);
			dialog.handleInput(KEY_SPACE);
		}
		expect(dialog.current.host).toEqual(DEFAULT_SETTINGS.host);
	});

	test("saving a plugin-only change succeeds with host JSON untouched", async () => {
		const harness = makeDialog(DEFAULT_SETTINGS, false);
		const { dialog } = harness;
		dialog.handleInput(KEY_SPACE); // Global compact off
		dialog.handleInput(KEY_S);
		await dialog.settled();
		expect(harness.saves).toHaveLength(1);
		expect(harness.saves[0]?.host).toEqual(DEFAULT_SETTINGS.host);
		expect(harness.saves[0]?.enabled).toBe(false);
		expect(harness.hostCalls).toEqual([]);
		expect(harness.doneResult?.enabled).toBe(false);
	});

	test("attempting a host change while unavailable fails visibly with JSON untouched", async () => {
		const harness = makeDialog(DEFAULT_SETTINGS, false);
		const { dialog } = harness;
		// Direct draft mutation is the only way a host change could exist
		// while the rows are locked; the save must fail visibly and must not
		// reach the store (plugin JSON keeps the old host preferences).
		dialog.current.host.recapEnabled = false;
		dialog.handleInput(KEY_S);
		await dialog.settled();
		expect(harness.saves).toHaveLength(0);
		expect(harness.doneResult).toBeUndefined();
		expect(harness.warnings.some((w) => /unavailable/i.test(w))).toBe(true);
		expect(
			lines(dialog).some((l) => /unavailable/i.test(l) && /host/i.test(l)),
		).toBe(true);
	});

	test("cancel writes nothing when host settings are unavailable", async () => {
		const harness = makeDialog(DEFAULT_SETTINGS, false);
		harness.dialog.handleInput(KEY_ESCAPE);
		await harness.dialog.settled();
		expect(harness.saves).toHaveLength(0);
		expect(harness.doneResult).toBeUndefined();
		expect(harness.hostCalls).toEqual([]);
	});
});

describe("menu labels and layout", () => {
	test("header is the aligned title with the dirty marker", () => {
		const { dialog } = makeDialog();
		const header = lines(dialog)[0];
		expect(header).toContain("OMP Compact — Settings");
		expect(header).not.toContain("*");
		dialog.handleInput(KEY_SPACE);
		expect(lines(dialog)[0]).toContain("*");
	});

	test("every row uses the aligned labels", () => {
		const { dialog } = makeDialog();
		const output = lines(dialog);
		for (const label of [
			"Global compact",
			"Mode",
			"Compact paths",
			"Retain Git rows",
			"Auto-shake",
			"Shake threshold",
			"Run statistics",
			"Actions",
			"Sent tokens",
			"Received tokens",
			"Cache stats",
			"Time",
			"Recap summary",
			"Thinking blocks",
		]) {
			expect(output.some((l) => l.includes(label))).toBe(true);
		}
	});

	test("one blank line separates the five groups", () => {
		const { dialog } = makeDialog();
		const output = lines(dialog, 80);
		const blanks = output
			.map((line, index) => (line === "" ? index : -1))
			.filter((index) => index >= 0);
		// header, global (2 rows), display (2 rows), shake (2 rows),
		// stats (6 rows), host (2 rows), help
		expect(blanks).toEqual([3, 6, 9, 16]);
	});
});

describe("short-terminal viewport", () => {
	const SHORT = 8;

	test("focused row stays visible at the top, middle, and end of the list", () => {
		const { dialog } = makeDialog(DEFAULT_SETTINGS, true, () => SHORT);
		// Top of the list: the first rows are visible, the tail is clipped.
		focus(dialog, "Global compact");
		let out = lines(dialog);
		expect(out).toHaveLength(SHORT);
		expect(out.join("\n")).toContain("Global compact");
		expect(out[out.length - 2]).toBe("…");
		// Middle of the list: both edges are clipped.
		focus(dialog, "Actions");
		out = lines(dialog);
		expect(out).toHaveLength(SHORT);
		expect(out.join("\n")).toContain("Actions");
		expect(out.filter((line) => line === "…")).toHaveLength(2);
		// End of the list: the last rows are visible, the head is clipped.
		focus(dialog, "Thinking blocks");
		out = lines(dialog);
		expect(out).toHaveLength(SHORT);
		expect(out.join("\n")).toContain("Thinking blocks");
		expect(out[1]).toBe("…");
	});

	test("every emitted frame stays within the terminal height", () => {
		for (const height of [4, 5, 6, 7, 8, 9, 12]) {
			const { dialog } = makeDialog(DEFAULT_SETTINGS, true, () => height);
			focus(dialog, "Shake threshold");
			const out = lines(dialog);
			expect(out).toHaveLength(height);
			// The focused row is never cut off by the host's bottom-anchored
			// window.
			expect(out.join("\n")).toContain("Shake threshold");
		}
	});

	test("focus near the list end keeps the window pinned at the bottom", () => {
		const { dialog } = makeDialog(DEFAULT_SETTINGS, true, () => SHORT);
		focus(dialog, "Recap summary");
		const first = lines(dialog);
		focus(dialog, "Thinking blocks");
		const second = lines(dialog);
		// Same visible rows (bottom-pinned window); only the focus marker
		// moves — the window is stable under one-step cursor moves. The
		// pinned contextual help line legitimately changes with the focused
		// row, so it is excluded from the window comparison.
		const stripRowDecoration = (out: string[]) =>
			out
				.slice(0, -1)
				.filter((line) => line !== "…")
				.map((line) => line.replace(/^›\s*/, "").replace(/^\s\s/, ""));
		expect(stripRowDecoration(second)).toEqual(stripRowDecoration(first));
		expect(first.join("\n")).toContain("› Recap summary");
		expect(second.join("\n")).toContain("› Thinking blocks");
	});

	test("the save error line stays visible inside the viewport", async () => {
		const warnings: string[] = [];
		const dialog = new SettingsDialog(
			{
				settings: DEFAULT_SETTINGS,
				onSave: async () => {
					throw new Error("disk full");
				},
				warn: (m) => warnings.push(m),
				theme: fakeTheme(),
				keybindings: noopKeybindings(),
				getTerminalRows: () => SHORT,
			},
			() => {},
		);
		dialog.handleInput(KEY_SPACE);
		dialog.handleInput(KEY_S);
		await dialog.settled();
		const out = lines(dialog);
		expect(out).toHaveLength(SHORT);
		expect(out.join("\n")).toContain("disk full");
	});

	test("sufficient terminal height renders the full dialog unchanged", () => {
		const full = lines(makeDialog().dialog);
		const tall = lines(makeDialog(DEFAULT_SETTINGS, true, () => 40).dialog);
		expect(tall).toEqual(full);
		expect(full).toHaveLength(20);
		expect(full.join("\n")).not.toContain("…");
	});
});

describe("threshold display", () => {
	function withThreshold(tokens: number): Harness {
		return makeDialog({
			...DEFAULT_SETTINGS,
			autoShake: { enabled: false, thresholdTokens: tokens },
		});
	}

	test("renders human units when not editing", () => {
		expect(
			renderedValue(withThreshold(2_000_000).dialog, "Shake threshold"),
		).toBe("2m tokens");
		expect(
			renderedValue(withThreshold(200_000).dialog, "Shake threshold"),
		).toBe("200k tokens");
		expect(renderedValue(withThreshold(25_000).dialog, "Shake threshold")).toBe(
			"25k tokens",
		);
	});

	test("zero renders as every-run semantics", () => {
		expect(renderedValue(withThreshold(0).dialog, "Shake threshold")).toBe(
			"0 (every run)",
		);
	});

	test("editing shows raw validated digits, not the human form", () => {
		const { dialog } = withThreshold(2_000_000);
		focus(dialog, "Shake threshold");
		dialog.handleInput(KEY_ENTER);
		expect(lines(dialog).some((l) => l.includes("[2000000]"))).toBe(true);
		expect(lines(dialog).some((l) => l.includes("2m tokens"))).toBe(false);
		// cancel the edit: the human form returns
		dialog.handleInput(KEY_ESCAPE);
		expect(lines(dialog).some((l) => l.includes("2m tokens"))).toBe(true);
	});

	test("humanizeThreshold exports the display contract", () => {
		expect(humanizeThreshold(0)).toBe("0 (every run)");
		expect(humanizeThreshold(2_000_000)).toBe("2m tokens");
		expect(humanizeThreshold(200_000)).toBe("200k tokens");
		expect(humanizeThreshold(25_000)).toBe("25k tokens");
		expect(humanizeThreshold(999)).toBe("999 tokens");
		expect(humanizeThreshold(10_000_000)).toBe("10m tokens");
	});
});

describe("contextual help line", () => {
	test("help describes the focused setting and changes with it", () => {
		const { dialog } = makeDialog();
		expect(lines(dialog)[lines(dialog).length - 1]).toContain(
			"Toggles the compact runtime",
		);
		focus(dialog, "Shake threshold");
		expect(lines(dialog)[lines(dialog).length - 1]).toContain(
			"Shakes once the run passes this many tokens",
		);
		focus(dialog, "Recap summary");
		expect(lines(dialog)[lines(dialog).length - 1]).toContain(
			"Stock recap summary visibility",
		);
	});

	test("help stays one dim line with the navigation hints", () => {
		const { dialog } = makeDialog();
		const help = lines(dialog)[lines(dialog).length - 1];
		expect(help).toContain("↑↓ move");
		expect(help).toContain("s save");
		expect(help).toContain("esc cancel");
	});

	test("editing keeps the digit-edit help", () => {
		const { dialog } = makeDialog();
		focus(dialog, "Shake threshold");
		dialog.handleInput(KEY_ENTER);
		expect(lines(dialog)[lines(dialog).length - 1]).toContain("digits edit");
	});
});

describe("muted rows", () => {
	/** Theme whose fg() tags colors, so assertions can tell muted apart. */
	function markerTheme(): ThemeLike {
		return {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `<b>${text}</b>`,
			italic: (text: string) => text,
			underline: (text: string) => text,
		};
	}

	test("disabled stats children mute labels and values", () => {
		const dialog = new SettingsDialog(
			{
				settings: {
					...DEFAULT_SETTINGS,
					stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				},
				onSave: async () => {},
				theme: markerTheme(),
				keybindings: noopKeybindings(),
			},
			() => {},
		);
		const output = dialog.render(80);
		const actions = output.find((l) => l.includes("Actions"));
		expect(actions).toBeDefined();
		expect(actions).toContain("<muted>├─ Actions</muted>");
		// the child value is muted too, even though the child is on
		expect(actions).toContain("<muted>on</muted>");
		// the focused parent row stays normally colored
		const stats = output.find((l) => l.includes("Run statistics"));
		expect(stats).toBeDefined();
		expect(stats).not.toContain("<muted>Run statistics</muted>");
	});

	test("unavailable host rows mute labels and values", () => {
		const dialog = new SettingsDialog(
			{
				settings: DEFAULT_SETTINGS,
				hostAvailable: false,
				onSave: async () => {},
				theme: markerTheme(),
				keybindings: noopKeybindings(),
			},
			() => {},
		);
		const output = dialog.render(80);
		const recap = output.find((l) => l.includes("Recap summary"));
		expect(recap).toBeDefined();
		expect(recap).toContain("<muted>Recap summary</muted>");
		expect(recap).toContain("<muted>n/a</muted>");
	});
});

describe("rendering safety", () => {
	test("render is width-safe at narrow widths", () => {
		const { dialog } = makeDialog();
		for (const width of [12, 16, 24, 40, 80]) {
			for (const line of dialog.render(width)) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
			}
		}
	});

	test("render keeps values readable at normal widths", () => {
		const { dialog } = makeDialog();
		const output = lines(dialog, 80);
		expect(output.some((l) => l.includes("Mode") && l.includes("live"))).toBe(
			true,
		);
		expect(
			output.some((l) => l.includes("Global compact") && l.includes("on")),
		).toBe(true);
		expect(output.some((l) => l.includes("Shake threshold"))).toBe(true);
		expect(output.some((l) => l.includes("Actions"))).toBe(true);
		expect(output.some((l) => l.includes("↑↓ move"))).toBe(true);
	});

	test("truncateAnsiSafe cuts visible text without leaking escapes", () => {
		const styled = "\x1b[31m1234567890\x1b[39m";
		const truncated = truncateAnsiSafe(styled, 5);
		expect(stripAnsi(truncated)).toBe("12345");
		expect(truncated.endsWith("\x1b[0m")).toBe(true);
		expect(truncateAnsiSafe(styled, 20)).toBe(styled);
	});

	test("truncateAnsiSafe counts code points and never splits surrogate pairs", () => {
		const emoji = "🚀".repeat(6); // 12 UTF-16 units, 6 code points
		const truncated = truncateAnsiSafe(emoji, 3);
		expect(stripAnsi(truncated)).toBe("🚀".repeat(3));
		expect(truncated.endsWith("\x1b[0m")).toBe(true);
		// 6 code points fit a width of 6 despite 12 UTF-16 units
		expect(truncateAnsiSafe(emoji, 6)).toBe(emoji);
		// styled astral content keeps escapes intact and closes the reset
		const styled = "\x1b[31m🚀ab\x1b[39m";
		const styledTruncated = truncateAnsiSafe(styled, 2);
		expect(stripAnsi(styledTruncated)).toBe("🚀a");
		expect(styledTruncated.endsWith("\x1b[0m")).toBe(true);
	});

	test("truncateAnsiSafe drops DEL, C1, and line separators from visible text", () => {
		// Shared rejected class: controls never count toward width and never
		// land in the truncated output. Astral characters still count as one.
		const dirty = "a\x7Fb\x9Bc\u2028d\u2029e🚀";
		const truncated = truncateAnsiSafe(dirty, 10);
		expect(stripAnsi(truncated)).toBe("abcde🚀");
		expect(truncated.includes("\x7f")).toBe(false);
		expect(truncated.includes("\x9b")).toBe(false);
		expect(truncated.includes("\u2028")).toBe(false);
		expect(truncated.includes("\u2029")).toBe(false);
	});
});

describe("headless and dialog opening", () => {
	test("openSettingsDialog without custom UI warns and resolves undefined", async () => {
		const warnings: string[] = [];
		const result = await openSettingsDialog({} as never, {
			settings: DEFAULT_SETTINGS,
			onSave: async () => {},
			warn: (m) => warnings.push(m),
		});
		expect(result).toBeUndefined();
		expect(warnings.length).toBeGreaterThan(0);
	});

	test("openSettingsDialog mounts the dialog and resolves with the saved settings", async () => {
		let resolvePromise: (result: CompactSettings | undefined) => void =
			() => {};
		let component: ComponentLike | undefined;
		const ui = {
			custom: async <T>(
				factory: (
					tui: unknown,
					theme: ThemeLike,
					keybindings: KeybindingsLike,
					done: (result: T) => void,
				) => ComponentLike | Promise<ComponentLike>,
			): Promise<T> => {
				const mounted = factory(
					null,
					fakeTheme(),
					noopKeybindings(),
					(result) => resolvePromise(result as CompactSettings | undefined),
				);
				component = mounted instanceof Promise ? await mounted : mounted;
				return new Promise<T>((resolve) => {
					resolvePromise = (result) => resolve(result as T);
				});
			},
		};
		const saves: CompactSettings[] = [];
		const promise = openSettingsDialog(ui, {
			settings: DEFAULT_SETTINGS,
			onSave: async (next) => {
				saves.push(next);
			},
		});
		expect(component).toBeDefined();
		component?.handleInput?.(KEY_SPACE); // toggle global mode
		component?.handleInput?.(KEY_S);
		const result = await promise;
		expect(saves).toHaveLength(1);
		expect(result?.enabled).toBe(false);
	});
});
