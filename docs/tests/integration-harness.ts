/**
 * Shared harness for the index integration suites.
 *
 * These suites boot the plugin into a live stock host, so they all need the
 * same scaffolding: a booted plugin with its captured renderers and event
 * handlers, per-boot temp roots, and the turn-shaped helpers that drive a run
 * (`beginRun` -> `addTool` -> `addAnswer` -> `finishRun`).
 *
 * Temp cleanup is deliberately split: this module owns the registry, but every
 * suite must call `cleanupGeneratedDirs` from its own `afterAll`. Bun runs
 * test files sequentially in one process and completes each file's hooks before
 * loading the next, so a hook registered here would bind to whichever suite
 * loaded the module first and fire once, leaving every later suite's temp dirs
 * behind. Verified: three files sharing one registry each drained only their
 * own entries.
 */
import { test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../.omp-plugin/config";
import {
	cleanupStockSettings,
	type HostModules,
	loadHost,
	type Renderable,
	type ToolExecutionInstance,
	type TranscriptInstance,
	writeStockSettings,
} from "./test-stock-host";

const binary = process.env.OMP_STOCK_BIN;

export const stockTest = binary ? test : test.skip;

// Per-boot unique dir/file names: every boot runs its own working directory
// and its own settings file, so parallel test files (bun runs them as
// separate processes) can never see each other's /tmp files or clobber each
// other's config mid-boot. Counters are per-process (per file), which is
// enough for uniqueness; the pid disambiguates processes.
let bootCounter = 0;

// The settings file of the most recent boot, so tests that read the persisted
// JSON after a dialog save resolve the same path the boot wrote.
export let lastBootSettingsPath: string | undefined;

/**
 * Temp roots this process created. Individual tests still remove their own
 * fixture dirs; this registry only guarantees nothing survives the run.
 * `mkdtemp` names are unique per boot, so nothing here is ever reused and an
 * already-removed path is a no-op under `force`.
 */
const generatedDirs = new Set<string>();

function bootTempDir(prefix = "omp-compact-boot-"): string {
	const dir = mkdtempSync(join(tmpdir(), `${prefix}${process.pid}-`));
	generatedDirs.add(dir);
	return dir;
}

/**
 * Per-process fixture root for tests that pass an explicit cwd. The same
 * suite runs concurrently (multiple `bun test` processes on one machine)
 * must never share audit pre/post-image files: a test's own write fixture
 * in a sibling process would corrupt the capture and silently drop the
 * evidence row.
 */
export function fixtureDir(name: string): string {
	const dir = join(tmpdir(), `omp-compact-fx-${process.pid}-${name}`);
	generatedDirs.add(dir);
	return dir;
}

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

export interface BootedPlugin {
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
	/** Mutates the fake host `pi` before the plugin boots: lets tests
	 * simulate a host surface that throws on one of the guarded
	 * registration calls. */
	piMutate?: (pi: Record<string, unknown>) => void;
}

export async function bootPlugin(
	prepare?: (root: BootedPlugin["root"], host: HostModules) => void,
	cwd = bootTempDir(),
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
	const modeConfigPath = writeStockSettings(
		bootSettings,
		`test-settings-${process.pid}-${bootCounter++}.json`,
	);
	lastBootSettingsPath = modeConfigPath;
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
	if (harness?.piMutate) {
		harness.piMutate(pi);
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

export async function dispatch(
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
export function dispatchFireAndForget(
	booted: BootedPlugin,
	event: Record<string, unknown>,
): Promise<void> {
	const pending: Promise<unknown>[] = [];
	for (const handler of booted.handlers.get(String(event.type)) ?? []) {
		pending.push(Promise.resolve(handler(event, booted.context)));
	}
	return Promise.all(pending).then(() => undefined);
}

export function toolUi(): Record<string, unknown> {
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

export function fakeTool(name: string): Record<string, unknown> {
	return {
		name,
		label: name,
		description: name,
		parameters: {},
		execute: async () => ({ content: [], details: {} }),
	};
}

export function assistant(
	text: string,
	stopReason = "stop",
): Record<string, unknown> {
	return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

export function visibleRows(component: Renderable, width = 120): string[] {
	return component
		.render(width)
		.map((line) => Bun.stripANSI(line).trimEnd())
		.filter((line) => line.trim().length > 0);
}

export function screenRows(component: Renderable, width = 120): string[] {
	return component.render(width).map((line) => Bun.stripANSI(line).trimEnd());
}

export async function bootWithTranscript(
	cwd = bootTempDir(),
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

export async function beginRun(booted: BootedPlugin): Promise<void> {
	await dispatch(booted, { type: "agent_start" });
}

export async function addTool(
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
export function addToolComponent(
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

export async function finishTool(
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

export function addAnswer(
	booted: BootedPlugin & { transcript: TranscriptInstance },
	text: string,
): void {
	const reply = new booted.ContainerBase();
	reply.addChild({ render: () => [text] });
	booted.transcript.addChild(reply);
}

export async function finishRun(
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

export async function shutdown(booted: BootedPlugin): Promise<void> {
	await dispatch(booted, { type: "session_shutdown" });
}

export async function groupedRead(
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

// ---------------------------------------------------------------------------
// RuntimeModes (upgrade2 item 2): compact / live / clear runtime modes.
// ---------------------------------------------------------------------------

export async function bootWithMode(
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
		{
			...DEFAULT_SETTINGS,
			mode,
			// These contracts pin the composition of the projected rows, so the
			// clock stays off: it reports the wall time of the run and would
			// tie the expectations to the hour and minute of the test run.
			stats: { ...DEFAULT_SETTINGS.stats, clock: false },
			...extra,
		},
	);
	if (!transcript) throw new Error("transcript missing");
	return { ...booted, transcript };
}

// ---------------------------------------------------------------------------
// Multi-response run evidence (D01/D02): one logical run spans several
// assistant-response groups (toolUse continuations) inside a single
// agent_start → terminal agent_end. Every mapped routine row — from the
// early AND the late groups, parallel/delayed reads included — must follow
// the frozen per-run mode at the terminal answer (`live` filters all,
// `compact` retains all in transcript order, `clear` hides ordinary rows),
// and the assistant texts keep their order (group texts precede the later
// group's rows; the terminal answer text is last and unchanged). The fold's
// retirement seam is observable on this path too: while a run works, none of
// its mapped members may retire into terminal history — the container offers
// no batch and every member is still removable — and the projection follows
// the mode regardless, because the seam is presentation-only (the missing
// live signal is the native history commit, see the D02 classification).
// ---------------------------------------------------------------------------

export interface CommittedSeamTranscript extends TranscriptInstance {
	canRemoveBlock?(component: unknown): boolean;
}

// ---------------------------------------------------------------------------
// RunStats wiring (upgrade2 item 4): authoritative message_end usage,
// tool_execution_start action dedup, and one persisted evidence entry per
// successful terminal run. These contracts boot with stats explicitly
// enabled (the harness default disables it for the pre-stats suites).
// ---------------------------------------------------------------------------

export function assistantWithUsage(
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

export async function completeAnswer(
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

export function bootWithStats(
	mode: "compact" | "live" | "clear" = "live",
	extra: Record<string, unknown> = {},
): Promise<BootedPlugin & { transcript: TranscriptInstance }> {
	return bootWithMode(mode, {
		stats: { ...DEFAULT_SETTINGS.stats, enabled: true },
		...extra,
	});
}

/**
 * Open the real /compact-settings dialog through the command handler and
 * drive it: `edit` changes the focused draft (Global compact is the first
 * focusable row), then save persists through saveSettingsFlow →
 * store.update(), exactly the path a user uses to change settings
 * mid-session (store snapshot and ModePolicy both refresh).
 */
export async function saveSettingsViaDialog(
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

export function rebuildHarness(): RebuildHarness {
	return {
		branch: { current: [] },
		resetCalls: 0,
		clears: 0,
		originalClear: undefined,
	};
}

export async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

export async function bootForRebuild(
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

/**
 * Drop every temp root this process created. Call from each suite's
 * `afterAll`; see the note above for why the hook cannot live here.
 */
export async function cleanupGeneratedDirs(): Promise<void> {
	await Promise.all(
		[...generatedDirs].map((dir) =>
			rm(dir, { recursive: true, force: true }).catch(() => {}),
		),
	);
	generatedDirs.clear();
	cleanupStockSettings();
}
