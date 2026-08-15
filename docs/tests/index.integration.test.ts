import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_SETTINGS } from "../../.omp-plugin/config";
import { KEY_DOWN, KEY_ESCAPE, KEY_SPACE } from "../../.omp-plugin/settings-ui";
import {
	type HostModules,
	loadHost,
	type Renderable,
	stockSettingsPath,
	type ToolExecutionInstance,
	type TranscriptInstance,
	writeStockSettings,
} from "./test-stock-host";

const binary = process.env.OMP_STOCK_BIN;
const stockTest = binary ? test : test.skip;
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type Handler = (
	event: Record<string, unknown>,
	context: BootedPlugin["context"],
) => unknown;
type MessageRenderer = (
	message: { details?: unknown },
	options: { expanded: boolean },
	theme: ReturnType<HostModules["getTheme"]>,
) => Renderable | undefined;

interface SentMessage {
	message: Record<string, unknown>;
	options?: Record<string, unknown>;
}

interface AppendedEntry {
	customType: string;
	data?: unknown;
}

interface BootedPlugin {
	host: HostModules;
	handlers: Map<string, Handler[]>;
	context: {
		cwd: string;
		hasUI: boolean;
		ui: {
			theme: ReturnType<HostModules["getTheme"]>;
			setWidget(key: string, content: unknown): void;
			notify(message: string, level: string): void;
			getToolsExpanded(): boolean;
			custom?<T>(
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (result: T) => void,
				) => unknown,
			): Promise<T>;
		};
		sessionManager: { getBranch(): readonly unknown[] };
		setInterval?(callback: () => void, milliseconds: number): unknown;
		clearTimer?(timer: unknown): void;
	};
	root: { addChild(child: unknown): void };
	ContainerBase: new () => {
		addChild(child: unknown): void;
		render(width: number): readonly string[];
	};
	registeredTools: string[];
	commands: string[];
	commandHandlers: Map<
		string,
		(args: string, ctx: BootedPlugin["context"]) => Promise<void>
	>;
	sentMessages: SentMessage[];
	appendedEntries: AppendedEntry[];
	renderers: Map<string, MessageRenderer>;
	notifications: string[];
	intervalCallbacks: Array<() => void>;
	clearedTimers: unknown[];
	dialogs: Array<{
		handleInput(data: string): void;
		settled(): Promise<void>;
		current: { enabled: boolean } | undefined;
		isDirty: boolean;
		saving: boolean;
		finished: boolean;
	}>;
}

/**
 * PostTurnShake integration harness: injects the public SDK registry seam
 * (`pi.pi.AgentRegistry`) with a fake live main AgentSession and pins the
 * command/event context's sessionManager to that session, so the plugin's
 * identity check resolves and every native shake dispatch is observable.
 */
interface BootHarness {
	piPi?: unknown;
	sessionManager?: { getBranch(): readonly unknown[] };
}

async function bootPlugin(
	prepare?: (root: BootedPlugin["root"], host: HostModules) => void,
	cwd = "/tmp",
	branch: readonly unknown[] = [],
	toolsExpanded = false,
	settings?: Record<string, unknown>,
	harness?: BootHarness,
): Promise<BootedPlugin> {
	const host = await loadHost();
	await host.initTheme();
	// RuntimeModes: keep every boot hermetic — point the plugin at a temp
	// settings file (defaults unless the test overrides) so the user's real
	// config can never leak into the suite. `resolveConfigPath` reads the env
	// synchronously at store creation inside host.plugin(pi), so the env can
	// be restored right after.
	//
	// The default boot disables the stats row: the audit/mode/Git contracts
	// below predate RunStats and assert exact evidence lists. Stats wiring
	// gets its own dedicated contracts that boot with stats explicitly
	// enabled.
	const bootSettings = settings ?? {
		...DEFAULT_SETTINGS,
		stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
	};
	const modeConfigPath = writeStockSettings(bootSettings, "test-settings.json");
	const previousModeConfig = Bun.env.OMP_COMPACT_CONFIG;
	Bun.env.OMP_COMPACT_CONFIG = modeConfigPath;
	const handlers = new Map<string, Handler[]>();
	const registeredTools: string[] = [];
	const commands: string[] = [];
	const commandHandlers = new Map<
		string,
		(args: string, ctx: BootedPlugin["context"]) => Promise<void>
	>();
	const sentMessages: SentMessage[] = [];
	const appendedEntries: AppendedEntry[] = [];
	const renderers = new Map<string, MessageRenderer>();
	const notifications: string[] = [];
	const intervalCallbacks: Array<() => void> = [];
	const clearedTimers: unknown[] = [];
	// Settings-dialog instances opened through the harness ui.custom seam;
	// drives the real /compact-settings save flow (store.update path).
	const dialogs: BootedPlugin["dialogs"] = [];
	const pi = {
		setLabel() {},
		getActiveTools() {
			throw new Error("native active-tool registry must not be queried");
		},
		setActiveTools() {
			throw new Error("native active-tool registry must not be changed");
		},
		registerTool(definition: { name: string }) {
			registeredTools.push(definition.name);
		},
		getCommands() {
			return commands.map((name) => ({ name }));
		},
		registerCommand(
			name: string,
			options?: {
				handler?: (args: string, ctx: BootedPlugin["context"]) => Promise<void>;
			},
		) {
			commands.push(name);
			if (options?.handler) commandHandlers.set(name, options.handler);
		},
		registerMessageRenderer(type: string, renderer: MessageRenderer) {
			renderers.set(type, renderer);
		},
		sendMessage(
			message: Record<string, unknown>,
			options?: Record<string, unknown>,
		) {
			sentMessages.push({ message, options });
		},
		appendEntry(customType: string, data?: unknown) {
			appendedEntries.push({ customType, data });
		},
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	// PostTurnShake harness: the plugin reads the public SDK registry seam
	// (`pi.pi.AgentRegistry`) synchronously at boot; inject the probe first.
	if (harness?.piPi !== undefined) {
		(pi as { pi?: unknown }).pi = harness.piPi;
	}
	// `createSettingsStore` resolves the config path synchronously, so the
	// env must be set while the plugin boots and can be restored right after.
	try {
		host.plugin(pi);
	} finally {
		if (previousModeConfig === undefined) {
			delete Bun.env.OMP_COMPACT_CONFIG;
		} else {
			Bun.env.OMP_COMPACT_CONFIG = previousModeConfig;
		}
	}
	const ContainerBase = Object.getPrototypeOf(
		host.ReadToolGroupComponent.prototype,
	).constructor as BootedPlugin["ContainerBase"];
	const root = new ContainerBase();
	prepare?.(root, host);
	const context: BootedPlugin["context"] = {
		cwd,
		hasUI: true,
		ui: {
			theme: host.getTheme(),
			setWidget(_key, content) {
				if (typeof content === "function") {
					(content as (tui: unknown) => Renderable)(root);
				}
			},
			notify(message) {
				notifications.push(message);
			},
			getToolsExpanded() {
				return toolsExpanded;
			},
			// Settings-dialog seam: open the real dialog through the command
			// handler and keep the instance so tests can drive the save flow.
			custom<T>(
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (result: T) => void,
				) => unknown,
			): Promise<T> {
				let resolve!: (result: T) => void;
				const promise = new Promise<T>((res) => {
					resolve = res;
				});
				const component = factory(
					{},
					host.getTheme(),
					{ matches: () => false },
					resolve,
				) as BootedPlugin["dialogs"][number];
				dialogs.push(component);
				return promise;
			},
		},
		sessionManager: harness?.sessionManager ?? { getBranch: () => branch },
		setInterval(callback) {
			intervalCallbacks.push(callback);
			return callback;
		},
		clearTimer(timer) {
			clearedTimers.push(timer);
		},
	};
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" }, context);
	}
	return {
		host,
		handlers,
		context,
		root,
		ContainerBase,
		registeredTools,
		commands,
		commandHandlers,
		sentMessages,
		renderers,
		appendedEntries,
		notifications,
		intervalCallbacks,
		clearedTimers,
		dialogs,
	};
}

async function dispatch(
	booted: BootedPlugin,
	event: Record<string, unknown>,
): Promise<void> {
	for (const handler of booted.handlers.get(String(event.type)) ?? []) {
		await handler(event, booted.context);
	}
}

/**
 * Stock AgentSession (`oh-my-pi/packages/agent/src/agent.ts`) delivers
 * extension events through an async `#handleAgentEvent` that never awaits the
 * listener promises: consecutive `tool_execution_start` / `tool_execution_end`
 * / `agent_end` handlers overlap in flight. `dispatch` above awaits each
 * handler, so the sequential suite below always sees the previous handler's
 * work completed — that is exactly what masks the race this section models.
 *
 * `dispatchFireAndForget` mirrors stock delivery: it invokes every listener
 * synchronously (each async handler runs up to its first `await` before
 * control returns) and returns a promise for later settling, without waiting
 * for any previously started handler. Firing start then immediately end (or
 * end then immediately `agent_end`) therefore forces the second handler's
 * synchronous prologue to run while the first handler is still suspended on
 * filesystem awaits — no sleeps, no timers, fully deterministic.
 */
function dispatchFireAndForget(
	booted: BootedPlugin,
	event: Record<string, unknown>,
): Promise<void> {
	const pending: Promise<unknown>[] = [];
	for (const handler of booted.handlers.get(String(event.type)) ?? []) {
		pending.push(Promise.resolve(handler(event, booted.context)));
	}
	return Promise.all(pending).then(() => undefined);
}

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

function assistant(text: string, stopReason = "stop"): Record<string, unknown> {
	return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

function visibleRows(component: Renderable, width = 120): string[] {
	return component
		.render(width)
		.map((line) => line.replace(ansiPattern, "").trimEnd())
		.filter((line) => line.trim().length > 0);
}

function screenRows(component: Renderable, width = 120): string[] {
	return component
		.render(width)
		.map((line) => line.replace(ansiPattern, "").trimEnd());
}

async function bootWithTranscript(
	cwd = "/tmp",
	toolsExpanded = false,
): Promise<BootedPlugin & { transcript: TranscriptInstance }> {
	let transcript: TranscriptInstance | undefined;
	const booted = await bootPlugin(
		(root, host) => {
			transcript = new host.TranscriptContainer();
			root.addChild(transcript);
		},
		cwd,
		[],
		toolsExpanded,
	);
	if (!transcript) throw new Error("transcript container missing");
	return { ...booted, transcript };
}

async function beginRun(booted: BootedPlugin): Promise<void> {
	await dispatch(booted, { type: "agent_start" });
}

async function addTool(
	booted: BootedPlugin & { transcript: TranscriptInstance },
	toolName: string,
	args: unknown,
	toolCallId: string,
): Promise<ToolExecutionInstance> {
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId,
		toolName,
		args,
	});
	return addToolComponent(booted, toolName, args, toolCallId);
}

/**
 * The native component half of `addTool`, without the awaited start event:
 * stock hosts create the component and register it on the transcript while
 * the extension start event is still in flight, so the race tests bind the
 * component independently of the fire-and-forget dispatch order.
 */
function addToolComponent(
	booted: BootedPlugin & { transcript: TranscriptInstance },
	toolName: string,
	args: unknown,
	toolCallId: string,
): ToolExecutionInstance {
	const component = new booted.host.ToolExecutionComponent(
		toolName,
		args,
		{ showImages: false, useBuiltInRenderer: true },
		fakeTool(toolName),
		toolUi(),
		booted.context.cwd,
		toolCallId,
	);
	booted.transcript.addChild(component);
	return component;
}

async function finishTool(
	booted: BootedPlugin,
	component: ToolExecutionInstance,
	input: {
		toolCallId: string;
		toolName: string;
		result: unknown;
		isError: boolean;
	},
): Promise<void> {
	await dispatch(booted, { type: "tool_execution_end", ...input });
	component.updateResult(input.result, false, input.toolCallId);
}

function addAnswer(
	booted: BootedPlugin & { transcript: TranscriptInstance },
	text: string,
): void {
	const reply = new booted.ContainerBase();
	reply.addChild({ render: () => [text] });
	booted.transcript.addChild(reply);
}

async function finishRun(
	booted: BootedPlugin,
	text: string,
	stopReason = "stop",
	willContinue = false,
): Promise<void> {
	await dispatch(booted, {
		type: "agent_end",
		messages: [assistant(text, stopReason)],
		willContinue,
	});
}

async function shutdown(booted: BootedPlugin): Promise<void> {
	await dispatch(booted, { type: "session_shutdown" });
}

stockTest("plugin leaves the native tool registry untouched", async () => {
	const booted = await bootWithTranscript();
	expect(booted.registeredTools).toEqual([]);
	await shutdown(booted);
});

stockTest("legacy mutation messages remain renderable", async () => {
	const booted = await bootWithTranscript();
	const renderer = booted.renderers.get("omp-compact-write");
	const component = renderer?.(
		{
			details: {
				toolName: "edit",
				path: "src/legacy.ts",
				added: 1,
				removed: 0,
				exact: true,
			},
		},
		{ expanded: false },
		booted.host.getTheme(),
	);
	expect(component && visibleRows(component).join("\n")).toContain(
		"edit: src/legacy.ts",
	);
	expect(component && visibleRows(component).join("\n")).toContain("+1|0");
	await shutdown(booted);
});

stockTest(
	"successful routine tools stay live until the terminal answer",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf done" },
			"bash-1",
		);
		expect(visibleRows(booted.transcript).join("\n")).toContain("printf done");
		expect(call.isTranscriptBlockFinalized()).toBe(false);
		expect(call.getTranscriptBlockSettledRows()).toBe(0);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "done" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		const settled = visibleRows(booted.transcript).join("\n");
		expect(settled).toContain("bash");
		expect(settled).toContain("printf done");
		expect(call.isTranscriptBlockFinalized()).toBe(false);
		addAnswer(booted, "final answer");
		await finishRun(booted, "final answer");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("final answer");
		expect(completed).not.toContain("printf done");
		expect(call.isTranscriptBlockFinalized()).toBe(true);
		await shutdown(booted);
	},
);

stockTest("expanded live tools delegate to the native renderer", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const call = await addTool(
		booted,
		"bash",
		{ command: "printf inspect" },
		"bash-expanded",
	);
	const compact = visibleRows(booted.transcript);
	call.setExpanded(true);
	const expanded = visibleRows(booted.transcript);
	expect(expanded).not.toEqual(compact);
	expect(expanded.join("\n")).toContain("printf inspect");
	call.setExpanded(false);
	const collapsed = visibleRows(booted.transcript);
	expect(collapsed).not.toEqual(expanded);
	expect(collapsed.join("\n")).toContain("bash: printf inspect");
	await shutdown(booted);
});

stockTest(
	"pending spinner advances and its session timer is cleared",
	async () => {
		const booted = await bootWithTranscript();
		expect(booted.intervalCallbacks).toHaveLength(1);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf spinner" },
			"bash-spinner",
		);
		const beforeTick = visibleRows(booted.transcript);
		booted.intervalCallbacks[0]?.();
		const afterTick = visibleRows(booted.transcript);
		expect(afterTick).not.toEqual(beforeTick);
		await finishTool(booted, call, {
			toolCallId: "bash-spinner",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "spinner" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		const settled = visibleRows(booted.transcript);
		booted.intervalCallbacks[0]?.();
		expect(visibleRows(booted.transcript)).toEqual(settled);
		await shutdown(booted);
		expect(booted.clearedTimers).toEqual([booted.intervalCallbacks[0]]);
	},
);

stockTest(
	"one session spinner timer survives a terminal run and animates the next",
	async () => {
		const booted = await bootWithTranscript();
		expect(booted.intervalCallbacks).toHaveLength(1);
		const timer = booted.intervalCallbacks[0];
		expect(timer).toBeDefined();
		// run 1: a routine tool settles, then a terminal answer filters it
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-run1",
		);
		await finishTool(booted, first, {
			toolCallId: "bash-run1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(booted, "first done");
		await finishRun(booted, "first done");
		// terminal completion must not clear or duplicate the session timer
		expect(booted.clearedTimers).toEqual([]);
		expect(booted.intervalCallbacks).toHaveLength(1);
		// run 2: the same callback advances the new pending row's frame
		await dispatch(booted, { type: "agent_start" });
		await addTool(booted, "bash", { command: "printf second" }, "bash-run2");
		const beforeTick = visibleRows(booted.transcript).join("\n");
		expect(beforeTick).toContain("Working…");
		expect(beforeTick).toContain("printf second");
		timer?.();
		const afterTick = visibleRows(booted.transcript).join("\n");
		expect(afterTick).toContain("Working…");
		expect(afterTick).not.toEqual(beforeTick);
		expect(booted.clearedTimers).toEqual([]);
		await shutdown(booted);
		expect(booted.clearedTimers).toEqual([timer]);
	},
);

stockTest(
	"ask stays native while the four visual tools render compact",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const ask = await addTool(
			booted,
			"ask",
			{ question: "continue?" },
			"interactive-ask",
		);
		ask.render = () => ["native-ask"];
		await addTool(
			booted,
			"browser",
			{ action: "open", url: "https://example.test" },
			"interactive-browser",
		);
		await addTool(
			booted,
			"computer",
			{ i: "click Save" },
			"interactive-computer",
		);
		await addTool(
			booted,
			"resolve",
			{ path: "xd://resolve", content: "applying staged edit" },
			"interactive-resolve",
		);
		await addTool(
			booted,
			"reject",
			{ path: "xd://reject", content: "rejected preview" },
			"interactive-reject",
		);
		await addTool(
			booted,
			"task",
			{ description: "subagent work" },
			"interactive-task",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("native-ask");
		expect(live).toContain("browser: https://example.test");
		expect(live).toContain("computer use: click Save");
		expect(live).toContain("resolve: applying staged edit");
		expect(live).toContain("reject: rejected preview");
		expect(live).toContain("task: description: subagent work");
		for (const toolName of ["browser", "computer", "resolve", "reject", "task"])
			expect(live).not.toContain(`native-${toolName}`);
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		await shutdown(booted);
	},
);

stockTest(
	"live hub renders compact and expanded hub stays native",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"hub",
			{ action: "inspect" },
			"hub-live",
		);
		call.render = () => ["native-hub"];
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("hub");
		expect(live).not.toContain("native-hub");
		call.setExpanded(true);
		const expanded = visibleRows(booted.transcript).join("\n");
		expect(expanded).toContain("native-hub");
		call.setExpanded(false);
		const collapsed = visibleRows(booted.transcript).join("\n");
		expect(collapsed).toContain("hub");
		expect(collapsed).not.toContain("native-hub");
		await shutdown(booted);
	},
);

stockTest("ambiguous anonymous tool components remain native", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	await dispatch(booted, {
		type: "message_update",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "ambiguous-a",
					name: "bash",
					arguments: { command: "echo ambiguous-a" },
				},
				{
					type: "toolCall",
					id: "ambiguous-b",
					name: "bash",
					arguments: { command: "echo ambiguous-b" },
				},
			],
		},
	});
	const first = new booted.host.ToolExecutionComponent(
		"bash",
		{ command: "echo ambiguous-a" },
		{ showImages: false, useBuiltInRenderer: true },
		fakeTool("bash"),
		toolUi(),
		booted.context.cwd,
		undefined,
	);
	const second = new booted.host.ToolExecutionComponent(
		"bash",
		{ command: "echo ambiguous-b" },
		{ showImages: false, useBuiltInRenderer: true },
		fakeTool("bash"),
		toolUi(),
		booted.context.cwd,
		undefined,
	);
	booted.transcript.addChild(first);
	booted.transcript.addChild(second);
	const live = visibleRows(booted.transcript).join("\n");
	expect(live).toContain("echo ambiguous-a");
	expect(live).toContain("echo ambiguous-b");
	addAnswer(booted, "done");
	await finishRun(booted, "done");
	const completed = visibleRows(booted.transcript).join("\n");
	expect(completed).toContain("echo ambiguous-a");
	expect(completed).toContain("echo ambiguous-b");
	await shutdown(booted);
});

stockTest(
	"a late message_update of the previous run never pollutes the next run after agent_start",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"late-first",
		);
		await finishTool(booted, first, {
			toolCallId: "late-first",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		addAnswer(booted, "first done");
		await finishRun(booted, "first done");
		// Stock queues message_update events behind earlier stream deltas
		// while agent_end/agent_start are delivered directly, so a delta
		// emitted for the settled run can be handled AFTER the next run's
		// agent_start. It must never allocate a state/entry into the next
		// run's ledger.
		await beginRun(booted);
		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "stale-late",
						name: "bash",
						arguments: { command: "echo stale-late" },
					},
				],
			},
		});
		// The next run's genuine tool still binds compactly (an allocated
		// stale state would block the single-pair order binding and fall
		// back to the native surface).
		const second = await addTool(
			booted,
			"bash",
			{ command: "printf second" },
			"late-second",
		);
		second.render = () => ["native-late-second"];
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("printf second");
		expect(live).not.toContain("native-late-second");
		expect(live).not.toContain("echo stale-late");
		await finishTool(booted, second, {
			toolCallId: "late-second",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		addAnswer(booted, "second done");
		await finishRun(booted, "second done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("echo stale-late");
		await shutdown(booted);
	},
);

stockTest(
	"unknown tool components fail open to the native renderer in every phase",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"future_tool",
			{ query: "registry routing" },
			"unknown-1",
		);
		call.render = () => ["native-future-tool"];
		// working: the unregistered tool keeps its native surface; no generic
		// compact row is synthesized for it
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("native-future-tool");
		expect(live).not.toContain("query: registry routing");
		await finishTool(booted, call, {
			toolCallId: "unknown-1",
			toolName: "future_tool",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		const settled = visibleRows(booted.transcript).join("\n");
		expect(settled).toContain("native-future-tool");
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		// the terminal filter hides routine rows but must never hide or
		// rewrite an unknown tool's native rows
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("native-future-tool");
		expect(completed).not.toContain("query: registry routing");
		await shutdown(booted);
	},
);

stockTest(
	"unknown tool components stay native in the full abort log",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"vendor_canvas",
			{ action: "inspect" },
			"unknown-abort",
		);
		call.render = () => ["native-vendor-canvas"];
		await finishTool(booted, call, {
			toolCallId: "unknown-abort",
			toolName: "vendor_canvas",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		await finishRun(booted, "", "aborted");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("native-vendor-canvas");
		expect(rows).not.toContain("action: inspect");
		await shutdown(booted);
	},
);

stockTest(
	"unknown and routine tools keep independent projections in one run",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const routine = await addTool(
			booted,
			"bash",
			{ command: "printf routine-row" },
			"mixed-routine",
		);
		routine.render = () => ["native-routine"];
		const unknown = await addTool(
			booted,
			"future_tool",
			{ query: "mixed run" },
			"mixed-unknown",
		);
		unknown.render = () => ["native-unknown"];
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("printf routine-row");
		expect(live).not.toContain("native-routine");
		expect(live).toContain("native-unknown");
		await finishTool(booted, routine, {
			toolCallId: "mixed-routine",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		await finishTool(booted, unknown, {
			toolCallId: "mixed-unknown",
			toolName: "future_tool",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		addAnswer(booted, "mixed done");
		await finishRun(booted, "mixed done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("mixed done");
		expect(completed).not.toContain("printf routine-row");
		expect(completed).not.toContain("native-routine");
		expect(completed).toContain("native-unknown");
		await shutdown(booted);
	},
);

stockTest("tool-use continuation never triggers cleanup", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const call = await addTool(
		booted,
		"grep",
		{ pattern: "registerTool", path: "src" },
		"grep-1",
	);
	await finishTool(booted, call, {
		toolCallId: "grep-1",
		toolName: "grep",
		result: {
			content: [{ type: "text", text: "match" }],
			details: { matchCount: 1 },
		},
		isError: false,
	});
	await finishRun(booted, "working", "toolUse", true);
	expect(visibleRows(booted.transcript).join("\n")).toContain("registerTool");
	await dispatch(booted, { type: "agent_start" });
	expect(visibleRows(booted.transcript).join("\n")).toContain("registerTool");
	addAnswer(booted, "done");
	await finishRun(booted, "done");
	expect(visibleRows(booted.transcript).join("\n")).not.toContain(
		"registerTool",
	);
	await shutdown(booted);
});

stockTest(
	"provisional tool IDs migrate onto the bound native component",
	async () => {
		const cwd = "/tmp/omp-compact-provisional-id";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "migrated.ts");
		await Bun.write(path, "old\n");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "",
						name: "write",
						arguments: { path: "provisional.ts", content: "new\n" },
					},
				],
			},
		});
		const component = new booted.host.ToolExecutionComponent(
			"write",
			{ path: "provisional.ts", content: "new\n" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("write"),
			toolUi(),
			cwd,
			"",
		);
		booted.transcript.addChild(component);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"provisional.ts",
		);
		component.updateArgs?.(
			{ path: "migrated.ts", content: "new\n" },
			"write-real",
		);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "write-real",
			toolName: "write",
			args: { path: "migrated.ts", content: "new\n" },
		});
		await Bun.write(path, "new\n");
		await finishTool(booted, component, {
			toolCallId: "write-real",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("write: migrated.ts");
		expect(completed).toContain("+1|1");
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-write",
			data: { toolCallId: "write-real" },
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"non-empty provisional tool IDs migrate onto the bound component",
	async () => {
		const cwd = "/tmp/omp-compact-provisional-nonempty";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "final.ts");
		await Bun.write(path, "old\n");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "write-prov",
						name: "write",
						arguments: { path: "staging.ts", content: "new\n" },
					},
				],
			},
		});
		const component = new booted.host.ToolExecutionComponent(
			"write",
			{ path: "staging.ts", content: "new\n" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("write"),
			toolUi(),
			cwd,
			"write-prov",
		);
		booted.transcript.addChild(component);
		expect(visibleRows(booted.transcript).join("\n")).toContain("staging.ts");
		component.updateArgs?.(
			{ path: "final.ts", content: "new\n" },
			"write-real",
		);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "write-real",
			toolName: "write",
			args: { path: "final.ts", content: "new\n" },
		});
		await Bun.write(path, "new\n");
		await finishTool(booted, component, {
			toolCallId: "write-real",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("write: final.ts");
		expect(completed).not.toContain("staging.ts");
		expect(completed).toContain("+1|1");
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-write",
			data: { toolCallId: "write-real" },
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest("git evidence lands on the migrated real-ID row", async () => {
	const cwd = "/tmp/omp-compact-provisional-git";
	await rm(cwd, { recursive: true, force: true });
	await mkdir(cwd, { recursive: true });
	const booted = await bootWithTranscript(cwd);
	await beginRun(booted);
	await dispatch(booted, {
		type: "message_update",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "",
					name: "bash",
					arguments: { command: "git status" },
				},
			],
		},
	});
	const component = new booted.host.ToolExecutionComponent(
		"bash",
		{ command: "git status" },
		{ showImages: false, useBuiltInRenderer: true },
		fakeTool("bash"),
		toolUi(),
		cwd,
		"",
	);
	booted.transcript.addChild(component);
	expect(visibleRows(booted.transcript).join("\n")).toContain("git status");
	component.updateArgs?.({ command: "git status" }, "bash-real");
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "bash-real",
		toolName: "bash",
		args: { command: "git status" },
	});
	await finishTool(booted, component, {
		toolCallId: "bash-real",
		toolName: "bash",
		result: {
			content: [{ type: "text", text: " M migrated.ts" }],
			details: { exitCode: 0 },
		},
		isError: false,
	});
	addAnswer(booted, "done");
	await finishRun(booted, "done");
	const completed = visibleRows(booted.transcript).join("\n");
	// the non-commit Git row is filtered by the terminal answer; the evidence
	// still lands on the migrated real-ID row of the persisted entry
	expect(completed).not.toContain("git status");
	expect(booted.appendedEntries[0]).toMatchObject({
		customType: "omp-compact-git",
		data: { toolCallId: "bash-real" },
	});
	await shutdown(booted);
	await rm(cwd, { recursive: true, force: true });
});

stockTest(
	"migration merges a pre-existing real-ID state without duplicates",
	async () => {
		const cwd = "/tmp/omp-compact-provisional-merge";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "merged.ts");
		await Bun.write(path, "old\n");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "",
						name: "write",
						arguments: { path: "staging.ts", content: "new\n" },
					},
				],
			},
		});
		const component = new booted.host.ToolExecutionComponent(
			"write",
			{ path: "staging.ts", content: "new\n" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("write"),
			toolUi(),
			cwd,
			"",
		);
		booted.transcript.addChild(component);
		expect(visibleRows(booted.transcript).join("\n")).toContain("staging.ts");
		// The real-ID state is created before the component rebinds.
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "write-real",
			toolName: "write",
			args: { path: "merged.ts", content: "new\n" },
		});
		await Bun.write(path, "new\n");
		component.updateArgs?.(
			{ path: "merged.ts", content: "new\n" },
			"write-real",
		);
		await finishTool(booted, component, {
			toolCallId: "write-real",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("write: merged.ts");
		expect(completed).not.toContain("staging.ts");
		expect(completed.match(/\+1\|1/g)).toHaveLength(1);
		expect(booted.appendedEntries).toHaveLength(1);
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-write",
			data: { toolCallId: "write-real" },
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"todo remains in the live log and disappears after the answer",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"todo",
			{ op: "done", task: "alpha" },
			"todo-1",
		);
		await finishTool(booted, call, {
			toolCallId: "todo-1",
			toolName: "todo",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain("alpha");
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		expect(visibleRows(booted.transcript).join("\n")).not.toContain("alpha");
		await shutdown(booted);
	},
);

stockTest(
	"abort without an answer commits the complete compact log",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "false" },
			"bash-abort",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-abort",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "failed" }],
				details: { exitCode: 1 },
			},
			isError: true,
		});
		await finishRun(booted, "", "aborted");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("false");
		expect(rows).toContain("exit 1");
		expect(rows).toContain("✗");
		expect(call.isTranscriptBlockFinalized()).toBe(true);
		await shutdown(booted);
	},
);

stockTest("verified non-zero write survives final filtering", async () => {
	const cwd = "/tmp/omp-compact-integration";
	await mkdir(cwd, { recursive: true });
	const path = join(cwd, "write.ts");
	await Bun.write(path, "const a = 1;\nkeep();\n");
	const booted = await bootWithTranscript(cwd);
	await beginRun(booted);
	const args = { path: "write.ts", content: "ignored raw input" };
	const call = await addTool(booted, "write", args, "write-1");
	await Bun.write(path, "const a = 2;\nkeep();\nextra();\n");
	await finishTool(booted, call, {
		toolCallId: "write-1",
		toolName: "write",
		result: {
			content: [{ type: "text", text: "ok" }],
			details: { resolvedPath: path },
		},
		isError: false,
	});
	addAnswer(booted, "written");
	await finishRun(booted, "written");
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("write: write.ts");
	expect(rows).toContain("+2|1");
	expect(booted.sentMessages).toEqual([]);
	expect(booted.appendedEntries[0]).toMatchObject({
		customType: "omp-compact-write",
		data: {
			version: 1,
			toolCallId: "write-1",
			added: 2,
			removed: 1,
			exact: true,
		},
	});
	await shutdown(booted);
	await rm(cwd, { recursive: true, force: true });
});

stockTest("new write below a symlinked parent keeps exact stats", async () => {
	const cwd = "/tmp/omp-compact-symlink";
	await rm(cwd, { recursive: true, force: true });
	await mkdir(join(cwd, "real"), { recursive: true });
	await symlink("real", join(cwd, "link"));
	const path = join(cwd, "link", "new.ts");
	const booted = await bootWithTranscript(cwd);
	await beginRun(booted);
	const call = await addTool(
		booted,
		"write",
		{ path: "link/new.ts", content: "new\n" },
		"write-symlink",
	);
	await Bun.write(path, "new\n");
	await finishTool(booted, call, {
		toolCallId: "write-symlink",
		toolName: "write",
		result: {
			content: [{ type: "text", text: "ok" }],
			details: { resolvedPath: path },
		},
		isError: false,
	});
	addAnswer(booted, "written");
	await finishRun(booted, "written");
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("write: link/new.ts");
	expect(rows).toContain("+1|0");
	expect(booted.sentMessages).toEqual([]);
	expect(booted.appendedEntries).toHaveLength(1);
	await shutdown(booted);
	await rm(cwd, { recursive: true, force: true });
});

stockTest(
	"no-op writes and non-Git failures are removed after the answer",
	async () => {
		const cwd = "/tmp/omp-compact-noop";
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "same.ts");
		await Bun.write(path, "same\n");
		const mismatchPath = join(cwd, "mismatch.ts");
		const otherPath = join(cwd, "other.ts");
		await Bun.write(mismatchPath, "old\n");
		await Bun.write(otherPath, "other\n");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const write = await addTool(
			booted,
			"write",
			{ path: "same.ts", content: "same\n" },
			"write-noop",
		);
		await finishTool(booted, write, {
			toolCallId: "write-noop",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		const mismatch = await addTool(
			booted,
			"write",
			{ path: "mismatch.ts", content: "new\n" },
			"write-mismatch",
		);
		await Bun.write(mismatchPath, "new\n");
		await finishTool(booted, mismatch, {
			toolCallId: "write-mismatch",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: otherPath },
			},
			isError: false,
		});
		const virtual = await addTool(
			booted,
			"write",
			{ path: "vault://_/note.md", content: "x" },
			"write-virtual",
		);
		await finishTool(booted, virtual, {
			toolCallId: "write-virtual",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: otherPath },
			},
			isError: false,
		});
		const bash = await addTool(
			booted,
			"bash",
			{ command: "exit 2" },
			"bash-error",
		);
		await finishTool(booted, bash, {
			toolCallId: "bash-error",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "no" }],
				details: { exitCode: 2 },
			},
			isError: true,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain("exit 2");
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("same.ts");
		expect(completed).not.toContain("mismatch.ts");
		expect(completed).not.toContain("vault://_/note.md");
		expect(completed).not.toContain("exit 2");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest("partial edit retains successful changed files", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const call = await addTool(
		booted,
		"edit",
		{ input: "multi-file" },
		"edit-partial",
	);
	await finishTool(booted, call, {
		toolCallId: "edit-partial",
		toolName: "edit",
		result: {
			content: [{ type: "text", text: "one file failed" }],
			details: {
				perFileResults: [
					{
						path: "src/a.ts",
						diff: "--- a\n+++ b\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n",
					},
					{ path: "src/b.ts", diff: "", isError: true },
				],
			},
		},
		isError: true,
	});
	addAnswer(booted, "partially edited");
	await finishRun(booted, "partially edited");
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("edit: src/a.ts");
	expect(rows).toContain("+2|1");
	expect(rows).not.toContain("src/b.ts");
	expect(booted.sentMessages).toEqual([]);
	expect(booted.appendedEntries).toHaveLength(1);
	await shutdown(booted);
});

stockTest(
	"numbered edit row survives terminal answer with audit evidence",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"edit",
			{ input: "replace" },
			"edit-numbered",
		);
		await finishTool(booted, call, {
			toolCallId: "edit-numbered",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "edited" }],
				details: {
					path: "src/numbered.ts",
					op: "update",
					diff: "-12|old line\n+12|new line",
				},
			},
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"edit: src/numbered.ts",
		);
		addAnswer(booted, "numbered edit done");
		await finishRun(booted, "numbered edit done");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("edit: src/numbered.ts");
		expect(rows).toContain("+1|1");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([
			{
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId: "edit-numbered",
					toolName: "edit",
					path: "src/numbered.ts",
					added: 1,
					removed: 1,
					exact: true,
				},
			},
		]);
		await shutdown(booted);
	},
);

stockTest(
	"recognized Git commits leave one summary row; non-commit rows filter",
	async () => {
		const success = await bootWithTranscript();
		await beginRun(success);
		const commit = await addTool(
			success,
			"bash",
			{ command: "git commit -m 'Fix compact log'" },
			"git-1",
		);
		await finishTool(success, commit, {
			toolCallId: "git-1",
			toolName: "bash",
			result: {
				content: [
					{
						type: "text",
						text: "[main abc1234] Fix compact log\n 1 file changed",
					},
				],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(success, "committed");
		await finishRun(success, "committed");
		const successRows = visibleRows(success.transcript).join("\n");
		expect(successRows).toContain("git commit: abc1234");
		// the individual Git row is replaced by the aggregate summary
		expect(successRows).not.toContain("git commit abc1234 Fix compact log");
		expect(success.sentMessages).toEqual([]);
		expect(success.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-git",
			data: { toolCallId: "git-1", text: "git commit abc1234 Fix compact log" },
		});
		await shutdown(success);

		const failure = await bootWithTranscript();
		await beginRun(failure);
		const rebase = await addTool(
			failure,
			"bash",
			{ command: "git rebase main" },
			"git-2",
		);
		await finishTool(failure, rebase, {
			toolCallId: "git-2",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "conflict" }],
				details: { exitCode: 1 },
			},
			isError: true,
		});
		addAnswer(failure, "reported");
		await finishRun(failure, "reported");
		const failureRows = visibleRows(failure.transcript).join("\n");
		// a non-commit failure produces no hash and is filtered with the answer
		expect(failureRows).not.toContain("git rebase main");
		expect(failureRows).not.toContain("git commit:");
		expect(failure.sentMessages).toEqual([]);
		expect(failure.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-git",
			data: { toolCallId: "git-2", text: "✗ git rebase main", isError: true },
		});
		await shutdown(failure);
	},
);

stockTest(
	"subject-less commit rows keep the hash in persisted evidence",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const commit = await addTool(
			booted,
			"bash",
			{ command: "git commit -m 'No subject line'" },
			"git-subjectless",
		);
		await finishTool(booted, commit, {
			toolCallId: "git-subjectless",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "[main abc1234]\n 1 file changed" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(booted, "committed");
		await finishRun(booted, "committed");
		const entry = booted.appendedEntries[0] as {
			customType: string;
			data: Record<string, unknown>;
		};
		expect(entry).toMatchObject({
			customType: "omp-compact-git",
			data: {
				toolCallId: "git-subjectless",
				subcommand: "commit",
				text: "git commit abc1234",
				shortHash: "abc1234",
			},
		});
		expect("subject" in entry.data).toBe(false);
		expect(visibleRows(booted.transcript).join("\n")).toContain("abc1234");
		await shutdown(booted);
	},
);

stockTest(
	"failed cd-gated Git rows are filtered as ordinary Bash errors",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "cd /missing && git status" },
			"git-cd-gated",
		);
		await finishTool(booted, call, {
			toolCallId: "git-cd-gated",
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "cd: no such file or directory: /missing" },
				],
				details: { exitCode: 1 },
			},
			isError: true,
		});
		addAnswer(booted, "reported");
		await finishRun(booted, "reported");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("git status");
		expect(completed).toContain("reported");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);
	},
);

stockTest(
	"audit kinds route write, edit, and Git Bash through the registry lifecycle",
	async () => {
		const cwd = "/tmp/omp-compact-audit-kinds";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "kinds.ts");
		await Bun.write(path, "const a = 1;\nkeep();\n");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const write = await addTool(
			booted,
			"write",
			{ path: "kinds.ts", content: "untrusted raw input" },
			"kinds-write",
		);
		await Bun.write(path, "const a = 2;\nkeep();\nextra();\n");
		await finishTool(booted, write, {
			toolCallId: "kinds-write",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		const edit = await addTool(
			booted,
			"edit",
			{ input: "replace" },
			"kinds-edit",
		);
		await finishTool(booted, edit, {
			toolCallId: "kinds-edit",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "edited" }],
				details: {
					path: "src/kinds.ts",
					op: "update",
					diff: "-12|old line\n+12|new line",
				},
			},
			isError: false,
		});
		const git = await addTool(
			booted,
			"bash",
			{ command: "git commit -m 'Route audit'" },
			"kinds-git",
		);
		await finishTool(booted, git, {
			toolCallId: "kinds-git",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "[main abc1234] Route audit" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const rows = visibleRows(booted.transcript).join("\n");
		// every audit kind keeps its current presentation through the
		// registry-selected lifecycle: write row with exact stats, edit row,
		// one aggregate Git summary
		expect(rows).toContain("write: kinds.ts");
		expect(rows).toContain("+2|1");
		expect(rows).toContain("edit: src/kinds.ts");
		expect(rows).toContain("git commit: abc1234");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toHaveLength(3);
		expect(
			booted.appendedEntries.find(
				(entry) =>
					(entry.data as { toolCallId?: string })?.toolCallId === "kinds-write",
			),
		).toMatchObject({
			customType: "omp-compact-write",
			data: { toolCallId: "kinds-write", added: 2, removed: 1, exact: true },
		});
		expect(
			booted.appendedEntries.find(
				(entry) =>
					(entry.data as { toolCallId?: string })?.toolCallId === "kinds-edit",
			),
		).toMatchObject({
			customType: "omp-compact-write",
			data: {
				toolCallId: "kinds-edit",
				toolName: "edit",
				path: "src/kinds.ts",
				added: 1,
				removed: 1,
				exact: true,
			},
		});
		expect(
			booted.appendedEntries.find(
				(entry) =>
					(entry.data as { toolCallId?: string })?.toolCallId === "kinds-git",
			),
		).toMatchObject({
			customType: "omp-compact-git",
			data: {
				toolCallId: "kinds-git",
				subcommand: "commit",
				text: "git commit abc1234 Route audit",
				isError: false,
			},
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"apply_patch wire alias keeps the compact edit route and mutation audit",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"apply_patch",
			{
				input:
					"*** Begin Patch\n*** Update File: src/alias.ts\n@@\n-old\n+new\n*** End Patch",
			},
			"apply-patch-1",
		);
		await finishTool(booted, call, {
			toolCallId: "apply-patch-1",
			toolName: "apply_patch",
			result: {
				content: [{ type: "text", text: "edited" }],
				details: {
					path: "src/alias.ts",
					op: "update",
					diff: "-1|old\n+1|new",
				},
			},
			isError: false,
		});
		const workingRows = visibleRows(booted.transcript).join("\n");
		expect(workingRows).toContain("edit: src/alias.ts");
		expect(workingRows).not.toContain("native apply_patch");

		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completedRows = visibleRows(booted.transcript).join("\n");
		expect(completedRows).toContain("edit: src/alias.ts");
		expect(booted.appendedEntries).toEqual([
			expect.objectContaining({
				customType: "omp-compact-write",
				data: expect.objectContaining({
					toolCallId: "apply-patch-1",
					toolName: "edit",
					path: "src/alias.ts",
					added: 1,
					removed: 1,
					exact: true,
				}),
			}),
		]);
		await shutdown(booted);
	},
);

stockTest(
	"unknown, native-live, and routine tools create no audit evidence",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const calls = [
			{ toolCallId: "mystery", toolName: "no-such-tool", args: {} },
			{ toolCallId: "live", toolName: "task", args: { op: "spawn" } },
			{ toolCallId: "routine", toolName: "grep", args: { pattern: "x" } },
			// alias of the canonical ast_grep: an alias must never create
			// audit work either
			{ toolCallId: "alias", toolName: "ast-grep", args: { pattern: "x" } },
			// routine Bash (non-Git command) stays below the Git gate
			{
				toolCallId: "shell",
				toolName: "bash",
				args: { command: "printf routine" },
			},
		];
		for (const call of calls) {
			const component = await addTool(
				booted,
				call.toolName,
				call.args,
				call.toolCallId,
			);
			await finishTool(booted, component, {
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				result: { content: [{ type: "text", text: "ok" }], details: {} },
				isError: false,
			});
		}
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);
	},
);

stockTest("native read group remains live, neutral, then filters", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "read-1",
		toolName: "read",
		args: { path: "src/a.ts" },
	});
	const group = new booted.host.ReadToolGroupComponent();
	booted.transcript.addChild(group);
	group.updateArgs({ path: "src/a.ts" }, "read-1");
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "read-2",
		toolName: "read",
		args: { path: "src/b.ts" },
	});
	group.updateArgs({ path: "src/b.ts" }, "read-2");
	const liveRaw = booted.transcript.render(120).join("\n");
	const live = liveRaw.replace(ansiPattern, "");
	expect(live).toContain("src/a.ts");
	expect(live).toContain("src/b.ts");
	expect(liveRaw).not.toContain(booted.host.getTheme().getFgAnsi("accent"));
	for (const id of ["read-1", "read-2"]) {
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			id,
		);
	}
	addAnswer(booted, "read done");
	await finishRun(booted, "read done");
	const completed = visibleRows(booted.transcript).join("\n");
	expect(completed).not.toContain("src/a.ts");
	expect(completed).toContain("read done");
	await shutdown(booted);
});

stockTest(
	"a single grouped read renders one compact lower-case row",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		// Stock ordering: the host creates the group and calls updateArgs
		// BEFORE the extension's tool_execution_start event creates the state.
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/a.ts" }, "read-1");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "src/a.ts" },
		});
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-1",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("• read src/a.ts");
		expect(live).not.toContain("● Read");
		expect(live).not.toContain("Read src");
		expect(
			visibleRows(booted.transcript).filter((row) => row.includes("read src/")),
		).toHaveLength(1);
		addAnswer(booted, "read done");
		await finishRun(booted, "read done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("src/a.ts");
		expect(completed).toContain("read done");
		await shutdown(booted);
	},
);

stockTest(
	"grouped reads render one compact row per call in start order despite reordered updates",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		// Stock ordering: group updates arrive before the extension events;
		// here they also arrive in reverse chronological order.
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/b.ts" }, "read-2");
		group.updateArgs({ path: "src/a.ts" }, "read-1");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "src/a.ts" },
		});
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-2",
			toolName: "read",
			args: { path: "src/b.ts" },
		});
		for (const id of ["read-1", "read-2"] as const) {
			await dispatch(booted, {
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "read",
				result: { content: [{ type: "text", text: "ok" }], details: {} },
				isError: false,
			});
			group.updateResult(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				false,
				id,
			);
		}
		const rows = visibleRows(booted.transcript);
		const first = rows.findIndex((row) => row.includes("src/a.ts"));
		const second = rows.findIndex((row) => row.includes("src/b.ts"));
		expect(first).toBeGreaterThanOrEqual(0);
		expect(second).toBe(first + 1);
		expect(rows.filter((row) => row.includes("read src/"))).toHaveLength(2);
		expect(rows.join("\n")).not.toContain("Read src");
		expect(rows.join("\n")).not.toContain("● Read");
		await shutdown(booted);
	},
);

stockTest(
	"a pending grouped read shows the stock working indicator and animates",
	async () => {
		const booted = await bootWithTranscript();
		const theme = booted.host.getTheme() as unknown as {
			getSpinnerFrames?: (name: string) => readonly string[];
			spinnerFrames?: readonly string[];
		};
		const frames =
			theme.getSpinnerFrames?.("activity") ?? theme.spinnerFrames ?? [];
		expect(frames.length).toBeGreaterThan(0);
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-pending",
			toolName: "read",
			args: { path: "src/pending.ts" },
		});
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/pending.ts" }, "read-pending");
		const beforeTick = visibleRows(booted.transcript).join("\n");
		expect(beforeTick).toContain("Working…");
		expect(beforeTick).toContain("src/pending.ts");
		expect(beforeTick).not.toContain("⏳");
		expect(beforeTick).not.toContain("⌛");
		expect(beforeTick).not.toContain("● Read");
		expect(frames.some((frame) => beforeTick.includes(frame))).toBe(true);
		booted.intervalCallbacks[0]?.();
		const afterTick = visibleRows(booted.transcript).join("\n");
		expect(afterTick).toContain("Working…");
		expect(afterTick).not.toEqual(beforeTick);
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-pending",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-pending",
		);
		const settled = visibleRows(booted.transcript).join("\n");
		expect(settled).toContain("• read src/pending.ts");
		expect(settled).not.toContain("Working…");
		await shutdown(booted);
	},
);

stockTest(
	"an error read row keeps the error marker and filters after the answer",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-err",
			toolName: "read",
			args: { path: "src/err.ts" },
		});
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/err.ts" }, "read-err");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-err",
			toolName: "read",
			result: { content: [{ type: "text", text: "missing" }], details: {} },
			isError: true,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "missing" }], details: {} },
			false,
			"read-err",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("✗");
		expect(live).toContain("read src/err.ts");
		expect(live).not.toContain("● Read");
		addAnswer(booted, "err done");
		await finishRun(booted, "err done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("src/err.ts");
		await shutdown(booted);
	},
);

stockTest("abort without an answer keeps compact read rows", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "read-abort",
		toolName: "read",
		args: { path: "src/keep.ts" },
	});
	const group = new booted.host.ReadToolGroupComponent();
	booted.transcript.addChild(group);
	group.updateArgs({ path: "src/keep.ts" }, "read-abort");
	await dispatch(booted, {
		type: "tool_execution_end",
		toolCallId: "read-abort",
		toolName: "read",
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
	});
	group.updateResult(
		{ content: [{ type: "text", text: "ok" }], details: {} },
		false,
		"read-abort",
	);
	await finishRun(booted, "", "aborted");
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("• read src/keep.ts");
	expect(rows).not.toContain("● Read");
	await shutdown(booted);
});

stockTest("an unmapped read group renders natively", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const group = new booted.host.ReadToolGroupComponent();
	booted.transcript.addChild(group);
	group.updateArgs({ path: "src/native.ts" }, "never-tracked");
	const live = visibleRows(booted.transcript).join("\n");
	expect(live).toContain("Read");
	expect(live).toContain("src/native.ts");
	expect(live).not.toContain("• read src/native.ts");
	expect(booted.notifications).toHaveLength(0);
	await shutdown(booted);
});

stockTest(
	"mapped and unmapped read groups keep their terminal safety split",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		// fully mapped group: compact rows while working, hidden at terminal
		const mapped = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(mapped);
		mapped.updateArgs({ path: "src/kept.ts" }, "read-mapped");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-mapped",
			toolName: "read",
			args: { path: "src/kept.ts" },
		});
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-mapped",
			toolName: "read",
			result: { content: [{ type: "text", text: "src" }], details: {} },
			isError: false,
		});
		mapped.updateResult(
			{ content: [{ type: "text", text: "src" }], details: {} },
			false,
			"read-mapped",
		);
		// unmapped group: native surface in every phase, even terminal
		const unmapped = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(unmapped);
		unmapped.updateArgs({ path: "src/native.ts" }, "never-tracked");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("• read src/kept.ts");
		expect(live).not.toContain("• read src/native.ts");
		expect(live).toContain("Read");
		expect(live).toContain("src/native.ts");
		addAnswer(booted, "group done");
		await finishRun(booted, "group done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("group done");
		expect(completed).not.toContain("src/kept.ts");
		expect(completed).not.toContain("• read src/native.ts");
		expect(completed).toContain("Read");
		expect(completed).toContain("src/native.ts");
		await shutdown(booted);
	},
);

stockTest(
	"a group with only unknown entries stays native despite an outstanding read",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-real",
			toolName: "read",
			args: { path: "src/real.ts" },
		});
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		// The outstanding read state may bind by order, but the group's native
		// entry belongs to an id the plugin never tracked: without an
		// updateArgs/updateResult ID match the group must stay native.
		group.updateArgs({ path: "src/unknown.ts" }, "never-tracked");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("Read");
		expect(live).toContain("src/unknown.ts");
		expect(live).not.toContain("• read src/real.ts");
		expect(live).not.toContain("• read src/unknown.ts");
		expect(booted.notifications).toHaveLength(0);
		await shutdown(booted);
	},
);

stockTest(
	"a mixed group with one matched and one unknown entry stays native",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-known",
			toolName: "read",
			args: { path: "src/known.ts" },
		});
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/known.ts" }, "read-known");
		group.updateArgs({ path: "src/mystery.ts" }, "never-tracked");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("Read");
		expect(live).toContain("src/known.ts");
		expect(live).toContain("src/mystery.ts");
		expect(live).not.toContain("• read src/known.ts");
		expect(live).not.toContain("• read src/mystery.ts");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-known",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-known",
		);
		addAnswer(booted, "mixed done");
		await finishRun(booted, "mixed done");
		// terminal filtering must not hide the untracked native entry either
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("Read");
		expect(completed).toContain("src/known.ts");
		expect(completed).toContain("src/mystery.ts");
		expect(booted.notifications).toHaveLength(0);
		await shutdown(booted);
	},
);

stockTest(
	"an expanded read group delegates to the native renderer",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-exp",
			toolName: "read",
			args: { path: "src/exp.ts" },
		});
		const group = new booted.host.ReadToolGroupComponent({
			showContentPreview: true,
		});
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/exp.ts" }, "read-exp");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-exp",
			toolName: "read",
			result: {
				content: [{ type: "text", text: "EXPANDED FILE BODY" }],
				details: {},
			},
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "EXPANDED FILE BODY" }], details: {} },
			false,
			"read-exp",
		);
		const collapsed = visibleRows(booted.transcript).join("\n");
		expect(collapsed).toContain("• read src/exp.ts");
		expect(collapsed).not.toContain("EXPANDED FILE BODY");
		group.setExpanded(true);
		const expanded = visibleRows(booted.transcript).join("\n");
		expect(expanded).toContain("EXPANDED FILE BODY");
		expect(expanded).not.toContain("• read src/exp.ts");
		group.setExpanded(false);
		const recollapsed = visibleRows(booted.transcript).join("\n");
		expect(recollapsed).toContain("• read src/exp.ts");
		expect(recollapsed).not.toContain("EXPANDED FILE BODY");
		await shutdown(booted);
	},
);

stockTest(
	"initially expanded tools and read groups render natively",
	async () => {
		const booted = await bootWithTranscript("/tmp", true);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf native" },
			"bash-exp0",
		);
		call.render = () => ["native-bash-expanded"];
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-exp0",
			toolName: "read",
			args: { path: "src/init.ts" },
		});
		// Emulate the stock event-controller: create, setExpanded(...) BEFORE
		// addChild, then add. The adapter must learn the initial expansion from
		// ui.getToolsExpanded() because the pre-addChild call is invisible.
		const group = new booted.host.ReadToolGroupComponent({
			showContentPreview: true,
		});
		group.setExpanded(true);
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/init.ts" }, "read-exp0");
		const body = Array.from(
			{ length: 12 },
			(_, index) => `EXPANDED BODY LINE ${index}`,
		).join("\n");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-exp0",
			toolName: "read",
			result: { content: [{ type: "text", text: body }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: body }], details: {} },
			false,
			"read-exp0",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("native-bash-expanded");
		expect(live).toContain("EXPANDED BODY LINE 0");
		// The late line proves the raw expanded preview survives: a collapsed
		// preview caps at COLLAPSED_PREVIEW_LINES (3) lines.
		expect(live).toContain("EXPANDED BODY LINE 11");
		expect(live).not.toContain("• read src/init.ts");
		// collapsing through the wrappers returns both to the compact surface
		call.setExpanded(false);
		group.setExpanded(false);
		const collapsed = visibleRows(booted.transcript).join("\n");
		expect(collapsed).toContain("printf native");
		expect(collapsed).toContain("• read src/init.ts");
		expect(collapsed).not.toContain("native-bash-expanded");
		expect(collapsed).not.toContain("EXPANDED BODY LINE 11");
		await shutdown(booted);
	},
);

stockTest("compact rows stay transparent and width-bounded", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const call = await addTool(
		booted,
		"bash",
		{ command: "printf transparent" },
		"bash-transparent",
	);
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "read-transparent",
		toolName: "read",
		args: { path: "src/transparent.ts" },
	});
	const group = new booted.host.ReadToolGroupComponent();
	booted.transcript.addChild(group);
	group.updateArgs({ path: "src/transparent.ts" }, "read-transparent");
	await finishTool(booted, call, {
		toolCallId: "bash-transparent",
		toolName: "bash",
		result: {
			content: [{ type: "text", text: "ok" }],
			details: { exitCode: 0 },
		},
		isError: false,
	});
	await dispatch(booted, {
		type: "tool_execution_end",
		toolCallId: "read-transparent",
		toolName: "read",
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
	});
	group.updateResult(
		{ content: [{ type: "text", text: "ok" }], details: {} },
		false,
		"read-transparent",
	);
	const raw = booted.transcript.render(20);
	expect(raw.join("\n")).not.toContain("\u001b[48;");
	expect(raw.join("\n")).not.toContain("\u001b[49m");
	for (const row of visibleRows(booted.transcript, 20)) {
		expect(row.length).toBeLessThanOrEqual(20);
	}
	await shutdown(booted);
});

stockTest("adjacent live tool calls render as a dense run", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	for (const [id, command] of [
		["bash-1", "printf one"],
		["bash-2", "printf two"],
	] as const) {
		const call = await addTool(booted, "bash", { command }, id);
		await finishTool(booted, call, {
			toolCallId: id,
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
	}
	const rows = screenRows(booted.transcript);
	const first = rows.findIndex((row) => row.includes("printf one"));
	const second = rows.findIndex((row) => row.includes("printf two"));
	expect(first).toBeGreaterThanOrEqual(0);
	expect(second).toBe(first + 1);
	await shutdown(booted);
});

stockTest("shutdown restores own descriptors exactly", async () => {
	let transcript: TranscriptInstance | undefined;
	const booted = await bootPlugin((root, host) => {
		transcript = new host.TranscriptContainer();
		root.addChild(transcript);
	});
	if (!transcript) throw new Error("transcript missing");
	expect(Object.hasOwn(transcript, "addChild")).toBe(true);
	await shutdown(booted);
	expect(Object.hasOwn(transcript, "addChild")).toBe(false);
});

stockTest("session switch restores then reinstalls the adapter", async () => {
	let transcript: TranscriptInstance | undefined;
	const booted = await bootPlugin((root, host) => {
		transcript = new host.TranscriptContainer();
		root.addChild(transcript);
	});
	if (!transcript) throw new Error("transcript missing");
	expect(Object.hasOwn(transcript, "addChild")).toBe(true);
	expect(booted.intervalCallbacks).toHaveLength(1);
	await dispatch(booted, { type: "session_before_switch" });
	expect(Object.hasOwn(transcript, "addChild")).toBe(false);
	expect(booted.clearedTimers).toHaveLength(1);
	await dispatch(booted, { type: "session_start" });
	expect(Object.hasOwn(transcript, "addChild")).toBe(true);
	expect(booted.intervalCallbacks).toHaveLength(2);
	await shutdown(booted);
	expect(Object.hasOwn(transcript, "addChild")).toBe(false);
	expect(booted.clearedTimers).toHaveLength(2);
});

stockTest(
	"incompatible transcript shape fails open and rolls back discovery wrappers",
	async () => {
		let rootOwnAddChildBefore = false;
		const booted = await bootPlugin((root) => {
			rootOwnAddChildBefore = Object.hasOwn(root, "addChild");
			const incompatible = Object.freeze({
				children: [],
				addChild() {},
				render: () => [],
				renderViewportTail: () => [],
				isBlockUncommitted: () => false,
				isBlockInLiveRegion: () => false,
			});
			root.addChild(incompatible);
		});
		expect(rootOwnAddChildBefore).toBe(false);
		expect(Object.hasOwn(booted.root, "addChild")).toBe(false);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "edit-disabled",
			toolName: "edit",
			args: { input: "multi" },
		});
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "edit-disabled",
			toolName: "edit",
			result: {
				details: {
					perFileResults: [
						{
							path: "src/a.ts",
							diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n",
						},
					],
				},
			},
			isError: false,
		});
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		expect(booted.notifications).toHaveLength(1);
		await shutdown(booted);
	},
);

stockTest(
	"process restore reconstructs compact mutation and Git presentation under live persisted settings",
	async () => {
		let transcript: TranscriptInstance | undefined;
		const branch = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "work" }] },
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "routine",
					toolName: "bash",
					args: { command: "printf routine" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "routine",
					toolName: "bash",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "mutation",
					toolName: "write",
					args: { path: "resume.ts", content: "new" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "mutation",
					toolName: "write",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId: "mutation",
					toolName: "write",
					path: "resume.ts",
					added: 2,
					removed: 1,
					exact: true,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "git",
					toolName: "bash",
					args: { command: "git status --short" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "git",
					toolName: "bash",
					content: [{ type: "text", text: "clean" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("done") },
			{
				type: "custom_message",
				customType: "omp-compact-git",
				display: false,
				content: "",
				details: {
					version: 1,
					toolCallId: "git",
					subcommand: "status",
					text: "git status --short",
					isError: false,
				},
			},
		];
		const booted = await bootPlugin(
			(root, host) => {
				transcript = new host.TranscriptContainer();
				root.addChild(transcript);
				for (const { id, toolName, args } of [
					{
						id: "routine",
						toolName: "bash",
						args: { command: "printf routine" },
					},
					{
						id: "mutation",
						toolName: "write",
						args: { path: "resume.ts", content: "new" },
					},
					{
						id: "git",
						toolName: "bash",
						args: { command: "git status --short" },
					},
				]) {
					const call = new host.ToolExecutionComponent(
						toolName,
						args,
						{ showImages: false, useBuiltInRenderer: true },
						fakeTool(toolName),
						toolUi(),
						"/tmp",
						id,
					);
					call.updateResult(
						{ content: [{ type: "text", text: "ok" }], details: {} },
						false,
						id,
					);
					transcript.addChild(call);
				}
				const ContainerBase = Object.getPrototypeOf(
					host.ReadToolGroupComponent.prototype,
				).constructor as BootedPlugin["ContainerBase"];
				const reply = new ContainerBase();
				reply.addChild({ render: () => ["done"] });
				transcript.addChild(reply);
			},
			"/tmp",
			branch,
		);
		if (!transcript) throw new Error("transcript missing");
		const rows = visibleRows(transcript).join("\n");
		// entering the existing session forces compact on the restored
		// history: the routine bash row, the non-commit Git row and the
		// write mutation all survive (persisted mode stays live)
		expect(rows).toContain("git status");
		expect(rows).not.toContain("git commit:");
		expect(rows).toContain("write: resume.ts");
		expect(rows).toContain("+2|1");
		expect(rows).toContain("done");
		expect(rows).toContain("printf routine");
		await shutdown(booted);
	},
);

stockTest(
	"process restore keeps routine grouped reads visible with retained compact rows",
	async () => {
		let transcript: TranscriptInstance | undefined;
		const branch = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "work" }] },
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "read-r",
					toolName: "read",
					args: { path: "src/replay.ts" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-r",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "git",
					toolName: "bash",
					args: { command: "git commit -m 'Fix replay'" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "git",
					toolName: "bash",
					content: [{ type: "text", text: "[main abc1234] Fix replay" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("done") },
			{
				type: "custom_message",
				customType: "omp-compact-git",
				display: false,
				content: "",
				details: {
					version: 1,
					toolCallId: "git",
					subcommand: "commit",
					text: "git commit abc1234 Fix replay",
					isError: false,
				},
			},
		];
		const booted = await bootPlugin(
			(root, host) => {
				transcript = new host.TranscriptContainer();
				root.addChild(transcript);
				const group = new host.ReadToolGroupComponent();
				transcript.addChild(group);
				const call = new host.ToolExecutionComponent(
					"bash",
					{ command: "git commit -m 'Fix replay'" },
					{ showImages: false, useBuiltInRenderer: true },
					fakeTool("bash"),
					toolUi(),
					"/tmp",
					"git",
				);
				call.updateResult(
					{
						content: [{ type: "text", text: "[main abc1234] Fix replay" }],
						details: {},
					},
					false,
					"git",
				);
				transcript.addChild(call);
				const ContainerBase = Object.getPrototypeOf(
					host.ReadToolGroupComponent.prototype,
				).constructor as BootedPlugin["ContainerBase"];
				const reply = new ContainerBase();
				reply.addChild({ render: () => ["done"] });
				transcript.addChild(reply);
			},
			"/tmp",
			branch,
		);
		if (!transcript) throw new Error("transcript missing");
		const rows = visibleRows(transcript).join("\n");
		// entering the existing session forces compact on the restored
		// history: the commit row and the routine read row both survive as
		// individual compact rows (persisted mode stays live)
		expect(rows).toContain("git commit abc1234 Fix replay");
		expect(rows).not.toContain("git commit: abc1234");
		expect(rows).toContain("done");
		expect(rows).toContain("src/replay.ts");
		expect(rows).not.toContain("Read src");
		await shutdown(booted);
	},
);

stockTest(
	"a provisional grouped read stays compact through a streamed-id rename",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/stream.ts" }, "read-tmp");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-tmp",
			toolName: "read",
			args: { path: "src/stream.ts" },
		});
		group.renameEntry("read-tmp", "read-final");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-final",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-final",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("• read src/stream.ts");
		expect(live).not.toContain("● Read");
		addAnswer(booted, "rename done");
		await finishRun(booted, "rename done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("src/stream.ts");
		expect(completed).toContain("rename done");
		await shutdown(booted);
	},
);

stockTest(
	"a streamed-id rename merges an existing real-id state into one row",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/merge.ts" }, "read-tmp");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-tmp",
			toolName: "read",
			args: { path: "src/merge.ts" },
		});
		// cumulative ordering: the final-id state already exists when the
		// rename arrives
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-final",
			toolName: "read",
			args: { path: "src/merge.ts" },
		});
		group.renameEntry("read-tmp", "read-final");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-final",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-final",
		);
		const liveRows = visibleRows(booted.transcript);
		expect(
			liveRows.filter((row) => row.includes("read src/merge.ts")),
		).toHaveLength(1);
		expect(liveRows.join("\n")).toContain("• read src/merge.ts");
		expect(liveRows.join("\n")).not.toContain("● Read");
		addAnswer(booted, "merge done");
		await finishRun(booted, "merge done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("src/merge.ts");
		expect(completed).toContain("merge done");
		await shutdown(booted);
	},
);

stockTest("an empty provisional id migrates to its real id", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const group = new booted.host.ReadToolGroupComponent();
	booted.transcript.addChild(group);
	group.updateArgs({ path: "src/empty.ts" }, "");
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "",
		toolName: "read",
		args: { path: "src/empty.ts" },
	});
	group.renameEntry("", "read-empty-final");
	await dispatch(booted, {
		type: "tool_execution_end",
		toolCallId: "read-empty-final",
		toolName: "read",
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
	});
	group.updateResult(
		{ content: [{ type: "text", text: "ok" }], details: {} },
		false,
		"read-empty-final",
	);
	const live = visibleRows(booted.transcript).join("\n");
	expect(live).toContain("• read src/empty.ts");
	expect(live).not.toContain("● Read");
	addAnswer(booted, "empty done");
	await finishRun(booted, "empty done");
	const completed = visibleRows(booted.transcript).join("\n");
	expect(completed).not.toContain("src/empty.ts");
	expect(completed).toContain("empty done");
	await shutdown(booted);
});

stockTest(
	"an empty provisional id can be retracted without sticking the group native",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/gone.ts" }, "");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "",
			toolName: "read",
			args: { path: "src/gone.ts" },
		});
		group.removeEntry("");
		// a later tracked read still renders compact: the retracted empty id
		// no longer blocks the completeness gate
		group.updateArgs({ path: "src/stays.ts" }, "read-keep");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-keep",
			toolName: "read",
			args: { path: "src/stays.ts" },
		});
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("Working… read src/stays.ts");
		expect(live).not.toContain("src/gone.ts");
		expect(live).not.toContain("● Read");
		await shutdown(booted);
	},
);

stockTest(
	"a retracted sibling is dropped from the compact read rows",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/keep.ts" }, "read-keep");
		group.updateArgs({ path: "src/retract.ts" }, "read-retract");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-keep",
			toolName: "read",
			args: { path: "src/keep.ts" },
		});
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-retract",
			toolName: "read",
			args: { path: "src/retract.ts" },
		});
		group.removeEntry("read-retract");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-keep",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-keep",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("• read src/keep.ts");
		expect(live).not.toContain("src/retract.ts");
		expect(live).not.toContain("● Read");
		await shutdown(booted);
	},
);

stockTest(
	"multiple transcript candidates disable the adapter transactionally",
	async () => {
		let first: TranscriptInstance | undefined;
		let second: TranscriptInstance | undefined;
		const booted = await bootPlugin((root, host) => {
			first = new host.TranscriptContainer();
			second = new host.TranscriptContainer();
			root.addChild(first);
			root.addChild(second);
		});
		expect(booted.notifications[0]).toContain("multiple transcript containers");
		expect(first && Object.hasOwn(first, "addChild")).toBe(false);
		expect(second && Object.hasOwn(second, "addChild")).toBe(false);
		await shutdown(booted);
	},
);

stockTest(
	"transcript host patch failure rolls back transactionally",
	async () => {
		let transcript: TranscriptInstance | undefined;
		const booted = await bootPlugin((root, host) => {
			const candidate = new host.TranscriptContainer();
			Object.defineProperty(candidate, "isBlockUncommitted", {
				value: candidate.isBlockUncommitted,
				configurable: false,
				writable: true,
			});
			transcript = candidate;
			root.addChild(candidate);
		});
		if (!transcript) throw new Error("transcript missing");
		const resolvedTranscript = transcript;
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		// wrappers applied before the failing method are gone
		expect(Object.hasOwn(transcript, "render")).toBe(false);
		expect(Object.hasOwn(transcript, "renderViewportTail")).toBe(false);
		expect(Object.hasOwn(transcript, "addChild")).toBe(false);
		expect(transcript.render).toBe(Object.getPrototypeOf(transcript).render);
		expect(transcript.renderViewportTail).toBe(
			Object.getPrototypeOf(transcript).renderViewportTail,
		);
		// the incompatible own property keeps its exact descriptor
		expect(Object.hasOwn(transcript, "isBlockUncommitted")).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(transcript, "isBlockUncommitted")
				?.configurable,
		).toBe(false);
		// native rendering still executes and the spinner never started
		expect(() => resolvedTranscript.render(120)).not.toThrow();
		expect(booted.intervalCallbacks).toHaveLength(0);
		await shutdown(booted);
		expect(booted.notifications).toHaveLength(1);
	},
);

stockTest(
	"mid-patch tool component failure rolls back every wrapper",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "incompatible-tool",
			toolName: "bash",
			args: { command: "printf native" },
		});
		const component = new booted.host.ToolExecutionComponent(
			"bash",
			{ command: "printf native" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			booted.context.cwd,
			"incompatible-tool",
		);
		const nativeUpdateArgs = component.updateArgs;
		Object.defineProperty(component, "setArgsComplete", {
			value: component.setArgsComplete,
			configurable: false,
			writable: true,
		});
		const frozenComplete = component.setArgsComplete;
		const marker = { keep: true };
		(component as ToolExecutionInstance & { marker?: object }).marker = marker;
		booted.transcript.addChild(component);
		// a single warning and full adapter rollback
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		// wrappers applied before the failing method are gone
		expect(Object.hasOwn(component, "updateArgs")).toBe(false);
		expect(Object.hasOwn(component, "updateResult")).toBe(false);
		expect(component.updateArgs).toBe(nativeUpdateArgs);
		// the incompatible own property keeps its exact descriptor
		expect(component.setArgsComplete).toBe(frozenComplete);
		expect(
			Object.getOwnPropertyDescriptor(component, "setArgsComplete"),
		).toEqual({
			value: frozenComplete,
			writable: true,
			enumerable: false,
			configurable: false,
		});
		// unrelated own properties and prototype methods are untouched
		expect(
			(component as ToolExecutionInstance & { marker?: object }).marker,
		).toBe(marker);
		// native methods still execute and the transcript renders natively
		component.updateArgs({ command: "printf native" }, "incompatible-tool");
		expect(
			component
				.render(120)
				.map((line) => line.replace(ansiPattern, ""))
				.join("\n"),
		).toContain("printf native");
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"printf native",
		);
		// the adapter stays disabled for the rest of the session
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "after-rollback",
			toolName: "bash",
			args: { command: "printf second" },
		});
		const second = new booted.host.ToolExecutionComponent(
			"bash",
			{ command: "printf second" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			booted.context.cwd,
			"after-rollback",
		);
		booted.transcript.addChild(second);
		expect(booted.notifications).toHaveLength(1);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"printf second",
		);
		await shutdown(booted);
	},
);

stockTest("mid-patch read group failure rolls back every wrapper", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "read-incompatible",
		toolName: "read",
		args: { path: "src/a.ts" },
	});
	const group = new booted.host.ReadToolGroupComponent();
	const nativeUpdateArgs = group.updateArgs;
	Object.defineProperty(group, "updateResult", {
		value: group.updateResult,
		configurable: false,
		writable: true,
	});
	const frozenResult = group.updateResult;
	booted.transcript.addChild(group);
	// a single warning and full adapter rollback
	expect(booted.notifications).toHaveLength(1);
	expect(booted.notifications[0]).toContain("omp-compact disabled");
	// the wrapper applied before the failing method is gone
	expect(Object.hasOwn(group, "updateArgs")).toBe(false);
	expect(group.updateArgs).toBe(nativeUpdateArgs);
	// the incompatible own property keeps its exact descriptor
	expect(group.updateResult).toBe(frozenResult);
	// native methods still execute and the group renders natively
	group.updateArgs({ path: "src/b.ts" }, "read-incompatible");
	expect(visibleRows(booted.transcript).join("\n")).toContain("src/b.ts");
	await shutdown(booted);
});

stockTest("numbered edit rows survive the terminal answer", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const call = await addTool(
		booted,
		"edit",
		{ input: "numbered" },
		"edit-numbered",
	);
	await finishTool(booted, call, {
		toolCallId: "edit-numbered",
		toolName: "edit",
		result: {
			content: [{ type: "text", text: "edited" }],
			details: {
				path: "src/numbered.ts",
				diff: "-12|old line\n+12|new line\n+13|extra line\n",
			},
		},
		isError: false,
	});
	addAnswer(booted, "numbered edit done");
	await finishRun(booted, "numbered edit done");
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("edit: src/numbered.ts");
	expect(rows).toContain("+2|1");
	expect(booted.sentMessages).toEqual([]);
	expect(booted.appendedEntries).toHaveLength(1);
	expect(booted.appendedEntries[0]).toEqual({
		customType: "omp-compact-write",
		data: {
			version: 1,
			toolCallId: "edit-numbered",
			toolName: "edit",
			path: "src/numbered.ts",
			added: 2,
			removed: 1,
			exact: true,
		},
	});
	await shutdown(booted);
});

stockTest(
	"a late second transcript discovery rolls back and disables until switch",
	async () => {
		const booted = await bootWithTranscript();
		const second = new booted.host.TranscriptContainer();
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(true);
		expect(Object.hasOwn(second, "addChild")).toBe(false);
		booted.transcript.addChild(second);
		// one warning and the session timer is cleared
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("multiple transcript containers");
		expect(booted.clearedTimers).toEqual([booted.intervalCallbacks[0]]);
		// every wrapper is gone and native rendering still executes
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		expect(Object.hasOwn(booted.transcript, "render")).toBe(false);
		expect(Object.hasOwn(second, "addChild")).toBe(false);
		expect(() => booted.transcript.render(120)).not.toThrow();
		// the adapter stays disabled for the rest of the session
		await dispatch(booted, { type: "agent_start" });
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "bash-late",
			toolName: "bash",
			args: { command: "printf late" },
		});
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		expect(booted.notifications).toHaveLength(1);
		expect(booted.intervalCallbacks).toHaveLength(1);
		// a switch retries install; the conflict still fails open
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		expect(booted.notifications).toHaveLength(2);
		expect(booted.notifications[1]).toContain("multiple transcript containers");
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		expect(() => booted.transcript.render(120)).not.toThrow();
		await shutdown(booted);
	},
);

stockTest(
	"a failing notifier still completes rollback and native calls",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf hostile" },
			"bash-hostile",
		);
		const hostile = new Proxy(
			{},
			{
				get() {
					throw new Error("hostile result");
				},
			},
		);
		expect(() =>
			call.updateResult(hostile as never, false, "bash-hostile"),
		).toThrow("hostile result");
		// rollback completed despite the notifier failure
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		expect(Object.hasOwn(call, "updateResult")).toBe(false);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		expect(() => booted.transcript.render(120)).not.toThrow();
		// native calls keep working after the wrapper is gone
		call.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"bash-hostile",
		);
		expect(() => call.render(120)).not.toThrow();
		await shutdown(booted);
	},
);

stockTest(
	"switch after a rollback reinstalls once the conflict is gone",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const component = new booted.host.ToolExecutionComponent(
			"bash",
			{ command: "printf native" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			booted.context.cwd,
			"switch-incompatible",
		);
		Object.defineProperty(component, "setExpanded", {
			value: component.setExpanded,
			configurable: false,
			writable: true,
		});
		booted.transcript.addChild(component);
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		// remove the incompatible component, then switch sessions
		booted.transcript.children.length = 0;
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		// the adapter reinstalls cleanly and no second warning appears
		expect(booted.notifications).toHaveLength(1);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(true);
		await shutdown(booted);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
	},
);

stockTest(
	"compound Git Bash calls leave one aggregate commit summary after the answer",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "git add src/a.ts && git commit -m 'Add a'" },
			"git-compound",
		);
		await finishTool(booted, call, {
			toolCallId: "git-compound",
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
				],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(booted, "committed");
		await finishRun(booted, "committed");
		const rows = visibleRows(booted.transcript);
		const completed = rows.join("\n");
		// the terminal answer keeps only one aggregate commit summary; the
		// add invocation of the same Bash call is filtered from the view
		expect(completed).not.toContain("git add src/a.ts");
		expect(completed).not.toContain("git commit abc1234 Add a");
		expect(completed).toContain("git commit: abc1234");
		expect(rows.filter((row) => row.includes("git commit:")).length).toBe(1);
		expect(booted.sentMessages).toEqual([]);
		// a single evidence entry carries the ordered record list
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-git",
			data: {
				toolCallId: "git-compound",
				subcommand: "add",
				text: "git add src/a.ts",
				isError: false,
			},
		});
		expect(
			(booted.appendedEntries[0]?.data as { records?: unknown[] })?.records,
		).toEqual([
			{ subcommand: "add", text: "git add src/a.ts", isError: false },
			{
				subcommand: "commit",
				text: "git commit abc1234 Add a",
				isError: false,
			},
		]);
		await shutdown(booted);
	},
);

stockTest(
	"failed compound and cd-gated Git calls create no retained rows",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "git add a && git commit -m 'x'" },
			"git-compound-fail",
		);
		await finishTool(booted, call, {
			toolCallId: "git-compound-fail",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "nothing to commit" }],
				details: { exitCode: 1 },
			},
			isError: true,
		});
		addAnswer(booted, "reported");
		await finishRun(booted, "reported");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("git add a");
		expect(completed).not.toContain("git commit");
		expect(completed).toContain("reported");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);

		const gated = await bootWithTranscript();
		await beginRun(gated);
		const gatedCall = await addTool(
			gated,
			"bash",
			{ command: "cd repo && git add a && git commit -m 'x'" },
			"git-cd-fail",
		);
		await finishTool(gated, gatedCall, {
			toolCallId: "git-cd-fail",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "conflict" }],
				details: { exitCode: 1 },
			},
			isError: true,
		});
		addAnswer(gated, "reported");
		await finishRun(gated, "reported");
		const filtered = visibleRows(gated.transcript).join("\n");
		expect(filtered).not.toContain("git add a");
		expect(filtered).not.toContain("git commit");
		expect(filtered).toContain("reported");
		expect(gated.appendedEntries).toEqual([]);
		await shutdown(gated);
	},
);

stockTest(
	"process restore hydrates a compound Git row into its individual compact records",
	async () => {
		let transcript: TranscriptInstance | undefined;
		const branch = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "work" }] },
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "git-compound",
					toolName: "bash",
					args: {
						command: "git add src/a.ts && git commit -m 'Add a'",
					},
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "git-compound",
					toolName: "bash",
					content: [
						{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
					],
					isError: false,
				},
			},
			{ type: "message", message: assistant("done") },
			{
				type: "custom_message",
				customType: "omp-compact-git",
				display: false,
				content: "",
				details: {
					version: 1,
					toolCallId: "git-compound",
					subcommand: "add",
					text: "git add src/a.ts",
					isError: false,
					records: [
						{
							subcommand: "add",
							text: "git add src/a.ts",
							isError: false,
						},
						{
							subcommand: "commit",
							text: "git commit abc1234 Add a",
							isError: false,
						},
					],
				},
			},
		];
		const booted = await bootPlugin(
			(root, host) => {
				transcript = new host.TranscriptContainer();
				root.addChild(transcript);
				const call = new host.ToolExecutionComponent(
					"bash",
					{ command: "git add src/a.ts && git commit -m 'Add a'" },
					{ showImages: false, useBuiltInRenderer: true },
					fakeTool("bash"),
					toolUi(),
					"/tmp",
					"git-compound",
				);
				call.updateResult(
					{
						content: [
							{
								type: "text",
								text: "[main abc1234] Add a\n 1 file changed",
							},
						],
						details: {},
					},
					false,
					"git-compound",
				);
				transcript.addChild(call);
				const ContainerBase = Object.getPrototypeOf(
					host.ReadToolGroupComponent.prototype,
				).constructor as BootedPlugin["ContainerBase"];
				const reply = new ContainerBase();
				reply.addChild({ render: () => ["done"] });
				transcript.addChild(reply);
			},
			"/tmp",
			branch,
		);
		if (!transcript) throw new Error("transcript missing");
		const rows = visibleRows(transcript).join("\n");
		// entering the existing session forces compact on the restored
		// history: the compound call keeps its individual records instead of
		// the filtered aggregate summary
		expect(rows).not.toContain("git commit: abc1234");
		expect(rows).toContain("git add src/a.ts");
		expect(rows).toContain("git commit abc1234 Add a");
		expect(rows).toContain("done");
		await shutdown(booted);
	},
);

stockTest(
	"brand-new file below a new nested directory keeps exact +N|0 and retention",
	async () => {
		const cwd = "/tmp/omp-compact-newfile";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "src", "components", "Button.tsx");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"write",
			{
				path: "src/components/Button.tsx",
				content: "untrusted raw input",
			},
			"write-new-nested",
		);
		// Native completion creates the missing directories as well as the
		// file; the raw requested content never becomes the post-image.
		await mkdir(dirname(path), { recursive: true });
		await Bun.write(path, "export const Button = () => <button />;\n");
		await finishTool(booted, call, {
			toolCallId: "write-new-nested",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		addAnswer(booted, "written");
		await finishRun(booted, "written");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: src/components/Button.tsx");
		expect(rows).toContain("+1|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toHaveLength(1);
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-write",
			data: {
				version: 1,
				toolCallId: "write-new-nested",
				toolName: "write",
				path: "src/components/Button.tsx",
				added: 1,
				removed: 0,
				exact: true,
			},
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"multi-line brand-new file reports exact +3|0 on the same row",
	async () => {
		const cwd = "/tmp/omp-compact-newfile-multi";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "multi.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			"write-new-multi",
		);
		await Bun.write(path, "one\ntwo\nthree\n");
		await finishTool(booted, call, {
			toolCallId: "write-new-multi",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		addAnswer(booted, "written");
		await finishRun(booted, "written");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: multi.ts");
		expect(rows).toContain("+3|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-write",
			data: {
				version: 1,
				toolCallId: "write-new-multi",
				added: 3,
				removed: 0,
				exact: true,
			},
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"brand-new empty file stays a no-op and disappears after the answer",
	async () => {
		const cwd = "/tmp/omp-compact-newfile-empty";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "empty.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"write",
			{ path: "empty.ts", content: "" },
			"write-new-empty",
		);
		await Bun.write(path, "");
		await finishTool(booted, call, {
			toolCallId: "write-new-empty",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("write: empty.ts");
		expect(completed).not.toContain("0|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

// ---------------------------------------------------------------------------
// Fire-and-forget delivery contracts (runtime race regression)
// ---------------------------------------------------------------------------
// Stock AgentSession never awaits extension listener promises, so in the real
// host `tool_execution_start` / `tool_execution_end` / `agent_end` handlers
// overlap in flight. Every test above goes through `dispatch`, which awaits
// each handler, so the sequential suite always observes the previous handler
// fully settled — it cannot reproduce (and therefore masked) the runtime
// race where a new non-empty write ends up with no stats/evidence.
//
// The contracts below model stock delivery with `dispatchFireAndForget`:
// each listener is invoked synchronously and the next event fires without
// awaiting the previous handler's promise. The race is therefore forced
// deterministically: the second handler's synchronous prologue (which must
// consume the audit record) provably runs before the first handler's async
// work — whatever shape it takes — can complete. No sleeps or timers.
//
// File-state determinism for the write audit: the pre-image snapshot must
// not race the native write, and the post-image read happens inside the end
// handler's completion work. Firing start and end back-to-back, then
// settling the start handler (pre-image state fixed, file still absent) and
// writing the file synchronously via `writeFileSync` lands the file before
// any post-image filesystem result can be delivered back to the end
// handler — a happens-before chain, not a timing guess.
//
// Red phase (pre-fix): the audit record was registered only after the start
// handler's capture resolved, so an end event fired before that saw no
// record and published nothing; `agent_end` fired before the end handler's
// audit completed committed a ledger view that can never be rewritten, so
// evidence and retention were lost. Green phase (post-fix): the record
// exists synchronously, the end handler consumes it and publishes exactly
// once, and `agent_end` waits for the run's in-flight audit work before
// filtering.

stockTest(
	"fire-and-forget write start/end overlap still publishes exact +3|0 evidence",
	async () => {
		const cwd = "/tmp/omp-compact-race-overlap";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "multi.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const toolCallId = "write-race-overlap";
		const startEvent = {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		};
		const endEvent = {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		};
		// Stock delivery: the end event fires without awaiting the start
		// handler; the audit record must already exist for the end handler's
		// synchronous prologue to consume.
		const startPromise = dispatchFireAndForget(booted, startEvent);
		const endPromise = dispatchFireAndForget(booted, endEvent);
		const component = addToolComponent(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			toolCallId,
		);
		// Before-snapshot is complete and the file is still absent; the native
		// write lands synchronously before any post-image read can complete.
		await startPromise;
		writeFileSync(path, "one\ntwo\nthree\n");
		await endPromise;
		component.updateResult(endEvent.result, false, toolCallId);
		addAnswer(booted, "written");
		await finishRun(booted, "written");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: multi.ts");
		expect(rows).toContain("+3|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([
			{
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId,
					toolName: "write",
					path: "multi.ts",
					added: 3,
					removed: 0,
					exact: true,
				},
			},
		]);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"agent_end waits for an in-flight write audit before terminal filtering",
	async () => {
		const cwd = "/tmp/omp-compact-race-agentend";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "multi.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const toolCallId = "write-race-agentend";
		// Fully settled start, then the native write, then the end event fired
		// without awaiting: the end handler consumes the record and suspends on
		// the post-image audit.
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		});
		const component = addToolComponent(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			toolCallId,
		);
		await Bun.write(path, "one\ntwo\nthree\n");
		const endPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		// The terminal answer arrives while the end handler is still awaiting
		// the post-image read. `agent_end` must not commit the filtered view
		// (nor publish the retention entry) before that audit work settles.
		addAnswer(booted, "written");
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("written")],
			willContinue: false,
		});
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([
			{
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId,
					toolName: "write",
					path: "multi.ts",
					added: 3,
					removed: 0,
					exact: true,
				},
			},
		]);
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: multi.ts");
		expect(rows).toContain("+3|0");
		await endPromise;
		component.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			false,
			toolCallId,
		);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"concurrent fire-and-forget writes keep one exact row and entry each",
	async () => {
		const cwd = "/tmp/omp-compact-race-concurrent";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const pathA = join(cwd, "a.ts");
		const pathB = join(cwd, "b.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const startA = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId: "write-race-a",
			toolName: "write",
			args: { path: "a.ts", content: "untrusted raw input" },
		});
		const componentA = addToolComponent(
			booted,
			"write",
			{ path: "a.ts", content: "untrusted raw input" },
			"write-race-a",
		);
		const startB = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId: "write-race-b",
			toolName: "write",
			args: { path: "b.ts", content: "untrusted raw input" },
		});
		const componentB = addToolComponent(
			booted,
			"write",
			{ path: "b.ts", content: "untrusted raw input" },
			"write-race-b",
		);
		// both end events still fire without awaiting either start handler
		const endA = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId: "write-race-a",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: pathA },
			},
			isError: false,
		});
		const endB = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId: "write-race-b",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: pathB },
			},
			isError: false,
		});
		await Promise.all([startA, startB]);
		writeFileSync(pathA, "one\ntwo\n");
		writeFileSync(pathB, "one\ntwo\nthree\n");
		await Promise.all([endA, endB]);
		componentA.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: pathA },
			},
			false,
			"write-race-a",
		);
		componentB.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: pathB },
			},
			false,
			"write-race-b",
		);
		addAnswer(booted, "written");
		await finishRun(booted, "written");
		const rows = visibleRows(booted.transcript);
		const completed = rows.join("\n");
		expect(completed).toContain("write: a.ts");
		expect(completed).toContain("+2|0");
		expect(completed).toContain("write: b.ts");
		expect(completed).toContain("+3|0");
		// exactly one compact row per write, no duplicates
		expect(rows.filter((line) => line.includes("write: a.ts"))).toHaveLength(1);
		expect(rows.filter((line) => line.includes("write: b.ts"))).toHaveLength(1);
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toHaveLength(2);
		const byToolCallId = new Map(
			booted.appendedEntries.map((entry) => [
				(entry.data as { toolCallId?: string } | undefined)?.toolCallId,
				entry,
			]),
		);
		expect(byToolCallId.get("write-race-a")).toEqual({
			customType: "omp-compact-write",
			data: {
				version: 1,
				toolCallId: "write-race-a",
				toolName: "write",
				path: "a.ts",
				added: 2,
				removed: 0,
				exact: true,
			},
		});
		expect(byToolCallId.get("write-race-b")).toEqual({
			customType: "omp-compact-write",
			data: {
				version: 1,
				toolCallId: "write-race-b",
				toolName: "write",
				path: "b.ts",
				added: 3,
				removed: 0,
				exact: true,
			},
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"fire-and-forget write audit survives a willContinue agent_end",
	async () => {
		const cwd = "/tmp/omp-compact-race-continue";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "multi.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const toolCallId = "write-race-continue";
		const startPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		});
		const endPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		const component = addToolComponent(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			toolCallId,
		);
		await startPromise;
		writeFileSync(path, "one\ntwo\nthree\n");
		await endPromise;
		component.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			false,
			toolCallId,
		);
		// continuation keeps the run live: no cleanup, row stays visible
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("still working", "toolUse")],
			willContinue: true,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"write: multi.ts",
		);
		// the eventual terminal answer keeps the verified row
		addAnswer(booted, "written");
		await finishRun(booted, "written");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: multi.ts");
		expect(rows).toContain("+3|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([
			{
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId,
					toolName: "write",
					path: "multi.ts",
					added: 3,
					removed: 0,
					exact: true,
				},
			},
		]);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"abort commit keeps fire-and-forget write evidence intact",
	async () => {
		const cwd = "/tmp/omp-compact-race-abort";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "multi.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const toolCallId = "write-race-abort";
		const startPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		});
		const endPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		const component = addToolComponent(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			toolCallId,
		);
		await startPromise;
		writeFileSync(path, "one\ntwo\nthree\n");
		await endPromise;
		component.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			false,
			toolCallId,
		);
		// an aborted run commits the complete log: the row stays with stats
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("", "aborted")],
			willContinue: false,
		});
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: multi.ts");
		expect(rows).toContain("+3|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([
			{
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId,
					toolName: "write",
					path: "multi.ts",
					added: 3,
					removed: 0,
					exact: true,
				},
			},
		]);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"no-op write under fire-and-forget delivery stays filtered without evidence",
	async () => {
		const cwd = "/tmp/omp-compact-race-noop";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "same.ts");
		// the file already exists with its final content before the start
		// event: both the before-snapshot and the post-image read are
		// deterministic and identical
		await Bun.write(path, "same\n");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const toolCallId = "write-race-noop";
		const startPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "same.ts", content: "same\n" },
		});
		const endPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		const component = addToolComponent(
			booted,
			"write",
			{ path: "same.ts", content: "same\n" },
			toolCallId,
		);
		await startPromise;
		await endPromise;
		component.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			false,
			toolCallId,
		);
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("same.ts");
		expect(completed).not.toContain("0|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"a write ended after the terminal commit publishes no late evidence",
	async () => {
		const cwd = "/tmp/omp-compact-race-lateend";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "multi.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const toolCallId = "write-race-lateend";
		// the start event fires but the tool never ends before the terminal
		// answer: the record is still pending when agent_end commits
		const startPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		});
		const component = addToolComponent(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			toolCallId,
		);
		addAnswer(booted, "written");
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("written")],
			willContinue: false,
		});
		// the committed view is authoritative: the late end must fail closed
		await startPromise;
		writeFileSync(path, "one\ntwo\nthree\n");
		await dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		component.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			false,
			toolCallId,
		);
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("write: multi.ts");
		expect(completed).not.toContain("+3|0");
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"shutdown during an in-flight write audit stays deadlock-free and clean",
	async () => {
		const cwd = "/tmp/omp-compact-race-shutdown";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const startPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId: "write-race-shutdown",
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		});
		addToolComponent(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			"write-race-shutdown",
		);
		// shutdown and session switch arrive while the capture is in flight
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		await dispatch(booted, { type: "session_shutdown" });
		// the late capture completes without publishing anything or throwing
		await startPromise;
		await dispatch(booted, { type: "session_shutdown" });
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"multi-Git record bookkeeping stays visible until the terminal filter",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		// the git record is registered synchronously at start, and the end
		// handler's git bookkeeping is synchronous too: even with fire-and-
		// forget delivery the retained row and its evidence entry must be
		// committed with the terminal answer, never after it
		const startPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId: "git-race-compound",
			toolName: "bash",
			args: {
				command: "git add src/a.ts && git commit -m 'Add a'",
			},
		});
		const component = addToolComponent(
			booted,
			"bash",
			{ command: "git add src/a.ts && git commit -m 'Add a'" },
			"git-race-compound",
		);
		const endPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId: "git-race-compound",
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
				],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		await startPromise;
		await endPromise;
		component.updateResult(
			{
				content: [
					{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
				],
				details: { exitCode: 0 },
			},
			false,
			"git-race-compound",
		);
		// while the run is live every invocation of the compound call is visible
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("git add src/a.ts");
		expect(live).toContain("git commit abc1234 Add a");
		addAnswer(booted, "committed");
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("committed")],
			willContinue: false,
		});
		// evidence and the retained multi-record row are committed together
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-git",
			data: {
				toolCallId: "git-race-compound",
				subcommand: "add",
				text: "git add src/a.ts",
				isError: false,
			},
		});
		expect(
			(booted.appendedEntries[0]?.data as { records?: unknown[] })?.records,
		).toEqual([
			{ subcommand: "add", text: "git add src/a.ts", isError: false },
			{
				subcommand: "commit",
				text: "git commit abc1234 Add a",
				isError: false,
			},
		]);
		const rows = visibleRows(booted.transcript);
		const completed = rows.join("\n");
		// the terminal filter collapses the compound call into the aggregate
		// commit summary while the persisted evidence keeps every record
		expect(completed).not.toContain("git add src/a.ts");
		expect(completed).not.toContain("git commit abc1234 Add a");
		expect(completed).toContain("git commit: abc1234");
		expect(rows.filter((row) => row.includes("git commit:")).length).toBe(1);
		await shutdown(booted);
	},
);

stockTest(
	"terminal answer leaves one aggregate Git row after all mutation rows",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const firstEdit = await addTool(
			booted,
			"edit",
			{ input: "replace" },
			"edit-1",
		);
		await finishTool(booted, firstEdit, {
			toolCallId: "edit-1",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "edited" }],
				details: {
					path: "src/first.ts",
					op: "update",
					diff: "-12|old line\n+12|new line",
				},
			},
			isError: false,
		});
		// the Git evidence sits between the mutations and includes a
		// non-commit invocation: the summary must still land after every
		// retained write/edit row, in chronological hash order
		const git = await addTool(
			booted,
			"bash",
			{ command: "git add src/a.ts && git commit -m 'Add a'" },
			"git-mid",
		);
		await finishTool(booted, git, {
			toolCallId: "git-mid",
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
				],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		const status = await addTool(
			booted,
			"bash",
			{ command: "git status --short" },
			"git-status",
		);
		await finishTool(booted, status, {
			toolCallId: "git-status",
			toolName: "bash",
			result: { content: [{ type: "text", text: "clean" }], details: {} },
			isError: false,
		});
		const secondEdit = await addTool(
			booted,
			"edit",
			{ input: "append" },
			"edit-2",
		);
		await finishTool(booted, secondEdit, {
			toolCallId: "edit-2",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "edited" }],
				details: {
					path: "src/second.ts",
					op: "update",
					diff: "+2|line one\n+2|line two",
				},
			},
			isError: false,
		});
		const lateCommit = await addTool(
			booted,
			"bash",
			{ command: "git commit -m 'Fix b'" },
			"git-late",
		);
		await finishTool(booted, lateCommit, {
			toolCallId: "git-late",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "[main f00d55] Fix b" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const rows = visibleRows(booted.transcript);
		const completed = rows.join("\n");
		// both mutations survive, in order, each as its own compact row
		expect(completed).toContain("edit: src/first.ts");
		expect(completed).toContain("edit: src/second.ts");
		// exactly one aggregate row after the last mutation, chronological hashes
		const summaryRows = rows.filter((row) => row.includes("git commit:"));
		expect(summaryRows).toEqual(["• git commit: abc1234, f00d55"]);
		expect(rows.indexOf("edit: src/second.ts")).toBeLessThan(
			rows.indexOf("• git commit: abc1234, f00d55"),
		);
		// individual and non-commit Git rows are gone from the view
		expect(completed).not.toContain("git add");
		expect(completed).not.toContain("git status");
		expect(completed).not.toContain("git commit abc1234 Add a");
		// persisted evidence keeps every invocation of every Git call
		const gitEntries = booted.appendedEntries.filter(
			(entry) => entry.customType === "omp-compact-git",
		);
		expect(gitEntries).toHaveLength(3);
		expect(gitEntries[0]?.data).toMatchObject({ toolCallId: "git-mid" });
		expect((gitEntries[0]?.data as { records?: unknown[] })?.records).toEqual([
			{ subcommand: "add", text: "git add src/a.ts", isError: false },
			{
				subcommand: "commit",
				text: "git commit abc1234 Add a",
				isError: false,
			},
		]);
		expect(gitEntries[1]?.data).toMatchObject({
			toolCallId: "git-status",
			subcommand: "status",
		});
		expect(gitEntries[2]?.data).toMatchObject({
			toolCallId: "git-late",
			subcommand: "commit",
			text: "git commit f00d55 Fix b",
		});
		await shutdown(booted);
	},
);

stockTest(
	"abort keeps every Git record of the run in the full log",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "git add a && git commit -m 'Add a' && git status" },
			"git-abort",
		);
		await finishTool(booted, call, {
			toolCallId: "git-abort",
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
				],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		// abort/error without a terminal answer keeps the full log unfiltered
		await finishRun(booted, "", "aborted");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("git add a");
		expect(rows).toContain("git commit abc1234 Add a");
		expect(rows).toContain("git status");
		// the aggregate summary row belongs to the filtered phase only
		expect(rows).not.toContain("git commit:");
		await shutdown(booted);
	},
);

async function groupedRead(
	booted: BootedPlugin & { transcript: TranscriptInstance },
	path: string,
	toolCallId: string,
): Promise<void> {
	const group = new booted.host.ReadToolGroupComponent();
	booted.transcript.addChild(group);
	group.updateArgs({ path }, toolCallId);
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId,
		toolName: "read",
		args: { path },
	});
	await dispatch(booted, {
		type: "tool_execution_end",
		toolCallId,
		toolName: "read",
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
	});
	group.updateResult(
		{ content: [{ type: "text", text: "ok" }], details: {} },
		false,
		toolCallId,
	);
}

stockTest(
	"absolute reads inside the session cwd render relative by default",
	async () => {
		const booted = await bootWithTranscript("/tmp");
		await beginRun(booted);
		await groupedRead(booted, "/tmp/src/a.ts", "read-rel-1");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("• read src/a.ts");
		expect(live).not.toContain("• read /tmp/src/a.ts");
		addAnswer(booted, "rel done");
		await finishRun(booted, "rel done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("rel done");
		expect(completed).not.toContain("src/a.ts");
		await shutdown(booted);
	},
);

stockTest(
	"reads of the session cwd itself and of external paths keep their form",
	async () => {
		const booted = await bootWithTranscript("/tmp");
		await beginRun(booted);
		await groupedRead(booted, "/tmp", "read-dot-1");
		await groupedRead(booted, "/etc/hosts", "read-ext-1");
		await groupedRead(booted, "/tmp-2/boundary.ts", "read-boundary-1");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("• read .");
		expect(live).toContain("• read /etc/hosts");
		expect(live).toContain("• read /tmp-2/boundary.ts");
		await shutdown(booted);
	},
);

stockTest("write mutation rows relativize the audited path", async () => {
	const cwd = "/tmp/omp-compact-display-write";
	await rm(cwd, { recursive: true, force: true });
	await mkdir(cwd, { recursive: true });
	const path = join(cwd, "write.ts");
	await Bun.write(path, "const a = 1;\nkeep();\n");
	const booted = await bootWithTranscript(cwd);
	await beginRun(booted);
	const call = await addTool(
		booted,
		"write",
		{ path: path, content: "ignored raw input" },
		"write-display-1",
	);
	await Bun.write(path, "const a = 2;\nkeep();\nextra();\n");
	await finishTool(booted, call, {
		toolCallId: "write-display-1",
		toolName: "write",
		result: {
			content: [{ type: "text", text: "ok" }],
			details: { resolvedPath: path },
		},
		isError: false,
	});
	addAnswer(booted, "display written");
	await finishRun(booted, "display written");
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("write: write.ts");
	expect(rows).toContain("+2|1");
	expect(rows).not.toContain("write: /tmp/omp-compact-display-write/write.ts");
	// persisted evidence keeps the audited absolute path untouched
	expect(booted.appendedEntries[0]).toMatchObject({
		customType: "omp-compact-write",
		data: {
			version: 1,
			toolCallId: "write-display-1",
			path: path,
			added: 2,
			removed: 1,
			exact: true,
		},
	});
	await shutdown(booted);
	await rm(cwd, { recursive: true, force: true });
});

stockTest(
	"a new session with a different cwd re-relativizes display paths",
	async () => {
		const first = await bootWithTranscript("/tmp/session-a");
		await beginRun(first);
		await groupedRead(first, "/tmp/session-a/x.ts", "read-s1");
		expect(visibleRows(first.transcript).join("\n")).toContain("• read x.ts");
		await shutdown(first);

		const second = await bootWithTranscript("/tmp/session-b");
		await beginRun(second);
		await groupedRead(second, "/tmp/session-b/x.ts", "read-s2");
		await groupedRead(second, "/tmp/session-a/x.ts", "read-s3");
		const rows = visibleRows(second.transcript).join("\n");
		expect(rows).toContain("• read x.ts");
		expect(rows).toContain("• read /tmp/session-a/x.ts");
		await shutdown(second);
	},
);

stockTest(
	"replayed absolute reads use the current session cwd for display",
	async () => {
		let transcript: TranscriptInstance | undefined;
		const branch = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "work" }] },
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "read-replay-in",
					toolName: "read",
					args: { path: "/tmp/replay-in.ts" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-replay-in",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "read-replay-out",
					toolName: "read",
					args: { path: "/etc/hosts" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-replay-out",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
		];
		const booted = await bootPlugin(
			(root, host) => {
				transcript = new host.TranscriptContainer();
				root.addChild(transcript);
				const group = new host.ReadToolGroupComponent();
				transcript.addChild(group);
			},
			"/tmp",
			branch,
		);
		if (!transcript) throw new Error("transcript missing");
		const rows = visibleRows(transcript).join("\n");
		expect(rows).toContain("• read replay-in.ts");
		expect(rows).not.toContain("• read /tmp/replay-in.ts");
		expect(rows).toContain("• read /etc/hosts");
		await shutdown(booted);
	},
);

// ---------------------------------------------------------------------------
// RuntimeModes (upgrade2 item 2): compact / live / clear runtime modes.
// ---------------------------------------------------------------------------

async function bootWithMode(
	mode: "compact" | "live" | "clear",
	extra: Record<string, unknown> = {},
): Promise<BootedPlugin & { transcript: TranscriptInstance }> {
	let transcript: TranscriptInstance | undefined;
	const booted = await bootPlugin(
		(root, host) => {
			transcript = new host.TranscriptContainer();
			root.addChild(transcript);
		},
		"/tmp",
		[],
		false,
		{ ...DEFAULT_SETTINGS, mode, ...extra },
	);
	if (!transcript) throw new Error("transcript missing");
	return { ...booted, transcript };
}

stockTest(
	"compact mode keeps the entire compact tool log at terminal",
	async () => {
		const booted = await bootWithMode("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf compact-kept" },
			"bash-compact",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-compact",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf compact-kept",
		);
		addAnswer(booted, "compact done");
		await finishRun(booted, "compact done");
		const terminalRows = visibleRows(booted.transcript).join("\n");
		// the full compact log survives the successful terminal finalization
		expect(terminalRows).toContain("bash: printf compact-kept");
		// no duplicate aggregate projections on top of the kept log
		expect(terminalRows).not.toContain("git commit:");
		await shutdown(booted);
	},
);

stockTest(
	"compact mode keeps read and git rows at terminal (live filters them)",
	async () => {
		const booted = await bootWithMode("compact");
		await beginRun(booted);
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/keep.ts" }, "read-c");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-c",
			toolName: "read",
			args: { path: "src/keep.ts" },
		});
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-c",
			toolName: "read",
			result: { content: [{ type: "text", text: "src" }] },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "src" }] },
			false,
			"read-c",
		);
		const git = await addTool(
			booted,
			"bash",
			{ command: "git status --short" },
			"git-c",
		);
		await finishTool(booted, git, {
			toolCallId: "git-c",
			toolName: "bash",
			result: { content: [{ type: "text", text: " M src/keep.ts" }] },
			isError: false,
		});
		addAnswer(booted, "compact read done");
		await finishRun(booted, "compact read done");
		const terminalRows = visibleRows(booted.transcript).join("\n");
		expect(terminalRows).toContain("read src/keep.ts");
		expect(terminalRows).toContain("git status --short");
		await shutdown(booted);
	},
);

stockTest("clear mode hides routine tools including task", async () => {
	const booted = await bootWithMode("clear");
	await beginRun(booted);
	const call = await addTool(
		booted,
		"bash",
		{ command: "printf clear-hidden" },
		"bash-clear",
	);
	await finishTool(booted, call, {
		toolCallId: "bash-clear",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	const task = await addTool(
		booted,
		"task",
		{ description: "subagent work" },
		"task-clear",
	);
	await finishTool(booted, task, {
		toolCallId: "task-clear",
		toolName: "task",
		result: { content: [{ type: "text", text: "done" }] },
		isError: false,
	});
	// Clear mode hides compact routine rows while preserving the native
	// renderer only for genuinely interactive controls.
	const liveRows = visibleRows(booted.transcript).join("\n");
	expect(liveRows).not.toContain("clear-hidden");
	expect(liveRows).not.toContain("task: description: subagent work");
	addAnswer(booted, "clear done");
	await finishRun(booted, "clear done");
	const terminalRows = visibleRows(booted.transcript).join("\n");
	expect(terminalRows).not.toContain("clear-hidden");
	expect(terminalRows).not.toContain("subagent work");
	expect(terminalRows).toContain("clear done");
	await shutdown(booted);
});

stockTest("clear mode abort keeps compact diagnostic rows", async () => {
	const booted = await bootWithMode("clear");
	await beginRun(booted);
	const call = await addTool(
		booted,
		"bash",
		{ command: "printf clear-diag" },
		"bash-diag",
	);
	await finishTool(booted, call, {
		toolCallId: "bash-diag",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	await finishRun(booted, "", "aborted");
	expect(visibleRows(booted.transcript).join("\n")).toContain(
		"bash: printf clear-diag",
	);
	await shutdown(booted);
});

stockTest(
	"clear mode keeps unknown tool components native in every phase",
	async () => {
		const booted = await bootWithMode("clear");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"future_tool",
			{ query: "clear fail-open" },
			"unknown-clear",
		);
		call.render = () => ["native-clear-unknown"];
		await finishTool(booted, call, {
			toolCallId: "unknown-clear",
			toolName: "future_tool",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		// `clear` hides routine rows but must never hide an unknown tool
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"native-clear-unknown",
		);
		await finishRun(booted, "", "aborted");
		// abort diagnostics keep the unknown tool's native surface too
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"native-clear-unknown",
		);
		await shutdown(booted);
	},
);

stockTest(
	"clear mode abort keeps the compact task diagnostic row",
	async () => {
		const booted = await bootWithMode("clear");
		await beginRun(booted);
		const task = await addTool(
			booted,
			"task",
			{ description: "subagent diagnostics" },
			"task-clear-abort",
		);
		task.render = () => ["native-task-abort"];
		await finishTool(booted, task, {
			toolCallId: "task-clear-abort",
			toolName: "task",
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});
		await finishRun(booted, "", "aborted");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("task: description: subagent diagnostics");
		expect(rows).not.toContain("native-task-abort");
		await shutdown(booted);
	},
);

stockTest(
	"retainGitLive=false suppresses Git rows and the commit summary",
	async () => {
		const booted = await bootWithMode("live", { retainGitLive: false });
		await beginRun(booted);
		const commit = await addTool(
			booted,
			"bash",
			{ command: "git commit -m 'Hide me'" },
			"git-hidden",
		);
		await finishTool(booted, commit, {
			toolCallId: "git-hidden",
			toolName: "bash",
			result: { content: [{ type: "text", text: "[main abc1234] Hide me" }] },
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).not.toContain(
			"git commit abc1234 Hide me",
		);
		addAnswer(booted, "hidden commit done");
		await finishRun(booted, "hidden commit done");
		const terminalRows = visibleRows(booted.transcript).join("\n");
		expect(terminalRows).not.toContain("git commit:");
		// evidence is never mutated by the visual toggle
		const gitEntries = booted.appendedEntries.filter(
			(entry) => entry.customType === "omp-compact-git",
		);
		expect(gitEntries).toHaveLength(1);
		expect(gitEntries[0]).toMatchObject({
			data: { toolCallId: "git-hidden", text: "git commit abc1234 Hide me" },
		});
		await shutdown(booted);
	},
);

// ---------------------------------------------------------------------------
// Multi-response run evidence (D01/D02): one logical run spans several
// assistant-response groups (toolUse continuations) inside a single
// agent_start → terminal agent_end. Every mapped routine row — from the
// early AND the late groups, parallel/delayed reads included — must follow
// the frozen per-run mode at the terminal answer (`live` filters all,
// `compact` retains all in transcript order, `clear` hides ordinary rows),
// and the assistant texts keep their order (group texts precede the later
// group's rows; the terminal answer text is last and unchanged). The fold's
// committed-row seam is observable on this path too: while working every
// mapped member reports uncommitted; after the carrier declares committed
// rows the transcript reports members below the boundary as committed —
// and the projection still follows the mode, because the seam is
// presentation-only (the missing live signal is the native viewport commit,
// see the D02 classification).
// ---------------------------------------------------------------------------

interface CommittedSeamTranscript extends TranscriptInstance {
	isBlockUncommitted?(component: unknown): boolean;
}

interface CommittedSeamComponent extends ToolExecutionInstance {
	setNativeScrollbackCommittedRows?(rows: number): void;
}

stockTest(
	"multi-response runs: early and late group rows follow the frozen mode at terminal; assistant texts keep order",
	async () => {
		const EXPECTED_COMPACT_ROWS = [
			"• bash: printf early",
			"• read src/early.ts",
			"• read src/a.ts",
			"• read src/b.ts",
			"• read src/c.ts",
			"• bash: printf late",
			"[ 6 actions · 0 sent · 0 received · 0% cache (0 hit) · 0s ]",
			"final answer",
		];
		const EXPECTED_FILTERED_ROWS = [
			"[ 6 actions · 0 sent · 0 received · 0% cache (0 hit) · 0s ]",
			"final answer",
		];
		for (const mode of ["live", "compact", "clear"] as const) {
			const booted = await bootWithMode(mode);
			await beginRun(booted);

			// Group 1 (early): a routine tool and a read, then a toolUse
			// continuation (agent_end willContinue).
			const bashEarly = await addTool(
				booted,
				"bash",
				{ command: "printf early" },
				"early-bash",
			);
			await finishTool(booted, bashEarly, {
				toolCallId: "early-bash",
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			});
			await groupedRead(booted, "src/early.ts", "early-read");
			await finishRun(booted, "early group text", "toolUse", true);

			// Group 2 (late): three parallel reads in ONE group; results
			// arrive out of call order (b, c) with the last delayed until
			// after the next continuation agent_end; then a routine tool.
			const lateGroup = new booted.host.ReadToolGroupComponent();
			booted.transcript.addChild(lateGroup);
			lateGroup.updateArgs({ path: "src/a.ts" }, "late-a");
			lateGroup.updateArgs({ path: "src/b.ts" }, "late-b");
			lateGroup.updateArgs({ path: "src/c.ts" }, "late-c");
			await dispatch(booted, {
				type: "tool_execution_start",
				toolCallId: "late-a",
				toolName: "read",
				args: { path: "src/a.ts" },
			});
			await dispatch(booted, {
				type: "tool_execution_start",
				toolCallId: "late-b",
				toolName: "read",
				args: { path: "src/b.ts" },
			});
			await dispatch(booted, {
				type: "tool_execution_start",
				toolCallId: "late-c",
				toolName: "read",
				args: { path: "src/c.ts" },
			});
			const settleLateRead = async (id: string): Promise<void> => {
				await dispatch(booted, {
					type: "tool_execution_end",
					toolCallId: id,
					toolName: "read",
					result: { content: [{ type: "text", text: id }], details: {} },
					isError: false,
				});
				lateGroup.updateResult(
					{ content: [{ type: "text", text: id }], details: {} },
					false,
					id,
				);
			};
			await settleLateRead("late-b");
			await settleLateRead("late-c");
			await finishRun(booted, "late group text", "toolUse", true);
			await settleLateRead("late-a");
			const bashLate = await addTool(
				booted,
				"bash",
				{ command: "printf late" },
				"late-bash",
			);
			await finishTool(booted, bashLate, {
				toolCallId: "late-bash",
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			});

			// While working, the committed-row seam is observable: every
			// mapped member is still live (uncommitted), and declaring the
			// run's rows committed through the carrier seam flips the
			// transcript report for members below the boundary.
			const liveRows = visibleRows(booted.transcript).join("\n");
			if (mode === "clear") {
				// `clear` hides ordinary rows from the very first phase.
				expect(liveRows).toBe("");
			} else {
				expect(liveRows).toContain("printf early");
				expect(liveRows).toContain("src/c.ts");
			}
			const transcript = booted.transcript as CommittedSeamTranscript;
			const span = visibleRows(booted.transcript).length;
			if (mode === "clear") {
				// `clear` never projects ordinary rows, so there is no span to
				// commit: the seam stays fail-open (members report uncommitted)
				// and the projection stays hidden.
				expect(span).toBe(0);
				expect(transcript.isBlockUncommitted?.(lateGroup)).toBe(true);
				(
					bashEarly as CommittedSeamComponent
				).setNativeScrollbackCommittedRows?.(10);
				expect(transcript.isBlockUncommitted?.(lateGroup)).toBe(true);
				expect(visibleRows(booted.transcript).join("\n")).toBe("");
			} else {
				expect(transcript.isBlockUncommitted?.(lateGroup)).toBe(true);
				expect(transcript.isBlockUncommitted?.(bashLate)).toBe(true);
				expect(span).toBeGreaterThan(0);
				(
					bashEarly as CommittedSeamComponent
				).setNativeScrollbackCommittedRows?.(span);
				expect(transcript.isBlockUncommitted?.(lateGroup)).toBe(false);
				expect(transcript.isBlockUncommitted?.(bashLate)).toBe(false);
				// The committed declaration is presentation-only: the projection
				// still renders every mapped row while working.
				expect(visibleRows(booted.transcript).join("\n")).toContain(
					"printf late",
				);
			}

			// Terminal answer: the assistant text is unchanged and last, and
			// every mapped row from both groups follows the frozen mode.
			addAnswer(booted, "final answer");
			await finishRun(booted, "final answer");
			const terminalRows = visibleRows(booted.transcript);
			if (mode === "compact") {
				expect(terminalRows).toEqual(EXPECTED_COMPACT_ROWS);
			} else {
				// `live` filters every routine row; `clear` hides ordinary rows.
				expect(terminalRows).toEqual(EXPECTED_FILTERED_ROWS);
			}
			// Rows from both groups settled: the fold finalizes every member
			// and reports the run's settled span on the carrier.
			expect(bashEarly.isTranscriptBlockFinalized()).toBe(true);
			expect(bashLate.isTranscriptBlockFinalized()).toBe(true);
			expect(bashEarly.getTranscriptBlockSettledRows()).toBeGreaterThan(0);
			await shutdown(booted);
		}
	},
);

stockTest(
	"global disable disposes the runtime but keeps the settings command",
	async () => {
		const booted = await bootWithMode("live", { enabled: false });
		// the settings command stays registered even when runtime is disabled
		expect(booted.commands).toContain("compact-settings");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"write",
			{ path: "off.ts", content: "x" },
			"write-off",
		);
		await finishTool(booted, call, {
			toolCallId: "write-off",
			toolName: "write",
			result: { content: [{ type: "text", text: "written" }] },
			isError: false,
		});
		// no adapter: no compact rows, no audit evidence, no timers
		expect(visibleRows(booted.transcript).join("\n")).not.toContain("• write");
		expect(booted.appendedEntries).toEqual([]);
		expect(booted.intervalCallbacks).toEqual([]);
		await shutdown(booted);
	},
);

stockTest(
	"re-enable after a disabled session reinstalls the runtime cleanly",
	async () => {
		const disabled = await bootWithMode("live", { enabled: false });
		await beginRun(disabled);
		expect(disabled.intervalCallbacks).toEqual([]);
		await shutdown(disabled);
		// a fresh session with the runtime enabled reinstalls the adapter
		const enabled = await bootWithTranscript();
		await beginRun(enabled);
		const call = await addTool(
			enabled,
			"bash",
			{ command: "printf reenabled" },
			"bash-re",
		);
		await finishTool(enabled, call, {
			toolCallId: "bash-re",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(visibleRows(enabled.transcript).join("\n")).toContain(
			"bash: printf reenabled",
		);
		await shutdown(enabled);
	},
);

// ---------------------------------------------------------------------------
// RunStats wiring (upgrade2 item 4): authoritative message_end usage,
// tool_execution_start action dedup, and one persisted evidence entry per
// successful terminal run. These contracts boot with stats explicitly
// enabled (the harness default disables it for the pre-stats suites).
// ---------------------------------------------------------------------------

function assistantWithUsage(
	text: string,
	usage: Record<string, number> = {
		input: 100,
		output: 50,
		cacheRead: 200,
		cacheWrite: 30,
	},
	timestamp = 1_700_000_000_000,
	stopReason = "stop",
): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		timestamp,
		usage,
	};
}

async function completeAnswer(
	booted: BootedPlugin,
	text: string,
	usage?: Record<string, number>,
	timestamp?: number,
): Promise<void> {
	await dispatch(booted, {
		type: "message_end",
		message: assistantWithUsage(text, usage, timestamp),
	});
	await finishRun(booted, text);
}

function statsEntries(
	booted: BootedPlugin,
): Array<{ customType: string; data: Record<string, unknown> }> {
	return booted.appendedEntries.filter(
		(entry) =>
			entry.customType === "omp-compact-stats" && entry.data !== undefined,
	) as Array<{ customType: string; data: Record<string, unknown> }>;
}

function bootWithStats(
	mode: "compact" | "live" | "clear" = "live",
	extra: Record<string, unknown> = {},
): Promise<BootedPlugin & { transcript: TranscriptInstance }> {
	return bootWithMode(mode, {
		stats: { ...DEFAULT_SETTINGS.stats, enabled: true },
		...extra,
	});
}

stockTest(
	"stats wiring: message_end usage, action dedup and one evidence entry",
	async () => {
		const booted = await bootWithStats();
		await beginRun(booted);
		// two distinct executions; the second start redelivers the first id
		await addTool(booted, "bash", { command: "printf a" }, "bash-1");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "printf a" },
		});
		const call = await addTool(booted, "read", { path: "/tmp/a.ts" }, "read-2");
		await finishTool(booted, call, {
			toolCallId: "read-2",
			toolName: "read",
			result: { content: [{ type: "text", text: "src" }] },
			isError: false,
		});
		addAnswer(booted, "done");
		await completeAnswer(
			booted,
			"done",
			{ input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
			1_700_000_000_100,
		);
		const stats = statsEntries(booted);
		expect(stats).toHaveLength(1);
		expect(stats[0].data).toMatchObject({
			version: 1,
			actions: 2,
			sent: 100,
			received: 50,
			cacheRead: 200,
			cacheWrite: 30,
			hasError: false,
			messages: 1,
		});
		// the row renders above the answer
		const rows = visibleRows(booted.transcript);
		const line = rows.find((row) => row.includes("2 actions"));
		expect(line).toBeDefined();
		expect(rows.indexOf(line as string)).toBeLessThan(rows.indexOf("done"));
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: persists terminal evidence before async projection drains",
	async () => {
		const booted = await bootWithStats();
		await beginRun(booted);
		addAnswer(booted, "boundary");
		await dispatch(booted, {
			type: "message_end",
			message: assistantWithUsage(
				"boundary",
				{ input: 13, output: 8, cacheRead: 21, cacheWrite: 0 },
				1_700_000_000_150,
			),
		});

		const terminal = dispatchFireAndForget(booted, {
			type: "agent_end",
			messages: [assistant("boundary")],
			willContinue: false,
		});
		// Stock dispatch does not await extension listeners. Durable evidence
		// must already be an ancestor candidate before another user run can
		// enter the session tree; visual placement may still await audit drain.
		expect(statsEntries(booted)).toHaveLength(1);
		expect(statsEntries(booted)[0]?.data).toMatchObject({
			sent: 13,
			received: 8,
			messages: 1,
		});
		expect(
			visibleRows(booted.transcript).some((row) => row.includes("13 sent")),
		).toBe(false);
		// A new agent_start may arrive before the async terminal projection.
		// It must not erase or reclassify run A's already-durable evidence.
		const nextRun = dispatchFireAndForget(booted, { type: "agent_start" });
		expect(statsEntries(booted)[0]?.data).toMatchObject({ sent: 13 });
		await nextRun;
		await terminal;
		expect(statsEntries(booted)).toHaveLength(1);
		expect(
			visibleRows(booted.transcript).some((row) => row.includes("13 sent")),
		).toBe(true);
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: two distinct completions sum usage by message identity",
	async () => {
		const booted = await bootWithStats();
		await beginRun(booted);
		addAnswer(booted, "first");
		await completeAnswer(
			booted,
			"first",
			{ input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
			1_700_000_000_100,
		);
		await beginRun(booted);
		addAnswer(booted, "second");
		// a second, distinct completion with equal usage is NOT fingerprint-deduped
		await completeAnswer(
			booted,
			"second",
			{ input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
			1_700_000_000_200,
		);
		// two consecutive successful runs → two evidence entries
		const stats = statsEntries(booted);
		expect(stats).toHaveLength(2);
		expect(stats[0].data).toMatchObject({ messages: 1, sent: 100 });
		expect(stats[1].data).toMatchObject({ messages: 1, sent: 100 });
		await shutdown(booted);
	},
);

stockTest("stats wiring: message_end without usage is ignored", async () => {
	const booted = await bootWithStats();
	await beginRun(booted);
	addAnswer(booted, "no usage");
	// assistant completions without a usage record (advisor cards, malformed
	// events) must not count as aggregated messages
	await dispatch(booted, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "no usage" }],
			stopReason: "stop",
			timestamp: 1_700_000_000_350,
		},
	});
	await dispatch(booted, {
		type: "message_end",
		message: assistantWithUsage(
			"no usage",
			"garbage" as unknown as Record<string, number>,
			1_700_000_000_351,
		),
	});
	await finishRun(booted, "no usage");
	const stats = statsEntries(booted);
	expect(stats).toHaveLength(1);
	expect(stats[0].data).toMatchObject({ messages: 0, sent: 0 });
	await shutdown(booted);
});

stockTest("stats wiring: zero-valued usage is counted once", async () => {
	const booted = await bootWithStats();
	await beginRun(booted);
	addAnswer(booted, "zero");
	await completeAnswer(
		booted,
		"zero",
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		1_700_000_000_360,
	);
	const stats = statsEntries(booted);
	expect(stats).toHaveLength(1);
	expect(stats[0].data).toMatchObject({
		messages: 1,
		sent: 0,
		received: 0,
		cacheRead: 0,
	});
	await shutdown(booted);
});

stockTest("stats wiring: duplicate completion counts once", async () => {
	const booted = await bootWithStats();
	await beginRun(booted);
	addAnswer(booted, "dup");
	const message = assistantWithUsage(
		"dup",
		{ input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
		1_700_000_000_370,
	);
	await dispatch(booted, { type: "message_end", message });
	// the same settled completion redelivered at the subscription boundary
	await dispatch(booted, { type: "message_end", message });
	await finishRun(booted, "dup");
	const stats = statsEntries(booted);
	expect(stats).toHaveLength(1);
	expect(stats[0].data).toMatchObject({
		messages: 1,
		sent: 100,
		received: 50,
	});
	await shutdown(booted);
});

stockTest(
	"stats wiring: no-tool clear answer still persists and renders the row",
	async () => {
		const booted = await bootWithStats("clear");
		await beginRun(booted);
		addAnswer(booted, "plain");
		await completeAnswer(
			booted,
			"plain",
			{ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
			1_700_000_000_300,
		);
		const stats = statsEntries(booted);
		expect(stats).toHaveLength(1);
		expect(stats[0].data).toMatchObject({ actions: 0, messages: 1, sent: 7 });
		const rows = visibleRows(booted.transcript);
		const line = rows.find((row) => row.includes("0 actions"));
		expect(line).toBeDefined();
		expect(rows.indexOf(line as string)).toBeLessThan(rows.indexOf("plain"));
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: aborted runs persist no stats and pollute no later run",
	async () => {
		const booted = await bootWithStats();
		await beginRun(booted);
		const call = await addTool(booted, "bash", { command: "false" }, "abort-1");
		await finishTool(booted, call, {
			toolCallId: "abort-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "boom" }] },
			isError: true,
		});
		addAnswer(booted, "");
		await dispatch(booted, {
			type: "message_end",
			message: assistantWithUsage("", undefined, 1_700_000_000_400, "aborted"),
		});
		await finishRun(booted, "", "aborted");
		// abort: no answer, no stats row/evidence
		expect(statsEntries(booted)).toEqual([]);
		// the next successful run starts clean: no aborted usage/actions leak
		await beginRun(booted);
		const call2 = await addTool(booted, "bash", { command: "true" }, "ok-2");
		await finishTool(booted, call2, {
			toolCallId: "ok-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "recovered");
		await completeAnswer(
			booted,
			"recovered",
			{ input: 11, output: 4, cacheRead: 0, cacheWrite: 0 },
			1_700_000_000_500,
		);
		const stats = statsEntries(booted);
		expect(stats).toHaveLength(1);
		expect(stats[0].data).toMatchObject({
			actions: 1,
			sent: 11,
			messages: 1,
			hasError: false,
		});
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: failed tool marks the row dirty without blocking it",
	async () => {
		const booted = await bootWithStats();
		await beginRun(booted);
		const call = await addTool(booted, "bash", { command: "false" }, "fail-1");
		await finishTool(booted, call, {
			toolCallId: "fail-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "boom" }] },
			isError: true,
		});
		addAnswer(booted, "still answered");
		await completeAnswer(
			booted,
			"still answered",
			{ input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
			1_700_000_000_600,
		);
		const stats = statsEntries(booted);
		expect(stats).toHaveLength(1);
		expect(stats[0].data).toMatchObject({ actions: 1, hasError: true });
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: disabled stats persist nothing even on success",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		addAnswer(booted, "quiet");
		await completeAnswer(
			booted,
			"quiet",
			{ input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
			1_700_000_000_700,
		);
		expect(booted.appendedEntries).toEqual([]);
		expect(visibleRows(booted.transcript).join("\n")).not.toContain(
			"actions ·",
		);
		await shutdown(booted);
	},
);

stockTest(
	"stats wiring: willContinue continuations produce one row at the answer",
	async () => {
		const booted = await bootWithStats();
		await beginRun(booted);
		await dispatch(booted, {
			type: "message_end",
			message: assistantWithUsage(
				"partial",
				{ input: 40, output: 20, cacheRead: 80, cacheWrite: 0 },
				1_700_000_000_800,
				"toolUse",
			),
		});
		await finishRun(booted, "partial", "toolUse", true);
		// continuation: same logical run keeps accumulating
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf cont" },
			"cont-1",
		);
		await finishTool(booted, call, {
			toolCallId: "cont-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "final");
		await completeAnswer(
			booted,
			"final",
			{ input: 60, output: 30, cacheRead: 120, cacheWrite: 0 },
			1_700_000_000_900,
		);
		const stats = statsEntries(booted);
		expect(stats).toHaveLength(1);
		expect(stats[0].data).toMatchObject({
			actions: 1,
			sent: 100,
			received: 50,
			cacheRead: 200,
			messages: 2,
		});
		await shutdown(booted);
	},
);

// ---------------------------------------------------------------------------
// Per-instance settings store (upgrade2 item 1 hardening): two plugin
// instances in one process must never share settings state.
// ---------------------------------------------------------------------------

stockTest("two plugin instances keep isolated settings snapshots", async () => {
	// instance A boots with compactPaths=false…
	const a = await bootWithMode("live", { compactPaths: false });
	// …then instance B boots with compactPaths=true in the same process
	// (the shared harness config file is rewritten, but each instance's
	// store was created and loaded at its own boot)
	const b = await bootWithTranscript();
	// A's rendering still uses A's snapshot: a module-global store would
	// leak B's settings into A's displayPaths closure
	await beginRun(a);
	await groupedRead(a, "/tmp/iso.ts", "iso-read");
	const live = visibleRows(a.transcript).join("\n");
	expect(live).toContain("• read /tmp/iso.ts");
	expect(live).not.toContain("• read iso.ts");
	await shutdown(a);
	await shutdown(b);
});

// ---------------------------------------------------------------------------
// Host-settings bridge (upgrade2 item 6): the settings menu must open and
// save ordinary plugin options even when no verified live main-session
// Settings instance exists. This stock runtime NEVER initializes the
// exported global `settings` Proxy — it throws "Settings not initialized.
// Call Settings.init() first." on any access — so the plugin must resolve
// host settings through the per-AgentSession instance and, when the live
// main session is unavailable, keep plugin rows savable while host rows are
// visibly unavailable.
// ---------------------------------------------------------------------------

interface MountedDialog {
	handleInput(data: string): void;
	render(width: number): readonly string[];
}

function mountDialog(booted: BootedPlugin): {
	get mounted(): MountedDialog | undefined;
	/** Resolves with the dialog's finished value (saved draft or undefined). */
	result: Promise<unknown>;
} {
	let mounted: MountedDialog | undefined;
	let resolveResult!: (result: unknown) => void;
	// openSettingsDialog awaits the promise `custom` returns; that promise is
	// resolved by the dialog's `done` callback, so sharing it here exposes
	// the dialog result without relying on the (void) command handler.
	const result = new Promise<unknown>((resolve) => {
		resolveResult = resolve;
	});
	booted.context.ui.custom = (async <T>(
		factory: (
			_tui: unknown,
			_theme: unknown,
			_keybindings: unknown,
			done: (result: T) => void,
		) => unknown,
	): Promise<T> => {
		mounted = factory(
			null,
			booted.host.getTheme(),
			{ matches: () => false },
			(result) => resolveResult(result),
		) as MountedDialog;
		return result as Promise<T>;
	}) as never;
	return {
		get mounted() {
			return mounted;
		},
		result,
	};
}

async function waitForDialog(
	mount: ReturnType<typeof mountDialog>,
	timeoutMs = 2_000,
): Promise<MountedDialog> {
	const start = Date.now();
	while (!mount.mounted) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("settings dialog did not mount");
		}
		await Bun.sleep(5);
	}
	return mount.mounted;
}

function pluginConfigPath(): string {
	// Same derivation as bootPlugin: two levels up from the stock .bin dir.
	return stockSettingsPath("test-settings.json");
}

stockTest(
	"settings menu opens with host rows unavailable and saves plugin-only changes when no live session settings exist",
	async () => {
		const booted = await bootWithTranscript();
		const handler = booted.commandHandlers.get("compact-settings");
		expect(handler).toBeDefined();
		const mount = mountDialog(booted);
		const commandDone = handler?.("", booted.context);
		const dialog = await waitForDialog(mount);
		// Host rows render n/a (no live main-session Settings instance): they
		// must never claim success when unavailable.
		const rows = dialog.render(120).map((l) => l.replace(ansiPattern, ""));
		expect(
			rows.some((l) => l.includes("Recap summary") && l.includes("n/a")),
		).toBe(true);
		expect(
			rows.some((l) => l.includes("Thinking blocks") && l.includes("n/a")),
		).toBe(true);
		// Plugin rows stay usable: toggle Global compact and save.
		dialog.handleInput(KEY_SPACE);
		dialog.handleInput("s");
		const saved = await mount.result;
		expect(saved).toMatchObject({ enabled: false });
		await commandDone;
		expect(booted.notifications).toContain("omp-compact settings saved");
		// The plugin JSON persisted the plugin change but left the host
		// preferences untouched.
		const persisted = JSON.parse(
			await Bun.file(pluginConfigPath()).text(),
		) as Record<string, unknown>;
		expect(persisted.enabled).toBe(false);
		expect(persisted.host).toEqual(DEFAULT_SETTINGS.host);
		// Nothing reported the stock global-proxy failure.
		expect(
			booted.notifications.some((n) => n.includes("Settings not initialized")),
		).toBe(false);
		await shutdown(booted);
	},
);

stockTest(
	"settings menu cancel writes nothing when host settings are unavailable",
	async () => {
		const booted = await bootWithTranscript();
		const handler = booted.commandHandlers.get("compact-settings");
		expect(handler).toBeDefined();
		const before = await Bun.file(pluginConfigPath()).text();
		const mount = mountDialog(booted);
		const commandDone = handler?.("", booted.context);
		const dialog = await waitForDialog(mount);
		dialog.handleInput(KEY_ESCAPE);
		const saved = await mount.result;
		expect(saved).toBeUndefined();
		await commandDone;
		expect(await Bun.file(pluginConfigPath()).text()).toBe(before);
		expect(booted.notifications).not.toContain("omp-compact settings saved");
		await shutdown(booted);
	},
);

// ---------------------------------------------------------------------------
// Env-override honesty on save (E01): with a hard env override in force the
// save still succeeds and persists the requested values, and exactly ONE
// notification carries both facts — the save and the effective value that
// stays in force. Never a warning plus a generic success that implies the
// saved value took effect.
// ---------------------------------------------------------------------------

stockTest(
	"settings save emits one notification when a hard env override masks the saved values",
	async () => {
		const previousMode = Bun.env.OMP_COMPACT_MODE;
		const previousPlugin = Bun.env.OMP_COMPACT_PLUGIN;
		Bun.env.OMP_COMPACT_PLUGIN = "0";
		delete Bun.env.OMP_COMPACT_MODE;
		try {
			const booted = await bootWithTranscript();
			const handler = booted.commandHandlers.get("compact-settings");
			expect(handler).toBeDefined();
			const mount = mountDialog(booted);
			const commandDone = handler?.("", booted.context);
			const dialog = await waitForDialog(mount);
			// The effective snapshot shows the override: Global compact off.
			const rows = dialog.render(120).map((l) => l.replace(ansiPattern, ""));
			expect(
				rows.some((l) => l.includes("Global compact") && l.includes("off")),
			).toBe(true);
			// Ask to re-enable: the save succeeds and persists the requested
			// value, and one notification carries both facts (saved +
			// effective) — the saved value cannot take effect while
			// OMP_COMPACT_PLUGIN=0 is set.
			dialog.handleInput(KEY_SPACE);
			dialog.handleInput("s");
			const saved = await mount.result;
			expect(saved).toMatchObject({ enabled: true });
			await commandDone;
			// Exactly one success-prefixed notification, no separate warning
			// and no generic success pretending the value took effect.
			const successLines = booted.notifications.filter((n) =>
				n.startsWith("omp-compact settings saved"),
			);
			expect(successLines).toHaveLength(1);
			expect(successLines[0]).toBe(
				"omp-compact settings saved; effective enabled remains false because OMP_COMPACT_PLUGIN=0",
			);
			expect(
				booted.notifications.filter((n) => n.includes("OMP_COMPACT_PLUGIN")),
			).toHaveLength(1);
			const persisted = JSON.parse(
				await Bun.file(pluginConfigPath()).text(),
			) as Record<string, unknown>;
			expect(persisted.enabled).toBe(true);
			await shutdown(booted);
		} finally {
			if (previousMode === undefined) delete Bun.env.OMP_COMPACT_MODE;
			else Bun.env.OMP_COMPACT_MODE = previousMode;
			if (previousPlugin === undefined) delete Bun.env.OMP_COMPACT_PLUGIN;
			else Bun.env.OMP_COMPACT_PLUGIN = previousPlugin;
		}
	},
);

// ---------------------------------------------------------------------------
// Legacy env contract (pre-upgrade shipped behavior): OMP_COMPACT_MODE=off
// hard-disables the runtime while the settings command stays registered.
// ---------------------------------------------------------------------------

stockTest("legacy OMP_COMPACT_MODE=off hard-disables the runtime", async () => {
	const previousMode = Bun.env.OMP_COMPACT_MODE;
	const previousPlugin = Bun.env.OMP_COMPACT_PLUGIN;
	Bun.env.OMP_COMPACT_MODE = "off";
	delete Bun.env.OMP_COMPACT_PLUGIN;
	try {
		const booted = await bootWithTranscript();
		// the settings command stays registered regardless
		expect(booted.commands).toContain("compact-settings");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf off" },
			"legacy-off",
		);
		await finishTool(booted, call, {
			toolCallId: "legacy-off",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		// no adapter: no compact rows, no evidence, no timers
		expect(visibleRows(booted.transcript).join("\n")).not.toContain("bash:");
		expect(booted.appendedEntries).toEqual([]);
		expect(booted.intervalCallbacks).toEqual([]);
		await shutdown(booted);
	} finally {
		if (previousMode === undefined) delete Bun.env.OMP_COMPACT_MODE;
		else Bun.env.OMP_COMPACT_MODE = previousMode;
		if (previousPlugin === undefined) delete Bun.env.OMP_COMPACT_PLUGIN;
		else Bun.env.OMP_COMPACT_PLUGIN = previousPlugin;
	}
});

// ---------------------------------------------------------------------------
// AdapterFailOpenFix: host-probe / adapter bring-up failures must never
// escape into the event stream. `ensureAdapter` runs capture/construct/
// install as one transaction: any setWidget/constructor exception restores
// partial own-instance effects, disables the adapter for the session, warns
// once through the UI notification seam, and never retries per event. Only
// a session boundary (switch/shutdown -> dispose) resets the disable state.
// Headless root absence (no setWidget) stays a quiet fail-open.
// ---------------------------------------------------------------------------

/**
 * setWidget fake that tracks probe registrations and lets the test decide
 * where to fail. Registration invokes the probe callback against `root`
 * (mirroring the stock harness) and records the key; removal forgets it.
 */
function trackingSetWidget(
	booted: Pick<BootedPlugin, "root">,
	widgets: Set<string>,
	fail: (key: string, content: unknown) => void,
): BootedPlugin["context"]["ui"]["setWidget"] {
	return (key, content) => {
		if (content === undefined) {
			widgets.delete(key);
			fail(key, content);
			return;
		}
		widgets.add(key);
		if (typeof content === "function") {
			(content as (tui: unknown) => Renderable)(booted.root);
		}
		fail(key, content);
	};
}

stockTest(
	"setWidget probe registration failure fails open: disabled, warned once, never retried",
	async () => {
		const booted = await bootWithTranscript();
		// Fail the probe on the reinstall: the host accepts the widget and
		// then throws, so a leftover registration would be an own-instance
		// leak the guard must roll back.
		const widgets = new Set<string>();
		booted.context.ui.setWidget = trackingSetWidget(
			booted,
			widgets,
			(_key, content) => {
				if (typeof content !== "function") return;
				throw new Error("setWidget registration failed");
			},
		);
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		// contained: exactly one warning, no probe left behind, no reinstall
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		expect(widgets.size).toBe(0);
		expect(booted.intervalCallbacks).toHaveLength(1);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		// every later event retries nothing and stays quiet
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "after-probe-failure",
			toolName: "bash",
			args: { command: "printf nope" },
		});
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "after-probe-failure",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(booted.notifications).toHaveLength(1);
		expect(booted.appendedEntries).toEqual([]);
		expect(booted.sentMessages).toEqual([]);
		expect(widgets.size).toBe(0);
		await shutdown(booted);
	},
);

stockTest(
	"setWidget probe removal failure is rolled back and disables once",
	async () => {
		const booted = await bootWithTranscript();
		const widgets = new Set<string>();
		let removals = 0;
		booted.context.ui.setWidget = trackingSetWidget(
			booted,
			widgets,
			(_key, content) => {
				if (content !== undefined) return;
				removals++;
				if (removals === 1) throw new Error("setWidget removal failed");
			},
		);
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		// the guard re-attempts removal during rollback: no probe widget
		// lingers even though the host's first removal call threw
		expect(removals).toBe(2);
		expect(widgets.size).toBe(0);
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		expect(booted.intervalCallbacks).toHaveLength(1);
		// disabled for the rest of the session: no retry, no second warning
		await beginRun(booted);
		expect(booted.notifications).toHaveLength(1);
		await shutdown(booted);
	},
);

stockTest(
	"adapter construction failure (throwing ui.theme getter) fails open once",
	async () => {
		const booted = await bootWithTranscript();
		// The probe succeeds; the failure surfaces while the adapter options
		// are evaluated (adapterUI reads context.ui.theme), i.e. inside the
		// construction phase of ensureAdapter.
		Object.defineProperty(booted.context.ui, "theme", {
			configurable: true,
			get() {
				throw new Error("theme unavailable");
			},
		});
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		expect(booted.notifications[0]).toContain("theme unavailable");
		expect(booted.intervalCallbacks).toHaveLength(1);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		await beginRun(booted);
		expect(booted.notifications).toHaveLength(1);
		await shutdown(booted);
	},
);

stockTest(
	"session switch resets the adapter-disable state for the next session",
	async () => {
		const booted = await bootWithTranscript();
		const widgets = new Set<string>();
		const workingSetWidget = booted.context.ui.setWidget;
		booted.context.ui.setWidget = trackingSetWidget(
			booted,
			widgets,
			(_key, content) => {
				if (typeof content !== "function") return;
				throw new Error("setWidget registration failed");
			},
		);
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		expect(booted.notifications).toHaveLength(1);
		expect(booted.intervalCallbacks).toHaveLength(1);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		// the host heals; a session boundary resets the disable state
		booted.context.ui.setWidget = workingSetWidget;
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		expect(booted.intervalCallbacks).toHaveLength(2);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(true);
		// the reinstalled adapter is fully functional
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf healed" },
			"healed",
		);
		await finishTool(booted, call, {
			toolCallId: "healed",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"printf healed",
		);
		// the failed session's single warning is the only notification
		expect(booted.notifications).toHaveLength(1);
		await shutdown(booted);
	},
);

stockTest(
	"headless root absence (no setWidget) stays a quiet fail-open",
	async () => {
		const booted = await bootWithTranscript();
		booted.context.ui.setWidget =
			undefined as unknown as BootedPlugin["context"]["ui"]["setWidget"];
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		expect(booted.notifications).toEqual([]);
		expect(booted.intervalCallbacks).toHaveLength(1);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		await beginRun(booted);
		expect(booted.notifications).toEqual([]);
		await shutdown(booted);
	},
);

stockTest(
	"a late agent-end drain after session dispose never touches the reinstalled adapter",
	async () => {
		const cwd = "/tmp/omp-compact-race-latedrain";
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		let transcript: TranscriptInstance | undefined;
		const booted = await bootPlugin(
			(root, host) => {
				transcript = new host.TranscriptContainer();
				root.addChild(transcript);
			},
			cwd,
			[],
			false,
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: true },
			},
		);
		if (!transcript) throw new Error("transcript missing");
		const bootedWithTranscript = { ...booted, transcript };
		await beginRun(bootedWithTranscript);
		// The write audit capture stays in flight while a terminal agent_end
		// queues its drain link; the session then switches before the drain
		// can settle (the same race the audit lifecycle generation guard
		// owns, now pinned for the stats seam).
		const toolCallId = "write-late-drain";
		const startPromise = dispatchFireAndForget(bootedWithTranscript, {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		});
		addToolComponent(
			bootedWithTranscript,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			toolCallId,
		);
		const drain = dispatchFireAndForget(bootedWithTranscript, {
			type: "agent_end",
			messages: [assistant("done")],
			willContinue: false,
		});
		await dispatch(bootedWithTranscript, { type: "session_before_switch" });
		await dispatch(bootedWithTranscript, { type: "session_start" });
		// The reinstalled adapter is live and owns a fresh run id sequence.
		await beginRun(bootedWithTranscript);
		const healed = await addTool(
			bootedWithTranscript,
			"bash",
			{ command: "printf healed" },
			"healed",
		);
		await finishTool(bootedWithTranscript, healed, {
			toolCallId: "healed",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		// Settle the old session's in-flight write and its queued drain: the
		// late callback must not render the old run's stats row on the new
		// adapter (or throw), and the new run renders normally.
		await startPromise;
		await dispatchFireAndForget(bootedWithTranscript, {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: {},
			},
			isError: false,
		});
		await drain;
		const rows = visibleRows(bootedWithTranscript.transcript).join("\n");
		expect(rows).toContain("printf healed");
		expect(rows).not.toContain("sent");
		expect(rows).not.toContain("actions");
		await shutdown(bootedWithTranscript);
		await rm(cwd, { recursive: true, force: true });
	},
);

// ---------------------------------------------------------------------------
// PostTurnShake wiring (upgrade2 item 5): the runtime gate is frozen exactly
// once at the true logical-run boundary. A globally disabled run explicitly
// disarms shake even if the prior run was armed or OMP_COMPACT_SHAKE=1;
// continuation agent_start never re-snapshots settings; agent_end shakes only
// runs whose frozen global-enabled snapshot is true. The shake probe injects
// the real registry seam (pi.pi.AgentRegistry) with a fake live main session,
// so every native dispatch is observable end to end.
// ---------------------------------------------------------------------------

interface ShakeProbe {
	calls: Array<{ mode: string; aborted: boolean }>;
	sessionManager: { getBranch(): readonly unknown[] };
	registry: unknown;
}

function shakeProbe(): ShakeProbe {
	const sessionManager = { getBranch: () => [] as readonly unknown[] };
	const calls: Array<{ mode: string; aborted: boolean }> = [];
	const session = {
		sessionManager,
		async shake(mode: string, opts?: { signal?: AbortSignal }) {
			calls.push({ mode, aborted: opts?.signal?.aborted ?? false });
			return {
				mode,
				toolResultsDropped: 1,
				blocksDropped: 1,
				tokensFreed: 1_000,
			};
		},
	};
	const registry = {
		global: () => ({
			get: (id: string) =>
				id === "Main"
					? { id, kind: "main", status: "idle", session }
					: undefined,
		}),
	};
	return { calls, sessionManager, registry };
}

/** Drain the fire-and-forget shake chain queued after an awaited agent_end. */
async function drainShake(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function bootWithShake(
	settings: Record<string, unknown>,
	probe = shakeProbe(),
): Promise<
	BootedPlugin & { transcript: TranscriptInstance; probe: ShakeProbe }
> {
	let transcript: TranscriptInstance | undefined;
	return bootPlugin(
		(root, host) => {
			transcript = new host.TranscriptContainer();
			root.addChild(transcript);
		},
		"/tmp",
		[],
		false,
		settings,
		{
			piPi: { AgentRegistry: probe.registry },
			sessionManager: probe.sessionManager,
		},
	).then((booted) => {
		if (!transcript) throw new Error("transcript missing");
		return { ...booted, transcript, probe };
	});
}

/**
 * Open the real /compact-settings dialog through the command handler and
 * drive it: `edit` changes the focused draft (Global compact is the first
 * focusable row), then save persists through saveSettingsFlow →
 * store.update(), exactly the path a user uses to change settings
 * mid-session (store snapshot and ModePolicy both refresh).
 */
async function saveSettingsViaDialog(
	booted: BootedPlugin,
	edit: (dialog: { handleInput(data: string): void }) => void,
): Promise<void> {
	const handler = booted.commandHandlers.get("compact-settings");
	if (!handler) throw new Error("compact-settings command not registered");
	const pending = handler("", booted.context);
	// The command handler reloads the store from disk before opening the
	// dialog, so the NEW dialog instance appears after real I/O settles.
	// Key the wait on dialog-count growth: an earlier save may already
	// have opened a dialog.
	const before = booted.dialogs.length;
	for (let i = 0; i < 10 && booted.dialogs.length <= before; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const dialog = booted.dialogs[booted.dialogs.length - 1];
	if (!dialog || booted.dialogs.length <= before) {
		throw new Error("settings dialog did not open");
	}
	edit(dialog);
	// The dialog binds the save action to the literal "s" key (stock TUI
	// keybinding); save persists through saveSettingsFlow → store.update().
	dialog.handleInput("s");
	await dialog.settled();
	await pending;
}

stockTest(
	"auto-shake: a globally disabled next run explicitly disarms shake armed by the prior run",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		// Run 1 starts ARMED but settles without shaking (aborted terminal
		// end): the once-per-run guard is still open, so the run's arming
		// must not survive into the next run.
		await beginRun(booted);
		await finishRun(booted, "", "aborted");
		await drainShake();
		expect(probe.calls).toEqual([]);

		// mid-session settings dialog: flip global mode off (real store
		// update path, so the next boundary sees the disable).
		await saveSettingsViaDialog(booted, (dialog) => {
			dialog.handleInput(KEY_SPACE);
		});

		// Next run boundary is globally disabled: the run must explicitly
		// disarm, so its terminal answer shakes nothing — even though the
		// prior run was armed and never shook.
		await beginRun(booted);
		await finishRun(booted, "done");
		await drainShake();
		expect(probe.calls).toEqual([]);
		await shutdown(booted);
	},
);

stockTest(
	"auto-shake: continuation agent_start never re-snapshots auto-shake settings changed mid-run",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		// the logical run starts armed…
		await beginRun(booted);
		// …a toolUse continuation keeps the run open…
		await finishRun(booted, "working", "toolUse");
		// …then the user turns auto-shake OFF mid-run (fifth focusable row:
		// Global compact, Mode, Compact paths, Retain Git rows, Auto-shake).
		await saveSettingsViaDialog(booted, (dialog) => {
			for (let i = 0; i < 4; i++) dialog.handleInput(KEY_DOWN);
			dialog.handleInput(KEY_SPACE);
		});
		// The continuation boundary must not observe the mid-run change:
		// no re-snapshot, no re-arm, no disarm of the frozen run — the
		// terminal answer of the frozen run still shakes exactly once.
		await beginRun(booted);
		await finishRun(booted, "final");
		await drainShake();
		expect(probe.calls).toHaveLength(1);
		expect(probe.calls[0]?.mode).toBe("elide");
		// The NEXT boundary observes the disable: no second shake.
		await beginRun(booted);
		await finishRun(booted, "after");
		await drainShake();
		expect(probe.calls).toHaveLength(1);
		await shutdown(booted);
	},
);

stockTest(
	"auto-shake: OMP_COMPACT_SHAKE=1 cannot re-arm a globally disabled run",
	async () => {
		const previous = Bun.env.OMP_COMPACT_SHAKE;
		Bun.env.OMP_COMPACT_SHAKE = "1";
		try {
			const probe = shakeProbe();
			const booted = await bootWithShake(
				{
					...DEFAULT_SETTINGS,
					enabled: false,
					stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
					autoShake: { enabled: true, thresholdTokens: 0 },
				},
				probe,
			);
			// The env force is resolved only for globally enabled runs: a
			// globally disabled run shakes nothing, even with SHAKE=1.
			await beginRun(booted);
			await finishRun(booted, "off");
			await drainShake();
			expect(probe.calls).toEqual([]);
			// Re-enable at the next boundary: SHAKE=1 forces shake on.
			await saveSettingsViaDialog(booted, (dialog) => {
				dialog.handleInput(KEY_SPACE);
			});
			await beginRun(booted);
			await finishRun(booted, "on");
			await drainShake();
			expect(probe.calls).toHaveLength(1);
			expect(probe.calls[0]?.mode).toBe("elide");
			// Disable again while SHAKE=1 still forces: the disabled boundary
			// explicitly disarms and the env force cannot re-arm it.
			await saveSettingsViaDialog(booted, (dialog) => {
				dialog.handleInput(KEY_SPACE);
			});
			await beginRun(booted);
			await finishRun(booted, "off-again");
			await drainShake();
			expect(probe.calls).toHaveLength(1);
			await shutdown(booted);
		} finally {
			if (previous === undefined) delete Bun.env.OMP_COMPACT_SHAKE;
			else Bun.env.OMP_COMPACT_SHAKE = previous;
		}
	},
);

stockTest(
	"auto-shake: re-enable at the next run boundary re-arms shake",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				enabled: false,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		await beginRun(booted);
		await finishRun(booted, "off");
		await drainShake();
		expect(probe.calls).toEqual([]);

		await saveSettingsViaDialog(booted, (dialog) => {
			dialog.handleInput(KEY_SPACE);
		});
		await beginRun(booted);
		await finishRun(booted, "on");
		await drainShake();
		expect(probe.calls).toHaveLength(1);
		expect(probe.calls[0]?.mode).toBe("elide");
		await shutdown(booted);
	},
);

stockTest(
	"auto-shake: session switch resets run state and the new session shakes fresh",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		await beginRun(booted);
		await finishRun(booted, "first");
		await drainShake();
		expect(probe.calls).toHaveLength(1);

		// Session switch: dispose drops the frozen snapshot, run state, and
		// any in-flight shake; the new session re-arms at its own boundary.
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		await beginRun(booted);
		await finishRun(booted, "second");
		await drainShake();
		expect(probe.calls).toHaveLength(2);
		await shutdown(booted);
	},
);

// ---------------------------------------------------------------------------
// E05 success feedback (auto-shake confirmation): a successfully resolved
// native shake shows the stock-format one-liner through the ephemeral UI
// notification (`ctx.ui.notify(message, "info")`), exactly once, and never
// as an appended session/custom entry. Skip/error paths stay silent.
// ---------------------------------------------------------------------------

stockTest(
	"auto-shake: a successful shake shows the stock-format ephemeral confirmation once",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		await beginRun(booted);
		await finishRun(booted, "done");
		await drainShake();
		expect(probe.calls).toHaveLength(1);
		// E05: the actual ShakeResult (1 tool result + 1 block, 1000 tokens)
		// is formatted exactly like stock formatShakeSummary and delivered
		// through the ephemeral notify path — the session gets no new leaf.
		expect(booted.notifications).toEqual([
			"Shook 1 tool result + 1 block (~1000 tokens freed).",
		]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);
	},
);

stockTest(
	"auto-shake: skipped and errored runs never show the confirmation",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		await beginRun(booted);
		// An aborted run is not a visible successful answer: no shake
		// dispatch and no success confirmation.
		await finishRun(booted, "", "aborted");
		await drainShake();
		expect(probe.calls).toEqual([]);
		expect(booted.notifications).toEqual([]);
		await shutdown(booted);
	},
);

// ---------------------------------------------------------------------------
// C01–C09 transcript reconstruction lifecycle: an exact stock
// `TranscriptContainer.clear()` followed by reconstructed component
// instances with identical toolCallIds must re-apply the current
// compact/live/clear policy without restart/reopen. The clear wrapper
// preserves active working ownership, retires stale historical bindings,
// rehydrates the authoritative current branch (identity-matched
// sessionManager resolver), and schedules one generation-guarded microtask
// that replays committed scrollback through the optional exact-root
// `resetDisplay` (fail-open when absent). Tests assert observable rows and
// reset/clear call counts — never private maps.
// ---------------------------------------------------------------------------

interface RebuildHarness {
	branch: { current: readonly unknown[] };
	resetCalls: number;
	clears: number;
	originalClear: (() => void) | undefined;
}

function rebuildHarness(): RebuildHarness {
	return {
		branch: { current: [] },
		resetCalls: 0,
		clears: 0,
		originalClear: undefined,
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function bootForRebuild(
	mode: "compact" | "live" | "clear" = "compact",
	harness = rebuildHarness(),
	withChildren?: (transcript: TranscriptInstance, host: HostModules) => void,
): Promise<
	BootedPlugin & {
		transcript: TranscriptInstance;
		harness: RebuildHarness;
	}
> {
	let transcript: TranscriptInstance | undefined;
	const booted = await bootPlugin(
		(root, host) => {
			// Exact-root capability for the optional full scrollback replay
			// (C07): the adapter probes `resetDisplay` and calls it only
			// after validated mapping.
			(root as { resetDisplay?: () => void }).resetDisplay = () => {
				harness.resetCalls++;
			};
			const candidate = new host.TranscriptContainer();
			// Observable native clear boundary: the adapter wraps this exact
			// instance method; count every native clear invocation.
			const nativeClear = candidate.clear.bind(candidate);
			harness.originalClear = () => {
				harness.clears++;
				nativeClear();
			};
			candidate.clear = harness.originalClear;
			transcript = candidate;
			root.addChild(candidate);
			withChildren?.(candidate, host);
		},
		"/tmp",
		[],
		false,
		{ ...DEFAULT_SETTINGS, mode },
		{ sessionManager: { getBranch: () => harness.branch.current } },
	);
	if (!transcript) throw new Error("transcript missing");
	return { ...booted, transcript, harness };
}

function committedSingleToolBranch(
	command: string,
	toolCallId: string,
	answer: string,
	extra: readonly unknown[] = [],
): readonly unknown[] {
	return [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "work" }] },
		},
		{
			type: "custom",
			customType: "tool_execution_start",
			data: { toolCallId, toolName: "bash", args: { command } },
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
		},
		...extra,
		{ type: "message", message: assistant(answer) },
	];
}

function interleavedGroupedReadBranch(answer: string): readonly unknown[] {
	return [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "work" }] },
		},
		{
			type: "custom",
			customType: "tool_execution_start",
			data: {
				toolCallId: "read-first",
				toolName: "read",
				args: { path: "src/first.ts" },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "read-first",
				toolName: "read",
				content: [{ type: "text", text: "first" }],
				isError: false,
			},
		},
		{
			type: "custom",
			customType: "tool_execution_start",
			data: {
				toolCallId: "between",
				toolName: "bash",
				args: { command: "printf between" },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "between",
				toolName: "bash",
				content: [{ type: "text", text: "between" }],
				isError: false,
			},
		},
		{
			type: "custom",
			customType: "tool_execution_start",
			data: {
				toolCallId: "read-last",
				toolName: "read",
				args: { path: "src/last.ts" },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "read-last",
				toolName: "read",
				content: [{ type: "text", text: "last" }],
				isError: false,
			},
		},
		{ type: "message", message: assistant(answer) },
	];
}

stockTest(
	"resumed session replays committed startup rows once through the exact-root resetDisplay",
	async () => {
		const harness = rebuildHarness();
		harness.branch.current = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "keep" }] },
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "write-1",
					toolName: "write",
					args: { path: "/tmp/resume.ts", content: "ok" },
				},
			},
			{
				type: "custom",
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId: "write-1",
					toolName: "write",
					path: "/tmp/resume.ts",
					added: 2,
					removed: 1,
					exact: true,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "write-1",
					toolName: "write",
					content: [{ type: "text", text: "done" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("resume done") },
		];
		const booted = await bootForRebuild(
			"compact",
			harness,
			(transcript, host) => {
				// stock resume already reconstructed the instances with the
				// identical toolCallIds before session_start hydrates
				const call = new host.ToolExecutionComponent(
					"write",
					{ path: "/tmp/resume.ts", content: "ok" },
					{ showImages: false, useBuiltInRenderer: true },
					fakeTool("write"),
					toolUi(),
					"/tmp",
					"write-1",
				);
				transcript.addChild(call);
				const ContainerBase = Object.getPrototypeOf(
					host.ReadToolGroupComponent.prototype,
				).constructor as BootedPlugin["ContainerBase"];
				const reply = new ContainerBase();
				reply.addChild({ render: () => ["resume done"] });
				transcript.addChild(reply);
			},
		);
		// hydration completed synchronously; the single generation microtask
		// validated the mapping and replayed exactly once
		expect(booted.harness.resetCalls).toBe(1);
		expect(booted.harness.clears).toBe(0);
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: resume.ts");
		expect(rows).toContain("+2|1");
		expect(rows).toContain("resume done");
		await shutdown(booted);
	},
);

stockTest(
	"process restore presents the historical transcript in compact view under live persisted settings",
	async () => {
		const harness = rebuildHarness();
		harness.branch.current = committedSingleToolBranch(
			"printf routine",
			"bash-r1",
			"restored done",
		);
		const booted = await bootForRebuild("live", harness, (transcript, host) => {
			// stock resume already reconstructed the instances with the
			// identical toolCallIds before session_start hydrates
			const call = new host.ToolExecutionComponent(
				"bash",
				{ command: "printf routine" },
				{ showImages: false, useBuiltInRenderer: true },
				fakeTool("bash"),
				toolUi(),
				"/tmp",
				"bash-r1",
			);
			call.updateResult(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				false,
				"bash-r1",
			);
			transcript.addChild(call);
			const ContainerBase = Object.getPrototypeOf(
				host.ReadToolGroupComponent.prototype,
			).constructor as BootedPlugin["ContainerBase"];
			const reply = new ContainerBase();
			reply.addChild({ render: () => ["restored done"] });
			transcript.addChild(reply);
		});
		// entering the existing session armed the one-shot restore override:
		// the routine bash row is retained (compact) even though the
		// persisted mode stays live
		expect(booted.harness.resetCalls).toBe(1);
		expect(booted.harness.clears).toBe(0);
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("bash: printf routine");
		expect(rows).toContain("restored done");
		await shutdown(booted);
	},
);

stockTest(
	"the live run after a process restore keeps the persisted live mode while restored history stays compact",
	async () => {
		const harness = rebuildHarness();
		harness.branch.current = committedSingleToolBranch(
			"printf routine",
			"bash-r1",
			"restored done",
		);
		const booted = await bootForRebuild("live", harness, (transcript, host) => {
			const call = new host.ToolExecutionComponent(
				"bash",
				{ command: "printf routine" },
				{ showImages: false, useBuiltInRenderer: true },
				fakeTool("bash"),
				toolUi(),
				"/tmp",
				"bash-r1",
			);
			call.updateResult(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				false,
				"bash-r1",
			);
			transcript.addChild(call);
			const ContainerBase = Object.getPrototypeOf(
				host.ReadToolGroupComponent.prototype,
			).constructor as BootedPlugin["ContainerBase"];
			const reply = new ContainerBase();
			reply.addChild({ render: () => ["restored done"] });
			transcript.addChild(reply);
		});
		// the restored history froze compact…
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf routine",
		);
		// …and the next live run re-arms the persisted live policy
		await beginRun(booted);
		const next = await addTool(
			booted,
			"bash",
			{ command: "printf next" },
			"bash-r2",
		);
		await finishTool(booted, next, {
			toolCallId: "bash-r2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "next done");
		await finishRun(booted, "next done");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("bash: printf routine");
		expect(rows).toContain("next done");
		expect(rows).not.toContain("printf next");
		await shutdown(booted);
	},
);

stockTest(
	"in-process /resume re-applies compact view to the restored transcript and the next live run keeps the persisted mode",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		// a brand-new session hydrates nothing and replays nothing
		expect(booted.harness.resetCalls).toBe(0);
		// stock switchSession emits the before/after events, then the caller
		// rebuilds the transcript (exact clear + reconstructed instances)
		harness.branch.current = committedSingleToolBranch(
			"printf first",
			"bash-1",
			"first done",
		);
		await dispatch(booted, { type: "session_before_switch", reason: "resume" });
		await dispatch(booted, { type: "session_switch", reason: "resume" });
		booted.transcript.clear();
		expect(booted.harness.clears).toBe(1);
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		rebuilt.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-1",
		);
		addAnswer(booted, "first done");
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("bash: printf first");
		expect(rows).toContain("first done");
		// exactly one full replay for the resumed generation
		expect(booted.harness.resetCalls).toBe(1);
		// the next live run keeps the persisted live mode
		await beginRun(booted);
		const next = await addTool(
			booted,
			"bash",
			{ command: "printf next" },
			"bash-2",
		);
		await finishTool(booted, next, {
			toolCallId: "bash-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "next done");
		await finishRun(booted, "next done");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("bash: printf first");
		expect(live).not.toContain("printf next");
		await shutdown(booted);
	},
);

stockTest(
	"session_switch with reason new does not re-arm the restore view",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		await dispatch(booted, { type: "session_before_switch", reason: "new" });
		await dispatch(booted, { type: "session_switch", reason: "new" });
		// the adapter stays disposed after the switch; a transcript rebuild
		// is pure stock (no fold, no compact rows, no replay)
		harness.branch.current = committedSingleToolBranch(
			"printf ghost",
			"bash-1",
			"ghost done",
		);
		booted.transcript.clear();
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf ghost" },
			"bash-1",
		);
		rebuilt.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-1",
		);
		addAnswer(booted, "ghost done");
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("bash: printf ghost");
		expect(booted.harness.resetCalls).toBe(0);
		await shutdown(booted);
	},
);

stockTest(
	"fork and handoff session switches do not force compact on the transcript",
	async () => {
		for (const reason of ["fork", "handoff"]) {
			const harness = rebuildHarness();
			const booted = await bootForRebuild("live", harness);
			await dispatch(booted, { type: "session_before_switch", reason });
			await dispatch(booted, { type: "session_switch", reason });
			harness.branch.current = committedSingleToolBranch(
				"printf ghost",
				"bash-1",
				"ghost done",
			);
			booted.transcript.clear();
			const rebuilt = addToolComponent(
				booted,
				"bash",
				{ command: "printf ghost" },
				"bash-1",
			);
			rebuilt.updateResult(
				{ content: [{ type: "text", text: "ok" }] },
				false,
				"bash-1",
			);
			addAnswer(booted, "ghost done");
			await flushMicrotasks();
			const rows = visibleRows(booted.transcript).join("\n");
			expect(rows).not.toContain("bash: printf ghost");
			expect(booted.harness.resetCalls).toBe(0);
			await shutdown(booted);
		}
	},
);

stockTest(
	"a brand-new session keeps the persisted live policy with no restore replay",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		expect(booted.harness.resetCalls).toBe(0);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf fresh" },
			"bash-1",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "fresh done");
		await finishRun(booted, "fresh done");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("printf fresh");
		await shutdown(booted);
	},
);

stockTest(
	"tree-like rebuild with identical toolCallIds reapplies compact policy and keeps the next live run working",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "first done");
		await finishRun(booted, "first done");
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf first",
		);
		// the authoritative branch now holds the committed run
		booted.harness.branch.current = committedSingleToolBranch(
			"printf first",
			"bash-1",
			"first done",
		);
		// stock rebuild: exact clear + reconstructed instances with the
		// identical toolCallIds
		booted.transcript.clear();
		expect(booted.harness.clears).toBe(1);
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		rebuilt.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-1",
		);
		addAnswer(booted, "first done");
		await flushMicrotasks();
		const rebuiltRows = visibleRows(booted.transcript).join("\n");
		expect(rebuiltRows).toContain("bash: printf first");
		expect(rebuiltRows).toContain("first done");
		// the retired instance is fully unwrapped (no stale strong refs)
		expect(Object.hasOwn(call, "render")).toBe(false);
		// exactly one full replay for this generation
		expect(booted.harness.resetCalls).toBe(1);
		// the next live run works against the rebuilt prefix
		await beginRun(booted);
		const next = await addTool(
			booted,
			"bash",
			{ command: "printf next" },
			"bash-2",
		);
		const liveRows = visibleRows(booted.transcript).join("\n");
		expect(liveRows).toContain("bash: printf next");
		expect(liveRows).toContain("bash: printf first");
		await finishTool(booted, next, {
			toolCallId: "bash-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "next done");
		await finishRun(booted, "next done");
		const terminalRows = visibleRows(booted.transcript).join("\n");
		expect(terminalRows).toContain("bash: printf next");
		expect(terminalRows).toContain("bash: printf first");
		expect(terminalRows).toContain("next done");
		await shutdown(booted);
	},
);

stockTest(
	"shake-like branch rewrite applies the current live policy to the rebuilt prefix and the new suffix",
	async () => {
		const booted = await bootForRebuild("live");
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		await finishTool(booted, first, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		const second = await addTool(
			booted,
			"bash",
			{ command: "printf second" },
			"bash-2",
		);
		await finishTool(booted, second, {
			toolCallId: "bash-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "shake done");
		await finishRun(booted, "shake done");
		// live terminal: routine tools are filtered out
		expect(visibleRows(booted.transcript).join("\n")).not.toContain("printf");
		// shake elides the branch down to the surviving tool result
		booted.harness.branch.current = committedSingleToolBranch(
			"printf first",
			"bash-1",
			"shake done",
		);
		booted.transcript.clear();
		expect(booted.harness.clears).toBe(1);
		addToolComponent(booted, "bash", { command: "printf first" }, "bash-1");
		addAnswer(booted, "shake done");
		await flushMicrotasks();
		const rebuilt = visibleRows(booted.transcript).join("\n");
		// the rebuilt historical prefix follows the current live policy
		expect(rebuilt).not.toContain("printf first");
		expect(rebuilt).toContain("shake done");
		// the new live suffix renders compact and settles filtered too
		await beginRun(booted);
		const third = await addTool(
			booted,
			"bash",
			{ command: "printf third" },
			"bash-3",
		);
		const working = visibleRows(booted.transcript).join("\n");
		expect(working).toContain("bash: printf third");
		await finishTool(booted, third, {
			toolCallId: "bash-3",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "third done");
		await finishRun(booted, "third done");
		const settled = visibleRows(booted.transcript).join("\n");
		expect(settled).not.toContain("printf third");
		expect(settled).toContain("third done");
		await shutdown(booted);
	},
);

stockTest(
	"shake rebuild filters a grouped read when interleaved tools split replay segments",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		harness.branch.current = interleavedGroupedReadBranch("shake read done");

		booted.transcript.clear();
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		for (const [toolCallId, path] of [
			["read-first", "src/first.ts"],
			["read-last", "src/last.ts"],
		] as const) {
			group.updateArgs({ path }, toolCallId);
			group.updateResult(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				false,
				toolCallId,
			);
		}
		const ContainerBase = Object.getPrototypeOf(
			booted.host.ReadToolGroupComponent.prototype,
		).constructor as BootedPlugin["ContainerBase"];
		const reply = new ContainerBase();
		reply.addChild({ render: () => ["shake read done"] });
		booted.transcript.addChild(reply);
		await flushMicrotasks();

		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("src/first.ts");
		expect(rows).not.toContain("src/last.ts");
		expect(rows).not.toContain("● Read");
		expect(rows).toContain("shake read done");
		await shutdown(booted);
	},
);

stockTest(
	"tree rebuild filters a grouped read when interleaved tools split replay segments",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		const answer = "tree read done";
		harness.branch.current = interleavedGroupedReadBranch(answer);
		await dispatch(booted, {
			type: "session_tree",
			newLeafId: "tree-read-new",
			oldLeafId: "tree-read-old",
		});
		booted.transcript.clear();
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		for (const [toolCallId, path] of [
			["read-first", "src/first.ts"],
			["read-last", "src/last.ts"],
		] as const) {
			group.updateArgs({ path }, toolCallId);
			group.updateResult(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				false,
				toolCallId,
			);
		}
		const ContainerBase = Object.getPrototypeOf(
			booted.host.ReadToolGroupComponent.prototype,
		).constructor as BootedPlugin["ContainerBase"];
		const reply = new ContainerBase();
		reply.addChild({ render: () => [answer] });
		booted.transcript.addChild(reply);
		await flushMicrotasks();

		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("src/first.ts");
		expect(rows).not.toContain("src/last.ts");
		expect(rows).not.toContain("● Read");
		expect(rows).toContain(answer);
		await shutdown(booted);
	},
);

stockTest("two quick clears replay only the latest generation", async () => {
	const booted = await bootForRebuild("compact");
	await beginRun(booted);
	const call = await addTool(
		booted,
		"bash",
		{ command: "printf first" },
		"bash-1",
	);
	await finishTool(booted, call, {
		toolCallId: "bash-1",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	addAnswer(booted, "first done");
	await finishRun(booted, "first done");
	booted.harness.branch.current = committedSingleToolBranch(
		"printf first",
		"bash-1",
		"first done",
	);
	// rebuild 1: a stale generation
	booted.transcript.clear();
	const stale = addToolComponent(
		booted,
		"bash",
		{ command: "printf first" },
		"bash-1",
	);
	// rebuild 2 before the settlement microtask runs: supersedes it
	booted.transcript.clear();
	expect(booted.harness.clears).toBe(2);
	const latest = addToolComponent(
		booted,
		"bash",
		{ command: "printf first" },
		"bash-1",
	);
	addAnswer(booted, "first done");
	await flushMicrotasks();
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("bash: printf first");
	expect(rows).toContain("first done");
	// only the latest generation replayed
	expect(booted.harness.resetCalls).toBe(1);
	// the intermediate generation's component was retired unwrapped
	expect(Object.hasOwn(stale, "render")).toBe(false);
	expect(Object.hasOwn(latest, "render")).toBe(true);
	await shutdown(booted);
});

stockTest(
	"dispose before the settlement microtask cancels the replay and leaves pure stock presentation",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "first done");
		await finishRun(booted, "first done");
		booted.harness.branch.current = committedSingleToolBranch(
			"printf first",
			"bash-1",
			"first done",
		);
		booted.transcript.clear();
		expect(booted.harness.clears).toBe(1);
		// shutdown before the microtask: the rebuild is cancelled and the
		// rollback leaves pure stock presentation rather than a mixed one
		await shutdown(booted);
		expect(booted.harness.resetCalls).toBe(0);
		expect(Object.hasOwn(booted.transcript, "render")).toBe(false);
		// the adapter's clear wrapper is gone: the transcript's own clear is
		// the harness counter the adapter captured as its original again
		const originalClear = booted.harness.originalClear;
		expect(originalClear).toBeDefined();
		if (!originalClear) throw new Error("original clear missing");
		expect(booted.transcript.clear).toBe(originalClear);
		expect(Object.hasOwn(call, "render")).toBe(false);
		expect(() => booted.transcript.render(120)).not.toThrow();
		expect(booted.notifications).toHaveLength(0);
	},
);

stockTest(
	"rebuilt unknown and expanded surfaces stay native while known tools go compact",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf known" },
			"bash-1",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "mystery-1",
			toolName: "mystery",
			args: { action: "probe" },
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		booted.harness.branch.current = [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "work" }],
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "bash-1",
					toolName: "bash",
					args: { command: "printf known" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "mystery-1",
					toolName: "mystery",
					args: { action: "probe" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "mystery-1",
					toolName: "mystery",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("done") },
		];
		booted.transcript.clear();
		const rebuiltKnown = addToolComponent(
			booted,
			"bash",
			{ command: "printf known" },
			"bash-1",
		);
		rebuiltKnown.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-1",
		);
		const rebuiltUnknown = addToolComponent(
			booted,
			"mystery",
			{ action: "probe" },
			"mystery-1",
		);
		rebuiltUnknown.render = () => ["native-mystery"];
		rebuiltUnknown.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"mystery-1",
		);
		addAnswer(booted, "done");
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("bash: printf known");
		expect(rows).toContain("native-mystery");
		// expanded surfaces stay native during the live phase after a rebuild
		await beginRun(booted);
		const expanded = await addTool(
			booted,
			"bash",
			{ command: "printf expanded" },
			"bash-2",
		);
		expanded.render = () => ["native-expanded"];
		expanded.setExpanded(true);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("native-expanded");
		expect(live).not.toContain("bash: printf expanded");
		await finishTool(booted, expanded, {
			toolCallId: "bash-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "expanded done");
		await finishRun(booted, "expanded done");
		await shutdown(booted);
	},
);

stockTest(
	"mid-run rebuild preserves the active pending tool without duplication",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf pending" },
			"bash-1",
		);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf pending",
		);
		// mid-run rebuild (e.g. a settings/theme change): stock preserves
		// the in-flight component instance and re-appends it
		booted.transcript.clear();
		expect(booted.harness.clears).toBe(1);
		booted.transcript.addChild(call);
		await flushMicrotasks();
		const rebuilt = visibleRows(booted.transcript).join("\n");
		// neither duplicated nor lost: exactly one pending compact row
		expect(rebuilt).toContain("bash: printf pending");
		expect(rebuilt.match(/printf pending/g)).toHaveLength(1);
		// exactly one full replay for this generation
		expect(booted.harness.resetCalls).toBe(1);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "pending done");
		await finishRun(booted, "pending done");
		const settled = visibleRows(booted.transcript).join("\n");
		expect(settled).toContain("bash: printf pending");
		expect(settled).toContain("pending done");
		await shutdown(booted);
	},
);
stockTest(
	"mid-run rebuild restores two exact active components and binds a new same-run tool",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		const second = await addTool(
			booted,
			"bash",
			{ command: "printf second" },
			"bash-2",
		);

		booted.transcript.clear();
		// Stock re-adds the exact live objects synchronously without replaying
		// updateArgs(args, toolCallId) for either historical component.
		booted.transcript.addChild(first);
		booted.transcript.addChild(second);
		await flushMicrotasks();
		const rebuilt = visibleRows(booted.transcript).join("\n");
		expect(rebuilt).toContain("bash: printf first");
		expect(rebuilt).toContain("bash: printf second");
		expect(rebuilt.match(/printf first/g)).toHaveLength(1);
		expect(rebuilt.match(/printf second/g)).toHaveLength(1);

		// A new same-run component must bind without requiring another
		// historical-ID callback from either preserved component.
		const afterRebuild = await addTool(
			booted,
			"bash",
			{ command: "printf after-rebuild" },
			"bash-3",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("bash: printf after-rebuild");
		expect(live.match(/printf after-rebuild/g)).toHaveLength(1);

		for (const [component, toolCallId] of [
			[first, "bash-1"],
			[second, "bash-2"],
			[afterRebuild, "bash-3"],
		] as const) {
			await finishTool(booted, component, {
				toolCallId,
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			});
		}
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		await shutdown(booted);
	},
);

stockTest(
	"fresh logical run ignores unresolved active rebuild states when binding a new tool",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf stale-first" },
			"stale-1",
		);
		const second = await addTool(
			booted,
			"bash",
			{ command: "printf stale-second" },
			"stale-2",
		);

		booted.transcript.clear();
		// These active components are not reconstructed in this generation;
		// their unresolved states must remain evidence, not block a later run.
		await flushMicrotasks();
		await finishTool(booted, first, {
			toolCallId: "stale-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		await finishTool(booted, second, {
			toolCallId: "stale-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "stale done");
		await finishRun(booted, "stale done");

		await beginRun(booted);
		const fresh = await addTool(
			booted,
			"bash",
			{ command: "printf fresh" },
			"fresh-1",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("bash: printf fresh");
		expect(live.match(/printf fresh/g)).toHaveLength(1);
		await finishTool(booted, fresh, {
			toolCallId: "fresh-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "fresh done");
		await finishRun(booted, "fresh done");
		await shutdown(booted);
	},
);

stockTest(
	"two quick clears carry the exact active components into the latest generation",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		const second = await addTool(
			booted,
			"bash",
			{ command: "printf second" },
			"bash-2",
		);
		// Both clears land before any re-add: the second generation
		// supersedes the first, but the exact active identity captured by
		// the first clear must carry into the latest generation — stock
		// re-adds the same live objects after the final clear without
		// replaying updateArgs for either component.
		booted.transcript.clear();
		booted.transcript.clear();
		expect(booted.harness.clears).toBe(2);
		booted.transcript.addChild(first);
		booted.transcript.addChild(second);
		await flushMicrotasks();
		const rebuilt = visibleRows(booted.transcript).join("\n");
		expect(rebuilt).toContain("bash: printf first");
		expect(rebuilt).toContain("bash: printf second");
		expect(rebuilt.match(/printf first/g)).toHaveLength(1);
		expect(rebuilt.match(/printf second/g)).toHaveLength(1);
		// exactly one replay, for the latest generation only
		expect(booted.harness.resetCalls).toBe(1);
		for (const [component, toolCallId] of [
			[first, "bash-1"],
			[second, "bash-2"],
		] as const) {
			await finishTool(booted, component, {
				toolCallId,
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			});
		}
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		await shutdown(booted);
	},
);

stockTest(
	"a new same-run tool binds after a partial rebuild without poisoning from the unresolved state",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		const second = await addTool(
			booted,
			"bash",
			{ command: "printf second" },
			"bash-2",
		);
		booted.transcript.clear();
		// Only the first object is reconstructed synchronously; the second
		// active state loses its host callback and stays unresolved evidence
		// for the rest of the run.
		booted.transcript.addChild(first);
		await flushMicrotasks();
		const rebuilt = visibleRows(booted.transcript).join("\n");
		expect(rebuilt).toContain("bash: printf first");
		expect(rebuilt.match(/printf first/g)).toHaveLength(1);
		// The genuinely new tool of the same logical run must bind compactly:
		// the unresolved preserved state must not inflate the single-pair
		// cardinality, and must never be guessed against by ordinal.
		const fresh = await addTool(
			booted,
			"bash",
			{ command: "printf fresh" },
			"bash-3",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("bash: printf fresh");
		expect(live.match(/printf fresh/g)).toHaveLength(1);
		for (const [component, toolCallId] of [
			[first, "bash-1"],
			[second, "bash-2"],
			[fresh, "bash-3"],
		] as const) {
			await finishTool(booted, component, {
				toolCallId,
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			});
		}
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const settled = visibleRows(booted.transcript).join("\n");
		expect(settled).toContain("bash: printf first");
		expect(settled).toContain("bash: printf fresh");
		expect(settled.match(/printf first/g)).toHaveLength(1);
		expect(settled.match(/printf fresh/g)).toHaveLength(1);
		// the unresolved state contributes no phantom row
		expect(settled).not.toContain("printf second");
		await shutdown(booted);
	},
);

stockTest(
	"session_tree intent alone never advances the presentation generation",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "first done");
		await finishRun(booted, "first done");
		booted.harness.branch.current = committedSingleToolBranch(
			"printf first",
			"bash-1",
			"first done",
		);
		// cancelled/no-op tree interaction: the intent event without any
		// transcript clear must not advance the generation or replay
		await dispatch(booted, {
			type: "session_tree",
			newLeafId: "leaf-2",
			oldLeafId: "leaf-1",
		});
		expect(booted.harness.resetCalls).toBe(0);
		expect(booted.harness.clears).toBe(0);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf first",
		);
		// a committed navigation rebuilds and replays exactly once
		booted.transcript.clear();
		addToolComponent(booted, "bash", { command: "printf first" }, "bash-1");
		addAnswer(booted, "first done");
		await flushMicrotasks();
		expect(booted.harness.resetCalls).toBe(1);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf first",
		);
		await shutdown(booted);
	},
);

stockTest("ambiguous rebuild mapping stays native per block", async () => {
	const booted = await bootForRebuild("compact");
	await beginRun(booted);
	const first = await addTool(
		booted,
		"bash",
		{ command: "printf first" },
		"bash-1",
	);
	await finishTool(booted, first, {
		toolCallId: "bash-1",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	const second = await addTool(
		booted,
		"bash",
		{ command: "printf second" },
		"bash-2",
	);
	await finishTool(booted, second, {
		toolCallId: "bash-2",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	addAnswer(booted, "done");
	await finishRun(booted, "done");
	booted.harness.branch.current = [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "work" }] },
		},
		{
			type: "custom",
			customType: "tool_execution_start",
			data: {
				toolCallId: "bash-1",
				toolName: "bash",
				args: { command: "printf first" },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "bash-1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
		},
		{
			type: "custom",
			customType: "tool_execution_start",
			data: {
				toolCallId: "bash-2",
				toolName: "bash",
				args: { command: "printf second" },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "bash-2",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
		},
		{ type: "message", message: assistant("done") },
	];
	booted.transcript.clear();
	// only one of the two historical components is re-added: the
	// reconstruction is ambiguous for the branch and stays native
	const rebuilt = addToolComponent(
		booted,
		"bash",
		{ command: "printf first" },
		"bash-1",
	);
	rebuilt.render = () => ["native-ambiguous"];
	addAnswer(booted, "done");
	await flushMicrotasks();
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("native-ambiguous");
	expect(rows).not.toContain("bash: printf first");
	expect(rows).toContain("done");
	await shutdown(booted);
});

stockTest(
	"unpatchable transcript clear rolls back transactionally to stock presentation",
	async () => {
		let transcript: TranscriptInstance | undefined;
		let nativeClear: (() => void) | undefined;
		const booted = await bootPlugin((root, host) => {
			const candidate = new host.TranscriptContainer();
			// `clear` is present (the capability probe passes) but cannot be
			// patched: the transaction must fail open to pure stock.
			nativeClear = candidate.clear;
			Object.defineProperty(candidate, "clear", {
				value: nativeClear,
				configurable: false,
				writable: true,
			});
			transcript = candidate;
			root.addChild(candidate);
		});
		if (!transcript) throw new Error("transcript missing");
		const resolvedTranscript = transcript;
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		// wrappers applied before the failing clear patch are gone
		expect(Object.hasOwn(transcript, "render")).toBe(false);
		expect(Object.hasOwn(transcript, "addChild")).toBe(false);
		// the incompatible own property keeps its exact descriptor and the
		// native method was never wrapped
		// the callback above assigned the native method unconditionally
		expect(nativeClear).toBeDefined();
		if (!nativeClear) throw new Error("native clear missing");
		expect(transcript.clear).toBe(nativeClear);
		expect(
			Object.getOwnPropertyDescriptor(transcript, "clear")?.configurable,
		).toBe(false);
		expect(() => resolvedTranscript.render(120)).not.toThrow();
		expect(booted.intervalCallbacks).toHaveLength(0);
		await shutdown(booted);
		expect(booted.notifications).toHaveLength(1);
	},
);

// ---------------------------------------------------------------------------
// D03 terminal scrollback replay: stock freezes mutable live-region rows
// into native scrollback when they move above the viewport, so a filtered
// terminal answer leaves frozen native rows behind. After the terminal
// projection and the stats carrier insertion attempt, the adapter replays
// the full presentation exactly once through the capability-checked
// exact-root `resetDisplay` — but only when the fold holds structured
// committed rows (declared through the native
// `setNativeScrollbackCommittedRows` seam). No committed rows, compact/full
// terminal paths, aborts, continuations, missing capability and disposed
// adapters all stay no-op/native. Tests assert observable rows and reset
// counts — never private maps.
// ---------------------------------------------------------------------------

stockTest(
	"D03: a committed filtered run replays terminal scrollback exactly once after stats insertion",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf scrollback" },
			"d03-bash",
		);
		await finishTool(booted, call, {
			toolCallId: "d03-bash",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		// stock froze the mutable row into native scrollback: declare the
		// run's rendered span committed through the carrier seam
		const span = visibleRows(booted.transcript).length;
		expect(span).toBeGreaterThan(0);
		(call as CommittedSeamComponent).setNativeScrollbackCommittedRows?.(span);
		// no replay before the terminal answer
		expect(booted.harness.resetCalls).toBe(0);
		addAnswer(booted, "d03 done");
		await completeAnswer(booted, "d03 done");
		// exactly one replay, after the stats carrier insertion: the stats
		// row renders directly above the answer
		expect(booted.harness.resetCalls).toBe(1);
		const rows = visibleRows(booted.transcript);
		const statsRow = rows.find((row) => row.includes("1 actions"));
		expect(statsRow).toBeDefined();
		expect(rows.indexOf(statsRow as string)).toBeLessThan(
			rows.indexOf("d03 done"),
		);
		await shutdown(booted);
	},
);

stockTest(
	"D03: a filtered run without committed rows never replays",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf uncommitted" },
			"d03-uncommitted",
		);
		await finishTool(booted, call, {
			toolCallId: "d03-uncommitted",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		// the run stays in the live region: nothing was declared committed
		expect(visibleRows(booted.transcript).length).toBeGreaterThan(0);
		expect(booted.harness.resetCalls).toBe(0);
		addAnswer(booted, "uncommitted done");
		await completeAnswer(booted, "uncommitted done");
		// the terminal seam still ran (stats inserted), but the missing
		// committed declaration keeps the replay a no-op
		expect(booted.harness.resetCalls).toBe(0);
		expect(
			visibleRows(booted.transcript).some((row) => row.includes("1 actions")),
		).toBe(true);
		await shutdown(booted);
	},
);

stockTest(
	"D03: compact-mode terminal runs (full retained log) never replay",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("compact", harness);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf compact" },
			"d03-compact",
		);
		await finishTool(booted, call, {
			toolCallId: "d03-compact",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		const span = visibleRows(booted.transcript).length;
		expect(span).toBeGreaterThan(0);
		(call as CommittedSeamComponent).setNativeScrollbackCommittedRows?.(span);
		addAnswer(booted, "compact done");
		await completeAnswer(booted, "compact done");
		// the full retained log settles as "full": committed rows exist but
		// the terminal projection never changed, so no replay
		expect(booted.harness.resetCalls).toBe(0);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"printf compact",
		);
		await shutdown(booted);
	},
);

stockTest(
	"D03: abort, continuation and disposed adapters never replay",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf abort" },
			"d03-abort",
		);
		await finishTool(booted, call, {
			toolCallId: "d03-abort",
			toolName: "bash",
			result: { content: [{ type: "text", text: "failed" }] },
			isError: true,
		});
		const span = visibleRows(booted.transcript).length;
		expect(span).toBeGreaterThan(0);
		(call as CommittedSeamComponent).setNativeScrollbackCommittedRows?.(span);
		// continuation: willContinue never fires the terminal seam
		await finishRun(booted, "continue text", "toolUse", true);
		expect(booted.harness.resetCalls).toBe(0);
		// abort/error finalization: the full log path never replays
		await finishRun(booted, "", "aborted");
		expect(booted.harness.resetCalls).toBe(0);
		// dispose: a late terminal event after shutdown touches no adapter
		await shutdown(booted);
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("late done")],
			willContinue: false,
		});
		expect(booted.harness.resetCalls).toBe(0);
	},
);

stockTest(
	"D03: a committed filtered run without the exact-root resetDisplay stays native",
	async () => {
		// standard boot: the host root has no resetDisplay capability
		const booted = await bootWithStats();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf nocap" },
			"d03-nocap",
		);
		await finishTool(booted, call, {
			toolCallId: "d03-nocap",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		const span = visibleRows(booted.transcript).length;
		expect(span).toBeGreaterThan(0);
		(call as CommittedSeamComponent).setNativeScrollbackCommittedRows?.(span);
		addAnswer(booted, "nocap done");
		await completeAnswer(booted, "nocap done");
		// capability missing: the replay fails open and the projection with
		// the stats row stays observable
		const rows = visibleRows(booted.transcript);
		expect(rows.some((row) => row.includes("1 actions"))).toBe(true);
		expect(rows).toContain("nocap done");
		await shutdown(booted);
	},
);
