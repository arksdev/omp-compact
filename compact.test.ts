import { describe, expect, test } from "bun:test";

import { editPathsFromInput, genericToolDescription } from "./compact";

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
		expect(description).not.toContain("e: null");
		expect(description).not.toContain("__hidden");
		expect(description).not.toContain("skip");
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
