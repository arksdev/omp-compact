/**
 * Typed production registry of compact tool-presentation rules.
 *
 * Single source of truth mapping a structured `toolName + args/result` shape
 * to compact presentation: the row route, the mutation audit kind, the
 * known arg/detail inventory, the pure description, and optional settled
 * result metadata. Rules are data, not behavior switches: adding or changing
 * a known tool's presentation happens here and nowhere else.
 *
 * Nothing here parses native rendered/ANSI text, calls, registers or
 * replaces native tools, or copies tool schemas. Unknown names resolve to
 * `undefined` explicitly (never a synthesized implicit compact rule) so
 * callers fail open to the native renderer.
 */
import { record, type ToolDescription } from "./compact";
import {
	describeAstEdit,
	describeAstGrep,
	describeBash,
	describeBrowser,
	describeComputer,
	describeEdit,
	describeGlob,
	describeGrep,
	describeHub,
	describeInspectImage,
	describeRead,
	describeTextDevice,
	describeWrite,
	genericDescribe,
	resultMetaBash,
	resultMetaGlob,
	resultMetaGrep,
	resultMetaResolution,
	resultMetaWrite,
	writeDeviceName,
} from "./tool-rule-describers";
import type { DisplayPathOptions } from "./display-path";

export type { ToolDescription } from "./compact";

/** How a tool call is presented. */
export type ToolRoute = "compact" | "read-group" | "native-live";

/** Mutation audit kind attributed to a tool's result evidence. */
export type ToolAuditKind = "none" | "write" | "edit" | "git-bash";

export interface ToolPresentationRule {
	/** Presentation route of the canonical tool. */
	readonly route: ToolRoute;
	/** Audit kind for mutation evidence of this tool. */
	readonly audit: ToolAuditKind;
	/** Arg keys this tool is known to carry (replay-inventory coverage). */
	readonly knownArgs: readonly string[];
	/** Result `details` keys this tool is known to return. */
	readonly knownDetails: readonly string[];
	/**
	 * Keeps the compact row even when the tool call is explicitly expanded.
	 * Only the interactive four (browser/computer/resolve/reject) opt in;
	 * ordinary compact tools keep the native inspection escape hatch.
	 */
	compactOnExpand?: boolean;
	/** Pure description from structured args; never touches the filesystem. */
	describe(args: unknown, displayPaths?: DisplayPathOptions): ToolDescription;
	/**
	 * Optional settled result metadata (e.g. bash exit code / wall time). The
	 * call args are passed alongside so a rule can stay silent when the row's
	 * own description already names what the result would repeat.
	 */
	resultMeta?(result: unknown, args?: unknown): readonly string[];
}

const READ_ARGS = ["path", "file_path", "offset", "limit"] as const;
const READ_DETAILS = [
	"resolvedPath",
	"contentType",
	"displayContent",
	"meta",
	"isDirectory",
	"fileSize",
	"truncation",
	"notes",
	"displayReadTargets",
	"summary",
] as const;
const BASH_ARGS = ["command", "cwd"] as const;
const BASH_DETAILS = [
	"timeoutSeconds",
	"wallTimeMs",
	"exitCode",
	"meta",
] as const;
const WRITE_ARGS = ["path", "content"] as const;
const WRITE_DETAILS = [
	"resolvedPath",
	"xdev",
	"__synthetic",
	"source",
	"executed",
] as const;
const EDIT_ARGS = [
	"path",
	"file_path",
	"paths",
	"input",
	"_input",
	"old_string",
	"new_string",
	"replace_all",
	"edits",
] as const;
const EDIT_DETAILS = [
	"diff",
	"path",
	"firstChangedLine",
	"oldText",
	"newText",
	"snapshotsPruned",
	"op",
	"perFileResults",
	"__synthetic",
	"source",
	"executed",
] as const;
const GREP_ARGS = ["pattern", "path", "case", "gitignore"] as const;
const GREP_DETAILS = [
	"scopePath",
	"searchPath",
	"cwd",
	"matchCount",
	"fileCount",
	"files",
	"fileMatches",
	"truncated",
	"displayContent",
	"fileLimitReached",
	"linesTruncated",
	"meta",
] as const;
const GLOB_ARGS = ["path", "gitignore", "hidden", "limit"] as const;
const GLOB_DETAILS = [
	"scopePath",
	"fileCount",
	"files",
	"truncated",
	"cwd",
] as const;
const HUB_ARGS = [
	"op",
	"to",
	"from",
	"message",
	"replyTo",
	"await",
	// jobs / wait
	"ids",
	"timeoutMs",
	"peek",
	// launch (process supervision)
	"name",
	"application",
	"args",
	"env",
	"cwd",
	"pty",
	"ready",
	"restart",
	"persist",
	"detached",
	"lines",
	"head",
	"grep",
	"follow",
	"cursor",
	"for",
	"pattern",
	"text",
	"enter",
	"keys",
	"signal",
	"timeout",
] as const;
const HUB_DETAILS = [
	"op",
	"from",
	"to",
	"receipts",
	"waited",
	"isError",
	"error",
	"inbox",
	"peers",
	"jobs",
	"cancelled",
	"agents",
	// launch result details
	"daemon",
	"daemons",
	"cursor",
	"timedOut",
	"state",
	"terminalRows",
	"matched",
	"spec",
] as const;
const TODO_ARGS = ["op", "title", "items"] as const;
const TODO_DETAILS = ["op", "phases", "storage", "completedTasks"] as const;
const EVAL_ARGS = ["code", "language", "title"] as const;
const EVAL_DETAILS = ["language", "languages", "cells"] as const;
const YIELD_ARGS = ["data", "type", "result"] as const;
const YIELD_DETAILS = ["data", "status"] as const;
const ASK_ARGS = ["question", "options", "multi"] as const;
const ASK_DETAILS = [
	"question",
	"options",
	"multi",
	"selectedOptions",
] as const;
const AST_GREP_ARGS = ["pat", "path", "skip"] as const;
const AST_EDIT_ARGS = ["ops", "paths"] as const;
const INSPECT_IMAGE_ARGS = ["path", "question"] as const;
const WEB_SEARCH_ARGS = [
	"i",
	"query",
	"recency",
	"limit",
	"max_tokens",
	"num_search_results",
	"temperature",
] as const;
const BROWSER_ARGS = [
	"action",
	"name",
	"url",
	"app",
	"viewport",
	"wait_until",
	"dialogs",
	"code",
	"timeout",
	"all",
	"kill",
] as const;
const BROWSER_DETAILS = [
	"action",
	"name",
	"url",
	"browser",
	"viewport",
	"observation",
	"screenshots",
] as const;
const COMPUTER_ARGS = ["code", "i", "read_only", "timeout"] as const;
const COMPUTER_DETAILS = [
	"code",
	"readOnly",
	"screenshots",
	"returnValue",
	"backend",
	"capturePermission",
	"inputPermission",
	"axPermission",
] as const;
// Resolution devices carry the write call shape (path + one-sentence reason
// content) plus the generic result envelope (status) and the yield-style
// `result` payload seen on result tools.
const RESOLUTION_ARGS = [
	"path",
	"file_path",
	"content",
	"reason",
	"status",
	"result",
] as const;
const RESOLUTION_DETAILS = [
	"xdev",
	"action",
	"reason",
	"sourceToolName",
	"label",
	"sourceResultDetails",
	"status",
] as const;
// Vibe worker-session devices (`node_modules/.../src/tools/vibe.ts`): one
// schema per tool, one shared `VibeToolDetails` payload for all five.
const VIBE_SPAWN_ARGS = ["cli", "name", "prompt"] as const;
const VIBE_SEND_ARGS = ["session", "message"] as const;
const VIBE_WAIT_ARGS = ["sessions", "timeout"] as const;
const VIBE_KILL_ARGS = ["session"] as const;
const VIBE_LIST_ARGS: readonly string[] = [];
const VIBE_DETAILS = [
	"op",
	"screens",
	"spawned",
	"send",
	"wait",
	"killed",
] as const;

// Null prototype: direct index of collision keys (constructor/toString/…) must
// yield undefined even for callers that bypass normalizeToolName. Object.hasOwn
// guards on the accessors are belt-and-braces at the untrusted-host boundary.
export const TOOL_ALIASES: Readonly<Partial<Record<string, string>>> =
	Object.freeze(
		Object.assign(Object.create(null), {
			apply_patch: "edit",
		}) as Partial<Record<string, string>>,
	);

function presentationRule(
	route: ToolRoute,
	audit: ToolAuditKind,
	knownArgs: readonly string[],
	knownDetails: readonly string[],
	describe: ToolPresentationRule["describe"],
	resultMeta?: ToolPresentationRule["resultMeta"],
	compactOnExpand?: boolean,
): ToolPresentationRule {
	const rule: ToolPresentationRule = {
		route,
		audit,
		knownArgs: Object.freeze(knownArgs.slice()),
		knownDetails: Object.freeze(knownDetails.slice()),
		describe,
	};
	if (resultMeta !== undefined) rule.resultMeta = resultMeta;
	if (compactOnExpand === true) rule.compactOnExpand = true;
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
		read: presentationRule(
			"read-group",
			"none",
			READ_ARGS,
			READ_DETAILS,
			describeRead,
		),
		bash: presentationRule(
			"compact",
			"git-bash",
			BASH_ARGS,
			BASH_DETAILS,
			describeBash,
			resultMetaBash,
		),
		write: presentationRule(
			"compact",
			"write",
			WRITE_ARGS,
			WRITE_DETAILS,
			describeWrite,
			resultMetaWrite,
		),
		edit: presentationRule(
			"compact",
			"edit",
			EDIT_ARGS,
			EDIT_DETAILS,
			describeEdit,
		),
		grep: presentationRule(
			"compact",
			"none",
			GREP_ARGS,
			GREP_DETAILS,
			describeGrep,
			resultMetaGrep,
		),
		glob: presentationRule(
			"compact",
			"none",
			GLOB_ARGS,
			GLOB_DETAILS,
			describeGlob,
			resultMetaGlob,
		),
		hub: presentationRule(
			"compact",
			"none",
			HUB_ARGS,
			HUB_DETAILS,
			describeHub,
		),
		todo: presentationRule(
			"compact",
			"none",
			TODO_ARGS,
			TODO_DETAILS,
			genericDescribe("todo"),
		),
		eval: presentationRule(
			"compact",
			"none",
			EVAL_ARGS,
			EVAL_DETAILS,
			genericDescribe("eval"),
		),
		yield: presentationRule(
			"compact",
			"none",
			YIELD_ARGS,
			YIELD_DETAILS,
			genericDescribe("yield"),
		),
		hus: presentationRule("compact", "none", [], [], genericDescribe("hus")),
		web_search: presentationRule(
			"compact",
			"none",
			WEB_SEARCH_ARGS,
			[],
			genericDescribe("web_search"),
		),
		ast_grep: presentationRule(
			"compact",
			"none",
			AST_GREP_ARGS,
			[],
			describeAstGrep,
		),
		ast_edit: presentationRule(
			"compact",
			"none",
			AST_EDIT_ARGS,
			[],
			describeAstEdit,
		),
		inspect_image: presentationRule(
			"compact",
			"none",
			INSPECT_IMAGE_ARGS,
			[],
			describeInspectImage,
		),
		browser: presentationRule(
			"compact",
			"none",
			BROWSER_ARGS,
			BROWSER_DETAILS,
			describeBrowser,
			undefined,
			true,
		),
		ask: presentationRule(
			"native-live",
			"none",
			ASK_ARGS,
			ASK_DETAILS,
			genericDescribe("ask"),
		),
		// Historical resolution transcripts: keyed by the `resolve`/`reject`
		// tool names this agent no longer emits (it writes to xd://resolve).
		// Kept as the reserve for those transcripts; `describeWrite` reaches
		// the very same describer through the device path.
		resolve: presentationRule(
			"compact",
			"none",
			RESOLUTION_ARGS,
			RESOLUTION_DETAILS,
			describeTextDevice("resolve"),
			resultMetaResolution,
			true,
		),
		reject: presentationRule(
			"compact",
			"none",
			RESOLUTION_ARGS,
			RESOLUTION_DETAILS,
			describeTextDevice("reject"),
			resultMetaResolution,
			true,
		),
		computer: presentationRule(
			"compact",
			"none",
			COMPUTER_ARGS,
			COMPUTER_DETAILS,
			describeComputer,
			undefined,
			true,
		),
		task: presentationRule("compact", "none", [], [], genericDescribe("task")),
		// Vibe worker-session devices: compact route, and the rows come from
		// the dedicated vibe builder in render.ts (not `describe`). The
		// generic description stays as the bounded fallback for any caller
		// that asks a vibe rule to describe itself. No `compactOnExpand`:
		// explicit expansion keeps the stock framed TV-wall card as the
		// inspection escape hatch, exactly like ordinary compact tools.
		vibe_spawn: presentationRule(
			"compact",
			"none",
			VIBE_SPAWN_ARGS,
			VIBE_DETAILS,
			genericDescribe("vibe_spawn"),
		),
		vibe_send: presentationRule(
			"compact",
			"none",
			VIBE_SEND_ARGS,
			VIBE_DETAILS,
			genericDescribe("vibe_send"),
		),
		vibe_wait: presentationRule(
			"compact",
			"none",
			VIBE_WAIT_ARGS,
			VIBE_DETAILS,
			genericDescribe("vibe_wait"),
		),
		vibe_kill: presentationRule(
			"compact",
			"none",
			VIBE_KILL_ARGS,
			VIBE_DETAILS,
			genericDescribe("vibe_kill"),
		),
		vibe_list: presentationRule(
			"compact",
			"none",
			VIBE_LIST_ARGS,
			VIBE_DETAILS,
			genericDescribe("vibe_list"),
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
 * that a `write` addressing an `xd://` device audits nothing. Such a call
 * dispatches a mounted tool — the path is a transport address, not a file, so
 * routing it into the write-audit path would attribute a local file mutation
 * to a device invocation.
 *
 * The audit module's own URI-scheme guard stays where it is as the second
 * line of defence: this decision keeps device calls out of the write branch
 * altogether instead of relying on a later refusal.
 *
 * Structured args only, no rendered text. An unregistered tool, a malformed
 * device URL, or unreadable args keep the static kind — unknown data must
 * never silently disable a real file audit.
 */
export function resolveToolAudit(name: string, args: unknown): ToolAuditKind {
	const rule = resolveToolRule(name);
	if (rule === undefined) return "none";
	if (rule.audit === "write" && writeDeviceName(record(args)) !== undefined)
		return "none";
	return rule.audit;
}

/**
 * Pure description for explicitly registered rules only; unregistered names
 * resolve to `undefined`. The bounded generic form stays available as a
 * direct helper (`genericToolDescription` in `compact.ts`) for callers that
 * deliberately render an unknown tool — the runtime adapter must never call
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
