import { afterAll, expect } from "bun:test";
import {
	addAnswer,
	addTool,
	type BootedPlugin,
	beginRun,
	bootPlugin,
	bootWithTranscript,
	cleanupGeneratedDirs,
	finishRun,
	finishTool,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";

afterAll(cleanupGeneratedDirs);

stockTest("plugin leaves the native tool registry untouched", async () => {
	const booted = await bootWithTranscript();
	expect(booted.registeredTools).toEqual([]);
	await shutdown(booted);
});

stockTest("legacy mutation messages remain renderable", async () => {
	const booted = await bootWithTranscript();
	const renderer = booted.renderers.get("omp-compact-write");
	const component = renderer?.(
		{
			details: {
				toolName: "edit",
				path: "src/legacy.ts",
				added: 1,
				removed: 0,
				exact: true,
			},
		},
		{ expanded: false },
		booted.host.getTheme(),
	);
	expect(component && visibleRows(component).join("\n")).toContain(
		"edit: src/legacy.ts",
	);
	expect(component && visibleRows(component).join("\n")).toContain("+1|0");
	await shutdown(booted);
});

stockTest(
	"successful routine tools stay live until the terminal answer",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf done" },
			"bash-1",
		);
		expect(visibleRows(booted.transcript).join("\n")).toContain("printf done");
		expect(call.isTranscriptBlockFinalized()).toBe(false);
		await finishTool(booted, call, {
			toolCallId: "bash-1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "done" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		const settled = visibleRows(booted.transcript).join("\n");
		expect(settled).toContain("bash");
		expect(settled).toContain("printf done");
		expect(call.isTranscriptBlockFinalized()).toBe(false);
		addAnswer(booted, "final answer");
		await finishRun(booted, "final answer");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("final answer");
		expect(completed).not.toContain("printf done");
		expect(call.isTranscriptBlockFinalized()).toBe(true);
		await shutdown(booted);
	},
);

stockTest(
	"a host without message renderers degrades instead of failing boot",
	async () => {
		const booted = await bootPlugin(undefined, "/tmp", [], false, undefined, {
			piMutate: (pi) => {
				pi.registerMessageRenderer = () => {
					throw new Error("RPC shim: renderer registration unavailable");
				};
			},
		});
		// The renderer trio is skipped; the rest of the boot survives: the
		// settings command stays registered and the event listeners still bind.
		expect(booted.renderers.size).toBe(0);
		expect(booted.commands).toContain("compact-settings");
		expect(booted.handlers.size).toBeGreaterThan(0);
		await shutdown(booted);
	},
);

stockTest(
	"a host without event subscriptions degrades instead of failing boot",
	async () => {
		const booted = await bootPlugin(undefined, "/tmp", [], false, undefined, {
			piMutate: (pi) => {
				pi.on = () => {
					throw new Error("RPC shim: event subscription unavailable");
				};
			},
		});
		// Each registration is guarded independently: the renderer trio and the
		// settings command still land even though every event subscription was
		// rejected.
		expect(booted.renderers.size).toBe(3);
		expect(booted.commands).toContain("compact-settings");
		expect(booted.handlers.size).toBe(0);
		await shutdown(booted);
	},
);

stockTest(
	"a failing display-cycle keypress notifies instead of crashing the host",
	async () => {
		// Stock awaits extension *command* handlers inside a try/catch
		// (`session/agent-session.ts` `#tryExecuteExtensionCommand`) but calls
		// *shortcut* handlers without awaiting
		// (`modes/controllers/input-controller.ts`
		// `registerExtensionShortcuts`), so its try/catch only catches
		// synchronous throws. An async rejection from the plugin's handler
		// would reach the process-level `unhandledRejection` hook, which
		// `pi-utils/postmortem.ts` treats as fatal — one keypress on a
		// read-only config file would end the user's session.
		let handler:
			| ((ctx: BootedPlugin["context"]) => Promise<void> | void)
			| undefined;
		const booted = await bootPlugin(undefined, "/tmp", [], false, undefined, {
			piMutate: (pi) => {
				pi.registerShortcut = (
					_chord: string,
					options: {
						handler: (ctx: BootedPlugin["context"]) => Promise<void> | void;
					},
				) => {
					handler = options.handler;
				};
			},
		});
		expect(handler).toBeDefined();

		const notifications: string[] = [];
		const ctx = {
			...booted.context,
			ui: {
				...booted.context.ui,
				notify: (message: string) => {
					notifications.push(message);
				},
				// The cycle reads the theme before saving; a throwing getter
				// stands in for any failure inside the handler body.
				get theme(): never {
					throw new Error("theme unavailable");
				},
			},
		} as unknown as BootedPlugin["context"];

		// Must resolve: the rejection is contained and reported.
		await expect(handler?.(ctx)).resolves.toBeUndefined();
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain("display cycle failed");
		expect(notifications[0]).toContain("theme unavailable");
		await shutdown(booted);
	},
);

stockTest("expanded live tools delegate to the native renderer", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const call = await addTool(
		booted,
		"bash",
		{ command: "printf inspect" },
		"bash-expanded",
	);
	const compact = visibleRows(booted.transcript);
	call.setExpanded(true);
	const expanded = visibleRows(booted.transcript);
	expect(expanded).not.toEqual(compact);
	expect(expanded.join("\n")).toContain("printf inspect");
	call.setExpanded(false);
	const collapsed = visibleRows(booted.transcript);
	expect(collapsed).not.toEqual(expanded);
	expect(collapsed.join("\n")).toContain("bash: printf inspect");
	await shutdown(booted);
});
