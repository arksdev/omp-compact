import { afterAll, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	addAnswer,
	addTool,
	addToolComponent,
	assistant,
	beginRun,
	bootPlugin,
	bootWithTranscript,
	cleanupGeneratedDirs,
	dispatch,
	dispatchFireAndForget,
	finishRun,
	finishTool,
	fixtureDir,
	groupedRead,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";
import type { TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

// ---------------------------------------------------------------------------
// Fire-and-forget delivery contracts (runtime race regression)
// ---------------------------------------------------------------------------
// Stock AgentSession never awaits extension listener promises, so in the real
// host `tool_execution_start` / `tool_execution_end` / `agent_end` handlers
// overlap in flight. Every test above goes through `dispatch`, which awaits
// each handler, so the sequential suite always observes the previous handler
// fully settled — it cannot reproduce (and therefore masked) the runtime
// race where a new non-empty write ends up with no stats/evidence.
//
// The contracts below model stock delivery with `dispatchFireAndForget`:
// each listener is invoked synchronously and the next event fires without
// awaiting the previous handler's promise. The race is therefore forced
// deterministically: the second handler's synchronous prologue (which must
// consume the audit record) provably runs before the first handler's async
// work — whatever shape it takes — can complete. No sleeps or timers.
//
// File-state determinism for the write audit: the pre-image snapshot must
// not race the native write, and the post-image read happens inside the end
// handler's completion work. Firing start and end back-to-back, then
// settling the start handler (pre-image state fixed, file still absent) and
// writing the file synchronously via `writeFileSync` lands the file before
// any post-image filesystem result can be delivered back to the end
// handler — a happens-before chain, not a timing guess.
//
// Red phase (pre-fix): the audit record was registered only after the start
// handler's capture resolved, so an end event fired before that saw no
// record and published nothing; `agent_end` fired before the end handler's
// audit completed committed a ledger view that can never be rewritten, so
// evidence and retention were lost. Green phase (post-fix): the record
// exists synchronously, the end handler consumes it and publishes exactly
// once, and `agent_end` waits for the run's in-flight audit work before
// filtering.

stockTest(
	"fire-and-forget write start/end overlap still publishes exact +3|0 evidence",
	async () => {
		const cwd = fixtureDir("race-overlap");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "multi.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const toolCallId = "write-race-overlap";
		const startEvent = {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		};
		const endEvent = {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		};
		// Stock delivery: the end event fires without awaiting the start
		// handler; the audit record must already exist for the end handler's
		// synchronous prologue to consume.
		const startPromise = dispatchFireAndForget(booted, startEvent);
		const endPromise = dispatchFireAndForget(booted, endEvent);
		const component = addToolComponent(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			toolCallId,
		);
		// Before-snapshot is complete and the file is still absent; the native
		// write lands synchronously before any post-image read can complete.
		await startPromise;
		writeFileSync(path, "one\ntwo\nthree\n");
		await endPromise;
		component.updateResult(endEvent.result, false, toolCallId);
		addAnswer(booted, "written");
		await finishRun(booted, "written");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: multi.ts");
		expect(rows).toContain("+3|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([
			{
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId,
					toolName: "write",
					path: "multi.ts",
					added: 3,
					removed: 0,
					exact: true,
				},
			},
		]);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"agent_end waits for an in-flight write audit before terminal filtering",
	async () => {
		const cwd = fixtureDir("race-agentend");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "multi.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const toolCallId = "write-race-agentend";
		// Fully settled start, then the native write, then the end event fired
		// without awaiting: the end handler consumes the record and suspends on
		// the post-image audit.
		await dispatch(booted, {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		});
		const component = addToolComponent(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			toolCallId,
		);
		await Bun.write(path, "one\ntwo\nthree\n");
		const endPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		// The terminal answer arrives while the end handler is still awaiting
		// the post-image read. `agent_end` must not commit the filtered view
		// (nor publish the retention entry) before that audit work settles.
		addAnswer(booted, "written");
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("written")],
			willContinue: false,
		});
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([
			{
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId,
					toolName: "write",
					path: "multi.ts",
					added: 3,
					removed: 0,
					exact: true,
				},
			},
		]);
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: multi.ts");
		expect(rows).toContain("+3|0");
		await endPromise;
		component.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			false,
			toolCallId,
		);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"concurrent fire-and-forget writes keep one exact row and entry each",
	async () => {
		const cwd = fixtureDir("race-concurrent");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const pathA = join(cwd, "a.ts");
		const pathB = join(cwd, "b.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const startA = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId: "write-race-a",
			toolName: "write",
			args: { path: "a.ts", content: "untrusted raw input" },
		});
		const componentA = addToolComponent(
			booted,
			"write",
			{ path: "a.ts", content: "untrusted raw input" },
			"write-race-a",
		);
		const startB = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId: "write-race-b",
			toolName: "write",
			args: { path: "b.ts", content: "untrusted raw input" },
		});
		const componentB = addToolComponent(
			booted,
			"write",
			{ path: "b.ts", content: "untrusted raw input" },
			"write-race-b",
		);
		// both end events still fire without awaiting either start handler
		const endA = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId: "write-race-a",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: pathA },
			},
			isError: false,
		});
		const endB = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId: "write-race-b",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: pathB },
			},
			isError: false,
		});
		await Promise.all([startA, startB]);
		writeFileSync(pathA, "one\ntwo\n");
		writeFileSync(pathB, "one\ntwo\nthree\n");
		await Promise.all([endA, endB]);
		componentA.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: pathA },
			},
			false,
			"write-race-a",
		);
		componentB.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: pathB },
			},
			false,
			"write-race-b",
		);
		addAnswer(booted, "written");
		await finishRun(booted, "written");
		const rows = visibleRows(booted.transcript);
		const completed = rows.join("\n");
		expect(completed).toContain("write: a.ts");
		expect(completed).toContain("+2|0");
		expect(completed).toContain("write: b.ts");
		expect(completed).toContain("+3|0");
		// exactly one compact row per write, no duplicates
		expect(rows.filter((line) => line.includes("write: a.ts"))).toHaveLength(1);
		expect(rows.filter((line) => line.includes("write: b.ts"))).toHaveLength(1);
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toHaveLength(2);
		const byToolCallId = new Map(
			booted.appendedEntries.map((entry) => [
				(entry.data as { toolCallId?: string } | undefined)?.toolCallId,
				entry,
			]),
		);
		expect(byToolCallId.get("write-race-a")).toEqual({
			customType: "omp-compact-write",
			data: {
				version: 1,
				toolCallId: "write-race-a",
				toolName: "write",
				path: "a.ts",
				added: 2,
				removed: 0,
				exact: true,
			},
		});
		expect(byToolCallId.get("write-race-b")).toEqual({
			customType: "omp-compact-write",
			data: {
				version: 1,
				toolCallId: "write-race-b",
				toolName: "write",
				path: "b.ts",
				added: 3,
				removed: 0,
				exact: true,
			},
		});
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"fire-and-forget write audit survives a willContinue agent_end",
	async () => {
		const cwd = fixtureDir("race-continue");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "multi.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const toolCallId = "write-race-continue";
		const startPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		});
		const endPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		const component = addToolComponent(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			toolCallId,
		);
		await startPromise;
		writeFileSync(path, "one\ntwo\nthree\n");
		await endPromise;
		component.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			false,
			toolCallId,
		);
		// continuation keeps the run live: no cleanup, row stays visible
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("still working", "toolUse")],
			willContinue: true,
		});
		expect(visibleRows(booted.transcript).join("\n")).toContain(
			"write: multi.ts",
		);
		// the eventual terminal answer keeps the verified row
		addAnswer(booted, "written");
		await finishRun(booted, "written");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: multi.ts");
		expect(rows).toContain("+3|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([
			{
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId,
					toolName: "write",
					path: "multi.ts",
					added: 3,
					removed: 0,
					exact: true,
				},
			},
		]);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"abort commit keeps fire-and-forget write evidence intact",
	async () => {
		const cwd = fixtureDir("race-abort");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "multi.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const toolCallId = "write-race-abort";
		const startPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		});
		const endPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		const component = addToolComponent(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			toolCallId,
		);
		await startPromise;
		writeFileSync(path, "one\ntwo\nthree\n");
		await endPromise;
		component.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			false,
			toolCallId,
		);
		// an aborted run commits the complete log: the row stays with stats
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("", "aborted")],
			willContinue: false,
		});
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("write: multi.ts");
		expect(rows).toContain("+3|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([
			{
				customType: "omp-compact-write",
				data: {
					version: 1,
					toolCallId,
					toolName: "write",
					path: "multi.ts",
					added: 3,
					removed: 0,
					exact: true,
				},
			},
		]);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"no-op write under fire-and-forget delivery stays filtered without evidence",
	async () => {
		const cwd = fixtureDir("race-noop");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "same.ts");
		// the file already exists with its final content before the start
		// event: both the before-snapshot and the post-image read are
		// deterministic and identical
		await Bun.write(path, "same\n");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const toolCallId = "write-race-noop";
		const startPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "same.ts", content: "same\n" },
		});
		const endPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		const component = addToolComponent(
			booted,
			"write",
			{ path: "same.ts", content: "same\n" },
			toolCallId,
		);
		await startPromise;
		await endPromise;
		component.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			false,
			toolCallId,
		);
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("same.ts");
		expect(completed).not.toContain("0|0");
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"a write ended after the terminal commit publishes no late evidence",
	async () => {
		const cwd = fixtureDir("race-lateend");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const path = join(cwd, "multi.ts");
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const toolCallId = "write-race-lateend";
		// the start event fires but the tool never ends before the terminal
		// answer: the record is still pending when agent_end commits
		const startPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId,
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		});
		const component = addToolComponent(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			toolCallId,
		);
		addAnswer(booted, "written");
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("written")],
			willContinue: false,
		});
		// the committed view is authoritative: the late end must fail closed
		await startPromise;
		writeFileSync(path, "one\ntwo\nthree\n");
		await dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			isError: false,
		});
		component.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { resolvedPath: path },
			},
			false,
			toolCallId,
		);
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).not.toContain("write: multi.ts");
		expect(completed).not.toContain("+3|0");
		await shutdown(booted);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"shutdown during an in-flight write audit stays deadlock-free and clean",
	async () => {
		const cwd = fixtureDir("race-shutdown");
		await rm(cwd, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true });
		const booted = await bootWithTranscript(cwd);
		await beginRun(booted);
		const startPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId: "write-race-shutdown",
			toolName: "write",
			args: { path: "multi.ts", content: "untrusted raw input" },
		});
		addToolComponent(
			booted,
			"write",
			{ path: "multi.ts", content: "untrusted raw input" },
			"write-race-shutdown",
		);
		// shutdown and session switch arrive while the capture is in flight
		await dispatch(booted, { type: "session_before_switch" });
		await dispatch(booted, { type: "session_start" });
		await dispatch(booted, { type: "session_shutdown" });
		// the late capture completes without publishing anything or throwing
		await startPromise;
		await dispatch(booted, { type: "session_shutdown" });
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries).toEqual([]);
		await rm(cwd, { recursive: true, force: true });
	},
);

stockTest(
	"multi-Git record bookkeeping stays visible until the terminal filter",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		// the git record is registered synchronously at start, and the end
		// handler's git bookkeeping is synchronous too: even with fire-and-
		// forget delivery the retained row and its evidence entry must be
		// committed with the terminal answer, never after it
		const startPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_start",
			toolCallId: "git-race-compound",
			toolName: "bash",
			args: {
				command: "git add src/a.ts && git commit -m 'Add a'",
			},
		});
		const component = addToolComponent(
			booted,
			"bash",
			{ command: "git add src/a.ts && git commit -m 'Add a'" },
			"git-race-compound",
		);
		const endPromise = dispatchFireAndForget(booted, {
			type: "tool_execution_end",
			toolCallId: "git-race-compound",
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
				],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		await startPromise;
		await endPromise;
		component.updateResult(
			{
				content: [
					{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
				],
				details: { exitCode: 0 },
			},
			false,
			"git-race-compound",
		);
		// while the run is live every invocation of the compound call is visible
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("git add src/a.ts");
		expect(live).toContain("git commit abc1234 Add a");
		addAnswer(booted, "committed");
		await dispatch(booted, {
			type: "agent_end",
			messages: [assistant("committed")],
			willContinue: false,
		});
		// evidence and the retained multi-record row are committed together
		expect(booted.sentMessages).toEqual([]);
		expect(booted.appendedEntries[0]).toMatchObject({
			customType: "omp-compact-git",
			data: {
				toolCallId: "git-race-compound",
				subcommand: "add",
				text: "git add src/a.ts",
				isError: false,
			},
		});
		expect(
			(booted.appendedEntries[0]?.data as { records?: unknown[] })?.records,
		).toEqual([
			{ subcommand: "add", text: "git add src/a.ts", isError: false },
			{
				subcommand: "commit",
				text: "git commit abc1234 Add a",
				isError: false,
			},
		]);
		const rows = visibleRows(booted.transcript);
		const completed = rows.join("\n");
		// the terminal filter collapses the compound call into the aggregate
		// commit summary while the persisted evidence keeps every record
		expect(completed).not.toContain("git add src/a.ts");
		expect(completed).not.toContain("git commit abc1234 Add a");
		expect(completed).toContain("git commit: abc1234");
		expect(rows.filter((row) => row.includes("git commit:")).length).toBe(1);
		await shutdown(booted);
	},
);

stockTest(
	"terminal answer leaves one aggregate Git row after all mutation rows",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const firstEdit = await addTool(
			booted,
			"edit",
			{ input: "replace" },
			"edit-1",
		);
		await finishTool(booted, firstEdit, {
			toolCallId: "edit-1",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "edited" }],
				details: {
					path: "src/first.ts",
					op: "update",
					diff: "-12|old line\n+12|new line",
				},
			},
			isError: false,
		});
		// the Git evidence sits between the mutations and includes a
		// non-commit invocation: the summary must still land after every
		// retained write/edit row, in chronological hash order
		const git = await addTool(
			booted,
			"bash",
			{ command: "git add src/a.ts && git commit -m 'Add a'" },
			"git-mid",
		);
		await finishTool(booted, git, {
			toolCallId: "git-mid",
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
				],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		const status = await addTool(
			booted,
			"bash",
			{ command: "git status --short" },
			"git-status",
		);
		await finishTool(booted, status, {
			toolCallId: "git-status",
			toolName: "bash",
			result: { content: [{ type: "text", text: "clean" }], details: {} },
			isError: false,
		});
		const secondEdit = await addTool(
			booted,
			"edit",
			{ input: "append" },
			"edit-2",
		);
		await finishTool(booted, secondEdit, {
			toolCallId: "edit-2",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "edited" }],
				details: {
					path: "src/second.ts",
					op: "update",
					diff: "+2|line one\n+2|line two",
				},
			},
			isError: false,
		});
		const lateCommit = await addTool(
			booted,
			"bash",
			{ command: "git commit -m 'Fix b'" },
			"git-late",
		);
		await finishTool(booted, lateCommit, {
			toolCallId: "git-late",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "[main f00d55] Fix b" }],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		addAnswer(booted, "done");
		await finishRun(booted, "done");
		const rows = visibleRows(booted.transcript);
		const completed = rows.join("\n");
		// both mutations survive, in order, each as its own compact row
		expect(completed).toContain("edit: src/first.ts");
		expect(completed).toContain("edit: src/second.ts");
		// exactly one aggregate row after the last mutation, chronological hashes
		const summaryRows = rows.filter((row) => row.includes("git commit:"));
		expect(summaryRows).toEqual(["• git commit: abc1234, f00d55"]);
		expect(rows.indexOf("edit: src/second.ts")).toBeLessThan(
			rows.indexOf("• git commit: abc1234, f00d55"),
		);
		// individual and non-commit Git rows are gone from the view
		expect(completed).not.toContain("git add");
		expect(completed).not.toContain("git status");
		expect(completed).not.toContain("git commit abc1234 Add a");
		// persisted evidence keeps every invocation of every Git call
		const gitEntries = booted.appendedEntries.filter(
			(entry) => entry.customType === "omp-compact-git",
		);
		expect(gitEntries).toHaveLength(3);
		expect(gitEntries[0]?.data).toMatchObject({ toolCallId: "git-mid" });
		expect((gitEntries[0]?.data as { records?: unknown[] })?.records).toEqual([
			{ subcommand: "add", text: "git add src/a.ts", isError: false },
			{
				subcommand: "commit",
				text: "git commit abc1234 Add a",
				isError: false,
			},
		]);
		expect(gitEntries[1]?.data).toMatchObject({
			toolCallId: "git-status",
			subcommand: "status",
		});
		expect(gitEntries[2]?.data).toMatchObject({
			toolCallId: "git-late",
			subcommand: "commit",
			text: "git commit f00d55 Fix b",
		});
		await shutdown(booted);
	},
);

stockTest(
	"abort keeps every Git record of the run in the full log",
	async () => {
		const booted = await bootWithTranscript();
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "git add a && git commit -m 'Add a' && git status" },
			"git-abort",
		);
		await finishTool(booted, call, {
			toolCallId: "git-abort",
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "[main abc1234] Add a\n 1 file changed" },
				],
				details: { exitCode: 0 },
			},
			isError: false,
		});
		// abort/error without a terminal answer keeps the full log unfiltered
		await finishRun(booted, "", "aborted");
		const rows = visibleRows(booted.transcript).join("\n");
		expect(rows).toContain("git add a");
		expect(rows).toContain("git commit abc1234 Add a");
		expect(rows).toContain("git status");
		// the aggregate summary row belongs to the filtered phase only
		expect(rows).not.toContain("git commit:");
		await shutdown(booted);
	},
);

stockTest(
	"absolute reads inside the session cwd render relative by default",
	async () => {
		const booted = await bootWithTranscript("/tmp");
		await beginRun(booted);
		await groupedRead(booted, "/tmp/src/a.ts", "read-rel-1");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("• read src/a.ts");
		expect(live).not.toContain("• read /tmp/src/a.ts");
		addAnswer(booted, "rel done");
		await finishRun(booted, "rel done");
		const completed = visibleRows(booted.transcript).join("\n");
		expect(completed).toContain("rel done");
		expect(completed).not.toContain("src/a.ts");
		await shutdown(booted);
	},
);

stockTest(
	"reads of the session cwd itself and of external paths keep their form",
	async () => {
		const booted = await bootWithTranscript("/tmp");
		await beginRun(booted);
		await groupedRead(booted, "/tmp", "read-dot-1");
		await groupedRead(booted, "/etc/hosts", "read-ext-1");
		await groupedRead(booted, "/tmp-2/boundary.ts", "read-boundary-1");
		const live = visibleRows(booted.transcript).join("\n");
		expect(live).toContain("• read .");
		expect(live).toContain("• read /etc/hosts");
		expect(live).toContain("• read /tmp-2/boundary.ts");
		await shutdown(booted);
	},
);

stockTest("write mutation rows relativize the audited path", async () => {
	const cwd = fixtureDir("display-write");
	await rm(cwd, { recursive: true, force: true });
	await mkdir(cwd, { recursive: true });
	const path = join(cwd, "write.ts");
	await Bun.write(path, "const a = 1;\nkeep();\n");
	const booted = await bootWithTranscript(cwd);
	await beginRun(booted);
	const call = await addTool(
		booted,
		"write",
		{ path: path, content: "ignored raw input" },
		"write-display-1",
	);
	await Bun.write(path, "const a = 2;\nkeep();\nextra();\n");
	await finishTool(booted, call, {
		toolCallId: "write-display-1",
		toolName: "write",
		result: {
			content: [{ type: "text", text: "ok" }],
			details: { resolvedPath: path },
		},
		isError: false,
	});
	addAnswer(booted, "display written");
	await finishRun(booted, "display written");
	const rows = visibleRows(booted.transcript).join("\n");
	expect(rows).toContain("write: write.ts");
	expect(rows).toContain("+2|1");
	expect(rows).not.toContain("write: /tmp/omp-compact-display-write/write.ts");
	// persisted evidence keeps the audited absolute path untouched
	expect(booted.appendedEntries[0]).toMatchObject({
		customType: "omp-compact-write",
		data: {
			version: 1,
			toolCallId: "write-display-1",
			path: path,
			added: 2,
			removed: 1,
			exact: true,
		},
	});
	await shutdown(booted);
	await rm(cwd, { recursive: true, force: true });
});

stockTest(
	"a new session with a different cwd re-relativizes display paths",
	async () => {
		const first = await bootWithTranscript("/tmp/session-a");
		await beginRun(first);
		await groupedRead(first, "/tmp/session-a/x.ts", "read-s1");
		expect(visibleRows(first.transcript).join("\n")).toContain("• read x.ts");
		await shutdown(first);

		const second = await bootWithTranscript("/tmp/session-b");
		await beginRun(second);
		await groupedRead(second, "/tmp/session-b/x.ts", "read-s2");
		await groupedRead(second, "/tmp/session-a/x.ts", "read-s3");
		const rows = visibleRows(second.transcript).join("\n");
		expect(rows).toContain("• read x.ts");
		expect(rows).toContain("• read /tmp/session-a/x.ts");
		await shutdown(second);
	},
);

stockTest(
	"replayed absolute reads use the current session cwd for display",
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
					toolCallId: "read-replay-in",
					toolName: "read",
					args: { path: "/tmp/replay-in.ts" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-replay-in",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "read-replay-out",
					toolName: "read",
					args: { path: "/etc/hosts" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-replay-out",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
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
			},
			"/tmp",
			branch,
		);
		if (!transcript) throw new Error("transcript missing");
		const rows = visibleRows(transcript).join("\n");
		expect(rows).toContain("• read replay-in.ts");
		expect(rows).not.toContain("• read /tmp/replay-in.ts");
		expect(rows).toContain("• read /etc/hosts");
		await shutdown(booted);
	},
);
