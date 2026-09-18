import { afterAll, expect } from "bun:test";
import { DEFAULT_SETTINGS } from "../../.omp-plugin/config";
import {
	addAnswer,
	beginRun,
	bootPlugin,
	cleanupGeneratedDirs,
	dispatch,
	finishRun,
	flushMicrotasks,
	saveSettingsViaDialog,
	shutdown,
	stockTest,
	visibleRows,
	type BootedPlugin,
} from "./integration-harness";
import type { Renderable, TranscriptInstance } from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

type AdvisorBoot = BootedPlugin & {
	transcript: TranscriptInstance;
	restored: Array<{
		card: Renderable;
		native: (width: number) => readonly string[];
	}>;
	setExpanded(expanded: boolean): void;
	paintCount(): number;
};

async function bootAdvisor(
	options: {
		compact?: boolean;
		enabled?: boolean;
		expanded?: boolean;
		mode?: "compact" | "live" | "clear";
		branch?: readonly unknown[];
		restoredDetails?: readonly unknown[];
	} = {},
): Promise<AdvisorBoot> {
	let transcript: TranscriptInstance | undefined;
	let expanded = options.expanded ?? false;
	let paints = 0;
	const restored: AdvisorBoot["restored"] = [];
	const booted = await bootPlugin(
		(root, host) => {
			Object.defineProperty(root, "requestRender", {
				value: () => {
					paints++;
				},
				configurable: true,
			});
			transcript = new host.TranscriptContainer();
			for (const details of options.restoredDetails ?? []) {
				const card = host.createAdvisorMessageCard(
					details,
					() => expanded,
					host.getTheme(),
				);
				restored.push({ card, native: card.render.bind(card) });
				transcript.addChild(card);
			}
			root.addChild(transcript);
		},
		"/tmp",
		options.branch ?? [],
		expanded,
		{
			...DEFAULT_SETTINGS,
			enabled: options.enabled ?? true,
			mode: options.mode ?? "compact",
			compactAdvisorNotes:
				options.compact ?? DEFAULT_SETTINGS.compactAdvisorNotes,
			stats: { ...DEFAULT_SETTINGS.stats, enabled: false },
		},
	);
	if (!transcript) throw new Error("advisor transcript missing");
	booted.context.ui.getToolsExpanded = () => expanded;
	return {
		...booted,
		transcript,
		restored,
		setExpanded(value) {
			expanded = value;
		},
		paintCount() {
			return paints;
		},
	};
}

async function addAdvisor(booted: AdvisorBoot, details: unknown) {
	const message = {
		role: "custom",
		customType: "advisor",
		display: true,
		content: "UNMODIFIED MODEL CONTENT",
		details,
	};
	const card = booted.host.createAdvisorMessageCard(
		details,
		() => booted.context.ui.getToolsExpanded(),
		booted.host.getTheme(),
	);
	const native = card.render.bind(card);
	await dispatch(booted, { type: "message_end", message });
	booted.transcript.addChild(card);
	return { card, native, message };
}

function advisorEntry(details: unknown, id = "advisor-entry") {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "2026-09-18T00:00:00Z",
		customType: "advisor",
		content: "UNMODIFIED MODEL CONTENT",
		details,
		display: true,
	};
}

stockTest(
	"advisor cards are native by default and while the plugin is disabled",
	async () => {
		for (const options of [{}, { compact: true, enabled: false }]) {
			const booted = await bootAdvisor(options);
			try {
				const paints = booted.paintCount();
				const { card, native } = await addAdvisor(booted, {
					notes: [
						{ severity: "nit", note: "Native first line\nNative second line" },
					],
				});
				expect(booted.paintCount()).toBe(paints);
				const widths: number[] = [];
				const opaque = {
					render(width: number) {
						widths.push(width);
						return ["unrelated card"];
					},
					invalidate() {},
				};
				booted.transcript.addChild(opaque);
				expect(widths).toEqual([]);
				expect(card.render(120)).toEqual(native(120));
				expect(visibleRows(booted.transcript).join("\n")).toContain(
					"Native second line",
				);
				expect(widths).not.toContain(8_192);
			} finally {
				await shutdown(booted);
			}
		}
	},
);

stockTest(
	"nit and concern notes compact in every mode without changing messages or being folded away",
	async () => {
		for (const mode of ["compact", "live", "clear"] as const) {
			const booted = await bootAdvisor({ compact: true, mode });
			try {
				await beginRun(booted);
				const details = Object.freeze({
					notes: Object.freeze([
						Object.freeze({
							severity: "nit",
							advisor: "default",
							note: "Keep the concise label\nAdditional explanation stays expandable.",
						}),
						Object.freeze({
							severity: "concern",
							advisor: "Luna",
							note: "Check the transaction boundary\nDo not lose this full context.",
						}),
					]),
				});
				const before = JSON.stringify(details);
				const { card, native, message } = await addAdvisor(booted, details);
				expect(visibleRows(card)).toEqual([
					"• advisor [nit] Keep the concise label",
					"• advisor [concern] [Luna] Check the transaction boundary",
				]);
				for (const line of visibleRows(card, 25))
					expect(line.length).toBeLessThanOrEqual(25);
				booted.setExpanded(true);
				expect(card.render(120)).toEqual(native(120));
				expect(visibleRows(card).join("\n")).toContain(
					"Do not lose this full context.",
				);
				booted.setExpanded(false);
				addAnswer(booted, "The assistant answer remains visible.");
				await finishRun(booted, "The assistant answer remains visible.");
				expect(visibleRows(booted.transcript).join("\n")).toContain(
					"• advisor [concern] [Luna] Check the transaction boundary",
				);
				expect(JSON.stringify(details)).toBe(before);
				expect(message.content).toBe("UNMODIFIED MODEL CONTENT");
			} finally {
				await shutdown(booted);
			}
		}
	},
);

stockTest(
	"omitted severity is a plain nit, alone or beside a concern",
	async () => {
		for (const mixed of [false, true]) {
			const booted = await bootAdvisor({ compact: true });
			try {
				const notes = [
					{ note: "Plain nit summary\nFull unbadged details stay available." },
					...(mixed
						? [
								{
									severity: "concern",
									note: "Concern summary\nConcern details.",
								},
							]
						: []),
				];
				const before = JSON.stringify(notes);
				const { card, native } = await addAdvisor(booted, { notes });
				expect(visibleRows(card)).toEqual([
					"• advisor [nit] Plain nit summary",
					...(mixed ? ["• advisor [concern] Concern summary"] : []),
				]);
				booted.setExpanded(true);
				expect(card.render(120)).toEqual(native(120));
				expect(visibleRows(card).join("\n")).toContain(
					"Full unbadged details stay available.",
				);
				expect(JSON.stringify(notes)).toBe(before);
			} finally {
				await shutdown(booted);
			}
		}
	},
);

stockTest(
	"blockers, unknown severities and malformed note metadata leave whole native cards",
	async () => {
		for (const unsafe of [
			{ severity: "blocker", note: "Do not deploy" },
			{ severity: "future-severity", note: "Unknown must stay visible" },
			{ severity: null, note: "Malformed null severity" },
			{ severity: 7, note: "Malformed severity" },
		]) {
			const booted = await bootAdvisor({ compact: true });
			try {
				const { card, native } = await addAdvisor(booted, {
					notes: [
						{ severity: "nit", note: "Safe first line\nKeep its body too" },
						unsafe,
					],
				});
				expect(card.render(120)).toEqual(native(120));
				expect(visibleRows(card).join("\n")).toContain("Keep its body too");
			} finally {
				await shutdown(booted);
			}
		}
	},
);

stockTest(
	"collapsed cards keep the first-three limit and validate hidden notes before compacting",
	async () => {
		const firstThree = [1, 2, 3].map((index) => ({
			severity: "concern",
			note: `Visible note ${index}\nFull note ${index}`,
		}));
		for (const severity of ["nit", "blocker", "unrecognized"]) {
			const booted = await bootAdvisor({ compact: true });
			try {
				const { card, native } = await addAdvisor(booted, {
					notes: [...firstThree, { severity, note: "Hidden fourth note" }],
				});
				if (severity === "nit") {
					expect(visibleRows(card)).toEqual([
						"• advisor [concern] Visible note 1",
						"• advisor [concern] Visible note 2",
						"• advisor [concern] Visible note 3",
						"  … +1 more note",
					]);
				} else expect(card.render(120)).toEqual(native(120));
				expect(visibleRows(card).join("\n")).not.toContain(
					"Hidden fourth note",
				);
				booted.setExpanded(true);
				expect(card.render(120)).toEqual(native(120));
				expect(visibleRows(card).join("\n")).toContain("Hidden fourth note");
			} finally {
				await shutdown(booted);
			}
		}
	},
);

stockTest(
	"unsafe hidden-note signature collisions invalidate an earlier safe match",
	async () => {
		const booted = await bootAdvisor({ compact: true });
		try {
			const visible = [1, 2, 3].map((index) => ({
				severity: "nit",
				note: `Note ${index}\nDetails ${index}`,
			}));
			const { card, native } = await addAdvisor(booted, {
				notes: [...visible, { severity: "nit", note: "Safe hidden note" }],
			});
			expect(visibleRows(card)[0]).toBe("• advisor [nit] Note 1");
			await dispatch(booted, {
				type: "message_end",
				message: {
					role: "custom",
					customType: "advisor",
					display: true,
					details: {
						notes: [
							...visible,
							{ severity: "unknown", note: "Unsafe hidden note" },
						],
					},
				},
			});
			expect(card.render(120)).toEqual(native(120));
		} finally {
			await shutdown(booted);
		}
	},
);

stockTest(
	"dialog setting changes repaint existing advisor cards immediately",
	async () => {
		const booted = await bootAdvisor();
		try {
			const { card, native } = await addAdvisor(booted, {
				notes: [
					{ severity: "nit", note: "Toggle this summary\nRecover this body" },
				],
			});
			for (const compact of [true, false, true]) {
				const paints = booted.paintCount();
				await saveSettingsViaDialog(booted, (dialog) => {
					// Native dialog navigation: enabled, mode, paths, Git, vibe, advisor.
					for (let index = 0; index < 5; index++) dialog.handleInput("j");
					dialog.handleInput(" ");
				});
				expect(booted.paintCount()).toBeGreaterThan(paints);
				if (compact)
					expect(visibleRows(card)).toEqual([
						"• advisor [nit] Toggle this summary",
					]);
				else expect(card.render(120)).toEqual(native(120));
			}
		} finally {
			await shutdown(booted);
		}
	},
);

stockTest(
	"restored and rebuilt cards match flat branch metadata and restore old instances",
	async () => {
		const details = {
			notes: [
				{
					severity: "concern",
					advisor: "Luna",
					note: "Restored summary\nRestored full details",
				},
			],
		};
		let branch: readonly unknown[] = [advisorEntry(details)];
		const booted = await bootAdvisor({
			compact: true,
			expanded: true,
			branch,
			restoredDetails: [details],
		});
		try {
			const original = booted.restored[0];
			if (!original) throw new Error("restored advisor missing");
			expect(original.card.render(120)).toEqual(original.native(120));
			booted.setExpanded(false);
			expect(visibleRows(original.card)).toEqual([
				"• advisor [concern] [Luna] Restored summary",
			]);
			booted.context.sessionManager.getBranch = () => branch;
			booted.transcript.clear();
			const rebuilt = booted.host.createAdvisorMessageCard(
				details,
				() => booted.context.ui.getToolsExpanded(),
				booted.host.getTheme(),
			);
			const rebuiltNative = rebuilt.render.bind(rebuilt);
			booted.transcript.addChild(rebuilt);
			await flushMicrotasks();
			expect(original.card.render(120)).toEqual(original.native(120));
			expect(visibleRows(rebuilt)).toEqual([
				"• advisor [concern] [Luna] Restored summary",
			]);
			branch = [];
			booted.transcript.clear();
			const unproven = booted.host.createAdvisorMessageCard(
				details,
				() => false,
				booted.host.getTheme(),
			);
			const unprovenNative = unproven.render.bind(unproven);
			booted.transcript.addChild(unproven);
			await flushMicrotasks();
			expect(rebuilt.render(120)).toEqual(rebuiltNative(120));
			expect(unproven.render(120)).toEqual(unprovenNative(120));
		} finally {
			await shutdown(booted);
		}
	},
);

stockTest(
	"unrelated opaque cards and complete-output collisions fail open without claiming event order",
	async () => {
		const booted = await bootAdvisor({ compact: true });
		try {
			const details = {
				notes: [
					{
						severity: "nit",
						note: "Check / tmp carefully\nPreserve the full explanation",
					},
				],
			};
			await dispatch(booted, {
				type: "message_end",
				message: {
					role: "custom",
					customType: "advisor",
					display: true,
					details,
				},
			});
			const unrelated = {
				render: () => ["Advisor [nit] unrelated content"],
				invalidate() {},
			};
			booted.transcript.addChild(unrelated);
			const card = booted.host.createAdvisorMessageCard(
				details,
				() => false,
				booted.host.getTheme(),
			);
			const native = card.render.bind(card);
			booted.transcript.addChild(card);
			expect(unrelated.render()).toEqual(["Advisor [nit] unrelated content"]);
			expect(visibleRows(card)).toEqual([
				"• advisor [nit] Check / tmp carefully",
			]);
			const mismatch = booted.host.createAdvisorMessageCard(
				{
					notes: [
						{
							severity: "nit",
							note: "Check /tmp carefully\nPreserve the full explanation",
						},
					],
				},
				() => false,
				booted.host.getTheme(),
			);
			const mismatchNative = mismatch.render.bind(mismatch);
			booted.transcript.addChild(mismatch);
			expect(mismatch.render(120)).toEqual(mismatchNative(120));
			const collision = { render: native, invalidate() {} };
			booted.transcript.addChild(collision);
			expect(card.render(120)).toEqual(native(120));
			expect(collision.render(120)).toEqual(native(120));
		} finally {
			await shutdown(booted);
		}
	},
);

stockTest(
	"native wrapping, tabs and paragraphs match without erasing body whitespace",
	async () => {
		const booted = await bootAdvisor({ compact: true });
		try {
			const summary = "Check / tmp before touching /tmp.";
			const { card, native } = await addAdvisor(booted, {
				notes: [
					{
						severity: "concern",
						advisor: "Luna",
						note: `${summary}\n${"Long\tparagraph with spaces and non-ASCII 漢字. ".repeat(12)}\n${"x".repeat(250)}`,
					},
				],
			});
			expect(visibleRows(card)).toEqual([
				`• advisor [concern] [Luna] ${summary}`,
			]);
			booted.setExpanded(true);
			expect(card.render(120)).toEqual(native(120));
		} finally {
			await shutdown(booted);
		}
	},
);

stockTest(
	"missing expansion capability stays native and disposal restores the stock renderer",
	async () => {
		const booted = await bootAdvisor({ compact: true });
		const { card, native } = await addAdvisor(booted, {
			notes: [{ severity: "concern", note: "Summary\nOriginal body" }],
		});
		expect(visibleRows(card)).toEqual(["• advisor [concern] Summary"]);
		const getExpanded = booted.context.ui.getToolsExpanded;
		const nativeOnly = booted.host.createAdvisorMessageCard(
			{
				notes: [
					{ severity: "nit", note: "Native with no accessor\nAll details" },
				],
			},
			() => false,
			booted.host.getTheme(),
		);
		const nativeOnlyRender = nativeOnly.render.bind(nativeOnly);
		await dispatch(booted, {
			type: "message_end",
			message: {
				role: "custom",
				customType: "advisor",
				display: true,
				details: {
					notes: [
						{ severity: "nit", note: "Native with no accessor\nAll details" },
					],
				},
			},
		});
		booted.transcript.addChild(nativeOnly);
		Object.defineProperty(booted.context.ui, "getToolsExpanded", {
			value: undefined,
			configurable: true,
			writable: true,
		});
		expect(nativeOnly.render(120)).toEqual(nativeOnlyRender(120));
		booted.context.ui.getToolsExpanded = getExpanded;
		await shutdown(booted);
		expect(card.render(120)).toEqual(native(120));
		expect(visibleRows(card).join("\n")).toContain("Original body");
	},
);
