import { beforeAll, describe, expect, test } from "bun:test";

import {
	type CompactSettings,
	type CompactSettingsPatch,
	type CompactSettingsStore,
	DEFAULT_SETTINGS,
} from "../../.omp-plugin/config";
import { loadStockPlugin } from "./test-stock-host";

interface AdapterModule {
	RuntimeAdapter: new (
		options: unknown,
	) => {
		install(): boolean;
		beginRun(): void;
		hydrateBranch(entries: readonly unknown[]): void;
		startTool(input: {
			toolCallId: string;
			toolName: string;
			args: unknown;
		}): void;
		updateTool(input: {
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
		}): void;
		finishTool(input: {
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
		}): void;
		setMutations(toolCallId: string, entries: unknown[]): void;
		setGit(toolCallId: string, git: unknown): void;
		observeAssistantMessage(message: unknown): void;
		captureTerminalRunId(): string | undefined;
		releaseTerminalRun(runId: string | undefined): void;
		endRun(input: {
			messages: readonly unknown[];
			willContinue?: boolean;
		}): string;
		dispose(): void;
	};
	ModePolicy: new (
		store: CompactSettingsStore,
	) => {
		prime(): void;
		ready(): Promise<void>;
		prepareRun(): Promise<{
			mode: string;
			enabled: boolean;
			retainGitLive: boolean;
		}>;
		armRestoreOverride(): void;
		dispose(): void;
		restoreOverride?: {
			mode: string;
			enabled: boolean;
			retainGitLive: boolean;
		};
	};
}

let adapterModule: AdapterModule;
let modePolicyModule: {
	ModePolicy: AdapterModule["ModePolicy"];
};

beforeAll(async () => {
	adapterModule = await loadStockPlugin<AdapterModule>(
		"runtime-adapter.ts",
		"modes-test",
	);
	modePolicyModule = await loadStockPlugin("mode-policy.ts", "modes-test");
});

const ACTIVITY_FRAMES = ["⠦", "⠧", "⠇", "⠏"];
const STATUS_FRAMES = ["⣾", "⣽", "⣻", "⢿"];

function fakeTheme(): unknown {
	return {
		fg: (_color: string, text: string) => `\x1b[38;2;1;1;1m${text}\x1b[39m`,
		bg: (_color: string, text: string) => `\x1b[48;2;2;2;2m${text}\x1b[49m`,
		getFgAnsi: () => "\x1b[38;2;1;1;1m",
		getBgAnsi: () => "\x1b[48;2;2;2;2m",
		spinnerFrames: STATUS_FRAMES,
		getSpinnerFrames: (type: string) =>
			type === "activity" ? ACTIVITY_FRAMES : STATUS_FRAMES,
	};
}

interface ToolComponent {
	render(width: number): readonly string[];
	updateArgs(args: unknown, toolCallId?: string): void;
	updateResult(result: unknown, isPartial: boolean, toolCallId?: string): void;
	setArgsComplete(): void;
	setExpanded(expanded: boolean): void;
	seal(): void;
	setToolActivityVisible(visible: boolean): void;
	readonly nativeRows: string[];
}

function fakeToolComponent(toolName: string): ToolComponent {
	const nativeRows = [`native-${toolName}`];
	return {
		nativeRows,
		render: () => nativeRows,
		updateArgs() {},
		updateResult() {},
		setArgsComplete() {},
		setExpanded() {},
		seal() {},
		setToolActivityVisible() {},
	};
}

interface ReadGroupComponent {
	render(width: number): readonly string[];
	updateArgs(args: Record<string, unknown>, toolCallId?: string): void;
	updateResult(result: unknown, isPartial?: boolean, toolCallId?: string): void;
	removeEntry(id: string): void;
	renameEntry(oldId: string, newId: string): void;
	setExpanded(expanded: boolean): void;
}

function fakeReadGroup(): ReadGroupComponent {
	return {
		render: () => ["native-read-group"],
		updateArgs() {},
		updateResult() {},
		removeEntry() {},
		renameEntry() {},
		setExpanded() {},
	};
}

interface FakeTranscript {
	children: unknown[];
	addChild(child: unknown): void;
	render(width: number): readonly string[];
	renderViewportTail(width: number, maxRows: number): readonly string[];
	isBlockUncommitted(component: unknown): boolean;
	isBlockInLiveRegion(component: unknown): boolean;
}

function fakeTranscript(): FakeTranscript {
	const children: unknown[] = [];
	return {
		children,
		addChild(child: unknown) {
			children.push(child);
		},
		render(width: number) {
			const rows: string[] = [];
			for (const child of children) {
				if (!child || typeof child !== "object") continue;
				const block = child as { render?(w: number): readonly string[] };
				if (typeof block.render === "function")
					rows.push(...block.render(width));
			}
			return rows;
		},
		renderViewportTail() {
			return [];
		},
		isBlockUncommitted() {
			return false;
		},
		isBlockInLiveRegion() {
			return false;
		},
	};
}

function fakeStore(initial?: CompactSettings): CompactSettingsStore & {
	updateRaw(patch: CompactSettingsPatch): Promise<void>;
} {
	let current = initial ?? DEFAULT_SETTINGS;
	const subscribers = new Set<(settings: CompactSettings) => void>();
	const apply = (patch: CompactSettingsPatch): CompactSettings => {
		current = {
			...current,
			...patch,
			stats: { ...current.stats, ...(patch.stats ?? {}) },
			autoShake: { ...current.autoShake, ...(patch.autoShake ?? {}) },
			host: { ...current.host, ...(patch.host ?? {}) },
		} as CompactSettings;
		for (const fn of [...subscribers]) fn(current);
		return current;
	};
	return {
		updateRaw: async (patch) => {
			apply(patch);
		},
		load: async () => current,
		snapshot: () => current,
		update: async (patch) => apply(patch),
		subscribe: (fn) => {
			subscribers.add(fn);
			return () => {
				subscribers.delete(fn);
			};
		},
	};
}

function settings(
	overrides: Partial<
		Pick<CompactSettings, "enabled" | "mode" | "retainGitLive">
	>,
): CompactSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

interface Booted {
	adapter: InstanceType<AdapterModule["RuntimeAdapter"]>;
	transcript: FakeTranscript;
	policy: InstanceType<AdapterModule["ModePolicy"]>;
	store: ReturnType<typeof fakeStore>;
	finalized: string[];
	renders: {
		render: number;
		components: unknown[];
	};
	/** Rollback warnings emitted by the adapter (fail-closed retirement). */
	warned: string[];
}

async function boot(
	overrides: {
		mode?: "compact" | "live" | "clear";
		retainGitLive?: boolean;
		enabled?: boolean;
	} = {},
): Promise<Booted> {
	const store = fakeStore(
		settings({
			mode: overrides.mode ?? "live",
			retainGitLive: overrides.retainGitLive ?? true,
			enabled: overrides.enabled ?? true,
		}),
	);
	const policy = new modePolicyModule.ModePolicy(store);
	policy.prime();
	await policy.prepareRun();
	const finalized: string[] = [];
	const warned: string[] = [];
	const transcript = fakeTranscript();
	const renders = { render: 0, components: [] as unknown[] };
	const adapter = new adapterModule.RuntimeAdapter({
		root: transcript,
		ui: {
			theme: fakeTheme(),
			setWidget() {},
			requestRender() {
				renders.render++;
			},
			requestComponentRender(component: unknown) {
				renders.components.push(component);
			},
			getToolsExpanded: () => false,
		},
		timers: {
			setInterval: () => 1,
			clearTimer: () => {},
		},
		modePolicy: policy,
		onRunFinalized: (runId: string) => finalized.push(runId),
		warn: (message: string) => warned.push(message),
	});
	if (!adapter.install()) throw new Error("adapter install failed");
	return { adapter, transcript, policy, store, finalized, renders, warned };
}

async function beginRun(booted: Booted): Promise<void> {
	await booted.policy.prepareRun();
	booted.adapter.beginRun();
}

function addTool(
	booted: Booted,
	toolName: string,
	toolCallId: string,
	args: unknown,
): ToolComponent {
	booted.adapter.startTool({ toolCallId, toolName, args });
	const component = fakeToolComponent(toolName);
	booted.transcript.addChild(component);
	return component;
}

function settle(
	booted: Booted,
	toolCallId: string,
	toolName: string,
	result: unknown,
): void {
	booted.adapter.updateTool({
		toolCallId,
		toolName,
		result,
		isError: false,
	});
}

function terminalAnswer(text = "done"): {
	messages: readonly unknown[];
	willContinue: boolean;
} {
	return {
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason: "stop",
			},
		],
		willContinue: false,
	};
}

function visibleRows(booted: Booted): string[] {
	return booted.transcript
		.render(120)
		.map((line) => Bun.stripANSI(line).trimEnd())
		.filter((line) => line.length > 0);
}

describe("runtime modes", () => {
	test("live keeps the current lifecycle: rows live, filtered at terminal", async () => {
		const booted = await boot();
		await beginRun(booted);
		addTool(booted, "bash", "bash-1", { command: "printf done" });
		settle(booted, "bash-1", "bash", {
			content: [{ type: "text", text: "ok" }],
		});
		expect(visibleRows(booted).join("\n")).toContain("bash: printf done");
		booted.adapter.endRun(terminalAnswer());
		expect(visibleRows(booted).join("\n")).not.toContain("printf done");
		expect(booted.finalized).toEqual(["omp-compact-run-1"]);
	});

	test("a settled run's late message_update never allocates into the next run", async () => {
		const booted = await boot();
		await beginRun(booted);
		addTool(booted, "bash", "first-call", { command: "printf first" });
		booted.adapter.endRun(terminalAnswer("first done"));
		// Stock queues message_update events behind earlier stream deltas
		// while agent_end/agent_start are delivered directly, so a delta
		// emitted for the settled run can be handled AFTER the next run's
		// agent_start. It must never allocate a state/entry into the next
		// run's ledger (or fabricate a ledger between runs).
		await beginRun(booted);
		booted.adapter.observeAssistantMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "stale-call",
					name: "bash",
					arguments: { command: "echo stale" },
				},
			],
		});
		// The next run's genuine tool still order-binds compactly; the stale
		// id never shows and never blocks the binding.
		addTool(booted, "bash", "second-call", { command: "printf second" });
		const rows = visibleRows(booted).join("\n");
		expect(rows).toContain("bash: printf second");
		expect(rows).not.toContain("native-bash");
		expect(rows).not.toContain("echo stale");
		settle(booted, "second-call", "bash", {
			content: [{ type: "text", text: "ok" }],
		});
		booted.adapter.endRun(terminalAnswer("second done"));
		expect(booted.finalized).toEqual([
			"omp-compact-run-1",
			"omp-compact-run-2",
		]);
	});

	test("compact keeps the entire compact tool log at terminal", async () => {
		const booted = await boot({ mode: "compact" });
		await beginRun(booted);
		addTool(booted, "bash", "bash-1", { command: "printf kept" });
		settle(booted, "bash-1", "bash", {
			content: [{ type: "text", text: "ok" }],
		});
		expect(visibleRows(booted).join("\n")).toContain("bash: printf kept");
		booted.adapter.endRun(terminalAnswer());
		const terminal = visibleRows(booted).join("\n");
		expect(terminal).toContain("bash: printf kept");
		// no duplicate aggregate projections on top of the kept log
		expect(terminal).not.toContain("git commit:");
		// the stats seam still fires: terminal success is presentation-
		// independent (compact keeps the log, but the answer is successful)
		expect(booted.finalized).toEqual(["omp-compact-run-1"]);
	});

	test("compact keeps read and git rows at terminal", async () => {
		const booted = await boot({ mode: "compact" });
		await beginRun(booted);
		// Reads bind through the read group only — no standalone tool block.
		booted.adapter.startTool({
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "a.ts" },
		});
		const group = fakeReadGroup();
		booted.transcript.addChild(group);
		(
			group as unknown as { updateArgs(a: unknown, id: string): void }
		).updateArgs({ path: "a.ts" }, "read-1");
		settle(booted, "read-1", "read", {
			content: [{ type: "text", text: "src" }],
		});
		addTool(booted, "bash", "git-1", { command: "git status --short" });
		booted.adapter.setGit("git-1", {
			version: 1,
			toolCallId: "git-1",
			subcommand: "status",
			text: "git status --short",
			isError: false,
		});
		settle(booted, "git-1", "bash", {
			content: [{ type: "text", text: "clean" }],
		});
		booted.adapter.endRun(terminalAnswer());
		const terminal = visibleRows(booted).join("\n");
		expect(terminal).toContain("read a.ts");
		expect(terminal).toContain("git status --short");
	});

	test("clear hides routine rows while working and at terminal", async () => {
		const booted = await boot({ mode: "clear" });
		await beginRun(booted);
		addTool(booted, "bash", "bash-1", { command: "printf hidden" });
		settle(booted, "bash-1", "bash", {
			content: [{ type: "text", text: "ok" }],
		});
		expect(visibleRows(booted).join("\n")).not.toContain("printf hidden");
		booted.adapter.endRun(terminalAnswer());
		expect(visibleRows(booted).join("\n")).not.toContain("printf hidden");
		expect(booted.finalized).toEqual(["omp-compact-run-1"]);
	});

	test("clear hides compact task rows throughout the run", async () => {
		const booted = await boot({ mode: "clear" });
		await beginRun(booted);
		addTool(booted, "task", "task-1", { description: "sub" });
		expect(visibleRows(booted).join("\n")).not.toContain("task:");
		booted.adapter.endRun(terminalAnswer());
		expect(visibleRows(booted).join("\n")).not.toContain("task:");
	});

	test("clear hides expanded tools and expanded read groups", async () => {
		const booted = await boot({ mode: "clear" });
		await beginRun(booted);
		const call = addTool(booted, "bash", "bash-1", { command: "printf x" });
		call.setExpanded(true);
		expect(visibleRows(booted).join("\n")).not.toContain("printf x");
		expect(visibleRows(booted).join("\n")).not.toContain("native-bash");
		booted.adapter.endRun(terminalAnswer());
	});

	test("clear abort keeps compact diagnostic rows", async () => {
		const booted = await boot({ mode: "clear" });
		await beginRun(booted);
		addTool(booted, "bash", "bash-1", { command: "printf diag" });
		settle(booted, "bash-1", "bash", {
			content: [{ type: "text", text: "ok" }],
		});
		booted.adapter.endRun({
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "" }],
					stopReason: "aborted",
				},
			],
			willContinue: false,
		});
		expect(visibleRows(booted).join("\n")).toContain("bash: printf diag");
		expect(booted.finalized).toEqual([]);
	});

	test("clear hides mapped read groups but never unmapped native groups", async () => {
		const booted = await boot({ mode: "clear" });
		await beginRun(booted);
		// mapped group: hidden in working and terminal phases
		booted.adapter.startTool({
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "a.ts" },
		});
		const group = fakeReadGroup();
		booted.transcript.addChild(group);
		(
			group as unknown as { updateArgs(a: unknown, id: string): void }
		).updateArgs({ path: "a.ts" }, "read-1");
		settle(booted, "read-1", "read", {
			content: [{ type: "text", text: "src" }],
		});
		expect(visibleRows(booted).join("\n")).not.toContain("read a.ts");
		booted.adapter.endRun(terminalAnswer());
		expect(visibleRows(booted).join("\n")).not.toContain("read a.ts");
		// unmapped group keeps the raw native renderer (fail-open, no silent drops)
		const unknown = fakeReadGroup();
		booted.transcript.addChild(unknown);
		(
			unknown as unknown as { updateArgs(a: unknown, id: string): void }
		).updateArgs({ path: "u.ts" }, "untracked-1");
		expect(visibleRows(booted).join("\n")).toContain("native-read-group");
	});

	test("retainGitLive=false suppresses git rows and the commit summary", async () => {
		const off = await boot({ retainGitLive: false });
		await beginRun(off);
		addTool(off, "bash", "git-1", { command: "git commit abc1234 Fix" });
		off.adapter.setGit("git-1", {
			version: 1,
			toolCallId: "git-1",
			subcommand: "commit",
			text: "git commit abc1234 Fix",
			isError: false,
		});
		settle(off, "git-1", "bash", {
			content: [{ type: "text", text: "committed" }],
		});
		expect(visibleRows(off).join("\n")).not.toContain("git commit");
		off.adapter.endRun(terminalAnswer());
		expect(visibleRows(off).join("\n")).not.toContain("git commit:");
		off.adapter.dispose();

		const on = await boot({ retainGitLive: true });
		await beginRun(on);
		addTool(on, "bash", "git-1", { command: "git commit abc1234 Fix" });
		on.adapter.setGit("git-1", {
			version: 1,
			toolCallId: "git-1",
			subcommand: "commit",
			text: "git commit abc1234 Fix",
			isError: false,
		});
		settle(on, "git-1", "bash", {
			content: [{ type: "text", text: "committed" }],
		});
		expect(visibleRows(on).join("\n")).toContain("git commit abc1234");
		on.adapter.endRun(terminalAnswer());
		expect(visibleRows(on).join("\n")).toContain("git commit:");
		expect(visibleRows(on).join("\n")).not.toContain("Fix");
	});

	test("mid-run settings changes never mix into the active run", async () => {
		const booted = await boot({ mode: "compact" });
		await beginRun(booted);
		addTool(booted, "bash", "bash-1", { command: "printf run1" });
		settle(booted, "bash-1", "bash", {
			content: [{ type: "text", text: "ok" }],
		});
		// user switches to clear while run 1 is still working
		await booted.store.updateRaw({ mode: "clear" });
		expect(visibleRows(booted).join("\n")).toContain("bash: printf run1");
		booted.adapter.endRun(terminalAnswer());
		expect(visibleRows(booted).join("\n")).toContain("bash: printf run1");
		// the next logical run starts under the new mode
		await beginRun(booted);
		addTool(booted, "bash", "bash-2", { command: "printf run2" });
		expect(visibleRows(booted).join("\n")).not.toContain("printf run2");
		booted.adapter.endRun(terminalAnswer());
		expect(visibleRows(booted).join("\n")).not.toContain("printf run2");
	});

	test("onRunFinalized fires once per filtered terminal run", async () => {
		const booted = await boot({ mode: "clear" });
		await beginRun(booted);
		addTool(booted, "bash", "bash-1", { command: "printf a" });
		settle(booted, "bash-1", "bash", {
			content: [{ type: "text", text: "ok" }],
		});
		// continuation: no finalize callback
		booted.adapter.endRun({
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "more" }],
					stopReason: "toolUse",
				},
			],
			willContinue: false,
		});
		expect(booted.finalized).toEqual([]);
		// terminal answer: one callback
		booted.adapter.endRun(terminalAnswer());
		expect(booted.finalized).toEqual(["omp-compact-run-1"]);
	});

	test("release after a failed drain renders only the finalized old run", async () => {
		const booted = await boot();
		await beginRun(booted);
		const oldComponent = addTool(booted, "bash", "old-call", {
			command: "printf old",
		});
		const oldRunId = booted.adapter.captureTerminalRunId();
		expect(oldRunId).toBeDefined();

		// Drain false: endRun never runs; the next run begins before the
		// release (stock agent_start delivery is fire-and-forget).
		await beginRun(booted);
		const newComponent = addTool(booted, "bash", "new-call", {
			command: "printf new",
		});
		const before = {
			render: booted.renders.render,
			components: [...booted.renders.components],
		};

		booted.adapter.releaseTerminalRun(oldRunId);

		// The release's fallback finalization requests the old run's render…
		expect(booted.renders.render).toBeGreaterThan(before.render);
		expect(booted.renders.components).toContain(oldComponent);
		// …but never the newer active run's component.
		expect(booted.renders.components).not.toContain(newComponent);
		// No onRunFinalized/stats/evidence side effects on a fail-closed drain.
		expect(booted.finalized).toEqual([]);

		// The new run is untouched and still finalizes as its own working
		// ledger.
		expect(booted.adapter.endRun(terminalAnswer())).toBe("filtered");
	});

	test("replay hydrates under the current mode", async () => {
		for (const mode of ["compact", "clear"] as const) {
			const booted = await boot({ mode });
			const component = fakeToolComponent("bash");
			booted.transcript.addChild(component);
			booted.adapter.hydrateBranch([
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "work" }] },
				},
				{
					type: "custom",
					customType: "tool_execution_start",
					data: {
						toolCallId: "b1",
						toolName: "bash",
						args: { command: "printf replay" },
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "b1",
						content: [{ type: "text", text: "ok" }],
						isError: false,
					},
				},
				{ type: "message", message: terminalAnswer("done").messages[0] },
			]);
			const rows = visibleRows(booted).join("\n");
			if (mode === "compact") {
				expect(rows).toContain("bash: printf replay");
			} else {
				expect(rows).not.toContain("printf replay");
			}
		}
	});

	test("dispose restores wrappers and clears the spinner timer", async () => {
		const cleared: unknown[] = [];
		const store = fakeStore(settings({}));
		const policy = new modePolicyModule.ModePolicy(store);
		policy.prime();
		await policy.prepareRun();
		const transcript = fakeTranscript();
		const timer = { id: 1 };
		const adapter = new adapterModule.RuntimeAdapter({
			root: transcript,
			ui: {
				theme: fakeTheme(),
				setWidget() {},
				requestRender() {},
				requestComponentRender() {},
				getToolsExpanded: () => false,
			},
			timers: {
				setInterval: () => timer,
				clearTimer: (value: unknown) => cleared.push(value),
			},
			modePolicy: policy,
		});
		expect(adapter.install()).toBe(true);
		await beginRun({
			adapter,
			transcript,
			policy,
			store,
			finalized: [],
			renders: { render: 0, components: [] },
			warned: [],
		});
		addTool(
			{
				adapter,
				transcript,
				policy,
				store,
				finalized: [],
				renders: { render: 0, components: [] },
				warned: [],
			},
			"bash",
			"bash-1",
			{ command: "printf x" },
		);
		expect(transcript.children).toHaveLength(1);
		const addChild = transcript.addChild.bind(transcript);
		adapter.dispose();
		expect(cleared).toEqual([timer]);
		// the transcript's addChild wrapper is restored to the original
		const restored = transcript.addChild;
		expect(restored).not.toBe(addChild);
		expect(() => transcript.render(120)).not.toThrow();
	});

	test("expanded browser/computer/resolve/reject stay compact while working", async () => {
		const booted = await boot();
		await beginRun(booted);
		const browser = addTool(booted, "browser", "browser-1", {
			url: "https://omp.test/expand-browser",
		});
		settle(booted, "browser-1", "browser", { content: [] });
		browser.setExpanded(true);
		const computer = addTool(booted, "computer", "computer-1", {});
		settle(booted, "computer-1", "computer", { content: [] });
		computer.setExpanded(true);
		const resolve = addTool(booted, "resolve", "resolve-1", {});
		settle(booted, "resolve-1", "resolve", { content: [] });
		resolve.setExpanded(true);
		const reject = addTool(booted, "reject", "reject-1", {});
		settle(booted, "reject-1", "reject", { content: [] });
		reject.setExpanded(true);
		const rows = visibleRows(booted).join("\n");
		expect(rows).toContain("browser: https://omp.test/expand-browser");
		expect(rows).toContain("• computer use");
		expect(rows).toContain("• resolve");
		expect(rows).toContain("• reject");
		expect(rows).not.toContain("native-browser");
		expect(rows).not.toContain("native-computer");
		expect(rows).not.toContain("native-resolve");
		expect(rows).not.toContain("native-reject");
	});

	test("expanded four tools keep compact rows at the compact terminal", async () => {
		const booted = await boot({ mode: "compact" });
		await beginRun(booted);
		const browser = addTool(booted, "browser", "browser-1", {
			url: "https://omp.test/term-browser",
		});
		settle(booted, "browser-1", "browser", { content: [] });
		browser.setExpanded(true);
		const reject = addTool(booted, "reject", "reject-1", {});
		settle(booted, "reject-1", "reject", { content: [] });
		reject.setExpanded(true);
		booted.adapter.endRun(terminalAnswer());
		const rows = visibleRows(booted).join("\n");
		expect(rows).toContain("browser: https://omp.test/term-browser");
		expect(rows).toContain("• reject");
		expect(rows).not.toContain("native-browser");
		expect(rows).not.toContain("native-reject");
	});

	test("clear abort keeps compact rows for expanded four tools", async () => {
		const booted = await boot({ mode: "clear" });
		await beginRun(booted);
		const browser = addTool(booted, "browser", "browser-1", {
			url: "https://omp.test/abort-browser",
		});
		settle(booted, "browser-1", "browser", { content: [] });
		browser.setExpanded(true);
		const resolve = addTool(booted, "resolve", "resolve-1", {});
		settle(booted, "resolve-1", "resolve", { content: [] });
		resolve.setExpanded(true);
		booted.adapter.endRun({
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "" }],
					stopReason: "aborted",
				},
			],
			willContinue: false,
		});
		const rows = visibleRows(booted).join("\n");
		expect(rows).toContain("browser: https://omp.test/abort-browser");
		expect(rows).toContain("• resolve");
		expect(rows).not.toContain("native-browser");
		expect(rows).not.toContain("native-resolve");
	});

	test("clear hides expanded four tools while working", async () => {
		const booted = await boot({ mode: "clear" });
		await beginRun(booted);
		const browser = addTool(booted, "browser", "browser-1", {
			url: "https://omp.test/hidden-browser",
		});
		settle(booted, "browser-1", "browser", { content: [] });
		browser.setExpanded(true);
		const rows = visibleRows(booted).join("\n");
		expect(rows).not.toContain("https://omp.test/hidden-browser");
		expect(rows).not.toContain("native-browser");
	});

	test("live terminal keeps mutation rows of the four tools compact", async () => {
		const booted = await boot();
		await beginRun(booted);
		const resolve = addTool(booted, "resolve", "resolve-1", {});
		settle(booted, "resolve-1", "resolve", { content: [] });
		resolve.setExpanded(true);
		booted.adapter.setMutations("resolve-1", [
			{
				version: 1,
				toolCallId: "resolve-1",
				toolName: "write",
				path: "resolve-evidence.md",
				added: 1,
				removed: 0,
				exact: true,
			},
		]);
		booted.adapter.endRun(terminalAnswer());
		const rows = visibleRows(booted).join("\n");
		expect(rows).toContain("resolve-evidence.md");
		expect(rows).not.toContain("native-resolve");
	});

	test("ordinary, native-live and unknown tools keep native on expansion", async () => {
		const booted = await boot();
		await beginRun(booted);
		const bash = addTool(booted, "bash", "bash-1", { command: "printf hatch" });
		settle(booted, "bash-1", "bash", { content: [] });
		bash.setExpanded(true);
		expect(visibleRows(booted).join("\n")).toContain("native-bash");
		const ask = addTool(booted, "ask", "ask-1", { question: "q?" });
		settle(booted, "ask-1", "ask", { content: [] });
		ask.setExpanded(true);
		expect(visibleRows(booted).join("\n")).toContain("native-ask");
		const unknown = addTool(booted, "mystery_tool", "mystery-1", {});
		settle(booted, "mystery-1", "mystery_tool", { content: [] });
		unknown.setExpanded(true);
		expect(visibleRows(booted).join("\n")).toContain("native-mystery_tool");
	});
});

describe("restore override (upgrade2 item 3)", () => {
	test("armRestoreOverride arms a one-shot compact snapshot cleared by prepareRun", async () => {
		const store = fakeStore(settings({ mode: "live", enabled: true }));
		const policy = new modePolicyModule.ModePolicy(store);
		policy.prime();
		await policy.prepareRun();
		policy.armRestoreOverride();
		expect(policy.restoreOverride).toEqual({
			mode: "compact",
			enabled: true,
			retainGitLive: true,
		});
		// the persisted mode is never touched
		expect((await store.load()).mode).toBe("live");
		// the override is one-shot: the next run boundary clears it
		await policy.prepareRun();
		expect(policy.restoreOverride).toBeUndefined();
	});

	test("armRestoreOverride is a no-op while the runtime is disabled", async () => {
		const store = fakeStore(settings({ enabled: false, mode: "live" }));
		const policy = new modePolicyModule.ModePolicy(store);
		policy.prime();
		await policy.ready();
		policy.armRestoreOverride();
		expect(policy.restoreOverride).toBeUndefined();
	});

	test("dispose clears the armed restore override", async () => {
		const store = fakeStore(settings({ mode: "live", enabled: true }));
		const policy = new modePolicyModule.ModePolicy(store);
		policy.prime();
		await policy.ready();
		policy.armRestoreOverride();
		expect(policy.restoreOverride).toBeDefined();
		policy.dispose();
		expect(policy.restoreOverride).toBeUndefined();
	});

	test("resume hydration renders compact under the armed override; the next run keeps the persisted live mode", async () => {
		const store = fakeStore(settings({ mode: "live", enabled: true }));
		const policy = new modePolicyModule.ModePolicy(store);
		policy.prime();
		await policy.ready();
		// stock entry into an existing session: no run boundary yet, so the
		// override outranks the (still unresolved) persisted live mode
		policy.armRestoreOverride();
		const finalized: string[] = [];
		const transcript = fakeTranscript();
		const renders = { render: 0, components: [] as unknown[] };
		const adapter = new adapterModule.RuntimeAdapter({
			root: transcript,
			ui: {
				theme: fakeTheme(),
				setWidget() {},
				requestRender() {
					renders.render++;
				},
				requestComponentRender(component: unknown) {
					renders.components.push(component);
				},
				getToolsExpanded: () => false,
			},
			timers: {
				setInterval: () => 1,
				clearTimer: () => {},
			},
			modePolicy: policy,
			onRunFinalized: (runId: string) => finalized.push(runId),
		});
		if (!adapter.install()) throw new Error("adapter install failed");
		// the stock resume transcript was reconstructed before hydration
		const restored = fakeToolComponent("bash");
		transcript.addChild(restored);
		adapter.hydrateBranch([
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "resume me" }],
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "b1",
					toolName: "bash",
					args: { command: "printf replay" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "b1",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{ type: "message", message: terminalAnswer("restored done").messages[0] },
		]);
		const restoredRows = visibleRows({
			adapter,
			transcript,
			policy,
			store,
			finalized,
			renders,
			warned: [],
		}).join("\n");
		expect(restoredRows).toContain("bash: printf replay");
		expect(restoredRows).not.toContain("native-bash");
		// the persisted mode is untouched by the restore entry
		expect((await store.load()).mode).toBe("live");
		// the next live run clears the override and keeps the persisted mode
		await policy.prepareRun();
		adapter.beginRun();
		addTool(
			{ adapter, transcript, policy, store, finalized, renders, warned: [] },
			"bash",
			"b2",
			{ command: "printf next" },
		);
		settle(
			{ adapter, transcript, policy, store, finalized, renders, warned: [] },
			"b2",
			"bash",
			{ content: [{ type: "text", text: "ok" }] },
		);
		adapter.endRun(terminalAnswer("next done"));
		const rows = visibleRows({
			adapter,
			transcript,
			policy,
			store,
			finalized,
			renders,
			warned: [],
		}).join("\n");
		expect(rows).toContain("bash: printf replay");
		// live filters the routine rows of the new run
		expect(rows).not.toContain("printf next");
	});
});

describe("runtime adapter: unpatchable read-group capability skew", () => {
	// The read group is registered in the binding BEFORE host.patchReadGroup
	// runs, so an unpatchable group (capability skew) must never let the
	// patch failure escape: the group would be orphaned and — in the
	// unwrapped mid-run discovery path — the rollback would never run, the
	// adapter would stay half-installed and the extension observer would
	// see the exception.
	test("an unpatchable read group discovered mid-run retires the adapter fail-open instead of escaping startTool", () => {
		const warned: string[] = [];
		// Discovery-shaped root: no transcript yet at install time, so the
		// adapter watches the container for one.
		const root: { children: unknown[]; addChild(child: unknown): void } = {
			children: [],
			addChild() {},
		};
		const adapter = new adapterModule.RuntimeAdapter({
			root,
			ui: {
				theme: fakeTheme(),
				setWidget() {},
				requestRender() {},
				requestComponentRender() {},
				getToolsExpanded: () => false,
			},
			timers: {
				setInterval: () => 1,
				clearTimer: () => {},
			},
			warn: (message: string) => warned.push(message),
		});
		expect(adapter.install()).toBe(true);
		adapter.beginRun();
		// The transcript appears directly in the tree (a native mutation
		// that bypasses the container's addChild patch) and already carries
		// a read group the host cannot patch.
		const transcript = fakeTranscript();
		transcript.children.push(Object.freeze(fakeReadGroup()));
		root.children.push(transcript);
		// The observer entry point must never throw: the adapter contains
		// the patch failure, warns once and retires fail-open.
		expect(() =>
			adapter.startTool({ toolCallId: "r1", toolName: "read", args: {} }),
		).not.toThrow();
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("omp-compact disabled");
		// The retired adapter stays inert: a second start neither throws
		// nor warns again, and dispose stays idempotent.
		expect(() =>
			adapter.startTool({ toolCallId: "r2", toolName: "read", args: {} }),
		).not.toThrow();
		expect(warned).toHaveLength(1);
		expect(() => adapter.dispose()).not.toThrow();
	});

	test("a frozen read group added to the live transcript retires the adapter with a single warning", async () => {
		const booted = await boot({ mode: "live" });
		const group = Object.freeze(fakeReadGroup());
		// The live observer path: stock's addChild drives the adapter, and
		// the patch failure must never surface through it.
		expect(() => booted.transcript.addChild(group)).not.toThrow();
		expect(booted.warned).toHaveLength(1);
		expect(booted.warned[0]).toContain("omp-compact disabled");
		// Retirement restored the transcript to native: later children and
		// rendering stay functional with no orphaned wrapper.
		const after = fakeToolComponent("bash");
		expect(() => booted.transcript.addChild(after)).not.toThrow();
		expect(booted.transcript.children).toContain(after);
		expect(() => booted.transcript.render(120)).not.toThrow();
	});
});
