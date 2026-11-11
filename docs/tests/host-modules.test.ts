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

describe("loadHostModule", () => {
	test("a module that fails to load disables every export the feature needs", async () => {
		const disabled: DisabledComponent[] = [];
		const module = await loadHostModule(
			"xd:// device rows",
			"@oh-my-pi/pi-tui/tools/xd-url",
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
			expect(entry.specifier).toBe("@oh-my-pi/pi-tui/tools/xd-url");
			expect(entry.reason).toContain("Cannot find module");
		}
	});

	test("a module without one export disables the feature and records only that export", async () => {
		const disabled: DisabledComponent[] = [];
		const module = await loadHostModule(
			"styled rows",
			"@oh-my-pi/pi-tui/native/spans",
			async () =>
				({ compactText: () => "" }) as {
					compactText: unknown;
					rowsText?: unknown;
				},
			["compactText", "rowsText"],
			disabled,
		);
		expect(module).toBeUndefined();
		expect(disabled.map((entry) => entry.symbol)).toEqual(["rowsText"]);
	});

	test("a complete module comes back as its live namespace", async () => {
		const disabled: DisabledComponent[] = [];
		const live = { theme: undefined as string | undefined };
		const module = await loadHostModule(
			"settings dialog",
			"@oh-my-pi/pi-tui/theme/theme",
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

	test("one line per feature, naming every export behind it", () => {
		const warning = disabledComponentsWarning([
			{
				component: "settings dialog",
				specifier: "@oh-my-pi/pi-tui/chrome/form-theme",
				symbol: "formTheme",
				reason: "export not found",
			},
			{
				component: "xd:// device rows",
				specifier: "@oh-my-pi/pi-tui/tools/xd-url",
				symbol: "parseXdUrl",
				reason: "module did not load",
			},
			{
				component: "settings dialog",
				specifier: "@oh-my-pi/pi-tui/theme/theme",
				symbol: "theme",
				reason: "export not found",
			},
		]);
		const lines = (warning ?? "").split("\n");
		const dialog = lines.filter((line) => line.includes("settings dialog"));
		expect(dialog).toHaveLength(1);
		expect(dialog[0]).toContain("formTheme");
		expect(dialog[0]).toContain("@oh-my-pi/pi-tui/theme/theme");
		expect(lines.filter((line) => line.includes("parseXdUrl"))).toHaveLength(1);
	});
});
