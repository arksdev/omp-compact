import { afterAll, expect } from "bun:test";
import { DEFAULT_SETTINGS } from "../../.omp-plugin/config";
import { KEY_SPACE } from "../../.omp-plugin/settings-ui";
import {
	addAnswer,
	addTool,
	addToolComponent,
	assistant,
	type BootedPlugin,
	beginRun,
	bootPlugin,
	cleanupGeneratedDirs,
	dispatch,
	finishRun,
	finishTool,
	flushMicrotasks,
	groupedRead,
	saveSettingsViaDialog,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";
import type { TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

/** Plain-CSI Down arrow, as a terminal delivers it to `handleInput`. */
const KEY_DOWN = "\u001b[B";

// ---------------------------------------------------------------------------
// PostTurnShake wiring (upgrade2 item 5): the runtime gate is frozen exactly
// once at the true logical-run boundary. A globally disabled run explicitly
// disarms shake even if the prior run was armed or OMP_COMPACT_SHAKE=1;
// continuation agent_start never re-snapshots settings; agent_end shakes only
// runs whose frozen global-enabled snapshot is true. The shake probe injects
// the real registry seam (pi.pi.AgentRegistry) with a fake live main session,
// so every native dispatch is observable end to end.
// ---------------------------------------------------------------------------

interface ShakeProbe {
	calls: Array<{ mode: string; aborted: boolean }>;
	sessionManager: { getBranch(): readonly unknown[] };
	registry: unknown;
	/**
	 * Mutable persisted branch behind the probe's `sessionManager`. A real
	 * `shake("elide")` rewrites the entries in place (`rewriteEntries`)
	 * before the host rebuilds the transcript, so tests that exercise the
	 * post-shake rebuild swap this to the elided branch from inside the
	 * shake call.
	 */
	branch: { current: readonly unknown[] };
	/** Invoked inside the native shake, before it resolves. */
	onShake?: () => void;
}

function shakeProbe(): ShakeProbe {
	const branch: { current: readonly unknown[] } = { current: [] };
	const sessionManager = { getBranch: () => branch.current };
	const calls: Array<{ mode: string; aborted: boolean }> = [];
	const probe: ShakeProbe = {
		calls,
		sessionManager,
		registry: undefined,
		branch,
	};
	const session = {
		sessionManager,
		async shake(mode: string, opts?: { signal?: AbortSignal }) {
			calls.push({ mode, aborted: opts?.signal?.aborted ?? false });
			// The real elide pass rewrites the persisted entries and swaps
			// the agent's messages before it resolves; the host transcript
			// rebuild happens afterwards.
			probe.onShake?.();
			return {
				mode,
				toolResultsDropped: 1,
				blocksDropped: 1,
				tokensFreed: 1_000,
			};
		},
	};
	const registry = {
		global: () => ({
			get: (id: string) =>
				id === "Main"
					? { id, kind: "main", status: "idle", session }
					: undefined,
		}),
	};
	probe.registry = registry;
	return probe;
}

/** Drain the fire-and-forget shake chain queued after an awaited agent_end. */
async function drainShake(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function bootWithShake(
	settings: Record<string, unknown>,
	probe = shakeProbe(),
): Promise<
	BootedPlugin & { transcript: TranscriptInstance; probe: ShakeProbe }
> {
	let transcript: TranscriptInstance | undefined;
	return bootPlugin(
		(root, host) => {
			transcript = new host.TranscriptContainer();
			root.addChild(transcript);
		},
		"/tmp",
		[],
		false,
		settings,
		{
			piPi: { AgentRegistry: probe.registry },
			sessionManager: probe.sessionManager,
		},
	).then((booted) => {
		if (!transcript) throw new Error("transcript missing");
		return { ...booted, transcript, probe };
	});
}

stockTest(
	"auto-shake: a globally disabled next run explicitly disarms shake armed by the prior run",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		// Run 1 starts ARMED but settles without shaking (aborted terminal
		// end): the once-per-run guard is still open, so the run's arming
		// must not survive into the next run.
		await beginRun(booted);
		await finishRun(booted, "", "aborted");
		await drainShake();
		expect(probe.calls).toEqual([]);

		// mid-session settings dialog: flip global mode off (real store
		// update path, so the next boundary sees the disable).
		await saveSettingsViaDialog(booted, (dialog) => {
			dialog.handleInput(KEY_SPACE);
		});

		// Next run boundary is globally disabled: the run must explicitly
		// disarm, so its terminal answer shakes nothing — even though the
		// prior run was armed and never shook.
		await beginRun(booted);
		await finishRun(booted, "done");
		await drainShake();
		expect(probe.calls).toEqual([]);
		await shutdown(booted);
	},
);

stockTest(
	"auto-shake: continuation agent_start never re-snapshots auto-shake settings changed mid-run",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		// the logical run starts armed…
		await beginRun(booted);
		// …a toolUse continuation keeps the run open…
		await finishRun(booted, "working", "toolUse");
		// …then the user turns auto-shake OFF mid-run. Navigate by rendered
		// label: the focusable row order is asserted by settings-ui, and a new
		// setting must not silently repoint this count.
		await saveSettingsViaDialog(booted, (dialog) => {
			let focused = false;
			for (let i = 0; i < 32; i++) {
				focused = dialog
					.render(100)
					.some((line) => /›.*Auto-shake/.test(Bun.stripANSI(line)));
				if (focused) break;
				dialog.handleInput(KEY_DOWN);
			}
			expect(focused, "Auto-shake row must be reachable").toBe(true);
			dialog.handleInput(KEY_SPACE);
		});
		// The continuation boundary must not observe the mid-run change:
		// no re-snapshot, no re-arm, no disarm of the frozen run — the
		// terminal answer of the frozen run still shakes exactly once.
		await beginRun(booted);
		await finishRun(booted, "final");
		await drainShake();
		expect(probe.calls).toHaveLength(1);
		expect(probe.calls[0]?.mode).toBe("elide");
		// The NEXT boundary observes the disable: no second shake.
		await beginRun(booted);
		await finishRun(booted, "after");
		await drainShake();
		expect(probe.calls).toHaveLength(1);
		await shutdown(booted);
	},
);

stockTest(
	"auto-shake: OMP_COMPACT_SHAKE=1 cannot re-arm a globally disabled run",
	async () => {
		const previous = Bun.env.OMP_COMPACT_SHAKE;
		Bun.env.OMP_COMPACT_SHAKE = "1";
		try {
			const probe = shakeProbe();
			const booted = await bootWithShake(
				{
					...DEFAULT_SETTINGS,
					enabled: false,
					stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
					autoShake: { enabled: true, thresholdTokens: 0 },
				},
				probe,
			);
			// The env force is resolved only for globally enabled runs: a
			// globally disabled run shakes nothing, even with SHAKE=1.
			await beginRun(booted);
			await finishRun(booted, "off");
			await drainShake();
			expect(probe.calls).toEqual([]);
			// Re-enable at the next boundary: SHAKE=1 forces shake on.
			await saveSettingsViaDialog(booted, (dialog) => {
				dialog.handleInput(KEY_SPACE);
			});
			await beginRun(booted);
			await finishRun(booted, "on");
			await drainShake();
			expect(probe.calls).toHaveLength(1);
			expect(probe.calls[0]?.mode).toBe("elide");
			// Disable again while SHAKE=1 still forces: the disabled boundary
			// explicitly disarms and the env force cannot re-arm it.
			await saveSettingsViaDialog(booted, (dialog) => {
				dialog.handleInput(KEY_SPACE);
			});
			await beginRun(booted);
			await finishRun(booted, "off-again");
			await drainShake();
			expect(probe.calls).toHaveLength(1);
			await shutdown(booted);
		} finally {
			if (previous === undefined) delete Bun.env.OMP_COMPACT_SHAKE;
			else Bun.env.OMP_COMPACT_SHAKE = previous;
		}
	},
);

stockTest(
	"auto-shake: re-enable at the next run boundary re-arms shake",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				enabled: false,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		await beginRun(booted);
		await finishRun(booted, "off");
		await drainShake();
		expect(probe.calls).toEqual([]);

		await saveSettingsViaDialog(booted, (dialog) => {
			dialog.handleInput(KEY_SPACE);
		});
		await beginRun(booted);
		await finishRun(booted, "on");
		await drainShake();
		expect(probe.calls).toHaveLength(1);
		expect(probe.calls[0]?.mode).toBe("elide");
		await shutdown(booted);
	},
);

stockTest(
	"auto-shake: a terminal purge of pending audit records finalizes the run but skips the shake",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		await beginRun(booted);
		// A write starts but its tool_execution_end never arrives before the
		// terminal agent_end: the terminal drain purges the pending record
		// (fail closed, no evidence), so the run's evidence was never
		// persisted and the post-run auto-shake must be skipped — while the
		// adapter's end-run finalization still runs.
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "write-pending",
			toolName: "write",
			args: { path: "pending.ts", content: "new\n" },
		});
		await finishRun(booted, "done");
		await drainShake();
		expect(probe.calls).toEqual([]);
		await shutdown(booted);
	},
);

stockTest(
	"auto-shake: session switch resets run state and the new session shakes fresh",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		await beginRun(booted);
		await finishRun(booted, "first");
		await drainShake();
		expect(probe.calls).toHaveLength(1);

		// Session switch: dispose drops the frozen snapshot, run state, and
		// any in-flight shake; the new session re-arms at its own boundary.
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		await beginRun(booted);
		await finishRun(booted, "second");
		await drainShake();
		expect(probe.calls).toHaveLength(2);
		await shutdown(booted);
	},
);

// ---------------------------------------------------------------------------
// E05 success feedback (auto-shake confirmation): a successfully resolved
// native shake shows the stock-format one-liner through the ephemeral UI
// notification (`ctx.ui.notify(message, "info")`), exactly once, and never
// as an appended session/custom entry. Skip/error paths stay silent.
// ---------------------------------------------------------------------------

stockTest(
	"auto-shake: a successful shake shows the stock-format ephemeral confirmation once",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		await beginRun(booted);
		await finishRun(booted, "done");
		await drainShake();
		expect(probe.calls).toHaveLength(1);
		// E05: the actual ShakeResult (1 tool result + 1 block, 1000 tokens)
		// is formatted exactly like stock formatShakeSummary and delivered
		// through the ephemeral notify path — the session gets no new leaf.
		expect(booted.notifications).toEqual([
			"Shook 1 tool result + 1 block (~1000 tokens freed).",
		]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);
	},
);

stockTest(
	"auto-shake: skipped and errored runs never show the confirmation",
	async () => {
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		await beginRun(booted);
		// An aborted run is not a visible successful answer: no shake
		// dispatch and no success confirmation.
		await finishRun(booted, "", "aborted");
		await drainShake();
		expect(probe.calls).toEqual([]);
		expect(booted.notifications).toEqual([]);
		await shutdown(booted);
	},
);

/**
 * One finished read turn as `shake("elide")` leaves it in the branch: the
 * assistant tool call survives, the result is replaced by the elide stub and
 * the terminal text answer closes the turn. This is what the host re-reads
 * when it rebuilds the transcript from the rewritten session file.
 */
function elidedReadTurn(
	toolCallId: string,
	path: string,
	answer: string,
	extraCall?: { id: string; name: string; args: unknown },
): readonly unknown[] {
	return [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "work" }] },
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					...(extraCall
						? [
								{
									type: "toolCall",
									id: extraCall.id,
									name: extraCall.name,
									arguments: extraCall.args,
								},
							]
						: []),
					{
						type: "toolCall",
						id: toolCallId,
						name: "read",
						arguments: { path },
					},
				],
			},
		},
		...(extraCall
			? [
					{
						type: "message",
						message: {
							role: "toolResult",
							toolCallId: extraCall.id,
							toolName: extraCall.name,
							content: [{ type: "text", text: "[shaken ~40 tokens]" }],
							isError: false,
						},
					},
				]
			: []),
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: "[shaken ~90 tokens]" }],
				isError: false,
			},
		},
		{ type: "message", message: assistant(answer) },
	];
}

stockTest(
	"auto-shake: the rebuilt read tail stays hidden after the post-turn shake",
	async () => {
		// Owner-reported regression: a long-lived session finishes a turn
		// with a normal text answer, auto-shake elides the turn's tool
		// results and the host rebuilds the transcript from the rewritten
		// branch. Stock collapses the older history
		// (`display.collapseCompacted`) and reconstructs only the newest
		// read group, so the visible groups are a suffix of the branch's
		// read segments. The rebuild must suffix-align that tail to the
		// trailing read ledger and keep it hidden behind the filtered
		// terminal answer — never expand the completed reads back into
		// stock read rows.
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		// an older turn whose surfaces the rebuild collapses away (still
		// present in the branch): one ordinary call plus its own read segment
		await beginRun(booted);
		const old = await addTool(
			booted,
			"bash",
			{ command: "printf old" },
			"bash-old",
		);
		await finishTool(booted, old, {
			toolCallId: "bash-old",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		await groupedRead(booted, "src/old.ts", "read-old");
		addAnswer(booted, "old done");
		await finishRun(booted, "old done");
		await drainShake();
		// the turn the user actually watched: an ordinary tool card plus a
		// completed read
		await beginRun(booted);
		const todo = await addTool(
			booted,
			"todo",
			{ i: "Closing validation task", todos: [] },
			"todo-1",
		);
		await finishTool(booted, todo, {
			toolCallId: "todo-1",
			toolName: "todo",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		await groupedRead(booted, "src/a.ts", "read-1");
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"• read src/a.ts",
		);
		addAnswer(booted, "shake done");
		// The elide pass rewrites the persisted entries before the host
		// rebuilds, so the rebuild hydrates from the elided branch.
		probe.onShake = () => {
			probe.branch.current = [
				...elidedReadTurn("read-old", "src/old.ts", "old done", {
					id: "bash-old",
					name: "bash",
					args: { command: "printf old" },
				}),
				...elidedReadTurn("read-1", "src/a.ts", "shake done", {
					id: "todo-1",
					name: "todo",
					args: { i: "Closing validation task", todos: [] },
				}),
			];
		};
		await finishRun(booted, "shake done");
		// filtered terminal answer: the read row is already gone
		expect(visibleRows(booted.transcript).join("\n")).not.toContain(
			"read src/a.ts",
		);
		await drainShake();
		expect(probe.calls).toHaveLength(2);
		expect(probe.calls[1]?.mode).toBe("elide");
		// stock's post-shake rebuild: clear, then repopulate the collapsed
		// tail. The staged rebuild constructs the read group without
		// replaying `updateArgs`, so the group arrives with no observed ids
		// and only ordinal pairing against the trailing read ledger can
		// claim it. Its native renderer is marked so an unbound group is
		// observable.
		booted.transcript.clear();
		const group = new booted.host.ReadToolGroupComponent();
		group.render = () => ["native read rows"];
		booted.transcript.addChild(group);
		addAnswer(booted, "shake done");
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("shake done");
		// the reconstructed group must be claimed by the trailing read
		// ledger and stay hidden behind the filtered terminal answer —
		// falling back to the stock renderer is the regression
		expect(rows).not.toContain("native read rows");
		expect(rows).not.toContain("read src/a.ts");
		await shutdown(booted);
	},
);

stockTest(
	"auto-shake: the rebuilt ordinary tool card stays hidden after the post-turn shake",
	async () => {
		// Second owner-reported symptom of the same turn: a compact `todo`
		// row stayed visible after the shake rebuild. Ordinary cards bind by
		// exact toolCallId through the tool-result path, so this asserts the
		// hydrated ledger phase (filtered for a text-answer turn) rather than
		// suffix alignment.
		const probe = shakeProbe();
		const booted = await bootWithShake(
			{
				...DEFAULT_SETTINGS,
				stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
				autoShake: { enabled: true, thresholdTokens: 0 },
			},
			probe,
		);
		await beginRun(booted);
		const todo = await addTool(
			booted,
			"todo",
			{ i: "Closing validation task", todos: [] },
			"todo-1",
		);
		await finishTool(booted, todo, {
			toolCallId: "todo-1",
			toolName: "todo",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"Closing validation task",
		);
		addAnswer(booted, "todo done");
		probe.onShake = () => {
			probe.branch.current = [
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
								id: "todo-1",
								name: "todo",
								arguments: { i: "Closing validation task", todos: [] },
							},
						],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "todo-1",
						toolName: "todo",
						content: [{ type: "text", text: "[shaken ~40 tokens]" }],
						isError: false,
					},
				},
				{ type: "message", message: assistant("todo done") },
			];
		};
		await finishRun(booted, "todo done");
		expect(visibleRows(booted.transcript).join("\n")).not.toContain(
			"Closing validation task",
		);
		await drainShake();
		expect(probe.calls).toHaveLength(1);
		// stock's post-shake rebuild: the card is reconstructed with a
		// discarded id and only `updateResult(result, isPartial, id)` carries
		// the exact ownership.
		booted.transcript.clear();
		const rebuilt = addToolComponent(
			booted,
			"todo",
			{ i: "Closing validation task", todos: [] },
			"todo-1",
		);
		rebuilt.render = () => ["native todo card"];
		rebuilt.updateResult(
			{ content: [{ type: "text", text: "[shaken ~40 tokens]" }] },
			false,
			"todo-1",
		);
		addAnswer(booted, "todo done");
		await flushMicrotasks();
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("todo done");
		// the rebuilt card belongs to a finalized filtered turn: it must stay
		// hidden, neither as a compact row nor as the stock card
		expect(rows).not.toContain("Closing validation task");
		expect(rows).not.toContain("native todo card");
		await shutdown(booted);
	},
);
