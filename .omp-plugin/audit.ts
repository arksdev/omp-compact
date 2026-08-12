import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { peelWriteUrlSelector } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";
import { diffLines } from "@oh-my-pi/pi-natives";

import {
	DIFF_MAX_REMAINING_LINES,
	lineCount,
	trimmedMiddleLines,
} from "./audit-diff";

import type { MutationMessageDetails } from "./messages";

export {
	completeEditMutations,
	DIFF_MAX_REMAINING_LINES,
	lineCount,
	trimmedMiddleLines,
} from "./audit-diff";

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const COMPOUND_FILE_TARGET =
	/(?:\.(?:tar\.gz|zip|tar|tgz|jar|war|ear|apk|sqlite3?|db3?)):/i;
const SNAPSHOT_MAX_BYTES = 1_048_576;
const SNAPSHOT_MAX_LINES = 50_000;

export interface MutationCandidate {
	toolCallId: string;
	toolName: "write";
	displayPath: string;
	absolutePath: string;
	canonicalPath: string;
	before: string;
}

function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Canonical form of a target path that stays stable across the write:
 * realpath the nearest existing ancestor, then re-append the still-missing
 * suffix. At capture time a brand-new file (and possibly its parent
 * directories) does not exist yet; a plain realpath would then fail and fall
 * back to the raw path, while completion-time realpath resolves symlinked
 * prefixes (e.g. macOS `/tmp` -> `/private/tmp`) once native created the
 * directories — a false mismatch that dropped exact stats for every new file
 * written below a newly created directory on a symlinked prefix.
 */
async function canonicalPath(path: string): Promise<string> {
	const absolutePath = resolve(path);
	try {
		return await realpath(absolutePath);
	} catch {
		const suffix: string[] = [];
		let current = absolutePath;
		for (;;) {
			const parent = dirname(current);
			if (parent === current) return absolutePath;
			suffix.unshift(basename(current));
			try {
				return resolve(await realpath(parent), ...suffix);
			} catch {
				current = parent;
			}
		}
	}
}

async function boundedText(
	path: string,
	missingAsEmpty: boolean,
): Promise<string | undefined> {
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) return missingAsEmpty ? "" : undefined;
		if (file.size > SNAPSHOT_MAX_BYTES) return undefined;
		const text = await file.text();
		return lineCount(text) <= SNAPSHOT_MAX_LINES ? text : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Synchronous twin of `boundedText` for the pre-image read in
 * `captureWriteCandidate`. Stock OMP invokes the `tool_execution_start`
 * listener without awaiting it, so an async read can lose the race against
 * the tool's own write and snapshot the post-image bytes (no diff -> no
 * evidence). Running the read synchronously inside the start handler captures
 * the pre-image before the handler yields. Semantics mirror `boundedText`
 * exactly: missing file -> "" when `missingAsEmpty`, oversized/over-long
 * snapshots -> undefined, other read errors -> undefined.
 */
function boundedTextSync(
	path: string,
	missingAsEmpty: boolean,
): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		if (size > SNAPSHOT_MAX_BYTES) return undefined;
		// Read through the same fd, at most MAX+1 bytes: a file that grew
		// past the bound between stat and read overflows the probe and the
		// snapshot is rejected instead of reading unbounded data (TOCTOU).
		const buffer = Buffer.allocUnsafe(size + 1);
		const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
		if (bytesRead > SNAPSHOT_MAX_BYTES) return undefined;
		const text = buffer.toString("utf8", 0, bytesRead);
		return lineCount(text) <= SNAPSHOT_MAX_LINES ? text : undefined;
	} catch (error) {
		if (missingAsEmpty && (error as NodeJS.ErrnoException).code === "ENOENT")
			return "";
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export async function captureWriteCandidate(input: {
	toolCallId: string;
	args: unknown;
	cwd: string;
}): Promise<MutationCandidate | undefined> {
	const args = objectRecord(input.args);
	if (typeof args.path !== "string" || typeof args.content !== "string")
		return undefined;
	let displayPath: string;
	try {
		displayPath = peelWriteUrlSelector(unwrapHashlineHeaderPath(args.path));
	} catch {
		return undefined;
	}
	if (
		!displayPath ||
		URI_SCHEME.test(displayPath) ||
		COMPOUND_FILE_TARGET.test(displayPath) ||
		args.path.includes(":conflicts")
	) {
		return undefined;
	}
	const absolutePath = isAbsolute(displayPath)
		? resolve(displayPath)
		: resolve(input.cwd, displayPath);
	// Synchronous pre-image read: the start handler must not yield before the
	// snapshot is taken (stock delivery is fire-and-forget; the tool's write
	// can otherwise land first and the diff collapses to zero).
	const before = boundedTextSync(absolutePath, true);
	if (before === undefined) return undefined;
	return {
		toolCallId: input.toolCallId,
		toolName: "write",
		displayPath,
		absolutePath,
		canonicalPath: await canonicalPath(absolutePath),
		before,
	};
}

function exactLineChanges(
	before: string,
	after: string,
): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const change of diffLines(before, after)) {
		if (change.added) added += change.count;
		else if (change.removed) removed += change.count;
	}
	return { added, removed };
}

export async function completeWriteCandidate(
	candidate: MutationCandidate | undefined,
	result: unknown,
	isError: boolean,
): Promise<MutationMessageDetails[]> {
	if (!candidate || isError || objectRecord(result).isError === true) return [];
	const details = objectRecord(objectRecord(result).details);
	if (
		typeof details.resolvedPath !== "string" ||
		!isAbsolute(details.resolvedPath)
	)
		return [];
	const resolvedPath = resolve(details.resolvedPath);
	const [effectiveCandidate, effectiveResult] = await Promise.all([
		canonicalPath(candidate.absolutePath),
		canonicalPath(resolvedPath),
	]);
	if (
		effectiveCandidate !== effectiveResult ||
		effectiveResult !== candidate.canonicalPath
	)
		return [];
	const after = await boundedText(effectiveResult, false);
	if (after === undefined) return [];
	// F02: zero-allocation equal-snapshot fast path — identical bytes mean
	// no mutation, so no diff work and no native call.
	if (after === candidate.before) return [];
	const middle = trimmedMiddleLines(candidate.before, after);
	if (middle.beforeLines === 0 && middle.afterLines === 0) return [];
	// F02 diff complexity budget: the native Myers-style diff is quadratic
	// in its remaining tokens, so enforce the static budget before the
	// call; over the budget the exact candidate is dropped (fail open)
	// instead of blocking the event loop. The trim already proved that a
	// wholly added/removed middle counts exactly, so those never need the
	// native diff at all.
	if (middle.beforeLines + middle.afterLines > DIFF_MAX_REMAINING_LINES)
		return [];
	const { added, removed } =
		middle.beforeLines === 0 || middle.afterLines === 0
			? { added: middle.afterLines, removed: middle.beforeLines }
			: exactLineChanges(candidate.before, after);
	if (added === 0 && removed === 0) return [];
	return [
		{
			version: 1,
			toolCallId: candidate.toolCallId,
			toolName: "write",
			path: candidate.displayPath,
			added,
			removed,
			exact: true,
		},
	];
}
