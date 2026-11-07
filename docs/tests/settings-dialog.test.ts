import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme/theme";

import {
	type CompactSettings,
	type CompactSettingsStore,
	createSettingsStore,
	DEFAULT_SETTINGS,
	type EnvLike,
	type ToolDisplay,
} from "../../.omp-plugin/config";
import {
	openSettingsDialog,
	runSettingsSession,
	SettingsDialog,
	type SettingsDialogDeps,
} from "../../.omp-plugin/settings-dialog";

const ENTER = "\r";
const ESCAPE = "\u001b";
const DOWN = "\u001b[B";
const BACKSPACE = "\u007f";

// The list and the chord editor style themselves through omp's theme, which
// omp initializes before any extension runs.
beforeAll(() => ensureThemeSync());

interface Harness {
	dialog: SettingsDialog;
	/** Every settings snapshot `onChange` saved, in order. */
	saves: CompactSettings[];
	warnings: string[];
	/** Set once the dialog resolves; `{ value }` keeps `undefined` apart. */
	closed: { value: CompactSettings | undefined } | undefined;
	frame(width?: number): string[];
	type(text: string): void;
}

function harness(
	options: {
		settings?: CompactSettings;
		tools?: SettingsDialogDeps["tools"];
		onChange?: SettingsDialogDeps["onChange"];
		checkShortcut?: SettingsDialogDeps["checkShortcut"];
		rows?: number;
	} = {},
): Harness {
	let stored = options.settings ?? DEFAULT_SETTINGS;
	const h: Harness = {
		dialog: undefined as never,
		saves: [],
		warnings: [],
		closed: undefined,
		frame: (width = 100) =>
			h.dialog.render(width).map((line) => Bun.stripANSI(line)),
		type: (text) => {
			for (const char of text) h.dialog.handleInput(char);
		},
	};
	h.dialog = new SettingsDialog(
		{
			settings: stored,
			tools: options.tools,
			onChange:
				options.onChange ??
				(async (update) => {
					stored = update(stored);
					h.saves.push(stored);
					return stored;
				}),
			checkShortcut: options.checkShortcut,
			warn: (message) => h.warnings.push(message),
			getTerminalRows:
				options.rows === undefined ? undefined : () => options.rows,
		},
		(value) => {
			h.closed = { value };
		},
	);
	return h;
}

/** The value shown on the row labelled `label`, or `undefined` when hidden. */
function rowValue(frame: readonly string[], label: string): string | undefined {
	for (const line of frame) {
		// Drop the scrollbar column, then the section sidebar left of `│`.
		const row = line.replace(/\s*[│█]\s*$/, "");
		const pane = row.slice(row.lastIndexOf("│") + 1);
		const match = pane.match(/^\s*(?:\S\s)?\s*(.+?)\s{2,}(\S+)$/);
		if (match?.[1] === label) return match[2];
	}
	return undefined;
}

/** Let queued saves settle: the fakes resolve within a few microtasks. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

const tools = (...names: string[]): SettingsDialogDeps["tools"] =>
	names.map((name) => ({ name, defaultDisplay: "rows" as ToolDisplay }));

describe("settings dialog", () => {
	test("opens on omp's settings list, sectioned, under the title", () => {
		const h = harness({ tools: tools("bash") });
		const frame = h.frame(120);
		expect(frame[0]).toBe("OMP Compact — Settings");
		expect(frame[1]).toBe("");
		const text = frame.join("\n");
		for (const section of ["General", "Display", "Statistics", "Tool cards"]) {
			expect(text).toContain(section);
		}
		expect(rowValue(frame, "Global compact")).toBe("true");
		expect(rowValue(frame, "Mode")).toBe("live");
		expect(rowValue(frame, "Cycle shortcut")).toBe("alt+c");
		expect(text).toContain("to close");
	});

	test("typing a query keeps the matching tool rows and hides the rest", () => {
		// Tall enough to list every row before the search.
		const h = harness({ rows: 60, tools: tools("bash", "wait", "waitingfor") });
		expect(rowValue(h.frame(), "bash")).toBe("rows");
		h.type("wa");
		const frame = h.frame();
		expect(frame.join("\n")).toContain("Search: wa");
		expect(rowValue(frame, "wait")).toBe("rows");
		expect(rowValue(frame, "waitingfor")).toBe("rows");
		expect(rowValue(frame, "bash")).toBeUndefined();
	});

	test("enter on a boolean saves that one change and shows the new value", async () => {
		const h = harness();
		h.dialog.handleInput(ENTER); // Global compact, the first row
		expect(rowValue(h.frame(), "Global compact")).toBe("false");
		await settle();
		expect(h.saves).toHaveLength(1);
		expect(h.saves[0]?.enabled).toBe(false);
		expect(rowValue(h.frame(), "Global compact")).toBe("false");
	});

	test("a change that fails to save reverts its row and warns", async () => {
		const h = harness({
			onChange: async () => {
				throw new Error("disk full");
			},
		});
		h.dialog.handleInput(ENTER);
		await settle();
		expect(h.warnings).toEqual(["disk full"]);
		expect(rowValue(h.frame(), "Global compact")).toBe("true");
		h.dialog.handleInput(ESCAPE);
		await settle();
		expect(h.closed).toEqual({ value: undefined });
	});

	test("turning Run statistics off hides its parts", async () => {
		const h = harness();
		h.type("run statistics");
		h.dialog.handleInput(ENTER);
		h.dialog.handleInput(ESCAPE); // clear the search
		const frame = h.frame(60);
		expect(rowValue(frame, "Run statistics")).toBe("false");
		for (const part of ["Actions", "Fresh input", "Time", "Add local time"]) {
			expect(rowValue(frame, part)).toBeUndefined();
		}
		await settle();
		expect(h.saves.at(-1)?.stats.enabled).toBe(false);
	});

	test("cycling a tool back to its default removes its entry", async () => {
		const h = harness({
			settings: { ...DEFAULT_SETTINGS, tools: { wait: "open" } },
			tools: tools("bash", "wait"),
		});
		h.type("wait");
		expect(rowValue(h.frame(), "wait")).toBe("open");
		h.dialog.handleInput(ENTER); // open -> rows, the default
		await settle();
		expect(h.saves.at(-1)?.tools).toEqual({});
		expect(rowValue(h.frame(), "wait")).toBe("rows");
	});

	test("the chord editor refuses a malformed or taken chord", async () => {
		const h = harness({
			checkShortcut: (chord) =>
				chord === "alt+x" ? "alt+x is already taken by OMP" : undefined,
		});
		h.type("cycle shortcut");
		h.dialog.handleInput(ENTER);
		h.type("q");
		h.dialog.handleInput(ENTER);
		expect(h.frame().join("\n")).toContain("needs a modifier");
		h.dialog.handleInput(BACKSPACE);
		h.type("alt+x");
		h.dialog.handleInput(ENTER);
		expect(h.frame().join("\n")).toContain("alt+x is already taken by OMP");
		await settle();
		expect(h.saves).toEqual([]);
	});

	test("the chord editor saves a valid chord in canonical spelling", async () => {
		const h = harness();
		h.type("cycle shortcut");
		h.dialog.handleInput(ENTER);
		h.type("alt+Q");
		h.dialog.handleInput(ENTER);
		await settle();
		expect(h.saves.map((saved) => saved.displayCycleKey)).toEqual([
			"shift+alt+q",
		]);
		h.dialog.handleInput(ESCAPE); // clear the search
		expect(rowValue(h.frame(), "Cycle shortcut")).toBe("shift+alt+q");
	});

	test("esc resolves with the final settings once pending saves land", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		let stored = DEFAULT_SETTINGS;
		const h = harness({
			onChange: async (update) => {
				await gate;
				stored = update(stored);
				return stored;
			},
		});
		h.dialog.handleInput(ENTER); // Global compact off
		h.dialog.handleInput(DOWN);
		h.dialog.handleInput(ENTER); // Mode live -> clear
		h.dialog.handleInput(ESCAPE);
		await settle();
		expect(h.closed).toBeUndefined();
		release();
		await settle();
		expect(h.closed?.value?.enabled).toBe(false);
		expect(h.closed?.value?.mode).toBe("clear");
	});

	test("esc without a change resolves undefined", async () => {
		const h = harness();
		h.dialog.handleInput(DOWN);
		h.dialog.handleInput(ESCAPE);
		await settle();
		expect(h.closed).toEqual({ value: undefined });
		expect(h.saves).toEqual([]);
	});

	test("on a short terminal every frame fits and keeps one height", () => {
		const rows = 20;
		const h = harness({
			rows,
			tools: tools(...Array.from({ length: 40 }, (_, i) => `tool${i}`)),
		});
		const heights: number[] = [];
		const record = () => heights.push(h.frame(120).length);
		record();
		for (let i = 0; i < 30; i++) h.dialog.handleInput(DOWN);
		record();
		h.type("tool1");
		record();
		h.type("zzz"); // no match
		record();
		for (let i = 0; i < 8; i++) h.dialog.handleInput(BACKSPACE);
		h.type("cycle shortcut");
		h.dialog.handleInput(ENTER); // chord editor open
		record();
		h.type("q");
		h.dialog.handleInput(ENTER); // with its error line
		record();
		expect(heights).toHaveLength(6);
		// omp keeps its status line under the dialog: one row less to fill.
		expect(Math.max(...heights)).toBeLessThanOrEqual(rows - 1);
		expect(heights.every((height) => height === heights[0])).toBe(true);
	});

	test("on a very short terminal the title gives way and the selection stays on screen", () => {
		const rows = 12;
		const h = harness({ rows });
		for (let i = 0; i < 6; i++) h.dialog.handleInput(DOWN);
		const frame = h.frame(120);
		expect(frame.length).toBeLessThanOrEqual(rows - 1);
		expect(frame.join("\n")).not.toContain("OMP Compact — Settings");
		// The selected row (Cycle shortcut) and its help are both visible.
		expect(rowValue(frame, "Cycle shortcut")).toBe("alt+c");
		expect(frame.join("\n")).toContain("Chord cycling");
	});
});

describe("openSettingsDialog", () => {
	test("without a custom UI it warns and resolves undefined", async () => {
		const warnings: string[] = [];
		const result = await openSettingsDialog({} as never, {
			settings: DEFAULT_SETTINGS,
			onChange: async () => DEFAULT_SETTINGS,
			warn: (message) => warnings.push(message),
		});
		expect(result).toBeUndefined();
		expect(warnings).toEqual([
			"omp-compact: interactive settings UI unavailable; nothing was changed",
		]);
	});

	test("mounts the dialog, sized to the host terminal, and resolves its result", async () => {
		const host = fakeUi(20);
		let stored = DEFAULT_SETTINGS;
		const promise = openSettingsDialog(host.ui, {
			settings: stored,
			onChange: async (update) => {
				stored = update(stored);
				return stored;
			},
			warn: () => {},
		});
		expect(host.component().render(120).length).toBeLessThanOrEqual(20);
		host.component().handleInput?.(ENTER);
		host.component().handleInput?.(ESCAPE);
		const result = await promise;
		expect(result?.enabled).toBe(false);
		// The settled save asked the host for a frame.
		expect(host.renders()).toBeGreaterThan(0);
	});
});

/** A host whose `ui.custom` mounts the dialog on a terminal `rows` high. */
function fakeUi(rows: number) {
	let component: Component | undefined;
	let renders = 0;
	const mounted = Promise.withResolvers<void>();
	const tui = {
		terminal: { rows },
		requestRender: () => {
			renders++;
		},
	} as unknown as TUI;
	const ui = {
		custom<T>(
			factory: (
				tui: TUI,
				theme: unknown,
				keybindings: unknown,
				done: (result: T) => void,
			) => Component,
		): Promise<T> {
			const { promise, resolve } = Promise.withResolvers<T>();
			component = factory(tui, undefined, undefined, resolve);
			mounted.resolve();
			return promise;
		},
	};
	return {
		ui,
		/** Resolves once `ui.custom` mounted the dialog. */
		mounted: mounted.promise,
		component: (): Component => {
			if (!component) throw new Error("the dialog is not mounted");
			return component;
		},
		renders: () => renders,
	};
}

describe("settings session under an env override", () => {
	/**
	 * A real store on a temp config holding `onDisk`, with `env` in force,
	 * and a `/compact-settings` session on it, as the command runs one.
	 */
	async function session(onDisk: Partial<CompactSettings>, env: EnvLike) {
		const dir = await mkdtemp(join(tmpdir(), "omp-compact-session-"));
		const file = join(dir, "config.json");
		await writeFile(file, JSON.stringify({ version: 1, ...onDisk }), "utf8");
		const real = createSettingsStore({ path: file, env, warn: () => {} });
		// The n-th write the session makes settles `writes[n]`, so a test can
		// wait for a change to land on disk.
		const writes: PromiseWithResolvers<void>[] = [];
		const write = (n: number) => {
			writes[n] ??= Promise.withResolvers<void>();
			return writes[n];
		};
		let started = 0;
		const store: CompactSettingsStore = {
			...real,
			update: (patch, options) => {
				const landed = write(started++);
				const result = real.update(patch, options);
				result.then(
					() => landed.resolve(),
					() => landed.resolve(),
				);
				return result;
			},
		};
		const host = fakeUi(60);
		const notices: Array<[string, string]> = [];
		const done = runSettingsSession(host.ui, {
			store,
			toolNames: [],
			notify: (level, message) => notices.push([level, message]),
		});
		await host.mounted;
		return {
			dialog: host.component(),
			notices,
			/** Wait for the `count`-th write, then for the dialog to show it. */
			saved: async (count: number) => {
				await write(count - 1).promise;
				for (let i = 0; i < 20; i++) await Promise.resolve();
			},
			/** Close the dialog and wait for the session to report. */
			close: async () => {
				host.component().handleInput?.(ESCAPE);
				await done;
			},
			disk: async () =>
				JSON.parse(await readFile(file, "utf8")) as CompactSettings,
			cleanup: () => rm(dir, { recursive: true, force: true }),
		};
	}

	test("a mode the env forces is saved, so the mode after it can be picked", async () => {
		const s = await session({ mode: "live" }, { OMP_COMPACT_MODE: "clear" });
		const frame = () => s.dialog.render(100).map((line) => Bun.stripANSI(line));
		expect(rowValue(frame(), "Mode")).toBe("live");
		s.dialog.handleInput?.(DOWN);
		s.dialog.handleInput?.(ENTER); // live -> clear, the forced mode
		await s.saved(1);
		expect(rowValue(frame(), "Mode")).toBe("clear");
		expect((await s.disk()).mode).toBe("clear");
		s.dialog.handleInput?.(ENTER); // clear -> compact
		await s.close();
		expect((await s.disk()).mode).toBe("compact");
		expect(rowValue(frame(), "Mode")).toBe("compact");
		expect(s.notices).toEqual([
			[
				"info",
				"omp-compact settings saved; effective mode remains clear because OMP_COMPACT_MODE=clear",
			],
		]);
		await s.cleanup();
	});

	test("turning Global compact off under OMP_COMPACT_PLUGIN=0 is saved", async () => {
		const s = await session({ enabled: true }, { OMP_COMPACT_PLUGIN: "0" });
		const frame = () => s.dialog.render(100).map((line) => Bun.stripANSI(line));
		expect(rowValue(frame(), "Global compact")).toBe("true");
		s.dialog.handleInput?.(ENTER);
		await s.saved(1);
		expect(rowValue(frame(), "Global compact")).toBe("false");
		await s.close();
		expect((await s.disk()).enabled).toBe(false);
		expect(rowValue(frame(), "Global compact")).toBe("false");
		expect(s.notices).toEqual([["info", "omp-compact settings saved"]]);
		await s.cleanup();
	});
});
