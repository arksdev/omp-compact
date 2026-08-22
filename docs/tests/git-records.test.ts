import { describe, expect, test } from "bun:test";
import {
	formatGitRecord,
	formatGitRecords,
	type GitEvidence,
	recognizeGitCommand,
	recognizeGitCommands,
} from "../../.omp-plugin/git-records";
import {
	MAX_EVIDENCE_PATH_LENGTH,
	MAX_EVIDENCE_TEXT_LENGTH,
	MAX_GIT_HASH_LENGTH,
	MAX_GIT_SUBCOMMAND_LENGTH,
	MAX_TOOL_CALL_ID_LENGTH,
} from "../../.omp-plugin/hydration-bounds";
import { isGitMessageDetails } from "../../.omp-plugin/messages";

describe("Git command recognition", () => {
	test("recognizes direct and cd-prefixed Git invocations", () => {
		expect(recognizeGitCommand("git status --short")?.subcommand).toBe(
			"status",
		);
		expect(
			recognizeGitCommand("cd repo && git commit -m 'Fix compact log'")
				?.subcommand,
		).toBe("commit");
		expect(
			recognizeGitCommand("git -C repo switch feature/compact")?.subcommand,
		).toBe("switch");
	});

	test("does not classify quoted words or ambiguous shell text as Git", () => {
		expect(recognizeGitCommand("echo git status")).toBeUndefined();
		expect(
			recognizeGitCommand("printf '%s' 'git commit -m nope'"),
		).toBeUndefined();
		expect(recognizeGitCommand("git status && echo done")).toBeUndefined();
		expect(recognizeGitCommand("echo hi && git status")).toBeUndefined();
		expect(
			recognizeGitCommand("cd repo && git status && echo done"),
		).toBeUndefined();
	});

	test("exposes the gated cd-prefix flag on every recognized command", () => {
		expect(recognizeGitCommand("git status")).toEqual({
			subcommand: "status",
			gated: false,
		});
		expect(recognizeGitCommand("command git status")).toEqual({
			subcommand: "status",
			gated: false,
		});
		expect(recognizeGitCommand("git -C repo status")).toEqual({
			subcommand: "status",
			gated: false,
		});
		expect(recognizeGitCommand("cd repo && git status")).toEqual({
			subcommand: "status",
			gated: true,
		});
		expect(recognizeGitCommand("cd /missing && git status")).toEqual({
			subcommand: "status",
			gated: true,
		});
	});

	test("recognizes short pager flags -p/-P like their long forms", () => {
		expect(recognizeGitCommand("git -p status")?.subcommand).toBe("status");
		expect(recognizeGitCommand("git -P commit -m x")?.subcommand).toBe(
			"commit",
		);
		expect(recognizeGitCommand("git -p -C repo log")?.subcommand).toBe("log");
		expect(recognizeGitCommand("git --no-pager status")?.subcommand).toBe(
			"status",
		);
		expect(recognizeGitCommands("git -P status && git -p diff")).toEqual([
			{ subcommand: "status", gated: false },
			{ subcommand: "diff", gated: false },
		]);
	});
});

describe("Git record formatting", () => {
	test("uses evidence-backed commit hash and subject", () => {
		const evidence: GitEvidence = {
			command: "git commit -m 'Fix compact log'",
			resultText: "[main abc1234] Fix compact log\n 1 file changed",
			isError: false,
		};
		expect(formatGitRecord(evidence)).toBe(
			"git commit abc1234 Fix compact log",
		);
	});

	test("pager-flagged commits still surface the evidence hash", () => {
		expect(
			formatGitRecord({
				command: "git -p commit -m 'Fix compact log'",
				resultText: "[main abc1234] Fix compact log\n 1 file changed",
				isError: false,
			}),
		).toBe("git commit abc1234 Fix compact log");
		expect(
			formatGitRecord({
				command: "git -P commit -m 'Fix compact log'",
				resultText: "[main abc1234] Fix compact log\n 1 file changed",
				isError: false,
			}),
		).toBe("git commit abc1234 Fix compact log");
	});

	test("retains failed records with an explicit marker", () => {
		expect(
			formatGitRecord({
				command: "git rebase main",
				resultText: "conflict",
				isError: true,
			}),
		).toBe("✗ git rebase main");
	});

	test("retains failed command-wrapped and -C invocations", () => {
		expect(
			formatGitRecord({
				command: "command git rebase main",
				resultText: "conflict",
				isError: true,
			}),
		).toBe("✗ git rebase main");
		expect(
			formatGitRecord({
				command: "git -C repo rebase main",
				resultText: "conflict",
				isError: true,
			}),
		).toBe("✗ git rebase main");
	});

	test("fails closed for a failed cd-gated Git command", () => {
		expect(
			formatGitRecord({
				command: "cd /missing && git status",
				resultText: "cd: no such file or directory: /missing",
				isError: true,
			}),
		).toBeUndefined();
	});

	test("keeps successful gated commands recognized", () => {
		expect(
			formatGitRecord({
				command: "cd repo && git status",
				resultText: " M feature.md\n",
				isError: false,
			}),
		).toBe("git status M feature.md");
		expect(
			formatGitRecord({
				command: "cd repo && git commit -m 'Fix compact log'",
				resultText: "[main abc1234] Fix compact log\n 1 file changed",
				isError: false,
			}),
		).toBe("git commit abc1234 Fix compact log");
	});

	test("ambiguous multi-command strings never format as Git", () => {
		expect(
			formatGitRecord({
				command: "git status && echo done",
				resultText: " M feature.md",
				isError: false,
			}),
		).toBeUndefined();
	});

	test("oneLine drops DEL, C1, and line separators while keeping astral text", () => {
		// Shared rejected class (display-control): C1 must not survive into a
		// git row even though oneLine still collapses whitespace runs itself.
		// Printable remnants after a dropped single-byte CSI (e.g. "[31m")
		// stay — same as sanitizeOneLine after stripControl.
		expect(
			formatGitRecord({
				command: "git commit -m 'x'",
				resultText: "[main abcd] hi\x7Fthere\x9B[31m🚀\u2028bye\u2029",
				isError: false,
			}),
		).toBe("git commit abcd hi there [31m🚀 bye");
	});

	test("appendDetail truncates at code points without splitting astral pairs", () => {
		// "git checkout" is 12 code points; MAX_RECORD_LENGTH is 240.
		// Available budget for detail is 240 - 12 - 1 = 227 code points.
		// Placing an emoji at the 226th position in detail means:
		// 225 ASCII + 1 emoji ("🚀") + trailing text.
		// Truncating to available - 1 = 226 code points keeps the whole emoji + "…".
		const longBranch = `${"a".repeat(225)}🚀tail`;
		const record = formatGitRecord({
			command: `git checkout ${longBranch}`,
			resultText: "Switched to branch",
			isError: false,
		});
		expect(record).toBe(`git checkout ${"a".repeat(225)}🚀…`);
		expect([...(record ?? "")].length).toBe(240);
		expect(
			[...(record ?? "")].every((ch) => {
				const cp = ch.codePointAt(0) ?? 0;
				return cp < 0xd800 || cp > 0xdfff;
			}),
		).toBe(true);
	});

	test("appendDetail preserves exact ASCII truncation behavior", () => {
		const longBranch = "a".repeat(300);
		const record = formatGitRecord({
			command: `git checkout ${longBranch}`,
			resultText: "Switched to branch",
			isError: false,
		});
		expect(record).toBe(`git checkout ${"a".repeat(226)}…`);
		expect(record?.length).toBe(240);
	});

	test("renderInvocation collects subsequent tokens when earlier astral tokens inflate UTF-16 length", () => {
		const emojiPattern = "🚀".repeat(120);
		const record = formatGitRecord({
			command: `git log -n 1 --grep ${emojiPattern} --oneline`,
			resultText: "abc1234 feat",
			isError: false,
		});
		expect(record).toBe(`git log -n 1 --grep ${emojiPattern} --oneline`);
	});
});

describe("Multiple Git invocations in one Bash call", () => {
	test("recognizes each sequential Git segment in command order", () => {
		expect(
			recognizeGitCommands("git add src/a.ts && git commit -m 'Add a'")?.map(
				(record) => record.subcommand,
			),
		).toEqual(["add", "commit"]);
		expect(
			recognizeGitCommands("cd repo && git add a && git commit -m x")?.map(
				(record) => record.gated,
			),
		).toEqual([true, false]);
	});

	test("formats one row per invocation in command order", () => {
		const records = formatGitRecords({
			command: "git add src/a.ts && git commit -m 'Add a'",
			resultText: "[main abc1234] Add a\n 1 file changed",
			isError: false,
		});
		expect(records?.map((record) => record.text)).toEqual([
			"git add src/a.ts",
			"git commit abc1234 Add a",
		]);
	});

	test("attributes output evidence only to the final bare segment", () => {
		const records = formatGitRecords({
			command: "git diff --check && git status",
			resultText: " M feature.md\n",
			isError: false,
		});
		expect(records?.map((record) => record.text)).toEqual([
			"git diff --check",
			"git status M feature.md",
		]);
	});

	test("never attributes a commit summary line to a non-commit segment", () => {
		const records = formatGitRecords({
			command: "git commit -m x && git push",
			resultText: "[main aa11bb] x\n 1 file changed",
			isError: false,
		});
		expect(records?.[0]).toEqual({
			subcommand: "commit",
			text: "git commit aa11bb x",
			isError: false,
		});
		expect(records?.[1]).toEqual({
			subcommand: "push",
			text: "git push",
			isError: false,
		});
	});

	test("recognizes mixed direct, command-wrapped and -C segments", () => {
		const records = recognizeGitCommands(
			"command git add a && git -C repo commit -m x && git status",
		);
		expect(records?.map((record) => record.subcommand)).toEqual([
			"add",
			"commit",
			"status",
		]);
	});

	test("fails closed when any segment is not a Git invocation", () => {
		expect(recognizeGitCommands("git status && echo done")).toBeUndefined();
		expect(recognizeGitCommands("echo hi && git status")).toBeUndefined();
		expect(
			recognizeGitCommands("cd repo && git status && echo done"),
		).toBeUndefined();
		expect(recognizeGitCommands("cd a && cd b && git status")).toBeUndefined();
		expect(recognizeGitCommands("git status ; git diff")).toBeUndefined();
		expect(recognizeGitCommands("git status | cat")).toBeUndefined();
		expect(recognizeGitCommands("git status || echo hi")).toBeUndefined();
	});

	test("fails closed for failed multi-Git chains", () => {
		expect(
			formatGitRecords({
				command: "git add a && git commit -m x",
				resultText: "nothing to commit",
				isError: true,
			}),
		).toBeUndefined();
		expect(
			formatGitRecords({
				command: "cd repo && git add a && git commit -m x",
				resultText: "conflict",
				isError: true,
			}),
		).toBeUndefined();
	});

	test("bounded chains of several Git segments keep order and commit evidence", () => {
		const records = formatGitRecords({
			command: "git add a && git commit -m x && git push",
			resultText: "[main cc33dd] x\n 1 file changed",
			isError: false,
		});
		expect(records?.map((record) => record.text)).toEqual([
			"git add a",
			"git commit cc33dd x",
			"git push",
		]);
	});
});

describe("persisted multi-Git evidence", () => {
	test("accepts bounded ordered record arrays", () => {
		expect(
			isGitMessageDetails({
				version: 1,
				toolCallId: "git-chain",
				subcommand: "add",
				text: "git add a",
				isError: false,
				records: [
					{ subcommand: "add", text: "git add a", isError: false },
					{ subcommand: "status", text: "git status", isError: false },
				],
			}),
		).toBe(true);
	});

	test("rejects malformed or unbounded record arrays", () => {
		const base = {
			version: 1,
			toolCallId: "git-chain",
			subcommand: "add",
			text: "git add a",
			isError: false,
		};
		expect(
			isGitMessageDetails({ ...base, records: [{ text: "missing fields" }] }),
		).toBe(false);
		expect(
			isGitMessageDetails({
				...base,
				records: Array.from({ length: 9 }, () => ({
					subcommand: "status",
					text: "git status",
					isError: false,
				})),
			}),
		).toBe(false);
	});

	test("bounds string fields at limit and over limit", () => {
		const base = {
			version: 1,
			toolCallId: "git-chain",
			subcommand: "add",
			text: "git add a",
			isError: false,
		};
		expect(
			isGitMessageDetails({
				...base,
				toolCallId: "c".repeat(MAX_TOOL_CALL_ID_LENGTH),
			}),
		).toBe(true);
		expect(
			isGitMessageDetails({
				...base,
				toolCallId: "c".repeat(MAX_TOOL_CALL_ID_LENGTH + 1),
			}),
		).toBe(false);
		expect(
			isGitMessageDetails({
				...base,
				subcommand: "s".repeat(MAX_GIT_SUBCOMMAND_LENGTH),
			}),
		).toBe(true);
		expect(
			isGitMessageDetails({
				...base,
				subcommand: "s".repeat(MAX_GIT_SUBCOMMAND_LENGTH + 1),
			}),
		).toBe(false);
		expect(
			isGitMessageDetails({
				...base,
				text: "t".repeat(MAX_EVIDENCE_TEXT_LENGTH),
			}),
		).toBe(true);
		expect(
			isGitMessageDetails({
				...base,
				text: "t".repeat(MAX_EVIDENCE_TEXT_LENGTH + 1),
			}),
		).toBe(false);
		expect(
			isGitMessageDetails({
				...base,
				cwd: "c".repeat(MAX_EVIDENCE_PATH_LENGTH),
			}),
		).toBe(true);
		expect(
			isGitMessageDetails({
				...base,
				cwd: "c".repeat(MAX_EVIDENCE_PATH_LENGTH + 1),
			}),
		).toBe(false);
		expect(
			isGitMessageDetails({
				...base,
				shortHash: "h".repeat(MAX_GIT_HASH_LENGTH),
			}),
		).toBe(true);
		expect(
			isGitMessageDetails({
				...base,
				shortHash: "h".repeat(MAX_GIT_HASH_LENGTH + 1),
			}),
		).toBe(false);
		expect(
			isGitMessageDetails({
				...base,
				records: [
					{
						subcommand: "status",
						text: "t".repeat(MAX_EVIDENCE_TEXT_LENGTH),
						isError: false,
					},
				],
			}),
		).toBe(true);
		expect(
			isGitMessageDetails({
				...base,
				records: [
					{
						subcommand: "status",
						text: "t".repeat(MAX_EVIDENCE_TEXT_LENGTH + 1),
						isError: false,
					},
				],
			}),
		).toBe(false);
	});
});
