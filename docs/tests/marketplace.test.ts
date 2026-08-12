import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import * as os from "node:os";

import pkg from "../../package.json";
import { parseMarketplaceCatalog } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/fetcher";
import { resolvePluginSource } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/source-resolver";
import {
	buildPluginId,
	type MarketplaceCatalog,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/types";

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
		expect(catalog.plugins[0].name).toBe("omp-compact");
		expect(catalog.plugins[0].source).toBe("./");
	});

	test("plugin ID resolves to omp-compact@arksdev at the repository root", async () => {
		const plugin = catalog.plugins[0];
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
		expect(plugin.version).toBe(pkg.version);
		expect(plugin.description).toBe(pkg.description);
		expect(plugin.author?.name).toBe(pkg.author);
		expect(plugin.homepage).toBe(pkg.homepage);
		expect(plugin.repository).toBe(pkg.repository?.url);
		expect(plugin.license).toBe(pkg.license);
		expect(plugin.keywords).toEqual(pkg.keywords);
		expect(pkg.engines.omp).toBe(">=17.2.12");
		expect(pkg.devDependencies["@oh-my-pi/pi-coding-agent"]).toBe("17.2.12");
		expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(await Bun.file(join(repoRoot, "CHANGELOG.md")).text()).toContain(
			`## [${pkg.version}]`,
		);
	});
});
