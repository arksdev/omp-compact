import { afterAll, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { DEFAULT_SETTINGS } from "../../.omp-plugin/config";
import {
	addTool,
	addToolComponent,
	assistant,
	type BootedPlugin,
	beginRun,
	bootPlugin,
	bootWithTranscript,
	cleanupGeneratedDirs,
	dispatch,
	dispatchFireAndForget,
	finishTool,
	fixtureDir,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";
import type { Renderable, TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

// ---------------------------------------------------------------------------
// AdapterFailOpenFix: host-probe / adapter bring-up failures must never
// escape into the event stream. `ensureAdapter` runs capture/construct/
// install as one transaction: any setWidget/constructor exception restores
// partial own-instance effects, disables the adapter for the session, warns
// once through the UI notification seam, and never retries per event. Only
// a session boundary (switch/shutdown -> dispose) resets the disable state.
// Headless root absence (no setWidget) stays a quiet fail-open.
// ---------------------------------------------------------------------------

/**
 * setWidget fake that tracks probe registrations and lets the test decide
 * where to fail. Registration invokes the probe callback against `root`
 * (mirroring the stock harness) and records the key; removal forgets it.
 */
function trackingSetWidget(
	booted: Pick<BootedPlugin, "root">,
	widgets: Set<string>,
	fail: (key: string, content: unknown) => void,
): BootedPlugin["context"]["ui"]["setWidget"] {
	return (key, content) => {
		if (content === undefined) {
			widgets.delete(key);
			fail(key, content);
			return;
		}
		widgets.add(key);
		if (typeof content === "function") {
			(content as (tui: unknown) => Renderable)(booted.root);
		}
		fail(key, content);
	};
}

stockTest(
	"setWidget probe registration failure fails open: disabled, warned once, never retried",
	async () => {
		const booted = await bootWithTranscript();
		// Fail the probe on the reinstall: the host accepts the widget and
		// then throws, so a leftover registration would be an own-instance
		// leak the guard must roll back.
		const widgets = new Set<string>();
		booted.context.ui.setWidget = trackingSetWidget(
			booted,
			widgets,
			(_key, content) => {
				if (typeof content !== "function") return;
				throw new Error("setWidget registration failed");
			},
		);
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		// contained: exactly one warning, no probe left behind, no reinstall
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		expect(widgets.size).toBe(0);
		// Idle install never arms a spinner; failed reinstall adds none.
		expect(booted.intervalCallbacks).toHaveLength(0);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		// every later event retries nothing and stays quiet
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "after-probe-failure",
			toolName: "bash",
			args: { command: "printf nope" },
		});
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "after-probe-failure",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(booted.notifications).toHaveLength(1);
		expect(booted.appendedEntries).toEqual([]);
		expect(booted.sentMessages).toEqual([]);
		expect(widgets.size).toBe(0);
		await shutdown(booted);
	},
);

stockTest(
	"setWidget probe removal failure is rolled back and disables once",
	async () => {
		const booted = await bootWithTranscript();
		const widgets = new Set<string>();
		let removals = 0;
		booted.context.ui.setWidget = trackingSetWidget(
			booted,
			widgets,
			(_key, content) => {
				if (content !== undefined) return;
				removals++;
				if (removals === 1) throw new Error("setWidget removal failed");
			},
		);
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		// the guard re-attempts removal during rollback: no probe widget
		// lingers even though the host's first removal call threw
		expect(removals).toBe(2);
		expect(widgets.size).toBe(0);
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		expect(booted.intervalCallbacks).toHaveLength(0);
		// disabled for the rest of the session: no retry, no second warning
		await beginRun(booted);
		expect(booted.notifications).toHaveLength(1);
		await shutdown(booted);
	},
);

stockTest(
	"adapter construction failure (throwing ui.theme getter) fails open once",
	async () => {
		const booted = await bootWithTranscript();
		// The probe succeeds; the failure surfaces while the adapter options
		// are evaluated (adapterUI reads context.ui.theme), i.e. inside the
		// construction phase of ensureAdapter.
		Object.defineProperty(booted.context.ui, "theme", {
			configurable: true,
			get() {
				throw new Error("theme unavailable");
			},
		});
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		expect(booted.notifications).toHaveLength(1);
		expect(booted.notifications[0]).toContain("omp-compact disabled");
		expect(booted.notifications[0]).toContain("theme unavailable");
		expect(booted.intervalCallbacks).toHaveLength(0);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		await beginRun(booted);
		expect(booted.notifications).toHaveLength(1);
		await shutdown(booted);
	},
);

stockTest(
	"session switch resets the adapter-disable state for the next session",
	async () => {
		const booted = await bootWithTranscript();
		const widgets = new Set<string>();
		const workingSetWidget = booted.context.ui.setWidget;
		booted.context.ui.setWidget = trackingSetWidget(
			booted,
			widgets,
			(_key, content) => {
				if (typeof content !== "function") return;
				throw new Error("setWidget registration failed");
			},
		);
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		expect(booted.notifications).toHaveLength(1);
		expect(booted.intervalCallbacks).toHaveLength(0);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		// the host heals; a session boundary resets the disable state
		booted.context.ui.setWidget = workingSetWidget;
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		// Idle reinstall still arms no spinner until a tool starts.
		expect(booted.intervalCallbacks).toHaveLength(0);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(true);
		// the reinstalled adapter is fully functional
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf healed" },
			"healed",
		);
		await finishTool(booted, call, {
			toolCallId: "healed",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"printf healed",
		);
		// the failed session's single warning is the only notification
		expect(booted.notifications).toHaveLength(1);
		await shutdown(booted);
	},
);

stockTest(
	"install() false and constructor throw share one bring-up failure path",
	async () => {
		// install() === false (multiple transcripts) and a throwing construct
		// must produce the same observables: one warning, probe widget gone
		// (shared path re-attempts removal even when captureHostRoot already
		// cleared it), adapter disabled for the session, no throw.
		async function bringUpWith(
			label: string,
			prepare: (
				booted: BootedPlugin & { transcript: TranscriptInstance },
				widgets: Set<string>,
				removals: { count: number },
			) => void,
		): Promise<void> {
			const booted = await bootWithTranscript();
			const widgets = new Set<string>();
			const removals = { count: 0 };
			const workingSetWidget = booted.context.ui.setWidget;
			prepare(booted, widgets, removals);
			await dispatch(booted, { type: "session_before_switch" });
			await dispatch(booted, { type: "session_start" });
			expect(booted.notifications, label).toHaveLength(1);
			expect(booted.notifications[0], label).toContain("omp-compact disabled");
			expect(widgets.size, label).toBe(0);
			// Shared path always re-attempts probe removal. install-false runs
			// captureHostRoot's clear then rollbackAdapterFailure (>=2);
			// construct-throw aborts mid-registration so only the rollback
			// removal runs (>=1). Either way the probe is gone.
			expect(removals.count, label).toBeGreaterThanOrEqual(
				label === "install-false" ? 2 : 1,
			);
			expect(Object.hasOwn(booted.transcript, "addChild"), label).toBe(false);
			expect(booted.intervalCallbacks, label).toHaveLength(0);
			// disabled for the rest of the session: no retry, no second warning
			await beginRun(booted);
			await dispatch(booted, {
				type: "tool_execution_start",
				toolCallId: `${label}-after`,
				toolName: "bash",
				args: { command: "printf after" },
			});
			expect(booted.notifications, label).toHaveLength(1);
			expect(Object.hasOwn(booted.transcript, "addChild"), label).toBe(false);
			booted.context.ui.setWidget = workingSetWidget;
			await shutdown(booted);
		}

		await bringUpWith("install-false", (booted, widgets, removals) => {
			const second = new booted.host.TranscriptContainer();
			booted.root.addChild(second);
			booted.context.ui.setWidget = trackingSetWidget(
				booted,
				widgets,
				(_key, content) => {
					if (content === undefined) removals.count++;
				},
			);
		});

		await bringUpWith("construct-throw", (booted, widgets, removals) => {
			booted.context.ui.setWidget = trackingSetWidget(
				booted,
				widgets,
				(_key, content) => {
					if (content === undefined) {
						removals.count++;
						return;
					}
					if (typeof content === "function") {
						throw new Error("setWidget registration failed");
					}
				},
			);
		});
	},
);

stockTest(
	"headless root absence (no setWidget) stays a quiet fail-open",
	async () => {
		const booted = await bootWithTranscript();
		booted.context.ui.setWidget =
			undefined as unknown as BootedPlugin["context"]["ui"]["setWidget"];
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		expect(booted.notifications).toEqual([]);
		expect(booted.intervalCallbacks).toHaveLength(0);
		expect(Object.hasOwn(booted.transcript, "addChild")).toBe(false);
		await beginRun(booted);
		expect(booted.notifications).toEqual([]);
		await shutdown(booted);
	},
);

stockTest(
	"a late agent-end drain after session dispose never touches the reinstalled adapter",
	async () => {
		const cwd = fixtureDir("race-latedrain");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		let transcript: TranscriptInstance | undefined;
		const booted = await bootPlugin(
			(root, host) => {
				transcript = new host.TranscriptContainer();
				root.addChild(transcript);
			},
			cwd,
			[],
			false,
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: true },
			},
		);
		if (!transcript) throw new Error("transcript missing");
		const bootedWithTranscript = { ...booted, transcript };
		await beginRun(bootedWithTranscript);
		// The write audit capture stays in flight while a terminal agent_end
		// queues its drain link; the session then switches before the drain
		// can settle (the same race the audit lifecycle generation guard
		// owns, now pinned for the stats seam).
		const toolCallId = "write-late-drain";
		const startPromise = dispatchFireAndForget(bootedWithTranscript, {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		});
		addToolComponent(
			bootedWithTranscript,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			toolCallId,
		);
		const drain = dispatchFireAndForget(bootedWithTranscript, {
			type: "agent_end",
			messages: [assistant("done")],
			willContinue: false,
		});
		await dispatch(bootedWithTranscript, { type: "session_before_switch" });
		await dispatch(bootedWithTranscript, { type: "session_start" });
		// The reinstalled adapter is live and owns a fresh run id sequence.
		await beginRun(bootedWithTranscript);
		const healed = await addTool(
			bootedWithTranscript,
			"bash",
			{ command: "printf healed" },
			"healed",
		);
		await finishTool(bootedWithTranscript, healed, {
			toolCallId: "healed",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		// Settle the old session's in-flight write and its queued drain: the
		// late callback must not render the old run's stats row on the new
		// adapter (or throw), and the new run renders normally.
		await startPromise;
		await dispatchFireAndForget(bootedWithTranscript, {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: {},
			},
			isError: false,
		});
		await drain;
		const rows = visibleRows(bootedWithTranscript.transcript).join("\n");
		expect(rows).toContain("printf healed");
		expect(rows).not.toContain("sent");
		expect(rows).not.toContain("actions");
		await shutdown(bootedWithTranscript);
		await rm(cwd, { recursive: true, force: true });
	},
);
