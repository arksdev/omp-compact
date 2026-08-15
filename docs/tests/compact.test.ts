import { describe, expect, test } from "bun:test";

import {
	editPathsFromInput,
	genericToolDescription,
	listValue,
	stringValue,
} from "../../.omp-plugin/compact";

describe("editPathsFromInput", () => {
	test("extracts bounded hashline edit targets", () => {
		const input =
			"[src/a.ts#A1B2]\nPUT 1.=1:\n+one\n[src/b.ts#C3D4]\nPUT 2.=2:\n+two";
		expect(editPathsFromInput(input)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("keeps header text without a 4-hex tag as the path itself", () => {
		expect(editPathsFromInput("[src/a.ts]\nPUT 1.=1:\n+one")).toEqual([
			"src/a.ts",
		]);
		expect(editPathsFromInput("[src/a.ts#TOOLONG]\nPUT 1.=1:")).toEqual([
			"src/a.ts#TOOLONG",
		]);
	});

	test("deduplicates repeated targets and caps at eight", () => {
		const input = Array.from(
			{ length: 12 },
			(_, i) => `[src/f${i}.ts#A${i.toString(16).padStart(4, "0")}]\nPUT 1.=1:`,
		).join("\n");
		const paths = editPathsFromInput(input);
		expect(paths).toHaveLength(8);
		expect(new Set(paths).size).toBe(8);
	});

	test("bounds the scanned input", () => {
		const prefix = "[src/a.ts#A1B2]\nPUT 1.=1:\n";
		const input = prefix + "x".repeat(32_768);
		expect(editPathsFromInput(input)).toEqual(["src/a.ts"]);
	});

	test("empty and targetless input yield no paths", () => {
		expect(editPathsFromInput("")).toEqual([]);
		expect(editPathsFromInput("PUT 1.=1:\n+one")).toEqual([]);
	});

	test("extracts apply-patch Add File targets", () => {
		const input = "*** Add File: src/new.ts\n+line\n";
		expect(editPathsFromInput(input)).toEqual(["src/new.ts"]);
	});

	test("extracts apply-patch Update File targets", () => {
		const input = "*** Update File: src/upd.ts\n@@ -1 +1 @@\n-old\n+new\n";
		expect(editPathsFromInput(input)).toEqual(["src/upd.ts"]);
	});

	test("extracts apply-patch Delete File targets", () => {
		const input = "*** Delete File: src/gone.ts\n-gone\n";
		expect(editPathsFromInput(input)).toEqual(["src/gone.ts"]);
	});

	test("mixes hashline and apply-patch headers with dedup and cap", () => {
		const input = [
			"[src/a.ts#A1B2]",
			"PUT 1.=1:",
			"+one",
			"*** Update File: src/b.ts",
			"@@ -1 +1 @@",
			"*** Delete File: src/c.ts",
			"-two",
		].join("\n");
		expect(editPathsFromInput(input)).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
		]);
	});

	test("deduplicates the same target across hashline and apply-patch formats", () => {
		const input = [
			"[src/a.ts#A1B2]",
			"PUT 1.=1:",
			"+one",
			"*** Update File: src/a.ts",
			"@@ -1 +1 @@",
			"*** Delete File: src/b.ts",
			"-two",
		].join("\n");
		expect(editPathsFromInput(input)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("caps apply-patch targets at eight alongside hashline targets", () => {
		const hashLines = Array.from(
			{ length: 6 },
			(_, i) => `[src/h${i}.ts#A${i.toString(16).padStart(4, "0")}]\nPUT 1.=1:`,
		).join("\n");
		const patchLines = Array.from(
			{ length: 6 },
			(_, i) => `*** Add File: src/p${i}.ts\n+line\n`,
		).join("\n");
		const paths = editPathsFromInput(`${hashLines}\n${patchLines}`);
		expect(paths).toHaveLength(8);
		expect(new Set(paths).size).toBe(8);
	});
});

describe("genericToolDescription", () => {
	test("tolerates cyclic objects without serializing them", () => {
		const args: Record<string, unknown> = { action: "run" };
		args.self = args;
		expect(genericToolDescription("custom_tool", args)).toEqual({
			title: "custom tool",
			description: "action: run self: {…}",
			meta: [],
		});
	});

	test("bounds string values, list sizes and entry count", () => {
		const long = "x".repeat(10_000);
		const description = genericToolDescription("t", {
			a: long,
			b: Array.from({ length: 20 }, (_, i) => `item-${i}`),
			c: { deep: true },
			d: 5,
			e: null,
			__hidden: "skip",
		}).description;
		expect(description).toContain("a: ".concat(long.slice(0, 160)));
		expect(description).toContain("b: [20 items]");
		expect(description).toContain("c: {…}");
		expect(description).toContain("d: 5");
		// The pair cap (four) is what hides `e: null` and `__hidden` here — the
		// null value itself is rendered when it fits within the cap (see the
		// dedicated null test below), and __-prefixed keys are always skipped
		// by their own rule.
		expect(description).not.toContain("__hidden");
		expect(description).not.toContain("skip");
	});

	test("renders explicit null values as null within the pair cap", () => {
		expect(genericToolDescription("t", { e: null, a: 1 }).description).toBe(
			"e: null a: 1",
		);
	});

	test("truncates string values at code-point boundaries, not UTF-16 units", () => {
		// One ASCII char plus 200 astral emoji = 401 UTF-16 code units; slicing
		// to 160 units would land mid-pair (1 + 79*2 = 159, leaving half of the
		// 80th emoji). Code-point truncation keeps exactly 160 code points.
		const description = genericToolDescription("t", {
			a: "x".concat("🚀".repeat(200)),
		}).description;
		expect(description).toBe("a: ".concat("x", "🚀".repeat(159)));
		expect([...description].every((ch) => ch !== "\uFFFD")).toBe(true);
	});

	test("stringValue keeps code-point boundaries", () => {
		// Same trick: leading char shifts the UTF-16 boundary off a pair edge.
		const long = "x".concat("🚀".repeat(10_000));
		expect(stringValue({ path: long }, "path")).toBe(
			"x".concat("🚀".repeat(4_095)),
		);
	});

	test("listValue items keep code-point boundaries", () => {
		const long = "x".concat("🚀".repeat(10_000));
		expect(listValue({ paths: [long] }, "paths")).toEqual([
			"x".concat("🚀".repeat(4_095)),
		]);
	});

	test("underscore and hyphen spellings share one lowercase title", () => {
		expect(genericToolDescription("Custom_Tool", {}).title).toBe("custom tool");
		expect(genericToolDescription("custom-tool", {}).title).toBe("custom tool");
	});

	test("skips undefined values", () => {
		expect(
			genericToolDescription("t", { a: undefined, b: 1 }).description,
		).toBe("b: 1");
	});

	test("non-object args render an empty description", () => {
		expect(genericToolDescription("t", null).description).toBe("");
		expect(genericToolDescription("t", "text").description).toBe("");
	});
});
