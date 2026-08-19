/**
 * Coerce unknown input to a plain object record for property reads.
 *
 * Truthy objects (including arrays) cast through; null, undefined, and
 * primitives yield `{}`. Arrays stay arrays under the cast — callers that
 * need "plain object only" must check `Array.isArray` themselves (see
 * render.ts, which keeps a stricter local helper for that reason).
 *
 * Single definition for the plugin: every previous per-module copy of this
 * majority shape points here so the coercion cannot drift.
 */
export function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}
