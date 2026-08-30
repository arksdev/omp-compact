import { afterAll, expect } from "bun:test";
import { KEY_SPACE } from "../../.omp-plugin/settings-ui";
import {
	addAnswer,
	addTool,
	beginRun,
	bootPlugin,
	bootWithTranscript,
	cleanupGeneratedDirs,
	dispatch,
	fakeTool,
	finishRun,
	finishTool,
	saveSettingsViaDialog,
	shutdown,
	stockTest,
	toolUi,
	visibleRows,
} from "./integration-harness";
import type {
	ToolExecutionInstance,
	TranscriptInstance,
} from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

stockTest(
	"multiple transcript candidates disable the adapter transactionally",
	async () => {
		let first: TranscriptInstance | undefined;
		let second: TranscriptInstance | undefined;
		const booted = await bootPlugin((root, host) => {
			first = new host.TranscriptContainer();
			second = new host.TranscriptContainer();
			root.addChild(first);
			root.addChild(second);
		});
		expect(booted.notifications[0]).toContain("multiple transcript containers");
		expect(first && Object.hasOwn(first, "addChild")).toBe(false);
		expect(second && Object.hasOwn(second, "addChild")).toBe(false);
		await shutdown(booted);
	},
);

stockTest(
	"transcript host patch failure rolls back transactionally",
	async () => {
		let transcript: TranscriptInstance | undefined;
		const booted = await bootPlugin((root, host) => {
			const candidate = new host.TranscriptContainer();
			// `peekFinalizedBatch` is the last transcript method the fold
			// patches, so freezing it fails the install after earlier wrappers
			// are already in place — exactly the transactional case.
			Object.defineProperty(candidate, "peekFinalizedBatch", {
				value: candidate.peekFinalizedBatch,
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
		// wrappers applied before the failing method are gone
		expect(Object.hasOwn(transcript, "render")).toBe(false);
		expect(Object.hasOwn(transcript, "renderViewport")).toBe(false);
		expect(Object.hasOwn(transcript, "liveRowCount")).toBe(false);
		expect(Object.hasOwn(transcript, "addChild")).toBe(false);
		expect(transcript.render).toBe(Object.getPrototypeOf(transcript).render);
		expect(transcript.renderViewport).toBe(
			Object.getPrototypeOf(transcript).renderViewport,
		);
		// the incompatible own property keeps its exact descriptor
		expect(Object.hasOwn(transcript, "peekFinalizedBatch")).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(transcript, "peekFinalizedBatch")
				?.configurable,
		).toBe(false);
		// native rendering still executes and the spinner never started
		expect(() => resolvedTranscript.render(120)).not.toThrow();
		expect(booted.intervalCallbacks).toHaveLength(0);
		await shutdown(booted);
		expect(booted.notifications).toHaveLength(1);
	},
);

stockTest(
	"mid-patch tool component failure rolls back every wrapper",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "incompatible-tool",
			toolName: "bash",
			args: { command: "printf native" },
		});
		const component = new booted.host.ToolExecutionComponent(
			"bash",
			{ command: "printf native" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			booted.context.cwd,
			"incompatible-tool",
		);
		const nativeUpdateArgs = component.updateArgs;
		Object.defineProperty(component, "setArgsComplete", {
			value: component.setArgsComplete,
			configurable: false,
			writable: true,
		});
		const frozenComplete = component.setArgsComplete;
		const marker = { keep: true };
		(component as ToolExecutionInstance & { marker?: object }).marker = marker;
		booted.transcript.addChild(component);
		// a single warning and full adapter rollback
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		// wrappers applied before the failing method are gone
		expect(Object.hasOwn(component, "updateArgs")).toBe(false);
		expect(Object.hasOwn(component, "updateResult")).toBe(false);
		expect(component.updateArgs).toBe(nativeUpdateArgs);
		// the incompatible own property keeps its exact descriptor
		expect(component.setArgsComplete).toBe(frozenComplete);
		expect(
			Object.getOwnPropertyDescriptor(component, "setArgsComplete"),
		).toEqual({
			value: frozenComplete,
			writable: true,
			enumerable: false,
			configurable: false,
		});
		// unrelated own properties and prototype methods are untouched
		expect(
			(component as ToolExecutionInstance & { marker?: object }).marker,
		).toBe(marker);
		// native methods still execute and the transcript renders natively
		component.updateArgs({ command: "printf native" }, "incompatible-tool");
		expect(
			component
				.render(120)
				.map((line) => Bun.stripANSI(line))
				.join("\n"),
		).toContain("printf native");
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"printf native",
		);
		// the adapter stays disabled for the rest of the session
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "after-rollback",
			toolName: "bash",
			args: { command: "printf second" },
		});
		const second = new booted.host.ToolExecutionComponent(
			"bash",
			{ command: "printf second" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			booted.context.cwd,
			"after-rollback",
		);
		booted.transcript.addChild(second);
		expect(booted.notifications).toHaveLength(1);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"printf second",
		);
		await shutdown(booted);
	},
);

stockTest("mid-patch read group failure rolls back every wrapper", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "read-incompatible",
		toolName: "read",
		args: { path: "src/a.ts" },
	});
	const group = new booted.host.ReadToolGroupComponent();
	const nativeUpdateArgs = group.updateArgs;
	Object.defineProperty(group, "updateResult", {
		value: group.updateResult,
		configurable: false,
		writable: true,
	});
	const frozenResult = group.updateResult;
	booted.transcript.addChild(group);
	// a single warning and full adapter rollback
	expect(booted.notifications).toHaveLength(1);
	expect(booted.notifications[0]).toContain("omp-compact disabled");
	// the wrapper applied before the failing method is gone
	expect(Object.hasOwn(group, "updateArgs")).toBe(false);
	expect(group.updateArgs).toBe(nativeUpdateArgs);
	// the incompatible own property keeps its exact descriptor
	expect(group.updateResult).toBe(frozenResult);
	// native methods still execute and the group renders natively
	group.updateArgs({ path: "src/b.ts" }, "read-incompatible");
	expect(visibleRows(booted.transcript).join("\n")).toContain("src/b.ts");
	await shutdown(booted);
});

stockTest("numbered edit rows survive the terminal answer", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const call = await addTool(
		booted,
		"edit",
		{ input: "numbered" },
		"edit-numbered",
	);
	await finishTool(booted, call, {
		toolCallId: "edit-numbered",
		toolName: "edit",
		result: {
			content: [{ type: "text", text: "edited" }],
			details: {
				path: "src/numbered.ts",
				diff: "-12|old line\n+12|new line\n+13|extra line\n",
			},
		},
		isError: false,
	});
	addAnswer(booted, "numbered edit done");
	await finishRun(booted, "numbered edit done");
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("edit: src/numbered.ts");
	expect(rows).toContain("+2|1");
	expect(booted.sentMessages).toEqual([]);
	expect(booted.appendedEntries).toHaveLength(1);
	expect(booted.appendedEntries[0]).toEqual({
		customType: "omp-compact-write",
		data: {
			version: 1,
			toolCallId: "edit-numbered",
			toolName: "edit",
			path: "src/numbered.ts",
			added: 2,
			removed: 1,
			exact: true,
		},
	});
	await shutdown(booted);
});

stockTest(
	"a late second transcript discovery rolls back and disables until switch",
	async () => {
		const booted = await bootWithTranscript();
		const second = new booted.host.TranscriptContainer();
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(true);
		expect(Object.hasOwn(second, "addChild")).toBe(false);
		booted.transcript.addChild(second);
		// one warning; idle install never armed a spinner timer to clear
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("multiple transcript containers");
		expect(booted.clearedTimers).toEqual([]);
		// every wrapper is gone and native rendering still executes
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		expect(Object.hasOwn(booted.transcript, "render")).toBe(false);
		expect(Object.hasOwn(second, "addChild")).toBe(false);
		expect(() => booted.transcript.render(120)).not.toThrow();
		// the adapter stays disabled for the rest of the session
		await dispatch(booted, { type: "agent_start" });
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "bash-late",
			toolName: "bash",
			args: { command: "printf late" },
		});
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		expect(booted.notifications).toHaveLength(1);
		expect(booted.intervalCallbacks).toHaveLength(0);
		// a switch retries install; the conflict still fails open
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		expect(booted.notifications).toHaveLength(2);
		expect(booted.notifications[1]).toContain("multiple transcript containers");
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		expect(() => booted.transcript.render(120)).not.toThrow();
		await shutdown(booted);
	},
);

stockTest(
	"a failing notifier still completes rollback and native calls",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf hostile" },
			"bash-hostile",
		);
		const hostile = new Proxy(
			{},
			{
				get() {
					throw new Error("hostile result");
				},
			},
		);
		expect(() =>
			call.updateResult(hostile as never, false, "bash-hostile"),
		).toThrow("hostile result");
		// rollback completed despite the notifier failure
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		expect(Object.hasOwn(call, "updateResult")).toBe(false);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		expect(() => booted.transcript.render(120)).not.toThrow();
		// native calls keep working after the wrapper is gone
		call.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"bash-hostile",
		);
		expect(() => call.render(120)).not.toThrow();
		await shutdown(booted);
	},
);

stockTest(
	"switch after a rollback reinstalls once the conflict is gone",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const component = new booted.host.ToolExecutionComponent(
			"bash",
			{ command: "printf native" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			booted.context.cwd,
			"switch-incompatible",
		);
		Object.defineProperty(component, "setExpanded", {
			value: component.setExpanded,
			configurable: false,
			writable: true,
		});
		booted.transcript.addChild(component);
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		// remove the incompatible component, then switch sessions
		booted.transcript.children.length = 0;
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		// the adapter reinstalls cleanly and no second warning appears
		expect(booted.notifications).toHaveLength(1);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(true);
		await shutdown(booted);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
	},
);

stockTest(
	"mid-session rollback stays session-terminal even after the host heals",
	async () => {
		// Host-invariant #rollback must clear index's live handle and set
		// adapterDisabled. Without that, ensureAdapter would keep returning
		// the disposed zombie; with a naive reinstall policy it would also
		// spin on a permanent host fault. Session-terminal disable is the
		// only option that cannot loop: native until a session boundary,
		// even if the conflicting surface is removed mid-session.
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const component = new booted.host.ToolExecutionComponent(
			"bash",
			{ command: "printf native" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			booted.context.cwd,
			"terminal-incompatible",
		);
		Object.defineProperty(component, "setExpanded", {
			value: component.setExpanded,
			configurable: false,
			writable: true,
		});
		booted.transcript.addChild(component);
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		const intervalsAfterRollback = booted.intervalCallbacks.length;
		// Host heals: remove the unpatchable surface. A reinstall policy
		// would re-arm here; session-terminal must stay native.
		booted.transcript.children.length = 0;
		await dispatch(booted, { type: "agent_end", messages: [] });
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "after-heal",
			toolName: "bash",
			args: { command: "printf healed-mid" },
		});
		const healed = new booted.host.ToolExecutionComponent(
			"bash",
			{ command: "printf healed-mid" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			booted.context.cwd,
			"after-heal",
		);
		expect(() => booted.transcript.addChild(healed)).not.toThrow();
		// Still native: no fold wrappers, no second spinner, no second warn.
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		expect(Object.hasOwn(healed, "updateArgs")).toBe(false);
		expect(booted.intervalCallbacks).toHaveLength(intervalsAfterRollback);
		expect(booted.notifications).toHaveLength(1);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"printf healed-mid",
		);
		await shutdown(booted);
	},
);

stockTest(
	"settings disable/re-enable after host-invariant rollback does not reinstall",
	async () => {
		// adapterDisabled is a host-invariant latch, not a user preference.
		// A mid-session settings toggle must not clear it — otherwise
		// disableRuntime() launders the terminal failure into a retry.
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const component = new booted.host.ToolExecutionComponent(
			"bash",
			{ command: "printf native" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			booted.context.cwd,
			"settings-launder-incompatible",
		);
		Object.defineProperty(component, "setExpanded", {
			value: component.setExpanded,
			configurable: false,
			writable: true,
		});
		booted.transcript.addChild(component);
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		const intervalsAfterRollback = booted.intervalCallbacks.length;

		// Host heals and the user flips global compact off then on. The
		// latch must survive both the disabled run boundary and the
		// re-enable boundary.
		booted.transcript.children.length = 0;
		await dispatch(booted, { type: "agent_end", messages: [] });
		await saveSettingsViaDialog(booted, (dialog) => {
			dialog.handleInput(KEY_SPACE);
		});
		await beginRun(booted);
		// Disabled-run teardown: no new spinners, wrappers stay unrestored,
		// settings command remains for a later re-enable.
		expect(booted.intervalCallbacks).toHaveLength(intervalsAfterRollback);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		expect(booted.commands).toContain("compact-settings");
		await finishRun(booted, "disabled");

		await saveSettingsViaDialog(booted, (dialog) => {
			dialog.handleInput(KEY_SPACE);
		});
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "after-settings-toggle",
			toolName: "bash",
			args: { command: "printf still-native" },
		});
		const after = new booted.host.ToolExecutionComponent(
			"bash",
			{ command: "printf still-native" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			booted.context.cwd,
			"after-settings-toggle",
		);
		expect(() => booted.transcript.addChild(after)).not.toThrow();
		// Still session-native: no fold wrappers, no second spinner, no
		// second warn. The settings cycle must not reinstall.
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		expect(Object.hasOwn(after, "updateArgs")).toBe(false);
		expect(booted.intervalCallbacks).toHaveLength(intervalsAfterRollback);
		// Settings-save info lines are unrelated; only the session-terminal
		// disable warn may fire, and only once.
		expect(
			booted.notifications.filter((n) => n.includes("omp-compact disabled")),
		).toHaveLength(1);
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"printf still-native",
		);
		await shutdown(booted);
	},
);

stockTest(
	"session boundary after rollback still clears the host-invariant latch",
	async () => {
		// dispose() owns the adapterDisabled reset. A settings toggle must
		// not clear the latch, but a genuine session boundary must — or the
		// latch becomes permanent and is worse than the launder bug.
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const component = new booted.host.ToolExecutionComponent(
			"bash",
			{ command: "printf native" },
			{ showImages: false, useBuiltInRenderer: true },
			fakeTool("bash"),
			toolUi(),
			booted.context.cwd,
			"dispose-clears-latch",
		);
		Object.defineProperty(component, "setExpanded", {
			value: component.setExpanded,
			configurable: false,
			writable: true,
		});
		booted.transcript.addChild(component);
		expect(booted.notifications).toHaveLength(1);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);

		// Settings disable/re-enable mid-session (must not clear the latch).
		booted.transcript.children.length = 0;
		await dispatch(booted, { type: "agent_end", messages: [] });
		await saveSettingsViaDialog(booted, (dialog) => {
			dialog.handleInput(KEY_SPACE);
		});
		await beginRun(booted);
		await finishRun(booted, "disabled");
		await saveSettingsViaDialog(booted, (dialog) => {
			dialog.handleInput(KEY_SPACE);
		});
		await beginRun(booted);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);

		// Genuine session boundary: dispose via switch, then a fresh start
		// with the conflict gone must reinstall.
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		// No second disable warn on reinstall after a real session boundary.
		expect(
			booted.notifications.filter((n) => n.includes("omp-compact disabled")),
		).toHaveLength(1);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(true);

		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf after-dispose" },
			"after-dispose",
		);
		await finishTool(booted, call, {
			toolCallId: "after-dispose",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf after-dispose",
		);
		expect(Object.hasOwn(call, "updateArgs")).toBe(true);
		await shutdown(booted);
	},
);

stockTest(
	"settings disable/re-enable without prior rollback still installs",
	async () => {
		// Common path: a user toggles global compact off then on mid-session
		// with a healthy host. The latch stays false, so the next enabled
		// run boundary reinstalls exactly as before.
		const booted = await bootWithTranscript();
		await beginRun(booted);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(true);
		// Arm real spinner work so disabled-run teardown has something to
		// clear (install alone does not start the idle timer).
		const liveCall = await addTool(
			booted,
			"bash",
			{ command: "printf live-before-toggle" },
			"live-before-toggle",
		);
		const intervalsWhileLive = booted.intervalCallbacks.length;
		expect(intervalsWhileLive).toBeGreaterThan(0);
		await finishTool(booted, liveCall, {
			toolCallId: "live-before-toggle",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		await finishRun(booted, "before-toggle");

		await saveSettingsViaDialog(booted, (dialog) => {
			dialog.handleInput(KEY_SPACE);
		});
		const clearedBeforeDisabledRun = booted.clearedTimers.length;
		await beginRun(booted);
		// Disabled-run teardown: wrappers restored, prior spinner cleared,
		// no new timer, settings command still alive for a clean re-enable.
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		expect(booted.intervalCallbacks).toHaveLength(intervalsWhileLive);
		expect(booted.clearedTimers.length).toBeGreaterThanOrEqual(
			clearedBeforeDisabledRun,
		);
		expect(booted.commands).toContain("compact-settings");
		await finishRun(booted, "off");

		await saveSettingsViaDialog(booted, (dialog) => {
			dialog.handleInput(KEY_SPACE);
		});
		await beginRun(booted);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(true);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf toggled-back" },
			"toggled-back",
		);
		await finishTool(booted, call, {
			toolCallId: "toggled-back",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"bash: printf toggled-back",
		);
		expect(Object.hasOwn(call, "updateArgs")).toBe(true);
		expect(booted.intervalCallbacks.length).toBeGreaterThan(intervalsWhileLive);
		await shutdown(booted);
	},
);
