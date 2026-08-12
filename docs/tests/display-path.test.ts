import { describe, expect, test } from "bun:test";

import {
	type DisplayPathOptions,
	displayPathValue,
	relativizePath,
} from "../../.omp-plugin/display-path";

const PROJECT = "/Volumes/Storage2T/Projects/orca-plugins";

function options(
	overrides: Partial<DisplayPathOptions> = {},
): DisplayPathOptions {
	return { cwd: PROJECT, enabled: true, ...overrides };
}

describe("relativizePath", () => {
	test("relativizes a direct descendant and a deep descendant", () => {
		expect(relativizePath(`${PROJECT}/file.ts`, PROJECT)).toBe("file.ts");
		expect(
			relativizePath(`${PROJECT}/docs/omp-shell/example.md`, PROJECT),
		).toBe("docs/omp-shell/example.md");
	});

	test("the cwd itself renders as dot", () => {
		expect(relativizePath(PROJECT, PROJECT)).toBe(".");
		expect(relativizePath(`${PROJECT}/`, PROJECT)).toBe(".");
	});

	test("root is never inside a cwd below it", () => {
		expect(relativizePath("/", PROJECT)).toBeUndefined();
	});

	test("a root cwd relativizes every absolute path", () => {
		expect(relativizePath("/etc/hosts", "/")).toBe("etc/hosts");
		expect(relativizePath("/", "/")).toBe(".");
	});

	test("boundary lookalikes are not inside the cwd", () => {
		expect(
			relativizePath("/Volumes/Storage2T/Projects/orca-plugins-x/a", PROJECT),
		).toBeUndefined();
		expect(
			relativizePath("/Volumes/Storage2T/Projects/orca-plugins2/a", PROJECT),
		).toBeUndefined();
		expect(
			relativizePath("/Volumes/Storage2T/Projects/orca-plugin/a", PROJECT),
		).toBeUndefined();
		expect(
			relativizePath(
				"/Volumes/Storage2T/Projects/orca-plugins-extra/a",
				PROJECT,
			),
		).toBeUndefined();
	});

	test("a shorter prefix never counts as inside", () => {
		expect(
			relativizePath("/Volumes/Storage2T/Projects/orca", PROJECT),
		).toBeUndefined();
		expect(
			relativizePath("/Volumes/Storage2T/Projects", PROJECT),
		).toBeUndefined();
	});

	test("external paths and other volumes stay absolute", () => {
		expect(relativizePath("/etc/hosts", PROJECT)).toBeUndefined();
		expect(relativizePath("/Volumes/Other/x.ts", PROJECT)).toBeUndefined();
		expect(relativizePath("/tmp/x.ts", PROJECT)).toBeUndefined();
	});

	test("already-relative inputs are never touched", () => {
		expect(relativizePath("src/a.ts", PROJECT)).toBeUndefined();
		expect(relativizePath("./src/a.ts", PROJECT)).toBeUndefined();
		expect(relativizePath("../src/a.ts", PROJECT)).toBeUndefined();
		expect(relativizePath("", PROJECT)).toBeUndefined();
	});

	test("parent escapes are preserved, not resolved", () => {
		expect(relativizePath(`${PROJECT}/../other/x.ts`, PROJECT)).toBeUndefined();
		expect(
			relativizePath(`${PROJECT}/../${PROJECT}/x.ts`, PROJECT),
		).toBeUndefined();
	});

	test("paths with spaces and unicode compare segment-wise", () => {
		expect(relativizePath(`${PROJECT}/pro ject/dir/my file.ts`, PROJECT)).toBe(
			"pro ject/dir/my file.ts",
		);
		expect(relativizePath(`${PROJECT}/файл.ts`, PROJECT)).toBe("файл.ts");
		expect(relativizePath("/проект/папка/файл.ts", "/проект")).toBe(
			"папка/файл.ts",
		);
		expect(relativizePath("/проект-2/файл.ts", "/проект")).toBeUndefined();
	});

	test("dot and empty segments normalize but never escape", () => {
		expect(relativizePath(`${PROJECT}//docs/./x.ts`, PROJECT)).toBe(
			"docs/x.ts",
		);
		expect(relativizePath(`${PROJECT}/./.`, PROJECT)).toBe(".");
	});

	test("a non-absolute cwd never relativizes", () => {
		expect(relativizePath("/project/x.ts", "project")).toBeUndefined();
		expect(relativizePath("/project/x.ts", "")).toBeUndefined();
	});
});

describe("displayPathValue", () => {
	test("off and absent options return the value byte-for-byte", () => {
		const value = `${PROJECT}/docs/x.ts:10-20`;
		expect(displayPathValue(value, options({ enabled: false }))).toBe(value);
		expect(displayPathValue(value, undefined)).toBe(value);
		expect(displayPathValue(value, options({ cwd: "" }))).toBe(value);
	});

	test("line selectors stay attached to the relativized base", () => {
		expect(displayPathValue(`${PROJECT}/f.ts:50-200`, options())).toBe(
			"f.ts:50-200",
		);
		expect(displayPathValue(`${PROJECT}/f.ts:raw`, options())).toBe("f.ts:raw");
		expect(displayPathValue(`${PROJECT}/f.ts:conflicts`, options())).toBe(
			"f.ts:conflicts",
		);
		expect(displayPathValue(`${PROJECT}/f.ts:12-`, options())).toBe("f.ts:12-");
	});

	test("archive selectors keep their member paths", () => {
		expect(
			displayPathValue(`${PROJECT}/arc.tar:path/inside/x.ts`, options()),
		).toBe("arc.tar:path/inside/x.ts");
		expect(
			displayPathValue(`${PROJECT}/arc.tar.gz:inner/f.ts`, options()),
		).toBe("arc.tar.gz:inner/f.ts");
	});

	test("sqlite selectors and query strings survive", () => {
		expect(displayPathValue(`${PROJECT}/data.sqlite:table`, options())).toBe(
			"data.sqlite:table",
		);
		expect(displayPathValue(`${PROJECT}/data.db:table:key`, options())).toBe(
			"data.db:table:key",
		);
		expect(
			displayPathValue(`${PROJECT}/data.db:table?limit=5&where=x`, options()),
		).toBe("data.db:table?limit=5&where=x");
	});

	test("uris and non-file values never relativize", () => {
		expect(displayPathValue("https://example.com/a/b", options())).toBe(
			"https://example.com/a/b",
		);
		expect(displayPathValue("file:///project/x.ts", options())).toBe(
			"file:///project/x.ts",
		);
		expect(displayPathValue("ssh://host/x", options())).toBe("ssh://host/x");
		expect(displayPathValue("~/.config/x", options())).toBe("~/.config/x");
	});

	test("external, relative, and escaped values pass through untouched", () => {
		expect(displayPathValue("/etc/hosts", options())).toBe("/etc/hosts");
		expect(displayPathValue("src/a.ts", options())).toBe("src/a.ts");
		expect(displayPathValue(`${PROJECT}/../x`, options())).toBe(
			`${PROJECT}/../x`,
		);
		expect(displayPathValue("/", options())).toBe("/");
	});

	test("the cwd itself displays as dot with selectors preserved", () => {
		expect(displayPathValue(PROJECT, options())).toBe(".");
		expect(displayPathValue(`${PROJECT}/`, options())).toBe(".");
	});

	test("normalizes redundant separators while relativizing", () => {
		expect(displayPathValue(`${PROJECT}//a//b.ts`, options())).toBe("a/b.ts");
	});
});
