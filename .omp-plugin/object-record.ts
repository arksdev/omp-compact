/**
 * Coerce unknown input to a plain object record for property reads.
 *
 * Non-array objects cast through; arrays, null, undefined, and primitives
 * yield `{}`, so an array never passes as a record with index keys.
 *
 * Single definition for the plugin: every previous per-module copy points
 * here so the coercion cannot drift.
 */
export function objectRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
