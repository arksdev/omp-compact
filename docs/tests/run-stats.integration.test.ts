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
				autoShake: { enabled: false, thresholdTokens: 120_000 },
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
		// Idle install never arms the spinner; dispose still clears if armed.
		expect(booted.clearedTimers.length).toBe(0);
		expect(booted.notifications).toEqual([]);
	},
);

/**
 * Minimal stock TTSR fingerprint: public children/getText for extraction,
 * addRules/setExpanded/setToolActivityVisible for classification, and a
 * native render that paints a background so the override is observable.
 */
class FakeTtsrNotification {
	children: Array<
		{ getText(): string } | { children: Array<{ getText(): string }> }
	> = [];
	#name: string;
	#body: string;
	#expanded = false;
	/** Counts every native render; the patch must not stack wrappers. */
	nativeRenderCount = 0;

	constructor(name: string, body: string) {
		this.#name = name;
		this.#body = body;
		this.#rebuild();
	}

	#rebuild(): void {
		const body = this.#expanded
			? this.#body
			: this.#body.split("\n").slice(0, 2).join("\n");
		this.children = [
			{ getText: () => `⚠ Injecting rule: ${this.#name}  ↺` },
			{ getText: () => body },
		];
	}

	addRules(): void {}
	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#rebuild();
	}
	setToolActivityVisible(): void {}

	render(_width: number): readonly string[] {
		this.nativeRenderCount++;
		// Stock yellow card signature: a background open/reset pair.
		return [`\x1b[48;2;80;80;0mNATIVE inject card ${this.#name}\x1b[49m`];
	}
}

class UnrecognizedTtsrLike {
	children = [{ getText: () => "not an inject header" }];
	addRules(): void {}
	setExpanded(): void {}
	setToolActivityVisible(): void {}
	render(_width: number): readonly string[] {
		return ["\x1b[48;2;1;1;1mNATIVE fallback\x1b[49m"];
	}
}

function stripAnsi(value: string): string {
	return value.replace(ansiPattern, "");
}

stockTest(
	"TTSR inject: pre-install child and post-install addChild both attach the override",
	async () => {
		const root = new host.ContainerBase();
		const transcript = new host.TranscriptContainer();
		const pre = new FakeTtsrNotification(
			"pre-rule",
			"body before install\nsecond",
		);
		// Present BEFORE adapter install: #installTranscript walks existing children.
		transcript.addChild(pre);
		root.addChild(transcript);

		const adapter = new adapterModule.RuntimeAdapter({
			root,
			ui: {
				theme: host.getTheme(),
				setWidget(_key, content) {
					if (typeof content === "function") {
						(content as (tui: unknown) => Renderable)(root);
					}
				},
				requestRender() {},
				getToolsExpanded: () => false,
			},
		});
		expect(adapter.install()).toBe(true);

		const preRows = pre.render(120);
		expect(preRows.map(stripAnsi)).toEqual([
			"• inject: pre-rule",
			"body before install",
			"second",
		]);
		expect(preRows.join("\n")).not.toContain("\x1b[48;");
		expect(preRows.join("\n")).not.toContain("NATIVE");
		// Extraction succeeded: native body never ran.
		expect(pre.nativeRenderCount).toBe(0);

		const post = new FakeTtsrNotification("post-rule", "after install body");
		// Present AFTER install: the exact addChild wrapper observes it.
		transcript.addChild(post);
		const postRows = post.render(120);
		expect(postRows.map(stripAnsi)).toEqual([
			"• inject: post-rule",
			"after install body",
		]);
		expect(postRows.join("\n")).not.toContain("\x1b[48;");
		expect(post.nativeRenderCount).toBe(0);

		// Idempotent: a second observe of the same instance must not stack wrappers.
		transcript.addChild(post);
		const again = post.render(80);
		expect(again.map(stripAnsi)[0]).toBe("• inject: post-rule");
		expect(post.nativeRenderCount).toBe(0);

		await adapter.dispose();
	},
);

stockTest(
	"TTSR inject: clear/rebuild restores native then re-attaches without double-wrap",
	async () => {
		const booted = await bootAdapter();
		const ttsr = new FakeTtsrNotification(
			"rebuild-rule",
			"line one\nline two\nline three",
		);
		booted.transcript.addChild(ttsr);

		const live = ttsr.render(120);
		expect(stripAnsi(live[0] ?? "")).toBe("• inject: rebuild-rule");
		expect(live.join("\n")).not.toContain("\x1b[48;");
		expect(ttsr.nativeRenderCount).toBe(0);

		// Expanded only grows recoverable body text; compact inject still wins.
		ttsr.setExpanded(true);
		const expanded = ttsr.render(120);
		expect(expanded.map(stripAnsi)).toEqual([
			"• inject: rebuild-rule",
			"line one",
			"line two",
			"line three",
		]);
		expect(expanded.join("\n")).not.toContain("\x1b[48;");
		expect(ttsr.nativeRenderCount).toBe(0);

		// Clear detaches TTSR patches (native restored) before stock empties.
		booted.transcript.clear();
		const nativeAfterDetach = ttsr.render(120);
		expect(nativeAfterDetach.join("\n")).toContain("\x1b[48;");
		expect(stripAnsi(nativeAfterDetach[0] ?? "")).toContain(
			"NATIVE inject card",
		);
		expect(ttsr.nativeRenderCount).toBe(1);

		// Stock repopulates through the surviving addChild wrapper.
		booted.transcript.addChild(ttsr);
		// Settlement microtask re-observes any already-present children too.
		await Promise.resolve();
		await Promise.resolve();

		const reattached = ttsr.render(120);
		expect(stripAnsi(reattached[0] ?? "")).toBe("• inject: rebuild-rule");
		expect(reattached.join("\n")).not.toContain("\x1b[48;");
		// Successful extraction never hits native after re-attach.
		expect(ttsr.nativeRenderCount).toBe(1);

		// Second clear + re-add stays single-wrapped; no extra native calls.
		booted.transcript.clear();
		booted.transcript.addChild(ttsr);
		await Promise.resolve();
		await Promise.resolve();
		expect(stripAnsi(ttsr.render(40)[0] ?? "")).toMatch(/^• inject:/);
		// Only the explicit post-detach native probe above should have run.
		expect(ttsr.nativeRenderCount).toBe(1);

		await booted.adapter.dispose();
	},
);

stockTest(
	"TTSR inject: unrecognized trees fail open to native; dispose restores native",
	async () => {
		const booted = await bootAdapter();
		const bad = new UnrecognizedTtsrLike();
		booted.transcript.addChild(bad);
		const rows = bad.render(120);
		expect(rows.join("\n")).toContain("\x1b[48;");
		expect(stripAnsi(rows[0] ?? "")).toBe("NATIVE fallback");

		const good = new FakeTtsrNotification("dispose-rule", "payload");
		booted.transcript.addChild(good);
		expect(stripAnsi(good.render(120)[0] ?? "")).toBe("• inject: dispose-rule");

		await booted.adapter.dispose();
		const afterDispose = good.render(120);
		expect(afterDispose.join("\n")).toContain("\x1b[48;");
		expect(stripAnsi(afterDispose[0] ?? "")).toContain("NATIVE inject card");
	},
);

/**
 * Minimal stock TodoReminder fingerprint: public children/getText for
 * extraction, setToolActivityVisible only (no addRules/setExpanded), and a
 * native render that paints a yellow inverse card so the override is observable.
 */
class FakeTodoReminder {
	children: Array<
		| { getText(): string }
		| { children: Array<{ getText(): string } | Record<string, never>> }
		| Record<string, never>
	> = [];
	#count: number;
	#attempt: number;
	#maxAttempts: number;
	#items: readonly string[];
	/** Counts every native render; the patch must not stack wrappers. */
	nativeRenderCount = 0;

	constructor(
		count: number,
		attempt: number,
		maxAttempts: number,
		items: readonly string[],
	) {
		this.#count = count;
		this.#attempt = attempt;
		this.#maxAttempts = maxAttempts;
		this.#items = items;
		this.#rebuild();
	}

	#rebuild(): void {
		const label = this.#count === 1 ? "todo" : "todos";
		const header = `⚠ ${this.#count} incomplete ${label} - reminder ${this.#attempt}/${this.#maxAttempts}`;
		const body = this.#items.map((item) => `  ☐ ${item}`).join("\n");
		this.children = [
			{},
			{
				children: [{ getText: () => header }, {}, { getText: () => body }],
			},
		];
	}

	setToolActivityVisible(): void {}

	render(_width: number): readonly string[] {
		this.nativeRenderCount++;
		return [
			`\x1b[7m\x1b[38;2;200;160;0mNATIVE todo reminder ${this.#count}\x1b[39m\x1b[27m`,
		];
	}
}

stockTest(
	"Todo reminder: pre-install child and post-install addChild both attach the override",
	async () => {
		const root = new host.ContainerBase();
		const transcript = new host.TranscriptContainer();
		const pre = new FakeTodoReminder(1, 1, 3, ["pre item"]);
		transcript.addChild(pre);
		root.addChild(transcript);

		const adapter = new adapterModule.RuntimeAdapter({
			root,
			ui: {
				theme: host.getTheme(),
				setWidget(_key, content) {
					if (typeof content === "function") {
						(content as (tui: unknown) => Renderable)(root);
					}
				},
				requestRender() {},
				getToolsExpanded: () => false,
			},
		});
		expect(adapter.install()).toBe(true);

		const preRows = pre.render(120);
		expect(preRows).toHaveLength(1);
		expect(stripAnsi(preRows[0] ?? "")).toBe(
			"• 1 incomplete todo - reminder 1/3 · pre item",
		);
		expect(preRows.join("\n")).not.toContain("\x1b[48;");
		expect(preRows.join("\n")).not.toContain("\x1b[7m");
		expect(preRows.join("\n")).not.toContain("NATIVE");
		expect(pre.nativeRenderCount).toBe(0);

		const post = new FakeTodoReminder(2, 2, 3, ["alpha", "beta"]);
		transcript.addChild(post);
		const postRows = post.render(120);
		expect(postRows).toHaveLength(1);
		expect(stripAnsi(postRows[0] ?? "")).toBe(
			"• 2 incomplete todos - reminder 2/3 · alpha · +1 more",
		);
		expect(postRows.join("\n")).not.toContain("\x1b[48;");
		expect(post.nativeRenderCount).toBe(0);

		// Idempotent: a second observe of the same instance must not stack wrappers.
		transcript.addChild(post);
		const again = post.render(80);
		expect(again).toHaveLength(1);
		expect(stripAnsi(again[0] ?? "")).toContain("reminder 2/3");
		expect(post.nativeRenderCount).toBe(0);

		// TTSR still takes the inject path on the same adapter.
		const ttsr = new FakeTtsrNotification("still-inject", "body");
		transcript.addChild(ttsr);
		expect(stripAnsi(ttsr.render(120)[0] ?? "")).toBe("• inject: still-inject");

		await adapter.dispose();
	},
);

stockTest(
	"Todo reminder: clear/rebuild restores native then re-attaches without double-wrap",
	async () => {
		const booted = await bootAdapter();
		const reminder = new FakeTodoReminder(1, 1, 3, ["rebuild item"]);
		booted.transcript.addChild(reminder);

		const live = reminder.render(120);
		expect(live).toHaveLength(1);
		expect(stripAnsi(live[0] ?? "")).toBe(
			"• 1 incomplete todo - reminder 1/3 · rebuild item",
		);
		expect(live.join("\n")).not.toContain("\x1b[7m");
		expect(reminder.nativeRenderCount).toBe(0);

		booted.transcript.clear();
		const nativeAfterDetach = reminder.render(120);
		expect(nativeAfterDetach.join("\n")).toContain("\x1b[7m");
		expect(stripAnsi(nativeAfterDetach[0] ?? "")).toContain(
			"NATIVE todo reminder",
		);
		expect(reminder.nativeRenderCount).toBe(1);

		booted.transcript.addChild(reminder);
		await Promise.resolve();
		await Promise.resolve();

		const reattached = reminder.render(120);
		expect(reattached).toHaveLength(1);
		expect(stripAnsi(reattached[0] ?? "")).toBe(
			"• 1 incomplete todo - reminder 1/3 · rebuild item",
		);
		expect(reattached.join("\n")).not.toContain("\x1b[7m");
		expect(reminder.nativeRenderCount).toBe(1);

		booted.transcript.clear();
		booted.transcript.addChild(reminder);
		await Promise.resolve();
		await Promise.resolve();
		expect(reminder.render(40)).toHaveLength(1);
		expect(reminder.nativeRenderCount).toBe(1);

		await booted.adapter.dispose();
		const afterDispose = reminder.render(120);
		expect(afterDispose.join("\n")).toContain("\x1b[7m");
		expect(stripAnsi(afterDispose[0] ?? "")).toContain("NATIVE todo reminder");
	},
);

/**
 * Activity-only leaf matching the StrippedToolCallsPlaceholder surface
 * (render + setToolActivityVisible, no reminder tree). Must stay native —
 * no DescriptorPatch install.
 */
class FakeStrippedPlaceholder {
	nativeRenderCount = 0;
	#count: number;

	constructor(count: number) {
		this.#count = count;
	}

	// Text-like leaf: no children tree, just getText on self.
	getText(): string {
		const noun = this.#count === 1 ? "tool call" : "tool calls";
		return `${this.#count} ${noun} elided — no result on this branch`;
	}

	setToolActivityVisible(): void {}

	render(_width: number): readonly string[] {
		this.nativeRenderCount++;
		return [`NATIVE elided ${this.getText()}`];
	}
}

stockTest(
	"Todo reminder: stripped-placeholder surface stays native; real reminder still compact",
	async () => {
		const booted = await bootAdapter();
		const placeholder = new FakeStrippedPlaceholder(1);
		booted.transcript.addChild(placeholder);

		const nativeRows = placeholder.render(120);
		expect(nativeRows).toEqual([
			"NATIVE elided 1 tool call elided — no result on this branch",
		]);
		expect(placeholder.nativeRenderCount).toBe(1);

		// A second observe (idempotent path) must still leave native alone.
		booted.transcript.addChild(placeholder);
		expect(placeholder.render(80)).toEqual([
			"NATIVE elided 1 tool call elided — no result on this branch",
		]);
		expect(placeholder.nativeRenderCount).toBe(2);

		const reminder = new FakeTodoReminder(1, 1, 3, ["still compact"]);
		booted.transcript.addChild(reminder);
		const compact = reminder.render(120);
		expect(compact).toHaveLength(1);
		expect(stripAnsi(compact[0] ?? "")).toBe(
			"• 1 incomplete todo - reminder 1/3 · still compact",
		);
		expect(reminder.nativeRenderCount).toBe(0);

		await booted.adapter.dispose();
		// Placeholder was never patched: dispose does not change native path.
		expect(placeholder.render(40)[0]).toContain("NATIVE elided");
		expect(stripAnsi(reminder.render(40)[0] ?? "")).toContain(
			"NATIVE todo reminder",
		);
	},
);

/**
 * Stock user bash execution fingerprint: getCommand + shared execution surface.
 * Own render override mirrors BashExecutionComponent.
 */
class FakeBashExecution {
	#command: string;
	#output = "";
	#finalized = false;
	#expanded = false;
	#exitCode: number | undefined;
	#cancelled = false;
	/**
	 * Mirrors stock Text children under the content container so the plugin's
	 * footer scrape can recover `(exit N)` / `(cancelled)` when setComplete
	 * was never observed (fresh history instances after rebuild).
	 */
	children: Array<{ getText(): string }> = [];
	nativeRenderCount = 0;

	constructor(command: string) {
		this.#command = command;
		this.#rebuildFooter();
	}

	#rebuildFooter(): void {
		const texts: Array<{ getText(): string }> = [
			{ getText: () => `$ ${this.#command}` },
		];
		if (this.#finalized) {
			if (this.#cancelled) texts.push({ getText: () => "\n(cancelled)" });
			else if (typeof this.#exitCode === "number" && this.#exitCode !== 0) {
				texts.push({ getText: () => `\n(exit ${this.#exitCode})` });
			}
		}
		this.children = texts;
	}

	getCommand(): string {
		return this.#command;
	}

	getOutput(): string {
		return this.#output;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
	}

	appendOutput(chunk: string): void {
		this.#output += chunk;
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string },
	): void {
		this.#exitCode = exitCode;
		this.#cancelled = cancelled;
		this.#finalized = true;
		if (options?.output !== undefined) this.#output = options.output;
		this.#rebuildFooter();
	}

	render(_width: number): readonly string[] {
		this.nativeRenderCount++;
		const state = this.#expanded
			? "EXPANDED"
			: this.#finalized
				? `DONE exit=${String(this.#exitCode)} cancelled=${String(this.#cancelled)}`
				: "RUNNING";
		return [
			`\x1b[48;2;40;40;40mNATIVE bash frame ${this.#command} ${state}\x1b[49m`,
		];
	}
}

/**
 * Stock user eval/python execution fingerprint: getCode + shared surface.
 * No own render — inherits from a base class the way EvalExecutionComponent
 * inherits Container.render. DescriptorPatch must still wrap/restore cleanly.
 */
class FakeExecutionBase {
	nativeRenderCount = 0;
	label = "base";

	render(_width: number): readonly string[] {
		this.nativeRenderCount++;
		return [`\x1b[48;2;20;20;60mNATIVE eval frame ${this.label}\x1b[49m`];
	}
}

class FakeEvalExecution extends FakeExecutionBase {
	#code: string;
	#output = "";
	#finalized = false;
	#expanded = false;
	#exitCode: number | undefined;
	#cancelled = false;
	/** Stock-like Text tree for footer scrape on unobserved setComplete. */
	children: Array<{ getText(): string }> = [];

	constructor(code: string) {
		super();
		this.#code = code;
		this.label = code;
		this.#rebuildFooter();
	}

	#rebuildFooter(): void {
		const texts: Array<{ getText(): string }> = [
			{ getText: () => `>>> ${this.#code}` },
		];
		if (this.#finalized) {
			if (this.#cancelled) texts.push({ getText: () => "\n(cancelled)" });
			else if (typeof this.#exitCode === "number" && this.#exitCode !== 0) {
				texts.push({ getText: () => `\n(exit ${this.#exitCode})` });
			}
		}
		this.children = texts;
	}

	getCode(): string {
		return this.#code;
	}

	getOutput(): string {
		return this.#output;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
	}

	appendOutput(chunk: string): void {
		this.#output += chunk;
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string },
	): void {
		this.#exitCode = exitCode;
		this.#cancelled = cancelled;
		this.#finalized = true;
		if (options?.output !== undefined) this.#output = options.output;
		this.label = `${this.#code} exit=${String(this.#exitCode)} cancelled=${String(this.#cancelled)} expanded=${String(this.#expanded)}`;
		this.#rebuildFooter();
	}
}

class UnrecognizedExecutionLike {
	// Shared streaming methods without getCommand/getCode — must stay native.
	appendOutput(): void {}
	setComplete(): void {}
	isTranscriptBlockFinalized(): boolean {
		return true;
	}
	getOutput(): string {
		return "";
	}
	setExpanded(): void {}
	render(_width: number): readonly string[] {
		return ["\x1b[48;2;1;1;1mNATIVE mystery execution\x1b[49m"];
	}
}

stockTest(
	"User bash/python execution: pre/post install attach, lifecycle, expand, rebuild",
	async () => {
		const root = new host.ContainerBase();
		const transcript = new host.TranscriptContainer();
		const preBash = new FakeBashExecution("ls pre");
		const preEval = new FakeEvalExecution("print('pre')");
		transcript.addChild(preBash);
		transcript.addChild(preEval);
		root.addChild(transcript);

		const adapter = new adapterModule.RuntimeAdapter({
			root,
			ui: {
				theme: host.getTheme(),
				setWidget(_key, content) {
					if (typeof content === "function") {
						(content as (tui: unknown) => Renderable)(root);
					}
				},
				requestRender() {},
				getToolsExpanded: () => false,
			},
		});
		expect(adapter.install()).toBe(true);

		// Running: compact Working… rows; inherited eval render is still wrapped.
		// Spinner glyph comes from the host theme activity frames — match the
		// stable payload rather than a pinned braille cell.
		expect(stripAnsi(preBash.render(120)[0] ?? "")).toMatch(
			/Working… bash: ls pre$/,
		);
		expect(stripAnsi(preEval.render(120)[0] ?? "")).toMatch(
			/Working… python: print\('pre'\)$/,
		);
		expect(preBash.nativeRenderCount).toBe(0);
		expect(preEval.nativeRenderCount).toBe(0);

		preBash.appendOutput("a\n");
		preBash.setComplete(0, false, { output: "a\n" });
		preEval.appendOutput("1\n");
		preEval.setComplete(0, false, { output: "1\n" });
		expect(stripAnsi(preBash.render(120)[0] ?? "")).toBe("• bash: ls pre");
		expect(stripAnsi(preEval.render(120)[0] ?? "")).toBe(
			"• python: print('pre')",
		);

		// Expanded falls back to the native multi-line frame so output is readable.
		preBash.setExpanded(true);
		preEval.setExpanded(true);
		expect(stripAnsi(preBash.render(120)[0] ?? "")).toContain(
			"NATIVE bash frame",
		);
		expect(stripAnsi(preEval.render(120)[0] ?? "")).toContain(
			"NATIVE eval frame",
		);
		expect(preBash.nativeRenderCount).toBe(1);
		expect(preEval.nativeRenderCount).toBe(1);

		// Collapse again: compact returns without stacking wrappers.
		preBash.setExpanded(false);
		preEval.setExpanded(false);
		expect(stripAnsi(preBash.render(120)[0] ?? "")).toBe("• bash: ls pre");
		expect(stripAnsi(preEval.render(120)[0] ?? "")).toBe(
			"• python: print('pre')",
		);

		const postBash = new FakeBashExecution("false");
		const postEval = new FakeEvalExecution("raise SystemExit(3)");
		transcript.addChild(postBash);
		transcript.addChild(postEval);
		postBash.setComplete(2, false);
		postEval.setComplete(undefined, true);
		expect(stripAnsi(postBash.render(120)[0] ?? "")).toBe(
			"✗ bash: false · exit 2",
		);
		expect(stripAnsi(postEval.render(120)[0] ?? "")).toBe(
			"✗ python: raise SystemExit(3) · cancelled",
		);

		// Unrecognized shared surface without getCommand/getCode stays native.
		const mystery = new UnrecognizedExecutionLike();
		transcript.addChild(mystery);
		expect(stripAnsi(mystery.render(40)[0] ?? "")).toBe(
			"NATIVE mystery execution",
		);

		// Clear detaches patches (native restored), then re-add re-attaches.
		transcript.clear();
		const nativeAfterDetach = preBash.render(120);
		expect(nativeAfterDetach.join("\n")).toContain("\x1b[48;");
		expect(stripAnsi(nativeAfterDetach[0] ?? "")).toContain(
			"NATIVE bash frame",
		);

		// Inherited render restore must delete the own wrapper (no stray own prop).
		expect(Object.getOwnPropertyDescriptor(preEval, "render")).toBeUndefined();
		expect(stripAnsi(preEval.render(120)[0] ?? "")).toContain(
			"NATIVE eval frame",
		);

		transcript.addChild(preBash);
		transcript.addChild(preEval);
		await Promise.resolve();
		await Promise.resolve();
		expect(stripAnsi(preBash.render(120)[0] ?? "")).toBe("• bash: ls pre");
		expect(stripAnsi(preEval.render(120)[0] ?? "")).toBe(
			"• python: print('pre')",
		);

		// Idempotent second observe must not stack wrappers.
		transcript.addChild(preBash);
		expect(stripAnsi(preBash.render(80)[0] ?? "")).toBe("• bash: ls pre");

		await adapter.dispose();
		expect(stripAnsi(preBash.render(40)[0] ?? "")).toContain(
			"NATIVE bash frame",
		);
		expect(Object.getOwnPropertyDescriptor(preEval, "render")).toBeUndefined();
		expect(stripAnsi(preEval.render(40)[0] ?? "")).toContain(
			"NATIVE eval frame",
		);
	},
);

stockTest(
	"User bash/python execution: install-time probe refuses empty source",
	async () => {
		const booted = await bootAdapter();
		const emptyBash = new FakeBashExecution("   ");
		const emptyEval = new FakeEvalExecution("");
		booted.transcript.addChild(emptyBash);
		booted.transcript.addChild(emptyEval);
		expect(stripAnsi(emptyBash.render(80)[0] ?? "")).toContain(
			"NATIVE bash frame",
		);
		expect(stripAnsi(emptyEval.render(80)[0] ?? "")).toContain(
			"NATIVE eval frame",
		);
		expect(emptyBash.nativeRenderCount).toBe(1);
		expect(emptyEval.nativeRenderCount).toBe(1);

		const good = new FakeBashExecution("echo ok");
		booted.transcript.addChild(good);
		good.setComplete(0, false);
		expect(stripAnsi(good.render(80)[0] ?? "")).toBe("• bash: echo ok");

		await booted.adapter.dispose();
	},
);

stockTest(
	"User bash/python execution: fresh history instance keeps exit after rebuild",
	async () => {
		// Stock history rebuild constructs a NEW component, calls setComplete
		// with the recorded exit, THEN addChilds it. The adapter never saw the
		// original setComplete on that instance — exit must come from the
		// stock footer Text tree via scrape, not the WeakMap observation.
		const booted = await bootAdapter();

		const live = new FakeBashExecution("false");
		booted.transcript.addChild(live);
		live.setComplete(2, false, { output: "boom\n" });
		expect(stripAnsi(live.render(120)[0] ?? "")).toBe("✗ bash: false · exit 2");

		// Clear detaches every user-execution patch (WeakMap state stays with
		// the retired instance and is irrelevant to a fresh one).
		booted.transcript.clear();
		await Promise.resolve();
		await Promise.resolve();

		// Fresh instance: setComplete BEFORE addChild, matching
		// chat-transcript-builder / ui-helpers history reconstruction.
		const histBash = new FakeBashExecution("false");
		histBash.setComplete(2, false, { output: "boom\n" });
		const histPy = new FakeEvalExecution("raise SystemExit(3)");
		histPy.setComplete(undefined, true);

		booted.transcript.addChild(histBash);
		booted.transcript.addChild(histPy);
		await Promise.resolve();
		await Promise.resolve();

		expect(stripAnsi(histBash.render(120)[0] ?? "")).toBe(
			"✗ bash: false · exit 2",
		);
		expect(stripAnsi(histPy.render(120)[0] ?? "")).toBe(
			"✗ python: raise SystemExit(3) · cancelled",
		);
		// Footer scrape path: never hit native (compact succeeded).
		expect(histBash.nativeRenderCount).toBe(0);
		expect(histPy.nativeRenderCount).toBe(0);

		// Second rebuild with another fresh failed instance still scrapes.
		booted.transcript.clear();
		const again = new FakeBashExecution("exit 7");
		again.setComplete(7, false);
		booted.transcript.addChild(again);
		await Promise.resolve();
		await Promise.resolve();
		expect(stripAnsi(again.render(80)[0] ?? "")).toBe(
			"✗ bash: exit 7 · exit 7",
		);

		await booted.adapter.dispose();
	},
);

class FakeSkillMessage {
	nativeRenderCount = 0;
	message: {
		role: string;
		customType: string;
		content: string;
		display: boolean;
		details: {
			name: string;
			args?: string;
			path?: string;
			lineCount?: number;
		};
	};
	#expanded = false;

	constructor(
		name: string,
		options?: { args?: string; path?: string; lineCount?: number },
	) {
		this.message = {
			role: "custom",
			customType: "skill-prompt",
			content: "PROMPT BODY",
			display: true,
			details: {
				name,
				args: options?.args,
				path: options?.path,
				lineCount: options?.lineCount,
			},
		};
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
	}

	render(_width: number): readonly string[] {
		this.nativeRenderCount++;
		if (this.#expanded) {
			return [
				`\x1b[48;2;40;20;60mNATIVE skill card ${this.message.details.name} EXPANDED\x1b[49m`,
				"prompt body line",
			];
		}
		return [
			`\x1b[48;2;40;20;60mNATIVE skill card ${this.message.details.name}\x1b[49m`,
		];
	}
}

class FakeGenericCustom {
	nativeRenderCount = 0;
	message: { customType: string; content: string };

	constructor(customType: string) {
		this.message = { customType, content: "ext body" };
	}

	setExpanded(): void {}

	render(_width: number): readonly string[] {
		this.nativeRenderCount++;
		return [`\x1b[48;2;1;1;1mNATIVE custom ${this.message.customType}\x1b[49m`];
	}
}

class FakeLateDiagnostics {
	nativeRenderCount = 0;
	files: Array<{
		path?: string;
		summary?: string;
		errored?: boolean;
		messages?: string[];
	}>;
	#expanded = false;

	constructor(
		files: Array<{
			path?: string;
			summary?: string;
			errored?: boolean;
			messages?: string[];
		}>,
	) {
		this.files = files;
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
	}

	setToolActivityVisible(): void {}

	render(_width: number): readonly string[] {
		this.nativeRenderCount++;
		const tag = this.#expanded ? " EXPANDED" : "";
		return [`\x1b[48;2;60;40;0mNATIVE late diagnostics${tag}\x1b[49m`];
	}
}

class FakeToolActivityContainer {
	children: unknown[];
	nativeRenderCount = 0;

	constructor(child: unknown) {
		this.children = [child];
	}

	setExpanded(): void {}
	setToolActivityVisible(): void {}

	render(_width: number): readonly string[] {
		this.nativeRenderCount++;
		return ["\x1b[48;2;2;2;2mNATIVE tool-activity container\x1b[49m"];
	}
}

stockTest(
	"Skill + late diagnostics: attach, expand native, rebuild, false positives",
	async () => {
		const root = new host.ContainerBase();
		const transcript = new host.TranscriptContainer();
		const preSkill = new FakeSkillMessage("pre-skill", {
			args: "--x",
			path: "/tmp/S.md",
			lineCount: 3,
		});
		const preLate = new FakeLateDiagnostics([
			{
				path: "a.ts",
				summary: "1 error",
				errored: true,
				messages: ["a.ts:1:1: error: boom", "a.ts:2:1: error: two"],
			},
		]);
		transcript.addChild(preSkill);
		transcript.addChild(preLate);
		root.addChild(transcript);

		const adapter = new adapterModule.RuntimeAdapter({
			root,
			ui: {
				theme: host.getTheme(),
				setWidget(_key, content) {
					if (typeof content === "function") {
						(content as (tui: unknown) => Renderable)(root);
					}
				},
				requestRender() {},
				getToolsExpanded: () => false,
			},
		});
		expect(adapter.install()).toBe(true);

		expect(stripAnsi(preSkill.render(120)[0] ?? "")).toBe(
			"• skill pre-skill --x · /tmp/S.md · 3 lines",
		);
		expect(preSkill.nativeRenderCount).toBe(0);
		expect(stripAnsi(preLate.render(120)[0] ?? "")).toContain(
			"late diagnostics",
		);
		expect(stripAnsi(preLate.render(120)[0] ?? "")).toContain("boom");
		expect(preLate.nativeRenderCount).toBe(0);

		// Expanded → native multi-line / full tree.
		preSkill.setExpanded(true);
		preLate.setExpanded(true);
		expect(stripAnsi(preSkill.render(120)[0] ?? "")).toContain(
			"NATIVE skill card",
		);
		expect(stripAnsi(preSkill.render(120).join("\n"))).toContain(
			"prompt body line",
		);
		expect(stripAnsi(preLate.render(120)[0] ?? "")).toContain(
			"NATIVE late diagnostics EXPANDED",
		);

		preSkill.setExpanded(false);
		preLate.setExpanded(false);
		expect(stripAnsi(preSkill.render(120)[0] ?? "")).toMatch(/^• skill /);
		expect(stripAnsi(preLate.render(120)[0] ?? "")).toMatch(
			/^• late diagnostics/,
		);

		// False positives stay native.
		const generic = new FakeGenericCustom("my-extension-card");
		const handoff = new FakeGenericCustom("handoff");
		const compactOwn = new FakeGenericCustom("omp-compact-stats");
		const emptyLate = new FakeLateDiagnostics([]);
		const activity = new FakeToolActivityContainer({ id: "inner" });
		transcript.addChild(generic);
		transcript.addChild(handoff);
		transcript.addChild(compactOwn);
		transcript.addChild(emptyLate);
		transcript.addChild(activity);
		expect(stripAnsi(generic.render(40)[0] ?? "")).toContain(
			"NATIVE custom my-extension-card",
		);
		expect(stripAnsi(handoff.render(40)[0] ?? "")).toContain(
			"NATIVE custom handoff",
		);
		expect(stripAnsi(compactOwn.render(40)[0] ?? "")).toContain(
			"NATIVE custom omp-compact-stats",
		);
		expect(stripAnsi(emptyLate.render(40)[0] ?? "")).toContain(
			"NATIVE late diagnostics",
		);
		expect(emptyLate.nativeRenderCount).toBe(1);
		expect(stripAnsi(activity.render(40)[0] ?? "")).toContain(
			"NATIVE tool-activity container",
		);
		expect(activity.nativeRenderCount).toBe(1);

		// Clear detaches; re-add re-attaches.
		transcript.clear();
		expect(stripAnsi(preSkill.render(80)[0] ?? "")).toContain(
			"NATIVE skill card",
		);
		transcript.addChild(preSkill);
		transcript.addChild(preLate);
		await Promise.resolve();
		await Promise.resolve();
		expect(stripAnsi(preSkill.render(120)[0] ?? "")).toMatch(/^• skill /);
		expect(stripAnsi(preLate.render(120)[0] ?? "")).toMatch(
			/^• late diagnostics/,
		);

		// Idempotent second observe.
		transcript.addChild(preSkill);
		expect(stripAnsi(preSkill.render(80)[0] ?? "")).toMatch(/^• skill /);

		await adapter.dispose();
		expect(stripAnsi(preSkill.render(40)[0] ?? "")).toContain(
			"NATIVE skill card",
		);
		expect(stripAnsi(preLate.render(40)[0] ?? "")).toContain(
			"NATIVE late diagnostics",
		);
	},
);

stockTest(
	"Skill + late diagnostics: install-time probe refuses empty late files",
	async () => {
		const booted = await bootAdapter();
		const empty = new FakeLateDiagnostics([
			{ path: "a.ts", summary: "none", messages: [] },
		]);
		booted.transcript.addChild(empty);
		expect(stripAnsi(empty.render(80)[0] ?? "")).toContain(
			"NATIVE late diagnostics",
		);
		expect(empty.nativeRenderCount).toBe(1);

		const good = new FakeLateDiagnostics([
			{ messages: ["z.ts:1:1: warning: soft"], summary: "1 warning" },
		]);
		booted.transcript.addChild(good);
		expect(stripAnsi(good.render(120)[0] ?? "")).toMatch(/^• late diagnostics/);
		expect(good.nativeRenderCount).toBe(0);

		await booted.adapter.dispose();
	},
);
