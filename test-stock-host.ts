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
 * The component instance interfaces mirror the pinned 17.2.12 declarations
 * (`node_modules/@oh-my-pi/pi-coding-agent/dist/types/modes/components/*`)
 * so the test boundary is the same API the plugin adapts, not a hand-copied
 * subset: `ToolExecutionComponent`'s ctor takes an optional `toolCallId`,
 * `ReadToolGroupComponent` exposes `setExpanded`/`setArgsComplete`, and
 * `TranscriptContainer` exposes `clear`/`isBlockUncommitted`/
 * `renderViewportTail`.
 *
 * Test scaffolding only — no production code is imported at module load.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const binary = process.env.OMP_STOCK_BIN;
const sourceDir = dirname(fileURLToPath(import.meta.url));

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
	getTranscriptBlockSettledRows(): number;
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
	isBlockUncommitted?(component: unknown): boolean;
	isBlockInLiveRegion(component: unknown): boolean;
	renderViewportTail(width: number, maxRows: number): readonly string[];
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
	getTheme: () => {
		fg(color: string, text: string): string;
		getFgAnsi(color: string): string;
	};
	initTheme: () => Promise<void>;
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

/** Generated temp dir beside the root node_modules directory. */
export function stockTempDir(): string {
	return resolve(dirname(binary ?? ""), "..", "..", ".omp-compact-test");
}

/** Isolated per-suite settings/config file path under the runtime temp dir. */
export function stockSettingsPath(fileName: string): string {
	return join(stockTempDir(), fileName);
}

/** Writes an isolated boot-settings JSON file (mkdir -p implied). */
export function writeStockSettings(
	settings: unknown,
	fileName: string,
): string {
	const path = stockSettingsPath(fileName);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(settings, null, 2));
	return path;
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
	const [componentModule, themeModule, readGroupModule, transcriptModule] =
		await Promise.all([
			import(
				pathToFileURL(join(root, "src/modes/components/tool-execution.ts")).href
			),
			import(pathToFileURL(join(root, "src/modes/theme/theme.ts")).href),
			import(
				pathToFileURL(join(root, "src/modes/components/read-tool-group.ts"))
					.href
			),
			import(
				pathToFileURL(
					join(root, "src/modes/components/transcript-container.ts"),
				).href
			),
		]);
	return {
		ToolExecutionComponent: componentModule.ToolExecutionComponent,
		ReadToolGroupComponent: readGroupModule.ReadToolGroupComponent,
		TranscriptContainer: transcriptModule.TranscriptContainer,
		ContainerBase: Object.getPrototypeOf(
			readGroupModule.ReadToolGroupComponent.prototype,
		).constructor,
		getTheme: () => themeModule.theme,
		initTheme: themeModule.initTheme,
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
