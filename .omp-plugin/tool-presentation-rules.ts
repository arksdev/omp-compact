/**
 * Typed production registry of compact tool-presentation rules.
 *
 * Single source of truth mapping a structured `toolName + args/result` shape
 * to compact presentation: the row route, the mutation audit kind, the pure
 * description, and optional settled result metadata. Rules are data, not
 * behavior switches: adding or changing a known tool's presentation happens
 * here and nowhere else.
 *
 * Nothing here parses native rendered/ANSI text, calls, registers or
 * replaces native tools, or copies tool schemas. Unknown names resolve to
 * `undefined` explicitly (never a synthesized implicit compact rule) so
 * callers fail open to the native renderer.
 */
import type { ToolDescription } from "./compact";
import type { DisplayPathOptions } from "./display-path";
import { objectRecord as record } from "./object-record";
import {
	describeAstEdit,
	describeAstGrep,
	describeBash,
	describeBrowser,
	describeComputer,
	describeEdit,
	describeFind,
	describeGlob,
	describeGrep,
	describeHub,
	describeInspectImage,
	describeRead,
	describeTask,
	describeTextDevice,
	describeTodo,
	describeWait,
	describeWrite,
	genericDescribe,
	resultMetaBash,
	resultMetaFind,
	resultMetaGlob,
	resultMetaGrep,
	resultMetaResolution,
	resultMetaTodo,
	resultMetaWait,
	resultMetaWrite,
	transportTargetOf,
	writeDeviceName,
} from "./tool-rule-describers";

export type { ToolDescription } from "./compact";

/** How a tool call is presented. */
export type ToolRoute =
	| "compact"
	| "read-group"
	| "native-live"
	| "live-card"
	| "kept-row";

/** Mutation audit kind attributed to a tool's result evidence. */
export type ToolAuditKind = "none" | "write" | "edit" | "git-bash";

export interface ToolPresentationRule {
	/** Presentation route of the canonical tool. */
	readonly route: ToolRoute;
	/** Audit kind for mutation evidence of this tool. */
	readonly audit: ToolAuditKind;
	/** Pure description from structured args; never touches the filesystem. */
	describe(args: unknown, displayPaths?: DisplayPathOptions): ToolDescription;
	/**
	 * Optional settled result metadata (e.g. bash exit code / wall time). The
	 * call args are passed alongside so a rule can stay silent when the row's
	 * own description already names what the result would repeat.
	 */
	resultMeta?(result: unknown, args?: unknown): readonly string[];
}

// Null prototype: direct index of collision keys (constructor/toString/…) must
// yield undefined even for callers that bypass normalizeToolName. Object.hasOwn
// guards on the accessors are belt-and-braces at the untrusted-host boundary.
//
// `jfind` is the spelling the semantic-search tool ships under in the host
// package layout (`pi-coding-agent/src/tools/jfind`): the wire name in
// transcripts is `find` (see `findToolRenderer` in `pi-tui/src/tools/find.ts`),
// and this alias keeps the one rule reachable if a session surfaces the
// module spelling instead — an unresolvable name would fall open to native.
export const TOOL_ALIASES: Readonly<Partial<Record<string, string>>> =
	Object.freeze(
		Object.assign(Object.create(null), {
			apply_patch: "edit",
			jfind: "find",
		}) as Partial<Record<string, string>>,
	);

function presentationRule(
	route: ToolRoute,
	audit: ToolAuditKind,
	describe: ToolPresentationRule["describe"],
	resultMeta?: ToolPresentationRule["resultMeta"],
): ToolPresentationRule {
	const rule: ToolPresentationRule = {
		route,
		audit,
		describe,
	};
	if (resultMeta !== undefined) rule.resultMeta = resultMeta;
	return Object.freeze(rule);
}

/**
 * Readonly canonical-name registry of every tool with a known presentation.
 * Keys are canonical underscore names only; aliases resolve through
 * `normalizeToolName`. Lookups that miss return `undefined` — never an
 * implicit compact rule.
 * Null prototype: exported table indexing must not inherit Object.prototype.
 * Accessors still use Object.hasOwn as defence in depth for untrusted host input.
 */
export const TOOL_RULES: Readonly<
	Partial<Record<string, ToolPresentationRule>>
> = Object.freeze(
	Object.assign(Object.create(null), {
		read: presentationRule("read-group", "none", describeRead),
		bash: presentationRule("compact", "git-bash", describeBash, resultMetaBash),
		write: presentationRule("compact", "write", describeWrite, resultMetaWrite),
		edit: presentationRule("compact", "edit", describeEdit),
		grep: presentationRule("compact", "none", describeGrep, resultMetaGrep),
		glob: presentationRule("compact", "none", describeGlob, resultMetaGlob),
		find: presentationRule("compact", "none", describeFind, resultMetaFind),
		// OMP 18.3.0 renamed the builtin coordination tool `hub` → `wait` and
		// stripped its schema to `type({})`: process supervision moved to
		// `write` (`proc://<id>/…`) and supervised `bash` services, while `wait`
		// now only blocks for background results and peer messages. Both rules
		// stay registered — `hub` is still the wire name on hosts up to 18.2.11
		// and the public floor is 18.0.1.
		hub: presentationRule("compact", "none", describeHub),
		wait: presentationRule("live-card", "none", describeWait, resultMetaWait),
		todo: presentationRule("live-card", "none", describeTodo, resultMetaTodo),
		eval: presentationRule("compact", "none", genericDescribe("eval")),
		yield: presentationRule("compact", "none", genericDescribe("yield")),
		hus: presentationRule("compact", "none", genericDescribe("hus")),
		web_search: presentationRule(
			"compact",
			"none",
			genericDescribe("web_search"),
		),
		ast_grep: presentationRule("compact", "none", describeAstGrep),
		ast_edit: presentationRule("compact", "none", describeAstEdit),
		inspect_image: presentationRule("compact", "none", describeInspectImage),
		browser: presentationRule("compact", "none", describeBrowser),
		ask: presentationRule("native-live", "none", genericDescribe("ask")),
		// Historical resolution transcripts: keyed by the `resolve`/`reject`
		// tool names this agent no longer emits (it writes to xd://resolve).
		// Kept as the reserve for those transcripts; `describeWrite` reaches
		// the very same describer through the device path.
		resolve: presentationRule(
			"compact",
			"none",
			describeTextDevice("resolve"),
			resultMetaResolution,
		),
		reject: presentationRule(
			"compact",
			"none",
			describeTextDevice("reject"),
			resultMetaResolution,
		),
		computer: presentationRule("compact", "none", describeComputer),
		task: presentationRule("kept-row", "none", describeTask),
		// Vibe worker-session devices: compact route, and the rows come from
		// the dedicated vibe builder in render.ts (not `describe`). The
		// generic description stays as the bounded fallback for any caller
		// that asks a vibe rule to describe itself.
		vibe_spawn: presentationRule(
			"compact",
			"none",
			genericDescribe("vibe_spawn"),
		),
		vibe_send: presentationRule(
			"compact",
			"none",
			genericDescribe("vibe_send"),
		),
		vibe_wait: presentationRule(
			"compact",
			"none",
			genericDescribe("vibe_wait"),
		),
		vibe_kill: presentationRule(
			"compact",
			"none",
			genericDescribe("vibe_kill"),
		),
		vibe_list: presentationRule(
			"compact",
			"none",
			genericDescribe("vibe_list"),
		),
		ida: presentationRule("compact", "none", genericDescribe("ida")),
		github: presentationRule("compact", "none", genericDescribe("github")),
		lsp: presentationRule("compact", "none", genericDescribe("lsp")),
		checkpoint: presentationRule(
			"compact",
			"none",
			genericDescribe("checkpoint"),
		),
		rewind: presentationRule("compact", "none", genericDescribe("rewind")),
		context_notes: presentationRule(
			"compact",
			"none",
			genericDescribe("context_notes"),
		),
		new_context: presentationRule(
			"compact",
			"none",
			genericDescribe("new_context"),
		),
		memory_edit: presentationRule(
			"compact",
			"none",
			genericDescribe("memory_edit"),
		),
		retain: presentationRule("compact", "none", genericDescribe("retain")),
		recall: presentationRule("compact", "none", genericDescribe("recall")),
		reflect: presentationRule("compact", "none", genericDescribe("reflect")),
		learn: presentationRule("compact", "none", genericDescribe("learn")),
		manage_skill: presentationRule(
			"compact",
			"none",
			genericDescribe("manage_skill"),
		),
	}) as Partial<Record<string, ToolPresentationRule>>,
);

/**
 * Canonical spelling of a tool name: hyphen aliases map to their underscore
 * canonical names (`ast-grep` → `ast_grep`, `ast-edit` → `ast_edit`).
 * Deterministic for any spelling.
 */
export function normalizeToolName(name: string): string {
	const normalized = name.replaceAll("-", "_");
	// Own-property only (belt-and-braces): tables are null-prototype, so bare
	// index already yields undefined for collision keys. Object.hasOwn remains
	// at the untrusted-host boundary in case a future edit reintroduces a
	// prototype-bearing table without updating the accessors.
	return Object.hasOwn(TOOL_ALIASES, normalized)
		? (TOOL_ALIASES[normalized] as string)
		: normalized;
}

/**
 * Explicit registry lookup. Returns the rule for a registered canonical name
 * (aliases resolve through `normalizeToolName`) or `undefined` — it never
 * synthesizes an implicit compact rule for unknown tools.
 */
export function resolveToolRule(
	name: string,
): ToolPresentationRule | undefined {
	const key = normalizeToolName(name);
	// Own-property only (belt-and-braces): see normalizeToolName.
	return Object.hasOwn(TOOL_RULES, key) ? TOOL_RULES[key] : undefined;
}

/**
 * Effective audit kind of one call: the registered rule's static kind, except
 * that a `write` addressing a mounted `xd://` device or a non-file transport
 * (`proc://`, `agent://`) audits nothing. Such a call dispatches a tool or a
 * process/peer operation — the path is an address, not a file, so routing it
 * into the write-audit path would attribute a local file mutation to it.
 *
 * The audit module's own URI-scheme guard stays where it is as the second
 * line of defence: this decision keeps those calls out of the write branch
 * altogether instead of relying on a later refusal.
 *
 * Structured args only, no rendered text. An unregistered tool, a malformed
 * device URL, or unreadable args keep the static kind — unknown data must
 * never silently disable a real file audit. `args` is optional because the
 * `tool_execution_end` event carries no args: a caller with no args resolves
 * the static kind only (device re-checking needs the start payload), and
 * audit lifecycle no-ops keep that residual difference inert.
 */
export function resolveToolAudit(name: string, args?: unknown): ToolAuditKind {
	const rule = resolveToolRule(name);
	if (rule === undefined) return "none";
	if (rule.audit === "write" && args !== undefined) {
		// A `write` addressing a mounted device or a non-file transport mutates
		// no file: the path is an address, not a target. Keeping the static
		// kind for unreadable args is deliberate — a malformed payload must
		// never silently disable a real file audit.
		const value = record(args);
		if (
			writeDeviceName(value) !== undefined ||
			transportTargetOf(value) !== undefined
		)
			return "none";
	}
	return rule.audit;
}

/**
 * Pure description for explicitly registered rules only; unregistered names
 * resolve to `undefined`. The bounded generic form stays available as a
 * direct helper (`genericToolDescription` in `compact.ts`) for callers that
 * deliberately render an unknown tool — the presenter must never call
 * this for an unresolved tool.
 */
export function describeTool(
	name: string,
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription | undefined {
	const resolved = resolveToolRule(name);
	return resolved === undefined
		? undefined
		: resolved.describe(args, displayPaths);
}
