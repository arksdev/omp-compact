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
	MAX_TOOL_NAME_LENGTH,
} from "./hydration-bounds";

/**
 * Persisted message-type discriminators. The `omp-compact-` prefix scopes
 * them to this plugin; OMP does not provide cross-plugin namespace
 * isolation, so the prefix is the only collision guard. Never change
 * these values without a migration: existing JSONL branches use them as
 * persistent keys.
 */
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

/**
 * Details for an "omp-compact-git" message.
 *
 * The top-level `subcommand`, `text`, and `isError` fields are legacy
 * single-record fields kept for backward compatibility. When `records` is
 * present, it carries the ordered per-command rows from a single Bash call
 * that ran several Git commands; consumers MUST use `records` whenever it
 * is present, falling back to the top-level fields only for legacy
 * single-record entries.
 */
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

export function isLegacyMutationMessageDetails(
	value: unknown,
): value is LegacyMutationMessageDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<LegacyMutationMessageDetails>;
	return (
		(details.toolCallId === undefined ||
			isBoundedString(details.toolCallId, MAX_TOOL_CALL_ID_LENGTH)) &&
		isBoundedString(details.toolName, MAX_TOOL_NAME_LENGTH) &&
		isBoundedString(details.path, MAX_EVIDENCE_PATH_LENGTH) &&
		(details.added === undefined ||
			isBoundedCount(details.added, MAX_MUTATION_COUNT)) &&
		(details.removed === undefined ||
			isBoundedCount(details.removed, MAX_MUTATION_COUNT)) &&
		(details.lineCount === undefined ||
			isBoundedCount(details.lineCount, MAX_MUTATION_COUNT)) &&
		typeof details.exact === "boolean"
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
			details.records.length > 0 &&
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
