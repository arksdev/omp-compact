import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import { join, resolve } from "node:path";
import { parseMarketplaceCatalog } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/fetcher";
import { resolvePluginSource } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/source-resolver";
import {
	buildPluginId,
	type MarketplaceCatalog,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/types";
import pkg from "../../package.json";

const repoRoot = resolve(import.meta.dir, "../..");
const catalogPath = join(repoRoot, ".omp-plugin", "marketplace.json");
const catalog: MarketplaceCatalog = parseMarketplaceCatalog(
	await Bun.file(catalogPath).text(),
	catalogPath,
);

describe("marketplace catalog", () => {
	test("stock parser accepts the catalog with exactly one plugin", () => {
		expect(catalog.name).toBe("arksdev");
		expect(catalog.owner.name).toBe("arksdev");
		expect(catalog.plugins).toHaveLength(1);
		const plugin = catalog.plugins[0];
		expect(plugin).toBeDefined();
		if (!plugin) throw new Error("catalog must contain one plugin");
		expect(plugin.name).toBe("omp-compact");
		expect(plugin.source).toBe("./");
	});

	test("plugin ID resolves to omp-compact@arksdev at the repository root", async () => {
		const plugin = catalog.plugins[0];
		if (!plugin) throw new Error("catalog must contain one plugin");
		expect(buildPluginId(plugin.name, catalog.name)).toBe(
			"omp-compact@arksdev",
		);

		// OMP resolves relative plugin sources against the marketplace root —
		// the directory containing .omp-plugin/ — which is this repository.
		const { dir } = await resolvePluginSource(plugin, {
			marketplaceClonePath: repoRoot,
			tmpDir: os.tmpdir(),
		});
		expect(dir).toBe(repoRoot);
		expect(await Bun.file(join(dir, "package.json")).exists()).toBe(true);
		expect(await Bun.file(join(dir, ".omp-plugin", "index.ts")).exists()).toBe(
			true,
		);
	});

	test("plugin metadata mirrors package.json", async () => {
		const plugin = catalog.plugins[0];
		if (!plugin) throw new Error("catalog must contain one plugin");
		expect(plugin.version).toBe(pkg.version);
		expect(plugin.description).toBe(pkg.description);
		expect(plugin.author?.name).toBe(pkg.author);
		expect(plugin.homepage).toBe(pkg.homepage);
		expect(plugin.repository).toBe(pkg.repository?.url);
		expect(plugin.license).toBe(pkg.license);
		expect(plugin.keywords).toEqual(pkg.keywords);
		expect(pkg.engines.omp).toBe(">=17.4.2");
		expect(pkg.devDependencies["@oh-my-pi/pi-coding-agent"]).toBe("17.4.2");
		expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(await Bun.file(join(repoRoot, "CHANGELOG.md")).text()).toContain(
			`## ${pkg.version}`,
		);
	});

	test("current minor release metadata is synchronized", async () => {
		expect(pkg.version).toBe("1.1.3");
		expect(catalog.plugins[0]?.version).toBe("1.1.3");
		const changelog = await Bun.file(join(repoRoot, "CHANGELOG.md")).text();
		expect(changelog).toContain("## 1.1.3 — 22 августа 2026");
		expect(changelog).toContain(
			"[1.1.3 ← 1.1.2](https://github.com/arksdev/omp-compact/compare/v1.1.2...v1.1.3)",
		);
	});
});
