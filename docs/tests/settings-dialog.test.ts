import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureTheme,
	type ExtensionTheme,
	type ExtensionUiHost,
} from "@oh-my-pi/pi-coding-agent";
import type { PasteEvent, UiNode } from "@oh-my-pi/pi-tui";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { widgetContext, widgetFor } from "@oh-my-pi/pi-tui/term/widgets";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspPrefsProps } from "@oh-my-pi/pi-wire";

import {
	type CompactSettings,
	type CompactSettingsStore,
	createSettingsStore,
	DEFAULT_SETTINGS,
	type EnvLike,
	type ToolDisplay,
} from "../../.omp-plugin/config";
import type { SettingsUiLike } from "../../.omp-plugin/host-api";
import {
	createSettingsDialog,
	openSettingsDialog,
	runSettingsSession,
	type SettingsDialogDeps,
} from "../../.omp-plugin/settings-dialog";

const ENTER = "\r";
const ESCAPE = "\u001b";
const DOWN = "\u001b[B";
const TAB = "\t";
const BACKSPACE = "\u007f";

beforeAll(() => ensureTheme());

function sendInput(node: UiNode, seq: string, pageRows = 28): void {
	const widget = widgetFor(node);
	const cx = widgetContext([node], { focus: () => {}, pageRows });
	const key = decodeKey(seq, { kitty: false, backspaceIsCtrl: false });
	if (!key) return;
	if (node.handlers.onKey?.(key)) return;
	widget?.key?.(node, key, cx);
}

function sendPaste(node: UiNode, text: string): void {
	const paste: PasteEvent = { text };
	if (node.handlers.onPaste?.(paste)) return;
	const widget = widgetFor(node);
	const cx = widgetContext([node], { focus: () => {}, pageRows: 28 });
	widget?.paste?.(node, paste, cx);
}

function renderDialog(node: UiNode, width = 100, height = 28): string[] {
	return renderBlock(node, width, { theme: currentTheme(), height }).rows.map(
		(line) => Bun.stripANSI(line),
	);
}

interface Harness {
	node: UiNode;
	/** Every settings snapshot `onChange` saved, in order. */
	saves: CompactSettings[];
	warnings: string[];
	/** Set once the dialog resolves; `{ value }` keeps `undefined` apart. */
	closed: { value: CompactSettings | undefined } | undefined;
	frame(width?: number): string[];
	send(seq: string): void;
	paste(text: string): void;
	type(text: string): void;
}

function harness(
	options: {
		settings?: CompactSettings;
		tools?: SettingsDialogDeps["tools"];
		onChange?: SettingsDialogDeps["onChange"];
		checkShortcut?: SettingsDialogDeps["checkShortcut"];
		rows?: number;
		/** Defaults to `true`: most cases cover Tern's rows. */
		ternView?: boolean;
	} = {},
): Harness {
	let stored = options.settings ?? DEFAULT_SETTINGS;
	const pageRows = options.rows ?? 28;
	const h: Harness = {
		node: undefined as never,
		saves: [],
		warnings: [],
		closed: undefined,
		frame: (width = 100) => renderDialog(h.node, width, pageRows),
		send: (seq) => sendInput(h.node, seq, pageRows),
		paste: (text) => sendPaste(h.node, text),
		type: (text) => {
			for (const char of text) sendInput(h.node, char, pageRows);
		},
	};
	h.node = createSettingsDialog(
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
			ternView: options.ternView ?? true,
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
		// Drop outer frame borders and scrollbar column (`│`, `┃`, `█`).
		const inner = line
			.replace(/^\s*[│┃]\s*/, "")
			.replace(/\s*(?:[│┃█]\s*)+$/, "");
		const match = inner.match(
			/^(?:›|❯|▸|●|○|◆|•|>)?\s*(.+?)\s{2,}(?:←\s+)?([^\s*]+)(?:\s+→)?\s*\*?$/,
		);
		if (match?.[1]?.trim() === label) return match[2];
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
	test("opens on omp's prefs window, sectioned, under the title", () => {
		const h = harness({ tools: tools("bash") });
		const frame = h.frame(120);
		const text = frame.join("\n");
		expect(text).toContain("OMP Compact — Settings");
		for (const section of ["General", "Display", "Statistics", "Tool cards"]) {
			expect(text).toContain(section);
		}
		expect(rowValue(frame, "Global compact")).toBe("true");
		expect(rowValue(frame, "Mode")).toBe("live");
		expect(text).toContain("to close");
	});

	test("typing a query keeps the matching tool rows and hides the rest", () => {
		const h = harness({ rows: 60, tools: tools("bash", "wait", "waitingfor") });
		h.send(TAB); // General -> Display
		h.send(TAB); // Display -> Statistics
		h.send(TAB); // Statistics -> Tool cards
		expect(rowValue(h.frame(), "bash")).toBe("rows");
		h.type("wa");
		const frame = h.frame();
		expect(frame.join("\n")).toContain("wa");
		expect(frame.join("\n")).toContain("2 matches");
		expect(rowValue(frame, "wait")).toBe("rows");
		expect(rowValue(frame, "waitingfor")).toBe("rows");
		expect(rowValue(frame, "bash")).toBeUndefined();
	});

	test("enter on a boolean saves that one change and shows the new value", async () => {
		const h = harness();
		h.send(ENTER); // Global compact, the first row
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
		h.send(ENTER);
		await settle();
		expect(h.warnings).toEqual(["disk full"]);
		expect(rowValue(h.frame(), "Global compact")).toBe("true");
		h.send(ESCAPE);
		await settle();
		expect(h.closed).toEqual({ value: undefined });
	});

	test("turning Run statistics off hides its parts", async () => {
		const h = harness();
		h.type("run statistics");
		h.send(ENTER);
		h.send(ESCAPE); // exit search onto Statistics page
		const frame = h.frame(100);
		expect(rowValue(frame, "Run statistics")).toBe("false");
		for (const part of ["Actions", "Fresh input", "Time", "Add local time"]) {
			expect(rowValue(frame, part)).toBeUndefined();
		}
		await settle();
		expect(h.saves.at(-1)?.stats.enabled).toBe(false);
	});

	test("the Tern style row shows while Run statistics is on", async () => {
		const h = harness({ rows: 60 });
		h.send(TAB); // Display
		h.send(TAB); // Statistics
		expect(rowValue(h.frame(), "Tern style")).toBe("rows");
		h.type("run statistics");
		h.send(ENTER);
		h.send(ESCAPE);
		expect(rowValue(h.frame(), "Tern style")).toBeUndefined();
		await settle();
		expect(h.saves.at(-1)?.stats.style).toBe("rows");
	});

	test("outside Tern the Tern style row is left out", () => {
		const h = harness({ rows: 60, ternView: false });
		h.send(TAB); // Display
		h.send(TAB); // Statistics
		const frame = h.frame();
		expect(rowValue(frame, "Add local time")).toBe("true");
		expect(rowValue(frame, "Tern style")).toBeUndefined();
	});

	test("enter on Tern style saves the next style", async () => {
		const h = harness({ rows: 60 });
		h.type("tern style");
		h.send(ENTER); // rows -> text
		await settle();
		expect(h.saves.map((saved) => saved.stats.style)).toEqual(["text"]);
		h.send(ESCAPE); // exit search onto Statistics
		expect(rowValue(h.frame(), "Tern style")).toBe("text");
	});

	test("cycling a tool back to its default removes its entry", async () => {
		const h = harness({
			settings: { ...DEFAULT_SETTINGS, tools: { wait: "open" } },
			tools: tools("bash", "wait"),
		});
		h.type("wait");
		expect(rowValue(h.frame(), "wait")).toBe("open");
		h.send(ENTER); // open -> rows, the default
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
		h.send(ENTER);
		h.type("q");
		h.send(ENTER);
		expect(h.frame().join("\n")).toContain("needs a modifier");
		h.send(BACKSPACE);
		h.type("alt+x");
		h.send(ENTER);
		expect(h.frame().join("\n")).toContain("alt+x is already taken by OMP");
		await settle();
		expect(h.saves).toEqual([]);
	});

	test("the chord editor saves a valid chord in canonical spelling", async () => {
		const h = harness();
		h.type("cycle shortcut");
		h.send(ENTER);
		h.type("alt+Q");
		h.send(ENTER);
		await settle();
		expect(h.saves.map((saved) => saved.displayCycleKey)).toEqual([
			"alt+shift+q",
		]);
		h.send(ESCAPE); // exit search onto Display
		expect(rowValue(h.frame(), "Cycle shortcut")).toBe("alt+shift+q");
	});

	test("paste edits the chord editor and search query", async () => {
		const h = harness();
		h.type("cycle shortcut");
		h.send(ENTER);
		h.paste("alt+P\n");
		h.send(ENTER);
		await settle();
		expect(h.saves.map((saved) => saved.displayCycleKey)).toEqual([
			"alt+shift+p",
		]);
		h.send(ESCAPE);
		h.paste("global compact");
		expect(rowValue(h.frame(), "Global compact")).toBe("true");
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
		h.send(ENTER); // Global compact off
		h.send(DOWN);
		h.send(ENTER); // Mode live -> clear
		h.send(ESCAPE);
		await settle();
		expect(h.closed).toBeUndefined();
		release();
		await settle();
		expect(h.closed?.value?.enabled).toBe(false);
		expect(h.closed?.value?.mode).toBe("clear");
	});

	test("esc without a change resolves undefined", async () => {
		const h = harness();
		h.send(DOWN);
		h.send(ESCAPE);
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
		h.send(TAB); // Display
		h.send(TAB); // Statistics
		h.send(TAB); // Tool cards
		for (let i = 0; i < 30; i++) h.send(DOWN);
		record();
		h.type("tool1");
		record();
		h.type("zzz"); // no match
		record();
		for (let i = 0; i < 8; i++) h.send(BACKSPACE);
		h.type("cycle shortcut");
		h.send(ENTER); // chord editor open
		record();
		h.type("q");
		h.send(ENTER); // with its error line
		record();
		expect(heights).toHaveLength(6);
		expect(Math.max(...heights)).toBeLessThanOrEqual(rows);
		expect(heights.every((height) => height === heights[0])).toBe(true);
	});

	test("on a short terminal the selection and its help stay on screen", () => {
		const rows = 14;
		const h = harness({ rows });
		h.send(TAB); // Display
		for (let i = 0; i < 4; i++) h.send(DOWN);
		const frame = h.frame(120);
		expect(frame.length).toBeLessThanOrEqual(rows);
		expect(rowValue(frame, "Cycle shortcut")).toBe("alt+c");
		expect(frame.join("\n")).toContain("Chord cycling");
	});
});

describe("native settings page", () => {
	const page = (h: Harness) => {
		if (h.node.kind !== "prefs") {
			throw new Error(`expected a prefs page, got ${h.node.kind}`);
		}
		return {
			props: h.node.props() as unknown as TspPrefsProps,
		};
	};
	const rowsOf = (props: TspPrefsProps) =>
		props.sections.flatMap((section) => section.rows);
	const pointer = (
		h: Harness,
		event:
			| { type: "action"; act: string; value?: string; mods: [] }
			| { type: "select"; item: string }
			| { type: "activate"; item: string }
			| { type: "change"; item: string; value: boolean | string | null },
	) => {
		switch (event.type) {
			case "action":
				h.node.handlers.onAction?.(event.act, { ...event, key: "" });
				return;
			case "select":
				h.node.handlers.onSelect?.(event.item, { ...event, key: "" });
				return;
			case "activate":
				h.node.handlers.onActivate?.(event.item, { ...event, key: "" });
				return;
			case "change":
				h.node.handlers.onChange?.({ ...event, key: "" });
				return;
		}
	};

	test("shows one section per page with typed controls", () => {
		const h = harness({ tools: tools("bash") });
		const { props } = page(h);
		expect(props.pages.map((p) => p.label)).toEqual([
			"General",
			"Display",
			"Statistics",
			"Tool cards",
		]);
		expect(props.page).toBe("general");
		expect(rowsOf(props).map((row) => [row.id, row.control.k])).toEqual([
			["enabled", "switch"],
			["mode", "choice"],
		]);
	});

	test("a page click shows that section; the tools page explains the choices once", () => {
		const h = harness({ tools: tools("bash", "wait") });
		pointer(h, { type: "action", act: "page", value: "tools", mods: [] });
		const { props } = page(h);
		expect(props.page).toBe("tools");
		expect(props.lead).toContain("newest");
		expect(rowsOf(props).map((row) => [row.id, row.hint])).toEqual([
			["tools.bash", undefined],
			["tools.wait", undefined],
		]);
		expect(props.focus).toBe("tools.bash");
	});

	test("a search result sits under its own section, whatever page was open", () => {
		const h = harness({ tools: tools("bash", "wait") });
		h.type("wai");
		const { props } = page(h);
		expect(props.query).toBe("wai");
		expect(props.sections.map((section) => [section.id, section.page])).toEqual(
			[["tools", "tools"]],
		);
		expect(rowsOf(props).map((row) => row.id)).toEqual(["tools.wait"]);
	});

	test("switches, choices and resets save like the keys do", async () => {
		const h = harness({ tools: tools("bash") });
		pointer(h, { type: "change", item: "enabled", value: false });
		pointer(h, { type: "change", item: "tools.bash", value: "open" });
		await settle();
		expect(h.saves.at(-1)?.enabled).toBe(false);
		expect(h.saves.at(-1)?.tools).toEqual({ bash: "open" });
		expect(page(h).props.pages.find((p) => p.id === "tools")?.changed).toBe(1);
		pointer(h, { type: "change", item: "tools.bash", value: null });
		await settle();
		expect(h.saves.at(-1)?.tools).toEqual({});
	});

	test("a typed chord goes through the chord checks", async () => {
		const h = harness({
			checkShortcut: (chord) =>
				chord === "ctrl+c" ? "ctrl+c is already taken" : undefined,
		});
		pointer(h, { type: "change", item: "displayCycleKey", value: "ctrl+c" });
		await settle();
		expect(h.saves).toHaveLength(0);
		const refused = page(h);
		expect(refused.props.editing).toEqual({
			row: "displayCycleKey",
			draft: "ctrl+c",
			cursor: 6,
		});
		expect(h.frame().join("\n")).toContain("ctrl+c is already taken");
		pointer(h, {
			type: "action",
			act: "close",
			value: "displayCycleKey",
			mods: [],
		});
		pointer(h, { type: "change", item: "displayCycleKey", value: "alt+Y" });
		await settle();
		expect(h.saves.at(-1)?.displayCycleKey).toBe("alt+shift+y");
	});

	test("resetting the shortcut goes through the chord checks too", async () => {
		const h = harness({
			settings: { ...DEFAULT_SETTINGS, displayCycleKey: "alt+x" },
			checkShortcut: (chord) =>
				chord === "alt+c"
					? "alt+c is already used by another extension"
					: undefined,
		});
		pointer(h, { type: "change", item: "displayCycleKey", value: null });
		await settle();
		expect(h.saves).toHaveLength(0);
		expect(page(h).props.editing).toEqual({
			row: "displayCycleKey",
			draft: "alt+c",
			cursor: 5,
		});
		expect(h.frame().join("\n")).toContain(
			"alt+c is already used by another extension",
		);
	});

	test("the page's close button closes the dialog", async () => {
		const h = harness();
		pointer(h, { type: "change", item: "compactPaths", value: false });
		pointer(h, { type: "action", act: "close", mods: [] });
		await settle();
		expect(h.closed?.value?.compactPaths).toBe(false);
	});

	test("the statistics page offers the Tern style choice", async () => {
		const h = harness();
		pointer(h, { type: "action", act: "page", value: "statistics", mods: [] });
		const style = rowsOf(page(h).props).find((row) => row.id === "stats.style");
		expect(style?.control).toEqual({
			k: "choice",
			value: "rows",
			options: ["rows", "text", "chips", "rule", "icons"].map((value) => ({
				value,
				label: value,
			})),
			mono: true,
		});
		pointer(h, { type: "change", item: "stats.style", value: "chips" });
		await settle();
		expect(h.saves.at(-1)?.stats.style).toBe("chips");
		expect(
			page(h).props.pages.find((p) => p.id === "statistics")?.changed,
		).toBe(1);
		pointer(h, { type: "change", item: "stats.style", value: null });
		await settle();
		expect(h.saves.at(-1)?.stats.style).toBe("rows");
	});

	test("the statistics page has no Tern style while Run statistics is off", () => {
		const h = harness({
			settings: {
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
			},
		});
		pointer(h, { type: "action", act: "page", value: "statistics", mods: [] });
		expect(rowsOf(page(h).props).map((row) => row.id)).toEqual([
			"stats.enabled",
		]);
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

	test("mounts the dialog as an overlay and resolves its result", async () => {
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
		expect(host.options()).toEqual({ overlay: true, fullscreen: true });
		expect(renderDialog(host.node(), 120, 20).length).toBeLessThanOrEqual(20);
		sendInput(host.node(), ENTER, 20);
		sendInput(host.node(), ESCAPE, 20);
		const result = await promise;
		expect(result?.enabled).toBe(false);
	});
});

/** A host whose `ui.custom` mounts the dialog on a terminal `rows` high. */
function fakeUi(rows: number) {
	let node: UiNode | undefined;
	let capturedOptions: unknown;
	const mounted = Promise.withResolvers<void>();
	const uiHost = {
		requestRender: () => {},
		size: () => ({ columns: 100, rows }),
		suspend: () => () => {},
	} as unknown as ExtensionUiHost;
	const ui: SettingsUiLike = {
		custom<T>(
			factory: (
				ui: ExtensionUiHost,
				theme: ExtensionTheme,
				keybindings: unknown,
				done: (result: T) => void,
			) => UiNode,
			options?: unknown,
		): Promise<T> {
			const { promise, resolve } = Promise.withResolvers<T>();
			capturedOptions = options;
			node = factory(
				uiHost,
				currentTheme() as unknown as ExtensionTheme,
				undefined,
				resolve,
			);
			mounted.resolve();
			return promise;
		},
	};
	return {
		ui,
		mounted: mounted.promise,
		options: () => capturedOptions,
		node: (): UiNode => {
			if (!node) throw new Error("the dialog is not mounted");
			return node;
		},
	};
}

describe("settings session under an env override", () => {
	async function session(onDisk: Partial<CompactSettings>, env: EnvLike) {
		const dir = await mkdtemp(join(tmpdir(), "omp-compact-session-"));
		const file = join(dir, "config.json");
		await writeFile(file, JSON.stringify({ version: 1, ...onDisk }), "utf8");
		const real = createSettingsStore({ path: file, env, warn: () => {} });
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
			node: host.node(),
			notices,
			saved: async (count: number) => {
				await write(count - 1).promise;
				for (let i = 0; i < 20; i++) await Promise.resolve();
			},
			close: async () => {
				sendInput(host.node(), ESCAPE, 60);
				await done;
			},
			disk: async () =>
				JSON.parse(await readFile(file, "utf8")) as CompactSettings,
			cleanup: () => rm(dir, { recursive: true, force: true }),
		};
	}

	test("a mode the env forces is saved, so the mode after it can be picked", async () => {
		const s = await session({ mode: "live" }, { OMP_COMPACT_MODE: "clear" });
		const frame = () => renderDialog(s.node, 100, 60);
		expect(rowValue(frame(), "Mode")).toBe("live");
		sendInput(s.node, DOWN, 60);
		sendInput(s.node, ENTER, 60); // live -> clear, the forced mode
		await s.saved(1);
		expect(rowValue(frame(), "Mode")).toBe("clear");
		expect((await s.disk()).mode).toBe("clear");
		sendInput(s.node, ENTER, 60); // clear -> compact
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
		const frame = () => renderDialog(s.node, 100, 60);
		expect(rowValue(frame(), "Global compact")).toBe("true");
		sendInput(s.node, ENTER, 60);
		await s.saved(1);
		expect(rowValue(frame(), "Global compact")).toBe("false");
		await s.close();
		expect((await s.disk()).enabled).toBe(false);
		expect(rowValue(frame(), "Global compact")).toBe("false");
		expect(s.notices).toEqual([["info", "omp-compact settings saved"]]);
		await s.cleanup();
	});
});
