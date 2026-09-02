import { afterAll, expect } from "bun:test";
import {
	addAnswer,
	addTool,
	addToolComponent,
	beginRun,
	bootWithTranscript,
	cleanupGeneratedDirs,
	dispatch,
	fakeTool,
	finishRun,
	finishTool,
	shutdown,
	stockTest,
	toolUi,
	visibleRows,
} from "./integration-harness";

afterAll(cleanupGeneratedDirs);

stockTest(
	"concurrent bash tools compact instead of framed Output/Wall cards",
	async () => {
		// Stock awaits extension tool_execution_start then fans the UI
		// subscriber without awaiting it, so concurrent bash starts often
		// allocate several states before any ToolExecutionComponent is
		// added. The live order fallback must pair equal-cardinality starts
		// so the framed `$ …` / Output / ⟦Wall…⟧ chrome never pins.
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const cmdA =
			'rm -f "glass.css" && git add glass.css && git commit -m "fix: transparent glass"';
		const cmdB = "python3 - <<'PY'\nprint(1)\nPY";
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "bash-conc-a",
			toolName: "bash",
			args: { command: cmdA },
		});
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "bash-conc-b",
			toolName: "bash",
			args: { command: cmdB },
		});
		// No updateArgs after addChild — same as the stock create-at-start path
		// where setArgsComplete/setExpanded run before addChild and the id is
		// never observed until updateResult.
		const toolA = addToolComponent(
			booted,
			"bash",
			{ command: cmdA },
			"bash-conc-a",
		);
		const toolB = addToolComponent(
			booted,
			"bash",
			{ command: cmdB },
			"bash-conc-b",
		);
		const working = visibleRows(booted.transcript).join("\n");
		expect(working).toContain("bash:");
		expect(working).toContain("git commit");
		expect(working).toContain("python3");
		expect(working).not.toContain("╭");
		expect(working).not.toContain("Output");
		expect(working).not.toContain("Wall:");
		await finishTool(booted, toolA, {
			toolCallId: "bash-conc-a",
			toolName: "bash",
			result: {
				content: [
					{
						type: "text",
						text: "[main bb3cef1] fix: transparent glass\n",
					},
				],
				details: { wallTimeMs: 230, timeoutSeconds: 300, exitCode: 0 },
			},
			isError: false,
		});
		await finishTool(booted, toolB, {
			toolCallId: "bash-conc-b",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "1\n" }],
				details: { wallTimeMs: 110, timeoutSeconds: 300, exitCode: 0 },
			},
			isError: false,
		});
		const done = visibleRows(booted.transcript).join("\n");
		expect(done).toContain("• bash:");
		expect(done).toContain("0.2s");
		expect(done).toContain("0.1s");
		expect(done).not.toContain("╭");
		expect(done).not.toContain("├─── Output");
		expect(done).not.toContain("⟦Wall:");
		expect(done).not.toContain("Timeout:");
		await shutdown(booted);
	},
);

stockTest(
	"pending spinner advances, idles when settled, and restarts on the next tool",
	async () => {
		const booted = await bootWithTranscript();
		// Install with nothing pending must not arm a forever-idle timer.
		expect(booted.intervalCallbacks).toHaveLength(0);
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf spinner" },
			"bash-spinner",
		);
		expect(booted.intervalCallbacks).toHaveLength(1);
		const firstTimer = booted.intervalCallbacks[0];
		const beforeTick = visibleRows(booted.transcript);
		firstTimer?.();
		const afterTick = visibleRows(booted.transcript);
		expect(afterTick).not.toEqual(beforeTick);
		await finishTool(booted, call, {
			toolCallId: "bash-spinner",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "spinner" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		// Last qualifying pending state gone → idle tick clears the interval.
		const settled = visibleRows(booted.transcript);
		firstTimer?.();
		expect(visibleRows(booted.transcript)).toEqual(settled);
		expect(booted.clearedTimers).toEqual([firstTimer]);
		// A newly started tool must re-arm the spinner (no frozen Working…).
		await addTool(
			booted,
			"bash",
			{ command: "printf again" },
			"bash-spinner-2",
		);
		expect(booted.intervalCallbacks).toHaveLength(2);
		const secondTimer = booted.intervalCallbacks[1];
		const beforeRestart = visibleRows(booted.transcript).join("\n");
		expect(beforeRestart).toContain("Working…");
		secondTimer?.();
		const afterRestart = visibleRows(booted.transcript).join("\n");
		expect(afterRestart).toContain("Working…");
		expect(afterRestart).not.toEqual(beforeRestart);
		await shutdown(booted);
		expect(booted.clearedTimers).toContain(secondTimer);
	},
);

stockTest(
	"spinner timer clears after a terminal run and restarts for the next",
	async () => {
		const booted = await bootWithTranscript();
		expect(booted.intervalCallbacks).toHaveLength(0);
		// run 1: a routine tool settles, then a terminal answer filters it
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"bash-run1",
		);
		expect(booted.intervalCallbacks).toHaveLength(1);
		const firstTimer = booted.intervalCallbacks[0];
		await finishTool(booted, first, {
			toolCallId: "bash-run1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		// Idle tick after settle clears the interval before the next run.
		firstTimer?.();
		expect(booted.clearedTimers).toEqual([firstTimer]);
		addAnswer(booted, "first done");
		await finishRun(booted, "first done");
		// run 2: a fresh tool restarts the spinner
		await dispatch(booted, { type: "agent_start" });
		await addTool(booted, "bash", { command: "printf second" }, "bash-run2");
		expect(booted.intervalCallbacks).toHaveLength(2);
		const secondTimer = booted.intervalCallbacks[1];
		const beforeTick = visibleRows(booted.transcript).join("\n");
		expect(beforeTick).toContain("Working…");
		expect(beforeTick).toContain("printf second");
		secondTimer?.();
		const afterTick = visibleRows(booted.transcript).join("\n");
		expect(afterTick).toContain("Working…");
		expect(afterTick).not.toEqual(beforeTick);
		await shutdown(booted);
		expect(booted.clearedTimers).toContain(secondTimer);
	},
);

stockTest(
	"ask stays native while the four visual tools render compact",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const ask = await addTool(
			booted,
			"ask",
			{ question: "continue?" },
			"interactive-ask",
		);
		ask.render = () => ["native-ask"];
		await addTool(
			booted,
			"browser",
			{ action: "open", url: "https://example.test" },
			"interactive-browser",
		);
		await addTool(
			booted,
			"computer",
			{ i: "click Save" },
			"interactive-computer",
		);
		await addTool(
			booted,
			"resolve",
			{ path: "xd://resolve", content: "applying staged edit" },
			"interactive-resolve",
		);
		await addTool(
			booted,
			"reject",
			{ path: "xd://reject", content: "rejected preview" },
			"interactive-reject",
		);
		await addTool(
			booted,
			"task",
			{ description: "subagent work" },
			"interactive-task",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("native-ask");
		expect(live).toContain("browser: https://example.test");
		expect(live).toContain("computer use: click Save");
		expect(live).toContain("resolve: applying staged edit");
		expect(live).toContain("reject: rejected preview");
		expect(live).toContain("task: description: subagent work");
		for (const toolName of ["browser", "computer", "resolve", "reject", "task"])
			expect(live).not.toContain(`native-${toolName}`);

		// Terminal answer (filtered): native-live must survive the settle —
		// previously filtered+no-mutations hid ask, and full forced tool-rows.
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const filtered = visibleRows(booted.transcript).join("\n");
		expect(filtered).toContain("native-ask");
		for (const toolName of ["browser", "computer", "resolve", "reject", "task"])
			expect(filtered).not.toContain(`native-${toolName}`);

		// Abort/error terminal (full): same native contract, fresh ask.
		await beginRun(booted);
		const askAbort = await addTool(
			booted,
			"ask",
			{ question: "retry?" },
			"interactive-ask-abort",
		);
		askAbort.render = () => ["native-ask-abort"];
		await finishRun(booted, "", "aborted");
		const aborted = visibleRows(booted.transcript).join("\n");
		expect(aborted).toContain("native-ask");
		expect(aborted).toContain("native-ask-abort");
		expect(aborted).not.toContain("ask: question:");
		await shutdown(booted);
	},
);

stockTest(
	"live hub renders compact and expanded hub stays native",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"hub",
			{ action: "inspect" },
			"hub-live",
		);
		call.render = () => ["native-hub"];
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("hub");
		expect(live).not.toContain("native-hub");
		call.setExpanded(true);
		const expanded = visibleRows(booted.transcript).join("\n");
		expect(expanded).toContain("native-hub");
		call.setExpanded(false);
		const collapsed = visibleRows(booted.transcript).join("\n");
		expect(collapsed).toContain("hub");
		expect(collapsed).not.toContain("native-hub");
		await shutdown(booted);
	},
);

stockTest("ambiguous anonymous tool components remain native", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	await dispatch(booted, {
		type: "message_update",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "ambiguous-a",
					name: "bash",
					arguments: { command: "echo ambiguous-a" },
				},
				{
					type: "toolCall",
					id: "ambiguous-b",
					name: "bash",
					arguments: { command: "echo ambiguous-b" },
				},
			],
		},
	});
	const first = new booted.host.ToolExecutionComponent(
		"bash",
		{ command: "echo ambiguous-a" },
		{ showImages: false, useBuiltInRenderer: true },
		fakeTool("bash"),
		toolUi(),
		booted.context.cwd,
		undefined,
	);
	const second = new booted.host.ToolExecutionComponent(
		"bash",
		{ command: "echo ambiguous-b" },
		{ showImages: false, useBuiltInRenderer: true },
		fakeTool("bash"),
		toolUi(),
		booted.context.cwd,
		undefined,
	);
	booted.transcript.addChild(first);
	booted.transcript.addChild(second);
	const live = visibleRows(booted.transcript).join("\n");
	expect(live).toContain("echo ambiguous-a");
	expect(live).toContain("echo ambiguous-b");
	addAnswer(booted, "done");
	await finishRun(booted, "done");
	const completed = visibleRows(booted.transcript).join("\n");
	expect(completed).toContain("echo ambiguous-a");
	expect(completed).toContain("echo ambiguous-b");
	await shutdown(booted);
});

stockTest(
	"streaming write/edit collapse to compact before tool_execution_start",
	async () => {
		// Stock paints ToolExecutionComponent cards from message_update while
		// args stream, and only emits tool_execution_start once args are final.
		// Mutation tools must collapse to the compact Working… row as soon as
		// the stream exposes a path — not stay on the native framed card until
		// the tool finishes.
		const booted = await bootWithTranscript();
		await beginRun(booted);

		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "stream-write-1",
						name: "write",
						arguments: {
							path: "src/stream-write.ts",
							content: "export const n = 1;\n",
						},
					},
				],
			},
		});
		const writeCall = new booted.host.ToolExecutionComponent(
			"write",
			{ path: "src/stream-write.ts", content: "export const n = 1;\n" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("write"),
			toolUi(),
			booted.context.cwd,
			"stream-write-1",
		);
		writeCall.render = () => [
			"native-write src/stream-write.ts",
			"export const n = 1;",
		];
		booted.transcript.addChild(writeCall);
		writeCall.updateArgs(
			{ path: "src/stream-write.ts", content: "export const n = 1;\n" },
			"stream-write-1",
		);

		const writeLive = visibleRows(booted.transcript).join("\n");
		expect(writeLive).toContain("write: src/stream-write.ts");
		expect(writeLive).toContain("Working…");
		expect(writeLive).not.toContain("native-write");
		expect(writeLive).not.toContain("export const n = 1");

		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "stream-write-1",
						name: "write",
						arguments: {
							path: "src/stream-write.ts",
							content: "export const n = 1;\n",
						},
					},
					{
						type: "toolCall",
						id: "stream-edit-1",
						name: "edit",
						arguments: {
							path: "src/stream-edit.ts",
							oldText: "a",
							newText: "b",
						},
					},
				],
			},
		});
		const editCall = new booted.host.ToolExecutionComponent(
			"edit",
			{ path: "src/stream-edit.ts", oldText: "a", newText: "b" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("edit"),
			toolUi(),
			booted.context.cwd,
			"stream-edit-1",
		);
		editCall.render = () => ["native-edit src/stream-edit.ts", "-a", "+b"];
		booted.transcript.addChild(editCall);
		editCall.updateArgs(
			{ path: "src/stream-edit.ts", oldText: "a", newText: "b" },
			"stream-edit-1",
		);

		const bothLive = visibleRows(booted.transcript).join("\n");
		expect(bothLive).toContain("write: src/stream-write.ts");
		expect(bothLive).toContain("edit: src/stream-edit.ts");
		expect(bothLive).toContain("Working…");
		expect(bothLive).not.toContain("native-write");
		expect(bothLive).not.toContain("native-edit");

		// Global tools-expanded (Ctrl+O) must not keep the streaming mutation
		// card native either — the compact Working… identity is enough.
		writeCall.setExpanded(true);
		editCall.setExpanded(true);
		const expandedLive = visibleRows(booted.transcript).join("\n");
		expect(expandedLive).toContain("write: src/stream-write.ts");
		expect(expandedLive).toContain("edit: src/stream-edit.ts");
		expect(expandedLive).not.toContain("native-write");
		expect(expandedLive).not.toContain("native-edit");

		await shutdown(booted);
	},
);

stockTest(
	"streaming hub Launch cards and concurrent tools compact before tool_execution_start",
	async () => {
		// Stock paints ToolExecutionComponent cards from message_update long
		// before tool_execution_start. Hub launch-style ops use the framed
		// 🚀 Launch chrome (logs = full Output block); concurrent bash in the
		// same stream paints $ … / Output / Wall. UI subscribers create those
		// cards synchronously, then the extension message_update is queued —
		// compact must bind and collapse both surfaces on that extension
		// delivery, not wait for tool_execution_start (which can be seconds
		// later for ready-gated start / follow logs).
		const booted = await bootWithTranscript();
		await beginRun(booted);

		const launchArgs = {
			op: "logs",
			name: "web",
			follow: true,
		};
		const bashArgs = { command: "curl -s localhost:5173" };

		// Production order: UI cards first, then extension message_update.
		const hubCall = addToolComponent(
			booted,
			"hub",
			launchArgs,
			"stream-hub-launch-1",
		);
		const bashCall = addToolComponent(
			booted,
			"bash",
			bashArgs,
			"stream-bash-with-launch-1",
		);

		// Sanity: unbound stock surfaces still show native Launch / bash chrome.
		const nativeBefore = visibleRows(booted.transcript).join("\n");
		expect(nativeBefore).toContain("Launch");
		expect(nativeBefore).toMatch(/╭|\$/);

		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "stream-hub-launch-1",
						name: "hub",
						arguments: launchArgs,
					},
					{
						type: "toolCall",
						id: "stream-bash-with-launch-1",
						name: "bash",
						arguments: bashArgs,
					},
				],
			},
		});
		// Stock's coalesced UI flush calls updateArgs(id) on existing cards
		// after the extension message_update early-allocates stream previews.
		hubCall.updateArgs(launchArgs, "stream-hub-launch-1");
		bashCall.updateArgs(bashArgs, "stream-bash-with-launch-1");

		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("Working…");
		// Launch-style hub describe: "launch: logs web" (not bare generic hub).
		expect(live).toMatch(/launch:\s*logs\s+web/);
		expect(live).toContain("bash:");
		expect(live).toContain("curl -s localhost:5173");
		expect(live).not.toContain("Launch");
		expect(live).not.toContain("╭");
		expect(live).not.toContain("Output");
		expect(live).not.toContain("Wall");

		// Settled Launch logs must stay one compact row, not the framed Output
		// block stock uses for op==="logs".
		await finishTool(booted, hubCall, {
			toolCallId: "stream-hub-launch-1",
			toolName: "hub",
			result: {
				content: [
					{
						type: "text",
						text: "ready on :5173\nGET / 200\n[web: running; cursor=12]",
					},
				],
				details: { op: "logs", state: "running", cursor: 12 },
			},
			isError: false,
		});
		await finishTool(booted, bashCall, {
			toolCallId: "stream-bash-with-launch-1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "ok\n" }],
				details: { wallTimeMs: 40, timeoutSeconds: 300, exitCode: 0 },
			},
			isError: false,
		});
		const done = visibleRows(booted.transcript).join("\n");
		expect(done).toMatch(/launch:\s*logs\s+web/);
		expect(done).toContain("• bash:");
		expect(done).not.toContain("Launch");
		expect(done).not.toContain("╭");
		expect(done).not.toContain("├─── Output");
		expect(done).not.toContain("ready on :5173");

		await shutdown(booted);
	},
);

stockTest(
	"streaming hub Launch start alone compacts before tool_execution_start",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const launchArgs = {
			op: "start",
			name: "web",
			application: "bun",
			args: ["run", "dev"],
			ready: { port: 5173 },
		};
		const hubCall = addToolComponent(
			booted,
			"hub",
			launchArgs,
			"stream-hub-start-1",
		);
		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "stream-hub-start-1",
						name: "hub",
						arguments: launchArgs,
					},
				],
			},
		});
		hubCall.updateArgs(launchArgs, "stream-hub-start-1");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("Working…");
		expect(live).toMatch(/launch:\s*start\s+web/);
		expect(live).not.toContain("Launch");
		expect(live).not.toContain("╭");
		await shutdown(booted);
	},
);

stockTest(
	"streaming bash alone compacts when message_update arrives before the card",
	async () => {
		// Stock coalesces message_update for the UI (~33ms) while the extension
		// queue may run first with no ToolExecutionComponent yet. Compact must
		// still early-allocate a stream preview, bind when the card lands, and
		// keep the settled row compact (no framed $ / Output / Wall chrome).
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const bashArgs = {
			command: "cd /tmp/openbot && docker compose build 2>&1 | tail -40",
		};

		// Extension message_update first — no unbound card (real stock order).
		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "stream-bash-before-card",
						name: "bash",
						arguments: bashArgs,
					},
				],
			},
		});
		// UI card lands after the extension delta (coalesced flush). Stock then
		// delivers updateArgs(id) on later deltas / tool_execution_start.
		const bashCall = addToolComponent(
			booted,
			"bash",
			bashArgs,
			"stream-bash-before-card",
		);
		bashCall.updateArgs(bashArgs, "stream-bash-before-card");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("Working…");
		expect(live).toContain("bash:");
		expect(live).toContain("docker compose build");
		expect(live).not.toContain("╭");
		expect(live).not.toContain("Output");
		expect(live).not.toContain("Wall");

		await finishTool(booted, bashCall, {
			toolCallId: "stream-bash-before-card",
			toolName: "bash",
			result: {
				content: [
					{
						type: "text",
						text: "Image openbot-migrate Built\n",
					},
				],
				details: {
					wallTimeMs: 286_490,
					timeoutSeconds: 600,
					exitCode: 0,
				},
			},
			isError: false,
		});
		const done = visibleRows(booted.transcript).join("\n");
		expect(done).toContain("• bash:");
		expect(done).toMatch(/\b286s\b/);
		expect(done).not.toContain("╭");
		expect(done).not.toContain("├─── Output");
		expect(done).not.toContain("⟦Wall:");
		expect(done).not.toContain("Image openbot-migrate Built");

		await shutdown(booted);
	},
);

stockTest(
	"a late message_update of the previous run never pollutes the next run after agent_start",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const first = await addTool(
			booted,
			"bash",
			{ command: "printf first" },
			"late-first",
		);
		await finishTool(booted, first, {
			toolCallId: "late-first",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		addAnswer(booted, "first done");
		await finishRun(booted, "first done");
		// Stock queues message_update events behind earlier stream deltas
		// while agent_end/agent_start are delivered directly, so a delta
		// emitted for the settled run can be handled AFTER the next run's
		// agent_start. It must never allocate a state/entry into the next
		// run's ledger.
		await beginRun(booted);
		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "stale-late",
						name: "bash",
						arguments: { command: "echo stale-late" },
					},
				],
			},
		});
		// The next run's genuine tool still binds compactly (an allocated
		// stale state would block the single-pair order binding and fall
		// back to the native surface).
		const second = await addTool(
			booted,
			"bash",
			{ command: "printf second" },
			"late-second",
		);
		second.render = () => ["native-late-second"];
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("printf second");
		expect(live).not.toContain("native-late-second");
		expect(live).not.toContain("echo stale-late");
		await finishTool(booted, second, {
			toolCallId: "late-second",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		addAnswer(booted, "second done");
		await finishRun(booted, "second done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("echo stale-late");
		await shutdown(booted);
	},
);

stockTest(
	"unknown tool components fail open to the native renderer in every phase",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"future_tool",
			{ query: "registry routing" },
			"unknown-1",
		);
		call.render = () => ["native-future-tool"];
		// working: the unregistered tool keeps its native surface; no generic
		// compact row is synthesized for it
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("native-future-tool");
		expect(live).not.toContain("query: registry routing");
		await finishTool(booted, call, {
			toolCallId: "unknown-1",
			toolName: "future_tool",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		const settled = visibleRows(booted.transcript).join("\n");
		expect(settled).toContain("native-future-tool");
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		// the terminal filter hides routine rows but must never hide or
		// rewrite an unknown tool's native rows
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("native-future-tool");
		expect(completed).not.toContain("query: registry routing");
		await shutdown(booted);
	},
);

stockTest(
	"unknown tool components stay native in the full abort log",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"vendor_canvas",
			{ action: "inspect" },
			"unknown-abort",
		);
		call.render = () => ["native-vendor-canvas"];
		await finishTool(booted, call, {
			toolCallId: "unknown-abort",
			toolName: "vendor_canvas",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		await finishRun(booted, "", "aborted");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("native-vendor-canvas");
		expect(rows).not.toContain("action: inspect");
		await shutdown(booted);
	},
);

stockTest(
	"unknown and routine tools keep independent projections in one run",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const routine = await addTool(
			booted,
			"bash",
			{ command: "printf routine-row" },
			"mixed-routine",
		);
		routine.render = () => ["native-routine"];
		const unknown = await addTool(
			booted,
			"future_tool",
			{ query: "mixed run" },
			"mixed-unknown",
		);
		unknown.render = () => ["native-unknown"];
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("printf routine-row");
		expect(live).not.toContain("native-routine");
		expect(live).toContain("native-unknown");
		await finishTool(booted, routine, {
			toolCallId: "mixed-routine",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		await finishTool(booted, unknown, {
			toolCallId: "mixed-unknown",
			toolName: "future_tool",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		addAnswer(booted, "mixed done");
		await finishRun(booted, "mixed done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("mixed done");
		expect(completed).not.toContain("printf routine-row");
		expect(completed).not.toContain("native-routine");
		expect(completed).toContain("native-unknown");
		await shutdown(booted);
	},
);

stockTest(
	"streamed full-card read beside bash keeps both rows compact",
	async () => {
		// Production sequence traced from OMP 18.1.2 for one assistant
		// message holding `read skill://…` + `bash`: stock creates the read
		// card first, then streams args into it carrying the read id, then
		// creates the bash card, and only afterwards fans both
		// tool_execution_start events. Skipping stream allocation for every
		// read left the read card without a state while the bash preview
		// state existed, so equal-cardinality order pairing crossed the two
		// (read card ← bash state) and the next id-carrying updateArgs
		// reported ambiguous ownership, quarantining both cards to native
		// framed chrome for the whole run.
		const readPath = "skill://keep-the-why-distilled";
		const command = "printenv HOME";
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const readCard = addToolComponent(
			booted,
			"read",
			{ path: readPath },
			"stream-read",
		);
		await dispatch(booted, {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "stream-read",
						name: "read",
						arguments: { path: readPath },
					},
					{
						type: "toolCall",
						id: "stream-bash",
						name: "bash",
						arguments: { command },
					},
				],
			},
		});
		readCard.updateArgs({ path: readPath }, "stream-read");
		const bashCard = addToolComponent(
			booted,
			"bash",
			{ command },
			"stream-bash",
		);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "stream-read",
			toolName: "read",
			args: { path: readPath },
		});
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "stream-bash",
			toolName: "bash",
			args: { command },
		});
		readCard.updateArgs({ path: readPath }, "stream-read");
		bashCard.updateArgs({ command }, "stream-bash");
		const working = visibleRows(booted.transcript).join("\n");
		expect(working).toContain(readPath);
		expect(working).toContain("bash:");
		expect(working).toContain(command);
		expect(working).not.toContain("╭");
		await finishTool(booted, readCard, {
			toolCallId: "stream-read",
			toolName: "read",
			result: {
				content: [{ type: "text", text: "name: keep-the-why-distilled\n" }],
				details: {},
			},
			isError: false,
		});
		await finishTool(booted, bashCard, {
			toolCallId: "stream-bash",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "/Users/admin\n" }],
				details: { wallTimeMs: 80, timeoutSeconds: 300, exitCode: 0 },
			},
			isError: false,
		});
		const done = visibleRows(booted.transcript).join("\n");
		expect(done).toContain(`read ${readPath}`);
		expect(done).toContain(`bash: ${command}`);
		expect(done).not.toContain("╭");
		expect(done).not.toContain("├─── Output");
		expect(done).not.toContain("⟦Wall:");
		await shutdown(booted);
	},
);
