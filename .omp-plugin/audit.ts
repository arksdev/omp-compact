import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
// External dependency: peelWriteUrlSelector/unwrapHashlineHeaderPath from
// @oh-my-pi/pi-coding-agent. API stability: integration tests cover contract.
import { peelWriteUrlSelector } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";
import { diffLines } from "@oh-my-pi/pi-natives";

import {
	DIFF_MAX_REMAINING_LINES,
	lineCount,
	trimmedMiddleLines,
} from "./audit-diff";

import { MAX_EVIDENCE_PATH_LENGTH } from "./hydration-bounds";

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
		let depth = 0;
		const MAX_DEPTH = 100; // Defensive: typical max path depth
		for (;;) {
			if (++depth > MAX_DEPTH) return absolutePath;
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

/**
 * Exact-size bounded snapshot reader (sync). Reads exactly `size` bytes from
 * `fd` in a loop, tolerating short reads, and returns the raw buffer only
 * when the total read length equals the stat size. A file that shrank (EOF
 * before `size`) or grew (more than `size` bytes available) between stat and
 * read is rejected — a partial or mismatched snapshot must never fabricate
 * evidence. Never allocates more than `size + 1` bytes, never reads past
 * `SNAPSHOT_MAX_BYTES`, and `read` defaults to node's `readSync`; tests
 * inject a scripted reader to exercise short reads, growth and shrink
 * deterministically.
 */
export function readExactSync(
	fd: number,
	size: number,
	read: (
		fd: number,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	) => number = readSync,
): Buffer | undefined {
	if (size > SNAPSHOT_MAX_BYTES) return undefined;
	const buffer = Buffer.allocUnsafe(size + 1);
	let total = 0;
	while (total <= size) {
		const count = read(fd, buffer, total, size + 1 - total, total);
		if (count <= 0) break; // EOF before size: the file shrank mid-read
		total += count;
	}
	if (total !== size) return undefined; // grew or shrank between stat and read
	return buffer;
}

/**
 * Exact-size bounded snapshot reader (async), the twin of `readExactSync`
 * for an already-open handle: loops short reads until exactly `size` bytes
 * are collected and rejects on growth/shrink, never allocating past
 * `size + 1`. The event loop stays non-blocking — the reads are awaited
 * FileHandle reads, never a synchronous read.
 */
export async function readExactAsync(
	handle: FileHandle,
	size: number,
	read: (
		handle: FileHandle,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	) => Promise<number> = async (h, buffer, offset, length, position) => {
		// Bun's FileHandle.read resolves to `{ buffer, bytesRead }` while
		// node's resolves to the byte count — normalize both contracts.
		const result = await h.read(buffer, offset, length, position);
		return typeof result === "number" ? result : result.bytesRead;
	},
): Promise<Buffer | undefined> {
	if (size > SNAPSHOT_MAX_BYTES) return undefined;
	const buffer = Buffer.allocUnsafe(size + 1);
	let total = 0;
	while (total <= size) {
		const count = await read(handle, buffer, total, size + 1 - total, total);
		if (count <= 0) break;
		total += count;
	}
	if (total !== size) return undefined;
	return buffer;
}

async function boundedText(
	path: string,
	missingAsEmpty: boolean,
): Promise<string | undefined> {
	let handle: FileHandle | undefined;
	try {
		// Gate the async path explicitly instead of relying on Bun.file:
		// Bun.file(path).text() blocks on a writer-less FIFO (Bun reports
		// its size as Infinity today, which the byte guard happens to catch,
		// but the text() call itself hangs — a version-dependent accident).
		// Opening with O_NONBLOCK and deciding on the OPENED descriptor
		// rejects every non-regular target fail-open before any read, so a
		// model-controlled path can never hang the read or fabricate
		// evidence, and a swap after the handle is open cannot be observed.
		handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const stats = await handle.stat();
		if (!stats.isFile()) return undefined;
		const size = stats.size;
		if (size > SNAPSHOT_MAX_BYTES) return undefined;
		const buffer = await readExactAsync(handle, size);
		if (buffer === undefined) return undefined;
		const text = buffer.toString("utf8", 0, size);
		return lineCount(text) <= SNAPSHOT_MAX_LINES ? text : undefined;
	} catch (error) {
		if (missingAsEmpty && (error as NodeJS.ErrnoException).code === "ENOENT")
			return "";
		return undefined;
	} finally {
		if (handle !== undefined) await handle.close().catch(() => undefined);
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
 * snapshots -> undefined, other read errors -> undefined. The path is opened
 * with `O_NONBLOCK` and gated on `fstat` of the opened descriptor: FIFOs,
 * devices, sockets and directories are rejected fail-open, so a
 * model-controlled non-regular target can never block the event loop, and a
 * symlink resolving to a regular file keeps its exact snapshot. The exact
 * snapshot is read through `readExactSync`: short reads are looped and any
 * growth/shrink between stat and read rejects the evidence instead of
 * fabricating a partial pre-image.
 */
function boundedTextSync(
	path: string,
	missingAsEmpty: boolean,
): string | undefined {
	let fd: number | undefined;
	try {
		// O_NONBLOCK: opening a writer-less FIFO (or another non-regular
		// target) with plain "r" blocks inside open(2) and hangs the main
		// event loop — the path is model-controlled. The regular/non-regular
		// decision is made on the OPENED descriptor (race-safe: no lstat
		// window a concurrent swap could slip through), and every non-regular
		// target is rejected fail-open before any allocation or read.
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const stats = fstatSync(fd);
		if (!stats.isFile()) return undefined;
		const size = stats.size;
		// Read through the same fd, at most size+1 bytes: a file that grew
		// past the bound between stat and read overflows the probe and the
		// snapshot is rejected instead of reading unbounded data (TOCTOU),
		// and a short read is looped until the exact size is collected.
		const buffer = readExactSync(fd, size);
		if (buffer === undefined) return undefined;
		const text = buffer.toString("utf8", 0, size);
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
	// Match the edit/delete path bound (audit-diff) BEFORE any filesystem
	// I/O: an overlong display path could never survive the evidence
	// validator, so the snapshot read must not be attempted at all (the
	// read would only fail incidentally with ENAMETOOLONG past PATH_MAX).
	if (displayPath.length > MAX_EVIDENCE_PATH_LENGTH) return undefined;
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
	// Triple equality check defends against race: effectiveCandidate and
	// effectiveResult resolve symlinks independently (timing-sensitive on
	// network mounts), and both must match the snapshot-time canonical path.
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
