import {
	isBoundedCount,
	isBoundedString,
	MAX_EVIDENCE_PATH_LENGTH,
	MAX_EVIDENCE_TEXT_LENGTH,
	MAX_GIT_HASH_LENGTH,
	MAX_GIT_RECORDS,
	MAX_GIT_SUBCOMMAND_LENGTH,
	MAX_MUTATION_COUNT,
	MAX_TOOL_CALL_ID_LENGTH,
} from "./hydration-bounds";

export const MUTATION_MESSAGE_TYPE = "omp-compact-write";
export const GIT_MESSAGE_TYPE = "omp-compact-git";

export interface MutationMessageDetails {
	version: 1;
	toolCallId: string;
	toolName: "write" | "edit";
	path: string;
	added: number;
	removed: number;
	exact: true;
}

export interface LegacyMutationMessageDetails {
	toolCallId?: string;
	toolName: string;
	path: string;
	added?: number;
	removed?: number;
	lineCount?: number;
	exact: boolean;
}

export interface GitRecordDetails {
	subcommand: string;
	text: string;
	isError: boolean;
}

export interface GitMessageDetails {
	version: 1;
	toolCallId: string;
	subcommand: string;
	text: string;
	isError: boolean;
	shortHash?: string;
	subject?: string;
	cwd?: string;
	/**
	 * Ordered per-invocation rows when one Bash call ran several Git
	 * commands; absent on legacy entries that carry a single record.
	 */
	records?: GitRecordDetails[];
}

function isGitRecordDetails(value: unknown): value is GitRecordDetails {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<GitRecordDetails>;
	return (
		isBoundedString(record.subcommand, MAX_GIT_SUBCOMMAND_LENGTH) &&
		isBoundedString(record.text, MAX_EVIDENCE_TEXT_LENGTH) &&
		typeof record.isError === "boolean"
	);
}

export function isMutationMessageDetails(
	value: unknown,
): value is MutationMessageDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<MutationMessageDetails>;
	return (
		details.version === 1 &&
		isBoundedString(details.toolCallId, MAX_TOOL_CALL_ID_LENGTH) &&
		(details.toolName === "write" || details.toolName === "edit") &&
		isBoundedString(details.path, MAX_EVIDENCE_PATH_LENGTH) &&
		isBoundedCount(details.added, MAX_MUTATION_COUNT) &&
		isBoundedCount(details.removed, MAX_MUTATION_COUNT) &&
		details.exact === true
	);
}

export function isGitMessageDetails(
	value: unknown,
): value is GitMessageDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<GitMessageDetails>;
	const recordsValid =
		details.records === undefined ||
		(Array.isArray(details.records) &&
			details.records.length <= MAX_GIT_RECORDS &&
			details.records.every(isGitRecordDetails));
	return (
		details.version === 1 &&
		isBoundedString(details.toolCallId, MAX_TOOL_CALL_ID_LENGTH) &&
		isBoundedString(details.subcommand, MAX_GIT_SUBCOMMAND_LENGTH) &&
		isBoundedString(details.text, MAX_EVIDENCE_TEXT_LENGTH) &&
		typeof details.isError === "boolean" &&
		(details.shortHash === undefined ||
			isBoundedString(details.shortHash, MAX_GIT_HASH_LENGTH)) &&
		(details.subject === undefined ||
			isBoundedString(details.subject, MAX_EVIDENCE_TEXT_LENGTH)) &&
		(details.cwd === undefined ||
			isBoundedString(details.cwd, MAX_EVIDENCE_PATH_LENGTH)) &&
		recordsValid
	);
}
