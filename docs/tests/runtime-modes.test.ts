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
		prepareRun(): Promise<{
			mode: string;
			enabled: boolean;
			retainGitLive: boolean;
		}>;
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
	const transcript = fakeTranscript();
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
			setInterval: () => 1,
			clearTimer: () => {},
		},
		modePolicy: policy,
		onRunFinalized: (runId: string) => finalized.push(runId),
	});
	if (!adapter.install()) throw new Error("adapter install failed");
	return { adapter, transcript, policy, store, finalized };
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

	test("clear keeps the stock task subagent surface throughout", async () => {
		const booted = await boot({ mode: "clear" });
		await beginRun(booted);
		addTool(booted, "task", "task-1", { description: "sub" });
		expect(visibleRows(booted).join("\n")).toContain("native-task");
		booted.adapter.endRun(terminalAnswer());
		expect(visibleRows(booted).join("\n")).toContain("native-task");
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
		});
		addTool(
			{ adapter, transcript, policy, store, finalized: [] },
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
});
