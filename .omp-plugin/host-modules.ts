/**
 * The omp helpers the plugin needs beyond omp's extension API, loaded so that
 * a host which moved or dropped one turns off one feature instead of the
 * whole plugin.
 *
 * Since omp 19.2.0 every remaining root helper is an export of the package root,
 * `@oh-my-pi/pi-coding-agent`. A static value import of a missing export is
 * a link-time error: the plugin module graph fails to link and omp loads
 * nothing of the plugin. omp 18.17 did exactly that to
 * `unwrapHashlineHeaderPath`. The root is therefore loaded once with a
 * dynamic `import()`, and each feature checks it for the exports it reads. A
 * missing export records a disabled component, and its consumer falls back to
 * the narrowest loss (see each export below).
 *
 * The root itself cannot fail here: `index.ts` imports `settings` from it
 * statically, so a host without it loads none of the plugin. The rejection
 * fallback in `loadHostModule` is for a helper that leaves the root and gets
 * its own specifier (docs/CONTRIBUTING.md, "Host drift").
 *
 * The specifier stays a string literal: omp rewrites an extension's literal
 * `import()` targets to its bundled host modules, and a computed specifier
 * would bypass that rewrite inside a compiled omp binary.
 *
 * Type-only imports are erased at transpile time and need no fallback.
 */
import type * as HostRoot from "@oh-my-pi/pi-coding-agent";

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
		// The floor is package.json `engines.omp` and the tracker its
		// `bugs.url`; the plugin does not read package.json at runtime, so
		// host-modules.test.ts checks both against it. omp does not enforce
		// `engines.omp`, so an older omp loads the plugin and lands here.
		"Update omp to 19.2.0 or later and omp-compact to its latest release, or report it at https://github.com/arksdev/omp-compact/issues",
	].join("\n");
}

/**
 * The host module `load` resolves to when it loads and carries every export
 * in `symbols`; otherwise `undefined`, with one disabled-component record per
 * missing export appended to `into` (the process registry by default). The
 * namespace itself is returned, so live bindings (omp's `theme`) stay live;
 * its type shows only `symbols`, so a feature cannot read an export it did
 * not check. Several features may pass the same pending `load()` result:
 * each checks only its own `symbols`.
 */
export async function loadHostModule<
	M extends object,
	K extends keyof M & string,
>(
	component: string,
	specifier: string,
	load: () => Promise<M>,
	symbols: readonly K[],
	into: DisabledComponent[] = disabled,
): Promise<Pick<M, K> | undefined> {
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
// missing export disables only the feature that lists it. `HOST_ROOT` names
// the literal `import()` specifier in the warning; keep the two equal.
const HOST_ROOT = "@oh-my-pi/pi-coding-agent";
const hostRoot: Promise<typeof HostRoot> = import("@oh-my-pi/pi-coding-agent");
const rootFeature = <K extends keyof typeof HostRoot & string>(
	component: string,
	symbols: readonly K[],
): Promise<Pick<typeof HostRoot, K> | undefined> =>
	loadHostModule(component, HOST_ROOT, () => hostRoot, symbols);

/**
 * omp's `xd://` grammar as 19.0.1 declared it, typed here: 19.1.0 dropped
 * the declaration with the devices, so nothing checks this shape any more.
 */
type XdUrlParser = (input: string) => { name: string | null } | null;

/**
 * The omp release that replaced `xd://` devices with bash tool commands, as
 * its lowest prerelease: a 19.1.0 beta or nightly has dropped them too.
 */
const XD_DEVICES_RETIRED_IN = "19.1.0-0";

/**
 * Whether an omp reporting `version` has no `xd://` devices, so the missing
 * `parseXdUrl` turns nothing off. An unknown or malformed version counts as
 * older: `Bun.semver.order` throws on a non-semver string, and a throw here
 * would fail the module and take the whole plugin down.
 */
function xdDevicesRetired(version: unknown): boolean {
	if (typeof version !== "string") return false;
	try {
		return Bun.semver.order(version, XD_DEVICES_RETIRED_IN) >= 0;
	} catch {
		return false;
	}
}

/**
 * The `xd://` grammar from `load`, checked like any other feature, except
 * that on an omp at `version` that retired the devices its absence records
 * nothing into `into`.
 */
export function loadXdGrammar(
	version: unknown,
	load: () => Promise<{ VERSION?: string; parseXdUrl?: XdUrlParser }>,
	into: DisabledComponent[] = disabled,
): Promise<{ parseXdUrl?: XdUrlParser } | undefined> {
	return loadHostModule(
		"xd:// device rows",
		HOST_ROOT,
		load,
		["parseXdUrl"],
		xdDevicesRetired(version) ? [] : into,
	);
}

const { VERSION: hostVersion } = await hostRoot;

const [spansRoot, xdRoot, settingsRoot, hashlineRoot] = await Promise.all([
	rootFeature("styled compact rows and the clickable stats row", ["ansiSpans"]),
	loadXdGrammar(hostVersion, () => hostRoot),
	rootFeature("the transcript-presenters setting hint", [
		"cfgExtensionTranscriptPresenters",
	]),
	rootFeature("hashline header paths in the write audit", [
		"unwrapHashlineHeaderPath",
	]),
]);

/**
 * omp's ANSI-to-spans conversion, or `undefined`: rows then reach omp as
 * plain text and the stats row draws as rendered lines without its click.
 */
export const nativeSpans = spansRoot;

/**
 * omp's `xd://` grammar, or `undefined`: a device write then reads as a
 * `write` of its `xd://` path, and its display choice is the `write` tool's.
 * omp 19.1.0 and later have neither the grammar nor the devices.
 */
export const parseXdUrl: XdUrlParser | undefined = xdRoot?.parseXdUrl;

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
