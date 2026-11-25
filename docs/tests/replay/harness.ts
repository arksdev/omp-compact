/**
 * Shared replay harness for the omp-compact replay-fixture corpus.
 *
 * Mirrors the boot/delivery patterns of the stock integration suites (same
 * host-module loading, same `pi` stub, same native `Transcript` and
 * `TranscriptPresenter`, same event dispatch) so replay fixtures exercise the
 * plugin through the exact seams omp 19.2.0 exposes.
 */
import { DEFAULT_SETTINGS } from "../../../.omp-plugin/config";
import {
	type ExtensionTheme,
	type HostModules,
	loadStockPluginAndHost,
	type PendingToolHandle,
	type Renderable,
	renderStockOutput,
	type StockTranscript,
	writeStockSettings,
} from "../test-stock-host";

/** Boot counter for per-boot unique settings filenames. */
let bootSeq = 0;

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
			theme: ExtensionTheme;
			notify(message: string, level?: string): void;
			refreshTranscript(ids?: readonly string[]): void;
			custom: () => Promise<undefined>;
		};
		mode: string;
		isIdle(): boolean;
		sessionManager: {
			getBranch(): readonly unknown[];
			getEntries(): readonly unknown[];
			getEntry(id: string): unknown;
		};
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
			theme: ExtensionTheme,
		) => unknown
	>;
	notifications: string[];
	/** Shortcut handlers by chord, as the plugin registered them. */
	shortcuts: Map<string, (context: BootedPlugin["context"]) => unknown>;
	transcript: StockTranscript;
	/** Session entries the walk reads; tests assign them before a resume. */
	branch: unknown[];
}

export async function bootReplay(options: {
	settings?: Record<string, unknown>;
	cwd?: string;
	branch?: unknown[];
	/** Entries of other branches, which only `getEntries` returns. */
	offBranch?: unknown[];
}): Promise<BootedPlugin> {
	const host = await loadStockPluginAndHost("replay");
	await host.initTheme();
	const bootSettings = options.settings ?? {
		...DEFAULT_SETTINGS,
		stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
	};
	const modeConfigPath = writeStockSettings(
		bootSettings,
		`replay-settings-${process.pid}-${Number(++bootSeq)}.json`,
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
			theme: ExtensionTheme,
		) => unknown
	>();
	const notifications: string[] = [];
	const shortcuts: BootedPlugin["shortcuts"] = new Map();
	const presenters: unknown[] = [];
	const cwd = options.cwd ?? "/tmp";
	const transcript = host.createTranscript({
		cwd,
		renderer: (customType) => renderers.get(customType) as never,
	});
	const pi = {
		logger: { warn() {} },
		setLabel() {},
		registerShortcut(
			key: string,
			spec: { handler: (context: BootedPlugin["context"]) => unknown },
		) {
			shortcuts.set(key, spec.handler);
		},
		getShortcutConflict: () => undefined,
		registerTranscriptPresenter(presenter: unknown) {
			presenters.push(presenter);
			transcript.setPresenters(presenters as never);
		},
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
	const branch = options.branch ?? [];
	const context: BootedPlugin["context"] = {
		cwd,
		hasUI: true,
		ui: {
			theme: host.extensionTheme(),
			notify(message) {
				notifications.push(message);
			},
			refreshTranscript(ids) {
				transcript.refresh(ids);
			},
			custom: async () => undefined,
		},
		mode: "tui",
		isIdle: () => true,
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => [...branch, ...(options.offBranch ?? [])],
			getEntry: (id) =>
				branch.find((entry) => (entry as { id?: string }).id === id),
		},
	};
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" }, context);
	}
	return {
		host,
		handlers,
		context,
		registeredTools,
		commands,
		sentMessages,
		renderers,
		appendedEntries,
		notifications,
		shortcuts,
		transcript,
		branch,
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

export function visibleRows(target: unknown, width = 120): string[] {
	return renderStockOutput(target, width)
		.map((line) => Bun.stripANSI(line).trimEnd())
		.filter((line) => line.trim().length > 0);
}

export function screenRows(component: Renderable, width = 120): string[] {
	return component.render(width).map((line) => Bun.stripANSI(line).trimEnd());
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

export interface ReplayFixtureMeta {
	id: string;
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

function normalizeCarrierData(data: unknown, depth = 0): unknown {
	if (data === null || typeof data !== "object" || depth > 6) return data;
	if (Array.isArray(data)) {
		return data.map((item) => normalizeCarrierData(item, depth + 1));
	}
	const record = data as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === "completedAt" || key === "durationMs") {
			out[key] = 0;
			continue;
		}
		if (key === "runId") {
			out[key] = "<run>";
			continue;
		}
		out[key] = normalizeCarrierData(value, depth + 1);
	}
	return out;
}

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
			stats: {
				...DEFAULT_SETTINGS.stats,
				enabled: settings.stats,
				clock: false,
			},
		},
	});
	onBoot?.(booted);

	const components = new Map<
		string,
		| { kind: "tool"; component: PendingToolHandle }
		| { kind: "read"; group: PendingToolHandle }
	>();
	let readGroup: PendingToolHandle | undefined;

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
					readGroup ??= booted.transcript.presentReadGroup();
					const pathArgs = (args ?? {}) as {
						path?: string;
						file_path?: string;
					};
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
				const component = booted.transcript.presentToolCall({
					id,
					name,
					args,
					cwd: booted.context.cwd,
				});
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
				const raw = result as { details?: { phases?: unknown[] } };
				const phases = raw.details?.phases;
				const cleaned = Array.isArray(phases)
					? {
							...raw,
							details: {
								...raw.details,
								phases: phases.filter(
									(phase) =>
										typeof phase === "object" &&
										phase !== null &&
										Array.isArray((phase as { tasks?: unknown }).tasks),
								),
							},
						}
					: raw;
				const settled = { ...cleaned, isError };
				if (binding?.kind === "tool") {
					binding.component.updateResult(settled, false, id);
				} else if (binding?.kind === "read") {
					binding.group.updateResult(settled, false, id);
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
				booted.transcript.presentAssistantText(event.text ?? "");
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

	await Bun.sleep(80);
	const statsRows = booted.sentMessages.flatMap(({ message }) =>
		visibleRows(
			booted.renderers.get(String(message.customType))?.(
				{ details: message.details },
				{ expanded: false },
				booted.context.ui.theme,
			),
		),
	);
	const outcome: ReplayOutcome = {
		rows: [...visibleRows(booted.transcript), ...statsRows],
		carriers: [
			...booted.appendedEntries,
			...booted.sentMessages.map(({ message }) => ({
				customType: String(message.customType),
				data: message.details,
			})),
		].map((entry) => ({
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
