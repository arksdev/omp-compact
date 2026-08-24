/**
 * Pure description behavior behind the registered tool rules: one describer
 * per known tool (plus optional settled-result metadata), the text-device
 * presentation table with its helpers, and the hub launch-style mirror.
 *
 * Consumed only by `tool-presentation-rules.ts`, which binds these functions
 * into TOOL_RULES. Nothing here knows routes, audit kinds or aliases — every
 * function is a pure `args → ToolDescription` (or `result → meta`) mapping
 * that never touches the filesystem.
 */
// External dependency: parseXdUrl from @oh-my-pi/pi-coding-agent. The device-URL
// grammar (trim, case-insensitive prefix, `/?#` rejection, bare-root form) must
// not drift from the stock router that actually dispatches these calls.
import { parseXdUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/xd-protocol";
import {
	editPathsFromInput,
	genericToolDescription,
	listValue,
	record,
	stringValue,
	truncateCodePoints,
	type ToolDescription,
} from "./compact";
import { type DisplayPathOptions, displayPathValue } from "./display-path";
import type { ToolPresentationRule } from "./tool-presentation-rules";

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

export function describeRead(
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

export function describeBash(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	const value = record(args);
	const description = stringValue(value, "command");
	const cwd = stringValue(value, "cwd");
	const meta = cwd ? [`in ${displayPathValue(cwd, displayPaths)}`] : [];
	return { title: "bash", description, meta };
}

export function resultMetaBash(result: unknown): readonly string[] {
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

/**
 * Stock text devices: their device content is a prose reason or title, never a
 * JSON args object, so they present through the resolution description
 * (`node_modules/.../tools/resolve.ts` `dispatchResolutionDevice`,
 * `report-tool-issue.ts` `dispatchReportIssueDevice`).
 *
 * Deliberate dual addressing: `resolve`/`reject` are ALSO registry keys in
 * TOOL_RULES, because historical transcripts still carry them as tool names —
 * this agent never emits those names, it dispatches `write` to `xd://resolve`.
 * The registry entries stay as the reserve for such transcripts; the device
 * path below reuses their describer instead of growing a second one.
 * Null prototype: an untrusted device name must not reach Object.prototype.
 */
interface TextDevicePresentation {
	readonly title: string;
	readonly titleColor?: string;
}
const TEXT_DEVICES: Readonly<Partial<Record<string, TextDevicePresentation>>> =
	Object.freeze(
		Object.assign(Object.create(null), {
			resolve: { title: "resolve", titleColor: "#A4D734" },
			reject: { title: "reject", titleColor: "#A1471A" },
			propose: { title: "propose" },
			report_issue: { title: "report issue" },
		}) as Partial<Record<string, TextDevicePresentation>>,
	);

/** Longest device content this module will attempt to parse as JSON args. */
const MAX_DEVICE_CONTENT = 65_536;

/**
 * Device name of an `xd://<device>` write, or `undefined` when the target is
 * an ordinary path. `parseXdUrl` is the stock grammar: `null` for a non-device
 * or malformed URL, `name: null` for the bare `xd://` root — both stay
 * `undefined` here, so an unrecognized target keeps plain write presentation.
 */
export function writeDeviceName(
	value: Record<string, unknown>,
): string | undefined {
	const path = stringValue(value, "path") || stringValue(value, "file_path");
	if (!path) return undefined;
	return parseXdUrl(path)?.name ?? undefined;
}

/**
 * Operation key of a device args object: stock schemas spell it `op` (`gh`)
 * or `action` (`security_scan`, `debug`, `browser`), and some devices
 * (`ast_grep`) carry none. Absent operation yields "" — never a placeholder.
 */
function deviceOperationOf(value: Record<string, unknown>): string {
	return stringValue(value, "op") || stringValue(value, "action");
}

/**
 * Operation of a JSON device call, read from the written content. Streaming
 * fragments, non-JSON bodies, arrays and over-budget payloads yield "": the
 * row then names the device alone until the settled result confirms more.
 */
function deviceOperationFromContent(content: string): string {
	if (!content || content.length > MAX_DEVICE_CONTENT) return "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return "";
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
	return deviceOperationOf(parsed as Record<string, unknown>);
}

/**
 * Presentation of a text device, or `undefined` for a JSON-args device.
 * Own-property only (belt-and-braces): see normalizeToolName.
 */
function textDevice(device: string): TextDevicePresentation | undefined {
	return Object.hasOwn(TEXT_DEVICES, device) ? TEXT_DEVICES[device] : undefined;
}

/**
 * Describer bound to one text device. Shared by the device path in
 * `describeWrite` and by the historical `resolve`/`reject` registry keys, so
 * each device's title and color live in TEXT_DEVICES and nowhere else.
 */
export function describeTextDevice(
	device: string,
): ToolPresentationRule["describe"] {
	const presentation = textDevice(device);
	const title = presentation?.title ?? device;
	const titleColor = presentation?.titleColor;
	return (args: unknown) => describeResolution(title, titleColor, args);
}

/**
 * A `write` is either a file write or an `xd://` device dispatch executing a
 * mounted tool. The device form names the device and its operation; printing
 * the transport path (`xd://github`) would read as a write to a fake file.
 */
export function describeWrite(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	const value = record(args);
	const device = writeDeviceName(value);
	if (device !== undefined) {
		const text = textDevice(device);
		if (text) return describeResolution(text.title, text.titleColor, value);
		return {
			// The device name as addressed: bounded, never re-spelled, so the
			// row stays checkable against the `xd://<device>` the model wrote.
			title: truncateCodePoints(device, 64),
			description: deviceOperationFromContent(stringValue(value, "content")),
			meta: [],
		};
	}
	return {
		title: "write",
		description: pathValue(value, displayPaths),
		meta: [],
	};
}

/**
 * Settled metadata of a device write. The operation is confirmed from the
 * validated dispatch args (`details.xdev.args`) — the authoritative copy that
 * actually executed — and printed only when the call content did not already
 * name it. Text devices delegate to the resolution metadata. A file write, a
 * help-mode dispatch (no args), and missing/broken details print nothing.
 */
export function resultMetaWrite(
	result: unknown,
	args?: unknown,
): readonly string[] {
	const value = record(args);
	const device = writeDeviceName(value);
	if (device === undefined) return [];
	if (textDevice(device)) return resultMetaResolution(result);
	const dispatch = record(record(record(result).details).xdev);
	const operation = deviceOperationOf(record(dispatch.args));
	if (!operation) return [];
	return operation === deviceOperationFromContent(stringValue(value, "content"))
		? []
		: [operation];
}

export function describeEdit(
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

export function describeGrep(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	const value = record(args);
	const description = stringValue(value, "pattern") || "?";
	const paths = pathList(value, displayPaths);
	const meta = paths.length > 0 ? [`in ${paths.join(", ")}`] : [];
	return { title: "grep", description, meta };
}

export function resultMetaGrep(result: unknown): readonly string[] {
	const details = record(record(result).details);
	return typeof details.matchCount === "number"
		? [`${details.matchCount} match${details.matchCount === 1 ? "" : "es"}`]
		: [];
}

export function describeGlob(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	return {
		title: "glob",
		description: pathList(record(args), displayPaths).join(", ") || "*",
		meta: [],
	};
}

export function resultMetaGlob(result: unknown): readonly string[] {
	const details = record(record(result).details);
	return typeof details.fileCount === "number"
		? [`${details.fileCount} file${details.fileCount === 1 ? "" : "s"}`]
		: [];
}

export function describeAstGrep(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	const value = record(args);
	const description = stringValue(value, "pat") || "?";
	const paths = pathList(value, displayPaths);
	const meta = paths.length > 0 ? [`in ${paths.join(", ")}`] : [];
	return { title: "ast grep", description, meta };
}

export function describeAstEdit(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	return {
		title: "ast edit",
		description: pathList(record(args), displayPaths).join(", "),
		meta: [],
	};
}

export function describeInspectImage(
	args: unknown,
	displayPaths?: DisplayPathOptions,
): ToolDescription {
	return {
		title: "inspect image",
		description: pathValue(record(args), displayPaths),
		meta: [],
	};
}

export function describeBrowser(args: unknown): ToolDescription {
	const value = record(args);
	// URL only; the action is the fallback when no URL was given.
	const description = stringValue(value, "url") || stringValue(value, "action");
	return { title: "browser", description, meta: [] };
}

export function describeComputer(args: unknown): ToolDescription {
	const value = record(args);
	// Shortest useful action: the intent field when present, else the first
	// non-empty line of the executed JS, else a neutral placeholder. Bound the
	// extraction so a dense one-line script cannot flood the row.
	const intent = stringValue(value, "i");
	const code = stringValue(value, "code");
	const firstLine = code.split("\n").find((line) => line.trim() !== "") ?? "";
	const description = truncateCodePoints(intent || firstLine || "?", 160);
	const meta = value.read_only === true ? ["read-only"] : [];
	return {
		title: "computer use",
		description,
		meta,
		titleColor: "#8D2A88",
	};
}

/**
 * Resolution/text devices (xd://resolve, xd://reject, xd://propose,
 * xd://report_issue) carry the write call shape: the device `path` plus the
 * one-sentence `content` reason, and optionally a direct
 * `reason`/`status`/yield-style `result.error` field. Extract the best short
 * structured field, never parsed native/ANSI output.
 *
 * Reached two ways: through the `resolve`/`reject` registry keys (historical
 * transcripts that carry those tool names) and through `describeWrite` when a
 * `write` addresses one of these devices. One describer, both paths.
 */
function describeResolution(
	title: string,
	titleColor: string | undefined,
	args: unknown,
): ToolDescription {
	const value = record(args);
	const resultError = stringValue(record(value.result), "error");
	const description =
		stringValue(value, "content") ||
		stringValue(value, "reason") ||
		resultError ||
		stringValue(value, "status") ||
		stringValue(value, "path") ||
		"?";
	return { title, description, meta: [], titleColor };
}

/** Settled resolution metadata: the apply/discard action plus its source. */
export function resultMetaResolution(result: unknown): readonly string[] {
	const details = record(record(result).details);
	const xdev = record(details.xdev);
	const inner = record(xdev.inner);
	const action = stringValue(inner, "action") || stringValue(details, "status");
	const source =
		stringValue(inner, "sourceToolName") || stringValue(inner, "label");
	const meta: string[] = [];
	if (action) meta.push(action);
	if (source) meta.push(source);
	return meta;
}

/** Registered routine/interactive tools describe through the bounded generic form. */
export function genericDescribe(name: string) {
	return (args: unknown): ToolDescription => genericToolDescription(name, args);
}

/**
 * Hub launch-style ops (stock `isLaunchStyleArgs`): explicit process ops, or
 * `send`/`wait` targeting a process `name` without a peer `to`/`from`.
 * Mirrors `node_modules/.../tools/hub/index.ts` so compact titles track the
 * framed 🚀 Launch chrome users see natively.
 */
const HUB_LAUNCH_OPS: Readonly<Record<string, true>> = Object.freeze({
	start: true,
	ps: true,
	logs: true,
	stop: true,
	restart: true,
	describe: true,
});

function isHubLaunchStyleArgs(args: Record<string, unknown>): boolean {
	const op = stringValue(args, "op");
	if (!op) return false;
	if (HUB_LAUNCH_OPS[op]) return true;
	if (op !== "send" && op !== "wait") return false;
	return (
		stringValue(args, "name").length > 0 &&
		stringValue(args, "to").length === 0 &&
		stringValue(args, "from").length === 0
	);
}

/** Launch ops → `launch: logs web` / `launch: start web bun`; else generic hub. */
export function describeHub(args: unknown): ToolDescription {
	const value = record(args);
	if (!isHubLaunchStyleArgs(value)) return genericToolDescription("hub", args);
	const op = stringValue(value, "op");
	const displayOp = op === "ps" ? "list" : op;
	const name = stringValue(value, "name");
	const application = stringValue(value, "application");
	const parts: string[] = [];
	if (displayOp) parts.push(displayOp);
	if (name) parts.push(name);
	else if (application) parts.push(application);
	if (op === "start" && name && application) parts.push(application);
	return {
		title: "launch",
		description: parts.join(" "),
		meta: [],
	};
}
