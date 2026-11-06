/**
 * The real presenter through omp's public seam: real `ToolExecutionComponent`
 * blocks in a real `TranscriptContainer`, asked through
 * `setTranscriptPresenters`, driven by the plugin's own event handlers.
 */
import { afterAll, describe, expect, test } from "bun:test";

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

function boot(
	mode: "live" | "compact" | "clear",
	branch?: unknown[],
): Promise<BootedPlugin> {
	return bootReplay({
		cwd: "/tmp",
		branch,
		settings: {
			...DEFAULT_SETTINGS,
			mode,
			stats: { ...DEFAULT_SETTINGS.stats, clock: false },
		},
	});
}

function block(booted: BootedPlugin, id: string, name: string, args: unknown) {
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
	return component;
}

async function runTool(
	booted: BootedPlugin,
	id: string,
	name: string,
	args: unknown,
	text = "ok",
): Promise<void> {
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: id,
		toolName: name,
		args,
	});
	const component = block(booted, id, name, args);
	const result = { content: [{ type: "text", text }] };
	await dispatch(booted, {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: name,
		result,
		isError: false,
	});
	component.updateResult(result, false, id);
}

const rows = (booted: BootedPlugin) =>
	visibleRows(booted.transcript).join("\n");

const COMMIT_OUTPUT = "[main abc1234] change\n 1 file changed, 1 insertion(+)";

async function answer(booted: BootedPlugin, text = "done"): Promise<void> {
	await dispatch(booted, {
		type: "agent_end",
		messages: [assistant(text)],
		willContinue: false,
	});
}

stockDescribe("presenter", () => {
	test("live: rows during the run, only evidence after the answer", async () => {
		const booted = await boot("live");
		await dispatch(booted, { type: "agent_start" });
		await runTool(booted, "c1", "grep", { pattern: "needle" });
		expect(rows(booted)).toContain("needle");
		await answer(booted);
		expect(rows(booted)).not.toContain("needle");
	});

	test("compact keeps the rows; clear never shows them", async () => {
		const compact = await boot("compact");
		await dispatch(compact, { type: "agent_start" });
		await runTool(compact, "c1", "grep", { pattern: "needle" });
		await answer(compact);
		expect(rows(compact)).toContain("needle");

		const clear = await boot("clear");
		await dispatch(clear, { type: "agent_start" });
		await runTool(clear, "c1", "grep", { pattern: "needle" });
		expect(rows(clear)).not.toContain("needle");
		await answer(clear);
		expect(rows(clear)).not.toContain("needle");
	});

	test("the run's commits collapse into one summary on the last evidence", async () => {
		const booted = await boot("live");
		await dispatch(booted, { type: "agent_start" });
		await runTool(
			booted,
			"c1",
			"bash",
			{ command: "git commit -m change" },
			COMMIT_OUTPUT,
		);
		await runTool(booted, "c2", "grep", { pattern: "needle" });
		await answer(booted);
		const text = rows(booted);
		expect(text).toContain("abc1234");
		expect(text).not.toContain("needle");
	});

	test("an abort keeps the diagnostic rows", async () => {
		const booted = await boot("live");
		await dispatch(booted, { type: "agent_start" });
		await runTool(booted, "c1", "grep", { pattern: "needle" });
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("", "aborted")],
			willContinue: false,
		});
		expect(rows(booted)).toContain("needle");
	});

	test("an unknown tool gets omp's own row in every mode", async () => {
		for (const mode of ["live", "compact", "clear"] as const) {
			const booted = await boot(mode);
			await dispatch(booted, { type: "agent_start" });
			await runTool(booted, "c1", "brand_new_tool", { x: 1 });
			await answer(booted);
			expect(rows(booted).toLowerCase(), mode).toContain("brand");
		}
	});

	test("a resumed branch is known without live events", async () => {
		const branch = [
			{ type: "message", message: { role: "user", content: "go" } },
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{
							type: "toolCall",
							id: "old",
							name: "grep",
							arguments: { pattern: "needle" },
						},
					],
				},
			},
			{ type: "message", message: { role: "toolResult", toolCallId: "old" } },
			{ type: "message", message: assistant("done") },
		];
		const live = await boot("live", branch);
		const component = block(live, "old", "grep", { pattern: "needle" });
		component.updateResult({ content: [] }, false, "old");
		expect(rows(live)).not.toContain("needle");

		const compact = await boot("compact", branch);
		const kept = block(compact, "old", "grep", { pattern: "needle" });
		kept.updateResult({ content: [] }, false, "old");
		expect(rows(compact)).toContain("needle");
	});

	test("a click on the stats row brings hidden calls back; the row skips the model", async () => {
		const booted = await boot("live");
		await dispatch(booted, { type: "agent_start" });
		await runTool(booted, "c1", "grep", { pattern: "needle" });
		await dispatch(booted, {
			type: "message_end",
			message: assistant("done", "stop", {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
			}),
		});
		await answer(booted);
		// Sent from the idle wait, never from `agent_end` itself.
		expect(booted.sentMessages).toEqual([]);
		await Bun.sleep(80);
		const sent = booted.sentMessages[0];
		expect(sent?.message.customType).toBe(STATS_MESSAGE_TYPE);
		expect(sent?.options).toEqual({ deliverAs: "nextTurn" });
		expect(rows(booted)).not.toContain("needle");

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
		expect(rows(booted)).toContain("needle");
		row.handleNativeEvent({ type: "action", act });
		expect(rows(booted)).not.toContain("needle");

		const [context] = booted.handlers.get("context") ?? [];
		const filtered = (await context?.(
			{
				messages: [
					{ role: "custom", customType: STATS_MESSAGE_TYPE },
					{ role: "user" },
				],
			} as never,
			booted.context,
		)) as { messages: unknown[] };
		expect(filtered.messages).toEqual([{ role: "user" }]);
	});
});
