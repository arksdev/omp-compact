import { MAX_EVIDENCE_PATH_LENGTH } from "./hydration-bounds";

import type { MutationMessageDetails } from "./messages";

/**
 * F02: evidence budgets for the edit audit. Malformed/oversized evidence
 * fails open locally — the entry keeps its native presentation and the
 * exact candidate is dropped, never invented.
 */

/** Per-file edit diff evidence budget (mirrors the write snapshot byte cap). */
export const MAX_DIFF_BYTES = 1_048_576;

/**
 * Per-file edit diff row budget: a full rewrite of a max-line snapshot is
 * two rows per line (one removed, one added), so this is 2x the snapshot
 * line cap. A diff beyond it cannot be counted exactly and is discarded.
 */
export const MAX_DIFF_ROWS = 100_000;

/** Delete pre-image budgets (mirror the write snapshot caps). */
export const MAX_DELETE_BYTES = 1_048_576;
export const MAX_DELETE_LINES = 50_000;

/** Per-call `perFileResults` file budget of the multi-file edit audit. */
export const MAX_PER_FILE_RESULTS = 128;

/**
 * Cumulative evidence scan budget across the per-file results of one edit
 * call. Individual diffs are capped at MAX_DIFF_BYTES, but an adversarial
 * result with many files each under the cap must still stop after bounded
 * total work; 4x the per-file cap keeps ordinary multi-file edits untouched.
 */
export const MAX_TOTAL_SCAN_BYTES = 4_194_304;

/**
 * F02 diff complexity budget for exact write comparison: maximum combined
 * trimmed-middle lines of one native `diffLines` call. The native
 * Myers-style diff is quadratic in the remaining token count (measured
 * ~140 ms worst case at this bound on the pinned runtime, 92 s at the full
 * snapshot caps), so a static pre-diff gate keeps a hostile snapshot pair
 * from blocking the event loop or the terminal drain. Over the budget the
 * write audit drops the exact candidate (fail open) instead of stalling;
 * localized changes in arbitrarily large files stay exact because the trim
 * shrinks the middle to the changed region only.
 */
export const DIFF_MAX_REMAINING_LINES = 4_000;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

/** Line count shared with the write audit: empty text is 0 lines, a trailing newline does not add a line. */
export function lineCount(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let index = 0; index < text.length; index++)
		if (text.charCodeAt(index) === 10) lines++;
	return text.endsWith("\n") ? lines - 1 : lines;
}

/**
 * Common leading/trailing lines of two snapshots, in native `diffLines`
 * token semantics (a token is the text up to and including its `\n`; the
 * final token has no terminator; a trailing newline creates no empty
 * token). The remaining middle is an upper bound of the native diff's own
 * trimmed middle, so the caller can budget the diff work before the native
 * call. Allocation-free: walks the two strings with charCodeAt/lastIndexOf
 * and never slices, splits or copies.
 */
export function trimmedMiddleLines(
	before: string,
	after: string,
): { beforeLines: number; afterLines: number } {
	let prefix = 0;
	let ia = 0;
	let ib = 0;
	// Common prefix: compare tokens from the start.
	for (;;) {
		let ea = ia;
		while (ea < before.length && before.charCodeAt(ea) !== 10) ea++;
		const la = ea < before.length ? ea + 1 - ia : ea - ia;
		let eb = ib;
		while (eb < after.length && after.charCodeAt(eb) !== 10) eb++;
		const lb = eb < after.length ? eb + 1 - ib : eb - ib;
		if (la === 0 || lb === 0 || la !== lb) break;
		let same = true;
		for (let k = 0; k < la; k++) {
			if (before.charCodeAt(ia + k) !== after.charCodeAt(ib + k)) {
				same = false;
				break;
			}
		}
		if (!same) break;
		prefix++;
		ia += la;
		ib += lb;
	}
	// Common suffix: compare tokens from the end, never crossing the prefix
	// region (ia/ib are token boundaries, so the loop condition also rules
	// out any partial overlap).
	let suffix = 0;
	let endA = before.length;
	let endB = after.length;
	while (endA > ia && endB > ib) {
		const startA = endA >= 2 ? before.lastIndexOf("\n", endA - 2) + 1 : 0;
		const startB = endB >= 2 ? after.lastIndexOf("\n", endB - 2) + 1 : 0;
		const la = endA - startA;
		const lb = endB - startB;
		if (la !== lb) break;
		let same = true;
		for (let k = 0; k < la; k++) {
			if (before.charCodeAt(startA + k) !== after.charCodeAt(startB + k)) {
				same = false;
				break;
			}
		}
		if (!same) break;
		suffix++;
		endA = startA;
		endB = startB;
	}
	return {
		beforeLines: lineCount(before) - prefix - suffix,
		afterLines: lineCount(after) - prefix - suffix,
	};
}

/**
 * Count added/removed lines from a unified diff. Returns undefined if the diff
 * exceeds budget or contains malformed hunks. `exact: true` in the returned
 * result means "parsed without overflow", not "validated against declared hunk
 * line counts"; the parser is intentionally fail-open for well-formed SDK output.
 */
export function countUnifiedDiff(
	diff: string,
): { added: number; removed: number } | undefined {
	if (diff.length > MAX_DIFF_BYTES) return undefined;
	let added = 0;
	let removed = 0;
	let inHunk = false;
	let sawHunk = false;
	let rows = 0;
	// Index-scan rows without splitting into a line array: a hostile diff
	// string cannot force an unbounded allocation or copy.
	for (let index = 0; index <= diff.length; ) {
		if (++rows > MAX_DIFF_ROWS) return undefined;
		const end = diff.indexOf("\n", index);
		const lineEnd = end === -1 ? diff.length : end;
		if (diff.startsWith("@@", index)) {
			// Validate @@ -a,b +c,d @@ format: must have space after @@, and at least
			// one - or + range. This rejects malformed hunks like "@@ not-a-hunk".
			const line = diff.slice(index, lineEnd);
			const hasMinusRange = line.includes(" -");
			const hasPlusRange = line.includes(" +");
			if (hasMinusRange || hasPlusRange) {
				inHunk = true;
				sawHunk = true;
			} else {
				// Malformed hunk header: fail open by returning undefined.
				return undefined;
			}
		} else if (inHunk) {
			if (
				diff.startsWith("diff --git ", index) ||
				diff.startsWith("Index: ", index)
			) {
				inHunk = false;
			} else {
				const marker = diff.charCodeAt(index);
				if (marker === 43 /* + */) added++;
				else if (marker === 45 /* - */) removed++;
			}
		}
		if (end === -1) break;
		index = end + 1;
	}
	return sawHunk ? { added, removed } : undefined;
}

export function countNumberedDiff(
	diff: string,
): { added: number; removed: number } | undefined {
	if (diff.length > MAX_DIFF_BYTES) return undefined;
	let added = 0;
	let removed = 0;
	let sawRow = false;
	let rows = 0;
	for (let index = 0; index <= diff.length; ) {
		if (++rows > MAX_DIFF_ROWS) return undefined;
		const end = diff.indexOf("\n", index);
		const lineEnd = end === -1 ? diff.length : end;
		// Strict stock numbered diff row: `+12|text`, `-12|text`, ` 12|context`.
		// Anything else (gap rows, diagnostics, headers) is not a row and is
		// ignored. Parsed without slicing: marker, digits, `|`, and content
		// free of line-terminator characters (\r, \u2028, \u2029) — the
		// original anchored regex `(.*)$` also rejected those.
		const marker = index < lineEnd ? diff.charCodeAt(index) : 0;
		if (
			marker === 43 /* + */ ||
			marker === 45 /* - */ ||
			marker === 32 /*   */
		) {
			let cursor = index + 1;
			let digits = 0;
			while (cursor < lineEnd) {
				const code = diff.charCodeAt(cursor);
				if (code < 48 || code > 57) break;
				digits++;
				cursor++;
			}
			if (
				digits > 0 &&
				cursor < lineEnd &&
				diff.charCodeAt(cursor) === 124 /* | */
			) {
				let clean = true;
				for (let content = cursor + 1; content < lineEnd; content++) {
					const code = diff.charCodeAt(content);
					if (code === 13 || code === 0x2028 || code === 0x2029) {
						clean = false;
						break;
					}
				}
				if (clean) {
					sawRow = true;
					if (marker === 43) added++;
					else if (marker === 45) removed++;
				}
			}
		}
		if (end === -1) break;
		index = end + 1;
	}
	return sawRow ? { added, removed } : undefined;
}

export function countDiffChanges(
	diff: string,
): { added: number; removed: number } | undefined {
	const unified = countUnifiedDiff(diff);
	if (unified !== undefined) return unified;
	return countNumberedDiff(diff);
}

/**
 * Derive mutation evidence from a single edit operation. Returns undefined
 * when evidence is malformed, oversized, or represents a zero-change diff
 * (both added and removed are 0) — fail open: the entry keeps native
 * presentation rather than invented stats.
 *
 * `exact: true` means the counts were derived from the actual applied diff or
 * pre-image, not estimated or sampled. Consumers may trust these counts for
 * aggregation and metrics without revalidation.
 */
function editEntry(
	toolCallId: string,
	path: unknown,
	diff: unknown,
): MutationMessageDetails | undefined {
	if (
		typeof path !== "string" ||
		!path ||
		path.length > MAX_EVIDENCE_PATH_LENGTH ||
		typeof diff !== "string"
	)
		return undefined;
	const changes = countDiffChanges(diff);
	if (!changes || (changes.added === 0 && changes.removed === 0))
		return undefined;
	return {
		version: 1,
		toolCallId,
		toolName: "edit",
		path,
		added: changes.added,
		removed: changes.removed,
		exact: true,
	};
}

/**
 * Derive mutation evidence from a delete operation using the full pre-image.
 * Returns undefined when the path is invalid, oldText is missing/pruned, or
 * oversized per F02 budgets.
 *
 * `exact: true` means `removed` was counted from the complete unpruned
 * pre-image — not estimated, not sampled. When snapshotsPruned is true or
 * oldText is unavailable, we return undefined rather than approximating.
 */
function deleteEntry(
	toolCallId: string,
	path: unknown,
	oldText: unknown,
	snapshotsPruned: unknown,
): MutationMessageDetails | undefined {
	if (
		typeof path !== "string" ||
		!path ||
		path.length > MAX_EVIDENCE_PATH_LENGTH
	)
		return undefined;
	// Exact stats require the unpruned pre-image; without it we must not
	// fabricate a removal count.
	if (typeof oldText !== "string" || snapshotsPruned) return undefined;
	if (
		oldText.length > MAX_DELETE_BYTES ||
		lineCount(oldText) > MAX_DELETE_LINES
	)
		return undefined;
	const removed = lineCount(oldText);
	if (removed === 0) return undefined;
	return {
		version: 1,
		toolCallId,
		toolName: "edit",
		path,
		added: 0,
		removed,
		exact: true,
	};
}

/**
 * Derive mutation evidence from a stock edit-tool result.
 *
 * - Multi-file results keep every successful entry and drop failed ones,
 *   bounded by the F02 budgets: at most MAX_PER_FILE_RESULTS files are
 *   processed and scanning stops once MAX_TOTAL_SCAN_BYTES of per-file
 *   evidence has been examined. Anything beyond the budgets is dropped
 *   deterministically — never counted approximately.
 * - A single-path result is retained whenever its details carry evidence of an
 *   applied mutation (non-zero diff, or an exact delete pre-image), even when
 *   the aggregate result is flagged as an error (stock marks partial
 *   application this way).
 * - Failed/unapplied/no-op results produce no entries.
 */
export function completeEditMutations(
	toolCallId: string,
	result: unknown,
	_isError: boolean,
): MutationMessageDetails[] {
	const resultRecord = record(result);
	const details = record(resultRecord.details);
	if (Array.isArray(details.perFileResults)) {
		const entries: MutationMessageDetails[] = [];
		const files = details.perFileResults;
		const fileCount = Math.min(files.length, MAX_PER_FILE_RESULTS);
		let scannedBytes = 0;
		for (let index = 0; index < fileCount; index++) {
			const file = record(files[index]);
			if (file.isError === true) continue;
			const diff = typeof file.diff === "string" ? file.diff : "";
			const oldText = typeof file.oldText === "string" ? file.oldText : "";
			const cost = diff.length + oldText.length;
			// Skip oversized file but continue scanning remaining files within budget.
			if (scannedBytes + cost > MAX_TOTAL_SCAN_BYTES) continue;
			scannedBytes += cost;
			const entry =
				file.op === "delete"
					? deleteEntry(
							toolCallId,
							file.path,
							file.oldText,
							file.snapshotsPruned,
						)
					: editEntry(toolCallId, file.path, file.diff);
			if (entry) entries.push(entry);
		}
		return entries;
	}
	const entry =
		details.op === "delete"
			? deleteEntry(
					toolCallId,
					details.path,
					details.oldText,
					details.snapshotsPruned,
				)
			: editEntry(toolCallId, details.path, details.diff);
	return entry ? [entry] : [];
}
