/**
 * What the plugin does when omp moved or dropped a helper it imports: the
 * loader records the loss instead of throwing, and the warning names it.
 * Each test passes its own registry, so the process registry that
 * host-health.test.ts checks stays untouched.
 */
import { describe, expect, test } from "bun:test";
import {
	type DisabledComponent,
	disabledComponentsWarning,
	loadHostModule,
} from "../../.omp-plugin/host-modules";
import pkg from "../../package.json";

const ROOT = "@oh-my-pi/pi-coding-agent";
// Where a helper would load from after leaving the root (CONTRIBUTING, "Host drift").
const FALLBACK = "@oh-my-pi/pi-tui";

describe("loadHostModule", () => {
	test("a fallback module that fails to load disables every export the feature needs", async () => {
		const disabled: DisabledComponent[] = [];
		const module = await loadHostModule(
			"xd:// device rows",
			FALLBACK,
			(): Promise<{ parseXdUrl: unknown; stripXdUrlPrefix: unknown }> =>
				Promise.reject(new Error("Cannot find module")),
			["parseXdUrl", "stripXdUrlPrefix"],
			disabled,
		);
		expect(module).toBeUndefined();
		expect(disabled.map((entry) => entry.symbol)).toEqual([
			"parseXdUrl",
			"stripXdUrlPrefix",
		]);
		for (const entry of disabled) {
			expect(entry.component).toBe("xd:// device rows");
			expect(entry.specifier).toBe(FALLBACK);
			expect(entry.reason).toContain("Cannot find module");
		}
	});

	test("an export missing from the shared root disables only the feature that lists it", async () => {
		const disabled: DisabledComponent[] = [];
		// What omp's root would be if a release dropped `rowsText`.
		const root: Promise<{
			compactText: unknown;
			rowsText?: unknown;
			parseXdUrl: () => number;
		}> = Promise.resolve({ compactText: () => "", parseXdUrl: () => 1 });
		const [rows, devices] = await Promise.all([
			loadHostModule(
				"styled rows",
				ROOT,
				() => root,
				["compactText", "rowsText"],
				disabled,
			),
			loadHostModule(
				"xd:// device rows",
				ROOT,
				() => root,
				["parseXdUrl"],
				disabled,
			),
		]);
		expect(rows).toBeUndefined();
		expect(devices?.parseXdUrl()).toBe(1);
		expect(disabled).toEqual([
			{
				component: "styled rows",
				specifier: ROOT,
				symbol: "rowsText",
				reason: "export not found",
			},
		]);
	});

	test("a complete module comes back as its live namespace", async () => {
		const disabled: DisabledComponent[] = [];
		const live = { theme: undefined as string | undefined };
		const module = await loadHostModule(
			"settings dialog",
			ROOT,
			async () => live,
			// Declared but not yet initialized still counts as present.
			["theme"],
			disabled,
		);
		expect(disabled).toEqual([]);
		live.theme = "dark";
		expect(module?.theme).toBe("dark");
	});
});

describe("disabledComponentsWarning", () => {
	test("nothing disabled, no warning", () => {
		expect(disabledComponentsWarning([])).toBeUndefined();
	});

	test("one line per feature, naming every export behind it once per specifier", () => {
		const warning = disabledComponentsWarning([
			{
				component: "settings dialog",
				specifier: ROOT,
				symbol: "formTheme",
				reason: "export not found",
			},
			{
				component: "xd:// device rows",
				specifier: ROOT,
				symbol: "parseXdUrl",
				reason: "module did not load",
			},
			{
				component: "settings dialog",
				specifier: ROOT,
				symbol: "theme",
				reason: "export not found",
			},
			{
				// A helper loaded from a fallback location after it left the root.
				component: "settings dialog",
				specifier: FALLBACK,
				symbol: "editorKey",
				reason: "export not found",
			},
		]);
		const lines = (warning ?? "").split("\n");
		expect(lines.filter((line) => line.startsWith("- "))).toEqual([
			`- settings dialog (formTheme, theme from ${ROOT}; editorKey from ${FALLBACK})`,
			`- xd:// device rows (parseXdUrl from ${ROOT})`,
		]);
		// The remedy names the floor and tracker package.json declares; the
		// plugin cannot read package.json at runtime.
		const remedy = lines.at(-1) ?? "";
		expect(remedy).toContain(
			`omp to ${pkg.engines.omp.replace(">=", "")} or later`,
		);
		expect(remedy).toContain(pkg.bugs.url);
	});
});
