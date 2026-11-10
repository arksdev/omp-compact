/**
 * Non-tool transcript blocks through the real presenter: omp's own
 * `PresentedBlock` around the stock component, asked through
 * `setTranscriptPresenters`, driven by the plugin's own event handlers.
 */
import { afterAll, afterEach, describe, expect, jest, test } from "bun:test";

import { DEFAULT_SETTINGS } from "../../.omp-plugin/config";
import { STATS_MESSAGE_TYPE } from "../../.omp-plugin/run-stats";
import {
	assistant,
	type BootedPlugin,
	bootReplay,
	dispatch,
	fakeTool,
	toolUi,
	visibleRows,
} from "./replay/harness";
import { cleanupStockSettings } from "./test-stock-host";

afterAll(() => {
	cleanupStockSettings();
});

const stockDescribe = process.env.OMP_STOCK_BIN ? describe : describe.skip;

const savedTerm = Bun.env.TERM_PROGRAM;
const savedNative = Bun.env.PI_TUI_NATIVE;
afterEach(() => {
	if (savedTerm === undefined) delete Bun.env.TERM_PROGRAM;
	else Bun.env.TERM_PROGRAM = savedTerm;
	if (savedNative === undefined) delete Bun.env.PI_TUI_NATIVE;
	else Bun.env.PI_TUI_NATIVE = savedNative;
});

/** The plain terminal view, whatever pane runs the tests. */
function terminalView(): void {
	delete Bun.env.TERM_PROGRAM;
}

function ternView(): void {
	Bun.env.TERM_PROGRAM = "tern";
	delete Bun.env.PI_TUI_NATIVE;
}

function boot(
	mode: "live" | "compact" | "clear",
	extra: Record<string, unknown> = {},
): Promise<BootedPlugin> {
	return bootReplay({
		cwd: "/tmp",
		settings: {
			...DEFAULT_SETTINGS,
			mode,
			stats: { ...DEFAULT_SETTINGS.stats, clock: false },
			...extra,
		},
	});
}

let lastStamp = 0;
/** A message timestamp: distinct per message, never behind the wall clock. */
function stamp(): number {
	lastStamp = Math.max(Date.now(), lastStamp + 1);
	return lastStamp;
}

function custom(customType: string, details: unknown, content = "") {
	return {
		role: "custom",
		customType,
		content,
		display: true,
		details,
		timestamp: stamp(),
	};
}

let eventSeq = 0;
function eventBlock(event: Record<string, unknown>) {
	return { type: "event", id: `test-event:${++eventSeq}`, event };
}

function present(booted: BootedPlugin, inner: object, block: unknown) {
	const presented = new booted.host.PresentedBlock(inner, block);
	booted.transcript.addChild(presented);
	return presented;
}

/** A stand-in for omp's background job card: one row of its own. */
function notice(text: string) {
	return { render: () => [text], invalidate() {} };
}

const rows = (booted: BootedPlugin) =>
	visibleRows(booted.transcript).join("\n");

async function runTool(
	booted: BootedPlugin,
	id: string,
	name: string,
	args: unknown,
	isError = false,
): Promise<void> {
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: id,
		toolName: name,
		args,
	});
	const component = new booted.host.ToolExecutionComponent(
		name,
		args,
		{ showImages: false, useBuiltInRenderer: true },
		fakeTool(name),
		toolUi(),
		booted.context.cwd,
		id,
	);
	booted.transcript.addChild(component);
	const result = { content: [{ type: "text", text: "ok" }] };
	await dispatch(booted, {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: name,
		result,
		isError,
	});
	component.updateResult({ ...result, isError }, false, id);
}

/**
 * The run's answer, then the idle wait the stats message is sent from,
 * run on fake timers.
 */
async function answer(booted: BootedPlugin): Promise<void> {
	await dispatch(booted, {
		type: "message_end",
		message: assistant("done", "stop", {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
		}),
	});
	jest.useFakeTimers();
	try {
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("done")],
			willContinue: false,
		});
		jest.advanceTimersByTime(1_000);
	} finally {
		jest.useRealTimers();
	}
}

stockDescribe("presenter: non-tool blocks", () => {
	test("a TTSR hit is one inject row per rule with its collapsed text", async () => {
		terminalView();
		const booted = await boot("live");
		const rules = [{ name: "no-unwrap", description: "first\nsecond\nthird" }];
		present(
			booted,
			new booted.host.TtsrNotificationComponent(rules),
			eventBlock({ type: "ttsr_triggered", rules }),
		);
		expect(visibleRows(booted.transcript)).toEqual([
			"• inject: no-unwrap",
			"  first",
			"  second…",
		]);
	});

	test("a todo reminder is one row with its first open item", async () => {
		terminalView();
		const booted = await boot("clear");
		const todos = [
			{ content: "write tests", status: "pending" },
			{ content: "ship", status: "pending" },
		];
		present(
			booted,
			new booted.host.TodoReminderComponent(todos, 1, 3),
			eventBlock({ type: "todo_reminder", todos, attempt: 1, maxAttempts: 3 }),
		);
		expect(rows(booted)).toBe(
			"• 2 incomplete todos - reminder 1/3 · write tests · +1 more",
		);
	});

	/** A user's `/skill:polish HEAD~1`, drawn as omp draws it. */
	function presentSkill(booted: BootedPlugin, timestamp = stamp()) {
		const message = {
			...custom("skill-prompt", {
				name: "polish",
				path: "/skills/polish/SKILL.md",
				args: "HEAD~1",
				lineCount: 12,
			}),
			attribution: "user",
			timestamp,
		};
		present(
			booted,
			new booted.host.SkillMessageComponent(message),
			booted.host.messageBlock(message),
		);
	}
	const SKILL_ROW =
		"• skill polish HEAD~1 · /skills/polish/SKILL.md · 12 lines";

	function bootQuiet(mode: "live" | "compact" | "clear") {
		return boot(mode, { stats: { ...DEFAULT_SETTINGS.stats, enabled: false } });
	}

	test("a skill prompt keeps its card while its run works, then is one row", async () => {
		terminalView();
		const booted = await bootQuiet("live");
		// omp stamps the prompt before the run it opens starts.
		presentSkill(booted);
		const card = rows(booted);
		expect(card).toContain("polish");
		expect(card).not.toBe(SKILL_ROW);
		await dispatch(booted, { type: "agent_start" });
		expect(rows(booted)).toBe(card);
		await answer(booted);
		expect(rows(booted)).toBe(SKILL_ROW);
	});

	test("a skill prompt drawn after its run started joins it", async () => {
		terminalView();
		const booted = await bootQuiet("compact");
		const stamped = stamp();
		await dispatch(booted, { type: "agent_start" });
		presentSkill(booted, stamped);
		expect(rows(booted)).not.toBe(SKILL_ROW);
		await answer(booted);
		expect(rows(booted)).toBe(SKILL_ROW);
	});

	test("a skill prompt queued before an abort opens its card in the next run", async () => {
		terminalView();
		const booted = await bootQuiet("live");
		await dispatch(booted, { type: "agent_start" });
		const queued = stamp();
		await dispatch(booted, {
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
			willContinue: false,
		});
		await dispatch(booted, { type: "agent_start" });
		presentSkill(booted, queued);
		expect(rows(booted)).not.toBe(SKILL_ROW);
		await answer(booted);
		expect(rows(booted)).toBe(SKILL_ROW);
	});

	test("clear and history keep a skill prompt one row", async () => {
		terminalView();
		const clear = await bootQuiet("clear");
		presentSkill(clear);
		await dispatch(clear, { type: "agent_start" });
		expect(rows(clear)).toBe(SKILL_ROW);

		const history = await bootQuiet("live");
		presentSkill(history, 1);
		expect(rows(history)).toBe(SKILL_ROW);
	});

	test("late diagnostics are one severity row", async () => {
		terminalView();
		const booted = await boot("live");
		const files = [
			{
				path: "src/a.ts",
				summary: "2 errors",
				errored: true,
				messages: ["a.ts:1 bad type", "a.ts:2 worse"],
			},
		];
		const message = custom("lsp-late-diagnostic", { files });
		present(
			booted,
			new booted.host.LateDiagnosticsMessageComponent(files),
			booted.host.messageBlock(message),
		);
		const text = rows(booted);
		expect(text).toContain(
			"late diagnostics (2 errors) · a.ts:1 bad type · +1 more",
		);
		expect(text.split("\n")).toHaveLength(1);
	});

	test("a ! run is one row while it runs and after it is recorded", async () => {
		terminalView();
		const booted = await boot("live");
		const run = {
			role: "bashExecution",
			command: "false",
			output: "",
			exitCode: undefined,
			cancelled: false,
			truncated: false,
			timestamp: stamp(),
		};
		const component = new booted.host.BashExecutionComponent("false", toolUi());
		const block = present(booted, component, booted.host.messageBlock(run));
		expect(rows(booted)).toBe("• Working… bash: false");
		block.setBlock(
			booted.host.messageBlock({ ...run, exitCode: 2, timestamp: stamp() }),
		);
		expect(rows(booted)).toBe("• ✗ bash: false · exit 2");
	});

	test("a $ run is one python row", async () => {
		terminalView();
		const booted = await boot("live");
		const run = {
			role: "pythonExecution",
			code: "print(1)",
			output: "1",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: stamp(),
		};
		present(
			booted,
			new booted.host.EvalExecutionComponent("print(1)", toolUi()),
			booted.host.messageBlock(run),
		);
		expect(rows(booted)).toBe("• python: print(1)");
	});

	test("advisor notes compact only with the setting; a blocker stays full", async () => {
		terminalView();
		const card = (booted: BootedPlugin, details: unknown) =>
			present(
				booted,
				booted.host.createAdvisorMessageCard(
					details,
					() => false,
					booted.context.ui.theme,
				),
				booted.host.messageBlock(custom("advisor", details)),
			);
		const notes = {
			notes: [
				{ note: "rename this\nbecause", severity: "nit" },
				{ note: "check the bound", severity: "concern", advisor: "sec" },
			],
		};

		const off = await boot("live");
		card(off, notes);
		expect(rows(off)).toContain("Advisor");
		expect(rows(off)).not.toContain("• advisor");

		const on = await boot("live", { compactAdvisorNotes: true });
		card(on, notes);
		expect(visibleRows(on.transcript)).toEqual([
			"• advisor [nit] rename this",
			"  • advisor [concern] [sec] check the bound",
		]);

		const blocker = await boot("live", { compactAdvisorNotes: true });
		card(blocker, {
			notes: [
				{ note: "small", severity: "nit" },
				{ note: "stop: data loss", severity: "blocker" },
			],
		});
		expect(rows(blocker)).toContain("stop: data loss");
		expect(rows(blocker)).not.toContain("• advisor");
	});

	test("turning the plugin off by the display cycle redraws advisor cards", async () => {
		terminalView();
		const booted = await boot("clear", { compactAdvisorNotes: true });
		const details = { notes: [{ note: "consider a test" }] };
		present(
			booted,
			booted.host.createAdvisorMessageCard(
				details,
				() => false,
				booted.context.ui.theme,
			),
			booted.host.messageBlock(custom("advisor", details)),
		);
		expect(rows(booted)).toBe("• advisor [nit] consider a test");
		const [cycle] = [...booted.shortcuts.values()];
		await cycle?.(booted.context);
		expect(rows(booted)).not.toContain("• advisor");
		expect(rows(booted)).toContain("consider a test");
	});

	test("an unknown custom message keeps omp's card", async () => {
		terminalView();
		const booted = await boot("live");
		present(
			booted,
			notice("third-party card"),
			booted.host.messageBlock(custom("someone-elses-type", {})),
		);
		expect(rows(booted)).toBe("third-party card");
	});

	test("a background notice folds with its run and comes back on the stats click", async () => {
		terminalView();
		const booted = await boot("live", {
			stats: { ...DEFAULT_SETTINGS.stats, enabled: true, clock: false },
		});
		await dispatch(booted, { type: "agent_start" });
		await runTool(booted, "c1", "grep", { pattern: "needle" });
		present(
			booted,
			notice("Background job job-1 completed"),
			booted.host.messageBlock(custom("async-result", { jobId: "job-1" })),
		);
		expect(rows(booted)).toContain("job-1");
		await answer(booted);
		expect(rows(booted)).not.toContain("job-1");

		const sent = booted.sentMessages.find(
			(entry) => entry.message.customType === STATS_MESSAGE_TYPE,
		);
		const row = booted.renderers.get(STATS_MESSAGE_TYPE)?.(
			{ details: sent?.message.details },
			{ expanded: false },
			booted.context.ui.theme,
		) as unknown as {
			describe(): { p?: { actions?: { click?: string } } };
			handleNativeEvent(event: unknown): void;
		};
		const act = row.describe().p?.actions?.click;
		row.handleNativeEvent({ type: "action", act });
		expect(rows(booted)).toContain("job-1");
		row.handleNativeEvent({ type: "action", act });
		expect(rows(booted)).not.toContain("job-1");
	});

	test("a notice from earlier history follows the current mode", async () => {
		terminalView();
		for (const [mode, shown] of [
			["compact", true],
			["live", false],
			["clear", false],
		] as const) {
			const booted = await boot(mode);
			present(
				booted,
				notice("Supervised process server completed"),
				booted.host.messageBlock(
					custom("launch-completion", { daemons: [{ name: "server" }] }),
				),
			);
			expect(rows(booted).includes("server"), mode).toBe(shown);
		}
	});

	test("the stats message carries a marker, not the stats line", async () => {
		terminalView();
		const booted = await boot("live", {
			stats: { ...DEFAULT_SETTINGS.stats, enabled: true, clock: false },
		});
		await dispatch(booted, { type: "agent_start" });
		await answer(booted);
		const sent = booted.sentMessages.find(
			(entry) => entry.message.customType === STATS_MESSAGE_TYPE,
		);
		expect(sent?.message.content).toBe("[omp-compact turn stats]");
		const row = booted.renderers.get(STATS_MESSAGE_TYPE)?.(
			{ details: sent?.message.details },
			{ expanded: false },
			booted.context.ui.theme,
		);
		expect(visibleRows(row as never).join("\n")).not.toContain(
			"omp-compact turn stats",
		);
	});

	test("in Tern a routine row keeps omp's own head; evidence rows keep their label", async () => {
		ternView();
		const booted = await boot("compact");
		await dispatch(booted, { type: "agent_start" });
		await runTool(booted, "g1", "grep", { pattern: "needle" });
		await runTool(booted, "g2", "grep", { pattern: "broken" }, true);
		await runTool(booted, "x1", "write", {
			path: "xd://github",
			content: '{"op":"pr_create"}',
		});
		const text = visibleRows(booted.transcript);
		// omp's own one-row summary, not the plugin's label.
		expect(text.slice(0, 2)).toEqual(["• grep", "• grep"]);
		// A different title is news: the label stays.
		expect(text.join("\n")).toContain("• github: pr_create");

		terminalView();
		const plain = await boot("compact");
		await dispatch(plain, { type: "agent_start" });
		await runTool(plain, "g1", "grep", { pattern: "needle" });
		expect(visibleRows(plain.transcript).join("\n")).toContain("grep: needle");
	});

	test("in Tern a label leaves out the card's own title, and keeps a different one", async () => {
		ternView();
		const booted = await boot("compact", { compactAdvisorNotes: true });
		await dispatch(booted, { type: "agent_start" });
		await runTool(booted, "c2", "read", { path: "proc://jobs" });
		// A prompt from history, so its row shows while this run works.
		const message = {
			...custom("skill-prompt", { name: "polish", lineCount: 3 }),
			timestamp: 1,
		};
		present(
			booted,
			new booted.host.SkillMessageComponent(message),
			booted.host.messageBlock(message),
		);
		const details = { notes: [{ note: "consider a test" }] };
		present(
			booted,
			booted.host.createAdvisorMessageCard(
				details,
				() => false,
				booted.context.ui.theme,
			),
			booted.host.messageBlock(custom("advisor", details)),
		);
		const run = {
			role: "bashExecution",
			command: "false",
			output: "",
			exitCode: 1,
			cancelled: false,
			truncated: false,
			timestamp: stamp(),
		};
		present(
			booted,
			new booted.host.BashExecutionComponent("false", toolUi()),
			booted.host.messageBlock(run),
		);
		const text = visibleRows(booted.transcript);
		expect(text).toContain("• proc jobs");
		expect(text).toContain("• polish · 3 lines");
		expect(text).toContain("• [nit] consider a test");
		expect(text).toContain("• ✗ false · exit 1");

		terminalView();
		const plain = await boot("compact");
		await dispatch(plain, { type: "agent_start" });
		await runTool(plain, "c1", "read", { path: "src.txt" });
		expect(visibleRows(plain.transcript)).toContain("• read src.txt");
	});
});
