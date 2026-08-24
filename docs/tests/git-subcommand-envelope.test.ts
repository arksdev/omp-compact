import { describe, expect, test } from "bun:test";

import {
	formatGitRecord,
	formatGitRecords,
	recognizeGitCommands,
} from "../../.omp-plugin/git-records";
import { MAX_GIT_SUBCOMMAND_LENGTH } from "../../.omp-plugin/hydration-bounds";
import { isGitMessageDetails } from "../../.omp-plugin/messages";

/**
 * Persistence envelope of the git-record subcommand field between the write
 * side (git-records.ts parseGitInvocationTokens) and the read/hydration gate
 * (isGitRecordDetails in messages.ts, via isBoundedString with
 * MAX_GIT_SUBCOMMAND_LENGTH = 128).
 *
 * Invariant: anything the write side emits as a git record must satisfy the
 * read side — otherwise the persisted replay row silently vanishes (rejected
 * carriers are skipped at rebuild-lifecycle.ts:641 and the live row that was
 * rendered during the session disappears on replay) with no diagnostic.
 *
 * The write side caps a token at MAX_TOKEN_LENGTH (4_096, tokenizer input
 * budget — a different concern), so a >128-char first token after `git`
 * used to be classified as a git invocation, emitted as a record, persisted,
 * and then rejected by the hydration gate. Fail closed at recognition
 * instead: a subcommand the hydration gate would reject is never a
 * recognized git invocation, so no record (and no carrier) is ever emitted.
 * A row at exactly the limit round-trips; one unit over produces no row at
 * all — both directions are pinned here so neither side can drift alone.
 */
function recordDetails(record: {
	subcommand: string;
	text: string;
	isError: boolean;
}) {
	return {
		version: 1,
		toolCallId: "git-envelope",
		subcommand: record.subcommand,
		text: record.text,
		isError: record.isError,
		records: [record],
	};
}

describe("git subcommand envelope: write side stays inside the hydration gate", () => {
	test("a subcommand at exactly the limit round-trips through the hydration gate", () => {
		const subcommand = "x".repeat(MAX_GIT_SUBCOMMAND_LENGTH);
		const command = `git "${subcommand}"`;

		const recognized = recognizeGitCommands(command);
		expect(recognized?.[0]?.subcommand.length).toBe(MAX_GIT_SUBCOMMAND_LENGTH);

		const records = formatGitRecords({
			command,
			resultText: "fatal: not a git command",
			isError: true,
		});
		expect(records?.length).toBe(1);
		const record = records?.[0];
		expect(record?.subcommand).toBe(subcommand);
		// The exact shape index.ts:940-951 persists: the read gate must accept it.
		const details = record ? recordDetails(record) : undefined;
		expect(isGitMessageDetails(details)).toBe(true);
	});

	test("one unit over the limit emits no record and no carrier (whole call fails closed)", () => {
		const subcommand = "x".repeat(MAX_GIT_SUBCOMMAND_LENGTH + 1);
		const command = `git "${subcommand}"`;

		expect(recognizeGitCommands(command)).toBeUndefined();
		const records = formatGitRecords({
			command,
			resultText: "fatal: not a git command",
			isError: true,
		});
		expect(records).toBeUndefined();
		expect(
			formatGitRecord({
				command,
				resultText: "fatal: not a git command",
				isError: true,
			}),
		).toBeUndefined();

		// A chain with one over-limit member fails the whole call closed —
		// mirroring the read gate, which rejects the entire carrier.
		const chain = formatGitRecords({
			command: `git status && git "${subcommand}"`,
			resultText: " M a.ts\nfatal: not a git command",
			isError: true,
		});
		expect(chain).toBeUndefined();
	});
});
