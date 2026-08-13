import { describe, expect, test } from "bun:test";

import { genericToolDescription } from "../../.omp-plugin/compact";
import {
	describeTool,
	normalizeToolName,
	resolveToolRule,
	TOOL_RULES,
	type ToolAuditKind,
	type ToolRoute,
} from "../../.omp-plugin/tool-presentation-rules";

const CANONICAL_NAMES = [
	"ask",
	"ast_edit",
	"ast_grep",
	"bash",
	"browser",
	"computer",
	"edit",
	"eval",
	"glob",
	"grep",
	"hub",
	"hus",
	"inspect_image",
	"read",
	"reject",
	"resolve",
	"task",
	"todo",
	"web_search",
	"write",
	"yield",
].sort();

describe("canonical routes and audit kinds", () => {
	test("registry holds exactly the canonical names — never synthesizes rules", () => {
		expect(Object.keys(TOOL_RULES).sort()).toEqual(CANONICAL_NAMES);
	});

	test("interactive four route compact with compactOnExpand; ask stays native", () => {
		expect(TOOL_RULES.read?.route).toBe("read-group");
		for (const name of ["browser", "computer", "resolve", "reject"]) {
			expect(TOOL_RULES[name]?.route, name).toBe("compact");
			expect(TOOL_RULES[name]?.compactOnExpand, name).toBe(true);
		}
		expect(TOOL_RULES.ask?.route).toBe("native-live");
		expect(TOOL_RULES.ask?.compactOnExpand).toBeUndefined();
		expect(TOOL_RULES.task?.route).toBe("compact");
	});

	test("compactOnExpand is opt-in: only the interactive four carry it", () => {
		const expanded = Object.entries(TOOL_RULES)
			.filter(([, rule]) => rule?.compactOnExpand === true)
			.map(([name]) => name)
			.sort();
		expect(expanded).toEqual(["browser", "computer", "reject", "resolve"]);
		for (const [name, rule] of Object.entries(TOOL_RULES)) {
			expect(rule, name).toBeDefined();
			if (!rule) continue;
			if (["browser", "computer", "resolve", "reject"].includes(name)) {
				expect(rule.compactOnExpand, name).toBe(true);
			} else {
				expect(rule.compactOnExpand, name).toBeUndefined();
			}
		}
	});

	test("existing routine tools are explicitly compact", () => {
		for (const name of [
			"bash",
			"write",
			"edit",
			"grep",
			"glob",
			"hub",
			"todo",
			"eval",
			"yield",
			"hus",
			"web_search",
			"ast_grep",
			"ast_edit",
			"inspect_image",
			"browser",
			"computer",
			"resolve",
			"reject",
		]) {
			expect(TOOL_RULES[name]?.route, name).toBe("compact");
		}
	});

	test("audit kinds: write→write, edit→edit, bash→git-bash, all others none", () => {
		const expected: Record<string, ToolAuditKind> = {
			write: "write",
			edit: "edit",
			bash: "git-bash",
		};
		for (const [name, rule] of Object.entries(TOOL_RULES)) {
			expect(rule, name).toBeDefined();
			if (!rule) continue;
			expect(rule.audit, name).toBe(expected[name] ?? "none");
		}
	});

	test("registry and rule data are frozen/static", () => {
		expect(Object.isFrozen(TOOL_RULES)).toBe(true);
		for (const rule of Object.values(TOOL_RULES)) {
			expect(rule).toBeDefined();
			if (!rule) continue;
			expect(Object.isFrozen(rule)).toBe(true);
			expect(Object.isFrozen(rule.knownArgs)).toBe(true);
			expect(Object.isFrozen(rule.knownDetails)).toBe(true);
		}
	});

	test("every rule carries bounded arg/detail inventories", () => {
		for (const [name, rule] of Object.entries(TOOL_RULES)) {
			expect(rule, name).toBeDefined();
			if (!rule) continue;
			expect(Array.isArray(rule.knownArgs), name).toBe(true);
			expect(Array.isArray(rule.knownDetails), name).toBe(true);
			expect(
				rule.knownArgs.every((key) => typeof key === "string"),
				name,
			).toBe(true);
			expect(
				rule.knownDetails.every((key) => typeof key === "string"),
				name,
			).toBe(true);
		}
	});
});

describe("alias normalization", () => {
	test("ast-grep/ast-edit resolve to their underscore canonical rules", () => {
		expect(normalizeToolName("ast-grep")).toBe("ast_grep");
		expect(normalizeToolName("ast-edit")).toBe("ast_edit");
		expect(resolveToolRule("ast-grep")).toBe(TOOL_RULES.ast_grep);
		expect(resolveToolRule("ast-edit")).toBe(TOOL_RULES.ast_edit);
		expect(resolveToolRule("ast-grep")).toBe(resolveToolRule("ast_grep"));
		expect(resolveToolRule("ast-edit")).toBe(resolveToolRule("ast_edit"));
	});

	test("apply_patch resolves to the canonical edit rule", () => {
		expect(normalizeToolName("apply_patch")).toBe("edit");
		expect(resolveToolRule("apply_patch")).toBe(TOOL_RULES.edit);
		expect(resolveToolRule("apply_patch")?.route).toBe("compact");
		expect(resolveToolRule("apply_patch")?.audit).toBe("edit");
		expect(resolveToolRule("apply_patch")?.knownArgs).toContain("input");
	});

	test("hyphen/underscore normalization is deterministic for any spelling", () => {
		expect(normalizeToolName("custom-tool")).toBe("custom_tool");
		expect(resolveToolRule("custom-tool")).toBeUndefined();
		expect(resolveToolRule("custom_tool")).toBeUndefined();
	});

	test("alias spellings are not registry keys themselves", () => {
		expect(TOOL_RULES["ast-grep"]).toBeUndefined();
		expect(TOOL_RULES["ast-edit"]).toBeUndefined();
	});
});

describe("explicit unknown lookup", () => {
	test("unregistered names resolve to undefined — never an implicit compact rule", () => {
		expect(resolveToolRule("unknown")).toBeUndefined();
		expect(resolveToolRule("custom_tool")).toBeUndefined();
		expect(resolveToolRule("")).toBeUndefined();
	});

	test("describeTool returns undefined for unregistered names", () => {
		expect(describeTool("custom_tool", { value: "x" })).toBeUndefined();
		expect(describeTool("nope", undefined)).toBeUndefined();
	});
});

describe("bounded generic helper", () => {
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
		// only the first four present keys are rendered — the fifth and any
		// private __-prefixed keys never reach the description
		expect(description).not.toContain("e: null");
		expect(description).not.toContain("__hidden");
		expect(description).not.toContain("skip");
		expect(description.length).toBeLessThanOrEqual(1_600);
	});

	test("underscore and hyphen spellings share one lowercase title", () => {
		expect(genericToolDescription("Custom_Tool", {}).title).toBe("custom tool");
		expect(genericToolDescription("custom-tool", {}).title).toBe("custom tool");
	});
});

describe("existing tool descriptions", () => {
	test("bash shows the command and cwd meta", () => {
		expect(describeTool("bash", { command: "bun test", cwd: "/tmp" })).toEqual({
			title: "bash",
			description: "bun test",
			meta: ["in /tmp"],
		});
	});

	test("read shows path plus offset/limit range", () => {
		expect(describeTool("read", { path: "src/a.ts" })?.description).toBe(
			"src/a.ts",
		);
		expect(
			describeTool("read", { path: "src/a.ts", offset: 10, limit: 5 })
				?.description,
		).toBe("src/a.ts:10-14");
		expect(
			describeTool("read", { path: "src/a.ts", offset: 3 })?.description,
		).toBe("src/a.ts:3");
		expect(
			describeTool("read", { path: "src/a.ts", limit: 3 })?.description,
		).toBe("src/a.ts:1-3");
		expect(describeTool("read", { file_path: "src/b.ts" })?.description).toBe(
			"src/b.ts",
		);
	});

	test("grep shows the pattern and search paths", () => {
		expect(describeTool("grep", { pattern: "x", path: ["src"] })).toEqual({
			title: "grep",
			description: "x",
			meta: ["in src"],
		});
		expect(
			describeTool("grep", { pattern: "", path: "src" })?.description,
		).toBe("?");
		expect(describeTool("grep", {})?.description).toBe("?");
	});

	test("glob shows the pattern list or *", () => {
		expect(describeTool("glob", { path: ["src/*.ts"] })?.description).toBe(
			"src/*.ts",
		);
		expect(describeTool("glob", {})?.description).toBe("*");
	});

	test("write shows the target path", () => {
		expect(describeTool("write", { path: "src/a.ts" })).toEqual({
			title: "write",
			description: "src/a.ts",
			meta: [],
		});
	});

	test("edit extracts bounded hashline targets from input", () => {
		const input =
			"[src/a.ts#A1B2]\nPUT 1.=1:\n+one\n[src/b.ts#C3D4]\nPUT 2.=2:\n+two";
		expect(describeTool("edit", { input })?.description).toBe(
			"src/a.ts, src/b.ts",
		);
		expect(describeTool("edit", { path: "src/a.ts" })?.description).toBe(
			"src/a.ts",
		);
	});

	test("apply_patch alias extracts bounded envelope targets", () => {
		const input =
			"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+two\n*** End Patch";
		expect(describeTool("apply_patch", { input })).toEqual({
			title: "edit",
			description: "src/a.ts, src/b.ts",
			meta: [],
		});
	});

	test("edit aliases accept the legacy streaming _input field", () => {
		const _input =
			"*** Begin Patch\n*** Update File: src/legacy.ts\n@@\n-old\n+new\n*** End Patch";
		expect(describeTool("apply_patch", { _input })?.description).toBe(
			"src/legacy.ts",
		);
		expect(resolveToolRule("apply_patch")?.knownArgs).toContain("_input");
	});

	test("ast_grep/ast_edit/inspect_image keep their labels", () => {
		expect(describeTool("ast_grep", { pat: "$A", path: ["src"] })).toEqual({
			title: "ast grep",
			description: "$A",
			meta: ["in src"],
		});
		expect(describeTool("ast-edit", { paths: ["src/a.ts"] })).toEqual({
			title: "ast edit",
			description: "src/a.ts",
			meta: [],
		});
		expect(
			describeTool("inspect_image", { path: "shots/x.png" })?.description,
		).toBe("shots/x.png");
		expect(describeTool("inspect_image", { path: "shots/x.png" })?.title).toBe(
			"inspect image",
		);
	});

	test("browser description is URL only with action fallback", () => {
		expect(
			describeTool("browser", { action: "open", url: "https://x" })
				?.description,
		).toBe("https://x");
		expect(describeTool("browser", { url: "https://x" })?.description).toBe(
			"https://x",
		);
		expect(describeTool("browser", { action: "run" })?.description).toBe("run");
		expect(describeTool("browser", {})?.description).toBe("");
		expect(describeTool("browser", {})?.title).toBe("browser");
		// browser keeps the ordinary dim title — no color metadata
		expect(describeTool("browser", { url: "https://x" })?.titleColor).toBe(
			undefined,
		);
	});

	test("computer exposes a short action payload with colored title", () => {
		const withIntent = describeTool("computer", {
			code: "await desktop.focusedWindow().ax()",
			i: "Read Spotify window state",
		});
		expect(withIntent?.title).toBe("computer use");
		expect(withIntent?.description).toBe("Read Spotify window state");
		expect(withIntent?.titleColor).toBe("#8D2A88");
		expect(
			describeTool("computer", { read_only: true, i: "Peek" })?.meta,
		).toEqual(["read-only"]);
		expect(
			describeTool("computer", { code: "await desktop.windows()" })
				?.description,
		).toBe("await desktop.windows()");
		expect(describeTool("computer", {})?.description).toBe("?");
		expect(describeTool("computer", {})?.meta).toEqual([]);
	});

	test("resolve/reject extract structured reason/status/path with colored titles", () => {
		// one-sentence reason content (write-device shape) wins
		expect(
			describeTool("resolve", {
				path: "xd://resolve",
				content: "applying staged edit",
			}),
		).toEqual({
			title: "resolve",
			description: "applying staged edit",
			meta: [],
			titleColor: "#A4D734",
		});
		expect(
			describeTool("reject", {
				path: "xd://reject",
				content: "overlaps a newer change",
			})?.description,
		).toBe("overlaps a newer change");
		expect(describeTool("reject", {})?.title).toBe("reject");
		expect(describeTool("reject", {})?.titleColor).toBe("#A1471A");
		// direct reason field, then yield-style result.error, then status, then path
		expect(
			describeTool("resolve", { reason: "looks correct" })?.description,
		).toBe("looks correct");
		expect(
			describeTool("reject", { result: { error: "repro failed" } })
				?.description,
		).toBe("repro failed");
		expect(describeTool("resolve", { status: "success" })?.description).toBe(
			"success",
		);
		expect(describeTool("reject", { path: "xd://reject" })?.description).toBe(
			"xd://reject",
		);
		// neutral safe fallback when no structured field is present
		expect(describeTool("resolve", {})?.description).toBe("?");
		expect(describeTool("reject", {})?.description).toBe("?");
	});

	test("resolution reasons stay bounded and never parse ANSI output", () => {
		const long = "x".repeat(20_000);
		expect(
			describeTool("resolve", { content: long })?.description?.length,
		).toBe(4_096);
		// structured fields only — raw ANSI in content passes through unparsed,
		// the description is never derived from rendered/native output
		const ansi = "\u001b[32mapplied\u001b[0m";
		expect(describeTool("reject", { content: ansi })?.description).toBe(ansi);
	});

	test("registered routine tools describe through the bounded generic form", () => {
		expect(describeTool("hub", { op: "send", to: "Main" })).toEqual({
			title: "hub",
			description: "op: send to: Main",
			meta: [],
		});
		expect(describeTool("todo", { op: "init" })?.title).toBe("todo");
		expect(describeTool("eval", { language: "py" })?.description).toBe(
			"language: py",
		);
		expect(describeTool("yield", {})?.title).toBe("yield");
		expect(describeTool("hus", {})?.title).toBe("hus");
		expect(describeTool("ask", { question: "q" })?.title).toBe("ask");
	});

	test("web_search is an explicit compact rule with its schema args", () => {
		const rule = TOOL_RULES.web_search;
		expect(rule?.route).toBe("compact");
		expect(rule?.audit).toBe("none");
		expect(rule?.knownArgs).toEqual([
			"i",
			"query",
			"recency",
			"limit",
			"max_tokens",
			"num_search_results",
			"temperature",
		]);
		// no stock result evidence exists yet — conservative empty inventory
		expect(rule?.knownDetails).toEqual([]);
		expect(rule?.resultMeta).toBeUndefined();
		expect(describeTool("web_search", { query: "registry", limit: 3 })).toEqual(
			{
				title: "web search",
				description: "query: registry limit: 3",
				meta: [],
			},
		);
	});

	test("bounds specialized string arguments before rendering", () => {
		const description = describeTool("bash", {
			command: "x".repeat(20_000),
		})?.description;
		expect(description?.length).toBeLessThanOrEqual(4_096);
	});
});

describe("project-relative display paths", () => {
	const display = { cwd: "/project", enabled: true };

	test("read/write/edit/grep/glob relativize in-cwd paths", () => {
		expect(
			describeTool("read", { path: "/project/src/a.ts" }, display)?.description,
		).toBe("src/a.ts");
		expect(
			describeTool(
				"read",
				{ path: "/project/src/a.ts", offset: 10, limit: 5 },
				display,
			)?.description,
		).toBe("src/a.ts:10-14");
		expect(
			describeTool("write", { path: "/project/src/a.ts" }, display)
				?.description,
		).toBe("src/a.ts");
		expect(
			describeTool("edit", { path: "/project/src/a.ts" }, display)?.description,
		).toBe("src/a.ts");
		expect(
			describeTool("grep", { pattern: "x", path: ["/project/src"] }, display)
				?.meta,
		).toEqual(["in src"]);
		expect(
			describeTool("glob", { path: ["/project/src/*.ts"] }, display)
				?.description,
		).toBe("src/*.ts");
	});

	test("cwd itself renders as dot", () => {
		expect(
			describeTool("read", { path: "/project" }, display)?.description,
		).toBe(".");
	});

	test("external paths, uris, archive/sqlite selectors stay verbatim", () => {
		expect(
			describeTool("read", { path: "/etc/hosts" }, display)?.description,
		).toBe("/etc/hosts");
		expect(
			describeTool("read", { path: "/project/x.tar:inner/f.ts" }, display)
				?.description,
		).toBe("x.tar:inner/f.ts");
		expect(
			describeTool("read", { path: "/project/db.sqlite:table:key" }, display)
				?.description,
		).toBe("db.sqlite:table:key");
		expect(
			describeTool("read", { path: "https://example.com/a" }, display)
				?.description,
		).toBe("https://example.com/a");
		expect(
			describeTool("read", { path: "/project-x/a.ts" }, display)?.description,
		).toBe("/project-x/a.ts");
	});

	test("edit hashline headers relativize", () => {
		const input = "[/project/src/a.ts#A1B2]\nPUT 1.=1:\n+one";
		expect(describeTool("edit", { input }, display)?.description).toBe(
			"src/a.ts",
		);
	});

	test("bash cwd meta relativizes", () => {
		expect(
			describeTool(
				"bash",
				{ command: "bun test", cwd: "/project/sub" },
				display,
			)?.meta,
		).toEqual(["in sub"]);
	});

	test("ast_grep/ast_edit/inspect_image labels relativize their paths", () => {
		expect(
			describeTool("ast_grep", { pat: "$A", path: ["/project/src"] }, display)
				?.meta,
		).toEqual(["in src"]);
		expect(
			describeTool("ast_edit", { paths: ["/project/src/a.ts"] }, display)
				?.description,
		).toBe("src/a.ts");
		expect(
			describeTool("inspect_image", { path: "/project/shots/x.png" }, display)
				?.description,
		).toBe("shots/x.png");
	});

	test("setting off is byte-for-byte current display", () => {
		const args = { path: "/project/src/a.ts", offset: 2, limit: 3 };
		expect(
			describeTool("read", args, { cwd: "/project", enabled: false }),
		).toEqual(describeTool("read", args));
		expect(describeTool("read", args, undefined)).toEqual(
			describeTool("read", args),
		);
	});
});

describe("tool-specific settled result metadata", () => {
	test("bash reports non-zero exit codes and wall time", () => {
		const rule = TOOL_RULES.bash;
		expect(
			rule?.resultMeta?.({
				content: [],
				details: { exitCode: 2, wallTimeMs: 1500 },
			}),
		).toEqual(["exit 2", "1.5s"]);
		expect(
			rule?.resultMeta?.({ details: { exitCode: 127, wallTimeMs: 100_000 } }),
		).toEqual(["exit 127", "100s"]);
		expect(
			rule?.resultMeta?.({ details: { exitCode: 0, wallTimeMs: 500 } }),
		).toEqual(["0.5s"]);
		expect(rule?.resultMeta?.({ details: {} })).toEqual([]);
		expect(rule?.resultMeta?.(undefined)).toEqual([]);
	});

	test("grep reports the match count with singular/plural", () => {
		const rule = TOOL_RULES.grep;
		expect(rule?.resultMeta?.({ details: { matchCount: 3 } })).toEqual([
			"3 matches",
		]);
		expect(rule?.resultMeta?.({ details: { matchCount: 1 } })).toEqual([
			"1 match",
		]);
		expect(rule?.resultMeta?.({ details: {} })).toEqual([]);
	});

	test("glob reports the file count with singular/plural", () => {
		const rule = TOOL_RULES.glob;
		expect(rule?.resultMeta?.({ details: { fileCount: 5 } })).toEqual([
			"5 files",
		]);
		expect(rule?.resultMeta?.({ details: { fileCount: 1 } })).toEqual([
			"1 file",
		]);
		expect(rule?.resultMeta?.({ details: {} })).toEqual([]);
	});

	test("resolve/reject report the apply/discard action and its source", () => {
		const result = {
			details: {
				xdev: {
					tool: "resolve",
					inner: {
						action: "apply",
						reason: "applying staged edit",
						sourceToolName: "edit",
						label: "src/a.ts",
					},
				},
			},
		};
		expect(TOOL_RULES.resolve?.resultMeta?.(result)).toEqual(["apply", "edit"]);
		expect(TOOL_RULES.reject?.resultMeta?.(result)).toEqual(["apply", "edit"]);
		// fallback to a generic settled status, then empty
		expect(
			TOOL_RULES.resolve?.resultMeta?.({ details: { status: "success" } }),
		).toEqual(["success"]);
		expect(TOOL_RULES.resolve?.resultMeta?.(undefined)).toEqual([]);
		expect(TOOL_RULES.resolve?.resultMeta?.({ details: {} })).toEqual([]);
	});

	test("no other rule carries result metadata", () => {
		for (const name of [
			"read",
			"write",
			"edit",
			"hub",
			"todo",
			"eval",
			"yield",
			"hus",
			"ast_grep",
			"ast_edit",
			"inspect_image",
			"browser",
			"ask",
			"computer",
			"task",
		]) {
			expect(TOOL_RULES[name]?.resultMeta, name).toBeUndefined();
		}
	});
});

describe("registry shape types", () => {
	test("routes and audit kinds are the shared closed unions", () => {
		const routes: ToolRoute[] = ["compact", "read-group", "native-live"];
		const audits: ToolAuditKind[] = ["none", "write", "edit", "git-bash"];
		expect(routes).toHaveLength(3);
		expect(audits).toHaveLength(4);
		for (const rule of Object.values(TOOL_RULES)) {
			expect(rule).toBeDefined();
			if (!rule) continue;
			expect(routes).toContain(rule.route);
			expect(audits).toContain(rule.audit);
		}
	});

	test("interactive four carry evidence-based arg/detail inventories", () => {
		expect(TOOL_RULES.browser?.knownArgs).toEqual([
			"action",
			"name",
			"url",
			"app",
			"viewport",
			"wait_until",
			"dialogs",
			"code",
			"timeout",
			"all",
			"kill",
		]);
		expect(TOOL_RULES.browser?.knownDetails).toEqual([
			"action",
			"name",
			"url",
			"browser",
			"viewport",
			"observation",
			"screenshots",
		]);
		expect(TOOL_RULES.computer?.knownArgs).toEqual([
			"code",
			"i",
			"read_only",
			"timeout",
		]);
		expect(TOOL_RULES.computer?.knownDetails).toEqual([
			"code",
			"readOnly",
			"screenshots",
			"returnValue",
			"backend",
			"capturePermission",
			"inputPermission",
			"axPermission",
		]);
		for (const name of ["resolve", "reject"]) {
			expect(TOOL_RULES[name]?.knownArgs).toEqual([
				"path",
				"file_path",
				"content",
				"reason",
				"status",
				"result",
			]);
			expect(TOOL_RULES[name]?.knownDetails).toEqual([
				"xdev",
				"action",
				"reason",
				"sourceToolName",
				"label",
				"sourceResultDetails",
				"status",
			]);
		}
	});

	test("only computer/resolve/reject descriptions carry titleColor", () => {
		const colored = Object.entries(TOOL_RULES)
			.filter(([, rule]) => rule?.describe !== undefined)
			.map(([name]) => ({
				name,
				color: describeTool(name, {})?.titleColor,
			}))
			.filter((entry) => entry.color !== undefined)
			.sort((a, b) => a.name.localeCompare(b.name));
		expect(colored).toEqual([
			{ name: "computer", color: "#8D2A88" },
			{ name: "reject", color: "#A1471A" },
			{ name: "resolve", color: "#A4D734" },
		]);
	});
});
