import { describe, expect, test } from "bun:test";
import {
	formatGitRecords,
	type GitEvidence,
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
		expect(recognizeGitCommands("git status --short")?.[0]?.subcommand).toBe(
			"status",
		);
		expect(
			recognizeGitCommands("cd repo && git commit -m 'Fix compact log'")?.[0]
				?.subcommand,
		).toBe("commit");
		expect(
			recognizeGitCommands("git -C repo switch feature/compact")?.[0]
				?.subcommand,
		).toBe("switch");
	});

	test("does not classify quoted words or ambiguous shell text as Git", () => {
		expect(recognizeGitCommands("echo git status")).toBeUndefined();
		expect(
			recognizeGitCommands("printf '%s' 'git commit -m nope'"),
		).toBeUndefined();
		expect(recognizeGitCommands("git status && echo done")).toBeUndefined();
		expect(recognizeGitCommands("echo hi && git status")).toBeUndefined();
		expect(
			recognizeGitCommands("cd repo && git status && echo done"),
		).toBeUndefined();
	});

	test("exposes the gated cd-prefix flag on every recognized command", () => {
		expect(recognizeGitCommands("git status")?.[0]).toEqual({
			subcommand: "status",
			gated: false,
		});
		expect(recognizeGitCommands("command git status")?.[0]).toEqual({
			subcommand: "status",
			gated: false,
		});
		expect(recognizeGitCommands("git -C repo status")?.[0]).toEqual({
			subcommand: "status",
			gated: false,
		});
		expect(recognizeGitCommands("cd repo && git status")?.[0]).toEqual({
			subcommand: "status",
			gated: true,
		});
		expect(recognizeGitCommands("cd /missing && git status")?.[0]).toEqual({
			subcommand: "status",
			gated: true,
		});
	});

	test("recognizes short pager flags -p/-P like their long forms", () => {
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
		expect(formatGitRecords(evidence)?.[0]?.text).toBe(
			"git commit abc1234 Fix compact log",
		);
	});

	test("pager-flagged commits still surface the evidence hash", () => {
		expect(
			formatGitRecords({
				command: "git -p commit -m 'Fix compact log'",
				resultText: "[main abc1234] Fix compact log\n 1 file changed",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit abc1234 Fix compact log");
		expect(
			formatGitRecords({
				command: "git -P commit -m 'Fix compact log'",
				resultText: "[main abc1234] Fix compact log\n 1 file changed",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit abc1234 Fix compact log");
	});

	test("retains failed records with an explicit marker", () => {
		expect(
			formatGitRecords({
				command: "git rebase main",
				resultText: "conflict",
				isError: true,
			})?.[0]?.text,
		).toBe("✗ git rebase main");
	});

	test("retains failed command-wrapped and -C invocations", () => {
		expect(
			formatGitRecords({
				command: "command git rebase main",
				resultText: "conflict",
				isError: true,
			})?.[0]?.text,
		).toBe("✗ git rebase main");
		expect(
			formatGitRecords({
				command: "git -C repo rebase main",
				resultText: "conflict",
				isError: true,
			})?.[0]?.text,
		).toBe("✗ git rebase main");
	});

	test("fails closed for a failed cd-gated Git command", () => {
		expect(
			formatGitRecords({
				command: "cd /missing && git status",
				resultText: "cd: no such file or directory: /missing",
				isError: true,
			})?.[0]?.text,
		).toBeUndefined();
	});

	test("keeps successful gated commands recognized", () => {
		expect(
			formatGitRecords({
				command: "cd repo && git status",
				resultText: " M feature.md\n",
				isError: false,
			})?.[0]?.text,
		).toBe("git status M feature.md");
		expect(
			formatGitRecords({
				command: "cd repo && git commit -m 'Fix compact log'",
				resultText: "[main abc1234] Fix compact log\n 1 file changed",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit abc1234 Fix compact log");
	});

	test("ambiguous multi-command strings never format as Git", () => {
		expect(
			formatGitRecords({
				command: "git status && echo done",
				resultText: " M feature.md",
				isError: false,
			})?.[0]?.text,
		).toBeUndefined();
	});

	test("oneLine drops DEL, C1, and line separators while keeping astral text", () => {
		// Shared rejected class (display-control): C1 must not survive into a
		// git row even though oneLine still collapses whitespace runs itself.
		// Printable remnants after a dropped single-byte CSI (e.g. "[31m")
		// stay — same as sanitizeOneLine after stripControl.
		expect(
			formatGitRecords({
				command: "git commit -m 'x'",
				resultText: "[main abcd] hi\x7Fthere\x9B[31m🚀\u2028bye\u2029",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit abcd hi there [31m🚀 bye");
	});

	test("appendDetail truncates at code points without splitting astral pairs", () => {
		// "git checkout" is 12 code points; MAX_RECORD_LENGTH is 240.
		// Available budget for detail is 240 - 12 - 1 = 227 code points.
		// Placing an emoji at the 226th position in detail means:
		// 225 ASCII + 1 emoji ("🚀") + trailing text.
		// Truncating to available - 1 = 226 code points keeps the whole emoji + "…".
		const longBranch = `${"a".repeat(225)}🚀tail`;
		const record = formatGitRecords({
			command: `git checkout ${longBranch}`,
			resultText: "Switched to branch",
			isError: false,
		})?.[0]?.text;
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
		const record = formatGitRecords({
			command: `git checkout ${longBranch}`,
			resultText: "Switched to branch",
			isError: false,
		})?.[0]?.text;
		expect(record).toBe(`git checkout ${"a".repeat(226)}…`);
		expect(record?.length).toBe(240);
	});

	test("renderInvocation collects subsequent tokens when earlier astral tokens inflate UTF-16 length", () => {
		const emojiPattern = "🚀".repeat(120);
		const record = formatGitRecords({
			command: `git log -n 1 --grep ${emojiPattern} --oneline`,
			resultText: "abc1234 feat",
			isError: false,
		})?.[0]?.text;
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
		expect(recognizeGitCommands("git status | cat")).toBeUndefined();
		expect(recognizeGitCommands("git status || echo hi")).toBeUndefined();
		expect(recognizeGitCommands("git status; echo done")).toBeUndefined();
		expect(recognizeGitCommands("git status;")).toBeUndefined();
		expect(recognizeGitCommands("; git status")).toBeUndefined();
		expect(recognizeGitCommands("git status;; git diff")).toBeUndefined();
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

	test("recognizes a ;-joined Git chain in command order", () => {
		expect(
			recognizeGitCommands(
				"git status --porcelain; git diff -- Cargo.toml Cargo.lock",
			),
		).toEqual([
			{ subcommand: "status", gated: false },
			{ subcommand: "diff", gated: false },
		]);
	});

	test("formats a ;-joined status/diff chain into two rows like its && twin", () => {
		const records = formatGitRecords({
			command: "git status --porcelain; git diff -- Cargo.toml Cargo.lock",
			resultText:
				" M Cargo.toml\n M Cargo.lock\n@@ -1,2 +1,3 @@\n toml\n+# modified\n",
			isError: false,
		});
		expect(records?.map((record) => record.text)).toEqual([
			"git status --porcelain",
			"git diff -- Cargo.toml Cargo.lock",
		]);
		expect(records?.map((record) => record.subcommand)).toEqual([
			"status",
			"diff",
		]);
	});

	test("a chain mixing ; and && keeps all three segments in command order", () => {
		expect(
			recognizeGitCommands("git add a; git commit -m x && git push"),
		).toEqual([
			{ subcommand: "add", gated: false },
			{ subcommand: "commit", gated: false },
			{ subcommand: "push", gated: false },
		]);
	});

	test("cd-gates a ;-joined segment exactly like its && twin", () => {
		expect(recognizeGitCommands("cd repo; git status")).toEqual([
			{ subcommand: "status", gated: true },
		]);
	});

	test("recognizes a previously-rejected ; chain as a positive case", () => {
		expect(recognizeGitCommands("git status ; git diff")).toEqual([
			{ subcommand: "status", gated: false },
			{ subcommand: "diff", gated: false },
		]);
		expect(
			recognizeGitCommands("git status ; git diff")?.map(
				(record) => record.subcommand,
			),
		).toEqual(["status", "diff"]);
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

describe("commit summary banner recognition", () => {
	test("two banner-shaped lines attribute nothing", () => {
		// A pre-commit hook prints a banner-shaped line (legal ref name plus
		// hex — `pre-commit` is a valid ref token) before the real one. Both
		// lines match, so the capture is ambiguous: no ordering rule can
		// tell them apart, and the plugin attributes nothing instead of
		// picking one and storing a hook line as commit evidence.
		expect(
			formatGitRecords({
				command: "git commit -m x",
				resultText:
					"[pre-commit a1b2c3d] restoring build cache\n" +
					"[main 0badf00d] real subject\n 1 file changed",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit -m x");
		expect(
			formatGitRecords({
				command: "git commit -m x",
				resultText:
					"[lefthook deadbeef] run checks\n" + "[main a1b2c3d] real subject",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit -m x");
	});

	test("a banner-shaped hook line after the real banner also attributes nothing", () => {
		// post-commit-shaped: a banner-shaped line after the genuine banner
		// makes the capture ambiguous exactly like one before it — the rule
		// is uniqueness in the window, not first/last position.
		expect(
			formatGitRecords({
				command: "git commit -m x",
				resultText:
					"[main 0badf00d] real subject\n 1 file changed\n" +
					"[main deadbeef] post-commit message",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit -m x");
	});

	test("ANSI-wrapped banner-shaped hook output cannot fabricate a hash", () => {
		// After ANSI stripping the mimic has exactly the banner shape, so the
		// window holds two banner-shaped lines: ambiguous, no attribution.
		expect(
			formatGitRecords({
				command: "git commit -m x",
				resultText:
					"\x1b[31m[main deadbeef] spoof\x1b[0m\n" +
					"[main 0badf00d] real subject\n 1 file changed",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit -m x");
	});

	test("a non-ref bracket line cannot fabricate a hash on its own", () => {
		// "a[b" is not a valid git ref name (refnames forbid "["), so with no
		// real banner in the captured output the row stays unadorned.
		expect(
			formatGitRecords({
				command: "git commit -m x",
				resultText: "[a[b 0badf00d] spoof",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit -m x");
	});

	test("label-and-hash hook lines without brackets never fabricate a hash", () => {
		const rows = formatGitRecords({
			command: "git commit -m x",
			resultText: [
				"clean        : git commit a1b2c3d real subject",
				"hook chatter : git commit deadbeef restoring build cache",
				"ansi spoof   : git commit 0badf00d spoof",
				"[main 0badf00d] real subject",
				" 1 file changed",
			].join("\n"),
			isError: false,
		});
		expect(rows?.[0]?.text).toBe("git commit 0badf00d real subject");
	});

	test("root-commit and detached-HEAD banners stay recognized", () => {
		expect(
			formatGitRecords({
				command: "git commit -m x",
				resultText: "[main (root-commit) 8a2c4d5] initial\n 1 file changed",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit 8a2c4d5 initial");
		expect(
			formatGitRecords({
				command: "git commit -m x",
				resultText: "[detached HEAD 82e797a] wip",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit 82e797a wip");
	});
});

describe("commit messages built by an inert substitution", () => {
	const quietChain =
		"cd /repo && git add src/a.rs && git commit -q -m \"$(printf 'fix: turn the spinner from the wall clock\\n\\nThe phase came from the dictation timer.')\" && git log --oneline -1";

	test("recognizes the quiet commit chain written for a message with a body", () => {
		expect(recognizeGitCommands(quietChain)).toEqual([
			{ subcommand: "add", gated: true },
			{ subcommand: "commit", gated: false },
			{ subcommand: "log", gated: false },
		]);
	});

	test("renders a substituted message as one collapsed line", () => {
		expect(
			formatGitRecords({
				command: "git commit -m \"$(printf 'fix: subject\\n\\nbody text')\"",
				resultText: "",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit -m fix: subject body text");
	});

	test("a banner still owns the hash of a substituted message", () => {
		expect(
			formatGitRecords({
				command: "git commit -m \"$(printf 'fix: subject\\n\\nbody')\"",
				resultText: "[main abc1234] fix: subject\n 1 file changed",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit abc1234 fix: subject");
	});

	test("rejects every substitution that could run another command", () => {
		for (const command of [
			'git commit -m "$(git rev-parse HEAD)"',
			'git commit -m "$(cat message.txt)"',
			"git commit -m \"$(printf '%s' subject)\"",
			"git commit -m \"$(printf 'a' 'b')\"",
			'git commit -m "$(echo -e bad)"',
			"git commit -m \"$(printf 'a\\qb')\"",
			'git commit -m "$(printf "$(printf \'x\')")"',
			"git commit -m \"$(printf 'x'\"",
			"git commit -m $(printf 'x')",
		])
			expect(recognizeGitCommands(command)).toBeUndefined();
	});

	test("a single-quoted substitution stays the literal text shell passes", () => {
		expect(
			formatGitRecords({
				command: "git commit -m '$(printf x)'",
				resultText: "",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit -m $(printf x)");
	});
});

describe("brace-expanded pathspecs", () => {
	test("recognizes a brace list inside a pathspec word", () => {
		expect(
			recognizeGitCommands(
				"git add src/hud/{scene.rs,panel.rs} && git commit -m x",
			),
		).toEqual([
			{ subcommand: "add", gated: false },
			{ subcommand: "commit", gated: false },
		]);
	});

	test("renders the brace list verbatim instead of expanding it", () => {
		expect(
			formatGitRecords({
				command: "git add src/hud/{scene.rs,panel.rs}",
				resultText: "",
				isError: false,
			})?.[0]?.text,
		).toBe("git add src/hud/{scene.rs,panel.rs}");
	});

	test("a brace command group is still rejected", () => {
		expect(recognizeGitCommands("{ git status; }")).toBeUndefined();
		expect(recognizeGitCommands("git status; }")).toBeUndefined();
		expect(recognizeGitCommands("git add a && { git commit -m x; }")).toBe(
			undefined,
		);
	});
});

describe("quiet commit hash attribution", () => {
	test("a git log right after a quiet commit proves its hash", () => {
		const rows = formatGitRecords({
			command:
				"cd /repo && git add src/a.rs && git commit -q -m \"$(printf 'fix: turn the spinner from the wall clock\\n\\nbody')\" && git log --oneline -1",
			resultText:
				"3f52b2f fix: turn the spinner from the wall clock\n\n\nWall time: 0.20 seconds",
			isError: false,
		});
		expect(rows?.map((row) => row.text)).toEqual([
			"git add src/a.rs",
			"git commit 3f52b2f fix: turn the spinner from the wall clock",
			"git log --oneline -1",
		]);
	});

	test("clustered and inline message flags carry the same proof", () => {
		expect(
			formatGitRecords({
				command: "git commit -qm 'fix: a' && git log --oneline -1",
				resultText: "3f52b2f fix: a",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit 3f52b2f fix: a");
		expect(
			formatGitRecords({
				command: "git commit --message='fix: a' && git log --oneline -1",
				resultText: "3f52b2f fix: a",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit 3f52b2f fix: a");
	});

	test("a subject mismatch attributes nothing", () => {
		expect(
			formatGitRecords({
				command: "git commit -q -m 'fix: a' && git log --oneline -1",
				resultText: "3f52b2f fix: b",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit -q -m fix: a");
	});

	test("a log before the commit never lends its hash", () => {
		// The pre-commit HEAD can carry the same subject after an amend or a
		// retried commit, and its line comes first in the capture.
		expect(
			formatGitRecords({
				command:
					"git log --oneline -1 && git commit -q -m 'fix: a' && git log --oneline -1",
				resultText: "3f52b2f fix: a",
				isError: false,
			})?.[1]?.text,
		).toBe("git commit -q -m fix: a");
	});

	test("a quiet commit without a following log stays hashless", () => {
		expect(
			formatGitRecords({
				command: "git commit -q -m 'fix: a' && git status --porcelain",
				resultText: " M src/a.rs",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit -q -m fix: a");
	});

	test("an older commit with the same subject cannot lend its hash", () => {
		// HEAD is the first line of git log output: when the leading
		// hash-shaped line is not the new commit, nothing is attributed.
		expect(
			formatGitRecords({
				command: "git commit -q -m 'fix: a' && git log --oneline -3",
				resultText: "0000abc other subject\n3f52b2f fix: a",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit -q -m fix: a");
	});

	test("a commit without a message flag stays hashless", () => {
		expect(
			formatGitRecords({
				command: "git commit -q -F message.txt && git log --oneline -1",
				resultText: "3f52b2f fix: a",
				isError: false,
			})?.[0]?.text,
		).toBe("git commit -q -F message.txt");
	});
});
