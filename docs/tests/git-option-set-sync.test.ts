import { describe, expect, test } from "bun:test";

import { recognizeGitCommands } from "../../.omp-plugin/git-records";

/**
 * The git chain parser keeps the value-taking option knowledge in TWO
 * independent lists that must always be extended together:
 *   - takesGitOptionValue     (git-records.ts:230) — the space form:
 *     `git -c key=value status` (one token per option, per value).
 *   - hasInlineGitOptionValue (git-records.ts:247) — the inline form:
 *     `git --git-dir=/path status` (option and value in one token).
 * Both list the same nine options today: -C, -c, --config-env, --exec-path,
 * --git-dir, --work-tree, --namespace, --super-prefix, --attr-source.
 *
 * Neither list is exported. This suite pins them through the exported
 * recognizer (recognizeGitCommands, git-records.ts:365) by driving every
 * option in BOTH forms and asserting the subcommand still resolves.
 *
 * The two lists have OPPOSITE failure directions:
 *
 *  1. A FORGOTTEN entry (missing from one or both lists) fails CLOSED and
 *     is at worst silent: the unrecognized token still starts with `-`, so
 *     gitSubcommandIndex (git-records.ts:296) hits its `token.startsWith("-")`
 *     guard and returns undefined — the invocation yields no evidence row.
 *     Never a misparse; absence only.
 *
 *  2. The 18-entry value-free set isValueFreeGitOption (git-records.ts:261)
 *     runs the DANGEROUS direction: if a value-taking option is wrongly
 *     ADDED there (while the two lists above are not extended), the parser
 *     skips only the option token and the option's VALUE token lands as the
 *     git subcommand — false attribution (a history row naming the option's
 *     value as the subcommand) with no error signal at all. Every entry of
 *     that set is therefore pinned in full too.
 *
 * Neither list may be merged into one shared table: gitSubcommandIndex
 * consults takesGitOptionValue BEFORE isValueFreeGitOption, so a single
 * classification table would change the precedence of parsed tokens — an
 * observable parser behavior change, out of scope here.
 *
 * This suite writes nothing; a deliberate production change to any of the
 * three lists must update the matching entry table below in the same commit.
 */
const VALUE_TAKING_OPTIONS = [
	"-C",
	"-c",
	"--config-env",
	"--exec-path",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--attr-source",
] as const;

/** Mirrors isValueFreeGitOption (git-records.ts:261) entry for entry. */
const VALUE_FREE_OPTIONS = [
	"--bare",
	"--no-replace-objects",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--no-optional-locks",
	"--no-lazy-fetch",
	"--paginate",
	"--no-pager",
	"-p",
	"-P",
	"--version",
	"--help",
	"--html-path",
	"--man-path",
	"--info-path",
	"--build-options",
] as const;

const STATUS_ROW = [{ subcommand: "status", gated: false }];

describe("value-taking git options stay in sync across the space and inline forms", () => {
	for (const option of VALUE_TAKING_OPTIONS) {
		test(`space form: git ${option} <value> status resolves to status`, () => {
			expect(recognizeGitCommands(`git ${option} /tmp/repo status`)).toEqual(
				STATUS_ROW,
			);
		});

		test(`inline form: git ${option}=<value> status resolves to status`, () => {
			expect(recognizeGitCommands(`git ${option}=/tmp/repo status`)).toEqual(
				STATUS_ROW,
			);
		});
	}
});

describe("value-free git options stay value-free (no value token becomes a subcommand)", () => {
	for (const option of VALUE_FREE_OPTIONS) {
		test(`git ${option} status resolves to status`, () => {
			expect(recognizeGitCommands(`git ${option} status`)).toEqual(STATUS_ROW);
		});
	}
});
