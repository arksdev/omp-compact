import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	BLOCK_FOLD_METHODS,
	isBashExecutionComponent,
	isEvalExecutionComponent,
	isLateDiagnosticsMessageComponent,
	isSkillMessageComponent,
	isTodoReminderComponent,
	isTtsrNotificationComponent,
	READ_GROUP_METHODS,
	READ_GROUP_PATCH_METHODS,
	TOOL_METHODS,
	TOOL_PATCH_METHODS,
	TRANSCRIPT_CRITICAL_METHODS,
	TRANSCRIPT_FOLD_METHODS,
	TRANSCRIPT_FOLD_OPTIONAL_METHODS,
	TRANSCRIPT_OPTIONAL_METHODS,
	TUI_OPTIONAL_METHODS,
} from "../../.omp-plugin/host-surface";
import {
	injectRulesFromTtsrComponent,
	lateDiagnosticsFromComponent,
	skillMessageFromComponent,
	todoReminderFromComponent,
	userBashExecutionFromComponent,
	userEvalExecutionFromComponent,
} from "../../.omp-plugin/render-scrape";
import { loadStockHost, stockHostVersion } from "./test-stock-host";

const binary = process.env.OMP_STOCK_BIN;
const stockTest = binary ? test : test.skip;

/**
 * Live host patch-surface guard (plan-post-kiro9, task 1).
 *
 * The manifests in `.omp-plugin/host-surface.ts` are the single source of
 * truth for the method names this plugin patches. The plugin's own runtime
 * guards only check `typeof x === "function"`, so a host version that
 * renames, deletes or re-signatures one of these methods (or silently
 * changes an argument position) passes every guard and breaks presentation
 * semantics instead. This suite reads the live stock host selected through
 * `OMP_STOCK_BIN` and asserts presence and exact `Function.prototype.length`
 * for the patched surface, so a host bump must either keep the surface
 * identical or trip here — before the defects reach a session.
 */
const VERIFIED_HOST_VERSION = "18.1.10";

/**
 * Method arity measured on the live host.
 *
 * Verbatim numbers checked against both 18.0.8 and 18.0.10 (probe of the
 * real prototypes), and re-checked on the 18.1.10 pin (arities unchanged).
 * `updateResult` is 1, not 3: the host's `isPartial`
 * parameter has a default, so `Function.prototype.length` stops before it —
 * do not "fix" it to 3.
 */
const EXPECTED_ARITY: Readonly<Record<string, number>> = Object.freeze({
	addChild: 1,
	render: 1,
	renderViewport: 3,
	liveRowCount: 1,
	peekFinalizedBatch: 2,
	acknowledgeFinalizedBatch: 1,
	canRemoveBlock: 1,
	blockStates: 0,
	clear: 0,
	peekReplayBatch: 1,
	renderTail: 2,
	peekFlushBatch: 1,
	updateArgs: 2,
	// isPartial has a default — see the table comment above.
	updateResult: 1,
	setArgsComplete: 1,
	setExpanded: 1,
	seal: 0,
	setToolActivityVisible: 1,
	removeEntry: 1,
	renameEntry: 2,
	resetDisplay: 0,
	// Block-fold reads (never patched), measured on 18.0.8 and 18.0.10.
	isTranscriptBlockFinalized: 0,
	isDisplaceableBlock: 0,
});

type HostMethod = (...args: unknown[]) => unknown;

/** Walks the instance's prototype chain exactly like the live adapter does. */
function ownMethod(target: object, name: string): HostMethod | undefined {
	let current: object | null = target;
	while (current !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(current, name);
		if (descriptor !== undefined) {
			return typeof descriptor.value === "function"
				? (descriptor.value as HostMethod)
				: undefined;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function expectRequiredMethod(target: object, name: string): HostMethod {
	const fn = ownMethod(target, name);
	expect(
		typeof fn,
		`required host method "${name}" is not a function on the live host`,
	).toBe("function");
	return fn as HostMethod;
}

function expectArity(name: string, fn: HostMethod): void {
	const expected = EXPECTED_ARITY[name];
	if (expected === undefined) {
		throw new Error(`no expected arity recorded for "${name}"`);
	}
	expect(
		fn.length,
		`"${name}" arity is ${fn.length}, expected ${expected}`,
	).toBe(expected);
}

function expectRequiredSurface(target: object, names: readonly string[]): void {
	for (const name of names) {
		expectArity(name, expectRequiredMethod(target, name));
	}
}

/**
 * Plan tri-state rule for optional manifests: ABSENT is fine (the plugin
 * fails open to native), present-with-wrong-arity fails. There is no third
 * acceptable state.
 */
function expectOptionalSurface(target: object, names: readonly string[]): void {
	for (const name of names) {
		const fn = ownMethod(target, name);
		if (typeof fn !== "function") continue;
		expectArity(name, fn);
	}
}

/** Live instances for the three patched surfaces (theme initialized first). */
async function liveSurface() {
	const host = await loadStockHost();
	await host.initTheme();
	const transcript = new host.TranscriptContainer();
	const toolUi = {
		requestRender() {},
		requestComponentRender() {},
		requestScrollbackRebuild() {},
		clearInlineImages() {},
		terminalWidth: 120,
		setWorkingMessage() {},
		setStatus() {},
		getToolsExpanded: () => false,
		setToolsExpanded() {},
	};
	const tool = new host.ToolExecutionComponent(
		"bash",
		{ command: "true" },
		{ showImages: false, useBuiltInRenderer: true },
		{
			name: "bash",
			label: "bash",
			description: "bash",
			parameters: {},
			execute: async () => ({ content: [], details: {} }),
		},
		toolUi,
		"/tmp",
		"canary-tool",
	);
	const readGroup = new host.ReadToolGroupComponent();
	return { host, transcript, tool, readGroup };
}

/**
 * Minimal TUI stand-in the execution leaves need. Both constructors take the
 * live `TUI` and only reach for the render callbacks and the width while
 * building their frame, so this covers construction without a terminal.
 */
const EXECUTION_UI = {
	terminalWidth: 120,
	requestRender() {},
	requestComponentRender() {},
};

describe("live host patch surface", () => {
	stockTest("host version drift warns instead of failing", () => {
		const version = stockHostVersion();
		if (version !== VERIFIED_HOST_VERSION) {
			console.warn(
				`[host-patch-surface] live host is ${version}, surface verified against ${VERIFIED_HOST_VERSION}. ` +
					"Run the host-bump checklist (docs/CONTRIBUTING.md) and re-measure the arities before shipping.",
			);
		}
	});

	stockTest(
		"transcript critical + fold methods exist with verified arity",
		async () => {
			const { transcript } = await liveSurface();
			// Both manifests asserted separately: fold methods are a subset of
			// critical, and re-asserting a shared name checks it twice — harmless.
			expectRequiredSurface(transcript, TRANSCRIPT_CRITICAL_METHODS);
			expectRequiredSurface(transcript, TRANSCRIPT_FOLD_METHODS);
		},
	);

	stockTest(
		"optional transcript methods are absent or have verified arity",
		async () => {
			const { transcript } = await liveSurface();
			expectOptionalSurface(transcript, TRANSCRIPT_OPTIONAL_METHODS);
			expectOptionalSurface(transcript, TRANSCRIPT_FOLD_OPTIONAL_METHODS);
		},
	);

	stockTest("tool component methods exist with verified arity", async () => {
		const { tool } = await liveSurface();
		expectRequiredSurface(tool, TOOL_METHODS);
		expectRequiredSurface(tool, TOOL_PATCH_METHODS);
	});

	stockTest("read-group methods exist with verified arity", async () => {
		const { readGroup } = await liveSurface();
		expectRequiredSurface(readGroup, READ_GROUP_METHODS);
		expectRequiredSurface(readGroup, READ_GROUP_PATCH_METHODS);
	});

	stockTest(
		"block fold methods are absent or have verified arity",
		async () => {
			const { tool } = await liveSurface();
			// The fold reads block methods through the prototype chain and falls
			// back to native when absent — hence the optional rule.
			expectOptionalSurface(tool, BLOCK_FOLD_METHODS);
		},
	);

	stockTest("TUI resetDisplay is absent or has verified arity", async () => {
		if (!binary) return;
		// The plugin captures the exact TUI instance the host hands to the
		// extension's setWidget (runtime-adapter.ts captureHostRoot) and
		// probes resetDisplay on it. Constructing the real TUI needs a live
		// terminal, so this asserts the pi-tui TUI class prototype from the
		// same host installation instead. The import is dynamic because the
		// package root is selected at runtime by OMP_STOCK_BIN (root
		// node_modules for 18.0.x, runtime/omp-<version>/node_modules
		// otherwise) — no static specifier can name both.
		const tuiRoot = resolve(dirname(binary), "..", "@oh-my-pi", "pi-tui");
		const tuiModule = (await import(
			pathToFileURL(join(tuiRoot, "src/tui.ts")).href
		)) as { TUI?: new () => object };
		expect(tuiModule.TUI, "pi-tui TUI class not found").not.toBeUndefined();
		if (!tuiModule.TUI) return;
		expectOptionalSurface(tuiModule.TUI.prototype, TUI_OPTIONAL_METHODS);
	});
});

/**
 * Live scraped-leaf canary.
 *
 * Six stock leaves are never patched through a method manifest: the plugin
 * recognizes them by structural fingerprint (`host-surface.ts` predicates)
 * and rebuilds their content by reading public children/accessors
 * (`render-scrape.ts`). Nothing above catches drift in that path — both
 * halves fail open by design, so a host that renames `getCommand`, drops
 * `files`, or rewords the todo header simply stops matching and the plugin
 * silently renders the stock card. The session looks intact; the compact
 * presentation is gone.
 *
 * These tests construct the real components and assert the fingerprint
 * matches AND the scrape recovers the values that were passed in. A host
 * bump that changes either half turns red here.
 *
 * Expected values come from a probe of the live 18.0.10 host, not from
 * reading the plugin: `injectRulesFromTtsrComponent` returns the rule name
 * without a body when the card is collapsed (the body sits behind
 * `ctrl+o`), and both execution scrapes report `running: true` until
 * `setComplete` lands.
 */
describe("live scraped-leaf canary", () => {
	stockTest("TTSR inject card: fingerprint and rule recovery", async () => {
		const host = await loadStockHost();
		await host.initTheme();
		const block = new host.TtsrNotificationComponent([
			{ name: "my-rule", body: "do it" },
		]);
		expect(isTtsrNotificationComponent(block)).toBe(true);
		expect(injectRulesFromTtsrComponent(block)).toEqual([{ name: "my-rule" }]);
	});

	stockTest("todo reminder: fingerprint and counts recovery", async () => {
		const host = await loadStockHost();
		await host.initTheme();
		const block = new host.TodoReminderComponent(
			[{ content: "task one", status: "pending" }],
			1,
			3,
		);
		expect(isTodoReminderComponent(block)).toBe(true);
		expect(todoReminderFromComponent(block)).toEqual({
			count: 1,
			attempt: 1,
			maxAttempts: 3,
			items: ["task one"],
		});
	});

	stockTest(
		"user bash execution: fingerprint and command recovery",
		async () => {
			const host = await loadStockHost();
			await host.initTheme();
			const block = new host.BashExecutionComponent("ls -la", EXECUTION_UI);
			expect(isBashExecutionComponent(block)).toBe(true);
			// Mutually exclusive with eval: the two share every method but the
			// getter, so a collision here would route both leaves to one scraper.
			expect(isEvalExecutionComponent(block)).toBe(false);
			expect(userBashExecutionFromComponent(block)).toEqual({
				kind: "bash",
				source: "ls -la",
				running: true,
			});
		},
	);

	stockTest("user eval execution: fingerprint and code recovery", async () => {
		const host = await loadStockHost();
		await host.initTheme();
		const block = new host.EvalExecutionComponent("print(1)", EXECUTION_UI);
		expect(isEvalExecutionComponent(block)).toBe(true);
		expect(isBashExecutionComponent(block)).toBe(false);
		expect(userEvalExecutionFromComponent(block)).toEqual({
			kind: "python",
			source: "print(1)",
			running: true,
		});
	});

	stockTest("skill card: fingerprint and details recovery", async () => {
		const host = await loadStockHost();
		await host.initTheme();
		// customType pins the host's SKILL_PROMPT_MESSAGE_TYPE literal
		// (session/messages.ts): both the predicate and the scrape reject
		// anything else, so a renamed constant must fail here.
		const block = new host.SkillMessageComponent({
			customType: "skill-prompt",
			details: { name: "pdf", path: "/s/pdf", lineCount: 12 },
		});
		expect(isSkillMessageComponent(block)).toBe(true);
		expect(skillMessageFromComponent(block)).toEqual({
			name: "pdf",
			path: "/s/pdf",
			lineCount: 12,
		});
	});

	stockTest("late diagnostics: fingerprint and files recovery", async () => {
		const host = await loadStockHost();
		await host.initTheme();
		const block = new host.LateDiagnosticsMessageComponent([
			{ summary: "a.ts: 1 error", messages: ["a.ts:1 boom"], errored: true },
		]);
		expect(isLateDiagnosticsMessageComponent(block)).toBe(true);
		expect(lateDiagnosticsFromComponent(block)).toEqual({
			errored: true,
			count: 1,
			summary: "a.ts: 1 error",
			firstMessage: "a.ts:1 boom",
		});
	});
});
