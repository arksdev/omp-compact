/**
 * The omp helpers the plugin needs beyond omp's extension API, loaded so that
 * a host which moved or dropped one turns off one feature instead of the
 * whole plugin.
 *
 * Since omp 18.18.9 every one of them is an export of the package root,
 * `@oh-my-pi/pi-coding-agent`. A static value import of a missing export is
 * a link-time error: the plugin module graph fails to link and omp loads
 * nothing of the plugin. omp 18.17 did exactly that to
 * `unwrapHashlineHeaderPath`. The root is therefore loaded once with a
 * dynamic `import()` and a rejection fallback, and each feature checks it for
 * the exports it reads. A missing export records a disabled component, and
 * its consumer falls back to the narrowest loss (see each export below).
 *
 * The specifier stays a string literal: omp rewrites an extension's literal
 * `import()` targets to its bundled host modules, and a computed specifier
 * would bypass that rewrite inside a compiled omp binary.
 *
 * Type-only imports are erased at transpile time and need no fallback.
 */
import type * as HostRoot from "@oh-my-pi/pi-coding-agent";

/** Where every helper below comes from. */
const HOST_ROOT = "@oh-my-pi/pi-coding-agent";

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
 * The warning that names every disabled feature in `entries`, or `undefined`
 * when there is none. One line per feature, with the exports behind it,
 * grouped by the specifier they were looked up in.
 */
export function disabledComponentsWarning(
	entries: readonly DisabledComponent[],
): string | undefined {
	if (entries.length === 0) return undefined;
	const byComponent = new Map<string, Map<string, string[]>>();
	for (const entry of entries) {
		const bySpecifier = byComponent.get(entry.component) ?? new Map();
		const symbols = bySpecifier.get(entry.specifier) ?? [];
		symbols.push(entry.symbol);
		bySpecifier.set(entry.specifier, symbols);
		byComponent.set(entry.component, bySpecifier);
	}
	const lines = [...byComponent].map(([component, bySpecifier]) => {
		const sources = [...bySpecifier].map(
			([specifier, symbols]) => `${symbols.join(", ")} from ${specifier}`,
		);
		return `- ${component} (${sources.join("; ")})`;
	});
	return [
		"omp-compact: this omp version lacks helpers the plugin uses; these features are off:",
		...lines,
		// Same tracker as package.json `bugs.url`; the plugin does not read
		// package.json at runtime, so a repository move must update both.
		"Update omp-compact, or report it at https://github.com/arksdev/omp-compact/issues",
	].join("\n");
}

/**
 * The host module `load` resolves to when it loads and carries every export
 * in `symbols`; otherwise `undefined`, with one disabled-component record per
 * missing export appended to `into` (the process registry by default). The
 * namespace itself is returned, so live bindings (omp's `theme`) stay live.
 * Several features may pass the same pending `load()` result: each checks
 * only its own `symbols`.
 */
export async function loadHostModule<M extends object>(
	component: string,
	specifier: string,
	load: () => Promise<M>,
	symbols: readonly (keyof M & string)[],
	into: DisabledComponent[] = disabled,
): Promise<M | undefined> {
	let module: M;
	try {
		module = await load();
	} catch (error) {
		const reason = `module did not load: ${error instanceof Error ? error.message : String(error)}`;
		for (const symbol of symbols)
			into.push({ component, specifier, symbol, reason });
		return undefined;
	}
	const missing = symbols.filter((symbol) => !(symbol in module));
	for (const symbol of missing)
		into.push({
			component,
			specifier,
			symbol,
			reason: "export not found",
		});
	return missing.length === 0 ? module : undefined;
}

// One load for every feature: each check below sees the same namespace, so a
// missing export disables only the feature that lists it.
const hostRoot: Promise<typeof HostRoot> = import("@oh-my-pi/pi-coding-agent");
const fromRoot = (): Promise<typeof HostRoot> => hostRoot;

const [dialogRoot, spansRoot, xdRoot, settingsRoot, hashlineRoot] =
	await Promise.all([
		loadHostModule("/compact-settings dialog", HOST_ROOT, fromRoot, [
			"formTheme",
			"editorKey",
			"editorKeys",
			"formatKeyHint",
			"getSettingsListTheme",
			"theme",
		]),
		loadHostModule(
			"styled compact rows and the clickable stats row",
			HOST_ROOT,
			fromRoot,
			["compactText", "rowsText", "styledSpans"],
		),
		loadHostModule("xd:// device rows", HOST_ROOT, fromRoot, ["parseXdUrl"]),
		loadHostModule(
			"the transcript-presenters setting hint",
			HOST_ROOT,
			fromRoot,
			["cfgExtensionTranscriptPresenters"],
		),
		loadHostModule(
			"hashline header paths in the write audit",
			HOST_ROOT,
			fromRoot,
			["unwrapHashlineHeaderPath"],
		),
	]);

/** What `/compact-settings` draws with: omp's settings-list chrome. */
export interface SettingsDialogHost {
	readonly formTheme: typeof HostRoot.formTheme;
	readonly editorKey: typeof HostRoot.editorKey;
	readonly editorKeys: typeof HostRoot.editorKeys;
	readonly formatKeyHint: typeof HostRoot.formatKeyHint;
	readonly getSettingsListTheme: typeof HostRoot.getSettingsListTheme;
	/** omp's active theme, read per call: omp swaps it on `/theme`. */
	theme(): typeof HostRoot.theme;
}

/**
 * omp's settings-list chrome, or `undefined` when any part is missing: the
 * dialog then does not open and warns instead.
 */
export const settingsDialogHost: SettingsDialogHost | undefined = dialogRoot
	? {
			formTheme: dialogRoot.formTheme,
			editorKey: dialogRoot.editorKey,
			editorKeys: dialogRoot.editorKeys,
			formatKeyHint: dialogRoot.formatKeyHint,
			getSettingsListTheme: dialogRoot.getSettingsListTheme,
			theme: () => dialogRoot.theme,
		}
	: undefined;

/**
 * omp's ANSI-to-spans conversion, or `undefined`: rows then reach omp as
 * plain text and the stats row draws as rendered lines without its click.
 */
export const nativeSpans:
	| Pick<typeof HostRoot, "compactText" | "rowsText" | "styledSpans">
	| undefined = spansRoot;

/**
 * omp's `xd://` grammar, or `undefined`: a device write then reads as a
 * `write` of its `xd://` path, and its display choice is the `write` tool's.
 */
export const parseXdUrl: typeof HostRoot.parseXdUrl | undefined =
	xdRoot?.parseXdUrl;

/**
 * omp's transcript-presenters setting, or `undefined`: the plugin then cannot
 * tell whether the setting is off and skips its hint.
 */
export const cfgExtensionTranscriptPresenters:
	| typeof HostRoot.cfgExtensionTranscriptPresenters
	| undefined = settingsRoot?.cfgExtensionTranscriptPresenters;

/**
 * omp's hashline header unwrapping, or `undefined`: the write audit then
 * takes the target path as written.
 */
export const unwrapHashlineHeaderPath:
	| typeof HostRoot.unwrapHashlineHeaderPath
	| undefined = hashlineRoot?.unwrapHashlineHeaderPath;
