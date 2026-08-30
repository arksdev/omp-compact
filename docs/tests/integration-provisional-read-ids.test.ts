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

stockTest(
	"a provisional grouped read stays compact through a streamed-id rename",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/stream.ts" }, "read-tmp");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-tmp",
			toolName: "read",
			args: { path: "src/stream.ts" },
		});
		group.renameEntry("read-tmp", "read-final");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-final",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-final",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("• read src/stream.ts");
		expect(live).not.toContain("● Read");
		addAnswer(booted, "rename done");
		await finishRun(booted, "rename done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("src/stream.ts");
		expect(completed).toContain("rename done");
		await shutdown(booted);
	},
);

stockTest(
	"a streamed-id rename merges an existing real-id state into one row",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/merge.ts" }, "read-tmp");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-tmp",
			toolName: "read",
			args: { path: "src/merge.ts" },
		});
		// cumulative ordering: the final-id state already exists when the
		// rename arrives
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-final",
			toolName: "read",
			args: { path: "src/merge.ts" },
		});
		group.renameEntry("read-tmp", "read-final");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-final",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-final",
		);
		const liveRows = visibleRows(booted.transcript);
		expect(
			liveRows.filter((row) => row.includes("read src/merge.ts")),
		).toHaveLength(1);
		expect(liveRows.join("\n")).toContain("• read src/merge.ts");
		expect(liveRows.join("\n")).not.toContain("● Read");
		addAnswer(booted, "merge done");
		await finishRun(booted, "merge done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("src/merge.ts");
		expect(completed).toContain("merge done");
		await shutdown(booted);
	},
);

stockTest("an empty provisional id migrates to its real id", async () => {
	const booted = await bootWithTranscript();
	await beginRun(booted);
	const group = new booted.host.ReadToolGroupComponent();
	booted.transcript.addChild(group);
	group.updateArgs({ path: "src/empty.ts" }, "");
	await dispatch(booted, {
		type: "tool_execution_start",
		toolCallId: "",
		toolName: "read",
		args: { path: "src/empty.ts" },
	});
	group.renameEntry("", "read-empty-final");
	await dispatch(booted, {
		type: "tool_execution_end",
		toolCallId: "read-empty-final",
		toolName: "read",
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
	});
	group.updateResult(
		{ content: [{ type: "text", text: "ok" }], details: {} },
		false,
		"read-empty-final",
	);
	const live = visibleRows(booted.transcript).join("\n");
	expect(live).toContain("• read src/empty.ts");
	expect(live).not.toContain("● Read");
	addAnswer(booted, "empty done");
	await finishRun(booted, "empty done");
	const completed = visibleRows(booted.transcript).join("\n");
	expect(completed).not.toContain("src/empty.ts");
	expect(completed).toContain("empty done");
	await shutdown(booted);
});

stockTest(
	"an empty provisional id can be retracted without sticking the group native",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/gone.ts" }, "");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "",
			toolName: "read",
			args: { path: "src/gone.ts" },
		});
		group.removeEntry("");
		// a later tracked read still renders compact: the retracted empty id
		// no longer blocks the completeness gate
		group.updateArgs({ path: "src/stays.ts" }, "read-keep");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-keep",
			toolName: "read",
			args: { path: "src/stays.ts" },
		});
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("Working… read src/stays.ts");
		expect(live).not.toContain("src/gone.ts");
		expect(live).not.toContain("● Read");
		await shutdown(booted);
	},
);

stockTest(
	"a retracted sibling is dropped from the compact read rows",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const group = new booted.host.ReadToolGroupComponent();
		booted.transcript.addChild(group);
		group.updateArgs({ path: "src/keep.ts" }, "read-keep");
		group.updateArgs({ path: "src/retract.ts" }, "read-retract");
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-keep",
			toolName: "read",
			args: { path: "src/keep.ts" },
		});
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId: "read-retract",
			toolName: "read",
			args: { path: "src/retract.ts" },
		});
		group.removeEntry("read-retract");
		await dispatch(booted, {
			type: "tool_execution_end",
			toolCallId: "read-keep",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
		group.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			false,
			"read-keep",
		);
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("• read src/keep.ts");
		expect(live).not.toContain("src/retract.ts");
		expect(live).not.toContain("● Read");
		await shutdown(booted);
	},
);
