/**
 * The omp helpers the plugin reaches outside omp's public entry points, loaded
 * so that a host which moved or dropped one turns off one feature instead of
 * the whole plugin.
 *
 * A static import of a deep host path (`@oh-my-pi/pi-tui/tools/xd-url`) is a
 * link-time dependency: when the file moves, the plugin module graph fails to
 * link and omp loads nothing of the plugin. omp 18.17 did exactly that to
 * `unwrapHashlineHeaderPath`. Each helper here is a dynamic `import()` with a
 * rejection fallback instead, checked for the exports the plugin reads. A
 * module that fails to load, or lacks an export, records a disabled
 * component, and its consumer falls back to the narrowest loss (see each
 * export below).
 *
 * Specifiers stay string literals: omp rewrites an extension's literal
 * `import()` targets to its bundled host modules, and a computed specifier
 * would bypass that rewrite inside a compiled omp binary.
 *
 * Type-only imports from these paths are erased at transpile time and need no
 * fallback.
 */
import type * as AgentRoot from "@oh-my-pi/pi-coding-agent";
import type * as ExtensionSettings from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import type * as FormTheme from "@oh-my-pi/pi-tui/chrome/form-theme";
import type * as KeybindingHints from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import type * as KeyHintFormat from "@oh-my-pi/pi-tui/key-hint-format";
import type * as NativeSpans from "@oh-my-pi/pi-tui/native/spans";
import type * as ThemeModule from "@oh-my-pi/pi-tui/theme/theme";
import type * as XdUrl from "@oh-my-pi/pi-tui/tools/xd-url";

/** One host export the plugin could not load, and the feature it turned off. */
export interface DisabledComponent {
	/** The plugin feature that is off, as the user knows it. */
	readonly component: string;
	/** The import specifier that failed. */
	readonly specifier: string;
	/** The export the feature needs from it. */
	readonly symbol: string;
	/** Why: the module failed to load, or loaded without the export. */
	readonly reason: string;
}

const disabled: DisabledComponent[] = [];

/** Every host export that failed to load in this process, in load order. */
export function disabledComponents(): readonly DisabledComponent[] {
	return disabled;
}

/**
 * The warning that names every disabled feature, or `undefined` when all
 * host helpers loaded. One line per feature, with the exports behind it.
 */
export function disabledComponentsWarning(): string | undefined {
	if (disabled.length === 0) return undefined;
	const byComponent = new Map<string, string[]>();
	for (const entry of disabled) {
		const symbols = byComponent.get(entry.component) ?? [];
		symbols.push(`${entry.symbol} from ${entry.specifier}`);
		byComponent.set(entry.component, symbols);
	}
	const lines = [...byComponent].map(
		([component, symbols]) => `- ${component} (${symbols.join(", ")})`,
	);
	return [
		"omp-compact: this omp version lacks helpers the plugin uses; these features are off:",
		...lines,
		"Update omp-compact, or report it at https://github.com/arksdev/omp-compact/issues",
	].join("\n");
}

/**
 * The host module `load` resolves to when it loads and carries every export
 * in `symbols`; otherwise `undefined`, with one disabled-component record per
 * export. The namespace itself is returned, so live bindings (omp's `theme`)
 * stay live.
 */
async function hostModule<M extends object>(
	component: string,
	specifier: string,
	load: () => Promise<M>,
	symbols: readonly (keyof M & string)[],
): Promise<M | undefined> {
	let module: M;
	try {
		module = await load();
	} catch (error) {
		const reason = `module did not load: ${error instanceof Error ? error.message : String(error)}`;
		for (const symbol of symbols)
			disabled.push({ component, specifier, symbol, reason });
		return undefined;
	}
	const missing = symbols.filter((symbol) => !(symbol in module));
	for (const symbol of missing)
		disabled.push({
			component,
			specifier,
			symbol,
			reason: "export not found",
		});
	return missing.length === 0 ? module : undefined;
}

const SETTINGS_DIALOG = "/compact-settings dialog";

const [
	formTheme,
	keybindingHints,
	keyHintFormat,
	themeModule,
	spans,
	xdUrl,
	extensionSettings,
	agentRoot,
] = await Promise.all([
	hostModule(
		SETTINGS_DIALOG,
		"@oh-my-pi/pi-tui/chrome/form-theme",
		(): Promise<typeof FormTheme> =>
			import("@oh-my-pi/pi-tui/chrome/form-theme"),
		["formTheme"],
	),
	hostModule(
		SETTINGS_DIALOG,
		"@oh-my-pi/pi-tui/chrome/keybinding-hints",
		(): Promise<typeof KeybindingHints> =>
			import("@oh-my-pi/pi-tui/chrome/keybinding-hints"),
		["editorKey", "editorKeys"],
	),
	hostModule(
		SETTINGS_DIALOG,
		"@oh-my-pi/pi-tui/key-hint-format",
		(): Promise<typeof KeyHintFormat> =>
			import("@oh-my-pi/pi-tui/key-hint-format"),
		["formatKeyHint"],
	),
	hostModule(
		SETTINGS_DIALOG,
		"@oh-my-pi/pi-tui/theme/theme",
		(): Promise<typeof ThemeModule> => import("@oh-my-pi/pi-tui/theme/theme"),
		["getSettingsListTheme", "theme"],
	),
	hostModule(
		"styled compact rows and the clickable stats row",
		"@oh-my-pi/pi-tui/native/spans",
		(): Promise<typeof NativeSpans> => import("@oh-my-pi/pi-tui/native/spans"),
		["compactText", "rowsText", "styledSpans"],
	),
	hostModule(
		"xd:// device rows",
		"@oh-my-pi/pi-tui/tools/xd-url",
		(): Promise<typeof XdUrl> => import("@oh-my-pi/pi-tui/tools/xd-url"),
		["parseXdUrl"],
	),
	hostModule(
		"the transcript-presenters setting hint",
		"@oh-my-pi/pi-coding-agent/extensibility/settings",
		(): Promise<typeof ExtensionSettings> =>
			import("@oh-my-pi/pi-coding-agent/extensibility/settings"),
		["cfgExtensionTranscriptPresenters"],
	),
	hostModule(
		"hashline header paths in the write audit",
		"@oh-my-pi/pi-coding-agent",
		(): Promise<typeof AgentRoot> => import("@oh-my-pi/pi-coding-agent"),
		["unwrapHashlineHeaderPath"],
	),
]);

/** What `/compact-settings` draws with: omp's settings-list chrome. */
export interface SettingsDialogHost {
	readonly formTheme: typeof FormTheme.formTheme;
	readonly editorKey: typeof KeybindingHints.editorKey;
	readonly editorKeys: typeof KeybindingHints.editorKeys;
	readonly formatKeyHint: typeof KeyHintFormat.formatKeyHint;
	readonly getSettingsListTheme: typeof ThemeModule.getSettingsListTheme;
	/** omp's active theme, read per call: omp swaps it on `/theme`. */
	theme(): ThemeModule.Theme;
}

/**
 * omp's settings-list chrome, or `undefined` when any part is missing: the
 * dialog then does not open and warns instead.
 */
export const settingsDialogHost: SettingsDialogHost | undefined =
	formTheme && keybindingHints && keyHintFormat && themeModule
		? {
				formTheme: formTheme.formTheme,
				editorKey: keybindingHints.editorKey,
				editorKeys: keybindingHints.editorKeys,
				formatKeyHint: keyHintFormat.formatKeyHint,
				getSettingsListTheme: themeModule.getSettingsListTheme,
				theme: () => themeModule.theme,
			}
		: undefined;

/**
 * omp's ANSI-to-spans conversion, or `undefined`: rows then reach omp as
 * plain text and the stats row draws as rendered lines without its click.
 */
export const nativeSpans: typeof NativeSpans | undefined = spans;

/**
 * omp's `xd://` grammar, or `undefined`: a device write then reads as a
 * `write` of its `xd://` path, and its display choice is the `write` tool's.
 */
export const parseXdUrl: typeof XdUrl.parseXdUrl | undefined =
	xdUrl?.parseXdUrl;

/**
 * omp's transcript-presenters setting, or `undefined`: the plugin then cannot
 * tell whether the setting is off and skips its hint.
 */
export const cfgExtensionTranscriptPresenters:
	| typeof ExtensionSettings.cfgExtensionTranscriptPresenters
	| undefined = extensionSettings?.cfgExtensionTranscriptPresenters;

/**
 * omp's hashline header unwrapping, or `undefined`: the write audit then
 * takes the target path as written.
 */
export const unwrapHashlineHeaderPath:
	| typeof AgentRoot.unwrapHashlineHeaderPath
	| undefined = agentRoot?.unwrapHashlineHeaderPath;
