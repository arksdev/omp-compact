/**
 * Shared replay harness for the omp-compact replay-fixture corpus.
 *
 * Mirrors the boot/delivery patterns of `index.integration.test.ts` (same
 * host-module loading, same `pi` stub, same native component/read-group
 * creation, same event dispatch) so replay fixtures exercise the plugin
 * through exactly the seams the stock integration suite relies on. This
 * file is test scaffolding only — no production code is touched.
 */
import { DEFAULT_SETTINGS } from "../../../.omp-plugin/config";
import {
	type HostModules,
	loadHost,
	type ReadGroupInstance,
	type Renderable,
	type ToolExecutionInstance,
	type TranscriptInstance,
	writeStockSettings,
} from "../test-stock-host";

const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type Handler = (
	event: Record<string, unknown>,
	context: BootedPlugin["context"],
) => unknown;

export interface AppendedEntry {
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
	sentMessages: Array<{ message: Record<string, unknown>; options?: unknown }>;
	appendedEntries: AppendedEntry[];
	renderers: Map<
		string,
		(
			message: { details?: unknown },
			options: { expanded: boolean },
			theme: ReturnType<HostModules["getTheme"]>,
		) => Renderable | undefined
	>;
	notifications: string[];
	intervalCallbacks: Array<() => void>;
	clearedTimers: unknown[];
	transcript: TranscriptInstance;
}

export async function bootReplay(options: {
	settings?: Record<string, unknown>;
	cwd?: string;
}): Promise<BootedPlugin> {
	const host = await loadHost();
	await host.initTheme();
	const bootSettings = options.settings ?? {
		...DEFAULT_SETTINGS,
		stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
	};
	const modeConfigPath = writeStockSettings(
		bootSettings,
		"replay-settings.json",
	);
	const previousModeConfig = Bun.env.OMP_COMPACT_CONFIG;
	Bun.env.OMP_COMPACT_CONFIG = modeConfigPath;
	const handlers = new Map<string, Handler[]>();
	const registeredTools: string[] = [];
	const commands: string[] = [];
	const sentMessages: BootedPlugin["sentMessages"] = [];
	const appendedEntries: AppendedEntry[] = [];
	const renderers = new Map<
		string,
		(
			message: { details?: unknown },
			options: { expanded: boolean },
			theme: ReturnType<HostModules["getTheme"]>,
		) => Renderable | undefined
	>();
	const notifications: string[] = [];
	const intervalCallbacks: Array<() => void> = [];
	const clearedTimers: unknown[] = [];
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
		registerCommand(name: string) {
			commands.push(name);
		},
		registerMessageRenderer(type: string, renderer: unknown) {
			renderers.set(type, renderer as never);
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
	try {
		host.plugin(pi);
	} finally {
		if (previousModeConfig === undefined) {
			delete Bun.env.OMP_COMPACT_CONFIG;
		} else {
			Bun.env.OMP_COMPACT_CONFIG = previousModeConfig;
		}
	}
	const ContainerBase = host.ContainerBase;
	const root = new ContainerBase();
	const transcript = new host.TranscriptContainer();
	root.addChild(transcript);
	const context: BootedPlugin["context"] = {
		cwd: options.cwd ?? "/tmp",
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
				return false;
			},
		},
		sessionManager: { getBranch: () => [] },
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
	if (!transcript) throw new Error("transcript container missing");
	return {
		host,
		handlers,
		context,
		root,
		ContainerBase,
		registeredTools,
		commands,
		sentMessages,
		renderers: renderers as BootedPlugin["renderers"],
		appendedEntries,
		notifications,
		intervalCallbacks,
		clearedTimers,
		transcript,
	};
}

export async function dispatch(
	booted: BootedPlugin,
	event: Record<string, unknown>,
): Promise<void> {
	// Stock invokes each event's listeners in order and awaits them
	// (runner.ts emit); the plugin registers one listener per event.
	for (const handler of booted.handlers.get(String(event.type)) ?? []) {
		await handler(event, booted.context);
	}
}

export function visibleRows(component: Renderable, width = 120): string[] {
	return component
		.render(width)
		.map((line) => line.replace(ansiPattern, "").trimEnd())
		.filter((line) => line.trim().length > 0);
}

export function screenRows(component: Renderable, width = 120): string[] {
	return component
		.render(width)
		.map((line) => line.replace(ansiPattern, "").trimEnd());
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
	usage?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		...(usage !== undefined ? { usage } : {}),
	};
}

// ---------------------------------------------------------------------------
// Fixture types + replay engine.
// ---------------------------------------------------------------------------

export interface ReplayFixtureMeta {
	id: string;
	/**
	 * Provenance marker: every fixture is derived from a raw OMP session
	 * transcript whose location lives only in the external regeneration
	 * manifest (`OMP_REPLAY_MANIFEST`). Tracked fixtures never reference
	 * the raw file — `source` is the literal `"<session>"` and no capture
	 * date or machine path is stored.
	 */
	source: string;
	sourceKind: string;
	cwd: string;
	mode: "live" | "compact" | "clear";
	stats: boolean;
	terminal: string;
	events: number;
	tools: number;
	toolNames: Record<string, number>;
	redaction: string;
	note: string;
}

export interface ReplayEvent {
	t:
		| "run_start"
		| "tool_start"
		| "tool_result"
		| "continue"
		| "answer"
		| "run_end"
		| "session_shutdown";
	id?: string;
	name?: string;
	args?: unknown;
	intent?: string;
	result?: unknown;
	isError?: boolean;
	pruned?: boolean;
	text?: string;
	stop?: string;
	usage?: Record<string, unknown>;
}

export interface ReplayFixture {
	meta: ReplayFixtureMeta;
	events: ReplayEvent[];
}

export interface ReplayOutcome {
	rows: string[];
	carriers: AppendedEntry[];
}

export function settingsForFixture(meta: ReplayFixtureMeta): {
	mode: "live" | "compact" | "clear";
	stats: boolean;
} {
	return { mode: meta.mode, stats: meta.stats };
}

/**
 * Golden carriers must not assert unstable wall-clock values: absolute
 * timestamps (`completedAt`) and machine-speed durations (`durationMs`)
 * become deterministic placeholders. Everything else — ids, counts, sums,
 * subcommands, records — is structural and preserved.
 */
function normalizeCarrierData(data: unknown, depth = 0): unknown {
	if (data === null || typeof data !== "object" || depth > 6) return data;
	if (Array.isArray(data)) {
		return data.map((item) => normalizeCarrierData(item, depth + 1));
	}
	const record = data as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === "completedAt") {
			out[key] = 0;
			continue;
		}
		if (key === "durationMs") {
			out[key] = 0;
			continue;
		}
		out[key] = normalizeCarrierData(value, depth + 1);
	}
	return out;
}

/**
 * Replay one normalized fixture through the harness. `events` end with an
 * optional `session_shutdown`; the snapshot is taken right before it (or at
 * the end of the stream) so the projection is the plugin's own terminal/live
 * state, not the post-dispose native rendering.
 */
export async function replayFixture(
	fixture: ReplayFixture,
	onBoot?: (booted: BootedPlugin) => void,
): Promise<{ booted: BootedPlugin; outcome: ReplayOutcome }> {
	const settings = settingsForFixture(fixture.meta);
	const booted = await bootReplay({
		cwd: fixture.meta.cwd,
		settings: {
			...DEFAULT_SETTINGS,
			mode: settings.mode,
			stats: { ...DEFAULT_SETTINGS.stats, enabled: settings.stats },
		},
	});
	onBoot?.(booted);

	const components = new Map<
		string,
		| { kind: "tool"; component: ToolExecutionInstance }
		| { kind: "read"; group: ReadGroupInstance }
	>();
	let readGroup: ReadGroupInstance | undefined;

	// Stock delivers extension events through a serial queue and awaits each
	// handler (runner.ts emit + agent-session.ts #queuedExtensionEvents), so
	// replay dispatches one event at a time. Fixtures already order every
	// `continue`/`answer` after the round-trip's ends, so the audit barrier
	// at agent_end never waits on an undelivered end.
	const events = fixture.events;
	for (const event of events) {
		if (event.t === "session_shutdown") break;
		switch (event.t) {
			case "run_start":
				readGroup = undefined;
				await dispatch(booted, { type: "agent_start" });
				break;
			case "tool_start": {
				const id = String(event.id);
				const name = String(event.name);
				const args = event.args;
				if (name === "read") {
					if (!readGroup) {
						readGroup = new booted.host.ReadToolGroupComponent();
						booted.transcript.addChild(readGroup);
					}
					const pathArgs = (args ?? {}) as {
						path?: string;
						file_path?: string;
					};
					// Stock delivery: the native group update lands before the
					// extension start event, so observed ids are recorded first.
					readGroup.updateArgs(pathArgs, id);
					await dispatch(booted, {
						type: "tool_execution_start",
						toolCallId: id,
						toolName: name,
						args,
					});
					components.set(id, { kind: "read", group: readGroup });
					continue;
				}
				await dispatch(booted, {
					type: "tool_execution_start",
					toolCallId: id,
					toolName: name,
					args,
				});
				const component = new booted.host.ToolExecutionComponent(
					name,
					args,
					{ showImages: false, useBuiltInRenderer: true },
					fakeTool(name),
					toolUi(),
					booted.context.cwd,
					id,
				);
				booted.transcript.addChild(component);
				components.set(id, { kind: "tool", component });
				break;
			}
			case "tool_result": {
				const id = String(event.id);
				const binding = components.get(id);
				const result = event.result;
				const isError = event.isError === true;
				await dispatch(booted, {
					type: "tool_execution_end",
					toolCallId: id,
					toolName: String(event.name),
					result,
					isError,
				});
				if (binding?.kind === "tool") {
					binding.component.updateResult(result, false, id);
				} else if (binding?.kind === "read") {
					binding.group.updateResult(result, false, id);
				}
				break;
			}
			case "continue": {
				if (event.usage !== undefined) {
					await dispatch(booted, {
						type: "message_end",
						message: assistant(event.text ?? "", "toolUse", event.usage),
					});
				}
				await dispatch(booted, {
					type: "agent_end",
					messages: [assistant(event.text ?? "", "toolUse")],
					willContinue: true,
				});
				break;
			}
			case "answer": {
				if (event.usage !== undefined) {
					await dispatch(booted, {
						type: "message_end",
						message: assistant(event.text ?? "", "stop", event.usage),
					});
				}
				const reply = new booted.ContainerBase();
				reply.addChild({ render: () => [event.text ?? ""] });
				booted.transcript.addChild(reply);
				await dispatch(booted, {
					type: "agent_end",
					messages: [assistant(event.text ?? "", "stop")],
					willContinue: false,
				});
				break;
			}
			case "run_end": {
				await dispatch(booted, {
					type: "agent_end",
					messages: [assistant(event.text ?? "", event.stop ?? "aborted")],
					willContinue: false,
				});
				break;
			}
			default:
				break;
		}
	}

	const outcome: ReplayOutcome = {
		rows: visibleRows(booted.transcript),
		carriers: booted.appendedEntries.map((entry) => ({
			customType: entry.customType,
			data: normalizeCarrierData(entry.data),
		})),
	};
	if (
		events.length > 0 &&
		events[events.length - 1]?.t === "session_shutdown"
	) {
		await dispatch(booted, { type: "session_shutdown" });
	}
	return { booted, outcome };
}
