import { afterAll, expect } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	addTool,
	addToolComponent,
	assistant,
	type BootedPlugin,
	bootForRebuild,
	beginRun,
	bootPlugin,
	cleanupGeneratedDirs,
	bootWithMode,
	dispatch,
	fakeTool,
	flushMicrotasks,
	finishRun,
	finishTool,
	rebuildHarness,
	groupedRead,
	shutdown,
	stockTest,
	toolUi,
	visibleRows,
} from "./integration-harness";
import type { TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

stockTest(
	"reusing a read ID cannot resurrect a finished native group",
	async () => {
		const booted = await bootWithMode("live");
		try {
			await beginRun(booted);
			await groupedRead(booted, "old.ts", "reused-read");
			await finishRun(booted, "first answer");
			expect(visibleRows(booted.transcript).join("\n")).not.toContain("old.ts");
			await beginRun(booted);
			await groupedRead(booted, "new.ts", "reused-read");
			const working = visibleRows(booted.transcript).join("\n");
			expect(working).toContain("new.ts");
			expect(working).not.toContain("old.ts");
			await finishRun(booted, "second answer");
			const finished = visibleRows(booted.transcript).join("\n");
			expect(finished).not.toContain("old.ts");
			expect(finished).not.toContain("new.ts");
		} finally {
			await shutdown(booted);
		}
	},
);

stockTest("shutdown restores own descriptors exactly", async () => {
	let transcript: TranscriptInstance | undefined;
	const booted = await bootPlugin((root, host) => {
		transcript = new host.TranscriptContainer();
		root.addChild(transcript);
	});
	if (!transcript) throw new Error("transcript missing");
	expect(Object.hasOwn(transcript, "addChild")).toBe(true);
	await shutdown(booted);
	expect(Object.hasOwn(transcript, "addChild")).toBe(false);
});

stockTest(
	"a vetoed resume keeps the current transcript and pending audit",
	async () => {
		const booted = await bootForRebuild("compact");
		try {
			await beginRun(booted);
			const old = await addTool(
				booted,
				"bash",
				{ command: "printf retained" },
				"before-veto",
			);
			await finishTool(booted, old, {
				toolCallId: "before-veto",
				toolName: "bash",
				result: { content: [{ type: "text", text: "retained" }] },
				isError: false,
			});
			const edit = await addTool(
				booted,
				"edit",
				{ path: "retained.ts" },
				"pending-edit",
			);
			const before = visibleRows(booted.transcript);
			await dispatch(booted, {
				type: "session_before_switch",
				reason: "resume",
			});
			// A later extension vetoes the switch. Native emits no session_switch
			// and keeps the current run; its next tool end still belongs here.
			expect(visibleRows(booted.transcript)).toEqual(before);
			await finishTool(booted, edit, {
				toolCallId: "pending-edit",
				toolName: "edit",
				isError: false,
				result: {
					content: [],
					details: {
						path: "retained.ts",
						diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n",
					},
				},
			});
			await finishRun(booted, "continued after veto");
			const rows = visibleRows(booted.transcript).join("\n");
			expect(rows).toContain("bash: printf retained");
			expect(rows).toMatch(/edit: retained\.ts.*\+1\|[^0-9]*1/);
		} finally {
			await shutdown(booted);
		}
	},
);

stockTest(
	"incompatible transcript shape fails open and rolls back discovery wrappers",
	async () => {
		let rootOwnAddChildBefore = false;
		const booted = await bootPlugin((root) => {
			rootOwnAddChildBefore = Object.hasOwn(root, "addChild");
			const incompatible = Object.freeze({
				children: [],
				addChild() {},
				render: () => [],
				renderViewport: () => [],
				liveRowCount: () => 0,
				peekFinalizedBatch: () => undefined,
				acknowledgeFinalizedBatch: () => {},
				canRemoveBlock: () => true,
				blockStates: () => [],
			});
			root.addChild(incompatible);
		});
		expect(rootOwnAddChildBefore).toBe(false);
		expect(Object.hasOwn(booted.root, "addChild")).toBe(false);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "edit-disabled",
			toolName: "edit",
			args: { input: "multi" },
		});
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "edit-disabled",
			toolName: "edit",
			result: {
				details: {
					perFileResults: [
						{
							path: "src/a.ts",
							diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n",
						},
					],
				},
			},
			isError: false,
		});
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		expect(booted.notifications).toHaveLength(1);
		await shutdown(booted);
	},
);

stockTest(
	"process restore keeps the compact mutation and drops routine Git rows under live persisted settings",
	async () => {
		let transcript: TranscriptInstance | undefined;
		const branch = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "work" }] },
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "routine",
					toolName: "bash",
					args: { command: "printf routine" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "routine",
					toolName: "bash",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "mutation",
					toolName: "write",
					args: { path: "resume.ts", content: "new" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "mutation",
					toolName: "write",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId: "mutation",
					toolName: "write",
					path: "resume.ts",
					added: 2,
					removed: 1,
					exact: true,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "git",
					toolName: "bash",
					args: { command: "git status --short" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "git",
					toolName: "bash",
					content: [{ type: "text", text: "clean" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("done") },
			{
				type: "custom_message",
				customType: "omp-compact-git",
				display: false,
				content: "",
				details: {
					version: 1,
					toolCallId: "git",
					subcommand: "status",
					text: "git status --short",
					isError: false,
				},
			},
		];
		const booted = await bootPlugin(
			(root, host) => {
				transcript = new host.TranscriptContainer();
				root.addChild(transcript);
				for (const { id, toolName, args } of [
					{
						id: "routine",
						toolName: "bash",
						args: { command: "printf routine" },
					},
					{
						id: "mutation",
						toolName: "write",
						args: { path: "resume.ts", content: "new" },
					},
					{
						id: "git",
						toolName: "bash",
						args: { command: "git status --short" },
					},
				]) {
					const call = new host.ToolExecutionComponent(
						toolName,
						args,
						{ showImages: false, useBuiltInRenderer: true },
						fakeTool(toolName),
						toolUi(),
						"/tmp",
						id,
					);
					call.updateResult(
						{ content: [{ type: "text", text: "ok" }], details: {} },
						false,
						id,
					);
					transcript.addChild(call);
				}
				const ContainerBase = Object.getPrototypeOf(
					host.ReadToolGroupComponent.prototype,
				).constructor as BootedPlugin["ContainerBase"];
				const reply = new ContainerBase();
				reply.addChild({ render: () => ["done"] });
				transcript.addChild(reply);
			},
			"/tmp",
			branch,
		);
		if (!transcript) throw new Error("transcript missing");
		const rows = visibleRows(transcript).join("\n");
		// The restored turn answered in text, so the live restore keeps exactly
		// what a finished live run keeps: the verified mutation, and neither the
		// routine bash row nor the non-commit Git row.
		expect(rows).toContain("write: resume.ts");
		expect(rows).toContain("+2|1");
		expect(rows).toContain("done");
		expect(rows).not.toContain("git status");
		expect(rows).not.toContain("git commit:");
		expect(rows).not.toContain("printf routine");
		await shutdown(booted);
	},
);

stockTest(
	"process restore filters routine grouped reads and keeps the commit as the retained summary under live",
	async () => {
		let transcript: TranscriptInstance | undefined;
		const branch = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "work" }] },
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "read-r",
					toolName: "read",
					args: { path: "src/replay.ts" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-r",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "git",
					toolName: "bash",
					args: { command: "git commit -m 'Fix replay'" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "git",
					toolName: "bash",
					content: [{ type: "text", text: "[main abc1234] Fix replay" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("done") },
			{
				type: "custom_message",
				customType: "omp-compact-git",
				display: false,
				content: "",
				details: {
					version: 1,
					toolCallId: "git",
					subcommand: "commit",
					text: "git commit abc1234 Fix replay",
					isError: false,
				},
			},
		];
		const booted = await bootPlugin(
			(root, host) => {
				transcript = new host.TranscriptContainer();
				root.addChild(transcript);
				const group = new host.ReadToolGroupComponent();
				transcript.addChild(group);
				const call = new host.ToolExecutionComponent(
					"bash",
					{ command: "git commit -m 'Fix replay'" },
					{ showImages: false, useBuiltInRenderer: true },
					fakeTool("bash"),
					toolUi(),
					"/tmp",
					"git",
				);
				call.updateResult(
					{
						content: [{ type: "text", text: "[main abc1234] Fix replay" }],
						details: {},
					},
					false,
					"git",
				);
				transcript.addChild(call);
				const ContainerBase = Object.getPrototypeOf(
					host.ReadToolGroupComponent.prototype,
				).constructor as BootedPlugin["ContainerBase"];
				const reply = new ContainerBase();
				reply.addChild({ render: () => ["done"] });
				transcript.addChild(reply);
			},
			"/tmp",
			branch,
		);
		if (!transcript) throw new Error("transcript missing");
		const rows = visibleRows(transcript).join("\n");
		// The restored turn answered in text, so the live restore presents it
		// exactly like a finished live run: the routine read is gone, the
		// commit survives as the retained aggregate summary rather than its
		// individual row, and nothing falls back to a native read card.
		expect(rows).toContain("git commit: abc1234");
		expect(rows).not.toContain("git commit abc1234 Fix replay");
		expect(rows).toContain("done");
		expect(rows).not.toContain("src/replay.ts");
		expect(rows).not.toContain("Read src");
		await shutdown(booted);
	},
);

stockTest(
	"cold restore keeps compact tools when skill:// reads render as full tool cards",
	async () => {
		// Stock 17.4.0: skill:// / agent:// reads are ToolExecutionComponent
		// (not ReadToolGroup). A prior bindHydrated filter treated every read
		// as group-only, so one skill card inflated unboundComponents and
		// failed order pairing for the whole restored transcript — empty
		// compact rebuild after omp -c.
		const harness = rebuildHarness();
		const branch = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "work" }] },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "bash-1",
							name: "bash",
							arguments: { command: "printf ready" },
						},
						{
							type: "toolCall",
							id: "skill-1",
							name: "read",
							arguments: { path: "skill://writing-skills" },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					content: [{ type: "text", text: "ready" }],
					isError: false,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "skill-1",
					toolName: "read",
					content: [{ type: "text", text: "skill body" }],
					isError: false,
				},
			},
			{ type: "message", message: assistant("done") },
		];
		harness.branch.current = branch;
		// the compact mode keeps every restored row printed, so an inflated
		// unboundComponents count still shows up as an empty rebuild here
		const booted = await bootForRebuild("compact", harness);
		// Stock renderInitialMessages swap: clear + re-add reconstructed cards.
		booted.transcript.clear();
		const bash = addToolComponent(
			booted,
			"bash",
			{ command: "printf ready" },
			"bash-1",
		);
		bash.updateResult(
			{ content: [{ type: "text", text: "ready" }], details: {} },
			false,
			"bash-1",
		);
		// Full-card internal-URL read (stock shape — not a ReadToolGroup).
		const skill = addToolComponent(
			booted,
			"read",
			{ path: "skill://writing-skills" },
			"skill-1",
		);
		skill.updateResult(
			{ content: [{ type: "text", text: "skill body" }], details: {} },
			false,
			"skill-1",
		);
		const ContainerBase = Object.getPrototypeOf(
			booted.host.ReadToolGroupComponent.prototype,
		).constructor as BootedPlugin["ContainerBase"];
		const reply = new ContainerBase();
		reply.addChild({ render: () => ["done"] });
		booted.transcript.addChild(reply);
		await Promise.resolve();
		await Promise.resolve();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("bash: printf ready");
		expect(rows).toContain("done");
		// Skill card may compact as a read row or stay native full-card;
		// the critical contract is sibling tools stay compact, not native boxes.
		expect(rows).not.toMatch(/[╭╰]/);
		await shutdown(booted);
	},
);

stockTest(
	"Tern: a write card rebuilt by clear refuses late diagnostics before settlement",
	async () => {
		// Stock routes late diagnostics into write/edit cards only while a TSP
		// terminal renders (`isNativeRendering`); the module is the host's own.
		const tuiRoot = resolve(
			dirname(process.env.OMP_STOCK_BIN ?? ""),
			"..",
			"@oh-my-pi",
			"pi-tui",
		);
		const nativeState = (await import(
			pathToFileURL(join(tuiRoot, "src/native/state.ts")).href
		)) as { setNativeRendering(on: boolean): void };
		const booted = await bootForRebuild("compact");
		nativeState.setNativeRendering(true);
		try {
			// The rebuild: clear, re-add the card, route its diagnostics, all
			// synchronously before the settlement microtask reinstalls the fold.
			booted.transcript.clear();
			const write = addToolComponent(
				booted,
				"write",
				{ path: "a.ts", content: "x" },
				"write-1",
			);
			write.updateResult(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				false,
				"write-1",
			);
			const diagnosed: { attachLateDiagnostics(files: unknown): boolean } =
				write as unknown as typeof diagnosed;
			const files = [
				{ path: "a.ts", summary: "1 error", errored: true, messages: ["boom"] },
			];
			expect(diagnosed.attachLateDiagnostics(files)).toBe(false);
			await flushMicrotasks();
			expect(diagnosed.attachLateDiagnostics(files)).toBe(false);
			await shutdown(booted);
			// Once the plugin is gone the stock card takes them again.
			expect(diagnosed.attachLateDiagnostics(files)).toBe(true);
		} finally {
			nativeState.setNativeRendering(false);
		}
	},
);
