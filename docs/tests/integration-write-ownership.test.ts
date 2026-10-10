import { afterAll, expect } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import {
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
	flushMicrotasks,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";
import type { TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

stockTest(
	"late write evidence returns to its source branch without leaking through a reused tool id",
	async () => {
		const cwd = fixtureDir("write-branch-owner");
		await mkdir(cwd, { recursive: true });
		const manager = SessionManager.inMemory(cwd);
		const base = manager.appendMessage({
			role: "user",
			content: "base",
			timestamp: 0,
		});
		let transcript: TranscriptInstance | undefined;
		const plugin = await bootPlugin(
			(root, host) => {
				transcript = new host.TranscriptContainer();
				root.addChild(transcript);
			},
			cwd,
			[],
			false,
			undefined,
			{
				sessionManager: manager,
				piMutate(pi) {
					pi.appendEntry = (type: string, data?: unknown) =>
						manager.appendCustomEntry(type, data);
				},
			},
		);
		if (!transcript) throw new Error("native transcript missing");
		const booted = { ...plugin, transcript };
		const toolCallId = "shared-write-id";
		const args = { path: "owned.ts", content: "one\ntwo\n" };
		const callMessage = {
			...assistant("", "toolUse"),
			content: [
				{ type: "toolCall", id: toolCallId, name: "write", arguments: args },
			],
		} as unknown as AssistantMessage;
		const result = {
			content: [],
			details: { resolvedPath: join(cwd, "owned.ts") },
		};
		try {
			await beginRun(booted);
			manager.appendMessage(callMessage);
			const call = await addTool(booted, "write", args, toolCallId);
			writeFileSync(join(cwd, "owned.ts"), args.content);
			await finishTool(booted, call, {
				toolCallId,
				toolName: "write",
				result,
				isError: false,
			});
			manager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "write",
				content: [],
				isError: false,
				timestamp: 1,
			});
			const answer = assistant("written") as unknown as AssistantMessage;
			const sourceLeaf = manager.appendMessage(answer);
			const terminal = dispatchFireAndForget(booted, {
				type: "agent_end",
				messages: [answer],
				willContinue: false,
			});
			// No async filesystem step of the post-image can finish before this
			// synchronous leaf move. The same model tool id now belongs elsewhere.
			manager.branch(base);
			manager.appendMessage({
				role: "user",
				content: "other branch",
				timestamp: 2,
			});
			manager.appendMessage(callMessage);
			manager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "write",
				content: [],
				isError: false,
				timestamp: 3,
			});
			manager.appendMessage(
				assistant("other answer") as unknown as AssistantMessage,
			);
			await terminal;
			const otherLeaf = manager.getLeafId();

			for (const [leaf, ownsEvidence] of [
				[otherLeaf, false],
				[sourceLeaf, true],
			] as const) {
				if (leaf === null) throw new Error("branch leaf missing");
				manager.branch(leaf);
				await dispatch(booted, { type: "session_tree" });
				transcript.clear();
				const replay = addToolComponent(booted, "write", args, toolCallId);
				replay.updateResult(result, false, toolCallId);
				await flushMicrotasks();
				const rows = visibleRows(transcript).join("\n");
				if (ownsEvidence) expect(rows).toContain("+2|0");
				else expect(rows).not.toContain("+2|0");
			}
		} finally {
			await shutdown(booted);
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

for (const alias of [false, true]) {
	stockTest(
		`overlapping writes drop ambiguous counts and recover after settlement (alias=${alias})`,
		async () => {
			const cwd = fixtureDir(`write-overlap-${alias}`);
			await mkdir(cwd, { recursive: true });
			const target = join(cwd, "shared.ts");
			writeFileSync(target, "before\n");
			if (alias) symlinkSync("shared.ts", join(cwd, "alias.ts"));
			const booted = await bootWithTranscript(cwd);
			const result = { content: [], details: { resolvedPath: target } };
			try {
				await beginRun(booted);
				const first = await addTool(
					booted,
					"write",
					{ path: "shared.ts", content: "first\n" },
					"write-first",
				);
				writeFileSync(target, "first\n");
				const firstEnd = dispatchFireAndForget(booted, {
					type: "tool_execution_end",
					toolName: "write",
					toolCallId: "write-first",
					result,
					isError: false,
				});
				first.updateResult(result, false, "write-first");
				const args = {
					path: alias ? "alias.ts" : "shared.ts",
					content: "second\nextra\n",
				};
				// The second capture runs synchronously before the first audit's
				// async post-image read can return. Its alias has the same target.
				const secondStart = dispatchFireAndForget(booted, {
					type: "tool_execution_start",
					toolName: "write",
					toolCallId: "write-second",
					args,
				});
				const second = addToolComponent(booted, "write", args, "write-second");
				writeFileSync(target, args.content);
				const secondEnd = dispatchFireAndForget(booted, {
					type: "tool_execution_end",
					toolName: "write",
					toolCallId: "write-second",
					result,
					isError: false,
				});
				second.updateResult(result, false, "write-second");
				await Promise.all([firstEnd, secondStart, secondEnd]);
				await finishRun(booted, "both completed");
				expect(
					booted.appendedEntries.filter(
						(entry) => entry.customType === "omp-compact-write",
					),
				).toEqual([]);
				expect(visibleRows(booted.transcript).join("\n")).not.toContain(
					"+2|−1",
				);

				await beginRun(booted);
				const recovered = await addTool(
					booted,
					"write",
					{ path: "shared.ts", content: "second\nextra\nrecovered\n" },
					"write-recovered",
				);
				writeFileSync(target, "second\nextra\nrecovered\n");
				await finishTool(booted, recovered, {
					toolCallId: "write-recovered",
					toolName: "write",
					result,
					isError: false,
				});
				await finishRun(booted, "recovered");
				expect(visibleRows(booted.transcript).join("\n")).toContain("+1|0");
			} finally {
				await shutdown(booted);
				await rm(cwd, { recursive: true, force: true });
			}
		},
	);
}
