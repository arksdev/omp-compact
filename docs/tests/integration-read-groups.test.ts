import { afterAll, expect } from "bun:test";
import {
	addAnswer,
	beginRun,
	bootWithTranscript,
	cleanupGeneratedDirs,
	dispatch,
	finishRun,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";

afterAll(cleanupGeneratedDirs);

stockTest("native read group remains live, neutral, then filters", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "read-1",
		toolName: "read",
		args: { path: "src/a.ts" },
	});
	const group = new booted.host.ReadToolGroupComponent();
	booted.transcript.addChild(group);
	group.updateArgs({ path: "src/a.ts" }, "read-1");
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "read-2",
		toolName: "read",
		args: { path: "src/b.ts" },
	});
	group.updateArgs({ path: "src/b.ts" }, "read-2");
	const liveRaw = booted.transcript.render(120).join("\n");
	const live = Bun.stripANSI(liveRaw);
	expect(live).toContain("src/a.ts");
	expect(live).toContain("src/b.ts");
	expect(liveRaw).not.toContain(booted.host.getTheme().getFgAnsi("accent"));
	for (const id of ["read-1", "read-2"]) {
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			id,
		);
	}
	addAnswer(booted, "read done");
	await finishRun(booted, "read done");
	const completed = visibleRows(booted.transcript).join("\n");
	expect(completed).not.toContain("src/a.ts");
	expect(completed).toContain("read done");
	await shutdown(booted);
});

stockTest(
	"a single grouped read renders one compact lower-case row",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		// Stock ordering: the host creates the group and calls updateArgs
		// BEFORE the extension's tool_execution_start event creates the state.
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/a.ts" }, "read-1");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "src/a.ts" },
		});
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-1",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("• read src/a.ts");
		expect(live).not.toContain("● Read");
		expect(live).not.toContain("Read src");
		expect(
			visibleRows(booted.transcript).filter((row) => row.includes("read src/")),
		).toHaveLength(1);
		addAnswer(booted, "read done");
		await finishRun(booted, "read done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("src/a.ts");
		expect(completed).toContain("read done");
		await shutdown(booted);
	},
);

stockTest(
	"grouped reads render one compact row per call in start order despite reordered updates",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		// Stock ordering: group updates arrive before the extension events;
		// here they also arrive in reverse chronological order.
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/b.ts" }, "read-2");
		group.updateArgs({ path: "src/a.ts" }, "read-1");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "src/a.ts" },
		});
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-2",
			toolName: "read",
			args: { path: "src/b.ts" },
		});
		for (const id of ["read-1", "read-2"] as const) {
			await dispatch(booted, {
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "read",
				result: { content: [{ type: "text", text: "ok" }], details: {} },
				isError: false,
			});
			group.updateResult(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				false,
				id,
			);
		}
		const rows = visibleRows(booted.transcript);
		const first = rows.findIndex((row) => row.includes("src/a.ts"));
		const second = rows.findIndex((row) => row.includes("src/b.ts"));
		expect(first).toBeGreaterThanOrEqual(0);
		expect(second).toBe(first + 1);
		expect(rows.filter((row) => row.includes("read src/"))).toHaveLength(2);
		expect(rows.join("\n")).not.toContain("Read src");
		expect(rows.join("\n")).not.toContain("● Read");
		await shutdown(booted);
	},
);

stockTest(
	"a pending grouped read shows the stock working indicator and animates",
	async () => {
		const booted = await bootWithTranscript();
		const theme = booted.host.getTheme() as unknown as {
			getSpinnerFrames?: (name: string) => readonly string[];
			spinnerFrames?: readonly string[];
		};
		const frames =
			theme.getSpinnerFrames?.("activity") ?? theme.spinnerFrames ?? [];
		expect(frames.length).toBeGreaterThan(0);
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-pending",
			toolName: "read",
			args: { path: "src/pending.ts" },
		});
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/pending.ts" }, "read-pending");
		const beforeTick = visibleRows(booted.transcript).join("\n");
		expect(beforeTick).toContain("Working…");
		expect(beforeTick).toContain("src/pending.ts");
		expect(beforeTick).not.toContain("⏳");
		expect(beforeTick).not.toContain("⌛");
		expect(beforeTick).not.toContain("● Read");
		expect(frames.some((frame) => beforeTick.includes(frame))).toBe(true);
		booted.intervalCallbacks[0]?.();
		const afterTick = visibleRows(booted.transcript).join("\n");
		expect(afterTick).toContain("Working…");
		expect(afterTick).not.toEqual(beforeTick);
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-pending",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-pending",
		);
		const settled = visibleRows(booted.transcript).join("\n");
		expect(settled).toContain("• read src/pending.ts");
		expect(settled).not.toContain("Working…");
		await shutdown(booted);
	},
);

stockTest(
	"an error read row keeps the error marker and filters after the answer",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-err",
			toolName: "read",
			args: { path: "src/err.ts" },
		});
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/err.ts" }, "read-err");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-err",
			toolName: "read",
			result: { content: [{ type: "text", text: "missing" }], details: {} },
			isError: true,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "missing" }], details: {} },
			false,
			"read-err",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("✗");
		expect(live).toContain("read src/err.ts");
		expect(live).not.toContain("● Read");
		addAnswer(booted, "err done");
		await finishRun(booted, "err done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("src/err.ts");
		await shutdown(booted);
	},
);

stockTest("abort without an answer keeps compact read rows", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "read-abort",
		toolName: "read",
		args: { path: "src/keep.ts" },
	});
	const group = new booted.host.ReadToolGroupComponent();
	booted.transcript.addChild(group);
	group.updateArgs({ path: "src/keep.ts" }, "read-abort");
	await dispatch(booted, {
		type: "tool_execution_end",
		toolCallId: "read-abort",
		toolName: "read",
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
	});
	group.updateResult(
		{ content: [{ type: "text", text: "ok" }], details: {} },
		false,
		"read-abort",
	);
	await finishRun(booted, "", "aborted");
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("• read src/keep.ts");
	expect(rows).not.toContain("● Read");
	await shutdown(booted);
});

stockTest("an unmapped read group renders natively", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const group = new booted.host.ReadToolGroupComponent();
	booted.transcript.addChild(group);
	group.updateArgs({ path: "src/native.ts" }, "never-tracked");
	const live = visibleRows(booted.transcript).join("\n");
	expect(live).toContain("Read");
	expect(live).toContain("src/native.ts");
	expect(live).not.toContain("• read src/native.ts");
	expect(booted.notifications).toHaveLength(0);
	await shutdown(booted);
});

stockTest(
	"mapped and unmapped read groups keep their terminal safety split",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		// fully mapped group: compact rows while working, hidden at terminal
		const mapped = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(mapped);
		mapped.updateArgs({ path: "src/kept.ts" }, "read-mapped");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-mapped",
			toolName: "read",
			args: { path: "src/kept.ts" },
		});
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-mapped",
			toolName: "read",
			result: { content: [{ type: "text", text: "src" }], details: {} },
			isError: false,
		});
		mapped.updateResult(
			{ content: [{ type: "text", text: "src" }], details: {} },
			false,
			"read-mapped",
		);
		// unmapped group: native surface in every phase, even terminal
		const unmapped = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(unmapped);
		unmapped.updateArgs({ path: "src/native.ts" }, "never-tracked");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("• read src/kept.ts");
		expect(live).not.toContain("• read src/native.ts");
		expect(live).toContain("Read");
		expect(live).toContain("src/native.ts");
		addAnswer(booted, "group done");
		await finishRun(booted, "group done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("group done");
		expect(completed).not.toContain("src/kept.ts");
		expect(completed).not.toContain("• read src/native.ts");
		expect(completed).toContain("Read");
		expect(completed).toContain("src/native.ts");
		await shutdown(booted);
	},
);

stockTest(
	"a group with only unknown entries stays native despite an outstanding read",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-real",
			toolName: "read",
			args: { path: "src/real.ts" },
		});
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		// The outstanding read state may bind by order, but the group's native
		// entry belongs to an id the plugin never tracked: without an
		// updateArgs/updateResult ID match the group must stay native.
		group.updateArgs({ path: "src/unknown.ts" }, "never-tracked");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("Read");
		expect(live).toContain("src/unknown.ts");
		expect(live).not.toContain("• read src/real.ts");
		expect(live).not.toContain("• read src/unknown.ts");
		expect(booted.notifications).toHaveLength(0);
		await shutdown(booted);
	},
);

stockTest(
	"a mixed group with one matched and one unknown entry stays native",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-known",
			toolName: "read",
			args: { path: "src/known.ts" },
		});
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/known.ts" }, "read-known");
		group.updateArgs({ path: "src/mystery.ts" }, "never-tracked");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("Read");
		expect(live).toContain("src/known.ts");
		expect(live).toContain("src/mystery.ts");
		expect(live).not.toContain("• read src/known.ts");
		expect(live).not.toContain("• read src/mystery.ts");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-known",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-known",
		);
		addAnswer(booted, "mixed done");
		await finishRun(booted, "mixed done");
		// terminal filtering must not hide the untracked native entry either
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("Read");
		expect(completed).toContain("src/known.ts");
		expect(completed).toContain("src/mystery.ts");
		expect(booted.notifications).toHaveLength(0);
		await shutdown(booted);
	},
);
