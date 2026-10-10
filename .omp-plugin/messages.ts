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
	/** Assistant/start entry that owns this write, independent of append timing. */
	sourceEntryId?: string;
	/** Proven empty-file creation; zero line counts alone do not prove a change. */
	created?: true;
	/**
	 * Origin tool of the mutation: "write" (full-file write), "edit"
	 * (edit/update operations), or "delete" (delete operations, exact
	 * removed counts only). Legacy delete entries persisted before the
	 * "delete" toolName existed carry "edit" and keep rendering as edit rows.
	 */
	toolName: "write" | "edit" | "delete";
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
	/** Legacy: written by 1.3.3 and earlier, never read; still bounded on load. */
	shortHash?: string;
	/** Legacy: written by 1.3.3 and earlier, never read; still bounded on load. */
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

/**
 * Accepts the two shapes the plugin itself persists under
 * `MUTATION_MESSAGE_TYPE`:
 * - a counted mutation (`exact: true` with bounded `added`/`removed`);
 * - a count-less delete (`exact: false`, no counts), written by `deleteEntry`
 *   in `audit-diff.ts` (reached through `completeEditMutations`) when the path
 *   is real but the exact pre-image is unavailable. The path is genuine
 *   evidence, so the row is shown without invented stats — rejecting it here
 *   would silently drop the only record of a delete on every rebuild and
 *   branch hydration while the live session still shows it.
 *
 * Counts are required exactly when the entry claims exactness, so no
 * `exact: true` aggregate can ever be assembled from unbounded or missing
 * numbers, and `state.entry.mutation.exact` stays false while a count-less
 * entry is present.
 */
export function isMutationMessageDetails(
	value: unknown,
): value is
	| MutationMessageDetails
	| (LegacyMutationMessageDetails & { toolCallId: string }) {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<MutationMessageDetails>;
	if (
		!isBoundedString(details.toolCallId, MAX_TOOL_CALL_ID_LENGTH) ||
		!(
			details.toolName === "write" ||
			details.toolName === "edit" ||
			details.toolName === "delete"
		) ||
		!isBoundedString(details.path, MAX_EVIDENCE_PATH_LENGTH)
	)
		return false;
	if (
		details.created !== undefined &&
		(details.created !== true ||
			details.toolName !== "write" ||
			details.exact !== true ||
			details.added !== 0 ||
			details.removed !== 0)
	)
		return false;
	if (
		details.sourceEntryId !== undefined &&
		(details.toolName !== "write" ||
			details.sourceEntryId === "" ||
			!isBoundedString(details.sourceEntryId, MAX_TOOL_CALL_ID_LENGTH))
	)
		return false;
	if (details.exact === true)
		return (
			details.version === 1 &&
			isBoundedCount(details.added, MAX_MUTATION_COUNT) &&
			isBoundedCount(details.removed, MAX_MUTATION_COUNT)
		);
	// Count-less delete exactly as `deleteEntry` writes it: no `version`, no
	// numbers. A partially counted inexact entry is not a shape the plugin
	// produces, so it stays rejected rather than hydrating half a claim.
	return (
		details.exact === false &&
		details.toolName === "delete" &&
		details.version === undefined &&
		details.added === undefined &&
		details.removed === undefined
	);
}

/** A persisted source must identify this write, not merely reuse its model id. */
export function writeSourceEntryId(
	value: unknown,
	toolCallId: string,
): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const entry = value as Record<string, unknown>;
	if (!isBoundedString(entry.id, MAX_TOOL_CALL_ID_LENGTH) || entry.id === "")
		return undefined;
	if (entry.type === "custom" && entry.customType === "tool_execution_start") {
		const data = entry.data as Record<string, unknown> | undefined;
		return data?.toolCallId === toolCallId && data.toolName === "write"
			? entry.id
			: undefined;
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message as Record<string, unknown> | undefined;
	if (message?.role !== "assistant" || !Array.isArray(message.content))
		return undefined;
	for (const value of message.content) {
		if (!value || typeof value !== "object") continue;
		const call = value as Record<string, unknown>;
		if (
			call.type === "toolCall" &&
			call.id === toolCallId &&
			call.name === "write"
		)
			return entry.id;
	}
	return undefined;
}

/**
 * Custom entries append at the live leaf, but delayed write evidence belongs
 * immediately after its source in every branch containing that source. This
 * is a read-only replay view: no journal entries or native leaf are rewritten.
 * ponytail: O(journal size) on rebuild; index by source if wide trees make
 * replay slow. Keep native append-only persistence instead of a second store.
 */
export function mutationBranchEntries(
	branch: readonly unknown[],
	entries: readonly unknown[],
): readonly unknown[] {
	let owners: Map<string, unknown> | undefined;
	let scoped: Map<string, unknown[]> | undefined;
	let hasScoped = false;
	for (const value of entries) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		if (entry.type !== "custom" || entry.customType !== MUTATION_MESSAGE_TYPE)
			continue;
		const details = entry.data as Partial<MutationMessageDetails> | undefined;
		if (!details || details.sourceEntryId === undefined) continue;
		hasScoped = true;
		if (!isMutationMessageDetails(details) || !details.sourceEntryId) continue;
		if (!owners) {
			owners = new Map();
			for (const value of branch) {
				if (!value || typeof value !== "object") continue;
				const entry = value as Record<string, unknown>;
				if (typeof entry.id === "string") owners.set(entry.id, entry);
			}
		}
		if (
			writeSourceEntryId(
				owners.get(details.sourceEntryId),
				details.toolCallId,
			) !== details.sourceEntryId
		)
			continue;
		scoped ??= new Map();
		const list = scoped.get(details.sourceEntryId);
		if (list) list.push(entry);
		else scoped.set(details.sourceEntryId, [entry]);
	}
	if (!hasScoped) return branch;
	const replay: unknown[] = [];
	for (const value of branch) {
		const entry =
			value && typeof value === "object"
				? (value as Record<string, unknown>)
				: undefined;
		const details = entry?.data as Partial<MutationMessageDetails> | undefined;
		if (
			entry?.type === "custom" &&
			entry.customType === MUTATION_MESSAGE_TYPE &&
			details?.sourceEntryId !== undefined
		)
			continue;
		replay.push(value);
		if (typeof entry?.id === "string") {
			const evidence = scoped?.get(entry.id);
			if (evidence) for (const entry of evidence) replay.push(entry);
		}
	}
	return replay;
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
