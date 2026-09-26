import { afterAll, expect } from "bun:test";
import {
	addAnswer,
	addTool,
	addToolComponent,
	assistant,
	type BootedPlugin,
	beginRun,
	bootForRebuild,
	bootPlugin,
	cleanupGeneratedDirs,
	dispatch,
	fakeTool,
	finishRun,
	finishTool,
	flushMicrotasks,
	rebuildHarness,
	shutdown,
	stockTest,
	toolUi,
	visibleRows,
} from "./integration-harness";
import type { TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

function committedSingleToolBranch(
	command: string,
	toolCallId: string,
	answer: string,
	extra: readonly unknown[] = [],
): readonly unknown[] {
	return [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "work" }] },
		},
		{
			type: "custom",
			customType: "tool_execution_start",
			data: { toolCallId, toolName: "bash", args: { command } },
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
		},
		...extra,
		{ type: "message", message: assistant(answer) },
	];
}

function interleavedGroupedReadBranch(answer: string): readonly unknown[] {
	return [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "work" }] },
		},
		{
			type: "custom",
			customType: "tool_execution_start",
			data: {
				toolCallId: "read-first",
				toolName: "read",
				args: { path: "src/first.ts" },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "read-first",
				toolName: "read",
				content: [{ type: "text", text: "first" }],
				isError: false,
			},
		},
		{
			type: "custom",
			customType: "tool_execution_start",
			data: {
				toolCallId: "between",
				toolName: "bash",
				args: { command: "printf between" },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "between",
				toolName: "bash",
				content: [{ type: "text", text: "between" }],
				isError: false,
			},
		},
		{
			type: "custom",
			customType: "tool_execution_start",
			data: {
				toolCallId: "read-last",
				toolName: "read",
				args: { path: "src/last.ts" },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "read-last",
				toolName: "read",
				content: [{ type: "text", text: "last" }],
				isError: false,
			},
		},
		{ type: "message", message: assistant(answer) },
	];
}

stockTest(
	"resumed session replays committed startup rows once through the exact-root resetDisplay",
	async () => {
		const harness = rebuildHarness();
		harness.branch.current = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "keep" }] },
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "write-1",
					toolName: "write",
					args: { path: "/tmp/resume.ts", content: "ok" },
				},
			},
			{
				type: "custom",
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId: "write-1",
					toolName: "write",
					path: "/tmp/resume.ts",
					added: 2,
					removed: 1,
					exact: true,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "write-1",
					toolName: "write",
					content: [{ type: "text", text: "done" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("resume done") },
		];
		const booted = await bootForRebuild(
			"compact",
			harness,
			(transcript, host) => {
				// stock resume already reconstructed the instances with the
				// identical toolCallIds before session_start hydrates
				const call = new host.ToolExecutionComponent(
					"write",
					{ path: "/tmp/resume.ts", content: "ok" },
					{ showImages: false, useBuiltInRenderer: true },
					fakeTool("write"),
					toolUi(),
					"/tmp",
					"write-1",
				);
				transcript.addChild(call);
				const ContainerBase = Object.getPrototypeOf(
					host.ReadToolGroupComponent.prototype,
				).constructor as BootedPlugin["ContainerBase"];
				const reply = new ContainerBase();
				reply.addChild({ render: () => ["resume done"] });
				transcript.addChild(reply);
			},
		);
		// hydration completed synchronously; the single generation microtask
		// validated the mapping and replayed exactly once
		expect(booted.harness.resetCalls).toBe(1);
		expect(booted.harness.clears).toBe(0);
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: resume.ts");
		expect(rows).toContain("+2|1");
		expect(rows).toContain("resume done");
		await shutdown(booted);
	},
);

stockTest(
	"process restore filters the historical transcript under live persisted settings",
	async () => {
		const harness = rebuildHarness();
		harness.branch.current = committedSingleToolBranch(
			"printf routine",
			"bash-r1",
			"restored done",
		);
		const booted = await bootForRebuild("live", harness, (transcript, host) => {
			// stock resume already reconstructed the instances with the
			// identical toolCallIds before session_start hydrates
			const call = new host.ToolExecutionComponent(
				"bash",
				{ command: "printf routine" },
				{ showImages: false, useBuiltInRenderer: true },
				fakeTool("bash"),
				toolUi(),
				"/tmp",
				"bash-r1",
			);
			call.updateResult(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				false,
				"bash-r1",
			);
			transcript.addChild(call);
			const ContainerBase = Object.getPrototypeOf(
				host.ReadToolGroupComponent.prototype,
			).constructor as BootedPlugin["ContainerBase"];
			const reply = new ContainerBase();
			reply.addChild({ render: () => ["restored done"] });
			transcript.addChild(reply);
		});
		// entering the existing session armed the one-shot restore override,
		// which snapshots the persisted live mode: the restored turn answered
		// in text, so its routine row is filtered exactly as it would be
		// right after that answer. An unbound surface would leak the stock
		// card (it prints the command), so absence also proves the binding.
		expect(booted.harness.resetCalls).toBe(1);
		expect(booted.harness.clears).toBe(0);
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("printf routine");
		expect(rows).toContain("restored done");
		await shutdown(booted);
	},
);

stockTest(
	"a restored turn that answered in text follows the selected mode: live keeps only its mutation, compact keeps the whole log, clear keeps neither",
	async () => {
		// Restore used to impose the complete log: TurnLedger's compact branch
		// turns any terminal verdict into the `full` phase, so a resumed
		// session showed the routine of turns that had already answered no
		// matter which mode the user picked. The restore snapshot now carries
		// the settings verbatim, so the restored turn presents exactly like it
		// did right after its answer: `live` keeps the verified mutation and
		// drops the read, `compact` keeps the whole log, `clear` keeps the
		// answer alone. Native renderers are marked, so an unbound surface
		// stays observable in every mode.
		const branch: readonly unknown[] = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "work" }] },
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "read-a",
					toolName: "read",
					args: { path: "src/a.ts" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-a",
					toolName: "read",
					content: [{ type: "text", text: "a" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "write-1",
					toolName: "write",
					args: { path: "resume.ts", content: "new" },
				},
			},
			{
				type: "custom",
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId: "write-1",
					toolName: "write",
					path: "resume.ts",
					added: 2,
					removed: 1,
					exact: true,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "write-1",
					toolName: "write",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("restored done") },
		];
		for (const mode of ["live", "compact", "clear"] as const) {
			const harness = rebuildHarness();
			harness.branch.current = branch;
			const booted = await bootForRebuild(mode, harness);
			const group = new booted.host.ReadToolGroupComponent();
			group.render = () => ["native read rows"];
			group.updateArgs({ path: "src/a.ts" }, "read-a");
			group.updateResult(
				{ content: [{ type: "text", text: "a" }], details: {} },
				false,
				"read-a",
			);
			const call = new booted.host.ToolExecutionComponent(
				"write",
				{ path: "resume.ts", content: "new" },
				{ showImages: false, useBuiltInRenderer: true },
				fakeTool("write"),
				toolUi(),
				booted.context.cwd,
				"write-1",
			);
			call.render = () => ["native write card"];
			call.updateResult(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				false,
				"write-1",
			);
			const reply = new booted.ContainerBase();
			reply.addChild({ render: () => ["restored done"] });
			booted.transcript.clear();
			booted.transcript.addChild(group);
			booted.transcript.addChild(call);
			booted.transcript.addChild(reply);
			await flushMicrotasks();
			const rows = visibleRows(booted.transcript).join("\n");
			expect(rows).toContain("restored done");
			expect(rows).not.toContain("native read rows");
			expect(rows).not.toContain("native write card");
			if (mode === "compact") {
				expect(rows).toContain("• read src/a.ts");
				expect(rows).toContain("write: resume.ts");
				expect(rows).toContain("+2|1");
			} else {
				// the routine read of an answered turn is gone under live and
				// clear alike
				expect(rows).not.toContain("src/a.ts");
			}
			if (mode === "live") {
				expect(rows).toContain("write: resume.ts");
				expect(rows).toContain("+2|1");
			}
			if (mode === "clear") {
				// clear hides every ordinary tool row, the verified mutation
				// included; the answer (and, when enabled, stats) is the view
				expect(rows).not.toContain("write: resume.ts");
			}
			await shutdown(booted);
		}
	},
);

stockTest(
	"the live run after a process restore keeps the persisted live mode and the restored history filtered",
	async () => {
		const harness = rebuildHarness();
		harness.branch.current = committedSingleToolBranch(
			"printf routine",
			"bash-r1",
			"restored done",
		);
		const booted = await bootForRebuild("live", harness, (transcript, host) => {
			const call = new host.ToolExecutionComponent(
				"bash",
				{ command: "printf routine" },
				{ showImages: false, useBuiltInRenderer: true },
				fakeTool("bash"),
				toolUi(),
				"/tmp",
				"bash-r1",
			);
			call.updateResult(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				false,
				"bash-r1",
			);
			transcript.addChild(call);
			const ContainerBase = Object.getPrototypeOf(
				host.ReadToolGroupComponent.prototype,
			).constructor as BootedPlugin["ContainerBase"];
			const reply = new ContainerBase();
			reply.addChild({ render: () => ["restored done"] });
			transcript.addChild(reply);
		});
		// the restored history froze under the persisted live mode: the turn
		// answered in text, so its routine row is filtered…
		expect(visibleRows(booted.transcript).join("\n")).not.toContain(
			"printf routine",
		);
		// …and the next live run re-arms the persisted live policy
		await beginRun(booted);
		const next = await addTool(
			booted,
			"bash",
			{ command: "printf next" },
			"bash-r2",
		);
		await finishTool(booted, next, {
			toolCallId: "bash-r2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "next done");
		await finishRun(booted, "next done");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("printf routine");
		expect(rows).toContain("next done");
		expect(rows).not.toContain("printf next");
		await shutdown(booted);
	},
);

stockTest(
	"in-process /resume filters the restored transcript and the next live run keeps the persisted mode",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		// a brand-new session hydrates nothing and replays nothing
		expect(booted.harness.resetCalls).toBe(0);
		// stock switchSession emits the before/after events, then the caller
		// rebuilds the transcript (exact clear + reconstructed instances)
		harness.branch.current = committedSingleToolBranch(
			"printf first",
			"bash-1",
			"first done",
		);
		await dispatch(booted, { type: "session_before_switch", reason: "resume" });
		await dispatch(booted, { type: "session_switch", reason: "resume" });
		booted.transcript.clear();
		expect(booted.harness.clears).toBe(1);
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		rebuilt.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-1",
		);
		addAnswer(booted, "first done");
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		// the restored turn answered in text, so live filters its routine row;
		// an unbound surface would leak the stock card with the command
		expect(rows).not.toContain("printf first");
		expect(rows).toContain("first done");
		// exactly one full replay for the resumed generation
		expect(booted.harness.resetCalls).toBe(1);
		// the next live run keeps the persisted live mode
		await beginRun(booted);
		const next = await addTool(
			booted,
			"bash",
			{ command: "printf next" },
			"bash-2",
		);
		await finishTool(booted, next, {
			toolCallId: "bash-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "next done");
		await finishRun(booted, "next done");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).not.toContain("printf first");
		expect(live).not.toContain("printf next");
		await shutdown(booted);
	},
);

stockTest(
	"in-process /resume rebuild through disposeChildren keeps the restored history plugin-owned and filtered",
	async () => {
		// Stock `renderInitialMessages` without `preserveExistingChat` swaps
		// the staged transcript in via `visibleChatContainer.disposeChildren()`
		// (ui-helpers.ts), NOT `clear()` — every in-process resume caller
		// (`ctx.switchSession`, `/resume` picker, tree navigation, reload)
		// takes that branch. The disposeChildren path internally calls the
		// container's `clear`, so the C02 rebuild boundary must still fire and
		// the re-added instances must bind under the armed restore override —
		// never fall through to native rows.
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		// a brand-new session hydrates nothing and replays nothing
		expect(booted.harness.resetCalls).toBe(0);
		harness.branch.current = committedSingleToolBranch(
			"printf first",
			"bash-1",
			"first done",
		);
		await dispatch(booted, { type: "session_before_switch", reason: "resume" });
		await dispatch(booted, { type: "session_switch", reason: "resume" });
		// stock renderInitialMessages swap: disposeChildren (native dispose of
		// every child + the container's clear) instead of a bare clear
		const transcript = booted.transcript;
		expect(typeof transcript.disposeChildren).toBe("function");
		transcript.disposeChildren?.();
		expect(booted.harness.clears).toBe(1);
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		rebuilt.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-1",
		);
		addAnswer(booted, "first done");
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		// the restored history binds under the armed override: live filters the
		// routine row of the answered turn, and an unbound surface would leak
		// the stock card, which prints the command
		expect(rows).not.toContain("printf first");
		expect(rows).toContain("first done");
		// exactly one full replay for the resumed generation
		expect(booted.harness.resetCalls).toBe(1);
		await shutdown(booted);
	},
);

stockTest(
	"in-process /tree rebuild through disposeChildren keeps the navigated history plugin-owned and filtered",
	async () => {
		// Stock `/tree` commits the leaf, emits `session_tree`, then
		// `renderInitialMessages` swaps the transcript via disposeChildren
		// (ui-helpers.ts) — same rebuild surface as in-process /resume, but
		// WITHOUT session_before_switch/session_switch. The default live mode
		// plus display.collapseCompacted tail means the rebuild must arm the
		// restore override (and suffix alignment) before clear, or the visible
		// history falls through to native tool cards. Bound history under live
		// is filtered, so the marked native fallback staying off screen is
		// what proves the arming.
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		expect(booted.harness.resetCalls).toBe(0);
		harness.branch.current = [
			...committedSingleToolBranch("printf old", "bash-old", "old done"),
			...committedSingleToolBranch("printf new", "bash-new", "new done"),
		];
		await dispatch(booted, {
			type: "session_tree",
			newLeafId: "leaf-new",
			oldLeafId: "leaf-old",
		});
		const transcript = booted.transcript;
		expect(typeof transcript.disposeChildren).toBe("function");
		transcript.disposeChildren?.();
		expect(booted.harness.clears).toBe(1);
		// Collapsed visible tail only (newest tool); full branch still has
		// bash-old + bash-new. Suffix alignment requires the restore arm.
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf new" },
			"bash-new",
		);
		rebuilt.render = () => ["native-fallback"];
		rebuilt.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-new",
		);
		addAnswer(booted, "new done");
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("printf new");
		expect(rows).toContain("new done");
		expect(rows).not.toContain("native-fallback");
		expect(booted.harness.resetCalls).toBe(1);
		// Next live run clears the one-shot restore and keeps persisted live.
		await beginRun(booted);
		const next = await addTool(
			booted,
			"bash",
			{ command: "printf next" },
			"bash-live",
		);
		await finishTool(booted, next, {
			toolCallId: "bash-live",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "next done");
		await finishRun(booted, "next done");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).not.toContain("printf new");
		expect(live).not.toContain("printf next");
		await shutdown(booted);
	},
);

stockTest(
	"in-process /branch rebuild through disposeChildren keeps the branched history plugin-owned and filtered",
	async () => {
		// Stock `/branch` commits the new session file, emits `session_branch`,
		// then callers (`selector-controller` / `extension-ui-controller`) run
		// `renderInitialMessages` which swaps the transcript via disposeChildren
		// (ui-helpers.ts) — same rebuild surface as `/tree` and in-process
		// `/resume`, but WITHOUT session_before_switch/session_switch and WITHOUT
		// session_tree. The default live mode plus display.collapseCompacted
		// tail means the rebuild must arm the restore override (and suffix
		// alignment) before clear, or the visible history falls through to
		// native tool cards.
		// Bound history under live is filtered, so the marked native fallback
		// staying off screen is what proves the arming.
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		expect(booted.harness.resetCalls).toBe(0);
		harness.branch.current = [
			...committedSingleToolBranch("printf old", "bash-old", "old done"),
			...committedSingleToolBranch("printf new", "bash-new", "new done"),
		];
		await dispatch(booted, {
			type: "session_branch",
			previousSessionFile: "/tmp/prior-session.jsonl",
		});
		const transcript = booted.transcript;
		expect(typeof transcript.disposeChildren).toBe("function");
		transcript.disposeChildren?.();
		expect(booted.harness.clears).toBe(1);
		// Collapsed visible tail only (newest tool); full branch still has
		// bash-old + bash-new. Suffix alignment requires the restore arm.
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf new" },
			"bash-new",
		);
		rebuilt.render = () => ["native-fallback"];
		rebuilt.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-new",
		);
		addAnswer(booted, "new done");
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("printf new");
		expect(rows).toContain("new done");
		expect(rows).not.toContain("native-fallback");
		expect(booted.harness.resetCalls).toBe(1);
		// Next live run clears the one-shot restore and keeps persisted live.
		await beginRun(booted);
		const next = await addTool(
			booted,
			"bash",
			{ command: "printf next" },
			"bash-live",
		);
		await finishTool(booted, next, {
			toolCallId: "bash-live",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "next done");
		await finishRun(booted, "next done");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).not.toContain("printf new");
		expect(live).not.toContain("printf next");
		await shutdown(booted);
	},
);

stockTest(
	"cold launch of a collapsed-history session binds the visible tool tail",
	async () => {
		// Real-world cold restart of a long-lived session: the branch
		// carries many committed tool calls, but stock collapses the
		// compacted/summarized history behind the summary divider
		// (`display.collapseCompacted` default true) and reconstructs
		// components only for the newest tail (here: 2 branch tool states,
		// only the newest rendered as a component). The rebuild must
		// suffix-align the visible tail to the newest states — never bail
		// to native because the counts differ.
		const harness = rebuildHarness();
		harness.branch.current = [
			...committedSingleToolBranch("printf old", "bash-old", "old done"),
			...committedSingleToolBranch("printf new", "bash-new", "new done"),
		];
		const booted = await bootForRebuild("live", harness);
		// stock renderInitialMessages swap: clear + re-add of the tail
		booted.transcript.clear();
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf new" },
			"bash-new",
		);
		rebuilt.render = () => ["native-fallback"];
		rebuilt.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-new",
		);
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		// the visible tail binds (suffix-aligned to the newest state), so the
		// live restore filters its routine row instead of leaving the native
		// fallback on screen
		expect(rows).not.toContain("printf new");
		expect(rows).not.toContain("native-fallback");
		await shutdown(booted);
	},
);

stockTest(
	"cold launch binds the visible read tail to the trailing read ledger",
	async () => {
		// Same collapse contract for reads: two committed read calls in two
		// ledgers, but stock re-renders only the newest read group after the
		// swap. The group arrives without observed ids (the staged rebuild
		// never replays updateArgs), so the trailing-ledger suffix pairing
		// must bind it compact — never leave it native.
		const harness = rebuildHarness();
		harness.branch.current = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "work" }] },
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "read-first",
					toolName: "read",
					args: { path: "src/first.ts" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-first",
					toolName: "read",
					content: [{ type: "text", text: "first" }],
					isError: false,
				},
			},
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "work again" }],
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "read-last",
					toolName: "read",
					args: { path: "src/last.ts" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-last",
					toolName: "read",
					content: [{ type: "text", text: "last" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("done") },
		];
		// the compact mode keeps the paired row printed: the restore snapshot
		// follows the settings, and `src/last.ts` rather than `src/first.ts` is
		// what proves the trailing ledger won the suffix pairing
		const booted = await bootForRebuild("compact", harness);
		booted.transcript.clear();
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		// the trailing read ledger binds the visible group compact
		expect(rows).toContain("• read src/last.ts");
		expect(rows).not.toContain("● Read");
		await shutdown(booted);
	},
);

stockTest(
	"cold entry into an existing session presents the staged historical transcript compact",
	async () => {
		// Exact cold-entry sequence of `omp -c` / auto-resume: `session_start`
		// arms the one-shot restore override and hydrates the non-empty
		// branch, then stock's renderInitialMessages builds every historical
		// block in a DETACHED staged container, clears the visible one (the
		// plugin's rebuild boundary) and only then transfers the finished
		// children into it. The plugin therefore first sees the blocks at
		// transfer time — after the boundary already fired — so the deferred
		// settlement must still bind them compact. Native renderers are
		// marked so an unbound surface is observable.
		const harness = rebuildHarness();
		harness.branch.current = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "work" }] },
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "read-a",
					toolName: "read",
					args: { path: "src/a.ts" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-a",
					toolName: "read",
					content: [{ type: "text", text: "a" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "read-b",
					toolName: "read",
					args: { path: "src/b.ts" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-b",
					toolName: "read",
					content: [{ type: "text", text: "b" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "bash-r",
					toolName: "bash",
					args: { command: "printf routine" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-r",
					toolName: "bash",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("restored done") },
		];
		// compact persisted mode: the restore snapshot follows the settings, so
		// the full log is what keeps every staged row observable here
		const booted = await bootForRebuild("compact", harness);
		// stock builds the historical blocks detached from the patched
		// container, so they are constructed and populated first…
		const group = new booted.host.ReadToolGroupComponent();
		group.render = () => ["native read rows"];
		group.updateArgs({ path: "src/a.ts" }, "read-a");
		group.updateResult(
			{ content: [{ type: "text", text: "a" }], details: {} },
			false,
			"read-a",
		);
		group.updateArgs({ path: "src/b.ts" }, "read-b");
		group.updateResult(
			{ content: [{ type: "text", text: "b" }], details: {} },
			false,
			"read-b",
		);
		const call = new booted.host.ToolExecutionComponent(
			"bash",
			{ command: "printf routine" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			booted.context.cwd,
			"bash-r",
		);
		call.render = () => ["native bash card"];
		call.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"bash-r",
		);
		const reply = new booted.ContainerBase();
		reply.addChild({ render: () => ["restored done"] });
		// …then the visible container is cleared and the finished children
		// are transferred into it
		booted.transcript.clear();
		booted.transcript.addChild(group);
		booted.transcript.addChild(call);
		booted.transcript.addChild(reply);
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("restored done");
		// the staged history bound: read rows folded into the group's compact
		// lines and the routine bash row present as a compact row
		expect(rows).toContain("• read src/a.ts");
		expect(rows).toContain("• read src/b.ts");
		expect(rows).toContain("bash: printf routine");
		expect(rows).not.toContain("native read rows");
		expect(rows).not.toContain("native bash card");
		await shutdown(booted);
	},
);

stockTest(
	"a restored read run split by visible thinking pairs both stock groups",
	async () => {
		// Stock seals its read group at EVERY assistant message with visible
		// content — text, thinking or an image — and opens a fresh one for the
		// next read. Two reads separated by a thinking-plus-toolCall message
		// therefore rebuild as TWO groups while the turn itself keeps running
		// (one ledger), so the hydrated read segments must split at the same
		// point. One segment against two groups makes both pairing branches
		// disagree, nothing binds, and every restored read falls back to its
		// stock card.
		const harness = rebuildHarness();
		harness.branch.current = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "work" }] },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "checking the first file" },
						{
							type: "toolCall",
							id: "read-a",
							name: "read",
							arguments: { path: "src/a.ts" },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-a",
					toolName: "read",
					content: [{ type: "text", text: "a" }],
					isError: false,
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "now the second file" },
						{
							type: "toolCall",
							id: "read-b",
							name: "read",
							arguments: { path: "src/b.ts" },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-b",
					toolName: "read",
					content: [{ type: "text", text: "b" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("restored done") },
		];
		// The fixture picks the compact mode: the restore snapshot follows the
		// settings, so under live these paired rows would be filtered away and
		// the paths are what prove each read reached its own group.
		const booted = await bootForRebuild("compact", harness);
		// two stock groups: the thinking block between the reads closed the
		// first run
		const first = new booted.host.ReadToolGroupComponent();
		first.render = () => ["native first read"];
		first.updateArgs({ path: "src/a.ts" }, "read-a");
		first.updateResult(
			{ content: [{ type: "text", text: "a" }], details: {} },
			false,
			"read-a",
		);
		const second = new booted.host.ReadToolGroupComponent();
		second.render = () => ["native second read"];
		second.updateArgs({ path: "src/b.ts" }, "read-b");
		second.updateResult(
			{ content: [{ type: "text", text: "b" }], details: {} },
			false,
			"read-b",
		);
		const reply = new booted.ContainerBase();
		reply.addChild({ render: () => ["restored done"] });
		booted.transcript.clear();
		booted.transcript.addChild(first);
		booted.transcript.addChild(second);
		booted.transcript.addChild(reply);
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("• read src/a.ts");
		expect(rows).toContain("• read src/b.ts");
		expect(rows).not.toContain("native first read");
		expect(rows).not.toContain("native second read");
		await shutdown(booted);
	},
);

stockTest(
	"session_switch with reason new does not re-arm the restore view",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		await dispatch(booted, { type: "session_before_switch", reason: "new" });
		await dispatch(booted, { type: "session_switch", reason: "new" });
		// the adapter stays disposed after the switch; a transcript rebuild
		// is pure stock (no fold, no compact rows, no replay)
		harness.branch.current = committedSingleToolBranch(
			"printf ghost",
			"bash-1",
			"ghost done",
		);
		booted.transcript.clear();
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf ghost" },
			"bash-1",
		);
		rebuilt.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-1",
		);
		addAnswer(booted, "ghost done");
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("bash: printf ghost");
		expect(booted.harness.resetCalls).toBe(0);
		await shutdown(booted);
	},
);

stockTest(
	"a handoff session switch does not arm the restore view on the transcript",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		await dispatch(booted, {
			type: "session_before_switch",
			reason: "handoff",
		});
		await dispatch(booted, { type: "session_switch", reason: "handoff" });
		harness.branch.current = committedSingleToolBranch(
			"printf ghost",
			"bash-1",
			"ghost done",
		);
		booted.transcript.clear();
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf ghost" },
			"bash-1",
		);
		rebuilt.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-1",
		);
		addAnswer(booted, "ghost done");
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("bash: printf ghost");
		expect(booted.harness.resetCalls).toBe(0);
		await shutdown(booted);
	},
);

stockTest(
	"a committed /fork keeps the compact transcript without a rebuild",
	async () => {
		// Stock `/fork` keeps the conversation and the rendered transcript: it
		// never clears or rebuilds the chat, so there is no rehydration point.
		// Tearing the adapter down at `session_before_switch` would hand every
		// existing row back to native chrome for the rest of the session.
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf forked" },
			"bash-1",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "fork done");
		await finishRun(booted, "fork done");
		const before = visibleRows(booted.transcript).join("\n");
		expect(before).toContain("bash: printf forked");
		await dispatch(booted, { type: "session_before_switch", reason: "fork" });
		await dispatch(booted, { type: "session_switch", reason: "fork" });
		await flushMicrotasks();
		expect(visibleRows(booted.transcript).join("\n")).toBe(before);
		await beginRun(booted);
		await flushMicrotasks();
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf forked",
		);
		await shutdown(booted);
	},
);

stockTest(
	"a brand-new session keeps the persisted live policy with no restore replay",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		expect(booted.harness.resetCalls).toBe(0);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf fresh" },
			"bash-1",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "fresh done");
		await finishRun(booted, "fresh done");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("printf fresh");
		await shutdown(booted);
	},
);

stockTest(
	"tree-like rebuild with identical toolCallIds reapplies compact policy and keeps the next live run working",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "first done");
		await finishRun(booted, "first done");
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf first",
		);
		// the authoritative branch now holds the committed run
		booted.harness.branch.current = committedSingleToolBranch(
			"printf first",
			"bash-1",
			"first done",
		);
		// stock rebuild: exact clear + reconstructed instances with the
		// identical toolCallIds
		booted.transcript.clear();
		expect(booted.harness.clears).toBe(1);
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		rebuilt.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-1",
		);
		addAnswer(booted, "first done");
		await flushMicrotasks();
		const rebuiltRows = visibleRows(booted.transcript).join("\n");
		expect(rebuiltRows).toContain("bash: printf first");
		expect(rebuiltRows).toContain("first done");
		// the retired instance is fully unwrapped (no stale strong refs)
		expect(Object.hasOwn(call, "render")).toBe(false);
		// exactly one full replay for this generation
		expect(booted.harness.resetCalls).toBe(1);
		// the next live run works against the rebuilt prefix
		await beginRun(booted);
		const next = await addTool(
			booted,
			"bash",
			{ command: "printf next" },
			"bash-2",
		);
		const liveRows = visibleRows(booted.transcript).join("\n");
		expect(liveRows).toContain("bash: printf next");
		expect(liveRows).toContain("bash: printf first");
		await finishTool(booted, next, {
			toolCallId: "bash-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "next done");
		await finishRun(booted, "next done");
		const terminalRows = visibleRows(booted.transcript).join("\n");
		expect(terminalRows).toContain("bash: printf next");
		expect(terminalRows).toContain("bash: printf first");
		expect(terminalRows).toContain("next done");
		await shutdown(booted);
	},
);

stockTest(
	"shake-like branch rewrite applies the current live policy to the rebuilt prefix and the new suffix",
	async () => {
		const booted = await bootForRebuild("live");
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		await finishTool(booted, first, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		const second = await addTool(
			booted,
			"bash",
			{ command: "printf second" },
			"bash-2",
		);
		await finishTool(booted, second, {
			toolCallId: "bash-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "shake done");
		await finishRun(booted, "shake done");
		// live terminal: routine tools are filtered out
		expect(visibleRows(booted.transcript).join("\n")).not.toContain("printf");
		// shake elides the branch down to the surviving tool result
		booted.harness.branch.current = committedSingleToolBranch(
			"printf first",
			"bash-1",
			"shake done",
		);
		booted.transcript.clear();
		expect(booted.harness.clears).toBe(1);
		addToolComponent(booted, "bash", { command: "printf first" }, "bash-1");
		addAnswer(booted, "shake done");
		await flushMicrotasks();
		const rebuilt = visibleRows(booted.transcript).join("\n");
		// the rebuilt historical prefix follows the current live policy
		expect(rebuilt).not.toContain("printf first");
		expect(rebuilt).toContain("shake done");
		// the new live suffix renders compact and settles filtered too
		await beginRun(booted);
		const third = await addTool(
			booted,
			"bash",
			{ command: "printf third" },
			"bash-3",
		);
		const working = visibleRows(booted.transcript).join("\n");
		expect(working).toContain("bash: printf third");
		await finishTool(booted, third, {
			toolCallId: "bash-3",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "third done");
		await finishRun(booted, "third done");
		const settled = visibleRows(booted.transcript).join("\n");
		expect(settled).not.toContain("printf third");
		expect(settled).toContain("third done");
		await shutdown(booted);
	},
);

stockTest(
	"shake rebuild filters a grouped read when interleaved tools split replay segments",
	async () => {
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		harness.branch.current = interleavedGroupedReadBranch("shake read done");

		booted.transcript.clear();
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		for (const [toolCallId, path] of [
			["read-first", "src/first.ts"],
			["read-last", "src/last.ts"],
		] as const) {
			group.updateArgs({ path }, toolCallId);
			group.updateResult(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				false,
				toolCallId,
			);
		}
		const ContainerBase = Object.getPrototypeOf(
			booted.host.ReadToolGroupComponent.prototype,
		).constructor as BootedPlugin["ContainerBase"];
		const reply = new ContainerBase();
		reply.addChild({ render: () => ["shake read done"] });
		booted.transcript.addChild(reply);
		await flushMicrotasks();

		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("src/first.ts");
		expect(rows).not.toContain("src/last.ts");
		expect(rows).not.toContain("● Read");
		expect(rows).toContain("shake read done");
		await shutdown(booted);
	},
);

stockTest(
	"tree rebuild presents interleaved reads compact under the restore override",
	async () => {
		// Committed `/tree` arms restoreOverride before the
		// disposeChildren/clear rebuild. Interleaved read segments still pair
		// correctly across the boundary. The fixture picks the compact mode
		// because the restore snapshot follows the settings now: under live a
		// correctly paired row of an answered turn is filtered away, and the
		// paths are what prove each segment reached its own group.
		const harness = rebuildHarness();
		const booted = await bootForRebuild("compact", harness);
		const answer = "tree read done";
		harness.branch.current = interleavedGroupedReadBranch(answer);
		await dispatch(booted, {
			type: "session_tree",
			newLeafId: "tree-read-new",
			oldLeafId: "tree-read-old",
		});
		booted.transcript.clear();
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		for (const [toolCallId, path] of [
			["read-first", "src/first.ts"],
			["read-last", "src/last.ts"],
		] as const) {
			group.updateArgs({ path }, toolCallId);
			group.updateResult(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				false,
				toolCallId,
			);
		}
		const ContainerBase = Object.getPrototypeOf(
			booted.host.ReadToolGroupComponent.prototype,
		).constructor as BootedPlugin["ContainerBase"];
		const reply = new ContainerBase();
		reply.addChild({ render: () => [answer] });
		booted.transcript.addChild(reply);
		await flushMicrotasks();

		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("• read src/first.ts");
		expect(rows).toContain("• read src/last.ts");
		expect(rows).not.toContain("● Read");
		expect(rows).toContain(answer);
		await shutdown(booted);
	},
);

stockTest(
	"session_compact arms the collapsed-rebuild permit for the post-summary tail",
	async () => {
		// Stock emits session_compact after a successful LLM compaction, then
		// rebuilds only the post-summary tail (display.collapseCompacted
		// default true) while getBranch() still walks the full path. Suffix
		// alignment is what binds that shorter visible tail to the newest
		// branch states, and this event is one of only two things that arm it.
		//
		// The fixture must NOT boot through a path that already arms the
		// restore override, or the permit would be untested: no
		// session_before_switch, no session_tree, and the branch is installed
		// after boot so the cold-launch arming does not cover the tail either.
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		harness.branch.current = [
			...committedSingleToolBranch("printf old", "bash-old", "old done"),
			...committedSingleToolBranch("printf new", "bash-new", "new done"),
		];
		await dispatch(booted, { type: "session_compact" });
		booted.transcript.clear();
		// Only the newest of the two branch tool states comes back, exactly
		// as stock reconstructs a collapsed history.
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf new" },
			"bash-new",
		);
		rebuilt.render = () => ["native-fallback"];
		// No toolCallId on the replay: the exact-ID pass must not be able to
		// resolve this card, so only the permit's suffix alignment can bind
		// it (a pending/background card replays exactly like this).
		rebuilt.updateResult({ content: [{ type: "text", text: "ok" }] }, false);
		await flushMicrotasks();

		const rows = visibleRows(booted.transcript).join("\n");
		// Bound through the permit: the live policy filters the routine row.
		// Without the permit the counts differ, pairing bails, and the native
		// fallback stays on screen.
		expect(rows).not.toContain("printf new");
		expect(rows).not.toContain("native-fallback");
		await shutdown(booted);
	},
);

stockTest(
	"auto-shake arms the collapsed-rebuild permit for the replayed tail",
	async () => {
		// An auto-shake elides heavy tool results in place and stock then calls
		// rebuildChatFromMessages (event-controller: rebuild on success, and on
		// the fallback path that still reclaimed tokens). No compaction entry is
		// written, so `session_compact` never fires — the rebuild used to land
		// unarmed. Whenever the replayed transcript carries fewer tool
		// components than the branch has tool states (reads re-collapsing into
		// one group, a background/pending tool kept live by the replay), exact
		// pairing bails, suffix alignment stays locked, and every visible card
		// keeps its native chrome until the session is reopened — the whole
		// history goes native mid-session while `--resume` renders it compact.
		//
		// Same fixture contract as the session_compact permit test: no
		// session_before_switch, no session_tree, branch installed after boot,
		// so nothing else arms the pairing.
		const harness = rebuildHarness();
		const booted = await bootForRebuild("live", harness);
		harness.branch.current = [
			...committedSingleToolBranch("printf old", "bash-old", "old done"),
			...committedSingleToolBranch("printf new", "bash-new", "new done"),
		];
		await dispatch(booted, {
			type: "auto_compaction_end",
			action: "shake",
			result: undefined,
			aborted: false,
			willRetry: false,
		});
		booted.transcript.clear();
		const rebuilt = addToolComponent(
			booted,
			"bash",
			{ command: "printf new" },
			"bash-new",
		);
		rebuilt.render = () => ["native-fallback"];
		// Same id-less replay as the session_compact permit test: the permit
		// is the only thing that can bind this card.
		rebuilt.updateResult({ content: [{ type: "text", text: "ok" }] }, false);
		await flushMicrotasks();

		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).not.toContain("printf new");
		expect(rows).not.toContain("native-fallback");
		await shutdown(booted);
	},
);

stockTest("a manual shake rebuild binds the collapsed tail", async () => {
	// `/shake` reclaims tokens through session.shake(), which emits no
	// extension event at all (session-maintenance.ts: rewriteEntries +
	// replaceMessages, no emit), then command-controller rebuilds the
	// transcript. Nothing arms the suffix permit on that path, so the
	// replayed tail must bind on the exact ids stock replays through
	// updateResult — the same shape the auto-shake test covers, minus the
	// event.
	const harness = rebuildHarness();
	const booted = await bootForRebuild("live", harness);
	harness.branch.current = [
		...committedSingleToolBranch("printf old", "bash-old", "old done"),
		...committedSingleToolBranch("printf new", "bash-new", "new done"),
	];
	booted.transcript.clear();
	const rebuilt = addToolComponent(
		booted,
		"bash",
		{ command: "printf new" },
		"bash-new",
	);
	rebuilt.render = () => ["native-fallback"];
	rebuilt.updateResult(
		{ content: [{ type: "text", text: "ok" }] },
		false,
		"bash-new",
	);
	await flushMicrotasks();

	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).not.toContain("printf new");
	expect(rows).not.toContain("native-fallback");
	await shutdown(booted);
});

stockTest("an aborted auto-shake arms nothing", async () => {
	// The cancelled and benign-skip paths never rebuild the transcript, so
	// arming there would leave a stale permit for whatever clear comes next
	// (a live /clear, the next run's own rebuild) and let suffix alignment
	// rewrite rows it never proved ownership of.
	const harness = rebuildHarness();
	const booted = await bootForRebuild("live", harness);
	harness.branch.current = [
		...committedSingleToolBranch("printf old", "bash-old", "old done"),
		...committedSingleToolBranch("printf new", "bash-new", "new done"),
	];
	await dispatch(booted, {
		type: "auto_compaction_end",
		action: "shake",
		result: undefined,
		aborted: true,
		willRetry: false,
	});
	booted.transcript.clear();
	const rebuilt = addToolComponent(
		booted,
		"bash",
		{ command: "printf new" },
		"bash-new",
	);
	rebuilt.render = () => ["native-fallback"];
	// Id-less replay: with no exact evidence, suffix alignment is the only
	// route left and it must stay locked.
	rebuilt.updateResult({ content: [{ type: "text", text: "ok" }] }, false);
	await flushMicrotasks();

	expect(visibleRows(booted.transcript).join("\n")).toContain(
		"native-fallback",
	);
	await shutdown(booted);
});

stockTest("two quick clears replay only the latest generation", async () => {
	const booted = await bootForRebuild("compact");
	await beginRun(booted);
	const call = await addTool(
		booted,
		"bash",
		{ command: "printf first" },
		"bash-1",
	);
	await finishTool(booted, call, {
		toolCallId: "bash-1",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	addAnswer(booted, "first done");
	await finishRun(booted, "first done");
	booted.harness.branch.current = committedSingleToolBranch(
		"printf first",
		"bash-1",
		"first done",
	);
	// rebuild 1: a stale generation
	booted.transcript.clear();
	const stale = addToolComponent(
		booted,
		"bash",
		{ command: "printf first" },
		"bash-1",
	);
	// rebuild 2 before the settlement microtask runs: supersedes it
	booted.transcript.clear();
	expect(booted.harness.clears).toBe(2);
	const latest = addToolComponent(
		booted,
		"bash",
		{ command: "printf first" },
		"bash-1",
	);
	addAnswer(booted, "first done");
	await flushMicrotasks();
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("bash: printf first");
	expect(rows).toContain("first done");
	// only the latest generation replayed
	expect(booted.harness.resetCalls).toBe(1);
	// the intermediate generation's component was retired unwrapped
	expect(Object.hasOwn(stale, "render")).toBe(false);
	expect(Object.hasOwn(latest, "render")).toBe(true);
	await shutdown(booted);
});

stockTest(
	"dispose before the settlement microtask cancels the replay and leaves pure stock presentation",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "first done");
		await finishRun(booted, "first done");
		booted.harness.branch.current = committedSingleToolBranch(
			"printf first",
			"bash-1",
			"first done",
		);
		booted.transcript.clear();
		expect(booted.harness.clears).toBe(1);
		// shutdown before the microtask: the rebuild is cancelled and the
		// rollback leaves pure stock presentation rather than a mixed one
		await shutdown(booted);
		expect(booted.harness.resetCalls).toBe(0);
		expect(Object.hasOwn(booted.transcript, "render")).toBe(false);
		// the adapter's clear wrapper is gone: the transcript's own clear is
		// the harness counter the adapter captured as its original again
		const originalClear = booted.harness.originalClear;
		expect(originalClear).toBeDefined();
		if (!originalClear) throw new Error("original clear missing");
		expect(booted.transcript.clear).toBe(originalClear);
		expect(Object.hasOwn(call, "render")).toBe(false);
		expect(() => booted.transcript.render(120)).not.toThrow();
		expect(booted.notifications).toHaveLength(0);
	},
);

stockTest(
	"rebuilt unknown and expanded surfaces stay native while known tools go compact",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf known" },
			"bash-1",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "mystery-1",
			toolName: "mystery",
			args: { action: "probe" },
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		booted.harness.branch.current = [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "work" }],
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "bash-1",
					toolName: "bash",
					args: { command: "printf known" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "mystery-1",
					toolName: "mystery",
					args: { action: "probe" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "mystery-1",
					toolName: "mystery",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("done") },
		];
		booted.transcript.clear();
		const rebuiltKnown = addToolComponent(
			booted,
			"bash",
			{ command: "printf known" },
			"bash-1",
		);
		rebuiltKnown.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"bash-1",
		);
		const rebuiltUnknown = addToolComponent(
			booted,
			"mystery",
			{ action: "probe" },
			"mystery-1",
		);
		rebuiltUnknown.render = () => ["native-mystery"];
		rebuiltUnknown.updateResult(
			{ content: [{ type: "text", text: "ok" }] },
			false,
			"mystery-1",
		);
		addAnswer(booted, "done");
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("bash: printf known");
		expect(rows).toContain("native-mystery");
		// expanded surfaces stay native during the live phase after a rebuild
		await beginRun(booted);
		const expanded = await addTool(
			booted,
			"bash",
			{ command: "printf expanded" },
			"bash-2",
		);
		expanded.render = () => ["native-expanded"];
		expanded.setExpanded(true);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("native-expanded");
		expect(live).not.toContain("bash: printf expanded");
		await finishTool(booted, expanded, {
			toolCallId: "bash-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "expanded done");
		await finishRun(booted, "expanded done");
		await shutdown(booted);
	},
);

stockTest(
	"mid-run rebuild preserves the active pending tool without duplication",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf pending" },
			"bash-1",
		);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf pending",
		);
		// mid-run rebuild (e.g. a settings/theme change): stock preserves
		// the in-flight component instance and re-appends it
		booted.transcript.clear();
		expect(booted.harness.clears).toBe(1);
		booted.transcript.addChild(call);
		await flushMicrotasks();
		const rebuilt = visibleRows(booted.transcript).join("\n");
		// neither duplicated nor lost: exactly one pending compact row
		expect(rebuilt).toContain("bash: printf pending");
		expect(rebuilt.match(/printf pending/g)).toHaveLength(1);
		// exactly one full replay for this generation
		expect(booted.harness.resetCalls).toBe(1);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "pending done");
		await finishRun(booted, "pending done");
		const settled = visibleRows(booted.transcript).join("\n");
		expect(settled).toContain("bash: printf pending");
		expect(settled).toContain("pending done");
		await shutdown(booted);
	},
);

stockTest(
	"mid-run rebuild restores two exact active components and binds a new same-run tool",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		const second = await addTool(
			booted,
			"bash",
			{ command: "printf second" },
			"bash-2",
		);

		booted.transcript.clear();
		// Stock re-adds the exact live objects synchronously without replaying
		// updateArgs(args, toolCallId) for either historical component.
		booted.transcript.addChild(first);
		booted.transcript.addChild(second);
		await flushMicrotasks();
		const rebuilt = visibleRows(booted.transcript).join("\n");
		expect(rebuilt).toContain("bash: printf first");
		expect(rebuilt).toContain("bash: printf second");
		expect(rebuilt.match(/printf first/g)).toHaveLength(1);
		expect(rebuilt.match(/printf second/g)).toHaveLength(1);

		// A new same-run component must bind without requiring another
		// historical-ID callback from either preserved component.
		const afterRebuild = await addTool(
			booted,
			"bash",
			{ command: "printf after-rebuild" },
			"bash-3",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("bash: printf after-rebuild");
		expect(live.match(/printf after-rebuild/g)).toHaveLength(1);

		for (const [component, toolCallId] of [
			[first, "bash-1"],
			[second, "bash-2"],
			[afterRebuild, "bash-3"],
		] as const) {
			await finishTool(booted, component, {
				toolCallId,
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			});
		}
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		await shutdown(booted);
	},
);

stockTest(
	"fresh logical run ignores unresolved active rebuild states when binding a new tool",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf stale-first" },
			"stale-1",
		);
		const second = await addTool(
			booted,
			"bash",
			{ command: "printf stale-second" },
			"stale-2",
		);

		booted.transcript.clear();
		// These active components are not reconstructed in this generation;
		// their unresolved states must remain evidence, not block a later run.
		await flushMicrotasks();
		await finishTool(booted, first, {
			toolCallId: "stale-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		await finishTool(booted, second, {
			toolCallId: "stale-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "stale done");
		await finishRun(booted, "stale done");

		await beginRun(booted);
		const fresh = await addTool(
			booted,
			"bash",
			{ command: "printf fresh" },
			"fresh-1",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("bash: printf fresh");
		expect(live.match(/printf fresh/g)).toHaveLength(1);
		await finishTool(booted, fresh, {
			toolCallId: "fresh-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "fresh done");
		await finishRun(booted, "fresh done");
		await shutdown(booted);
	},
);

stockTest(
	"two quick clears carry the exact active components into the latest generation",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		const second = await addTool(
			booted,
			"bash",
			{ command: "printf second" },
			"bash-2",
		);
		// Both clears land before any re-add: the second generation
		// supersedes the first, but the exact active identity captured by
		// the first clear must carry into the latest generation — stock
		// re-adds the same live objects after the final clear without
		// replaying updateArgs for either component.
		booted.transcript.clear();
		booted.transcript.clear();
		expect(booted.harness.clears).toBe(2);
		booted.transcript.addChild(first);
		booted.transcript.addChild(second);
		await flushMicrotasks();
		const rebuilt = visibleRows(booted.transcript).join("\n");
		expect(rebuilt).toContain("bash: printf first");
		expect(rebuilt).toContain("bash: printf second");
		expect(rebuilt.match(/printf first/g)).toHaveLength(1);
		expect(rebuilt.match(/printf second/g)).toHaveLength(1);
		// exactly one replay, for the latest generation only
		expect(booted.harness.resetCalls).toBe(1);
		for (const [component, toolCallId] of [
			[first, "bash-1"],
			[second, "bash-2"],
		] as const) {
			await finishTool(booted, component, {
				toolCallId,
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			});
		}
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		await shutdown(booted);
	},
);

stockTest(
	"a new same-run tool binds after a partial rebuild without poisoning from the unresolved state",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		const second = await addTool(
			booted,
			"bash",
			{ command: "printf second" },
			"bash-2",
		);
		booted.transcript.clear();
		// Only the first object is reconstructed synchronously; the second
		// active state loses its host callback and stays unresolved evidence
		// for the rest of the run.
		booted.transcript.addChild(first);
		await flushMicrotasks();
		const rebuilt = visibleRows(booted.transcript).join("\n");
		expect(rebuilt).toContain("bash: printf first");
		expect(rebuilt.match(/printf first/g)).toHaveLength(1);
		// The genuinely new tool of the same logical run must bind compactly:
		// the unresolved preserved state must not inflate the single-pair
		// cardinality, and must never be guessed against by ordinal.
		const fresh = await addTool(
			booted,
			"bash",
			{ command: "printf fresh" },
			"bash-3",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("bash: printf fresh");
		expect(live.match(/printf fresh/g)).toHaveLength(1);
		for (const [component, toolCallId] of [
			[first, "bash-1"],
			[second, "bash-2"],
			[fresh, "bash-3"],
		] as const) {
			await finishTool(booted, component, {
				toolCallId,
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			});
		}
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const settled = visibleRows(booted.transcript).join("\n");
		expect(settled).toContain("bash: printf first");
		expect(settled).toContain("bash: printf fresh");
		expect(settled.match(/printf first/g)).toHaveLength(1);
		expect(settled.match(/printf fresh/g)).toHaveLength(1);
		// the unresolved state contributes no phantom row
		expect(settled).not.toContain("printf second");
		await shutdown(booted);
	},
);

stockTest(
	"session_tree intent alone never advances the presentation generation",
	async () => {
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "first done");
		await finishRun(booted, "first done");
		booted.harness.branch.current = committedSingleToolBranch(
			"printf first",
			"bash-1",
			"first done",
		);
		// cancelled/no-op tree interaction: the intent event without any
		// transcript clear must not advance the generation or replay
		await dispatch(booted, {
			type: "session_tree",
			newLeafId: "leaf-2",
			oldLeafId: "leaf-1",
		});
		expect(booted.harness.resetCalls).toBe(0);
		expect(booted.harness.clears).toBe(0);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf first",
		);
		// a committed navigation rebuilds and replays exactly once
		booted.transcript.clear();
		addToolComponent(booted, "bash", { command: "printf first" }, "bash-1");
		addAnswer(booted, "first done");
		await flushMicrotasks();
		expect(booted.harness.resetCalls).toBe(1);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf first",
		);
		await shutdown(booted);
	},
);

stockTest(
	"session_branch alone never advances the presentation generation",
	async () => {
		// session_branch is a post-commit hook only — rehydration keys off the
		// transcript clear that follows the caller's renderInitialMessages, not
		// the event itself (mirrors session_tree intent).
		const booted = await bootForRebuild("compact");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-1",
		);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		addAnswer(booted, "first done");
		await finishRun(booted, "first done");
		booted.harness.branch.current = committedSingleToolBranch(
			"printf first",
			"bash-1",
			"first done",
		);
		await dispatch(booted, {
			type: "session_branch",
			previousSessionFile: "/tmp/prior-session.jsonl",
		});
		expect(booted.harness.resetCalls).toBe(0);
		expect(booted.harness.clears).toBe(0);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf first",
		);
		// a committed branch rebuilds and replays exactly once
		booted.transcript.clear();
		addToolComponent(booted, "bash", { command: "printf first" }, "bash-1");
		addAnswer(booted, "first done");
		await flushMicrotasks();
		expect(booted.harness.resetCalls).toBe(1);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf first",
		);
		await shutdown(booted);
	},
);

stockTest("ambiguous rebuild mapping stays native per block", async () => {
	const booted = await bootForRebuild("compact");
	await beginRun(booted);
	const first = await addTool(
		booted,
		"bash",
		{ command: "printf first" },
		"bash-1",
	);
	await finishTool(booted, first, {
		toolCallId: "bash-1",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	const second = await addTool(
		booted,
		"bash",
		{ command: "printf second" },
		"bash-2",
	);
	await finishTool(booted, second, {
		toolCallId: "bash-2",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	addAnswer(booted, "done");
	await finishRun(booted, "done");
	booted.harness.branch.current = [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "work" }] },
		},
		{
			type: "custom",
			customType: "tool_execution_start",
			data: {
				toolCallId: "bash-1",
				toolName: "bash",
				args: { command: "printf first" },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "bash-1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
		},
		{
			type: "custom",
			customType: "tool_execution_start",
			data: {
				toolCallId: "bash-2",
				toolName: "bash",
				args: { command: "printf second" },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "bash-2",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
		},
		{ type: "message", message: assistant("done") },
	];
	booted.transcript.clear();
	// only one of the two historical components is re-added: the
	// reconstruction is ambiguous for the branch and stays native
	const rebuilt = addToolComponent(
		booted,
		"bash",
		{ command: "printf first" },
		"bash-1",
	);
	rebuilt.render = () => ["native-ambiguous"];
	addAnswer(booted, "done");
	await flushMicrotasks();
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("native-ambiguous");
	expect(rows).not.toContain("bash: printf first");
	expect(rows).toContain("done");
	await shutdown(booted);
});

stockTest(
	"unpatchable transcript clear rolls back transactionally to stock presentation",
	async () => {
		let transcript: TranscriptInstance | undefined;
		let nativeClear: (() => void) | undefined;
		const booted = await bootPlugin((root, host) => {
			const candidate = new host.TranscriptContainer();
			// `clear` is present (the capability probe passes) but cannot be
			// patched: the transaction must fail open to pure stock.
			nativeClear = candidate.clear;
			Object.defineProperty(candidate, "clear", {
				value: nativeClear,
				configurable: false,
				writable: true,
			});
			transcript = candidate;
			root.addChild(candidate);
		});
		if (!transcript) throw new Error("transcript missing");
		const resolvedTranscript = transcript;
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		// wrappers applied before the failing clear patch are gone
		expect(Object.hasOwn(transcript, "render")).toBe(false);
		expect(Object.hasOwn(transcript, "addChild")).toBe(false);
		// the incompatible own property keeps its exact descriptor and the
		// native method was never wrapped
		// the callback above assigned the native method unconditionally
		expect(nativeClear).toBeDefined();
		if (!nativeClear) throw new Error("native clear missing");
		expect(transcript.clear).toBe(nativeClear);
		expect(
			Object.getOwnPropertyDescriptor(transcript, "clear")?.configurable,
		).toBe(false);
		expect(() => resolvedTranscript.render(120)).not.toThrow();
		expect(booted.intervalCallbacks).toHaveLength(0);
		await shutdown(booted);
		expect(booted.notifications).toHaveLength(1);
	},
);
