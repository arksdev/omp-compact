/**
 * Replay-corpus coverage inventory.
 *
 * Classifies every normalized tool/output shape present in the fixture
 * corpus and fails when an unknown shape would silently fall back to native
 * rendering. The single source of truth for tool presentation is the
 * production registry `tool-presentation-rules.ts`: a tool name, arg key,
 * or result-detail key that appears in the corpus but is not declared by
 * its production rule fails the suite, so new fixture shapes force a
 * deliberate production decision instead of being silently ignored.
 *
 * Routes are the production registry's own:
 * - "compact"     — routine tools rendered as compact rows.
 * - "read-group"  — read streams rendered through the native read group.
 * - "native-live" — interactive surfaces (ask/resolve/reject/computer/
 *   browser/task) that stay native during the live phase. The 10 real
 *   histories in this corpus exercise only "ask"; the exact native-live
 *   set observed is asserted below.
 *
 * Non-tool fallback reasons ("unmapped", "expanded", "incompatible") may
 * render natively by design, but they are integration-only safety classes
 * enforced by the synthetic integration suite — never corpus coverage.
 * Every tool observed in this corpus must resolve to an explicit
 * production rule; the fallback list is referenced only to keep the error
 * message actionable when a new shape appears.
 *
 * Goldens stay fully independent of the registry: they are checked in
 * replay.test.ts against the actual projected rows/carriers, so an
 * incorrect production route still changes a golden and fails. This file
 * only guarantees the corpus↔golden pairing.
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReplayEvent, ReplayFixture } from "./replay/harness";
import type { ToolRoute } from "../../.omp-plugin/tool-presentation-rules";
import {
	normalizeToolName,
	resolveToolRule,
	TOOL_RULES,
} from "../../.omp-plugin/tool-presentation-rules";

const fixturesDir = join(import.meta.dir, "replay", "fixtures");
const goldenDir = join(import.meta.dir, "replay", "golden");

// Non-tool fallback reasons that may render natively without a registry
// entry. Integration-only safety classes: the synthetic integration suite
// enforces them; the replay corpus must never rely on them (every observed
// tool resolves to an explicit production rule).
const SAFE_FALLBACK_CLASSES = ["unmapped", "expanded", "incompatible"];

const PRODUCTION_ROUTES: readonly ToolRoute[] = [
	"compact",
	"read-group",
	"native-live",
];

const ALLOWED_EVENT_TYPES: Record<string, true> = {
	run_start: true,
	tool_start: true,
	tool_result: true,
	continue: true,
	answer: true,
	run_end: true,
	session_shutdown: true,
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

interface ShapeFailure {
	message: string;
}

function classifyFixture(fixture: ReplayFixture): ShapeFailure[] {
	const failures: ShapeFailure[] = [];
	const starts = new Map<string, { name: string }>();
	const results = new Map<string, { name: string }>();

	const fail = (message: string): void => {
		failures.push({ message });
	};

	for (const [index, event] of fixture.events.entries()) {
		const where = `event ${index} (${event.t})`;
		if (!ALLOWED_EVENT_TYPES[event.t]) {
			fail(`${where}: unknown event type ${event.t}`);
			continue;
		}
		if (event.t === "tool_start") {
			const name = String(event.name ?? "");
			const rule = resolveToolRule(name);
			if (!rule) {
				fail(
					`${where}: unresolved tool name "${name}" — add an explicit rule to tool-presentation-rules.ts (fallback reasons ${SAFE_FALLBACK_CLASSES.join("/")} are integration-only and do not cover fixtures)`,
				);
				continue;
			}
			starts.set(String(event.id), { name });
			for (const key of Object.keys(record(event.args))) {
				if (!rule.knownArgs.includes(key)) {
					fail(
						`${where}: tool "${name}" has undeclared arg key "${key}" (declared: ${rule.knownArgs.join(", ") || "none"})`,
					);
				}
			}
			continue;
		}
		if (event.t === "tool_result") {
			const id = String(event.id);
			const name = String(event.name ?? "");
			const start = starts.get(id);
			if (!start) {
				fail(`${where}: tool_result without a matching tool_start (id ${id})`);
				continue;
			}
			if (start.name !== name) {
				fail(
					`${where}: tool_result name "${name}" does not match its start "${start.name}"`,
				);
			}
			const rule = resolveToolRule(name);
			if (!rule) {
				fail(
					`${where}: result for unresolved tool "${name}" — unknown shapes must not silently fall back`,
				);
				continue;
			}
			const result = record(event.result);
			const content = result.content;
			if (!Array.isArray(content)) {
				fail(`${where}: result content is not an array`);
			} else {
				for (const block of content) {
					const type = record(block).type;
					if (type !== "text") {
						fail(
							`${where}: undeclared result content block type "${String(type)}"`,
						);
					}
				}
			}
			for (const key of Object.keys(record(result.details))) {
				if (!rule.knownDetails.includes(key)) {
					fail(
						`${where}: tool "${name}" has undeclared result detail key "${key}" (declared: ${rule.knownDetails.join(", ") || "none"})`,
					);
				}
			}
			results.set(id, { name });
		}
	}

	// Pair integrity: every start resolves exactly one result and vice versa.
	for (const [id, start] of starts) {
		if (!results.has(id)) {
			fail(`tool_start ${id} (${start.name}) has no tool_result`);
		}
	}
	for (const [id] of results) {
		if (!starts.has(id)) {
			fail(`tool_result ${id} has no tool_start`);
		}
	}
	return failures;
}

const PRIVACY_PATTERNS: Array<[RegExp, string]> = [
	[/\/Users\/[A-Za-z0-9._-]+/, "absolute user path"],
	[
		/\/Volumes\/Storage2T\/Projects\/(?!orca-plugins)/,
		"other-project absolute path",
	],
	[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "email"],
	[/sk-[A-Za-z0-9_-]{8,}/, "API key"],
	[/ghp_[A-Za-z0-9]{20,}/, "GitHub token"],
	[/AKIA[0-9A-Z]{16}/, "AWS key"],
	[/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/, "bearer token"],
	[/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
];

function walkStrings(value: unknown, visit: (text: string) => void): void {
	if (typeof value === "string") {
		visit(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) walkStrings(item, visit);
		return;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) {
			walkStrings(item, visit);
		}
	}
}

const fixtureFiles = readdirSync(fixturesDir)
	.filter((file) => file.endsWith(".json"))
	.sort();

test("inventory: every fixture shape is classified with an explicit route", () => {
	const allFailures: ShapeFailure[] = [];
	for (const file of fixtureFiles) {
		const fixture = JSON.parse(
			readFileSync(join(fixturesDir, file), "utf8"),
		) as ReplayFixture;
		for (const failure of classifyFixture(fixture)) {
			allFailures.push({ message: `${file}: ${failure.message}` });
		}
	}
	expect(allFailures.map((failure) => failure.message).join("\n")).toBe("");
});

test("inventory: every observed tool resolves to an explicit production rule", () => {
	const observed = new Set<string>();
	for (const file of fixtureFiles) {
		const fixture = JSON.parse(
			readFileSync(join(fixturesDir, file), "utf8"),
		) as ReplayFixture;
		for (const event of fixture.events) {
			if (event.t === "tool_start") observed.add(String(event.name));
		}
	}
	for (const name of observed) {
		const rule = resolveToolRule(name);
		expect(
			rule,
			`tool "${name}" lacks a production rule in tool-presentation-rules.ts`,
		).toBeDefined();
		if (!rule) continue;
		expect(
			PRODUCTION_ROUTES,
			`tool "${name}" has an invalid production route`,
		).toContain(rule.route);
	}
});

test("inventory: the only native-live tool in the real histories is ask", () => {
	const observed = new Set<string>();
	for (const file of fixtureFiles) {
		const fixture = JSON.parse(
			readFileSync(join(fixturesDir, file), "utf8"),
		) as ReplayFixture;
		for (const event of fixture.events) {
			if (event.t === "tool_start") observed.add(String(event.name));
		}
	}
	const nativeLive = [...observed]
		.filter((name) => resolveToolRule(name)?.route === "native-live")
		.sort();
	expect(nativeLive).toEqual(["ask"]);
});

test("inventory: alias names normalize onto canonical production rules", () => {
	expect(normalizeToolName("ast-grep")).toBe("ast_grep");
	expect(normalizeToolName("ast-edit")).toBe("ast_edit");
	for (const [name, rule] of Object.entries(TOOL_RULES)) {
		expect(normalizeToolName(name), `key "${name}" is not canonical`).toBe(
			name,
		);
		expect(resolveToolRule(name)).toBe(rule);
	}
	expect(resolveToolRule("ast-grep")).toBe(TOOL_RULES.ast_grep);
	expect(resolveToolRule("ast-edit")).toBe(TOOL_RULES.ast_edit);
	// Fail-open resolver: unknown names never synthesize a compact rule.
	expect(resolveToolRule("no-such-tool")).toBeUndefined();
});

test("inventory: corpus carries the structurally unique shapes it claims", () => {
	const fixtures = fixtureFiles.map((file) =>
		JSON.parse(readFileSync(join(fixturesDir, file), "utf8")),
	) as ReplayFixture[];
	// Read-group streams (read tool_starts with path selectors).
	const reads = fixtures.flatMap((fixture) =>
		fixture.events.filter(
			(event) => event.t === "tool_start" && event.name === "read",
		),
	);
	expect(reads.length).toBeGreaterThan(10);
	expect(
		reads.some(
			(event) =>
				typeof record(event.args).path === "string" &&
				String(record(event.args).path).includes(":"),
		),
	).toBe(true);
	// Real mutation and git evidence paths are present in the corpus.
	const bashCommands = fixtures.flatMap((fixture) =>
		fixture.events
			.filter(
				(event) =>
					event.t === "tool_start" &&
					event.name === "bash" &&
					typeof record(event.args).command === "string",
			)
			.map((event) => String(record(event.args).command)),
	);
	expect(
		bashCommands.some((command) => command.startsWith("git")),
		"corpus must carry real git command shapes",
	).toBe(true);
	expect(
		bashCommands.some((command) => command.includes("&&")),
		"corpus must carry real compound shell shapes",
	).toBe(true);
	const editResults = fixtures.flatMap((fixture) =>
		fixture.events.filter(
			(event) =>
				event.t === "tool_result" &&
				event.name === "edit" &&
				typeof record(event.result).details === "object",
		),
	);
	expect(
		editResults.some((event) => "diff" in record(record(event.result).details)),
		"corpus must carry real edit diff shapes",
	).toBe(true);
	// Unicode and aborted-terminal shapes are present.
	const allText = fixtures
		.flatMap((fixture) => fixture.events)
		.flatMap((event) => {
			const texts: string[] = [];
			walkStrings(event.text ?? event.result, (text) => texts.push(text));
			return texts;
		});
	expect(allText.some((text) => /[\u0400-\u04FF]/.test(text))).toBe(true);
	expect(fixtures.some((fixture) => fixture.meta.terminal === "aborted")).toBe(
		true,
	);
});

test("inventory: every fixture has a golden and every golden has a fixture", () => {
	const fixtureIds = new Set(
		fixtureFiles.map((file) => file.replace(/\.json$/, "")),
	);
	const goldenFiles = readdirSync(goldenDir)
		.filter((file) => file.endsWith(".json"))
		.sort();
	const missingGoldens = fixtureFiles.filter(
		(file) => !existsSync(join(goldenDir, file)),
	);
	const orphanGoldens = goldenFiles.filter(
		(file) => !fixtureIds.has(file.replace(/\.json$/, "")),
	);
	expect(missingGoldens, "fixtures without a golden projection").toEqual([]);
	expect(orphanGoldens, "goldens without a fixture").toEqual([]);
});

test("inventory: corpus is redacted — no user paths, emails, or tokens", () => {
	for (const file of fixtureFiles) {
		const fixture = JSON.parse(
			readFileSync(join(fixturesDir, file), "utf8"),
		) as ReplayFixture;
		const leaks: string[] = [];
		walkStrings(fixture, (text) => {
			for (const [pattern, label] of PRIVACY_PATTERNS) {
				if (pattern.test(text)) {
					leaks.push(`${label}: ${text.slice(0, 80)}`);
					break;
				}
			}
		});
		expect(leaks, `${file} leaked identifiers`).toEqual([]);
	}
});

test("inventory: result shapes stay capped and structurally bounded", () => {
	for (const file of fixtureFiles) {
		const fixture = JSON.parse(
			readFileSync(join(fixturesDir, file), "utf8"),
		) as ReplayFixture;
		for (const event of fixture.events as ReplayEvent[]) {
			if (event.t === "tool_result") {
				const content = record(event.result).content;
				if (Array.isArray(content)) {
					for (const block of content) {
						const text = record(block).text;
						expect(
							typeof text !== "string" || text.length <= 800,
							`${file}: result text exceeds the fixture cap`,
						).toBe(true);
					}
				}
			}
		}
	}
});
