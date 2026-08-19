import { beforeAll, describe, expect, test } from "bun:test";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import {
	isRejectedControlCode,
	stripRejectedControls,
} from "../../.omp-plugin/display-control";
import type { DisplayPathOptions } from "../../.omp-plugin/display-path";
import type {
	GitMessageDetails,
	LegacyMutationMessageDetails,
	MutationMessageDetails,
} from "../../.omp-plugin/messages";
import type { CompactToolView } from "../../.omp-plugin/render";
import { loadStockPlugin } from "./test-stock-host";

interface RenderModule {
	renderCompactToolRows(
		view: CompactToolView,
		theme: Theme,
		width?: number,
		displayPaths?: DisplayPathOptions,
	): readonly string[];
	renderInjectRuleRows(
		rules: readonly { name: string; body?: string }[],
		theme: Theme,
		width?: number,
	): readonly string[];
	injectRulesFromTtsrComponent(
		block: unknown,
	): readonly { name: string; body?: string }[] | undefined;
	todoReminderFromComponent(block: unknown):
		| {
				count: number;
				attempt: number;
				maxAttempts: number;
				items: readonly string[];
		  }
		| undefined;
	renderTodoReminderRow(
		view: {
			count: number;
			attempt: number;
			maxAttempts: number;
			items: readonly string[];
		},
		theme: Theme,
		width?: number,
	): readonly string[];
	userBashExecutionFromComponent(
		block: unknown,
		observed?: {
			exitCode?: number;
			cancelled?: boolean;
			expanded?: boolean;
		},
	):
		| {
				kind: "bash";
				source: string;
				running: boolean;
				exitCode?: number;
				cancelled?: boolean;
				expanded?: boolean;
		  }
		| undefined;
	userEvalExecutionFromComponent(
		block: unknown,
		observed?: {
			exitCode?: number;
			cancelled?: boolean;
			expanded?: boolean;
		},
	):
		| {
				kind: "python";
				source: string;
				running: boolean;
				exitCode?: number;
				cancelled?: boolean;
				expanded?: boolean;
		  }
		| undefined;
	renderUserExecutionRow(
		view: {
			kind: "bash" | "python";
			source: string;
			running: boolean;
			exitCode?: number;
			cancelled?: boolean;
			expanded?: boolean;
		},
		theme: Theme,
		width?: number,
	): readonly string[];
	skillMessageFromComponent(
		block: unknown,
		observed?: { expanded?: boolean },
	):
		| {
				name: string;
				args?: string;
				path?: string;
				lineCount?: number;
				expanded?: boolean;
		  }
		| undefined;
	renderSkillMessageRow(
		view: {
			name: string;
			args?: string;
			path?: string;
			lineCount?: number;
			expanded?: boolean;
		},
		theme: Theme,
		width?: number,
	): readonly string[];
	lateDiagnosticsFromComponent(
		block: unknown,
		observed?: { expanded?: boolean },
	):
		| {
				errored: boolean;
				summary?: string;
				count: number;
				firstMessage?: string;
				expanded?: boolean;
		  }
		| undefined;
	renderLateDiagnosticsRow(
		view: {
			errored: boolean;
			summary?: string;
			count: number;
			firstMessage?: string;
			expanded?: boolean;
		},
		theme: Theme,
		width?: number,
	): readonly string[];
	gitLine(entry: GitMessageDetails, theme: Theme): string;
	gitMessageComponent(
		details: GitMessageDetails | undefined,
		theme: Theme,
	): Component | undefined;
	gitCommitHashes(details: GitMessageDetails): string[];
	terminalGitSummaryLine(
		hashes: readonly string[],
		theme: Theme,
		width?: number,
	): string;
	mutationLine(
		entry: MutationMessageDetails | LegacyMutationMessageDetails,
		theme: Theme,
		displayPaths?: DisplayPathOptions,
	): string;
	sanitizeOneLine(value: unknown, limit?: number): string;
}

let renderModule: RenderModule;
let truncateToWidth: (value: string, width: number) => string;

beforeAll(async () => {
	// This test intentionally exercises the stock-runtime module boundary: the
	// plugin source tree resolves @oh-my-pi through its node_modules link to
	// the pinned runtime install.
	renderModule = await loadStockPlugin<RenderModule>(
		"render.ts",
		"render-test",
	);
	const tuiModule = (await import("@oh-my-pi/pi-tui")) as {
		truncateToWidth(value: string, width: number): string;
	};
	truncateToWidth = tuiModule.truncateToWidth;
});

function renderCompactToolRows(
	view: CompactToolView,
	theme: Theme,
	width?: number,
	displayPaths?: DisplayPathOptions,
): readonly string[] {
	return renderModule.renderCompactToolRows(view, theme, width, displayPaths);
}

function gitLine(entry: GitMessageDetails, theme: Theme): string {
	return renderModule.gitLine(entry, theme);
}

function gitMessageComponent(
	details: GitMessageDetails | undefined,
	theme: Theme,
): Component | undefined {
	return renderModule.gitMessageComponent(details, theme);
}

function mutationLine(
	entry: MutationMessageDetails | LegacyMutationMessageDetails,
	theme: Theme,
	displayPaths?: DisplayPathOptions,
): string {
	return renderModule.mutationLine(entry, theme, displayPaths);
}

function sanitizeOneLine(value: unknown, limit?: number): string {
	return renderModule.sanitizeOneLine(value, limit);
}

const ACTIVITY_FRAMES = ["⠦", "⠧", "⠇", "⠏"];
const STATUS_FRAMES = ["⣾", "⣽", "⣻", "⢿"];

function fakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => `\x1b[38;2;1;1;1m${text}\x1b[39m`,
		bg: (_color: string, text: string) => `\x1b[48;2;2;2;2m${text}\x1b[49m`,
		getFgAnsi: () => "\x1b[38;2;1;1;1m",
		getBgAnsi: () => "\x1b[48;2;2;2;2m",
		spinnerFrames: STATUS_FRAMES,
		getSpinnerFrames: (type: string) =>
			type === "activity" ? ACTIVITY_FRAMES : STATUS_FRAMES,
	} as unknown as Theme;
}

function stripAnsi(value: string): string {
	return Bun.stripANSI(value);
}

function routineView(overrides: Partial<CompactToolView>): CompactToolView {
	return {
		toolName: "bash",
		args: { command: "bun test" },
		isError: false,
		isPartial: false,
		...overrides,
	};
}

describe("routine rows", () => {
	test("settled rows start with the compact bullet and a lowercase label", () => {
		const [line] = renderCompactToolRows(routineView({}), fakeTheme());
		expect(stripAnsi(line ?? "")).toMatch(/^• bash: bun test/);
		expect(line ?? "").not.toContain("\x1b[1m");
	});

	test("read rows use `• read <path>` without a colon separator", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "read",
				args: { path: "/Volumes" },
			}),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe("• read /Volumes");
	});

	test("read offset descriptions keep their range punctuation", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "read",
				args: { path: "src/a.ts", offset: 10, limit: 5 },
			}),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe("• read src/a.ts:10-14");
	});

	test("underscore and hyphen aliases share one lowercase label", () => {
		const underscore = renderCompactToolRows(
			routineView({ toolName: "ast_grep", args: { pat: "foo" } }),
			fakeTheme(),
		);
		const hyphen = renderCompactToolRows(
			routineView({ toolName: "ast-grep", args: { pat: "foo" } }),
			fakeTheme(),
		);
		expect(stripAnsi(underscore[0] ?? "")).toMatch(/^• ast grep: foo/);
		expect(underscore).toEqual(hyphen);
	});

	test("unknown tool titles are lowercased after sanitization", () => {
		const [line] = renderCompactToolRows(
			routineView({ toolName: "Custom_Tool", args: { value: "x" } }),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toMatch(/^• custom tool: value: x/);
	});

	test("underscore and hyphen spellings of any tool share one label", () => {
		const underscore = renderCompactToolRows(
			routineView({ toolName: "custom_tool", args: { value: "x" } }),
			fakeTheme(),
		);
		const hyphen = renderCompactToolRows(
			routineView({ toolName: "custom-tool", args: { value: "x" } }),
			fakeTheme(),
		);
		expect(underscore).toEqual(hyphen);
		expect(stripAnsi(hyphen[0] ?? "")).toMatch(/^• custom tool: value: x/);
	});

	test("non-read summaries keep their readable colon punctuation", () => {
		const [line] = renderCompactToolRows(
			routineView({ args: { command: "bun test", cwd: "/tmp" } }),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe("• bash: bun test · in /tmp");
	});

	test("routine rows stay on the transparent terminal background", () => {
		const [line] = renderCompactToolRows(routineView({}), fakeTheme());
		expect(line).not.toContain("\x1b[48;");
		expect(line).not.toContain("\x1b[49m");
	});

	test("routine rows do not pad transparent lines to the requested width", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "read",
				args: { path: "a.ts" },
			}),
			fakeTheme(),
			20,
		);
		expect(stripAnsi(line ?? "")).toBe("• read a.ts");
		expect(stripAnsi(line ?? "").length).toBeLessThan(20);
	});

	test("short transparent rows survive host truncation unchanged", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "read",
				args: { path: "a.ts" },
			}),
			fakeTheme(),
			20,
		);
		const hostTruncated = truncateToWidth(line ?? "", 20);
		expect(hostTruncated).toBe(line);
	});

	test("overflowing transparent rows are fitted to width", () => {
		const [line] = renderCompactToolRows(
			routineView({ args: { command: "x".repeat(60) } }),
			fakeTheme(),
			20,
		);
		expect(stripAnsi(line ?? "").length).toBeLessThanOrEqual(20);
		expect(line).not.toContain("\x1b[48;");
	});

	test("error rows keep the error marker without adding a background", () => {
		const [line] = renderCompactToolRows(
			routineView({
				args: { command: "boom" },
				result: { content: [{ type: "text", text: "failed" }] },
				isError: true,
			}),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toMatch(/^✗ bash: boom/);
		expect(line).not.toContain("\x1b[48;");
	});
});

describe("settled result metadata from the registry", () => {
	test("bash rows append exit code and wall time after the summary meta", () => {
		const [line] = renderCompactToolRows(
			routineView({
				args: { command: "boom", cwd: "/tmp" },
				result: { details: { exitCode: 2, wallTimeMs: 1500 } },
				isError: true,
			}),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe(
			"✗ bash: boom · in /tmp · exit 2 · 1.5s",
		);
	});

	test("grep rows append the match count", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "grep",
				args: { pattern: "x" },
				result: { details: { matchCount: 3 } },
			}),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe("• grep: x · 3 matches");
	});

	test("glob rows append the file count", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "glob",
				args: { path: ["src/*.ts"] },
				result: { details: { fileCount: 1 } },
			}),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe("• glob: src/*.ts · 1 file");
	});

	test("error result text joins tool metadata in order", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "grep",
				args: { pattern: "x" },
				result: {
					content: [{ type: "text", text: "no such file" }],
					details: { matchCount: 0 },
				},
				isError: true,
			}),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe("✗ grep: x · 0 matches · no such file");
	});
});

describe("mutation and Git rows stay transparent", () => {
	test("write/edit mutation rows keep fixed stat colors and stay transparent", () => {
		const line = mutationLine(
			{
				version: 1,
				toolCallId: "t1",
				toolName: "write",
				path: "/tmp/a.ts",
				added: 3,
				removed: 1,
				exact: true,
			},
			fakeTheme(),
		);
		expect(line).not.toContain("\x1b[48;");
		expect(line).toContain(Bun.color("#A4D734", "ansi-16m") ?? "");
		expect(line).toContain(Bun.color("#A1471A", "ansi-16m") ?? "");
		expect(line).toContain("•");
	});

	test("exact mutation rows stay transparent through the row renderer", () => {
		const lines = renderCompactToolRows(
			{
				toolName: "write",
				args: { path: "/tmp/a.ts" },
				isError: false,
				isPartial: false,
				mutationEntries: [
					{
						version: 1,
						toolCallId: "t1",
						toolName: "write",
						path: "/tmp/a.ts",
						added: 3,
						removed: 1,
						exact: true,
					},
				],
			},
			fakeTheme(),
			40,
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("\x1b[48;");
	});

	test("mutation rows fit to width without wrapping", () => {
		const longPath = `/tmp/${"dir/".repeat(40)}file.ts`;
		const lines = renderCompactToolRows(
			{
				toolName: "write",
				args: { path: longPath },
				isError: false,
				isPartial: false,
				mutationEntries: [
					{
						version: 1,
						toolCallId: "t1",
						toolName: "write",
						path: longPath,
						added: 12,
						removed: 4,
						exact: true,
					},
				],
			},
			fakeTheme(),
			40,
		);
		expect(lines).toHaveLength(1);
		const text = stripAnsi(lines[0] ?? "");
		// One-row contract: the fitted line must not exceed the terminal width.
		expect(text.length).toBeLessThanOrEqual(40);
		// Counts are the evidence the row exists to convey — never clip them.
		expect(text.endsWith("+12|4") || text.includes("+12|4")).toBe(true);
		expect(text).toMatch(/\+12\|4\s*$/);
	});

	test("delete mutation rows keep the removed count when fitted", () => {
		const longPath = `/tmp/${"x".repeat(200)}.ts`;
		const lines = renderCompactToolRows(
			{
				toolName: "delete",
				args: { path: longPath },
				isError: false,
				isPartial: false,
				mutationEntries: [
					{
						version: 1,
						toolCallId: "t1",
						toolName: "delete",
						path: longPath,
						added: 0,
						removed: 7,
						exact: true,
					},
				],
			},
			fakeTheme(),
			36,
		);
		expect(lines).toHaveLength(1);
		const text = stripAnsi(lines[0] ?? "");
		expect(text.length).toBeLessThanOrEqual(36);
		expect(text).toMatch(/-7\s*$/);
	});

	test("standalone gitLine keeps its markers and stays surface-free for reuse", () => {
		const ok = gitLine(
			{
				version: 1,
				toolCallId: "g1",
				subcommand: "commit",
				text: "git commit abc1234 subject",
				isError: false,
			},
			fakeTheme(),
		);
		const failed = gitLine(
			{
				version: 1,
				toolCallId: "g2",
				subcommand: "rebase",
				text: "✗ git rebase main",
				isError: true,
			},
			fakeTheme(),
		);
		expect(ok).not.toContain("\x1b[48;");
		expect(ok).toContain("•");
		expect(failed).toContain("✗");
		expect(failed).not.toContain("\x1b[48;");
	});

	test("git rows stay transparent through the row renderer", () => {
		const lines = renderCompactToolRows(
			{
				toolName: "bash",
				args: { command: "git status" },
				isError: false,
				isPartial: false,
				git: {
					version: 1,
					toolCallId: "g1",
					subcommand: "status",
					text: "git status",
					isError: false,
				},
			},
			fakeTheme(),
			40,
		);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0] ?? "")).toBe("• git status");
		expect(lines[0]).not.toContain("\x1b[48;");
	});

	test("failed git rows keep the error marker without a background", () => {
		const [line] = renderCompactToolRows(
			{
				toolName: "bash",
				args: { command: "git rebase main" },
				isError: true,
				isPartial: false,
				git: {
					version: 1,
					toolCallId: "g2",
					subcommand: "rebase",
					text: "✗ git rebase main",
					isError: true,
				},
			},
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toMatch(/^✗ git rebase main/);
		expect(line).not.toContain("\x1b[48;");
	});

	test("gitLine strips exactly one leading icon for bare ✗ text", () => {
		for (const text of ["✗", "✗ ", "✗  "]) {
			const line = gitLine(
				{
					version: 1,
					toolCallId: "g3",
					subcommand: "rebase",
					text,
					isError: true,
				},
				fakeTheme(),
			);
			expect(stripAnsi(line)).toBe("✗");
			expect((stripAnsi(line).match(/✗/g) ?? []).length).toBe(1);
		}
	});

	test("gitLine keeps the icon single for icon-prefixed error text", () => {
		const line = gitLine(
			{
				version: 1,
				toolCallId: "g4",
				subcommand: "rebase",
				text: "✗ git rebase main",
				isError: true,
			},
			fakeTheme(),
		);
		expect(stripAnsi(line)).toMatch(/^✗ git rebase main/);
		expect((stripAnsi(line).match(/✗/g) ?? []).length).toBe(1);
	});

	test("legacy git message components stay transparent at render width", () => {
		const component = gitMessageComponent(
			{
				version: 1,
				toolCallId: "g1",
				subcommand: "commit",
				text: "git commit abc1234 subject",
				isError: false,
			},
			fakeTheme(),
		);
		const lines = component?.render(20) ?? [];
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0] ?? "").length).toBeLessThanOrEqual(20);
		expect(lines[0]).not.toContain("\x1b[48;");
	});
});

describe("delete mutation rows", () => {
	const removedColor = Bun.color("#A1471A", "ansi-16m") ?? "";

	test("exact delete rows show a red title, gray path and red removed stat", () => {
		const line = mutationLine(
			{
				version: 1,
				toolCallId: "t1",
				toolName: "delete",
				path: "/tmp/gone.ts",
				added: 0,
				removed: 3,
				exact: true,
			},
			fakeTheme(),
		);
		expect(stripAnsi(line)).toBe("• delete: /tmp/gone.ts -3");
		expect(line).not.toContain("\x1b[48;");
		// Title and removed stat share the removal red; the path stays muted.
		expect(line).toContain(removedColor);
		expect(line).toContain("•");
	});

	test("delete rows with unknown removed count render no stat at all", () => {
		const line = mutationLine(
			{
				toolCallId: "t1",
				toolName: "delete",
				path: "/tmp/gone.ts",
				added: 0,
				removed: 0,
				exact: false,
			},
			fakeTheme(),
		);
		expect(stripAnsi(line)).toBe("• delete: /tmp/gone.ts");
		expect(line).not.toContain("\x1b[48;");
	});

	test("delete rows with a missing removed count render no stat at all", () => {
		const line = mutationLine(
			{
				toolCallId: "t1",
				toolName: "delete",
				path: "/tmp/gone.ts",
				exact: true,
			},
			fakeTheme(),
		);
		expect(stripAnsi(line)).toBe("• delete: /tmp/gone.ts");
	});

	test("count-less legacy delete entries flow through the row renderer without stats", () => {
		const lines = renderCompactToolRows(
			{
				toolName: "delete",
				args: { path: "/tmp/gone.ts" },
				isError: false,
				isPartial: false,
				mutationEntries: [
					{
						toolCallId: "t1",
						toolName: "delete",
						path: "/tmp/gone.ts",
						exact: false,
					},
				],
			},
			fakeTheme(),
			40,
		);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0] ?? "")).toBe("• delete: /tmp/gone.ts");
		expect(lines[0]).not.toContain("\x1b[48;");
	});

	test("exact delete rows stay transparent through the row renderer", () => {
		const lines = renderCompactToolRows(
			{
				toolName: "delete",
				args: { path: "/tmp/gone.ts", content: "" },
				isError: false,
				isPartial: false,
				mutationEntries: [
					{
						version: 1,
						toolCallId: "t1",
						toolName: "delete",
						path: "/tmp/gone.ts",
						added: 0,
						removed: 4,
						exact: true,
					},
				],
			},
			fakeTheme(),
			40,
		);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0] ?? "")).toBe("• delete: /tmp/gone.ts -4");
		expect(lines[0]).not.toContain("\x1b[48;");
	});

	test("delete rows relativize the audited path when enabled", () => {
		const display = { cwd: "/project", enabled: true };
		const entry = {
			version: 1,
			toolCallId: "t1",
			toolName: "delete",
			path: "/project/src/gone.ts",
			added: 0,
			removed: 5,
			exact: true,
		};
		expect(stripAnsi(mutationLine(entry, fakeTheme(), display))).toBe(
			"• delete: src/gone.ts -5",
		);
		expect(stripAnsi(mutationLine(entry, fakeTheme()))).toBe(
			"• delete: /project/src/gone.ts -5",
		);
		expect(
			stripAnsi(
				mutationLine({ ...entry, path: "/etc/hosts" }, fakeTheme(), display),
			),
		).toBe("• delete: /etc/hosts -5");
	});

	test("delete rows bound long and astral paths like other mutation rows", () => {
		const longPath = `/project/${"a".repeat(400)}.ts`;
		const [line] = renderCompactToolRows(
			{
				toolName: "delete",
				args: { path: longPath, content: "" },
				isError: false,
				isPartial: false,
				mutationEntries: [
					{
						version: 1,
						toolCallId: "t1",
						toolName: "delete",
						path: longPath,
						added: 0,
						removed: 1,
						exact: true,
					},
				],
			},
			fakeTheme(),
			undefined,
		);
		expect(stripAnsi(line ?? "")).toBe(
			"• delete: ".concat("/project/", "a".repeat(170), "… -1"),
		);
		const astralPath = `/project/${"🚀".repeat(200)}.ts`;
		const [astral] = renderCompactToolRows(
			{
				toolName: "delete",
				args: { path: astralPath, content: "" },
				isError: false,
				isPartial: false,
				mutationEntries: [
					{
						version: 1,
						toolCallId: "t2",
						toolName: "delete",
						path: astralPath,
						added: 0,
						removed: 1,
						exact: true,
					},
				],
			},
			fakeTheme(),
			undefined,
		);
		const stripped = stripAnsi(astral ?? "");
		expect(stripped.startsWith("• delete: /project/")).toBe(true);
		expect([...stripped].some((ch) => ch === "\uFFFD")).toBe(false);
	});

	test("mixed delete and edit entries keep their distinct rows", () => {
		const lines = renderCompactToolRows(
			{
				toolName: "edit",
				args: { path: "/tmp" },
				isError: false,
				isPartial: false,
				mutationEntries: [
					{
						version: 1,
						toolCallId: "t1",
						toolName: "delete",
						path: "/tmp/gone.ts",
						added: 0,
						removed: 2,
						exact: true,
					},
					{
						version: 1,
						toolCallId: "t2",
						toolName: "edit",
						path: "/tmp/kept.ts",
						added: 1,
						removed: 1,
						exact: true,
					},
				],
			},
			fakeTheme(),
		);
		expect(lines.map((row) => stripAnsi(row ?? ""))).toEqual([
			"• delete: /tmp/gone.ts -2",
			"• edit: /tmp/kept.ts +1|1",
		]);
	});

	test("legacy delete entries persisted as edit rows keep their old rendering", () => {
		const line = mutationLine(
			{
				version: 1,
				toolCallId: "t1",
				toolName: "edit",
				path: "/tmp/legacy-gone.ts",
				added: 0,
				removed: 2,
				exact: true,
			},
			fakeTheme(),
		);
		expect(stripAnsi(line)).toBe("• edit: /tmp/legacy-gone.ts +0|2");
	});
});

describe("sanitizeOneLine", () => {
	test("strips ANSI escapes and control characters", () => {
		expect(sanitizeOneLine("a\x1b[31mb\x1b[0m\x00c\td")).toBe("abc d");
	});

	test("bounds long text with a single ellipsis", () => {
		expect(sanitizeOneLine("x".repeat(300), 10)).toBe("xxxxxxxxx…");
	});

	test("truncates at code-point boundaries without splitting surrogate pairs", () => {
		const emoji = "🚀".repeat(120);
		expect(sanitizeOneLine(emoji, 10)).toBe(`${"🚀".repeat(9)}…`);
		// 120 code points fit the 120 budget despite 240 UTF-16 units
		expect(sanitizeOneLine(emoji, 120)).toBe(emoji);
	});

	test("keeps the code-point budget exact for mixed astral text", () => {
		// the budget includes the ellipsis: limit-1 content code points + …
		expect(sanitizeOneLine("a🚀b🚀c🚀d🚀e", 4)).toBe("a🚀b…");
		expect([...sanitizeOneLine("a🚀b🚀c🚀d🚀e", 4)].length).toBe(4);
	});

	test("strips DEL, C1 controls, and Unicode line/paragraph separators", () => {
		// stripControl must match git-records oneLine's rejected class for
		// these codes (DEL 0x7F, C1 0x80–0x9F, U+2028/U+2029). sanitizeOneLine
		// then collapses residual whitespace, so a dropped control between
		// letters leaves a single space when tab was adjacent — here the
		// controls sit between printable runs with no whitespace neighbors.
		expect(sanitizeOneLine("a\x7Fb\x9Bc\u2028d\u2029e")).toBe("abcde");
		// Representative single-byte CSI (0x9B) must not survive into a row.
		expect(sanitizeOneLine(`pre\x9B[31mpost`)).toBe("pre[31mpost");
	});

	test("keeps astral code points intact while filtering controls", () => {
		const input = `ok\x7F🚀\x9B中\u{1F600}`;
		expect(sanitizeOneLine(input)).toBe("ok🚀中😀");
		// Byte-for-byte on the surviving astral characters (no U+FFFD).
		expect([...sanitizeOneLine(input)]).toEqual(["o", "k", "🚀", "中", "😀"]);
	});
});

describe("shared display control class", () => {
	// Single pin for the rejected control class shared by render stripControl,
	// git-records oneLine, and settings-ui truncation. A future edit to the
	// class fails here instead of drifting silently between call sites.
	test("rejects DEL, C1, and Unicode line/paragraph separators", () => {
		expect(isRejectedControlCode(0x7f)).toBe(true); // DEL
		expect(isRejectedControlCode(0x9b)).toBe(true); // single-byte CSI
		expect(isRejectedControlCode(0x80)).toBe(true);
		expect(isRejectedControlCode(0x9f)).toBe(true);
		expect(isRejectedControlCode(0x2028)).toBe(true);
		expect(isRejectedControlCode(0x2029)).toBe(true);
		expect(isRejectedControlCode(0x00)).toBe(true);
		expect(isRejectedControlCode(0x1b)).toBe(true); // ESC (ANSI stripped separately)
	});

	test("preserves TAB/LF/CR for multi-line row shaping callers", () => {
		expect(isRejectedControlCode(0x09)).toBe(false);
		expect(isRejectedControlCode(0x0a)).toBe(false);
		expect(isRejectedControlCode(0x0d)).toBe(false);
		expect(stripRejectedControls("a\tb\nc\rd")).toBe("a\tb\nc\rd");
	});

	test("keeps printable ASCII and astral code points intact", () => {
		expect(isRejectedControlCode(0x20)).toBe(false); // space
		expect(isRejectedControlCode(0x41)).toBe(false); // A
		// High surrogate of 🚀 is outside every rejected range when the
		// caller iterates by code point and reads charCodeAt(0).
		expect(isRejectedControlCode("🚀".charCodeAt(0))).toBe(false);
		expect(stripRejectedControls("ok\x7F🚀\x9B中\u{1F600}")).toBe("ok🚀中😀");
		expect([...stripRejectedControls("ok\x7F🚀\x9B中\u{1F600}")]).toEqual([
			"o",
			"k",
			"🚀",
			"中",
			"😀",
		]);
	});
});

describe("pending rows", () => {
	test("advance deterministically through the active theme activity frames", () => {
		const frames: string[] = [];
		for (let tick = 0; tick < 4; tick++) {
			const [line] = renderCompactToolRows(
				routineView({ isPartial: true, tick }),
				fakeTheme(),
			);
			frames.push(stripAnsi(line ?? ""));
		}
		expect(frames).toEqual([
			"⠦ Working… bash: bun test",
			"⠧ Working… bash: bun test",
			"⠇ Working… bash: bun test",
			"⠏ Working… bash: bun test",
		]);
	});

	test("the frame cycle wraps deterministically beyond the frame list", () => {
		const [line] = renderCompactToolRows(
			routineView({ isPartial: true, tick: 4 }),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe("⠦ Working… bash: bun test");
	});

	test("pending read rows keep the path after Working…", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "read",
				args: { path: "src/a.ts" },
				isPartial: true,
				tick: 0,
			}),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe("⠦ Working… read src/a.ts");
	});

	test("pending rows contain Working… and no hourglass or emoji", () => {
		const [line] = renderCompactToolRows(
			routineView({ isPartial: true, tick: 1 }),
			fakeTheme(),
		);
		const text = stripAnsi(line ?? "");
		expect(text).toContain("Working…");
		expect(text).not.toMatch(/⏳|⌛|⏰|🕐|🕑|🕒|🕓|🕔|🕕|🕖|🕗|🕘|🕙|🕚|🕛/);
	});

	test("pending rows stay on the transparent terminal background", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "read",
				args: { path: "/Volumes" },
				isPartial: true,
				tick: 0,
			}),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe("⠦ Working… read /Volumes");
		expect(line).not.toContain("\x1b[48;");
	});
});

describe("terminal Git commit summary", () => {
	function gitDetails(
		overrides: Partial<GitMessageDetails> = {},
	): GitMessageDetails {
		return {
			version: 1,
			toolCallId: "g1",
			subcommand: "commit",
			text: "git commit abc1234 Subject",
			isError: false,
			...overrides,
		};
	}

	test("collects successful commit hashes in command order", () => {
		expect(
			renderModule.gitCommitHashes(
				gitDetails({
					subcommand: "add",
					text: "git add src/a.ts",
					records: [
						{ subcommand: "add", text: "git add src/a.ts", isError: false },
						{
							subcommand: "commit",
							text: "git commit abc1234 Add a",
							isError: false,
						},
						{ subcommand: "status", text: "git status", isError: false },
						{
							subcommand: "commit",
							text: "git commit f00d55 Fix b",
							isError: false,
						},
					],
				}),
			),
		).toEqual(["abc1234", "f00d55"]);
	});

	test("excludes failed commits and hashless commit invocations", () => {
		expect(
			renderModule.gitCommitHashes(
				gitDetails({
					records: [
						{ subcommand: "commit", text: "✗ git commit -m x", isError: true },
						{
							subcommand: "commit",
							text: "git commit -m 'no hash shown'",
							isError: false,
						},
					],
				}),
			),
		).toEqual([]);
	});

	test("legacy single-record entries follow their own subcommand", () => {
		expect(
			renderModule.gitCommitHashes(
				gitDetails({ subcommand: "commit", text: "git commit bee1234 Fix" }),
			),
		).toEqual(["bee1234"]);
		expect(
			renderModule.gitCommitHashes(
				gitDetails({ subcommand: "status", text: "git status" }),
			),
		).toEqual([]);
		expect(
			renderModule.gitCommitHashes(
				gitDetails({
					subcommand: "commit",
					text: "✗ git commit -m x",
					isError: true,
				}),
			),
		).toEqual([]);
	});

	test("summary line orders hashes and colors only the last with added foreground", () => {
		const line = renderModule.terminalGitSummaryLine(
			["abc1234", "f00d55"],
			fakeTheme(),
		);
		expect(stripAnsi(line)).toBe("• git commit: abc1234, f00d55");
		const added = Bun.color("#A4D734", "ansi-16m") ?? "";
		expect(added.length).toBeGreaterThan(0);
		expect(line).toContain(added);
		// exactly one hash carries the added foreground; the label and earlier
		// hashes stay neutral and the row never paints a background
		expect(line.split(added).length - 1).toBe(1);
		expect(line).not.toContain("\x1b[48;");
	});

	test("summary line stays width-safe and transparent at narrow widths", () => {
		const line = renderModule.terminalGitSummaryLine(
			["abc1234", "f00d55", "cafebabe"],
			fakeTheme(),
			20,
		);
		const text = stripAnsi(line);
		expect(text.length).toBeLessThanOrEqual(20);
		// old hashes are dropped with an ellipsis; the newest hash is never cut
		expect(text).toContain("…");
		expect(text).toContain("cafebabe");
		expect(text).not.toContain("abc1234");
		expect(line).not.toContain("\x1b[48;");
		const added = Bun.color("#A4D734", "ansi-16m") ?? "";
		expect(line.split(added).length - 1).toBe(1);
	});

	test("summary line drops oldest hashes first with many commits", () => {
		const hashes = [
			"abc1234",
			"def5678",
			"cafe1234",
			"beef5678",
			"badc0de1",
			"f00d55aa",
			"feedface",
			"c0ffee42",
			"bada55ee",
			"1234abcd",
			"abcdef01",
			"deadbeef",
		];
		// width 60 keeps the label plus the newest four hashes
		const line = renderModule.terminalGitSummaryLine(hashes, fakeTheme(), 60);
		const text = stripAnsi(line);
		expect(text).toBe(
			"• git commit: …, bada55ee, 1234abcd, abcdef01, deadbeef",
		);
		expect(text.length).toBeLessThanOrEqual(60);
		const added = Bun.color("#A4D734", "ansi-16m") ?? "";
		// exactly the newest hash keeps the added foreground
		expect(line.split(added).length - 1).toBe(1);
		expect(line.indexOf(added)).toBeLessThan(line.indexOf("deadbeef"));
	});

	test("summary line drops the label before ever clipping the newest hash", () => {
		const line = renderModule.terminalGitSummaryLine(
			["abc1234", "f00d55"],
			fakeTheme(),
			8,
		);
		const text = stripAnsi(line);
		expect(text).toBe("f00d55");
		expect(text.length).toBeLessThanOrEqual(8);
		const added = Bun.color("#A4D734", "ansi-16m") ?? "";
		expect(line.split(added).length - 1).toBe(1);
	});

	test("summary line keeps the ellipsis once it fits alongside the newest hash", () => {
		const line = renderModule.terminalGitSummaryLine(
			["abc1234", "f00d55"],
			fakeTheme(),
			9,
		);
		expect(stripAnsi(line)).toBe("…, f00d55");
	});

	test("working live view keeps every record of a multi-record Git call", () => {
		const lines = renderCompactToolRows(
			{
				toolName: "bash",
				args: { command: "git add src/a.ts && git commit -m 'Add a'" },
				isError: false,
				isPartial: false,
				git: gitDetails({
					subcommand: "add",
					text: "git add src/a.ts",
					records: [
						{ subcommand: "add", text: "git add src/a.ts", isError: false },
						{
							subcommand: "commit",
							text: "git commit abc1234 Add a",
							isError: false,
						},
					],
				}),
			},
			fakeTheme(),
		);
		expect(lines).toHaveLength(2);
		expect(stripAnsi(lines[0] ?? "")).toBe("• git add src/a.ts");
		expect(stripAnsi(lines[1] ?? "")).toBe("• git commit abc1234 Add a");
	});
});

describe("project-relative display paths", () => {
	const display = { cwd: "/project", enabled: true };

	test("read rows relativize in-cwd paths when enabled", () => {
		const [line] = renderCompactToolRows(
			routineView({ toolName: "read", args: { path: "/project/docs/x.md" } }),
			fakeTheme(),
			undefined,
			display,
		);
		expect(stripAnsi(line ?? "")).toBe("• read docs/x.md");
	});

	test("read rows keep selectors and stay byte-for-byte when off", () => {
		const args = { path: "/project/docs/x.md:10-20" };
		const withDisplay = renderCompactToolRows(
			routineView({ toolName: "read", args }),
			fakeTheme(),
			undefined,
			display,
		);
		expect(stripAnsi(withDisplay[0] ?? "")).toBe("• read docs/x.md:10-20");
		const without = renderCompactToolRows(
			routineView({ toolName: "read", args }),
			fakeTheme(),
		);
		const off = renderCompactToolRows(
			routineView({ toolName: "read", args }),
			fakeTheme(),
			undefined,
			{ cwd: "/project", enabled: false },
		);
		expect(off).toEqual(without);
		expect(stripAnsi(off[0] ?? "")).toBe("• read /project/docs/x.md:10-20");
	});

	test("external and boundary-lookalike paths keep their absolute form", () => {
		const [external] = renderCompactToolRows(
			routineView({ toolName: "read", args: { path: "/etc/hosts" } }),
			fakeTheme(),
			undefined,
			display,
		);
		expect(stripAnsi(external ?? "")).toBe("• read /etc/hosts");
		const [lookalike] = renderCompactToolRows(
			routineView({ toolName: "read", args: { path: "/project-x/a.ts" } }),
			fakeTheme(),
			undefined,
			display,
		);
		expect(stripAnsi(lookalike ?? "")).toBe("• read /project-x/a.ts");
	});

	test("grouped reads render one relativized row per read state", () => {
		const rows = [
			...renderCompactToolRows(
				routineView({
					toolName: "read",
					args: { path: "/project/src/a.ts" },
				}),
				fakeTheme(),
				undefined,
				display,
			),
			...renderCompactToolRows(
				routineView({
					toolName: "read",
					args: { path: "/project/src/b.ts" },
				}),
				fakeTheme(),
				undefined,
				display,
			),
		];
		expect(rows.map((row) => stripAnsi(row ?? ""))).toEqual([
			"• read src/a.ts",
			"• read src/b.ts",
		]);
	});

	test("mutation rows relativize the audited path when enabled", () => {
		const entry = {
			version: 1,
			toolCallId: "t1",
			toolName: "write",
			path: "/project/src/a.ts",
			added: 3,
			removed: 1,
			exact: true,
		};
		const line = mutationLine(entry, fakeTheme(), display);
		expect(stripAnsi(line)).toBe("• write: src/a.ts +3|1");
		expect(stripAnsi(mutationLine(entry, fakeTheme()))).toBe(
			"• write: /project/src/a.ts +3|1",
		);
		expect(
			stripAnsi(
				mutationLine({ ...entry, path: "/etc/hosts" }, fakeTheme(), display),
			),
		).toBe("• write: /etc/hosts +3|1");
	});

	test("terminal mutation rows go through the same display mapping", () => {
		const [line] = renderCompactToolRows(
			{
				toolName: "write",
				args: { path: "/project/src/a.ts" },
				isError: false,
				isPartial: false,
				mutationEntries: [
					{
						version: 1,
						toolCallId: "t1",
						toolName: "write",
						path: "/project/src/a.ts",
						added: 1,
						removed: 0,
						exact: true,
					},
				],
			},
			fakeTheme(),
			undefined,
			display,
		);
		expect(stripAnsi(line ?? "")).toBe("• write: src/a.ts +1|0");
	});

	test("relative rows still fit the component width without padding", () => {
		const [narrow] = renderCompactToolRows(
			routineView({
				toolName: "read",
				args: { path: "/project/a-very-long-file-name-that-will-not-fit.ts" },
			}),
			fakeTheme(),
			20,
			display,
		);
		expect(stripAnsi(narrow ?? "")).not.toContain("\x1b[48;");
		expect(stripAnsi(narrow ?? "").length).toBeLessThanOrEqual(20);
	});
});

describe("structured title colors", () => {
	const COMPUTER = Bun.color("#8D2A88", "ansi-16m") ?? "";
	const RESOLVE = Bun.color("#A4D734", "ansi-16m") ?? "";
	const REJECT = Bun.color("#A1471A", "ansi-16m") ?? "";
	const RESET = "\x1b[39m";

	/** Visible title text between the given color open and its [39m reset. */
	function coloredTitleSpan(line: string | undefined, open: string): string {
		const text = line ?? "";
		const start = text.indexOf(open);
		if (start < 0) return "";
		const end = text.indexOf(RESET, start);
		return end > start ? text.slice(start + open.length, end) : "";
	}

	/** Substring after the colored title's [39m reset. */
	function afterColoredTitle(line: string | undefined, open: string): string {
		const text = line ?? "";
		const start = text.indexOf(open);
		const end = text.indexOf(RESET, start);
		return end > start ? text.slice(end + RESET.length) : text;
	}

	test("computer rows open the fixed foreground exactly once, on the title only", () => {
		const [line] = renderCompactToolRows(
			routineView({ toolName: "computer", args: { action: "run" } }),
			fakeTheme(),
		);
		expect(COMPUTER.length).toBeGreaterThan(0);
		expect(line ?? "").toContain(COMPUTER);
		expect((line ?? "").split(COMPUTER).length - 1).toBe(1);
		expect(coloredTitleSpan(line, COMPUTER)).toBe("computer use");
		expect(afterColoredTitle(line, COMPUTER)).not.toContain(COMPUTER);
	});

	test("resolve and reject titles use their own fixed colors", () => {
		const resolveLine = renderCompactToolRows(
			routineView({ toolName: "resolve", args: { issue: 42 } }),
			fakeTheme(),
		)[0];
		const rejectLine = renderCompactToolRows(
			routineView({
				toolName: "reject",
				args: { reason: "too long" },
				result: { content: [{ type: "text", text: "rejected" }] },
				isError: true,
			}),
			fakeTheme(),
		)[0];
		expect(RESOLVE.length).toBeGreaterThan(0);
		expect(REJECT.length).toBeGreaterThan(0);
		expect((resolveLine ?? "").split(RESOLVE).length - 1).toBe(1);
		expect(coloredTitleSpan(resolveLine, RESOLVE)).toBe("resolve");
		expect((rejectLine ?? "").split(REJECT).length - 1).toBe(1);
		expect(coloredTitleSpan(rejectLine, REJECT)).toBe("reject");
		expect(resolveLine ?? "").not.toContain(REJECT);
		expect(rejectLine ?? "").not.toContain(RESOLVE);
	});

	test("uncolored browser and routine titles stay dim and hex-free", () => {
		const [browser] = renderCompactToolRows(
			routineView({
				toolName: "browser",
				args: { action: "open", url: "https://example.dev" },
			}),
			fakeTheme(),
		);
		const [bash] = renderCompactToolRows(routineView({}), fakeTheme());
		for (const line of [browser, bash]) {
			expect(line ?? "").not.toContain(COMPUTER);
			expect(line ?? "").not.toContain(RESOLVE);
			expect(line ?? "").not.toContain(REJECT);
		}
		expect(stripAnsi(browser ?? "")).toMatch(/^• browser: /);
		expect(stripAnsi(bash ?? "")).toMatch(/^• bash: /);
	});

	test("pending colored rows color the title but keep Working… dim", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "resolve",
				args: { issue: 42 },
				isPartial: true,
				tick: 0,
			}),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toMatch(/^⠦ Working… resolve/);
		const text = line ?? "";
		expect(text.split(RESOLVE).length - 1).toBe(1);
		expect(text.slice(0, text.indexOf(RESOLVE))).not.toContain(RESOLVE);
		expect(coloredTitleSpan(text, RESOLVE)).toBe("resolve");
	});

	test("error rows color the title while the icon and payload stay uncolored", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "computer",
				args: { action: "run", target: "spotify" },
				result: { content: [{ type: "text", text: "access denied" }] },
				isError: true,
			}),
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toMatch(/^✗ computer use/);
		const text = line ?? "";
		expect(text.split(COMPUTER).length - 1).toBe(1);
		expect(coloredTitleSpan(text, COMPUTER)).toBe("computer use");
		expect(afterColoredTitle(text, COMPUTER)).not.toContain(COMPUTER);
		expect(text).not.toContain("\x1b[48;");
	});

	test("truncating inside a colored title still closes the foreground", () => {
		const [line] = renderCompactToolRows(
			routineView({ toolName: "computer", args: { action: "run" } }),
			fakeTheme(),
			10,
		);
		const text = line ?? "";
		const stripped = stripAnsi(text);
		expect(stripped.length).toBeLessThanOrEqual(10);
		expect(stripped).toMatch(/^• comput/);
		expect(text.split(COMPUTER).length - 1).toBe(1);
		// the single color open is always closed after truncation
		expect(text.indexOf(RESET, text.indexOf(COMPUTER))).toBeGreaterThan(
			text.indexOf(COMPUTER),
		);
		expect(text).not.toContain("\x1b[48;");
	});

	test("long colored rows truncate to width without leaking color into the tail", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "computer",
				args: { action: "run", target: "x".repeat(80) },
			}),
			fakeTheme(),
			16,
		);
		const text = line ?? "";
		expect(stripAnsi(text).length).toBeLessThanOrEqual(16);
		expect(text.split(COMPUTER).length - 1).toBe(1);
		expect(coloredTitleSpan(text, COMPUTER)).toBe("computer use");
		expect(text).not.toContain("\x1b[48;");
	});

	test("ANSI embedded in argument text is stripped before rendering", () => {
		const [line] = renderCompactToolRows(
			routineView({
				toolName: "custom_tool",
				args: { value: "\x1b[31mred\x1b[0m" },
			}),
			fakeTheme(),
		);
		expect(line ?? "").not.toContain("\x1b[31m");
		expect(stripAnsi(line ?? "")).toBe("• custom tool: value: red");
	});
});

describe("inject rule rows", () => {
	const INJECT_GREEN = Bun.color("#A4D734", "ansi-16m") ?? "";

	function renderInject(
		rules: readonly { name: string; body?: string }[],
		width?: number,
	): readonly string[] {
		return renderModule.renderInjectRuleRows(rules, fakeTheme(), width);
	}

	test("marker inject is green and the rest stays dim ordinary tool chrome", () => {
		const [line] = renderInject([
			{ name: "no-secrets", body: "never log tokens" },
		]);
		expect(stripAnsi(line ?? "")).toBe("• inject: no-secrets");
		expect(line ?? "").toContain(INJECT_GREEN);
		// Only the literal marker carries the fixed green; the bullet and name stay dim.
		const afterMarker = (line ?? "").split("inject").slice(1).join("inject");
		expect(afterMarker).not.toContain(INJECT_GREEN);
		expect(line ?? "").not.toContain("\x1b[48;");
		expect(line ?? "").not.toContain("\x1b[49m");
	});

	test("body lines stay gray without a card background", () => {
		const rows = renderInject([
			{ name: "wrap", body: "first line\nsecond line" },
		]);
		expect(rows.map((row) => stripAnsi(row))).toEqual([
			"• inject: wrap",
			"first line",
			"second line",
		]);
		for (const row of rows) {
			expect(row).not.toContain("\x1b[48;");
			expect(row).not.toContain("\x1b[49m");
		}
		expect(rows[1] ?? "").not.toContain(INJECT_GREEN);
	});

	test("ANSI and control characters in rule payload are stripped", () => {
		const rows = renderInject([
			{
				name: "\x1b[31mred\x1b[0m",
				body: "safe\x1b[48;2;255;0;0mcard\x1b[49m",
			},
		]);
		expect(stripAnsi(rows[0] ?? "")).toBe("• inject: red");
		expect(rows[0] ?? "").not.toContain("\x1b[31m");
		expect(rows[1] ?? "").not.toContain("\x1b[48;");
		expect(stripAnsi(rows[1] ?? "")).toBe("safecard");
	});

	test("overflowing inject rows fit width without padding a background", () => {
		const [line] = renderInject(
			[{ name: "x".repeat(80), body: "y".repeat(80) }],
			20,
		);
		expect(stripAnsi(line ?? "").length).toBeLessThanOrEqual(20);
		expect(line ?? "").not.toContain("\x1b[48;");
	});

	test("extractor recovers single-rule TTSR trees via public children/getText", () => {
		const tree = {
			children: [
				{ getText: () => "⚠ Injecting rule: sticky-rule  ↺" },
				{
					children: [
						{ getText: () => "Keep the why distilled." },
						{ getText: () => " (ctrl+o to expand)" },
					],
				},
			],
			render() {
				return [];
			},
		};
		expect(renderModule.injectRulesFromTtsrComponent(tree)).toEqual([
			{ name: "sticky-rule", body: "Keep the why distilled." },
		]);
	});

	test("extractor recovers multi-rule TTSR trees and skips expand hints", () => {
		const tree = {
			children: [
				{ getText: () => "⚠ Injecting 2 rules:  ↺" },
				{ getText: () => "alpha: first body" },
				{ getText: () => "beta: second body" },
				{ getText: () => " (ctrl+o to expand)" },
			],
			render() {
				return [];
			},
		};
		expect(renderModule.injectRulesFromTtsrComponent(tree)).toEqual([
			{ name: "alpha", body: "first body" },
			{ name: "beta", body: "second body" },
		]);
	});

	test("extractor fails open on unrecognized trees", () => {
		expect(renderModule.injectRulesFromTtsrComponent({})).toBeUndefined();
		expect(
			renderModule.injectRulesFromTtsrComponent({
				children: [{ getText: () => "not an inject header" }],
			}),
		).toBeUndefined();
	});
});

describe("todo reminder row", () => {
	function reminderTheme(): Theme {
		return {
			...fakeTheme(),
			fg: (color: string, text: string) =>
				color === "warning"
					? `\x1b[38;2;200;160;0m${text}\x1b[39m`
					: `\x1b[38;2;1;1;1m${text}\x1b[39m`,
			inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
		} as unknown as Theme;
	}

	function stockTree(header: string, body: string) {
		return {
			children: [
				{},
				{
					children: [{ getText: () => header }, {}, { getText: () => body }],
				},
			],
			render() {
				return [] as const;
			},
			setToolActivityVisible() {},
		};
	}

	test("extractor recovers header counts and checkbox body lines", () => {
		const tree = stockTree(
			"⚠ 2 incomplete todos - reminder 1/3",
			"  ☐ ship compact row\n  ☐ keep yellow",
		);
		expect(renderModule.todoReminderFromComponent(tree)).toEqual({
			count: 2,
			attempt: 1,
			maxAttempts: 3,
			items: ["ship compact row", "keep yellow"],
		});
	});

	test("extractor accepts singular todo label", () => {
		const tree = stockTree(
			"⚠ 1 incomplete todo - reminder 2/3",
			"  ☐ only item",
		);
		expect(renderModule.todoReminderFromComponent(tree)).toEqual({
			count: 1,
			attempt: 2,
			maxAttempts: 3,
			items: ["only item"],
		});
	});

	test("extractor fails open on inject headers and empty trees", () => {
		expect(renderModule.todoReminderFromComponent({})).toBeUndefined();
		expect(
			renderModule.todoReminderFromComponent(
				stockTree("⚠ Injecting rule: sticky-rule  ↺", "body"),
			),
		).toBeUndefined();
		expect(
			renderModule.todoReminderFromComponent(
				stockTree("not a reminder header", "  ☐ x"),
			),
		).toBeUndefined();
		// StrippedToolCallsPlaceholder body — same activity surface as a
		// reminder, but never a reminder header/items tree.
		expect(
			renderModule.todoReminderFromComponent({
				getText: () => "1 tool call elided — no result on this branch",
			}),
		).toBeUndefined();
		expect(
			renderModule.todoReminderFromComponent({
				children: [
					{
						getText: () => "2 tool calls elided — no result on this branch",
					},
				],
			}),
		).toBeUndefined();
	});

	test("compact row is one yellow line with reminder count and todos", () => {
		const theme = reminderTheme();
		const rows = renderModule.renderTodoReminderRow(
			{
				count: 1,
				attempt: 1,
				maxAttempts: 3,
				items: ["finish the row"],
			},
			theme,
		);
		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toBe(
			"• 1 incomplete todo - reminder 1/3 · finish the row",
		);
		expect(rows[0] ?? "").toContain("\x1b[38;2;200;160;0m");
		expect(rows[0] ?? "").not.toContain("\x1b[48;");
		expect(rows[0] ?? "").not.toContain("\x1b[49m");
		expect(rows[0] ?? "").not.toContain("\x1b[7m");
		expect(rows[0] ?? "").not.toContain(
			Bun.color("#A4D734", "ansi-16m") ?? "NOPE",
		);
	});

	test("multiple items keep the first and show +K more", () => {
		const [line] = renderModule.renderTodoReminderRow(
			{
				count: 3,
				attempt: 2,
				maxAttempts: 3,
				items: ["alpha", "beta", "gamma"],
			},
			reminderTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe(
			"• 3 incomplete todos - reminder 2/3 · alpha · +2 more",
		);
	});

	test("ANSI and control characters in payload are stripped", () => {
		const tree = stockTree(
			"⚠ 1 incomplete todo - reminder 1/3",
			"  ☐ safe\x1b[48;2;255;0;0mcard\x1b[49m",
		);
		const view = renderModule.todoReminderFromComponent(tree);
		expect(view?.items).toEqual(["safecard"]);
		expect(view).toBeDefined();
		if (!view) return;
		const [line] = renderModule.renderTodoReminderRow(view, reminderTheme());
		expect(line ?? "").not.toContain("\x1b[48;");
		expect(stripAnsi(line ?? "")).toContain("safecard");
	});

	test("overflowing reminder row fits width without a background", () => {
		const [line] = renderModule.renderTodoReminderRow(
			{
				count: 1,
				attempt: 1,
				maxAttempts: 3,
				items: ["x".repeat(80)],
			},
			reminderTheme(),
			24,
		);
		expect(stripAnsi(line ?? "").length).toBeLessThanOrEqual(24);
		expect(line ?? "").not.toContain("\x1b[48;");
		expect(line ?? "").not.toContain("\x1b[7m");
	});
});

describe("user bash/python execution rows", () => {
	function bashBlock(options: {
		command: string;
		output?: string;
		finalized?: boolean;
		footer?: string;
	}) {
		const children: Array<{ getText(): string }> = [];
		const footer = options.footer;
		if (footer) children.push({ getText: () => footer });
		return {
			children,
			getCommand: () => options.command,
			getOutput: () => options.output ?? "",
			isTranscriptBlockFinalized: () => options.finalized === true,
			setExpanded() {},
			appendOutput() {},
			setComplete() {},
			render() {
				return ["NATIVE bash frame"] as const;
			},
		};
	}

	function evalBlock(options: {
		code: string;
		output?: string;
		finalized?: boolean;
		footer?: string;
	}) {
		const children: Array<{ getText(): string }> = [];
		const footer = options.footer;
		if (footer) children.push({ getText: () => footer });
		return {
			children,
			getCode: () => options.code,
			getOutput: () => options.output ?? "",
			isTranscriptBlockFinalized: () => options.finalized === true,
			setExpanded() {},
			appendOutput() {},
			setComplete() {},
			render() {
				return ["NATIVE eval frame"] as const;
			},
		};
	}

	test("extractors prefer public accessors and stay mutually exclusive", () => {
		const bash = bashBlock({ command: "ls -la", finalized: true });
		const py = evalBlock({ code: "print(1)", finalized: false });
		expect(renderModule.userBashExecutionFromComponent(bash)).toEqual({
			kind: "bash",
			source: "ls -la",
			running: false,
		});
		expect(renderModule.userEvalExecutionFromComponent(bash)).toBeUndefined();
		expect(renderModule.userEvalExecutionFromComponent(py)).toEqual({
			kind: "python",
			source: "print(1)",
			running: true,
		});
		expect(renderModule.userBashExecutionFromComponent(py)).toBeUndefined();
	});

	test("extractors accept observed setComplete/setExpanded state", () => {
		const bash = bashBlock({ command: "false", finalized: true });
		expect(
			renderModule.userBashExecutionFromComponent(bash, {
				exitCode: 1,
				cancelled: false,
				expanded: false,
			}),
		).toEqual({
			kind: "bash",
			source: "false",
			running: false,
			exitCode: 1,
			cancelled: false,
			expanded: false,
		});
	});

	test("extractors scrape stock footer when setComplete was missed at attach", () => {
		const bash = bashBlock({
			command: "boom",
			finalized: true,
			footer: "(exit 2)",
		});
		expect(renderModule.userBashExecutionFromComponent(bash)).toEqual({
			kind: "bash",
			source: "boom",
			running: false,
			exitCode: 2,
		});
		const cancelled = evalBlock({
			code: "1/0",
			finalized: true,
			footer: "(cancelled)",
		});
		expect(renderModule.userEvalExecutionFromComponent(cancelled)).toEqual({
			kind: "python",
			source: "1/0",
			running: false,
			cancelled: true,
		});
	});

	test("extractors fail open on missing accessors or empty source", () => {
		expect(renderModule.userBashExecutionFromComponent({})).toBeUndefined();
		expect(
			renderModule.userBashExecutionFromComponent(
				bashBlock({ command: "   ", finalized: true }),
			),
		).toBeUndefined();
		expect(
			renderModule.userEvalExecutionFromComponent({
				getCode: () => "x",
				// missing isTranscriptBlockFinalized / getOutput
			}),
		).toBeUndefined();
	});

	test("compact bash row matches agent bash tool chrome", () => {
		const theme = fakeTheme();
		const [line] = renderModule.renderUserExecutionRow(
			{
				kind: "bash",
				source: "bun test",
				running: false,
			},
			theme,
		);
		expect(stripAnsi(line ?? "")).toBe("• bash: bun test");
		expect(line ?? "").not.toContain("\x1b[48;");
		expect(line ?? "").not.toContain("\x1b[7m");
	});

	test("compact python row uses python label for $ / $$ user cells", () => {
		const [line] = renderModule.renderUserExecutionRow(
			{
				kind: "python",
				source: "print(1)",
				running: false,
			},
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe("• python: print(1)");
	});

	test("running rows keep Working… identity chrome", () => {
		const [line] = renderModule.renderUserExecutionRow(
			{
				kind: "bash",
				source: "sleep 1",
				running: true,
			},
			fakeTheme(),
		);
		expect(stripAnsi(line ?? "")).toBe("⠦ Working… bash: sleep 1");
	});

	test("failed and cancelled rows show exit meta with error marker", () => {
		const failed = renderModule.renderUserExecutionRow(
			{
				kind: "bash",
				source: "false",
				running: false,
				exitCode: 2,
			},
			fakeTheme(),
		)[0];
		expect(stripAnsi(failed ?? "")).toBe("✗ bash: false · exit 2");
		const cancelled = renderModule.renderUserExecutionRow(
			{
				kind: "python",
				source: "raise SystemExit",
				running: false,
				cancelled: true,
			},
			fakeTheme(),
		)[0];
		expect(stripAnsi(cancelled ?? "")).toBe(
			"✗ python: raise SystemExit · cancelled",
		);
	});

	test("overflowing execution rows fit width without a background", () => {
		const [line] = renderModule.renderUserExecutionRow(
			{
				kind: "bash",
				source: "x".repeat(80),
				running: false,
			},
			fakeTheme(),
			20,
		);
		expect(stripAnsi(line ?? "").length).toBeLessThanOrEqual(20);
		expect(line ?? "").not.toContain("\x1b[48;");
	});

	test("ANSI in command/code is stripped before rendering", () => {
		const [line] = renderModule.renderUserExecutionRow(
			{
				kind: "bash",
				source: "\x1b[31mred\x1b[0m",
				running: false,
			},
			fakeTheme(),
		);
		expect(line ?? "").not.toContain("\x1b[31m");
		expect(stripAnsi(line ?? "")).toBe("• bash: red");
	});
});

describe("skill message row", () => {
	function skillBlock(options: {
		customType?: string;
		name?: string;
		args?: string;
		path?: string;
		lineCount?: number;
		content?: string;
	}) {
		return {
			message: {
				role: "custom",
				customType: options.customType ?? "skill-prompt",
				content: options.content ?? "prompt body",
				display: true,
				details: {
					name: options.name ?? "figma-use",
					args: options.args,
					path: options.path,
					lineCount: options.lineCount,
				},
			},
			setExpanded() {},
			render() {
				return ["NATIVE skill card"] as const;
			},
		};
	}

	test("extractor reads structured message.details", () => {
		expect(
			renderModule.skillMessageFromComponent(
				skillBlock({
					name: "  keep-the-why  ",
					args: "a\nb",
					path: "/tmp/SKILL.md",
					lineCount: 12,
				}),
			),
		).toEqual({
			name: "keep-the-why",
			args: "a b",
			path: "/tmp/SKILL.md",
			lineCount: 12,
		});
	});

	test("extractor accepts observed expanded state", () => {
		expect(
			renderModule.skillMessageFromComponent(skillBlock({}), {
				expanded: true,
			}),
		).toEqual({
			name: "figma-use",
			expanded: true,
		});
	});

	test("extractor fails open on non-skill customTypes and missing message", () => {
		expect(
			renderModule.skillMessageFromComponent(
				skillBlock({ customType: "my-extension-card" }),
			),
		).toBeUndefined();
		expect(
			renderModule.skillMessageFromComponent(
				skillBlock({ customType: "handoff" }),
			),
		).toBeUndefined();
		expect(
			renderModule.skillMessageFromComponent(
				skillBlock({ customType: "omp-compact-stats" }),
			),
		).toBeUndefined();
		expect(renderModule.skillMessageFromComponent({})).toBeUndefined();
		expect(
			renderModule.skillMessageFromComponent({
				render() {
					return [] as const;
				},
				setExpanded() {},
			}),
		).toBeUndefined();
	});

	test("missing details name falls back to unknown", () => {
		expect(
			renderModule.skillMessageFromComponent({
				message: {
					customType: "skill-prompt",
					content: "x",
					details: {},
				},
			}),
		).toEqual({ name: "unknown" });
	});

	test("compact row uses skill identity colors without background", () => {
		const theme = {
			...fakeTheme(),
			fg: (color: string, text: string) => {
				if (color === "customMessageLabel")
					return `\x1b[38;2;180;100;255m${text}\x1b[39m`;
				if (color === "customMessageText")
					return `\x1b[38;2;200;200;200m${text}\x1b[39m`;
				if (color === "accent") return `\x1b[38;2;80;160;255m${text}\x1b[39m`;
				if (color === "muted") return `\x1b[38;2;120;120;120m${text}\x1b[39m`;
				return `\x1b[38;2;1;1;1m${text}\x1b[39m`;
			},
		} as unknown as Theme;
		const [line] = renderModule.renderSkillMessageRow(
			{
				name: "figma-use",
				args: "--file x",
				path: "SKILL.md",
				lineCount: 1,
			},
			theme,
		);
		expect(stripAnsi(line ?? "")).toBe(
			"• skill figma-use --file x · SKILL.md · 1 line",
		);
		expect(line ?? "").toContain("\x1b[38;2;180;100;255m");
		expect(line ?? "").toContain("\x1b[38;2;200;200;200m");
		expect(line ?? "").not.toContain("\x1b[48;");
		expect(line ?? "").not.toContain("\x1b[7m");
	});

	test("overflowing skill row fits width without a background", () => {
		const [line] = renderModule.renderSkillMessageRow(
			{
				name: "x".repeat(40),
				args: "y".repeat(40),
				path: "/very/long/path/SKILL.md",
				lineCount: 99,
			},
			fakeTheme(),
			24,
		);
		expect(stripAnsi(line ?? "").length).toBeLessThanOrEqual(24);
		expect(line ?? "").not.toContain("\x1b[48;");
	});
});

describe("late diagnostics row", () => {
	function lateBlock(files: unknown[]) {
		return {
			files,
			setExpanded() {},
			setToolActivityVisible() {},
			render() {
				return ["NATIVE late diagnostics"] as const;
			},
		};
	}

	test("extractor flattens files and counts messages", () => {
		expect(
			renderModule.lateDiagnosticsFromComponent(
				lateBlock([
					{
						path: "a.ts",
						summary: "1 error",
						errored: true,
						messages: ["a.ts:1:1: error: boom", "a.ts:2:1: error: two"],
					},
					{ summary: "1 warning", messages: ["b.ts:3:1: warning: soft"] },
				]),
			),
		).toEqual({
			errored: true,
			summary: "1 error, 1 warning",
			count: 3,
			firstMessage: "a.ts:1:1: error: boom",
		});
	});

	test("extractor refuses empty messages (host early-return)", () => {
		expect(
			renderModule.lateDiagnosticsFromComponent(lateBlock([])),
		).toBeUndefined();
		expect(
			renderModule.lateDiagnosticsFromComponent(
				lateBlock([{ path: "a.ts", summary: "ok", messages: [] }]),
			),
		).toBeUndefined();
		expect(renderModule.lateDiagnosticsFromComponent({})).toBeUndefined();
		expect(
			renderModule.lateDiagnosticsFromComponent({
				setExpanded() {},
				setToolActivityVisible() {},
				children: [{}],
			}),
		).toBeUndefined();
	});

	test("extractor accepts observed expanded state", () => {
		expect(
			renderModule.lateDiagnosticsFromComponent(
				lateBlock([{ messages: ["only"] }]),
				{ expanded: false },
			),
		).toEqual({
			errored: false,
			count: 1,
			firstMessage: "only",
			expanded: false,
		});
	});

	test("compact error row uses toolTitle and error payload without background", () => {
		const theme = {
			...fakeTheme(),
			fg: (color: string, text: string) => {
				if (color === "toolTitle")
					return `\x1b[38;2;100;200;255m${text}\x1b[39m`;
				if (color === "error") return `\x1b[38;2;255;80;80m${text}\x1b[39m`;
				if (color === "warning") return `\x1b[38;2;200;160;0m${text}\x1b[39m`;
				return `\x1b[38;2;1;1;1m${text}\x1b[39m`;
			},
		} as unknown as Theme;
		const [line] = renderModule.renderLateDiagnosticsRow(
			{
				errored: true,
				summary: "2 errors",
				count: 2,
				firstMessage: "a.ts:1:1: error: boom",
			},
			theme,
		);
		expect(stripAnsi(line ?? "")).toBe(
			"• late diagnostics (2 errors) · a.ts:1:1: error: boom · +1 more",
		);
		expect(line ?? "").toContain("\x1b[38;2;100;200;255m");
		expect(line ?? "").toContain("\x1b[38;2;255;80;80m");
		expect(line ?? "").not.toContain("\x1b[48;");
		expect(line ?? "").not.toContain("\x1b[7m");
	});

	test("warning severity uses warning ink", () => {
		const theme = {
			...fakeTheme(),
			fg: (color: string, text: string) =>
				color === "warning"
					? `\x1b[38;2;200;160;0m${text}\x1b[39m`
					: `\x1b[38;2;1;1;1m${text}\x1b[39m`,
		} as unknown as Theme;
		const [line] = renderModule.renderLateDiagnosticsRow(
			{
				errored: false,
				count: 1,
				firstMessage: "soft",
			},
			theme,
		);
		expect(stripAnsi(line ?? "")).toBe("• late diagnostics · soft");
		expect(line ?? "").toContain("\x1b[38;2;200;160;0m");
	});

	test("overflowing late-diagnostics row fits width without a background", () => {
		const [line] = renderModule.renderLateDiagnosticsRow(
			{
				errored: true,
				summary: "many",
				count: 9,
				firstMessage: "x".repeat(80),
			},
			fakeTheme(),
			28,
		);
		expect(stripAnsi(line ?? "").length).toBeLessThanOrEqual(28);
		expect(line ?? "").not.toContain("\x1b[48;");
	});
});
