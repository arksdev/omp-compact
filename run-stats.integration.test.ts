import { beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	type HostModules,
	loadStockHost,
	loadStockPlugin,
	type Renderable,
	stockTempDir,
	type ToolExecutionInstance,
	type TranscriptInstance,
} from "./test-stock-host";

const binary = process.env.OMP_STOCK_BIN;
const stockTest = binary ? test : test.skip;
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

interface AdapterModule {
	RuntimeAdapter: new (options: {
		root: unknown;
		ui: {
			theme: unknown;
			setWidget?(key: string, content: unknown): void;
			requestRender?(): void;
			requestComponentRender?(component: unknown): void;
			getToolsExpanded?(): boolean;
		};
		timers?: {
			setInterval?(callback: () => void, ms?: number): unknown;
			clearTimer?(timer: unknown): void;
		};
		warn?(message: string): void;
		onRunFinalized?(runId: string): void;
		statsRenderer?(evidence: unknown): string | undefined;
		modePolicy?: unknown;
	}) => {
		install(): boolean;
		beginRun(): void;
		startTool(input: {
			toolCallId: string;
			toolName: string;
			args: unknown;
		}): void;
		finishTool(input: {
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
		}): void;
		endRun(input: {
			messages: unknown[];
			willContinue?: boolean;
		}): "working" | "filtered" | "full";
		showStats(runId: string, line: string): boolean;
		ledgerActions(runId: string): number | undefined;
		ledgerHasError(runId: string): boolean | undefined;
		hydrateBranch(entries: readonly unknown[]): void;
		dispose(): void;
	};
}

interface ConfigModule {
	createSettingsStore(deps: {
		env?: Record<string, string | undefined>;
		path?: string;
		warn?: (message: string) => void;
	}): {
		load(): Promise<unknown>;
		snapshot(): unknown;
		subscribe(fn: (settings: unknown) => void): () => void;
	};
}

interface ModePolicyModule {
	ModePolicy: new (store: {
		load(): Promise<unknown>;
		snapshot(): unknown;
		subscribe(fn: (settings: unknown) => void): () => void;
	}) => {
		prime(): void;
		prepareRun(): Promise<unknown>;
		dispose(): void;
	};
}

let host: Omit<HostModules, "plugin">;
let adapterModule: AdapterModule;
let configModule: ConfigModule;
let modePolicyModule: ModePolicyModule;

function toolUi(): Record<string, unknown> {
	return {
		requestRender() {},
		requestComponentRender() {},
		requestScrollbackRebuild() {},
		clearInlineImages() {},
		terminalWidth: 120,
		setWorkingMessage() {},
		setStatus() {},
		getToolsExpanded: () => false,
		setToolsExpanded() {},
	};
}

function fakeTool(name: string): Record<string, unknown> {
	return {
		name,
		label: name,
		description: name,
		parameters: {},
		execute: async () => ({ content: [], details: {} }),
	};
}

function assistant(
	text: string,
	stopReason = "stop",
	timestamp = 1_700_000_000_000,
): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		timestamp,
		usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
	};
}

interface BootedAdapter {
	transcript: TranscriptInstance;
	adapter: InstanceType<AdapterModule["RuntimeAdapter"]>;
	finalizedRuns: string[];
	notifications: string[];
	intervalCallbacks: Array<() => void>;
	clearedTimers: unknown[];
}

async function bootAdapter(options?: {
	mode?: "live" | "clear" | "compact";
	statsRenderer?: (evidence: unknown) => string | undefined;
}): Promise<BootedAdapter> {
	const root = new host.ContainerBase();
	const transcript = new host.TranscriptContainer();
	root.addChild(transcript);
	const finalizedRuns: string[] = [];
	const notifications: string[] = [];
	const intervalCallbacks: Array<() => void> = [];
	const clearedTimers: unknown[] = [];
	const ui = {
		theme: host.getTheme(),
		setWidget(_key: string, content: unknown) {
			if (typeof content === "function") {
				(content as (tui: unknown) => Renderable)(root);
			}
		},
		requestRender() {},
		requestComponentRender() {},
		getToolsExpanded: () => false,
	};
	let modePolicy: unknown;
	if (options?.mode && options.mode !== "live") {
		const configPath = join(stockTempDir(), `config-${options.mode}.json`);
		await writeFile(
			configPath,
			JSON.stringify({
				version: 1,
				enabled: true,
				mode: options.mode,
				retainGitLive: true,
				compactPaths: true,
				stats: {
					enabled: true,
					actions: true,
					sent: true,
					received: true,
					cache: true,
					time: true,
				},
				autoShake: { enabled: false, thresholdTokens: 2_000_000 },
				host: { recapEnabled: true, thinkingBlocksVisible: true },
			}),
		);
		const store = configModule.createSettingsStore({
			path: configPath,
			warn: () => {},
		});
		const policy = new modePolicyModule.ModePolicy(store);
		await policy.prepareRun();
		modePolicy = policy;
	}
	const adapter = new adapterModule.RuntimeAdapter({
		root,
		ui,
		timers: {
			setInterval(callback) {
				intervalCallbacks.push(callback);
				return callback;
			},
			clearTimer(timer) {
				clearedTimers.push(timer);
			},
		},
		warn: (message) => notifications.push(message),
		onRunFinalized: (runId) => finalizedRuns.push(runId),
		statsRenderer: options?.statsRenderer,
		modePolicy,
	});
	if (!adapter.install()) throw new Error("adapter install failed");
	return {
		transcript,
		adapter,
		finalizedRuns,
		notifications,
		intervalCallbacks,
		clearedTimers,
	};
}

function visibleRows(component: Renderable, width = 120): string[] {
	return component
		.render(width)
		.map((line) => line.replace(ansiPattern, "").trimEnd())
		.filter((line) => line.trim().length > 0);
}

function addTool(
	booted: BootedAdapter,
	toolName: string,
	args: unknown,
	toolCallId: string,
): ToolExecutionInstance {
	booted.adapter.startTool({ toolCallId, toolName, args });
	const component = new host.ToolExecutionComponent(
		toolName,
		args,
		{ showImages: false, useBuiltInRenderer: true },
		fakeTool(toolName),
		toolUi(),
		"/tmp",
		toolCallId,
	);
	booted.transcript.addChild(component);
	return component;
}

function addAnswer(booted: BootedAdapter, text: string): void {
	const reply = new host.ContainerBase();
	reply.addChild({ render: () => [text] });
	booted.transcript.addChild(reply);
}

function finishRun(
	booted: BootedAdapter,
	text: string,
	stopReason = "stop",
	willContinue = false,
): "working" | "filtered" | "full" {
	return booted.adapter.endRun({
		messages: [assistant(text, stopReason)],
		willContinue,
	});
}

stockTest("boots the adapter against the stock runtime", async () => {
	const booted = await bootAdapter();
	expect(booted.adapter.install()).toBe(true);
	await booted.adapter.dispose();
});

beforeAll(async () => {
	if (!binary) return;
	await mkdir(stockTempDir(), { recursive: true });
	host = await loadStockHost();
	await host.initTheme();
	adapterModule = await loadStockPlugin<AdapterModule>(
		"runtime-adapter.ts",
		"runstats-boot",
	);
	configModule = await loadStockPlugin<ConfigModule>(
		"config.ts",
		"runstats-boot",
	);
	modePolicyModule = await loadStockPlugin<ModePolicyModule>(
		"mode-policy.ts",
		"runstats-boot",
	);
});

stockTest(
	"stats row renders after tool rows and before the answer, exactly once",
	async () => {
		const booted = await bootAdapter();
		booted.adapter.beginRun();
		addTool(booted, "bash", { command: "bun test" }, "tool-1");
		booted.adapter.finishTool({
			toolCallId: "tool-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		addAnswer(booted, "done");
		expect(finishRun(booted, "done")).toBe("filtered");
		expect(booted.finalizedRuns).toEqual(["omp-compact-run-1"]);
		const line =
			"[ 1 actions · 100 sent · 50 received · 67% cache (200 hit) · 1h 20m 32s ]";
		expect(booted.adapter.ledgerActions("omp-compact-run-1")).toBe(1);
		expect(booted.adapter.ledgerHasError("omp-compact-run-1")).toBe(false);
		expect(booted.adapter.showStats("omp-compact-run-1", line)).toBe(true);
		// exactly once: a second call must not duplicate the carrier
		expect(booted.adapter.showStats("omp-compact-run-1", line)).toBe(false);
		const rows = visibleRows(booted.transcript);
		const statsIndex = rows.indexOf(line);
		expect(statsIndex).toBeGreaterThan(rows.indexOf("• bash: bun test"));
		expect(statsIndex).toBeLessThan(rows.indexOf("done"));
		expect(rows.filter((row) => row === line)).toHaveLength(1);
		await booted.adapter.dispose();
	},
);

stockTest(
	"stats row on a no-tool answer sits directly above the answer",
	async () => {
		const booted = await bootAdapter();
		booted.adapter.beginRun();
		addAnswer(booted, "plain answer");
		expect(finishRun(booted, "plain answer")).toBe("filtered");
		const line =
			"[ 0 actions · 100 sent · 50 received · 67% cache (200 hit) · 32s ]";
		expect(booted.adapter.showStats("omp-compact-run-1", line)).toBe(true);
		const rows = visibleRows(booted.transcript);
		expect(rows.indexOf(line)).toBeLessThan(rows.indexOf("plain answer"));
		await booted.adapter.dispose();
	},
);

stockTest("failed tool executions color the row via ledger state", async () => {
	const booted = await bootAdapter();
	booted.adapter.beginRun();
	addTool(booted, "bash", { command: "false" }, "tool-1");
	addTool(booted, "read", { path: "src/a.ts" }, "tool-2");
	booted.adapter.finishTool({
		toolCallId: "tool-1",
		toolName: "bash",
		result: { content: [{ type: "text", text: "boom" }], details: {} },
		isError: true,
	});
	booted.adapter.finishTool({
		toolCallId: "tool-2",
		toolName: "read",
		result: { content: [{ type: "text", text: "src" }], details: {} },
		isError: false,
	});
	addAnswer(booted, "done");
	expect(finishRun(booted, "done")).toBe("filtered");
	expect(booted.adapter.ledgerActions("omp-compact-run-1")).toBe(2);
	expect(booted.adapter.ledgerHasError("omp-compact-run-1")).toBe(true);
	await booted.adapter.dispose();
});

stockTest(
	"clear mode hides tool rows but keeps the stats row above the answer",
	async () => {
		const booted = await bootAdapter({ mode: "clear" });
		booted.adapter.beginRun();
		addTool(booted, "bash", { command: "bun test" }, "tool-1");
		booted.adapter.finishTool({
			toolCallId: "tool-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		addAnswer(booted, "clear done");
		expect(finishRun(booted, "clear done")).toBe("filtered");
		const line =
			"[ 1 actions · 100 sent · 50 received · 67% cache (200 hit) · 1h 20m 32s ]";
		expect(booted.adapter.showStats("omp-compact-run-1", line)).toBe(true);
		const rows = visibleRows(booted.transcript);
		expect(rows).not.toContain("• bash: bun test");
		expect(rows.indexOf(line)).toBeLessThan(rows.indexOf("clear done"));
		await booted.adapter.dispose();
	},
);

stockTest(
	"compact mode keeps the full compact log and still gets the stats row",
	async () => {
		const booted = await bootAdapter({ mode: "compact" });
		booted.adapter.beginRun();
		addTool(booted, "bash", { command: "bun test" }, "tool-1");
		booted.adapter.finishTool({
			toolCallId: "tool-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		addAnswer(booted, "compact done");
		// compact maps the successful answer to the full-retained phase…
		expect(finishRun(booted, "compact done")).toBe("full");
		// …but the hook still fires (success is classified from the event),
		// so the row renders after the retained compact tool log.
		expect(booted.finalizedRuns).toEqual(["omp-compact-run-1"]);
		const line =
			"[ 1 actions · 100 sent · 50 received · 67% cache (200 hit) · 1h 20m 32s ]";
		expect(booted.adapter.showStats("omp-compact-run-1", line)).toBe(true);
		const rows = visibleRows(booted.transcript);
		expect(rows).toContain("• bash: bun test");
		expect(rows.indexOf(line)).toBeGreaterThan(
			rows.indexOf("• bash: bun test"),
		);
		expect(rows.indexOf(line)).toBeLessThan(rows.indexOf("compact done"));
		await booted.adapter.dispose();
	},
);

stockTest("continuation keeps one run and one stats row", async () => {
	const booted = await bootAdapter();
	booted.adapter.beginRun();
	addTool(booted, "bash", { command: "first" }, "tool-1");
	booted.adapter.finishTool({
		toolCallId: "tool-1",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
	});
	addAnswer(booted, "partial");
	expect(finishRun(booted, "partial", "toolUse", true)).toBe("working");
	// continuation: agent_start must not open a second run
	booted.adapter.beginRun();
	addAnswer(booted, "final");
	expect(finishRun(booted, "final")).toBe("filtered");
	expect(booted.finalizedRuns).toEqual(["omp-compact-run-1"]);
	expect(booted.adapter.ledgerActions("omp-compact-run-1")).toBe(1);
	await booted.adapter.dispose();
});

stockTest(
	"replay reinserts the stats row above the answer from persisted evidence",
	async () => {
		const evidence = {
			version: 1,
			runId: "omp-compact-run-7",
			actions: 1,
			sent: 100,
			received: 50,
			cacheRead: 200,
			cacheWrite: 30,
			hitRate: 200 / 300,
			durationMs: 4_832_000,
			hasError: false,
			messages: 2,
			completedAt: 1_700_000_100_000,
		};
		const booted = await bootAdapter({
			statsRenderer: (value) => {
				const e = value as typeof evidence;
				return `[ ${e.actions} actions · ${e.sent} sent · ${e.received} received · ${Math.round(e.hitRate * 100)}% cache (${e.cacheRead} hit) · 1h 20m 32s ]`;
			},
		});
		const branch = [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hi" }],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "" },
						{ type: "toolCall", id: "tool-1", name: "bash", arguments: {} },
					],
					stopReason: "toolUse",
					timestamp: 2,
					usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "bash",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
			},
			{
				type: "message",
				message: assistant("replayed done"),
			},
			{ type: "custom", customType: "omp-compact-stats", data: evidence },
		];
		// host side builds the transcript before hydration — components are
		// added without any tool events (a real replay never re-fires them)
		const tool = new host.ToolExecutionComponent(
			"bash",
			{ command: "bun test" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			"/tmp",
			"tool-1",
		);
		booted.transcript.addChild(tool);
		addAnswer(booted, "replayed done");
		booted.adapter.hydrateBranch(branch);
		const line =
			"[ 1 actions · 100 sent · 50 received · 67% cache (200 hit) · 1h 20m 32s ]";
		const rows = visibleRows(booted.transcript);
		expect(rows.indexOf(line)).toBeGreaterThan(
			rows.indexOf("• bash: bun test"),
		);
		expect(rows.indexOf(line)).toBeLessThan(rows.indexOf("replayed done"));
		expect(rows.filter((row) => row === line)).toHaveLength(1);
		expect(tool).toBeDefined();
		await booted.adapter.dispose();
	},
);

stockTest(
	"no-tool replay places the row above the branch-final answer",
	async () => {
		const evidence = {
			version: 1,
			runId: "omp-compact-run-9",
			actions: 0,
			sent: 100,
			received: 50,
			cacheRead: 200,
			cacheWrite: 30,
			hitRate: 200 / 300,
			durationMs: 32_000,
			hasError: false,
			messages: 1,
			completedAt: 1_700_000_100_000,
		};
		const booted = await bootAdapter({
			statsRenderer: (value) => {
				const e = value as typeof evidence;
				return `[ ${e.actions} actions · ${e.sent} sent · ${e.received} received · 67% cache (${e.cacheRead} hit) · 32s ]`;
			},
		});
		const branch = [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hi" }],
					timestamp: 1,
				},
			},
			{ type: "message", message: assistant("replayed plain") },
			{ type: "custom", customType: "omp-compact-stats", data: evidence },
		];
		addAnswer(booted, "replayed plain");
		booted.adapter.hydrateBranch(branch);
		const line =
			"[ 0 actions · 100 sent · 50 received · 67% cache (200 hit) · 32s ]";
		const rows = visibleRows(booted.transcript);
		expect(rows.indexOf(line)).toBeLessThan(rows.indexOf("replayed plain"));
		expect(rows.filter((row) => row === line)).toHaveLength(1);
		await booted.adapter.dispose();
	},
);

stockTest(
	"session dispose clears stats state and stays fail-open",
	async () => {
		const booted = await bootAdapter();
		booted.adapter.beginRun();
		addAnswer(booted, "done");
		expect(finishRun(booted, "done")).toBe("filtered");
		expect(
			booted.adapter.showStats(
				"omp-compact-run-1",
				"[ 0 actions · 100 sent · 50 received · 67% cache (200 hit) · 32s ]",
			),
		).toBe(true);
		await booted.adapter.dispose();
		// disposed: no new rows, no crashes, transcript still renders
		expect(
			booted.adapter.showStats("omp-compact-run-1", "[ 0 actions · 100 sent ]"),
		).toBe(false);
		expect(() => booted.transcript.render(120)).not.toThrow();
		expect(booted.clearedTimers.length).toBeGreaterThan(0);
		expect(booted.notifications).toEqual([]);
	},
);
