import { afterAll, expect } from "bun:test";
import {
	addAnswer,
	addTool,
	type BootedPlugin,
	beginRun,
	bootWithTranscript,
	cleanupGeneratedDirs,
	dispatch,
	finishRun,
	finishTool,
	screenRows,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";
import type { TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

stockTest(
	"an expanded read group delegates to the native renderer",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-exp",
			toolName: "read",
			args: { path: "src/exp.ts" },
		});
		const group = new booted.host.ReadToolGroupComponent({
			showContentPreview: true,
		});
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/exp.ts" }, "read-exp");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-exp",
			toolName: "read",
			result: {
				content: [{ type: "text", text: "EXPANDED FILE BODY" }],
				details: {},
			},
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "EXPANDED FILE BODY" }], details: {} },
			false,
			"read-exp",
		);
		const collapsed = visibleRows(booted.transcript).join("\n");
		expect(collapsed).toContain("• read src/exp.ts");
		expect(collapsed).not.toContain("EXPANDED FILE BODY");
		group.setExpanded(true);
		const expanded = visibleRows(booted.transcript).join("\n");
		expect(expanded).toContain("EXPANDED FILE BODY");
		expect(expanded).not.toContain("• read src/exp.ts");
		group.setExpanded(false);
		const recollapsed = visibleRows(booted.transcript).join("\n");
		expect(recollapsed).toContain("• read src/exp.ts");
		expect(recollapsed).not.toContain("EXPANDED FILE BODY");
		await shutdown(booted);
	},
);

stockTest(
	"initially expanded tools and read groups render natively",
	async () => {
		const booted = await bootWithTranscript("/tmp", true);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf native" },
			"bash-exp0",
		);
		call.render = () => ["native-bash-expanded"];
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-exp0",
			toolName: "read",
			args: { path: "src/init.ts" },
		});
		// Emulate the stock event-controller: create, setExpanded(...) BEFORE
		// addChild, then add. The adapter must learn the initial expansion from
		// ui.getToolsExpanded() because the pre-addChild call is invisible.
		const group = new booted.host.ReadToolGroupComponent({
			showContentPreview: true,
		});
		group.setExpanded(true);
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/init.ts" }, "read-exp0");
		const body = Array.from(
			{ length: 12 },
			(_, index) => `EXPANDED BODY LINE ${index}`,
		).join("\n");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-exp0",
			toolName: "read",
			result: { content: [{ type: "text", text: body }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: body }], details: {} },
			false,
			"read-exp0",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("native-bash-expanded");
		expect(live).toContain("EXPANDED BODY LINE 0");
		// The late line proves the raw expanded preview survives: a collapsed
		// preview caps at COLLAPSED_PREVIEW_LINES (3) lines.
		expect(live).toContain("EXPANDED BODY LINE 11");
		expect(live).not.toContain("• read src/init.ts");
		// collapsing through the wrappers returns both to the compact surface
		call.setExpanded(false);
		group.setExpanded(false);
		const collapsed = visibleRows(booted.transcript).join("\n");
		expect(collapsed).toContain("printf native");
		expect(collapsed).toContain("• read src/init.ts");
		expect(collapsed).not.toContain("native-bash-expanded");
		expect(collapsed).not.toContain("EXPANDED BODY LINE 11");
		await shutdown(booted);
	},
);

stockTest("compact rows stay transparent and width-bounded", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const call = await addTool(
		booted,
		"bash",
		{ command: "printf transparent" },
		"bash-transparent",
	);
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "read-transparent",
		toolName: "read",
		args: { path: "src/transparent.ts" },
	});
	const group = new booted.host.ReadToolGroupComponent();
	booted.transcript.addChild(group);
	group.updateArgs({ path: "src/transparent.ts" }, "read-transparent");
	await finishTool(booted, call, {
		toolCallId: "bash-transparent",
		toolName: "bash",
		result: {
			content: [{ type: "text", text: "ok" }],
			details: { exitCode: 0 },
		},
		isError: false,
	});
	await dispatch(booted, {
		type: "tool_execution_end",
		toolCallId: "read-transparent",
		toolName: "read",
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
	});
	group.updateResult(
		{ content: [{ type: "text", text: "ok" }], details: {} },
		false,
		"read-transparent",
	);
	const raw = booted.transcript.render(20);
	expect(raw.join("\n")).not.toContain("\u001b[48;");
	expect(raw.join("\n")).not.toContain("\u001b[49m");
	for (const row of visibleRows(booted.transcript, 20)) {
		expect(row.length).toBeLessThanOrEqual(20);
	}
	await shutdown(booted);
});

stockTest(
	"compact rows repaint when the host swaps its theme object",
	async () => {
		const booted = await bootWithTranscript();
		// Mirror the host's live ui surface (`agent-session.ts` exposes
		// `get theme() { return theme; }` over the module binding that `/theme`
		// reassigns): the adapter must see each swap, not a boot-time snapshot.
		Object.defineProperty(booted.context.ui, "theme", {
			configurable: true,
			get: () => booted.host.getTheme(),
		});
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf theme-swap" },
			"bash-theme-swap",
		);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-theme-swap",
			toolName: "read",
			args: { path: "src/theme-swap.ts" },
		});
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/theme-swap.ts" }, "read-theme-swap");
		await finishTool(booted, call, {
			toolCallId: "bash-theme-swap",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-theme-swap",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-theme-swap",
		);
		const rawBefore = booted.transcript.render(120).join("\n");
		const textBefore = visibleRows(booted.transcript).join("\n");
		const dimBefore = booted.host.getTheme().getFgAnsi("dim");
		expect(textBefore).toContain("• bash: printf theme-swap");
		expect(textBefore).toContain("• read src/theme-swap.ts");
		expect(rawBefore).toContain(dimBefore);
		// Run the host's real `/theme <name>` swap on the binding the harness
		// hands back: `loadStockHost` derives theme.ts from the same package
		// root as the host itself (OMP_STOCK_BIN), so a second module
		// instance is impossible by construction.
		// The host theme binding is process-global: every test in this file
		// shares it, so restore the pre-test theme even when an assertion
		// fails mid-test (each bootPlugin re-inits it, but the binding must
		// not leak to tests that read it without rebooting).
		const previousTheme = booted.host.getCurrentThemeName() ?? "dark";
		try {
			const swapped = await booted.host.setTheme("light-dunes");
			expect(swapped.success).toBe(true);
			const dimAfter = booted.host.getTheme().getFgAnsi("dim");
			expect(dimAfter).not.toBe(dimBefore);
			const rawAfter = booted.transcript.render(120).join("\n");
			expect(rawAfter).toContain(dimAfter);
			expect(rawAfter).not.toContain(dimBefore);
			// Same rows, same shape — only the palette follows the host's swap.
			expect(visibleRows(booted.transcript).join("\n")).toContain(
				"• bash: printf theme-swap",
			);
		} finally {
			// Restore the name that was active before the swap, not a
			// hardcoded default — a hardcoded value would itself leak when
			// the suite runs under a non-default theme.
			const restored = await booted.host.setTheme(previousTheme);
			expect(restored.success).toBe(true);
			expect(booted.host.getCurrentThemeName()).toBe(previousTheme);
		}
		await shutdown(booted);
	},
);

stockTest("adjacent live tool calls render as a dense run", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	for (const [id, command] of [
		["bash-1", "printf one"],
		["bash-2", "printf two"],
	] as const) {
		const call = await addTool(booted, "bash", { command }, id);
		await finishTool(booted, call, {
			toolCallId: id,
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
	}
	const rows = screenRows(booted.transcript);
	const first = rows.findIndex((row) => row.includes("printf one"));
	const second = rows.findIndex((row) => row.includes("printf two"));
	expect(first).toBeGreaterThanOrEqual(0);
	expect(second).toBe(first + 1);
	await shutdown(booted);
});

/** Stock wording of a finished supervised process (host launch summary). */
const SUPERVISED_FAILURE =
	"✘ Supervised process failed live18b (exit 2) (1.9s)";

/**
 * Transcript-block surface the fold installs on every block it owns; the
 * container reads it back to decide which blocks have settled and may retire
 * into terminal history.
 */
interface FoldedBlockProbe {
	isTranscriptBlockFinalized(): boolean;
}

/**
 * Stock notice of finished background activity (OMP 18.0.1
 * `buildLaunchCompletionBlock` / `buildAsyncResultBlock`): a
 * `ToolActivityContainer` wrapping one `TranscriptBlock` whose children are
 * `Text` leaves, one per reported process. `ContainerBase` is the very stock
 * `Container` both host classes extend, so the double carries the real
 * structure — including the wrapper's activity and expand proxies.
 */
function addBackgroundCompletion(
	booted: BootedPlugin & { transcript: TranscriptInstance },
	line: string,
): FoldedBlockProbe {
	const block = new booted.ContainerBase();
	block.addChild({ render: () => [line] });
	const notice = Object.assign(new booted.ContainerBase(), {
		setToolActivityVisible() {},
		setExpanded() {},
	});
	notice.addChild(block);
	booted.transcript.addChild(notice);
	// The probe methods appear once the fold plans the block into a run.
	return notice as unknown as FoldedBlockProbe;
}

stockTest(
	"a background completion notice joins the dense run and leaves with it",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		for (const [id, command] of [
			["bash-notice-1", "printf one"],
			["bash-notice-2", "printf two"],
		] as const) {
			if (id === "bash-notice-2")
				addBackgroundCompletion(booted, SUPERVISED_FAILURE);
			const call = await addTool(booted, "bash", { command }, id);
			await finishTool(booted, call, {
				toolCallId: id,
				toolName: "bash",
				result: {
					content: [{ type: "text", text: "ok" }],
					details: { exitCode: 0 },
				},
				isError: false,
			});
		}
		// Working phase: the notice is one more row of the same dense run, so
		// the transcript inserts no separator around it.
		const rows = screenRows(booted.transcript);
		const one = rows.findIndex((row) => row.includes("printf one"));
		const notice = rows.findIndex((row) => row.includes(SUPERVISED_FAILURE));
		const two = rows.findIndex((row) => row.includes("printf two"));
		expect(one).toBeGreaterThanOrEqual(0);
		expect(notice).toBe(one + 1);
		expect(two).toBe(notice + 1);
		// Terminal answer: background activity is not a mutation, so the
		// notice leaves with the rest of the run's routine rows.
		await finishRun(booted, "both processes reported");
		expect(
			screenRows(booted.transcript).some((row) =>
				row.includes(SUPERVISED_FAILURE),
			),
		).toBe(false);
		await shutdown(booted);
	},
);

stockTest(
	"a leading background completion notice settles only with its run",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		// Notice first: it carries the run, so the span it reports is the one
		// the host may commit to native scrollback.
		const notice = addBackgroundCompletion(booted, SUPERVISED_FAILURE);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf after" },
			"bash-notice-3",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-notice-3",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		const rows = screenRows(booted.transcript);
		expect(rows.some((row) => row.includes(SUPERVISED_FAILURE))).toBe(true);
		// The carrier answers for the whole run, so the notice stays unfinalized
		// while the run works: retirement into history is what the container
		// gates on, and an open run must never be retired.
		expect(notice.isTranscriptBlockFinalized()).toBe(false);
		await finishRun(booted, "the process reported before the command");
		expect(
			screenRows(booted.transcript).some((row) =>
				row.includes(SUPERVISED_FAILURE),
			),
		).toBe(false);
		await shutdown(booted);
	},
);

stockTest(
	"a folded background completion notice stays gone once the next run starts",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf before" },
			"bash-notice-4",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-notice-4",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addBackgroundCompletion(booted, SUPERVISED_FAILURE);
		expect(
			screenRows(booted.transcript).some((row) =>
				row.includes(SUPERVISED_FAILURE),
			),
		).toBe(true);
		addAnswer(booted, "the process reported");
		await finishRun(booted, "the process reported");
		// The next run must not resurrect what the previous one folded away:
		// the notice keeps the verdict of its own run, exactly like a tool row.
		await beginRun(booted);
		const rows = screenRows(booted.transcript);
		expect(rows.some((row) => row.includes(SUPERVISED_FAILURE))).toBe(false);
		expect(rows.some((row) => row.includes("printf before"))).toBe(false);
		await shutdown(booted);
	},
);

stockTest(
	"a run made of nothing but a notice still closes its fold boundary",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		// A process dies while the model is writing: the notice lands between
		// two text blocks, so its run holds no tool card that could carry the
		// switch from live rows to the filtered log.
		addAnswer(booted, "writing the answer");
		const notice = addBackgroundCompletion(booted, SUPERVISED_FAILURE);
		addAnswer(booted, "answer continues");
		expect(
			screenRows(booted.transcript).some((row) =>
				row.includes(SUPERVISED_FAILURE),
			),
		).toBe(true);
		expect(notice.isTranscriptBlockFinalized()).toBe(false);
		await finishRun(booted, "answer continues");
		// Closing the run finalizes the lone member, so the container may
		// retire it — and what it retires is the folded, empty projection.
		expect(notice.isTranscriptBlockFinalized()).toBe(true);
		expect(
			screenRows(booted.transcript).some((row) =>
				row.includes(SUPERVISED_FAILURE),
			),
		).toBe(false);
		await shutdown(booted);
	},
);
