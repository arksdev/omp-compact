import { beforeAll, describe, expect, test } from "bun:test";

import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";
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

describe("sanitizeOneLine", () => {
	test("strips ANSI escapes and control characters", () => {
		expect(sanitizeOneLine("a\x1b[31mb\x1b[0m\x00c\td")).toBe("abc d");
	});

	test("bounds long text with a single ellipsis", () => {
		expect(sanitizeOneLine("x".repeat(300), 10)).toBe("xxxxxxxxx…");
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
