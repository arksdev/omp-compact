/**
 * Opt-in compact presentation for non-blocking advisor notes.
 *
 * The stock card (`createAdvisorMessageCard`) is an opaque closure over its
 * `details`: it exposes no note metadata, and the host renders it outside the
 * registered message-renderer path. The plugin therefore matches the card's
 * own stripped native rows against the layout the stock renderer would
 * produce from the structured `details` it saw on the message stream or in the
 * restored branch — no event-order guessing, no session mutation.
 *
 * These contracts assert observable output only: rendered rows, restored
 * native renderers and untouched payloads.
 */
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
import type {
	AdvisorCardInstance,
	TranscriptInstance,
} from "./test-stock-host";

afterAll(cleanupGeneratedDirs);

interface AdvisorBoot extends BootedPlugin {
	transcript: TranscriptInstance;
	/** Cards constructed before the adapter installed, with their native render. */
	restored: Array<{
		card: AdvisorCardInstance;
		native: (width: number) => readonly string[];
	}>;
	/** Flip the host's tool-output expansion flag (the card reads it live). */
	setExpanded(expanded: boolean): void;
}

interface BootOptions {
	compact?: boolean;
	enabled?: boolean;
	expanded?: boolean;
	mode?: "compact" | "live" | "clear";
	/** Branch entries the adapter hydrates candidate metadata from. */
	branch?: readonly unknown[];
	/** Restored cards to place before the adapter installs. */
	restoredDetails?: readonly unknown[];
	/** Omit the live `getToolsExpanded` capability entirely. */
	withoutExpansionCapability?: boolean;
}

async function bootAdvisor(options: BootOptions = {}): Promise<AdvisorBoot> {
	let expanded = options.expanded ?? false;
	let transcript: TranscriptInstance | undefined;
	const restored: AdvisorBoot["restored"] = [];
	const booted = await bootPlugin(
		(root, host) => {
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
		`/tmp/omp-compact-advisor-${process.pid}`,
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
	if (options.withoutExpansionCapability) {
		Object.defineProperty(booted.context.ui, "getToolsExpanded", {
			value: undefined,
			configurable: true,
			writable: true,
		});
	} else {
		// The harness boots with a frozen snapshot; the card reads the host
		// accessor live, so tests toggle expansion through this closure.
		booted.context.ui.getToolsExpanded = () => expanded;
	}
	return {
		...booted,
		transcript,
		restored,
		setExpanded(value) {
			expanded = value;
		},
	};
}

/** The stock message a host delivers for one advisor card. */
function advisorMessage(details: unknown) {
	return {
		role: "custom",
		customType: "advisor",
		display: true,
		attribution: "agent",
		content: "UNMODIFIED MODEL CONTENT",
		details,
	};
}

/** Restored-branch entry shape (`custom_message` with `details`). */
function advisorEntry(details: unknown, id = "advisor-entry") {
	return {
		type: "custom_message",
		id,
		parentId: null,
		customType: "advisor",
		content: "UNMODIFIED MODEL CONTENT",
		display: true,
		details,
	};
}

/**
 * Deliver the structured message and place the stock card the host builds from
 * it, exactly like `modes/utils/ui-helpers.ts` does for the transcript.
 */
async function addAdvisorCard(booted: AdvisorBoot, details: unknown) {
	const message = advisorMessage(details);
	await dispatch(booted, { type: "message_end", message });
	const card = booted.host.createAdvisorMessageCard(
		details,
		() => booted.context.ui.getToolsExpanded?.() === true,
		booted.host.getTheme(),
	);
	const native = card.render.bind(card);
	booted.transcript.addChild(card);
	return { card, native, message };
}

/** Focus `Advisor nit/concern` by rendered label, then toggle it. */
function toggleAdvisorRow(dialog: BootedPlugin["dialogs"][number]): void {
	for (let i = 0; i < 32; i++) {
		const focused = dialog
			.render(100)
			.map((line) => Bun.stripANSI(line))
			.some((line) => /›.*Advisor nit\/concern/.test(line));
		if (focused) break;
		dialog.handleInput("j");
	}
	dialog.handleInput(" ");
}

const PLAIN_NOTES = [
	{
		severity: "nit",
		advisor: "default",
		note: "Keep the concise label\nAdditional explanation stays expandable.",
	},
	{
		severity: "concern",
		advisor: "Luna",
		note: "Check the transaction boundary\nDo not lose this full context.",
	},
];

stockTest(
	"the option is off by default: cards stay byte-identical and nothing is probed wide",
	async () => {
		for (const options of [{}, { compact: true, enabled: false }]) {
			const booted = await bootAdvisor(options);
			try {
				const { card, native } = await addAdvisorCard(booted, {
					notes: PLAIN_NOTES,
				});
				const widths: number[] = [];
				const unrelated = {
					render(width: number) {
						widths.push(width);
						return ["unrelated card"];
					},
					invalidate() {},
				};
				booted.transcript.addChild(unrelated);
				expect(widths).toEqual([]);
				expect(card.render(120)).toEqual(native(120));
				expect(visibleRows(card).join("\n")).toContain(
					"Additional explanation stays expandable.",
				);
				expect(unrelated.render(40)).toEqual(["unrelated card"]);
				expect(widths).toEqual([40]);
			} finally {
				await shutdown(booted);
			}
		}
	},
);

stockTest(
	"nit and concern notes compact in every mode without changing the message or details",
	async () => {
		for (const mode of ["compact", "live", "clear"] as const) {
			const booted = await bootAdvisor({ compact: true, mode });
			try {
				await beginRun(booted);
				const details = {
					notes: [
						{
							severity: "nit",
							advisor: "default",
							note: "Keep the concise label\nAdditional explanation stays expandable.",
						},
						{
							severity: "concern",
							advisor: "Luna",
							note: "Check the transaction boundary\nDo not lose this full context.",
						},
					],
				};
				const before = JSON.stringify(details);
				const { card, native, message } = await addAdvisorCard(booted, details);
				expect(visibleRows(card)).toEqual([
					"• advisor [nit] Keep the concise label",
					"• advisor [concern] [Luna] Check the transaction boundary",
				]);
				for (const line of visibleRows(card, 25))
					expect(line.length).toBeLessThanOrEqual(25);
				addAnswer(booted, "The assistant answer remains visible.");
				await finishRun(booted, "The assistant answer remains visible.");
				expect(visibleRows(booted.transcript).join("\n")).toContain(
					"• advisor [concern] [Luna] Check the transaction boundary",
				);
				expect(JSON.stringify(details)).toBe(before);
				expect(message.content).toBe("UNMODIFIED MODEL CONTENT");
				booted.setExpanded(true);
				expect(card.render(120)).toEqual(native(120));
				expect(visibleRows(card).join("\n")).toContain(
					"Do not lose this full context.",
				);
			} finally {
				await shutdown(booted);
			}
		}
	},
);

stockTest("an omitted severity is the host's plain nit", async () => {
	const booted = await bootAdvisor({ compact: true });
	try {
		const notes = [
			{ note: "Plain nit summary\nFull unbadged details stay available." },
			{ severity: "concern", note: "Concern summary\nConcern details." },
		];
		const before = JSON.stringify(notes);
		const { card, native } = await addAdvisorCard(booted, { notes });
		expect(visibleRows(card)).toEqual([
			"• advisor [nit] Plain nit summary",
			"• advisor [concern] Concern summary",
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
});

stockTest(
	"blockers, unknown severities and unsafe note text keep the whole card native",
	async () => {
		const unsafe = [
			{ severity: "blocker", note: "Do not deploy" },
			{ severity: "future-severity", note: "Unknown must stay visible" },
			{ severity: null, note: "Malformed null severity" },
			{ severity: 7, note: "Malformed severity" },
			{ note: "Control \u001b[31mescape must stay native" },
			{ note: "   " },
		];
		for (const entry of unsafe) {
			const booted = await bootAdvisor({ compact: true });
			try {
				const { card, native } = await addAdvisorCard(booted, {
					notes: [
						{ severity: "nit", note: "Safe first line\nKeep its body too" },
						entry,
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

stockTest("details without a usable notes array stay native", async () => {
	// Shapes the stock card itself can render but the plugin must not claim:
	// no notes, an empty list, and metadata past the per-card note budget.
	for (const details of [
		undefined,
		{},
		{ notes: [] },
		{ notes: Array.from({ length: 65 }, (_, i) => ({ note: `note ${i}` })) },
	]) {
		const booted = await bootAdvisor({ compact: true });
		try {
			const { card, native } = await addAdvisorCard(booted, details);
			expect(card.render(120)).toEqual(native(120));
		} finally {
			await shutdown(booted);
		}
	}
});

stockTest(
	"collapsed cards keep the first-three limit, the hidden count and validate hidden notes",
	async () => {
		const firstThree = [1, 2, 3].map((index) => ({
			severity: "concern",
			note: `Visible note ${index}\nFull note ${index}`,
		}));
		for (const severity of ["nit", "blocker", "unrecognized"]) {
			const booted = await bootAdvisor({ compact: true });
			try {
				const { card, native } = await addAdvisorCard(booted, {
					notes: [...firstThree, { severity, note: "Hidden fourth note" }],
				});
				if (severity === "nit") {
					expect(visibleRows(card)).toEqual([
						"• advisor [concern] Visible note 1",
						"• advisor [concern] Visible note 2",
						"• advisor [concern] Visible note 3",
						"  … +1 more note",
					]);
				} else {
					expect(card.render(120)).toEqual(native(120));
					expect(visibleRows(card).join("\n")).toContain("Visible note 3");
				}
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
	"a later unsafe card invalidates an earlier safe match with the same collapsed rows",
	async () => {
		const booted = await bootAdvisor({ compact: true });
		try {
			const visible = [1, 2, 3].map((index) => ({
				severity: "nit",
				note: `Note ${index}\nDetails ${index}`,
			}));
			const { card, native } = await addAdvisorCard(booted, {
				notes: [...visible, { severity: "nit", note: "Safe hidden note" }],
			});
			expect(visibleRows(card)[0]).toBe("• advisor [nit] Note 1");
			await dispatch(booted, {
				type: "message_end",
				message: advisorMessage({
					notes: [
						...visible,
						{ severity: "unknown", note: "Unsafe hidden note" },
					],
				}),
			});
			expect(card.render(120)).toEqual(native(120));
		} finally {
			await shutdown(booted);
		}
	},
);

stockTest(
	"long notes compact at the stock break points instead of staying native",
	async () => {
		const notes = [
			{
				severity: "nit",
				advisor: "Luna",
				// One paragraph past the 106-column body cap, one short second
				// paragraph, plus a single over-wide word.
				note: `${"word ".repeat(25)}end-of-line-mark\nShort tail paragraph`,
			},
			{
				severity: "concern",
				// Intro shorter than the badge line, body that must wrap after
				// the badge is accounted for.
				note: `short start ${"x".repeat(200)}\n\nfinal paragraph`,
			},
		];
		const booted = await bootAdvisor({ compact: true });
		try {
			const before = JSON.stringify(notes);
			const { card, native } = await addAdvisorCard(booted, { notes });
			// The card really renders wrapped rows, and the reconstruction
			// still lines up: compaction is proof, not a guess.
			expect(native(120).length).toBeGreaterThan(4);
			// The compact row is the note's first line, whole at a wide
			// terminal and truncated only by the terminal itself.
			expect(visibleRows(card, 260)).toEqual([
				`• advisor [nit] [Luna] ${"word ".repeat(25).trimEnd()} end-of-line-mark`,
				`• advisor [concern] short start ${"x".repeat(200)}`,
			]);
			for (const line of visibleRows(card, 40))
				expect(line.length).toBeLessThanOrEqual(40);
			expect(JSON.stringify(notes)).toBe(before);
			// Expansion still returns the untouched multi-row stock card.
			booted.setExpanded(true);
			expect(card.render(120)).toEqual(native(120));
			expect(visibleRows(card).join("\n")).toContain("end-of-line-mark");
			expect(visibleRows(card).join("\n")).toContain("Short tail paragraph");
			expect(visibleRows(card).join("\n")).toContain("final paragraph");
		} finally {
			await shutdown(booted);
		}
	},
);

stockTest(
	"a visible note the plugin cannot read keeps every card native",
	async () => {
		const visible = [1, 2, 3].map((index) => ({
			severity: "nit",
			note: `Note ${index}\nDetails ${index}`,
		}));
		// The safe card is proven first; then an unreadable fourth note (whose
		// entry never reaches the collapsed body) arrives with rows that would
		// otherwise be claimed by that proof.
		const booted = await bootAdvisor({ compact: true });
		try {
			const safe = {
				notes: [...visible, { severity: "nit", note: "Readable hidden note" }],
			};
			const { card, native } = await addAdvisorCard(booted, safe);
			expect(visibleRows(card)[0]).toBe("• advisor [nit] Note 1");
			// The malformed card paints the same collapsed rows as its stock
			// card does — the unreadable entry is hidden either way.
			const malformed = {
				notes: [...visible, { severity: "nit", note: 42 }],
			};
			await dispatch(booted, {
				type: "message_end",
				message: advisorMessage(malformed),
			});
			const malformedCard = booted.host.createAdvisorMessageCard(
				malformed,
				() => false,
				booted.host.getTheme(),
			);
			const malformedNative = malformedCard.render.bind(malformedCard);
			booted.transcript.addChild(malformedCard);
			expect(visibleRows(malformedCard).join("\n")).toContain("Note 3");
			expect(malformedCard.render(120)).toEqual(malformedNative(120));
			expect(card.render(120)).toEqual(native(120));
		} finally {
			await shutdown(booted);
		}
	},
);

stockTest("cards with no notes at all stay ignorable", async () => {
	const booted = await bootAdvisor({ compact: true });
	try {
		const { card, native } = await addAdvisorCard(booted, {
			notes: [{ severity: "nit", note: "Notes still compact\nFull body" }],
		});
		// A sibling `Advisor 0 notes` card renders a header no candidate can
		// reproduce, so it neither compacts nor poisons the generation.
		const empty = booted.host.createAdvisorMessageCard(
			{ notes: [] },
			() => false,
			booted.host.getTheme(),
		);
		const emptyNative = empty.render.bind(empty);
		booted.transcript.addChild(empty);
		expect(empty.render(120)).toEqual(emptyNative(120));
		expect(visibleRows(card)).toEqual(["• advisor [nit] Notes still compact"]);
		expect(card.render(120)).not.toEqual(native(120));
	} finally {
		await shutdown(booted);
	}
});

stockTest("tabs and repeated spaces match the stock rendering", async () => {
	const booted = await bootAdvisor({ compact: true });
	try {
		const { card, native } = await addAdvisorCard(booted, {
			notes: [{ severity: "concern", note: "Tabs\there\tand  double  spaces" }],
		});
		expect(visibleRows(card)).toEqual([
			"• advisor [concern] Tabs here and double spaces",
		]);
		booted.setExpanded(true);
		expect(card.render(120)).toEqual(native(120));
	} finally {
		await shutdown(booted);
	}
});

stockTest(
	"the settings dialog toggles compaction on the live card",
	async () => {
		const booted = await bootAdvisor();
		try {
			const { card, native } = await addAdvisorCard(booted, {
				notes: [
					{ severity: "nit", note: "Toggle this summary\nRecover this body" },
				],
			});
			expect(card.render(120)).toEqual(native(120));
			for (const compact of [true, false, true]) {
				await saveSettingsViaDialog(booted, toggleAdvisorRow);
				if (compact) {
					expect(visibleRows(card)).toEqual([
						"• advisor [nit] Toggle this summary",
					]);
				} else {
					expect(card.render(120)).toEqual(native(120));
					expect(visibleRows(card).join("\n")).toContain("Recover this body");
				}
			}
		} finally {
			await shutdown(booted);
		}
	},
);

stockTest(
	"restored cards match branch metadata, and disproven ones go back to native",
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
			// Expanded at boot: the stock card renders, because compaction
			// never hides the expanded body.
			expect(original.card.render(120)).toEqual(original.native(120));
			booted.setExpanded(false);
			expect(visibleRows(original.card)).toEqual([
				"• advisor [concern] [Luna] Restored summary",
			]);
			booted.context.sessionManager.getBranch = () => branch;
			booted.transcript.clear();
			const rebuilt = booted.host.createAdvisorMessageCard(
				details,
				() => booted.context.ui.getToolsExpanded?.() === true,
				booted.host.getTheme(),
			);
			const rebuiltNative = rebuilt.render.bind(rebuilt);
			booted.transcript.addChild(rebuilt);
			await flushMicrotasks();
			// The rebuild detached the old wrapper; the retired instance is native.
			expect(original.card.render(120)).toEqual(original.native(120));
			expect(visibleRows(rebuilt)).toEqual([
				"• advisor [concern] [Luna] Restored summary",
			]);
			// Without branch evidence the same card is unproven and stays native.
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
	"shutdown restores the stock renderer on every patched card",
	async () => {
		const booted = await bootAdvisor({ compact: true });
		const { card, native } = await addAdvisorCard(booted, {
			notes: [{ severity: "concern", note: "Summary\nOriginal body" }],
		});
		expect(visibleRows(card)).toEqual(["• advisor [concern] Summary"]);
		await shutdown(booted);
		expect(card.render(120)).toEqual(native(120));
		expect(visibleRows(card).join("\n")).toContain("Original body");
	},
);

stockTest("unknown shapes and different content fail open", async () => {
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
			message: advisorMessage(details),
		});
		// A structurally similar card with unrelated rows is never claimed.
		const unrelated = {
			render: (_width: number) => ["Advisor [nit] unrelated content"],
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
		expect(unrelated.render(120)).toEqual(["Advisor [nit] unrelated content"]);
		expect(visibleRows(card)).toEqual([
			"• advisor [nit] Check / tmp carefully",
		]);
		// Rows that differ from every candidate stay native.
		const mismatch = booted.host.createAdvisorMessageCard(
			{ notes: [{ severity: "nit", note: "Check /tmp carefully\nKeep it" }] },
			() => false,
			booted.host.getTheme(),
		);
		const mismatchNative = mismatch.render.bind(mismatch);
		booted.transcript.addChild(mismatch);
		expect(mismatch.render(120)).toEqual(mismatchNative(120));
		expect(visibleRows(mismatch).join("\n")).toContain("Check /tmp carefully");
		// The proven card is unaffected by the neighbours.
		expect(visibleRows(card)).toEqual([
			"• advisor [nit] Check / tmp carefully",
		]);
		expect(card.render(120)).not.toEqual(native(120));
	} finally {
		await shutdown(booted);
	}
});

stockTest(
	"without the live expansion capability every advisor card stays native",
	async () => {
		const booted = await bootAdvisor({
			compact: true,
			withoutExpansionCapability: true,
		});
		try {
			const { card, native } = await addAdvisorCard(booted, {
				notes: [{ severity: "nit", note: "Capability gated\nFull body" }],
			});
			expect(card.render(120)).toEqual(native(120));
			expect(visibleRows(card).join("\n")).toContain("Full body");
		} finally {
			await shutdown(booted);
		}
	},
);
