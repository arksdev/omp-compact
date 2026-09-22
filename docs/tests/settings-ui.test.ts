import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
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
	DEFAULT_DISPLAY_CYCLE_KEY,
	formatDisplayCycleStatus,
	nextDisplayCycleState,
	RESERVED_SHORTCUTS,
	validateDisplayCycleKey,
} from "../../.omp-plugin/display-cycle";
import {
	type CompactSettingsStore,
	type ComponentLike,
	cycleDisplayState,
	chooseSettingsCommandName,
	type HostBridgeLike,
	humanizeThreshold,
	KEY_BACKSPACE,
	KEY_ENTER,
	KEY_ESCAPE,
	KEY_SPACE,
	type KeybindingsLike,
	normalizeArrowKey,
	openSettingsDialog,
	registerDisplayCycleShortcut,
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
// Plain-CSI arrows, as a terminal delivers them to `handleInput`. The dialog
// no longer exports these: `normalizeArrowKey` owns every arrow spelling.
const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_RIGHT = "\u001b[C";
const KEY_LEFT = "\u001b[D";

/** Focusable row order when the stats row is enabled (the default). */
const FOCUSABLE_LABELS = [
	"Global compact",
	"Mode",
	"Compact paths",
	"Retain Git rows",
	"vibe-compact",
	"Advisor nit/concern",
	"Cycle shortcut",
	"Auto-shake",
	"Shake threshold",
	"Run statistics",
	"Actions",
	"Fresh input",
	"Received tokens",
	"Cached tokens",
	"Time",
	"Add local time",
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

	test("registerSettingsCommand tolerates a throwing registerCommand", () => {
		const pi = {
			getCommands: () => [],
			registerCommand: () => {
				throw new Error("RPC shim: command registration unavailable");
			},
		};
		expect(
			registerSettingsCommand(pi, {
				description: "d",
				handler: async () => {},
			}),
		).toBeUndefined();
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
		dialog.handleInput(KEY_J);
		expect(focusedRow(dialog)).toContain("vibe-compact");
		dialog.handleInput(KEY_DOWN);
		expect(focusedRow(dialog)).toContain("Advisor nit/concern");
		dialog.handleInput(KEY_DOWN);
		expect(focusedRow(dialog)).toContain("Cycle shortcut");
		dialog.handleInput(KEY_DOWN);
		expect(focusedRow(dialog)).toContain("Auto-shake");
		// wrap from the bottom back to the top
		for (let i = 0; i < FOCUSABLE_LABELS.length - 7; i++) {
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
		// Land on a trailing host row while the six stats children are still
		// focusable (cursor index 14 of 15). Shrinking the focusable set must
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
		focus(dialog, "Fresh input");
		expect(focusedRow(dialog)).toContain("Fresh input");
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
		focus(dialog, "Fresh input");
		dialog.handleInput(KEY_SPACE);
		expect(dialog.current.stats.sent).toBe(false);
	});

	test("the vibe-compact toggle flips the draft, goes dirty, and saves", async () => {
		const harness = makeDialog();
		const { dialog } = harness;
		expect(renderedValue(dialog, "vibe-compact")).toBe("on");
		focus(dialog, "vibe-compact");
		expect(focusedRow(dialog)).toContain("vibe-compact");
		// The help line under the rows describes the focused toggle.
		expect(lines(dialog)[lines(dialog).length - 1]).toContain(
			"Compact rows for vibe tools",
		);
		dialog.handleInput(KEY_SPACE);
		expect(dialog.current.compactVibeRows).toBe(false);
		expect(renderedValue(dialog, "vibe-compact")).toBe("off");
		expect(dialog.isDirty).toBe(true);
		dialog.handleInput(KEY_S);
		await dialog.settled();
		expect(harness.saves).toHaveLength(1);
		expect(harness.saves[0]?.compactVibeRows).toBe(false);
		expect(harness.doneResult?.compactVibeRows).toBe(false);
	});

	test("the advisor toggle flips the draft, goes dirty, and saves", async () => {
		const harness = makeDialog();
		const { dialog } = harness;
		expect(renderedValue(dialog, "Advisor nit/concern")).toBe("off");
		focus(dialog, "Advisor nit/concern");
		expect(focusedRow(dialog)).toContain("Advisor nit/concern");
		// The help line under the rows describes the focused toggle.
		expect(lines(dialog)[lines(dialog).length - 1]).toContain(
			"Compact nit/concern advisor notes; blockers stay full",
		);
		dialog.handleInput(KEY_SPACE);
		expect(dialog.current.compactAdvisorNotes).toBe(true);
		expect(renderedValue(dialog, "Advisor nit/concern")).toBe("on");
		expect(dialog.isDirty).toBe(true);
		dialog.handleInput(KEY_S);
		await dialog.settled();
		expect(harness.saves).toHaveLength(1);
		expect(harness.saves[0]?.compactAdvisorNotes).toBe(true);
		expect(harness.doneResult?.compactAdvisorNotes).toBe(true);
	});

	test("canceling the advisor toggle leaves the preference unchanged", async () => {
		const harness = makeDialog();
		focus(harness.dialog, "Advisor nit/concern");
		harness.dialog.handleInput(KEY_SPACE);
		harness.dialog.handleInput(KEY_ESCAPE);
		await harness.dialog.settled();
		expect(harness.saves).toEqual([]);
		expect(harness.doneResult).toBeUndefined();
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

	test("a long digit paste is capped at the digit limit", () => {
		// The value is bounded at 10 million, so a 20-digit paste is a paste
		// accident. The cap keeps the buffer at ten digits; the exact length
		// matters because an off-by-one in the room calculation would still
		// look "shorter than pasted".
		const { dialog } = makeDialog(zeroThreshold);
		focus(dialog, "Shake threshold");
		dialog.handleInput(KEY_ENTER);
		dialog.handleInput("1".repeat(20));
		expect(renderedValue(dialog, "Shake threshold")).toHaveLength(10);
		dialog.handleInput(KEY_ENTER);
		// Ten ones exceed the bound, so the commit is refused and the editor
		// stays open with the error — the cap is a paste guard, not validation.
		expect(dialog.current.autoShake.thresholdTokens).toBe(0);
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

	test("input after the dialog closes cannot touch the draft", () => {
		// The host detaches the component asynchronously, so a keystroke can
		// still arrive after `done` fired. Reaching the draft then would mean a
		// closed dialog changing settings, and a following save would persist
		// it. Closed through the public path (escape), never by assigning the
		// private flag, so the guard is what the test exercises.
		const { dialog, doneResult, saves } = makeDialog();
		focus(dialog, "Mode");
		const before = dialog.current;
		dialog.handleInput(KEY_ESCAPE);
		expect(doneResult).toBeUndefined();
		dialog.handleInput(KEY_RIGHT); // would cycle the mode
		dialog.handleInput(KEY_DOWN); // would move the cursor
		dialog.handleInput(KEY_SPACE); // would toggle a row
		dialog.handleInput(KEY_S); // would save
		expect(dialog.current).toEqual(before);
		expect(dialog.isDirty).toBe(false);
		expect(saves).toHaveLength(0);
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

	// End-to-end against the REAL store on a temp config: the dialog is
	// seeded from the effective snapshot (index.ts) and hands that whole
	// snapshot back, so a hard override must neither reach the file nor
	// silence the masking notice.
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
		const outcome = await saveSettingsFlow(
			{ ...initial, compactPaths: false },
			{ store, notify: (level, message) => notifies.push([level, message]) },
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
		const outcome = await saveSettingsFlow(
			{ ...initial, compactPaths: false },
			{ store, notify: (level, message) => notifies.push([level, message]) },
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
		const outcome = await saveSettingsFlow(
			{ ...initial, compactPaths: false },
			{ store, notify: (level, message) => notifies.push([level, message]) },
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
		const outcome = await saveSettingsFlow(
			{ ...initial, enabled: true },
			{ store, notify: (level, message) => notifies.push([level, message]) },
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
			"vibe-compact",
			"Advisor nit/concern",
			"Cycle shortcut",
			"Auto-shake",
			"Shake threshold",
			"Run statistics",
			"Actions",
			"Fresh input",
			"Received tokens",
			"Cached tokens",
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
		// header, global (2 rows), display (5 rows), shake (2 rows),
		// stats (7 rows), host (2 rows), help
		expect(blanks).toEqual([3, 9, 12, 20]);
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
		// 1 and 2 are the degenerate heights: the header plus the pinned help
		// line already fill two rows, so anything but a hard clamp overflows.
		for (const height of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12]) {
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

	test("a degenerate height keeps the focused row when an error is pinned too", async () => {
		// With an error the tail is two rows, so the clamp threshold moves from
		// 3 to 4. The focused row still wins: it is what the next keypress acts
		// on, so it outranks the header and the error text.
		for (const height of [1, 2, 3]) {
			const dialog = new SettingsDialog(
				{
					settings: DEFAULT_SETTINGS,
					onSave: async () => {
						throw new Error("disk full");
					},
					warn: () => {},
					theme: fakeTheme(),
					keybindings: noopKeybindings(),
					getTerminalRows: () => height,
				},
				() => {},
			);
			dialog.handleInput(KEY_SPACE);
			dialog.handleInput(KEY_S);
			await dialog.settled();
			const out = lines(dialog);
			expect(out).toHaveLength(height);
			expect(out[0]).toContain("Global compact");
		}
	});

	test("sufficient terminal height renders the full dialog unchanged", () => {
		const full = lines(makeDialog().dialog);
		const tall = lines(makeDialog(DEFAULT_SETTINGS, true, () => 40).dialog);
		expect(tall).toEqual(full);
		expect(full).toHaveLength(24);
		expect(full.join("\n")).not.toContain("…");
	});

	test("non-positive or non-finite terminal height renders the full frame", () => {
		const full = lines(makeDialog().dialog);
		expect(full).toHaveLength(24);

		for (const degenerate of [0, -1, Number.NaN]) {
			const dialog = makeDialog(
				DEFAULT_SETTINGS,
				true,
				() => degenerate,
			).dialog;
			const rendered = lines(dialog);
			expect(rendered).toEqual(full);
			expect(rendered).toHaveLength(24);
		}

		const undefinedRows = makeDialog(
			DEFAULT_SETTINGS,
			true,
			() => undefined,
		).dialog;
		expect(lines(undefinedRows)).toEqual(full);
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

	test("truncateAnsiSafe counts terminal cells and never splits surrogate pairs", () => {
		// The budget is terminal cells, not code points: each 🚀 paints two
		// columns, so a second one would need columns 3-4 of a 3-column
		// budget and is dropped whole rather than half-emitted.
		// Unstyled text cut at a boundary needs no reset (nothing is open);
		// styled cuts below assert the reset that closes color state.
		// Three glyphs are exactly 6 cells: byte-identical, no reset.
		expect(truncateAnsiSafe("🚀🚀🚀", 6)).toBe("🚀🚀🚀");
		// Styled astral content keeps escapes intact and closes the reset;
		// "a" would land in column 3 of a 2-column budget.
		const styled = "\x1b[31m🚀ab\x1b[39m";
		const styledTruncated = truncateAnsiSafe(styled, 2);
		expect(stripAnsi(styledTruncated)).toBe("🚀");
		expect(styledTruncated.endsWith("\x1b[0m")).toBe(true);
		// A cut must never land between the UTF-16 units of an astral glyph:
		// an index-based slice of "x🚀y" at width 2 would split the pair.
		expect(stripAnsi(truncateAnsiSafe("x🚀y", 2))).toBe("x");
		expect(stripAnsi(truncateAnsiSafe("x🚀y", 3))).toBe("x🚀");
	});

	test("truncateAnsiSafe budgets terminal cells, not code points", () => {
		// Two 2-cell glyphs fill a 4-column budget exactly; the old walk
		// counted each glyph as one cell and emitted three (6 columns).
		expect(stripAnsi(truncateAnsiSafe("日本語", 4))).toBe("日本");
		expect(stripAnsi(truncateAnsiSafe("日本語", 5))).toBe("日本");
		expect(stripAnsi(truncateAnsiSafe("日本語", 6))).toBe("日本語");
	});

	test("truncateAnsiSafe never half-emits a wide glyph at the budget boundary", () => {
		// 本 is 2 cells: a budget of 2 must not emit half of the following
		// wide glyph, and the host's truncation drops everything past a
		// glyph that would straddle the edge.
		expect(stripAnsi(truncateAnsiSafe("x本y", 1))).toBe("x");
		expect(stripAnsi(truncateAnsiSafe("x本y", 2))).toBe("x");
		expect(stripAnsi(truncateAnsiSafe("x本y", 3))).toBe("x本");
		expect(stripAnsi(truncateAnsiSafe("x本y", 4))).toBe("x本y");
	});

	test("truncateAnsiSafe keeps combining marks with their base glyph", () => {
		expect(stripAnsi(truncateAnsiSafe("e\u0301x", 1))).toBe("e\u0301");
		expect(truncateAnsiSafe("e\u0301x", 2)).toBe("e\u0301x");
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

describe("arrow key encodings", () => {
	test("normalizeArrowKey accepts plain CSI, SS3, and unmodified kitty forms", () => {
		expect(normalizeArrowKey(KEY_UP)).toBe("up");
		expect(normalizeArrowKey(KEY_DOWN)).toBe("down");
		expect(normalizeArrowKey(KEY_RIGHT)).toBe("right");
		expect(normalizeArrowKey(KEY_LEFT)).toBe("left");
		// SS3: sent while the TTY is in application-cursor-keys mode.
		expect(normalizeArrowKey("\u001bOA")).toBe("up");
		expect(normalizeArrowKey("\u001bOB")).toBe("down");
		expect(normalizeArrowKey("\u001bOC")).toBe("right");
		expect(normalizeArrowKey("\u001bOD")).toBe("left");
		// kitty keyboard protocol: no modifiers, with and without the
		// event-type sub-field. `:1` is a press, `:2` an auto-repeat.
		expect(normalizeArrowKey("\u001b[1;1A")).toBe("up");
		expect(normalizeArrowKey("\u001b[1;1B")).toBe("down");
		expect(normalizeArrowKey("\u001b[1;1:1B")).toBe("down");
		expect(normalizeArrowKey("\u001b[1;1:2B")).toBe("down");
		expect(normalizeArrowKey("\u001b[1;1:2D")).toBe("left");
	});

	test("normalizeArrowKey rejects modified arrows and release events", () => {
		// A held modifier is a different key: shift+up, alt+down, ctrl+right.
		expect(normalizeArrowKey("\u001b[1;2A")).toBeUndefined();
		expect(normalizeArrowKey("\u001b[1;3B")).toBeUndefined();
		expect(normalizeArrowKey("\u001b[1;5C")).toBeUndefined();
		expect(normalizeArrowKey("\u001b[1;3D")).toBeUndefined();
		expect(normalizeArrowKey("\u001b[1;2:1A")).toBeUndefined();
		// Event type 3 is a key release — never a second press.
		expect(normalizeArrowKey("\u001b[1;1:3A")).toBeUndefined();
		expect(normalizeArrowKey("\u001b[1;1:3D")).toBeUndefined();
		// Masks no terminal produces must not slip through either.
		expect(normalizeArrowKey("\u001b[1;0A")).toBeUndefined();
		expect(normalizeArrowKey("\u001b[1;11A")).toBeUndefined();
		expect(normalizeArrowKey("\u001b[2;1A")).toBeUndefined();
	});

	test("normalizeArrowKey rejects everything that is not an arrow", () => {
		expect(normalizeArrowKey("j")).toBeUndefined();
		expect(normalizeArrowKey("")).toBeUndefined();
		expect(normalizeArrowKey(KEY_ESCAPE)).toBeUndefined();
		expect(normalizeArrowKey(KEY_ENTER)).toBeUndefined();
		// SS3 P is F1, CSI 1;2H is Home — same shape, different keys.
		expect(normalizeArrowKey("\u001bOP")).toBeUndefined();
		expect(normalizeArrowKey("\u001b[1;2H")).toBeUndefined();
		expect(normalizeArrowKey("\u001b[200~")).toBeUndefined();
		// Truncated and garbled input must not be guessed at.
		expect(normalizeArrowKey("\u001b[")).toBeUndefined();
		expect(normalizeArrowKey("\u001b[1;A")).toBeUndefined();
		expect(normalizeArrowKey("\u001b[;1A")).toBeUndefined();
		expect(normalizeArrowKey("\u001bO1;1A")).toBeUndefined();
		expect(normalizeArrowKey("[1;1A")).toBeUndefined();
	});

	test("SS3 arrows move the focus like plain CSI arrows", () => {
		const { dialog } = makeDialog();
		expect(focusedRow(dialog)).toContain("Global compact");
		dialog.handleInput("\u001bOB");
		expect(focusedRow(dialog)).toContain("Mode");
		dialog.handleInput("\u001bOB");
		expect(focusedRow(dialog)).toContain("Compact paths");
		dialog.handleInput("\u001bOA");
		expect(focusedRow(dialog)).toContain("Mode");
	});

	test("kitty parameterized arrows move the focus", () => {
		const { dialog } = makeDialog();
		// no sub-field, explicit press, and auto-repeat all count as presses
		dialog.handleInput("\u001b[1;1B");
		expect(focusedRow(dialog)).toContain("Mode");
		dialog.handleInput("\u001b[1;1:1B");
		expect(focusedRow(dialog)).toContain("Compact paths");
		dialog.handleInput("\u001b[1;1:2B");
		expect(focusedRow(dialog)).toContain("Retain Git rows");
		dialog.handleInput("\u001b[1;1:2A");
		expect(focusedRow(dialog)).toContain("Compact paths");
		dialog.handleInput("\u001b[1;1A");
		expect(focusedRow(dialog)).toContain("Mode");
	});

	test("modified arrows neither move the focus nor cycle a value", () => {
		const { dialog } = makeDialog({ ...DEFAULT_SETTINGS, mode: "live" });
		dialog.handleInput(KEY_DOWN); // Mode, a cycle row
		expect(focusedRow(dialog)).toContain("Mode");
		for (const modified of [
			"\u001b[1;2A", // shift+up
			"\u001b[1;2B", // shift+down
			"\u001b[1;3A", // alt+up
			"\u001b[1;3B", // alt+down
			"\u001b[1;2C", // shift+right
			"\u001b[1;3D", // alt+left
			"\u001b[1;5C", // ctrl+right
		]) {
			dialog.handleInput(modified);
		}
		expect(focusedRow(dialog)).toContain("Mode");
		expect(renderedValue(dialog, "Mode")).toBe("live");
		expect(dialog.isDirty).toBe(false);
	});

	test("kitty release events are ignored by the dialog itself", () => {
		const { dialog } = makeDialog({ ...DEFAULT_SETTINGS, mode: "live" });
		dialog.handleInput("\u001b[1;1:3B");
		expect(focusedRow(dialog)).toContain("Global compact");
		dialog.handleInput(KEY_DOWN); // Mode
		dialog.handleInput("\u001b[1;1:3C");
		expect(renderedValue(dialog, "Mode")).toBe("live");
		expect(dialog.isDirty).toBe(false);
	});

	test("SS3 left/right cycle the focused option row", () => {
		const { dialog } = makeDialog({ ...DEFAULT_SETTINGS, mode: "live" });
		dialog.handleInput("\u001bOB"); // Mode
		dialog.handleInput("\u001bOC");
		expect(renderedValue(dialog, "Mode")).toBe("clear");
		dialog.handleInput("\u001bOD");
		expect(renderedValue(dialog, "Mode")).toBe("live");
	});

	test("unhandled input still leaves the dialog untouched", () => {
		const harness = makeDialog();
		const { dialog } = harness;
		dialog.handleInput("\u001b[1;2H");
		dialog.handleInput("x");
		expect(focusedRow(dialog)).toContain("Global compact");
		expect(dialog.isDirty).toBe(false);
		expect(harness.doneResult).toBeUndefined();
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

	test("a chord reserved by the extension runtime is refused by name", () => {
		// Each of these would be dropped at registration with only a log line.
		for (const chord of ["ctrl+c", "alt+m", "shift+tab", "alt+enter"]) {
			expect(validateDisplayCycleKey(chord)).toBe(
				`${chord} is already taken by OMP; pick another shortcut`,
			);
		}
	});

	test("a chord bound by the host's default keymap is refused too", () => {
		// alt+p / alt+r come from the host keybinding table, read live rather
		// than copied.
		expect(validateDisplayCycleKey("alt+p")).toContain("already taken by OMP");
		expect(validateDisplayCycleKey("alt+r")).toContain("already taken by OMP");
	});

	test("modifier order does not smuggle an occupied chord through", () => {
		// The host canonicalizes chords, so ctrl+alt+x and alt+ctrl+x are one
		// chord; validation must agree or a reordered spelling would slip past.
		expect(validateDisplayCycleKey("shift+ctrl+p")).toContain(
			"already taken by OMP",
		);
		expect(validateDisplayCycleKey("ctrl+shift+p")).toContain(
			"already taken by OMP",
		);
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

	test("the reserved copy matches the host list this pin ships", () => {
		// The host field is private and unreadable at runtime, so this copy is
		// the only thing standing between a user and a silently dead key. It
		// must be re-checked whenever the agent pin moves.
		expect([...RESERVED_SHORTCUTS]).toEqual([
			"ctrl+c",
			"ctrl+d",
			"ctrl+z",
			"ctrl+k",
			"ctrl+p",
			"ctrl+l",
			"ctrl+o",
			"ctrl+t",
			"ctrl+g",
			"alt+m",
			"ctrl+q",
			"shift+tab",
			"shift+ctrl+p",
			"alt+enter",
			"escape",
			"enter",
		]);
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

	test("an occupied chord falls back to the default instead of dying silently", () => {
		const { pi, registered } = shortcutApi();
		const used = registerDisplayCycleShortcut(pi, "ctrl+c", {
			description: "cycle",
			handler: () => {},
		});
		expect(used).toBe("alt+c");
		expect(registered[0]?.chord).toBe("alt+c");
	});

	test("a host without shortcut support does not take the plugin down", () => {
		const pi = {
			registerShortcut: () => {
				throw new Error("not supported");
			},
		};
		expect(
			registerDisplayCycleShortcut(pi, "alt+c", {
				description: "cycle",
				handler: () => {},
			}),
		).toBeUndefined();
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

describe("display cycle: dialog row", () => {
	test("the row shows the current chord and commits it in canonical spelling", () => {
		const { dialog } = makeDialog();
		expect(renderedValue(dialog, "Cycle shortcut")).toBe("alt+c");
		focus(dialog, "Cycle shortcut");
		dialog.handleInput(KEY_ENTER);
		// The chord editor announces what it accepts, in the same style as
		// the digit editor.
		expect(lines(dialog)[lines(dialog).length - 1]).toContain("chord edit");
		for (const ch of "alt+shift+d") dialog.handleInput(ch);
		dialog.handleInput(KEY_ENTER);
		// Committed in canonical form: the row echoes the host's modifier
		// order (ctrl > shift > alt > super), the spelling the store
		// persists and the host registers.
		expect(dialog.current.displayCycleKey).toBe("shift+alt+d");
		expect(dialog.isDirty).toBe(true);
	});

	test("an uppercase chord commits in canonical spelling", () => {
		// The canonicalise-not-reject decision: `alt+Q` is a valid chord; the
		// dialog echoes the canonical form the store persists and the host
		// registers (`shift+alt+q` — the id the physical press derives), not
		// the raw typed text.
		const { dialog } = makeDialog();
		focus(dialog, "Cycle shortcut");
		dialog.handleInput(KEY_ENTER);
		for (const ch of "alt+Q") dialog.handleInput(ch);
		dialog.handleInput(KEY_ENTER);
		expect(dialog.current.displayCycleKey).toBe("shift+alt+q");
		expect(dialog.isDirty).toBe(true);
	});

	test("an occupied chord is refused on the dialog's error line", () => {
		const { dialog } = makeDialog();
		focus(dialog, "Cycle shortcut");
		dialog.handleInput(KEY_ENTER);
		for (const ch of "ctrl+c") dialog.handleInput(ch);
		dialog.handleInput(KEY_ENTER);
		// Rejected: the draft keeps the old chord and the editor stays open
		// with the typed text so the user can correct it.
		expect(dialog.current.displayCycleKey).toBe("alt+c");
		expect(lines(dialog).join("\n")).toContain(
			"ctrl+c is already taken by OMP; pick another shortcut",
		);
		expect(renderedValue(dialog, "Cycle shortcut")).toBe("ctrl+c");
	});

	test("escape abandons a chord edit without touching the draft", () => {
		const { dialog } = makeDialog();
		focus(dialog, "Cycle shortcut");
		dialog.handleInput(KEY_ENTER);
		for (const ch of "alt+y") dialog.handleInput(ch);
		dialog.handleInput(KEY_ESCAPE);
		expect(dialog.current.displayCycleKey).toBe("alt+c");
		expect(dialog.isDirty).toBe(false);
	});

	test("backspace edits the chord buffer", () => {
		const { dialog } = makeDialog();
		focus(dialog, "Cycle shortcut");
		dialog.handleInput(KEY_ENTER);
		for (const ch of "alt+cx") dialog.handleInput(ch);
		dialog.handleInput(KEY_BACKSPACE);
		dialog.handleInput(KEY_ENTER);
		expect(dialog.current.displayCycleKey).toBe("alt+c");
	});

	test("a long paste is capped at the chord length limit", () => {
		// The cap exists so a stray clipboard paste cannot fill the row: the
		// longest legal chord is 30 characters. Assert the exact length, not
		// "shorter than pasted" — an off-by-one in the room calculation would
		// survive the looser check.
		const { dialog } = makeDialog();
		focus(dialog, "Cycle shortcut");
		dialog.handleInput(KEY_ENTER);
		dialog.handleInput("a".repeat(60));
		expect(renderedValue(dialog, "Cycle shortcut")).toHaveLength(40);
	});

	test("a paste that would overflow the cap is truncated, not dropped", () => {
		// Two chunks: the second only partly fits. The remaining room must be
		// filled rather than the whole chunk rejected.
		const { dialog } = makeDialog();
		focus(dialog, "Cycle shortcut");
		dialog.handleInput(KEY_ENTER);
		dialog.handleInput("b".repeat(35));
		dialog.handleInput("c".repeat(10));
		const value = renderedValue(dialog, "Cycle shortcut") ?? "";
		expect(value).toHaveLength(40);
		expect(value).toBe(`${"b".repeat(35)}${"c".repeat(5)}`);
	});

	test("a chunk containing non-ASCII is ignored entirely", () => {
		// Anything outside printable ASCII is either a control sequence or a
		// paste that cannot spell a chord, so the whole chunk goes — a partial
		// accept would leave half a paste in the editor.
		const { dialog } = makeDialog();
		focus(dialog, "Cycle shortcut");
		dialog.handleInput(KEY_ENTER);
		dialog.handleInput("alt+");
		dialog.handleInput("alt+ф");
		dialog.handleInput("d\u0000");
		expect(renderedValue(dialog, "Cycle shortcut")).toBe("alt+");
	});

	test("a saved chord change reports that it needs a restart", async () => {
		// The host cannot unregister a shortcut, so the new chord only starts
		// working after OMP restarts — the same honesty the thinking-visibility
		// change already gets.
		const notifies: Array<[string, string]> = [];
		const store = {
			update: async (next: CompactSettings) => next,
			overrides: () => ({ enabledBy: [], modeBy: undefined }),
		} as unknown as CompactSettingsStore;
		const outcome = await saveSettingsFlow(
			{ ...DEFAULT_SETTINGS, displayCycleKey: "alt+shift+d" },
			{
				store,
				previous: DEFAULT_SETTINGS,
				notify: (level, message) => notifies.push([level, message]),
			},
		);
		expect(outcome.restartRequired).toBe(true);
		expect(notifies).toEqual([
			["info", "omp-compact settings saved"],
			["info", "The cycle shortcut takes effect after restarting OMP"],
		]);
	});
});
