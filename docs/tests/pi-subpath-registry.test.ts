import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import ts from "typescript";

/**
 * Value imports from `@oh-my-pi/*` must stay on the compiled-binary Pi
 * registry.
 *
 * THE FAILURE CLASS
 * -----------------
 * A compiled OMP binary does not resolve `@oh-my-pi/*` through the
 * filesystem. The legacy extension loader serves those specifiers from a
 * build-time registry: the keys collected by `collectBundledPiEntries`
 * (`node_modules/@oh-my-pi/pi-coding-agent/scripts/legacy-pi-virtual-module.ts:103-180`),
 * baked into the binary as the `BUNDLED_PI_MODULE_LOADERS` virtual module. A
 * specifier that is not a registry key fails at load time INSIDE the binary.
 *
 * In dev (uncompiled) runs the registry is bypassed and `Bun.resolveSync`
 * finds the same module in `node_modules`, so the identical source both loads
 * under `bun` and dies in production. That is exactly how the regression that
 * motivated this guard slipped through CI: `formatDuration` was imported from
 * `@oh-my-pi/pi-utils/format`. pi-utils' exports map (`.`, `./ar`, `./*`,
 * `./*.js`) serves that subpath only through the `./*` ROOT CATCH-ALL, and
 * the derivation deliberately skips root catch-alls (line 141, comment lines
 * 99-101: "root catch-alls stay out"), so the key is absent from the
 * registry and the marketplace plugin failed to load. Marketplace-cached
 * plugins carry no `node_modules` either — `cachePlugin` is a plain `fs.cp`
 * with no install step — so at load time the registry is the sole resolution
 * source.
 *
 * WHY A STRUCTURAL GUARD
 * ----------------------
 * An end-to-end test of the real mechanism would have to run plugin code
 * inside a compiled OMP binary (bunfs), i.e. build the host — bundling
 * pi-coding-agent, the six bundled Pi packages and the virtual-module plugin
 * from `scripts/legacy-pi-virtual-module.ts`. That is a host-repo build that
 * this repository cannot perform. A dev-mode dynamic `import()` of a subpath
 * exercises the node_modules fallback instead of the registry, so it passes
 * even for the known-broken specifier and proves nothing about the binary.
 * The honest substitute is this structural scan: REIMPLEMENT the registry
 * keys from the same inputs the build script reads (the installed package
 * manifests plus the source layout their exports point at), then statically
 * verify that every value import in plugin source is a key. Deriving at test
 * time — not hardcoding today's known-good subpaths — keeps the guard
 * sensitive to host-side exports-map changes, which `engines.omp >= 18.0.1`
 * permits without any edit in this repo; the current tree passing is then
 * evidence about the installed host, not a self-fulfilling table lookup.
 *
 * This is a source-scanning structural guard rather than a behavioral test,
 * a weaker form than this suite's usual observable-contract tests: it pins an
 * invariant of the load machinery, not a runtime behavior. The observable
 * contract (the plugin loads inside a compiled host) is not exercisable here,
 * so the next-best contract is "no value import may leave the registry
 * surface". The registry derivation itself is pinned against the known
 * regression shape (root and literal subpath in; root-catch-all subpath out)
 * so a bug in the reimplementation cannot silently weaken the guard.
 *
 * TYPE-ONLY IMPORTS ARE SEPARATE
 * ------------------------------
 * `import type` clauses and inline `type` specifiers are erased at transpile
 * time — they never reach the loader and cannot fail at runtime — so they are
 * exempt from the registry check. Today's type-only subpath sites are
 * `@oh-my-pi/pi-coding-agent/modes/theme/theme` and
 * `@oh-my-pi/pi-coding-agent/modes/theme/schema`; they stay exempt whether or
 * not the host ever registers them. The moment a value binding is added to
 * one of those imports, the statement stops being type-only and this suite
 * starts enforcing it.
 *
 * SCOPE
 * -----
 * Only `.omp-plugin` TypeScript sources are scanned (recursive `*.ts`
 * glob). `docs/tests/` is never loaded by the host, so widening the scan
 * there would blur the contract. Parsing uses the
 * repo's existing `typescript` devDependency — no new dependency is added.
 * The scanner classifies static `import` (including `import type` and inline
 * type specifiers), `export ... from`, dynamic `import()` and `require()`.
 * Today the plugin uses only static top-of-file `import` declarations
 * (verified 2026-08-26), but all four forms are handled so a future
 * introduction is caught without editing this file.
 *
 * The proof that the guard fires lives INSIDE this suite, on fixtures: the
 * pre-fix case is replayed from an in-memory source string and from a real
 * file under a temp directory, never by touching repo files. `bun:test`
 * throws when imported outside the test runner, so there is no standalone
 * proof harness to run.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const PLUGIN_SOURCE_DIR = path.join(REPO_ROOT, ".omp-plugin");
const PI_PACKAGES_DIR = path.join(REPO_ROOT, "node_modules", "@oh-my-pi");

/**
 * Monorepo dirs of the bundled packages, in the order upstream declares them
 * (legacy-pi-virtual-module.ts:17-24), mapped to the names of their installed
 * npm packages in `node_modules/@oh-my-pi/`. The dir-to-name mapping is not
 * derivable from installed artifacts (the monorepo layout is not shipped), so
 * it is stated here; the "all six roots registered" test below keeps it
 * honest, and a rename fails the derivation loudly.
 */
const BUNDLED_PACKAGE_DIRS = [
	"agent",
	"ai",
	"coding-agent",
	"natives",
	"tui",
	"utils",
] as const;

const INSTALLED_PACKAGE_NAMES: Record<
	(typeof BUNDLED_PACKAGE_DIRS)[number],
	string
> = {
	agent: "pi-agent-core",
	ai: "pi-ai",
	"coding-agent": "pi-coding-agent",
	natives: "pi-natives",
	tui: "pi-tui",
	utils: "pi-utils",
};

// Upstream skips these wildcard basenames (legacy-pi-virtual-module.ts:25-27,
// 66-73): `index` (aggregate files stay behind the literal/root surface),
// `worker-entry` (main-thread-unsafe) and test/spec/d/generated/bench files.
// Mirrored as Records to match the project's static-table convention.
const SKIPPED_WILDCARD_BASENAMES: Record<string, true> = { index: true };
const MAIN_THREAD_UNSAFE_WILDCARD_BASENAMES: Record<string, true> = {
	"worker-entry": true,
};

interface RegisteredPackageManifest {
	readonly name: string;
	readonly exports: Record<string, unknown>;
}

/**
 * Parse one `package.json` into the two fields the registry derivation needs.
 * The installed package layout must match what the build script sees in the
 * monorepo; a manifest that is not a JSON object or has no string `name`
 * throws rather than silently yielding an empty registry.
 */
async function readPiPackageManifest(
	packageDir: string,
	packageName: string,
): Promise<RegisteredPackageManifest> {
	const raw: unknown = await Bun.file(
		path.join(packageDir, "package.json"),
	).json();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(
			`${packageName}: package.json under ${PI_PACKAGES_DIR} is not a JSON object`,
		);
	}
	const manifest = raw as { name?: unknown; exports?: unknown };
	if (typeof manifest.name !== "string") {
		throw new Error(
			`${packageName}: package.json under ${PI_PACKAGES_DIR} has no string "name"`,
		);
	}
	const exportsValue = manifest.exports;
	const exports: Record<string, unknown> =
		typeof exportsValue === "object" &&
		exportsValue !== null &&
		!Array.isArray(exportsValue)
			? (exportsValue as Record<string, unknown>)
			: {};
	return { name: manifest.name, exports };
}

/**
 * The registry key of a wildcard export key: the literal part before `*` as
 * it appears in the import specifier, and the source pattern parts (mirrors
 * `parseWildcardPattern`, legacy-pi-virtual-module.ts:76-87).
 */
interface WildcardPattern {
	readonly exportPrefix: string;
	readonly exportSuffix: string;
	readonly sourcePrefix: string;
	readonly sourceSuffix: string;
}

function parseWildcardPattern(
	exportKey: string,
	sourcePattern: string,
): WildcardPattern | null {
	const exportStar = exportKey.indexOf("*");
	const sourceStar = sourcePattern.indexOf("*");
	if (exportStar === -1 || sourceStar === -1) return null;
	if (exportKey.indexOf("*", exportStar + 1) !== -1) return null;
	if (sourcePattern.indexOf("*", sourceStar + 1) !== -1) return null;
	if (!sourcePattern.startsWith("./")) return null;
	return {
		exportPrefix: exportKey.slice(2, exportStar),
		exportSuffix: exportKey.slice(exportStar + 1),
		sourcePrefix: sourcePattern.slice(2, sourceStar),
		sourceSuffix: sourcePattern.slice(sourceStar + 1),
	};
}

/**
 * The import target of one exports value: either a plain string or an object
 * with a string `import` property (mirrors `exportImportTarget`,
 * legacy-pi-virtual-module.ts:89-93).
 */
function exportImportTarget(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { import?: unknown }).import === "string"
	) {
		return (value as { import: string }).import;
	}
	return null;
}

/** Mirrors `isSafeWildcardBasename` (legacy-pi-virtual-module.ts:66-73). */
function isRegisteredWildcardBasename(basename: string): boolean {
	if (!basename || basename.startsWith(".") || basename.startsWith("_")) {
		return false;
	}
	if (SKIPPED_WILDCARD_BASENAMES[basename] === true) return false;
	if (MAIN_THREAD_UNSAFE_WILDCARD_BASENAMES[basename] === true) return false;
	return !/\.(test|spec|d|generated|bench)$/.test(basename);
}

/**
 * Reimplementation of `collectBundledPiEntries`
 * (legacy-pi-virtual-module.ts:103-180), restricted to the registry KEYS —
 * the import specifiers a compiled binary serves. Same rules, same order:
 *
 *   1. the bare package root is always registered (line 126);
 *   2. literal `./sub` export keys are registered verbatim (lines 128-133,
 *      skipping `.`, non-`./` keys and keys containing `*`);
 *   3. wildcard keys are expanded by globbing the source files their
 *      `import` target points at (lines 135-175), but only when the export
 *      prefix is neither `""` nor `"/"` (line 141) — ROOT CATCH-ALLS STAY
 *      OUT. That exclusion is the whole point of this suite: a subpath
 *      served only by `./*` (or `./*.js`) is usable under `bun` from
 *      node_modules and is NOT importable inside a compiled binary.
 *
 * Wildcard expansion details mirrored from upstream: recursive glob of the
 * source suffix (line 151), sorted matches (159), hidden/underscore segments
 * skipped (166), unsafe basenames skipped (167), export-path reconstruction
 * `exportPrefix + basename + exportSuffix` (168-170), and a missing source
 * directory silently yielding no keys (ENOENT, lines 172-174).
 * The `binding`/`seenBindings` bookkeeping is irrelevant to the key set and
 * is omitted.
 */
async function deriveBundledPiRegistry(): Promise<ReadonlySet<string>> {
	const keys = new Set<string>();
	for (const dir of BUNDLED_PACKAGE_DIRS) {
		const packageName = INSTALLED_PACKAGE_NAMES[dir];
		const packageDir = path.join(PI_PACKAGES_DIR, packageName);
		const { name, exports } = await readPiPackageManifest(
			packageDir,
			packageName,
		);
		keys.add(name);

		for (const exportKey in exports) {
			if (
				!exportKey.startsWith("./") ||
				exportKey === "." ||
				exportKey.includes("*")
			) {
				continue;
			}
			keys.add(`${name}/${exportKey.slice(2)}`);
		}

		for (const exportKey in exports) {
			if (
				!exportKey.startsWith("./") ||
				exportKey === "." ||
				!exportKey.includes("*")
			) {
				continue;
			}
			const sourcePattern = exportImportTarget(exports[exportKey]);
			if (sourcePattern === null) continue;
			const pattern = parseWildcardPattern(exportKey, sourcePattern);
			if (pattern === null) continue;
			if (!/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(pattern.sourceSuffix)) {
				continue;
			}
			if (pattern.exportPrefix === "" || pattern.exportPrefix === "/") {
				continue;
			}
			const sourceDir = path.join(packageDir, pattern.sourcePrefix);
			try {
				const matches: string[] = [];
				const glob = new Bun.Glob(`**/*${pattern.sourceSuffix}`);
				for await (const match of glob.scan({
					cwd: sourceDir,
					onlyFiles: true,
				})) {
					matches.push(match.split(path.sep).join("/"));
				}
				matches.sort();
				for (const match of matches) {
					if (!match.endsWith(pattern.sourceSuffix)) continue;
					const basename = match.slice(
						0,
						match.length - pattern.sourceSuffix.length,
					);
					const segments = basename.split("/");
					if (
						segments.some(
							(segment) => segment.startsWith(".") || segment.startsWith("_"),
						)
					) {
						continue;
					}
					if (!isRegisteredWildcardBasename(segments.at(-1) ?? "")) {
						continue;
					}
					keys.add(
						`${name}/${pattern.exportPrefix}${basename}${pattern.exportSuffix}`,
					);
				}
			} catch (error) {
				const code =
					typeof error === "object" && error !== null
						? (error as { code?: unknown }).code
						: undefined;
				if (code !== "ENOENT") throw error;
			}
		}
	}
	return keys;
}

/** One derivation for the whole suite; the scan and its proof share it. */
let registryPromise: Promise<ReadonlySet<string>> | undefined;
function loadRegistry(): Promise<ReadonlySet<string>> {
	registryPromise ??= deriveBundledPiRegistry();
	return registryPromise;
}

/**
 * One `@oh-my-pi/*` value import site: file (as reported to the scanner),
 * 1-based line of the specifier, and the specifier string.
 */
interface PiImportedSpecifier {
	readonly file: string;
	readonly line: number;
	readonly specifier: string;
}

/** Static `import` carries a runtime binding unless fully type-only. */
function isValueImport(node: ts.ImportDeclaration): boolean {
	const clause = node.importClause;
	if (clause === undefined) return true; // side-effect import: runtime
	if (clause.isTypeOnly) return false;
	const bindings = clause.namedBindings;
	if (bindings === undefined) return true; // default import: runtime
	if (ts.isNamespaceImport(bindings)) return true; // `import * as`
	return bindings.elements.some((element) => !element.isTypeOnly);
}

/** `export ... from` carries a runtime binding unless fully type-only. */
function isValueExport(node: ts.ExportDeclaration): boolean {
	if (node.moduleSpecifier === undefined) return false; // local export
	if (node.isTypeOnly) return false;
	const clause = node.exportClause;
	if (clause === undefined) return true; // `export * from`
	if (ts.isNamespaceExport(clause)) return true; // `export * as ns`
	return clause.elements.some((element) => !element.isTypeOnly);
}

/**
 * Parse one source file and collect every `@oh-my-pi/*` import site that
 * survives transpilation. Type-only sites are silently skipped by design:
 * they are erased and never reach the loader.
 */
function collectValueImports(
	fileName: string,
	content: string,
): PiImportedSpecifier[] {
	const sourceFile = ts.createSourceFile(
		fileName,
		content,
		ts.ScriptTarget.Latest,
		false,
		ts.ScriptKind.TS,
	);
	const uses: PiImportedSpecifier[] = [];
	function useAt(node: ts.Node, specifier: string): void {
		uses.push({
			file: fileName,
			line:
				sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
					.line + 1,
			specifier,
		});
	}
	function isPiSpecifier(node: ts.Expression): string | null {
		return ts.isStringLiteral(node) && node.text.startsWith("@oh-my-pi/")
			? node.text
			: null;
	}
	function visit(node: ts.Node): void {
		if (ts.isImportDeclaration(node)) {
			const specifier = isPiSpecifier(node.moduleSpecifier);
			if (specifier !== null && isValueImport(node)) useAt(node, specifier);
		} else if (ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier === undefined) return;
			const specifier = isPiSpecifier(node.moduleSpecifier);
			if (specifier !== null && isValueExport(node)) {
				useAt(node, specifier);
			}
		} else if (ts.isImportEqualsDeclaration(node)) {
			const specifier = isPiSpecifier(node.moduleReference as ts.Expression);
			if (specifier !== null) useAt(node, specifier);
		} else if (ts.isCallExpression(node)) {
			const isDynamicImport =
				node.expression.kind === ts.SyntaxKind.ImportKeyword;
			const isRequire =
				ts.isIdentifier(node.expression) && node.expression.text === "require";
			if (isDynamicImport || isRequire) {
				const argument = node.arguments[0];
				const specifier =
					argument !== undefined ? isPiSpecifier(argument) : null;
				if (specifier !== null) useAt(node, specifier);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return uses;
}

/**
 * Read every `.ts` file under `scannedRoot` (recursively) and collect its
 * value import sites, with file paths reported as
 * `displayPrefix/<relative path>`.
 */
async function scanPiValueImports(
	scannedRoot: string,
	displayPrefix: string,
): Promise<PiImportedSpecifier[]> {
	const uses: PiImportedSpecifier[] = [];
	const glob = new Bun.Glob("**/*.ts");
	for await (const match of glob.scan({
		cwd: scannedRoot,
		onlyFiles: true,
		dot: true,
	})) {
		const content = await Bun.file(path.join(scannedRoot, match)).text();
		uses.push(
			...collectValueImports(
				displayPrefix === "" ? match : `${displayPrefix}/${match}`,
				content,
			),
		);
	}
	return uses;
}

/**
 * Actionable failure text for one violation: the specifier, the mechanism
 * that rejects it, and the fix — import from the package root or a
 * registered subpath. Someone reading this in six months should not need
 * the file-level comment above.
 */
function violationMessage(
	use: PiImportedSpecifier,
	registry: ReadonlySet<string>,
): string {
	const scope = use.specifier.split("/").slice(0, 2).join("/");
	const subpaths = [...registry]
		.filter((key) => key !== scope && key.startsWith(`${scope}/`))
		.sort();
	const alternatives = registry.has(scope)
		? subpaths.length === 0
			? `the package root ("${scope}")`
			: `the package root ("${scope}") or a registered subpath (${subpaths
					.map((subpath) => `"${subpath}"`)
					.join(", ")})`
		: `one of the bundled packages (${BUNDLED_PACKAGE_DIRS.map(
				(dir) => `"@oh-my-pi/${INSTALLED_PACKAGE_NAMES[dir]}"`,
			).join(", ")}) — no specifier of "${scope}" is registered`;
	return (
		`${use.file}:${use.line} — value import "${use.specifier}" is not in ` +
		`the compiled-binary Pi registry. Compiled OMP binaries resolve ` +
		`@oh-my-pi/* only through the keys built by collectBundledPiEntries ` +
		`(node_modules/@oh-my-pi/pi-coding-agent/scripts/` +
		`legacy-pi-virtual-module.ts:103-180): package roots, literal ./sub ` +
		`export keys and prefixed wildcard expansions — root ./* catch-alls ` +
		`are excluded (line 141). That is exactly how ` +
		`"@oh-my-pi/pi-utils/format" (pi-utils exports: ., ./ar, ./*, ./*.js) ` +
		`breaks production loads while passing under \`bun\`, which resolves ` +
		`node_modules and bypasses the registry. Type-only imports are fine; a ` +
		`value import must be ${alternatives}.`
	);
}

/** The pre-fix regression replayed: `formatDuration` from the subpath. */
const PRE_FIX_SOURCE = [
	'import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";',
	'import { formatDuration } from "@oh-my-pi/pi-utils/format";',
	"",
	"export function pad(value: number): number {",
	"\treturn value + 1;",
	"}",
].join("\n");

describe("derived Pi registry mirrors the compiled-binary registry", () => {
	test("registers every bundled package root", async () => {
		const registry = await loadRegistry();
		for (const dir of BUNDLED_PACKAGE_DIRS) {
			expect(
				registry.has(`@oh-my-pi/${INSTALLED_PACKAGE_NAMES[dir]}`),
				`missing root for ${dir} — check the installed-name map`,
			).toBe(true);
		}
	});

	test("registers literal ./sub keys and prefixed wildcard expansions", async () => {
		const registry = await loadRegistry();
		// Literal key (pi-utils exports: `./ar`).
		expect(registry.has("@oh-my-pi/pi-utils/ar")).toBe(true);
		// Prefixed wildcard expansion (pi-coding-agent `./tools/*` style).
		expect(registry.has("@oh-my-pi/pi-coding-agent/tools/path-utils")).toBe(
			true,
		);
	});

	test("excludes root catch-all subpaths — the pi-utils/format regression", async () => {
		const registry = await loadRegistry();
		// pi-utils exports: ., ./ar, ./*, ./*.js. ./ar is a literal key and is
		// registered; ./ and ./ar are roots/literals; ./format is served only
		// by the ./ and ./js catch-alls, whose exportPrefix is "" — skipped at
		// legacy-pi-virtual-module.ts:141.
		expect(registry.has("@oh-my-pi/pi-utils/format")).toBe(false);
		expect(registry.has("@oh-my-pi/pi-utils/formatDuration")).toBe(false);
	});
});

describe("value imports in plugin source stay on the registry surface", () => {
	test("the current .omp-plugin tree has no violations", async () => {
		const registry = await loadRegistry();
		const uses = await scanPiValueImports(PLUGIN_SOURCE_DIR, ".omp-plugin");
		const violations = uses.filter((use) => !registry.has(use.specifier));
		expect(violations.map((use) => violationMessage(use, registry))).toEqual(
			[],
		);
	});
});

describe("the guard fires on the pre-fix case", () => {
	test("in-memory fixture with @oh-my-pi/pi-utils/format is rejected", async () => {
		const registry = await loadRegistry();
		const uses = collectValueImports("vibe-cards-slots.ts", PRE_FIX_SOURCE);
		const violations = uses.filter((use) => !registry.has(use.specifier));
		expect(violations).toHaveLength(1);
		const violation = violations[0];
		expect(violation?.file).toBe("vibe-cards-slots.ts");
		expect(violation?.line).toBe(2);
		expect(violation?.specifier).toBe("@oh-my-pi/pi-utils/format");
	});

	test("failure message names specifier, mechanism and fix", async () => {
		const registry = await loadRegistry();
		const uses = collectValueImports("vibe-cards-slots.ts", PRE_FIX_SOURCE);
		const message = violationMessage(uses[0] as PiImportedSpecifier, registry);
		expect(message).toContain("vibe-cards-slots.ts:2");
		expect(message).toContain("@oh-my-pi/pi-utils/format");
		expect(message).toContain("legacy-pi-virtual-module.ts");
		expect(message).toContain('the package root ("@oh-my-pi/pi-utils")');
		expect(message).toContain('"@oh-my-pi/pi-utils/ar"');
	});

	test("a real pre-fix file under a scanned dir is rejected end to end", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "pi-subpath-registry-"));
		writeFileSync(path.join(tempDir, "vibe-cards-slots.ts"), PRE_FIX_SOURCE);
		try {
			const registry = await loadRegistry();
			const uses = await scanPiValueImports(tempDir, "");
			const violations = uses.filter((use) => !registry.has(use.specifier));
			expect(violations).toHaveLength(1);
			expect(violations[0]?.file).toBe("vibe-cards-slots.ts");
			expect(violations[0]?.line).toBe(2);
			expect(violations[0]?.specifier).toBe("@oh-my-pi/pi-utils/format");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("type-only imports are exempt (erased before the loader)", () => {
	test("type-only subpath imports from unregistered paths pass", async () => {
		const source = [
			'import type { Theme } from "@oh-my-pi/pi-utils/format";',
			'import { type ThemeColor } from "@oh-my-pi/pi-utils/format";',
		].join("\n");
		const uses = collectValueImports("type-only.ts", source);
		expect(uses).toEqual([]);
	});

	test("adding one value binding to the same specifier fails", async () => {
		const registry = await loadRegistry();
		const source = [
			'import { type ThemeColor, formatDuration } from "@oh-my-pi/pi-utils/format";',
		].join("\n");
		const uses = collectValueImports("mixed.ts", source);
		expect(uses.filter((use) => !registry.has(use.specifier))).toHaveLength(1);
	});

	test("bare package roots are accepted", async () => {
		const registry = await loadRegistry();
		const source = [
			'import { formatDuration } from "@oh-my-pi/pi-utils";',
			'import { diffLines } from "@oh-my-pi/pi-natives";',
		].join("\n");
		const uses = collectValueImports("roots.ts", source);
		expect(uses.filter((use) => !registry.has(use.specifier))).toEqual([]);
	});
});

describe("all specifier forms are scanned", () => {
	test("dynamic import() and require() are classified as value imports", async () => {
		const registry = await loadRegistry();
		const source = [
			'const lazy = () => import("@oh-my-pi/pi-utils/format");',
			'const late = require("@oh-my-pi/pi-utils/format");',
			'const fine = import("@oh-my-pi/pi-utils");',
		].join("\n");
		const uses = collectValueImports("dynamic.ts", source);
		const violations = uses.filter((use) => !registry.has(use.specifier));
		expect(violations.map((use) => use.specifier)).toEqual([
			"@oh-my-pi/pi-utils/format",
			"@oh-my-pi/pi-utils/format",
		]);
	});

	test("export-from is classified per specifier", async () => {
		const registry = await loadRegistry();
		const source = [
			'export { formatDuration } from "@oh-my-pi/pi-utils/format";',
			'export type { Theme } from "@oh-my-pi/pi-utils/format";',
			'export * from "@oh-my-pi/pi-utils/format";',
		].join("\n");
		const uses = collectValueImports("re-export.ts", source);
		const violations = uses.filter((use) => !registry.has(use.specifier));
		expect(violations.map((use) => use.specifier)).toEqual([
			"@oh-my-pi/pi-utils/format",
			"@oh-my-pi/pi-utils/format",
		]);
	});
});
