/**
 * F01: explicit production bounds applied BEFORE hydration/state allocation.
 *
 * Historical/custom evidence that exceeds these limits is ignored locally:
 * the entry keeps its native presentation and is never copied into
 * ToolState, ledger entries or the replay evidence arrays. The limits are
 * generous enough that stock live events and the existing replay corpora
 * never trip them — they exist so a hostile or corrupted session JSONL
 * cannot grow session state without bound. Failing entries never abort a
 * branch hydration, never roll back adapter installation and are never
 * truncated into a record that claims `exact: true`.
 */

/** Host-generated tool execution ids (UUIDs, run sequences). */
export const MAX_TOOL_CALL_ID_LENGTH = 256;

/** Registered tool names (stock and plugin). */
export const MAX_TOOL_NAME_LENGTH = 128;

/** Persisted filesystem path/cwd evidence fields. */
export const MAX_EVIDENCE_PATH_LENGTH = 4_096;

/**
 * Persisted arbitrary text fields (Git rows, subjects, command text).
 * Mirrors the git-records command-length budget (16_384).
 */
export const MAX_EVIDENCE_TEXT_LENGTH = 16_384;

/** Git commit hashes are hex, 4–64 chars. */
export const MAX_GIT_HASH_LENGTH = 64;

/** Git subcommand names are short verb-like tokens. */
export const MAX_GIT_SUBCOMMAND_LENGTH = 128;

/**
 * Per-carrier Git record rows; mirrors the git-records command-chain budget
 * (MAX_COMMANDS = 8).
 */
export const MAX_GIT_RECORDS = 8;

/** Mutation added/removed counts (real diff line counts). */
export const MAX_MUTATION_COUNT = 10_000_000;

/**
 * Mutation evidence carriers retained per state. Each persisted carrier is
 * one entry, and a corrupted branch must not grow the array without bound;
 * excess carriers are ignored evidence.
 */
export const MAX_MUTATION_ENTRIES = 1_000;

/**
 * Estimated retained payload budget for branch args/result objects. When a
 * branch entry exceeds it, the payload is skipped or left unretained —
 * never deep-copied into ToolState.
 */
export const MAX_PAYLOAD_BYTES = 1_048_576;
export const MAX_PAYLOAD_DEPTH = 32;

/**
 * Maximum walk steps in isPayloadWithinBudget. Bounds the total number
 * of nodes visited in a single payload check, independent of byte budget,
 * to prevent event-loop stall on adversarially wide-but-shallow objects.
 * Set equal to MAX_PAYLOAD_BYTES so the existing byte guard still wins
 * first for typical payloads; the step guard is a belt-and-suspenders cap.
 */
export const MAX_PAYLOAD_STEPS = MAX_PAYLOAD_BYTES;

export function isBoundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length <= max;
}

export function isBoundedCount(value: unknown, max: number): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= max
	);
}

/**
 * Bounded structural estimate of a payload before any state allocation.
 * Walks strings/arrays/objects depth-first and fails once the byte or
 * depth budget is exhausted, so a hostile cyclic or deeply nested object
 * terminates after a bounded number of steps. Never allocates a copy and
 * never reads values — string lengths and key names only.
 *
 * Retained-cost contract per primitive leaf: strings charge their length;
 * numbers charge 8 bytes (IEEE-754 double); booleans, null, undefined and
 * opaque primitives (functions/symbols) charge a fixed nonzero slot of 4
 * bytes. The fixed leaf charges keep wide primitive arrays and shallow
 * objects inside the byte budget — a hostile payload cannot slip through
 * by shipping many zero-cost leaves that the step cap alone would have to
 * absorb.
 *
 * A step counter (MAX_PAYLOAD_STEPS) provides an independent cap on total
 * nodes visited, guarding against adversarially wide-but-shallow objects
 * that stay within depth and byte limits while causing excessive iteration.
 */
export function isPayloadWithinBudget(
	value: unknown,
	maxBytes = MAX_PAYLOAD_BYTES,
	maxDepth = MAX_PAYLOAD_DEPTH,
): boolean {
	let bytes = 0;
	let steps = 0;
	const walk = (node: unknown, depth: number): boolean => {
		if (depth > maxDepth) return false;
		if (++steps > MAX_PAYLOAD_STEPS) return false;
		if (typeof node === "string") {
			bytes += node.length;
			return bytes <= maxBytes;
		}
		if (node === null || node === undefined) {
			bytes += 4; // fixed retained slot
			return bytes <= maxBytes;
		}
		const type = typeof node;
		if (type === "number") {
			bytes += 8; // IEEE-754 double
			return bytes <= maxBytes;
		}
		if (type === "boolean") {
			bytes += 4; // fixed retained slot
			return bytes <= maxBytes;
		}
		if (type !== "object") {
			bytes += 4; // opaque leaves (functions/symbols): fixed cost
			return bytes <= maxBytes;
		}
		try {
			bytes += 8; // container shell
			if (bytes > maxBytes) return false;
			if (Array.isArray(node)) {
				for (const item of node) {
					if (!walk(item, depth + 1)) return false;
				}
				return true;
			}
			const record = node as Record<string, unknown>;
			for (const key of Object.keys(record)) {
				bytes += key.length;
				if (bytes > maxBytes) return false;
				if (!walk(record[key], depth + 1)) return false;
			}
		} catch {
			return false; // hostile getters/proxies fail closed
		}
		return true;
	};
	return walk(value, 0);
}
