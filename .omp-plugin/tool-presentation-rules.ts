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
import {
	editPathsFromInput,
	genericToolDescription,
	listValue,
	record,
	stringValue,
	type ToolDescription,
} from "./compact";
import { type DisplayPathOptions, displayPathValue } from "./display-path";

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
	/** Pure description from structured args; never touches the filesystem. */
	describe(args: unknown, displayPaths?: DisplayPathOptions): ToolDescription;
	/** Optional settled result metadata (e.g. bash exit code / wall time). */
	resultMeta?(result: unknown): readonly string[];
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
const HUB_ARGS = ["op", "to", "from", "message", "replyTo", "await"] as const;
const HUB_DETAILS = [
	"op",
	"from",
	"to",
	"receipts",
	"waited",
	"isError",
	"error",
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

const TOOL_ALIASES: Readonly<Partial<Record<string, string>>> = Object.freeze({
	apply_patch: "edit",
});

function pathValue(
	value: Record<string, unknown>,
	displayPaths?: DisplayPathOptions,
): string {
	return displayPathValue(
		stringValue(value, "path") || stringValue(value, "file_path"),
		displayPaths,
	);
}

function pathList(
	value: Record<string, unknown>,
	displayPaths?: DisplayPathOptions,
): string[] {
	const paths = listValue(value, "path");
	const selected = paths.length > 0 ? paths : listValue(value, "paths");
	return selected.map((path) => displayPathValue(path, displayPaths));
}

function describeRead(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	const value = record(args);
	let description = pathValue(value, displayPaths);
	const offset = typeof value.offset === "number" ? value.offset : undefined;
	const limit = typeof value.limit === "number" ? value.limit : undefined;
	if (offset !== undefined || limit !== undefined) {
		const start = offset ?? 1;
		const end = limit === undefined ? undefined : start + limit - 1;
		description += `:${start}${end === undefined ? "" : `-${end}`}`;
	}
	return { title: "read", description, meta: [] };
}

function describeBash(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	const value = record(args);
	const description = stringValue(value, "command");
	const cwd = stringValue(value, "cwd");
	const meta = cwd ? [`in ${displayPathValue(cwd, displayPaths)}`] : [];
	return { title: "bash", description, meta };
}

function resultMetaBash(result: unknown): readonly string[] {
	const details = record(record(result).details);
	const meta: string[] = [];
	if (typeof details.exitCode === "number" && details.exitCode !== 0)
		meta.push(`exit ${details.exitCode}`);
	if (typeof details.wallTimeMs === "number") {
		const seconds = details.wallTimeMs / 1000;
		meta.push(`${seconds.toFixed(seconds < 10 ? 1 : 0)}s`);
	}
	return meta;
}

function describeWrite(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	return {
		title: "write",
		description: pathValue(record(args), displayPaths),
		meta: [],
	};
}

function describeEdit(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	const value = record(args);
	const description =
		pathValue(value, displayPaths) ||
		pathList(value, displayPaths).join(", ") ||
		editPathsFromInput(
			stringValue(value, "input") || stringValue(value, "_input"),
		)
			.map((path) => displayPathValue(path, displayPaths))
			.join(", ");
	return { title: "edit", description, meta: [] };
}

function describeGrep(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	const value = record(args);
	const description = stringValue(value, "pattern") || "?";
	const paths = pathList(value, displayPaths);
	const meta = paths.length > 0 ? [`in ${paths.join(", ")}`] : [];
	return { title: "grep", description, meta };
}

function resultMetaGrep(result: unknown): readonly string[] {
	const details = record(record(result).details);
	return typeof details.matchCount === "number"
		? [`${details.matchCount} match${details.matchCount === 1 ? "" : "es"}`]
		: [];
}

function describeGlob(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	return {
		title: "glob",
		description: pathList(record(args), displayPaths).join(", ") || "*",
		meta: [],
	};
}

function resultMetaGlob(result: unknown): readonly string[] {
	const details = record(record(result).details);
	return typeof details.fileCount === "number"
		? [`${details.fileCount} file${details.fileCount === 1 ? "" : "s"}`]
		: [];
}

function describeAstGrep(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	const value = record(args);
	const description = stringValue(value, "pat") || "?";
	const paths = pathList(value, displayPaths);
	const meta = paths.length > 0 ? [`in ${paths.join(", ")}`] : [];
	return { title: "ast grep", description, meta };
}

function describeAstEdit(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	return {
		title: "ast edit",
		description: pathList(record(args), displayPaths).join(", "),
		meta: [],
	};
}

function describeInspectImage(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	return {
		title: "inspect image",
		description: pathValue(record(args), displayPaths),
		meta: [],
	};
}

function describeBrowser(args: unknown): ToolDescription {
	const value = record(args);
	const description = [stringValue(value, "action"), stringValue(value, "url")]
		.filter(Boolean)
		.join(" ");
	return { title: "browser", description, meta: [] };
}

/** Registered routine/interactive tools describe through the bounded generic form. */
function genericDescribe(name: string) {
	return (args: unknown): ToolDescription => genericToolDescription(name, args);
}

function presentationRule(
	route: ToolRoute,
	audit: ToolAuditKind,
	knownArgs: readonly string[],
	knownDetails: readonly string[],
	describe: ToolPresentationRule["describe"],
	resultMeta?: ToolPresentationRule["resultMeta"],
): ToolPresentationRule {
	const rule: ToolPresentationRule = {
		route,
		audit,
		knownArgs: Object.freeze(knownArgs.slice()),
		knownDetails: Object.freeze(knownDetails.slice()),
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
 */
export const TOOL_RULES: Readonly<
	Partial<Record<string, ToolPresentationRule>>
> = Object.freeze({
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
		genericDescribe("hub"),
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
	browser: presentationRule("native-live", "none", [], [], describeBrowser),
	ask: presentationRule(
		"native-live",
		"none",
		ASK_ARGS,
		ASK_DETAILS,
		genericDescribe("ask"),
	),
	resolve: presentationRule(
		"native-live",
		"none",
		[],
		[],
		genericDescribe("resolve"),
	),
	reject: presentationRule(
		"native-live",
		"none",
		[],
		[],
		genericDescribe("reject"),
	),
	computer: presentationRule(
		"native-live",
		"none",
		[],
		[],
		genericDescribe("computer"),
	),
	task: presentationRule("compact", "none", [], [], genericDescribe("task")),
});

/**
 * Canonical spelling of a tool name: hyphen aliases map to their underscore
 * canonical names (`ast-grep` → `ast_grep`, `ast-edit` → `ast_edit`).
 * Deterministic for any spelling.
 */
export function normalizeToolName(name: string): string {
	const normalized = name.replaceAll("-", "_");
	return TOOL_ALIASES[normalized] ?? normalized;
}

/**
 * Explicit registry lookup. Returns the rule for a registered canonical name
 * (aliases resolve through `normalizeToolName`) or `undefined` — it never
 * synthesizes an implicit compact rule for unknown tools.
 */
export function resolveToolRule(
	name: string,
): ToolPresentationRule | undefined {
	return TOOL_RULES[normalizeToolName(name)] ?? undefined;
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
