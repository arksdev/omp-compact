/**
 * Shared steps for the integration suites: the real plugin factory booted
 * against omp's real `TranscriptContainer` and `ToolExecutionComponent`,
 * its presenter registered through omp's public `setTranscriptPresenters`,
 * driven by the events omp emits in the order omp emits them.
 */
import { describe } from "bun:test";

import { DEFAULT_SETTINGS } from "../../.omp-plugin/config";
import { objectRecord } from "../../.omp-plugin/object-record";
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
import type { ToolExecutionInstance } from "./test-stock-host";

export { assistant, type BootedPlugin, dispatch };

/** Suites that need the pinned omp package skip without `OMP_STOCK_BIN`. */
export const stockDescribe = process.env.OMP_STOCK_BIN
	? describe
	: describe.skip;

export type Mode = "live" | "compact" | "clear";

export interface BootOptions {
	cwd?: string;
	branch?: unknown[];
	offBranch?: unknown[];
	stats?: boolean;
	settings?: Record<string, unknown>;
}

export function boot(
	mode: Mode,
	options: BootOptions = {},
): Promise<BootedPlugin> {
	return bootReplay({
		cwd: options.cwd ?? "/tmp",
		branch: options.branch,
		offBranch: options.offBranch,
		settings: {
			...DEFAULT_SETTINGS,
			mode,
			stats: {
				...DEFAULT_SETTINGS.stats,
				enabled: options.stats ?? false,
				clock: false,
			},
			...options.settings,
		},
	});
}

/** omp's card for a tool call, appended to the transcript. */
export function addBlock(
	booted: BootedPlugin,
	id: string,
	name: string,
	args: unknown,
): ToolExecutionInstance {
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

/** omp filled in the id of a call whose arguments streamed without one. */
export function renameBlock(block: object, id: string): void {
	if (
		!("renameToolCallId" in block) ||
		typeof block.renameToolCallId !== "function"
	)
		throw new Error("omp's tool block has no renameToolCallId");
	block.renameToolCallId(id);
}

export async function startTool(
	booted: BootedPlugin,
	id: string,
	name: string,
	args: unknown,
): Promise<ToolExecutionInstance> {
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: id,
		toolName: name,
		args,
	});
	return addBlock(booted, id, name, args);
}

export function textResult(text: string): { content: unknown[] } {
	return { content: [{ type: "text", text }] };
}

export async function endTool(
	booted: BootedPlugin,
	component: ToolExecutionInstance,
	id: string,
	name: string,
	result: unknown = textResult("ok"),
	isError = false,
): Promise<void> {
	await dispatch(booted, {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: name,
		result,
		isError,
	});
	component.updateResult({ ...(result as object), isError }, false, id);
}

export async function runTool(
	booted: BootedPlugin,
	id: string,
	name: string,
	args: unknown,
	result: unknown = textResult("ok"),
	isError = false,
): Promise<ToolExecutionInstance> {
	const component = await startTool(booted, id, name, args);
	await endTool(booted, component, id, name, result, isError);
	return component;
}

export function beginRun(booted: BootedPlugin): Promise<void> {
	return dispatch(booted, { type: "agent_start" });
}

/** A tool-use response ended; the agent continues the same logical run. */
export async function continueRun(booted: BootedPlugin): Promise<void> {
	await dispatch(booted, {
		type: "agent_end",
		messages: [assistant("", "toolUse")],
		willContinue: true,
	});
	await dispatch(booted, { type: "agent_start" });
}

/** The terminal answer, or an abort/error stop. */
export function endRun(
	booted: BootedPlugin,
	stop: "stop" | "aborted" | "error" = "stop",
	text = stop === "stop" ? "done" : "",
): Promise<void> {
	return dispatch(booted, {
		type: "agent_end",
		messages: [assistant(text, stop)],
		willContinue: false,
	});
}

/** The transcript as text, ANSI stripped, blank rows dropped. */
export function rows(booted: BootedPlugin): string {
	return visibleRows(booted.transcript).join("\n");
}

/** The stats rows the plugin sent, drawn by its own message renderer. */
export function statsRows(booted: BootedPlugin): string[] {
	return booted.sentMessages.flatMap(({ message }) =>
		visibleRows(
			booted.renderers.get(String(message.customType))?.(
				{ details: message.details },
				{ expanded: false },
				booted.context.ui.theme,
			) ?? { render: () => [] },
		),
	);
}

/** Long enough for the plugin's idle wait to poll at least once. */
export const IDLE_POLL_MS = 80;

/**
 * Click the stats row in Tern's native view, as the user would; returns
 * whether the row offered the click at all.
 */
export function clickStatsRow(booted: BootedPlugin, details: unknown): boolean {
	const row = booted.renderers.get(STATS_MESSAGE_TYPE)?.(
		{ details },
		{ expanded: false },
		booted.context.ui.theme,
	);
	if (
		!row ||
		!("describe" in row) ||
		typeof row.describe !== "function" ||
		!("handleNativeEvent" in row) ||
		typeof row.handleNativeEvent !== "function"
	)
		throw new Error("the stats row has no native view");
	const act = objectRecord(
		objectRecord(objectRecord(row.describe()).p).actions,
	).click;
	if (typeof act !== "string") return false;
	row.handleNativeEvent({ type: "action", act });
	return true;
}
