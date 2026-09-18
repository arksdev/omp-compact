/**
 * Shared typed stock-host test loader for the omp-compact suites.
 *
 * Single boundary for everything a test suite needs from the pinned stock
 * host: the `OMP_STOCK_BIN` presence check (explicit missing-binary error),
 * the pi-coding-agent package-root derivation, the stock
 * component/theme/transcript module imports, direct production plugin
 * module loading (no staged source copies — the repository pins
 * `@oh-my-pi/*` in its root `node_modules`), and isolated generated
 * settings/config state under `.omp-compact-test`.
 *
 * The component instance interfaces mirror the pinned OMP 17.4.2 declarations
 * (`node_modules/@oh-my-pi/pi-coding-agent/dist/types/modes/components/*`)
 * so the test boundary is the same API the plugin adapts, not a hand-copied
 * subset: `ToolExecutionComponent`'s ctor takes an optional `toolCallId`,
 * `ReadToolGroupComponent` exposes `setExpanded`/`setArgsComplete`, and
 * `TranscriptContainer` exposes `clear`, the viewport render, live row
 * count, history batches and block lifecycle states plus container-owned
 * tool-activity forwarding.
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

const binary = process.env.OMP_STOCK_BIN;
const sourceDir = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../..",
	".omp-plugin",
);

export interface Renderable {
	render(width: number): readonly string[];
}

export interface ToolExecutionInstance extends Renderable {
	updateArgs(args: unknown, toolCallId?: string): void;
	updateResult(result: unknown, isPartial: boolean, toolCallId?: string): void;
	setArgsComplete(toolCallId?: string): void;
	setExpanded(expanded: boolean): void;
	setToolActivityVisible(visible: boolean): void;
	seal(): void;
	isTranscriptBlockFinalized(): boolean;
}

export interface ReadGroupInstance extends Renderable {
	updateArgs(
		args: { path?: string; file_path?: string },
		toolCallId?: string,
	): void;
	updateResult(result: unknown, isPartial?: boolean, toolCallId?: string): void;
	renameEntry(oldId: string, newId: string): void;
	removeEntry(id: string): boolean;
	setArgsComplete(toolCallId?: string): void;
	setExpanded(expanded: boolean): void;
}

export interface TranscriptInstance extends Renderable {
	addChild(child: unknown): void;
	children: unknown[];
	clear(): void;
	/**
	 * Optional capability: hosts check presence before patching (see
	 * host-adapter's capability guard), and seam transcripts may lack it.
	 */
	disposeChildren?(): void;
	setToolActivityVisible(visible: boolean): void;
	/**
	 * Optional capability: hosts check presence before patching (see
	 * host-adapter's capability guard), and seam transcripts may lack it.
	 */
	canRemoveBlock?(component: unknown): boolean;
	renderViewport(
		width: number,
		rows: number,
		frame: { tick: number; now: number },
	): readonly string[];
	liveRowCount(width: number): number;
	peekFinalizedBatch(
		width: number,
		capacity: number,
	): { id: number; rows: readonly string[] } | undefined;
	acknowledgeFinalizedBatch(id: number): void;
	blockStates(): readonly ("active" | "settled" | "committed")[];
}

export interface ToolExecutionComponentOptions {
	showImages: boolean;
	useBuiltInRenderer: boolean;
	showCompletedActivity?: () => boolean;
}

export interface HostModules {
	plugin: (pi: unknown) => void;
	ToolExecutionComponent: new (
		toolName: string,
		args: unknown,
		options: ToolExecutionComponentOptions | undefined,
		tool: unknown,
		ui: unknown,
		cwd?: string,
		toolCallId?: string,
	) => ToolExecutionInstance;
	ReadToolGroupComponent: new (options?: {
		showContentPreview?: boolean;
	}) => ReadGroupInstance;
	TranscriptContainer: new () => TranscriptInstance;
	ContainerBase: new () => {
		addChild(child: unknown): void;
		render(width: number): readonly string[];
	};
	/**
	 * The six leaves the plugin recovers by scraping instead of patching
	 * (`render-scrape.ts`), each behind a structural fingerprint in
	 * `host-surface.ts`. Constructor shapes are the live 18.0.10 ones; a host
	 * that changes them fails to compile the canary rather than silently
	 * falling back to native rendering in a session.
	 */
	TtsrNotificationComponent: new (
		rules: readonly unknown[],
	) => object;
	TodoReminderComponent: new (
		todos: readonly unknown[],
		attempt: number,
		maxAttempts: number,
	) => object;
	BashExecutionComponent: new (
		command: string,
		ui: unknown,
		excludeFromContext?: boolean,
	) => object;
	EvalExecutionComponent: new (
		code: string,
		ui: unknown,
		excludeFromContext?: boolean,
		language?: string,
	) => object;
	SkillMessageComponent: new (message: unknown) => object;
	LateDiagnosticsMessageComponent: new (files: readonly unknown[]) => object;
	getTheme: () => {
		fg(color: string, text: string): string;
		getFgAnsi(color: string): string;
	};
	initTheme: () => Promise<void>;
	/** `/theme` swap on the same theme module instance `getTheme()` reads. */
	setTheme: (name: string) => Promise<{ success: boolean; error?: string }>;
	/** Name of the active theme, or undefined before the first init/swap. */
	getCurrentThemeName: () => string | undefined;
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

/** Generated temp dir beside the root node_modules directory. */
export function stockTempDir(): string {
	return resolve(dirname(binary ?? ""), "..", "..", ".omp-compact-test");
}

/** Isolated per-suite settings/config file path under the runtime temp dir. */
export function stockSettingsPath(fileName: string): string {
	return join(stockTempDir(), fileName);
}

/**
 * Files this process generated under `stockTempDir()`, so a suite can drop
 * exactly its own output. The directory itself is shared: `bun test` runs
 * several files per process and several processes per machine, and fixed
 * names like `config-compact.json` are written by other suites — removing
 * the directory would delete a sibling's live config mid-run.
 */
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
 * Removes the settings files this process wrote through
 * `writeStockSettings`. Call from an `afterAll` in the test file itself:
 * a hook registered here would bind to whichever file imported this module
 * first and fire once for the whole process, leaving the rest behind.
 */
export function cleanupStockSettings(): void {
	for (const path of generatedSettings) rmSync(path, { force: true });
	generatedSettings.clear();
}

/**
 * Directly loads one production plugin module from the source tree (no
 * staging copies). The per-call cache-bust label gives every suite a fresh
 * module instance, exactly like the previous temp-copy imports did.
 */
export async function loadStockPlugin<T = Record<string, unknown>>(
	entry: string,
	label = "stock",
): Promise<T> {
	const href = pathToFileURL(join(sourceDir, entry)).href;
	return (await import(`${href}?${label}-${Date.now()}`)) as T;
}

/** Loads the stock host modules (components/theme/transcript) only. */
export async function loadStockHost(): Promise<Omit<HostModules, "plugin">> {
	const root = packageRoot();
	const resolveHostModule = (agentPath: string, tuiPath: string): string => {
		const agentFull = join(root, agentPath);
		if (existsSync(agentFull)) return agentFull;
		const tuiFull = resolve(root, "..", "pi-tui", tuiPath);
		if (existsSync(tuiFull)) return tuiFull;
		throw new Error(`Cannot find host module at ${agentFull} or ${tuiFull}`);
	};
	const [
		componentModule,
		themeModule,
		readGroupModule,
		transcriptModule,
		ttsrModule,
		todoReminderModule,
		bashExecutionModule,
		evalExecutionModule,
		skillMessageModule,
		lateDiagnosticsModule,
	] = await Promise.all([
		import(
			pathToFileURL(
				resolveHostModule(
					"src/modes/components/tool-execution.ts",
					"src/chat/tool-execution.ts",
				),
			).href
		),
		import(
			pathToFileURL(
				resolveHostModule("src/modes/theme/theme.ts", "src/theme/theme.ts"),
			).href
		),
		import(
			pathToFileURL(
				resolveHostModule(
					"src/modes/components/read-tool-group.ts",
					"src/chat/read-tool-group.ts",
				),
			).href
		),
		import(
			pathToFileURL(
				resolveHostModule(
					"src/modes/components/transcript-container.ts",
					"src/chrome/transcript-container.ts",
				),
			).href
		),
		import(
			pathToFileURL(
				resolveHostModule(
					"src/modes/components/ttsr-notification.ts",
					"src/chat/ttsr-notification.ts",
				),
			).href
		),
		import(
			pathToFileURL(
				resolveHostModule(
					"src/modes/components/todo-reminder.ts",
					"src/chat/todo-reminder.ts",
				),
			).href
		),
		import(
			pathToFileURL(
				resolveHostModule(
					"src/modes/components/bash-execution.ts",
					"src/chat/bash-execution.ts",
				),
			).href
		),
		import(
			pathToFileURL(
				resolveHostModule(
					"src/modes/components/eval-execution.ts",
					"src/chat/eval-execution.ts",
				),
			).href
		),
		import(
			pathToFileURL(
				resolveHostModule(
					"src/modes/components/skill-message.ts",
					"src/chat/skill-message.ts",
				),
			).href
		),
		import(
			pathToFileURL(
				resolveHostModule(
					"src/modes/components/late-diagnostics-message.ts",
					"src/chat/late-diagnostics-message.ts",
				),
			).href
		),
	]);
	try {
		const hlPath = resolveHostModule(
			"src/tui/hyperlink.ts",
			"src/render/hyperlink.ts",
		);
		const hlModule = (await import(pathToFileURL(hlPath).href)) as {
			applyHyperlinkSetting?: (mode: string) => void;
		};
		hlModule.applyHyperlinkSetting?.("always");
	} catch {
		// Ignore if hyperlink module is absent.
	}
	return {
		ToolExecutionComponent: componentModule.ToolExecutionComponent,
		ReadToolGroupComponent: readGroupModule.ReadToolGroupComponent,
		TranscriptContainer: transcriptModule.TranscriptContainer,
		TtsrNotificationComponent: ttsrModule.TtsrNotificationComponent,
		TodoReminderComponent: todoReminderModule.TodoReminderComponent,
		BashExecutionComponent: bashExecutionModule.BashExecutionComponent,
		EvalExecutionComponent: evalExecutionModule.EvalExecutionComponent,
		SkillMessageComponent: skillMessageModule.SkillMessageComponent,
		LateDiagnosticsMessageComponent:
			lateDiagnosticsModule.LateDiagnosticsMessageComponent,
		ContainerBase: Object.getPrototypeOf(
			readGroupModule.ReadToolGroupComponent.prototype,
		).constructor,
		getTheme: () => themeModule.theme,
		initTheme: themeModule.initTheme,
		setTheme: themeModule.setTheme,
		getCurrentThemeName: themeModule.getCurrentThemeName,
	};
}

/** Full host boundary: plugin entry (index.ts) plus the stock modules. */
export async function loadHost(): Promise<HostModules> {
	const [pluginModule, host] = await Promise.all([
		loadStockPlugin<{ default: (pi: unknown) => void }>("index.ts"),
		loadStockHost(),
	]);
	return { plugin: pluginModule.default, ...host };
}
