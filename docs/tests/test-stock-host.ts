/**
 * Shared typed stock-host test loader for the omp-compact suites.
 *
 * Single boundary for everything a test suite needs from the pinned stock
 * host: the `OMP_STOCK_BIN` presence check (explicit missing-binary error),
 * the pi-coding-agent package-root derivation, a real `Transcript` +
 * `TranscriptPresenter` from `@oh-my-pi/pi-coding-agent`, direct production
 * plugin module loading, and isolated generated settings/config state under
 * `.omp-compact-test`.
 *
 * Test scaffolding only — no production code is imported at module load.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	ExtensionRender,
	ExtensionTheme,
} from "@oh-my-pi/pi-coding-agent";
import type { JSXNode, Signal, UiNode } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";

const binary = process.env.OMP_STOCK_BIN;
const sourceDir = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../..",
	".omp-plugin",
);

export type { ExtensionTheme };

export interface Renderable {
	render(width: number): readonly string[];
}

export interface PendingToolHandle extends Renderable {
	updateArgs(args: unknown, toolCallId?: string): void;
	updateResult(result: unknown, isPartial?: boolean, toolCallId?: string): void;
	setArgsComplete(toolCallId?: string): void;
	setExpanded(expanded: boolean): void;
	seal(): void;
	rename(newId: string): void;
	removeEntry?(id: string): boolean;
}

export interface ExecRunHandle {
	record(recorded: unknown): void;
}

export interface StockTranscript extends Renderable {
	readonly length: number;
	setPresenters(presenters: readonly never[]): void;
	refresh(ids?: readonly string[]): void;
	clear(): void;
	setExpanded(expanded: boolean): void;
	setToolActivityVisible(visible: boolean): void;
	presentToolCall(spec: {
		id: string;
		name: string;
		args: unknown;
		cwd?: string;
	}): PendingToolHandle;
	presentReadGroup(): PendingToolHandle;
	presentMessage(message: unknown): void;
	presentExecRun(
		run: unknown,
		options?: { deferred?: boolean; recorded?: unknown },
	): ExecRunHandle;
	presentTtsr(rules: readonly unknown[]): void;
	presentTodoReminder(
		todos: readonly unknown[],
		attempt: number,
		maxAttempts: number,
	): void;
	presentAssistantText(text: string): void;
	dispose(): void;
}

export interface HostModules {
	plugin: (pi: unknown) => void;
	createTranscript: (options?: {
		cwd?: string;
		renderer?: (
			customType: string,
		) => ((...args: never[]) => ExtensionRender | undefined) | undefined;
	}) => StockTranscript;
	ExecRun: new (options: {
		kind: "bash" | "eval";
		source: string;
		language?: "python" | "js";
		excluded?: boolean;
	}) => {
		appendOutput(chunk: string): void;
		setComplete(
			exitCode: number | undefined,
			cancelled: boolean,
			completion?: { output?: string },
		): void;
	};
	initTheme: () => Promise<void>;
	/** `/theme` swap on the same theme module instance `currentTheme()` reads. */
	setTheme: (name: string) => Promise<{ success: boolean; error?: string }>;
	/** Name of the active theme, or undefined before the first init/swap. */
	getCurrentThemeName: () => string | undefined;
	messageBlock: (message: unknown) => unknown;
	extensionTheme: () => ExtensionTheme;
	renderUiNode: (node: UiNode, width: number) => readonly string[];
}

/** True when the pinned stock binary is on the environment. */
export function isStockHostPresent(): boolean {
	return binary !== undefined;
}

/** Explicit missing-binary error, then the pinned pi-coding-agent root. */
function packageRoot(): string {
	if (!binary) throw new Error("OMP_STOCK_BIN is required");
	return resolve(dirname(binary), "..", "@oh-my-pi", "pi-coding-agent");
}

/** Version declared by the package selected through OMP_STOCK_BIN. */
export function stockHostVersion(): string {
	const manifest = JSON.parse(
		readFileSync(join(packageRoot(), "package.json"), "utf8"),
	) as { version?: unknown };
	if (typeof manifest.version !== "string")
		throw new Error("pinned stock host package has no version");
	return manifest.version;
}

/**
 * Transcript specs of the schemes the pinned host's `InternalUrlRouter`
 * registers itself. Stock `readArgsCollapseIntoGroup` decides a read's card
 * shape from exactly this registry.
 */
export async function stockInternalUrlSpecs(): Promise<
	ReadonlyMap<string, { compactTranscript?: boolean }>
> {
	const { InternalUrlRouter } = (await import(
		pathToFileURL(join(packageRoot(), "src/internal-urls/router.ts")).href
	)) as {
		InternalUrlRouter: new () => {
			specs(): ReadonlyMap<string, { compactTranscript?: boolean }>;
		};
	};
	return new InternalUrlRouter().specs();
}

/** Generated temp dir beside the root node_modules directory. */
export function stockTempDir(): string {
	return resolve(dirname(binary ?? ""), "..", "..", ".omp-compact-test");
}

/** Isolated per-suite settings/config file path under the runtime temp dir. */
export function stockSettingsPath(fileName: string): string {
	return join(stockTempDir(), fileName);
}

const generatedSettings = new Set<string>();

/** Writes an isolated boot-settings JSON file (mkdir -p implied). */
export function writeStockSettings(
	settings: unknown,
	fileName: string,
): string {
	const path = stockSettingsPath(fileName);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(settings, null, 2));
	generatedSettings.add(path);
	return path;
}

/**
 * Removes the settings files this process wrote through `writeStockSettings`.
 */
export function cleanupStockSettings(): void {
	for (const path of generatedSettings) rmSync(path, { force: true });
	generatedSettings.clear();
}

/**
 * Directly loads one production plugin module from the source tree.
 */
export async function loadStockPlugin<T = Record<string, unknown>>(
	entry: string,
	label = "stock",
): Promise<T> {
	const href = pathToFileURL(join(sourceDir, entry)).href;
	return (await import(`${href}?${label}-${Date.now()}`)) as T;
}

let renderTargetImpl: (target: unknown, width: number) => readonly string[] =
	() => [];

export function renderStockOutput(
	target: unknown,
	width = 120,
): readonly string[] {
	if (!target || typeof target !== "object") return [];
	if ("render" in target && typeof target.render === "function") {
		return (target as Renderable).render(width);
	}
	return renderTargetImpl(target, width);
}
/** Loads the stock host modules (transcript/components/theme) only. */
export async function loadStockHost(): Promise<Omit<HostModules, "plugin">> {
	const root = packageRoot();
	const resolveHostTui = (specifier: string): string =>
		Bun.resolveSync(specifier, root);
	const resolveHost = (relPath: string): string => {
		const full = join(root, relPath);
		if (existsSync(full)) return full;
		throw new Error(`Cannot find host module at ${full}`);
	};
	const [
		piTuiModule,
		piTuiRenderModule,
		piTuiThemeModule,
		interactiveTranscript,
		shellModule,
		presentedModule,
		noticesModule,
		execRunModule,
		presentationModule,
		themeModule,
		renderOutputModule,
	] = await Promise.all([
		import(pathToFileURL(resolveHostTui("@oh-my-pi/pi-tui")).href),
		import(pathToFileURL(resolveHostTui("@oh-my-pi/pi-tui/term/render")).href),
		import(
			pathToFileURL(resolveHostTui("@oh-my-pi/pi-tui/theme/runtime")).href
		),
		import(
			pathToFileURL(resolveHost("src/modes/interactive/transcript.tsx")).href
		),
		import(pathToFileURL(resolveHost("src/ui/shell/index.ts")).href),
		import(
			pathToFileURL(
				resolveHost("src/ui/transcript/figures/presented-block.tsx"),
			).href
		),
		import(
			pathToFileURL(resolveHost("src/ui/transcript/messages/notices.tsx")).href
		),
		import(pathToFileURL(resolveHost("src/ui/transcript/exec-run.tsx")).href),
		import(
			pathToFileURL(
				resolveHost("src/session/transcript/transcript-presentation.ts"),
			).href
		),
		import(pathToFileURL(resolveHost("src/ui/theme/service.ts")).href),
		import(
			pathToFileURL(resolveHost("src/ui/extensions/render-output.tsx")).href
		),
		import(pathToFileURL(resolveHost("src/ui/styles/index.ts")).href),
	]);

	const { isUiNode, jsx, signal } = piTuiModule as {
		isUiNode: (value: unknown) => value is UiNode;
		jsx: (type: unknown, props: Record<string, unknown>) => JSXNode;
		signal: <T>(initial: T) => Signal<T>;
	};
	const { renderBlock } = piTuiRenderModule as {
		renderBlock: (
			node: UiNode,
			width: number,
			options: { theme: Theme },
		) => { rows: readonly string[] };
	};
	const { currentTheme } = piTuiThemeModule as {
		currentTheme: () => Theme;
	};
	const renderNode = (node: UiNode, width: number): readonly string[] =>
		renderBlock(node, width, { theme: currentTheme() }).rows;
	renderTargetImpl = (target, width) =>
		isUiNode(target) ? renderNode(target, width) : [];
	const { messageBlock } = presentationModule as {
		messageBlock: (message: unknown) => unknown;
	};
	const { TranscriptPresenter } = interactiveTranscript as {
		TranscriptPresenter: new (
			host: unknown,
		) => {
			setPresenters(presenters: readonly never[]): void;
			refreshPresentation(ids?: readonly string[]): void;
			presentationOf(block: unknown): unknown;
			presentToolCall(spec: {
				id: string;
				name: string;
				args: unknown;
				cwd?: string;
			}): {
				block: unknown;
				call?: {
					setExpanded(expanded: boolean): void;
					setArgsComplete(): void;
				};
				updateArgs(args: unknown): void;
				updateResult(result: unknown, partial: boolean): void;
				seal(): void;
				rename?(newId: string): void;
			};
			presentReadGroup(): {
				block: unknown;
				group?: {
					setExpanded(expanded: boolean): void;
					setArgsComplete(id?: string): void;
					renameEntry(oldId: string, newId: string): void;
					removeEntry(id: string): boolean;
				};
				updateArgs(args: unknown, id?: string): void;
				updateResult(result: unknown, partial: boolean, id?: string): void;
				seal(): void;
			};
			presentMessage(message: unknown): unknown;
			presentExecRun(
				run: unknown,
				options?: { deferred?: boolean; recorded?: unknown },
			): ExecRunHandle;
			dispose(): void;
		};
	};
	const { Transcript, ViewList } = shellModule as {
		Transcript: new () => {
			readonly nodes: () => readonly UiNode[];
			append(
				factory: () => JSXNode,
				options?: { compact?: () => boolean; spacedBelow?: boolean },
			): unknown;
			clear(): void;
			dispose(): void;
		};
		ViewList: new () => { clear(): void; push(...entries: never[]): void };
	};
	const { PresentedBlock } = presentedModule as {
		PresentedBlock: (props: {
			block: unknown;
			presentation: () => unknown;
			expanded: () => boolean;
			onToggle: (collapsed: boolean) => void;
			activityVisible: () => boolean;
			children: JSXNode;
		}) => JSXNode;
	};
	const { TtsrNotice, TodoReminder } = noticesModule as {
		TtsrNotice: (props: {
			rules: readonly unknown[];
			expanded: () => boolean;
		}) => JSXNode;
		TodoReminder: (props: {
			todos: readonly unknown[];
			attempt: number;
			maxAttempts: number;
		}) => JSXNode;
	};
	const { ExecRun } = execRunModule as HostModules["ExecRun"] extends infer T
		? { ExecRun: T }
		: never;
	const { initTheme, setTheme, getCurrentThemeName } = themeModule as {
		initTheme: () => Promise<void>;
		setTheme: (name: string) => Promise<{ success: boolean; error?: string }>;
		getCurrentThemeName: () => string | undefined;
	};
	const { extensionTheme } = renderOutputModule as {
		extensionTheme: (theme: Theme) => ExtensionTheme;
	};

	const createTranscript: HostModules["createTranscript"] = (options = {}) => {
		const transcript = new Transcript();
		const expanded = signal(false);
		const hideToolActivity = signal(false);
		const pendingShellRuns = new ViewList();
		const presenter = new TranscriptPresenter({
			shell: {
				transcript,
				host: undefined,
				size: () => ({ columns: 120, rows: 40 }),
			},
			viewSession: { hasBuiltInTool: () => true },
			display: {
				toolOutputExpanded: expanded,
				hideToolActivity,
				hideThinking: signal(false),
				proseOnlyThinking: signal(false),
				expandThinkingBlocks: signal(false),
				showImages: signal(false),
				tableCharts: signal(false),
				shellVisualization: signal(false),
				mcpMarkdown: signal(false),
				readPreview: signal(false),
			},
			pendingShellRuns,
			linkTargets: () => new Map(),
			messages: {
				expanded,
				activityVisible: () => !hideToolActivity(),
				advisorCollapsedLines: () => 0,
				renderer: (customType: string) => options.renderer?.(customType),
				onRenderError: () => {},
				imageLinks: () => undefined,
				skillPath: () => undefined,
				actions: () => false,
				hour12: () => undefined,
				promptZones: () => false,
				magicKeywords: () => [],
				onUserAction: () => {},
			},
		});

		const wrapPending = (
			pending:
				| ReturnType<typeof presenter.presentToolCall>
				| ReturnType<typeof presenter.presentReadGroup>,
		): PendingToolHandle => {
			return {
				updateArgs: (args, id) => pending.updateArgs(args, id),
				updateResult: (result, isPartial = false, id) =>
					pending.updateResult(result, isPartial, id),
				setArgsComplete: (id) => {
					if ("call" in pending && pending.call) pending.call.setArgsComplete();
					else if ("group" in pending && pending.group)
						pending.group.setArgsComplete(id);
				},
				setExpanded: (value) => {
					if ("call" in pending && pending.call)
						pending.call.setExpanded(value);
					else if ("group" in pending && pending.group)
						pending.group.setExpanded(value);
				},
				seal: () => pending.seal(),
				rename: (newId) => {
					if ("rename" in pending && typeof pending.rename === "function") {
						pending.rename(newId);
					}
				},
				removeEntry:
					"group" in pending && pending.group
						? (id) => pending.group?.removeEntry(id) ?? false
						: undefined,
				render: (width) =>
					transcript.nodes().flatMap((node) => renderNode(node, width)),
			};
		};

		let nextEventId = 1;
		return {
			get length() {
				return transcript.nodes().length;
			},
			setPresenters: (presenters) => presenter.setPresenters(presenters),
			refresh: (ids) => presenter.refreshPresentation(ids),
			clear: () => transcript.clear(),
			setExpanded: (value) => expanded.set(value),
			setToolActivityVisible: (visible) => hideToolActivity.set(!visible),
			presentToolCall: (spec) =>
				wrapPending(
					presenter.presentToolCall({
						cwd: options.cwd,
						...spec,
					}),
				),
			presentReadGroup: () => wrapPending(presenter.presentReadGroup()),
			presentMessage: (message) => {
				presenter.presentMessage(message);
			},
			presentExecRun: (run, runOptions) =>
				presenter.presentExecRun(run, runOptions),
			presentTtsr: (rules) => {
				const block = {
					type: "event" as const,
					id: `event-${nextEventId++}`,
					event: { type: "ttsr_triggered" as const, rules },
				};
				transcript.append(() =>
					jsx(PresentedBlock, {
						block,
						presentation: () => presenter.presentationOf(block),
						expanded: () => expanded(),
						onToggle: () => {},
						activityVisible: () => !hideToolActivity(),
						children: jsx(TtsrNotice, {
							rules,
							expanded: () => expanded(),
						}),
					}),
				);
			},
			presentTodoReminder: (todos, attempt, maxAttempts) => {
				const block = {
					type: "event" as const,
					id: `event-${nextEventId++}`,
					event: {
						type: "todo_reminder" as const,
						todos,
						attempt,
						maxAttempts,
					},
				};
				transcript.append(() =>
					jsx(PresentedBlock, {
						block,
						presentation: () => presenter.presentationOf(block),
						expanded: () => expanded(),
						onToggle: () => {},
						activityVisible: () => !hideToolActivity(),
						children: jsx(TodoReminder, {
							todos,
							attempt,
							maxAttempts,
						}),
					}),
				);
			},
			presentAssistantText: (text) => {
				transcript.append(() => jsx("text", { text }), { spacedBelow: true });
			},
			render: (width) =>
				transcript.nodes().flatMap((node) => renderNode(node, width)),
			dispose: () => {
				presenter.dispose();
				transcript.dispose();
			},
		};
	};

	return {
		createTranscript,
		ExecRun,
		initTheme,
		setTheme,
		getCurrentThemeName,
		messageBlock,
		extensionTheme: () => extensionTheme(currentTheme()),
		renderUiNode: (node, width) =>
			isUiNode(node) ? renderNode(node, width) : [],
	};
}

/** Loads both the stock host modules and the production plugin factory. */
export async function loadStockPluginAndHost(
	label = "stock",
): Promise<HostModules> {
	const [host, pluginModule] = await Promise.all([
		loadStockHost(),
		loadStockPlugin<{ default?: (pi: unknown) => void }>("index.ts", label),
	]);
	if (typeof pluginModule.default !== "function") {
		throw new Error("plugin default export missing");
	}
	return { ...host, plugin: pluginModule.default };
}
