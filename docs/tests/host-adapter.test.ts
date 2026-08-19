import { describe, expect, test } from "bun:test";

import {
	HostAdapter1731,
	insertTranscriptChildAt,
	isBashExecutionComponent,
	isEvalExecutionComponent,
	isLateDiagnosticsMessageComponent,
	isReadGroupComponent,
	isSkillMessageComponent,
	isTodoReminderComponent,
	isToolComponent,
	isTranscriptHost,
	isTtsrNotificationComponent,
	leafCapabilities,
	removeEntryToolCallId,
	renameEntryIds,
	setExpandedValue,
	transcriptCapabilities,
	tuiCapabilities,
	updateArgsPayload,
	updateArgsToolCallId,
	updateResultIsPartial,
	updateResultPayload,
	updateResultToolCallId,
} from "../../.omp-plugin/host-adapter";
import type {
	RenderableBlock,
	TranscriptHost,
} from "../../.omp-plugin/transcript-fold";
import { loadStockHost, stockHostVersion } from "./test-stock-host";

const binary = process.env.OMP_STOCK_BIN;
const stockTest = binary ? test : test.skip;

class FakeTranscript implements TranscriptHost {
	readonly children: unknown[] = [];

	addChild(child: unknown): void {
		this.children.push(child);
	}

	clear(): void {
		this.children.length = 0;
	}

	render(): readonly string[] {
		return [];
	}

	renderViewportTail(): readonly string[] {
		return [];
	}

	isBlockUncommitted(): boolean {
		return false;
	}

	isBlockInLiveRegion(): boolean {
		return false;
	}
}

class ToolActivityProbe {
	visible = true;

	setToolActivityVisible(visible: boolean): void {
		this.visible = visible;
	}

	render(): readonly string[] {
		return this.visible ? ["activity"] : [];
	}
}

class ToolComponent implements RenderableBlock {
	readonly calls: string[] = [];

	render(): readonly string[] {
		return [];
	}

	updateArgs(args: unknown, id: string): void {
		this.calls.push(`updateArgs:${String(id)}:${String(args)}`);
	}

	updateResult(): void {
		this.calls.push("updateResult");
	}

	setArgsComplete(): void {
		this.calls.push("setArgsComplete");
	}

	setExpanded(expanded: boolean): void {
		this.calls.push(`setExpanded:${String(expanded)}`);
	}

	seal(): void {}

	setToolActivityVisible(): void {}
}

class ReadGroup implements RenderableBlock {
	render(): readonly string[] {
		return [];
	}

	updateArgs(): void {}

	updateResult(): void {}

	setExpanded(): void {}

	renameEntry(_oldId: string, _newId: string): void {}

	removeEntry(): void {}
}

function container(children: unknown[] = []): Record<string, unknown> {
	return {
		children,
		addChild: (child: unknown) => (children as unknown[]).push(child),
	};
}

describe("host shape guards", () => {
	test("isTranscriptHost accepts the full critical shape and rejects partial shapes", () => {
		expect(isTranscriptHost(new FakeTranscript())).toBe(true);
		expect(isTranscriptHost(null)).toBe(false);
		expect(isTranscriptHost({ children: [], addChild() {} })).toBe(false);
		expect(
			isTranscriptHost({
				children: [],
				addChild() {},
				render() {},
				renderViewportTail() {},
				isBlockUncommitted() {},
			}),
		).toBe(false);
		expect(
			isTranscriptHost({
				children: [],
				addChild() {},
				render() {},
				renderViewportTail() {},
				isBlockUncommitted() {},
				isBlockInLiveRegion() {},
			}),
		).toBe(true);
	});

	test("isToolComponent and isReadGroupComponent classify full leaf shapes only", () => {
		const tool = new ToolComponent();
		expect(isToolComponent(tool)).toBe(true);
		expect(isReadGroupComponent(tool)).toBe(false);
		expect(isToolComponent(new ReadGroup())).toBe(false);
		expect(isReadGroupComponent(new ReadGroup())).toBe(true);
		expect(isToolComponent({})).toBe(false);
		expect(isReadGroupComponent(null)).toBe(false);
		// a shape missing one required method is not a tool component
		const partialTool = {
			render() {},
			updateArgs() {},
			updateResult() {},
			setArgsComplete() {},
			setExpanded() {},
			seal() {},
		};
		expect(isToolComponent(partialTool)).toBe(false);
	});

	test("boolean predicates match capability records without allocating them", () => {
		// Oracle: the record builders remain the diagnostic source of truth.
		// Predicates must accept/reject the same objects so a host surface
		// never silently degrades to native because the fast path drifted.
		const transcriptViaRecord = (value: unknown): boolean => {
			if (!value || typeof value !== "object") return false;
			const c = transcriptCapabilities(value);
			return (
				c.children &&
				c.addChild &&
				c.render &&
				c.renderViewportTail &&
				c.isBlockUncommitted &&
				c.isBlockInLiveRegion
			);
		};
		const toolViaRecord = (value: unknown): boolean => {
			if (!value || typeof value !== "object") return false;
			const c = leafCapabilities(value);
			return c.render && c.kind === "tool";
		};
		const readGroupViaRecord = (value: unknown): boolean => {
			if (!value || typeof value !== "object") return false;
			const c = leafCapabilities(value);
			return c.render && c.kind === "readGroup";
		};

		const fullTranscript = {
			children: [],
			addChild() {},
			render() {},
			renderViewportTail() {},
			isBlockUncommitted() {},
			isBlockInLiveRegion() {},
			clear() {},
		};
		const partialTranscript = {
			children: [],
			addChild() {},
			render() {},
			renderViewportTail() {},
			isBlockUncommitted() {},
		};
		const nonArrayChildren = {
			children: {},
			addChild() {},
			render() {},
			renderViewportTail() {},
			isBlockUncommitted() {},
			isBlockInLiveRegion() {},
		};
		const tool = new ToolComponent();
		const readGroup = new ReadGroup();
		// Full tool surface plus read-group discriminators: record form ranks
		// readGroup over tool, so the predicate must reject as a tool too.
		const toolPlusReadGroup = {
			render() {},
			updateArgs() {},
			updateResult() {},
			setArgsComplete() {},
			setExpanded() {},
			seal() {},
			setToolActivityVisible() {},
			removeEntry() {},
			renameEntry() {},
		};
		const missingRenderTool = {
			updateArgs() {},
			updateResult() {},
			setArgsComplete() {},
			setExpanded() {},
			seal() {},
			setToolActivityVisible() {},
		};
		const samples: unknown[] = [
			null,
			undefined,
			42,
			"x",
			{},
			[],
			fullTranscript,
			partialTranscript,
			nonArrayChildren,
			new FakeTranscript(),
			tool,
			readGroup,
			toolPlusReadGroup,
			missingRenderTool,
			{ render() {} },
		];

		for (const sample of samples) {
			expect(isTranscriptHost(sample)).toBe(transcriptViaRecord(sample));
			expect(isToolComponent(sample)).toBe(toolViaRecord(sample));
			expect(isReadGroupComponent(sample)).toBe(readGroupViaRecord(sample));
		}

		// Sanity: the interesting dual-surface case is read-group, not tool.
		expect(isReadGroupComponent(toolPlusReadGroup)).toBe(true);
		expect(isToolComponent(toolPlusReadGroup)).toBe(false);
	});

	test("isTtsrNotificationComponent matches TTSR surface and rejects tools/todos", () => {
		const ttsr = {
			render() {
				return [] as const;
			},
			addRules() {},
			setExpanded() {},
			setToolActivityVisible() {},
		};
		expect(isTtsrNotificationComponent(ttsr)).toBe(true);
		expect(isToolComponent(ttsr)).toBe(false);
		expect(isReadGroupComponent(ttsr)).toBe(false);

		// Todo reminder: activity control only, no addRules.
		expect(
			isTtsrNotificationComponent({
				render() {
					return [] as const;
				},
				setToolActivityVisible() {},
			}),
		).toBe(false);

		// Full tool leaf must never classify as TTSR.
		expect(isTtsrNotificationComponent(new ToolComponent())).toBe(false);
		expect(isTtsrNotificationComponent(null)).toBe(false);
		expect(isTtsrNotificationComponent({})).toBe(false);
	});

	test("isTodoReminderComponent matches activity-only surface and rejects TTSR/tools", () => {
		const reminder = {
			render() {
				return [] as const;
			},
			setToolActivityVisible() {},
		};
		expect(isTodoReminderComponent(reminder)).toBe(true);
		expect(isTtsrNotificationComponent(reminder)).toBe(false);
		expect(isToolComponent(reminder)).toBe(false);
		expect(isReadGroupComponent(reminder)).toBe(false);

		// TTSR has addRules + setExpanded — never a todo reminder.
		expect(
			isTodoReminderComponent({
				render() {
					return [] as const;
				},
				addRules() {},
				setExpanded() {},
				setToolActivityVisible() {},
			}),
		).toBe(false);

		// Late diagnostics-like: activity + expand, no addRules.
		expect(
			isTodoReminderComponent({
				render() {
					return [] as const;
				},
				setExpanded() {},
				setToolActivityVisible() {},
			}),
		).toBe(false);

		// Full tool / read-group leaves must never classify as reminders.
		expect(isTodoReminderComponent(new ToolComponent())).toBe(false);
		expect(isTodoReminderComponent(new ReadGroup())).toBe(false);
		expect(isTodoReminderComponent(null)).toBe(false);
		expect(isTodoReminderComponent({})).toBe(false);
		expect(
			isTodoReminderComponent({
				render() {
					return [] as const;
				},
			}),
		).toBe(false);

		// StrippedToolCallsPlaceholder (OMP 17.3.4) also exposes only
		// render + setToolActivityVisible. Surface matching alone collides;
		// containment is install-time extraction in #patchTodoReminder plus
		// render-time fail-open — not a stricter method fingerprint.
		expect(
			isTodoReminderComponent({
				render() {
					return ["1 tool call elided — no result on this branch"] as const;
				},
				setToolActivityVisible() {},
			}),
		).toBe(true);
	});

	test("isBashExecutionComponent and isEvalExecutionComponent are mutually exclusive", () => {
		const bash = {
			render() {
				return [] as const;
			},
			appendOutput() {},
			setComplete() {},
			isTranscriptBlockFinalized() {
				return true;
			},
			getOutput() {
				return "";
			},
			setExpanded() {},
			getCommand() {
				return "ls";
			},
		};
		const evalExec = {
			render() {
				return [] as const;
			},
			appendOutput() {},
			setComplete() {},
			isTranscriptBlockFinalized() {
				return true;
			},
			getOutput() {
				return "";
			},
			setExpanded() {},
			getCode() {
				return "print(1)";
			},
		};
		expect(isBashExecutionComponent(bash)).toBe(true);
		expect(isEvalExecutionComponent(bash)).toBe(false);
		expect(isEvalExecutionComponent(evalExec)).toBe(true);
		expect(isBashExecutionComponent(evalExec)).toBe(false);
		// Both accessors together is not a stock surface.
		expect(
			isBashExecutionComponent({
				...bash,
				getCode() {
					return "x";
				},
			}),
		).toBe(false);
		expect(
			isEvalExecutionComponent({
				...evalExec,
				getCommand() {
					return "ls";
				},
			}),
		).toBe(false);

		// Tool / TTSR / todo / read-group leaves never classify as user executions.
		expect(isBashExecutionComponent(new ToolComponent())).toBe(false);
		expect(isEvalExecutionComponent(new ToolComponent())).toBe(false);
		expect(isBashExecutionComponent(new ReadGroup())).toBe(false);
		expect(isEvalExecutionComponent(new ReadGroup())).toBe(false);
		expect(
			isBashExecutionComponent({
				render() {
					return [] as const;
				},
				addRules() {},
				setExpanded() {},
				setToolActivityVisible() {},
			}),
		).toBe(false);
		expect(
			isEvalExecutionComponent({
				render() {
					return [] as const;
				},
				setToolActivityVisible() {},
			}),
		).toBe(false);
		expect(isBashExecutionComponent(null)).toBe(false);
		expect(isEvalExecutionComponent({})).toBe(false);
		// Missing shared execution methods fails closed.
		expect(
			isBashExecutionComponent({
				render() {
					return [] as const;
				},
				getCommand() {
					return "ls";
				},
			}),
		).toBe(false);
	});

	test("isSkillMessageComponent matches skill-prompt message and rejects collisions", () => {
		const skill = {
			render() {
				return [] as const;
			},
			setExpanded() {},
			message: {
				role: "custom",
				customType: "skill-prompt",
				content: "body",
				display: true,
				details: { name: "figma-use", path: "/x", lineCount: 1 },
			},
		};
		expect(isSkillMessageComponent(skill)).toBe(true);
		expect(isLateDiagnosticsMessageComponent(skill)).toBe(false);
		expect(isTodoReminderComponent(skill)).toBe(false);
		expect(isToolComponent(skill)).toBe(false);

		// Generic custom fallthrough — arbitrary customType must never match.
		expect(
			isSkillMessageComponent({
				render() {
					return [] as const;
				},
				setExpanded() {},
				message: { customType: "my-extension-card", content: "x" },
			}),
		).toBe(false);
		// Handoff customType.
		expect(
			isSkillMessageComponent({
				render() {
					return [] as const;
				},
				setExpanded() {},
				message: { customType: "handoff", content: "x" },
			}),
		).toBe(false);
		// Plugin's own omp-compact-* cards.
		expect(
			isSkillMessageComponent({
				render() {
					return [] as const;
				},
				setExpanded() {},
				message: { customType: "omp-compact-stats", content: "x" },
			}),
		).toBe(false);
		// Method surface without message.
		expect(
			isSkillMessageComponent({
				render() {
					return [] as const;
				},
				setExpanded() {},
			}),
		).toBe(false);
		// Late diagnostics activity surface.
		expect(
			isSkillMessageComponent({
				render() {
					return [] as const;
				},
				setExpanded() {},
				setToolActivityVisible() {},
				files: [],
				message: { customType: "skill-prompt" },
			}),
		).toBe(false);
		expect(isSkillMessageComponent(new ToolComponent())).toBe(false);
		expect(isSkillMessageComponent(null)).toBe(false);
		expect(isSkillMessageComponent({})).toBe(false);
	});

	test("isLateDiagnosticsMessageComponent matches files+activity and rejects collisions", () => {
		const late = {
			render() {
				return [] as const;
			},
			setExpanded() {},
			setToolActivityVisible() {},
			files: [{ messages: ["a.ts:1:1: error: x"] }],
		};
		expect(isLateDiagnosticsMessageComponent(late)).toBe(true);
		expect(isSkillMessageComponent(late)).toBe(false);
		expect(isTodoReminderComponent(late)).toBe(false);
		expect(isTtsrNotificationComponent(late)).toBe(false);
		expect(isToolComponent(late)).toBe(false);

		// Empty files array still matches fingerprint; install probe refuses.
		expect(
			isLateDiagnosticsMessageComponent({
				render() {
					return [] as const;
				},
				setExpanded() {},
				setToolActivityVisible() {},
				files: [],
			}),
		).toBe(true);

		// ToolActivityContainer-like: expand+activity+children, no files.
		expect(
			isLateDiagnosticsMessageComponent({
				render() {
					return [] as const;
				},
				setExpanded() {},
				setToolActivityVisible() {},
				children: [{}],
			}),
		).toBe(false);

		// Todo activity-only (no setExpanded, no files).
		expect(
			isLateDiagnosticsMessageComponent({
				render() {
					return [] as const;
				},
				setToolActivityVisible() {},
			}),
		).toBe(false);

		// TTSR has addRules.
		expect(
			isLateDiagnosticsMessageComponent({
				render() {
					return [] as const;
				},
				addRules() {},
				setExpanded() {},
				setToolActivityVisible() {},
				files: [],
			}),
		).toBe(false);

		// Full tool leaf.
		expect(isLateDiagnosticsMessageComponent(new ToolComponent())).toBe(false);
		expect(isLateDiagnosticsMessageComponent(null)).toBe(false);
		expect(isLateDiagnosticsMessageComponent({})).toBe(false);
	});
});

describe("stats carrier placement", () => {
	test("inserts only at a valid mutable transcript position", () => {
		const transcript = new FakeTranscript();
		const first = { id: "first" };
		const second = { id: "second" };
		const host = new HostAdapter1731(undefined);
		expect(host.insertTranscriptChildAt(transcript, 0, first)).toBe(true);
		expect(insertTranscriptChildAt(transcript, 1, second)).toBe(true);
		expect(insertTranscriptChildAt({ children: [] }, 0, {})).toBe(false);
		expect(transcript.children).toEqual([first, second]);
		expect(insertTranscriptChildAt(transcript, -1, {})).toBe(false);
		expect(insertTranscriptChildAt(transcript, 3, {})).toBe(false);
		Object.freeze(transcript.children);
		expect(insertTranscriptChildAt(transcript, 1, {})).toBe(false);
		expect(transcript.children).toEqual([first, second]);
	});

	test("detached anchor is re-checked at splice time and never invents a position", () => {
		const transcript = new FakeTranscript();
		const early = { id: "early" };
		const anchor = { id: "answer" };
		const late = { id: "late" };
		const stats = { id: "stats" };
		transcript.children.push(early, anchor, late);

		// Index computed while the anchor is still present (insert-before).
		const index = transcript.children.indexOf(anchor);
		expect(index).toBe(1);

		// Anchor leaves the transcript before the splice runs.
		transcript.children.splice(index, 1);
		expect(transcript.children).toEqual([early, late]);

		expect(() =>
			insertTranscriptChildAt(transcript, index, stats, { before: anchor }),
		).not.toThrow();
		expect(
			insertTranscriptChildAt(transcript, index, stats, { before: anchor }),
		).toBe(false);
		// Stale numeric index must not land the row between unrelated children.
		expect(transcript.children).toEqual([early, late]);
		expect(transcript.children).not.toContain(stats);
	});

	test("present before-anchor is re-resolved immediately before splice", () => {
		const transcript = new FakeTranscript();
		const first = { id: "first" };
		const anchor = { id: "answer" };
		const stats = { id: "stats" };
		transcript.children.push(first, anchor);
		// Stale index on purpose — identity wins over the numeric hint.
		expect(
			insertTranscriptChildAt(transcript, 0, stats, { before: anchor }),
		).toBe(true);
		expect(transcript.children).toEqual([first, stats, anchor]);
	});

	test("present after-anchor inserts immediately after the re-resolved identity", () => {
		const transcript = new FakeTranscript();
		const block = { id: "block" };
		const answer = { id: "answer" };
		const stats = { id: "stats" };
		transcript.children.push(block, answer);
		expect(
			insertTranscriptChildAt(transcript, 99, stats, { after: block }),
		).toBe(true);
		expect(transcript.children).toEqual([block, stats, answer]);

		transcript.children.splice(0, 1); // detach block
		expect(
			insertTranscriptChildAt(transcript, 0, { id: "x" }, { after: block }),
		).toBe(false);
		expect(transcript.children).toEqual([stats, answer]);
	});
});

describe("capability fingerprints", () => {
	test("transcriptCapabilities probes every critical method and the optional clear", () => {
		expect(transcriptCapabilities(new FakeTranscript())).toEqual({
			children: true,
			addChild: true,
			render: true,
			renderViewportTail: true,
			isBlockUncommitted: true,
			isBlockInLiveRegion: true,
			clear: true,
		});
		expect(transcriptCapabilities(null).children).toBe(false);
		expect(transcriptCapabilities({ children: [] }).addChild).toBe(false);
	});

	test("tuiCapabilities probes the exact TUI resetDisplay", () => {
		expect(tuiCapabilities({ resetDisplay() {} })).toEqual({
			resetDisplay: true,
		});
		expect(tuiCapabilities({})).toEqual({ resetDisplay: false });
		expect(tuiCapabilities(null)).toEqual({ resetDisplay: false });
		const host = new HostAdapter1731({ resetDisplay() {} });
		expect(host.tuiCapabilities()).toEqual({ resetDisplay: true });
		expect(host.tuiCapabilities().resetDisplay).toBe(true);
	});

	test("leafCapabilities reports kind and per-method presence", () => {
		const tool = leafCapabilities(new ToolComponent());
		expect(tool.kind).toBe("tool");
		expect(tool.render).toBe(true);
		expect(tool.methods.updateArgs).toBe(true);
		expect(tool.methods.seal).toBe(true);
		expect(tool.methods.setToolActivityVisible).toBe(true);
		expect(tool.methods.removeEntry).toBe(false);
		expect(tool.methods.isDisplaceableBlock).toBe(false);

		const readGroup = leafCapabilities(new ReadGroup());
		expect(readGroup.kind).toBe("readGroup");
		expect(readGroup.methods.removeEntry).toBe(true);
		expect(readGroup.methods.seal).toBe(false);

		expect(leafCapabilities({}).kind).toBe("none");
		expect(leafCapabilities(null).kind).toBe("none");
		expect(leafCapabilities(undefined).render).toBe(false);
	});

	test("the host release pin targets OMP 17.3.8", () => {
		expect(HostAdapter1731.hostVersion).toBe("17.3.8");
	});
});

describe("OMP 17.3.8 argument positions", () => {
	test("updateArgs carries (payload, toolCallId)", () => {
		expect(updateArgsToolCallId(["payload", "id-1"])).toBe("id-1");
		expect(updateArgsToolCallId([42])).toBeUndefined();
		expect(updateArgsToolCallId([])).toBeUndefined();
		expect(updateArgsPayload(["payload"])).toBe("payload");
		expect(updateArgsPayload([])).toBeUndefined();
	});

	test("updateResult carries (result, isPartial, toolCallId)", () => {
		expect(updateResultToolCallId(["result", false, "id-2"])).toBe("id-2");
		expect(updateResultToolCallId(["result", false])).toBeUndefined();
		expect(updateResultPayload(["result", false])).toBe("result");
		expect(updateResultIsPartial(["result", true])).toBe(true);
		expect(updateResultIsPartial(["result", "yes"])).toBe(false);
	});

	test("renameEntry, removeEntry and setExpanded positions", () => {
		expect(renameEntryIds(["old", "new"])).toEqual({
			oldId: "old",
			newId: "new",
		});
		expect(renameEntryIds([1, "new"])).toEqual({
			oldId: undefined,
			newId: "new",
		});
		expect(renameEntryIds([])).toEqual({
			oldId: undefined,
			newId: undefined,
		});
		expect(removeEntryToolCallId(["id-3"])).toBe("id-3");
		expect(removeEntryToolCallId([])).toBeUndefined();
		expect(setExpandedValue([true])).toBe(true);
		expect(setExpandedValue([false])).toBe(false);
	});
});
describe("HostAdapter1731 discovery", () => {
	test("collectTranscriptCandidates finds nested transcripts", () => {
		const transcript = new FakeTranscript();
		const nested = container([transcript]);
		const root = container([nested]);
		expect(new HostAdapter1731(root).collectTranscriptCandidates()).toEqual([
			transcript,
		]);
	});

	test("collectTranscriptCandidates returns every candidate and tolerates cycles", () => {
		const first = new FakeTranscript();
		const second = new FakeTranscript();
		expect(
			new HostAdapter1731(
				container([first, second]),
			).collectTranscriptCandidates(),
		).toEqual([first, second]);

		const cyclic = container([]);
		const root = container([cyclic]);
		(cyclic.children as unknown[]).push(root);
		const transcript = new FakeTranscript();
		(root.children as unknown[]).push(transcript);
		expect(new HostAdapter1731(root).collectTranscriptCandidates()).toEqual([
			transcript,
		]);
	});

	test("collectTranscriptCandidates is bounded by depth", () => {
		const transcript = new FakeTranscript();
		// transcript at depth 11 is found
		let nested = container([transcript]);
		for (let index = 0; index < 10; index++) nested = container([nested]);
		expect(new HostAdapter1731(nested).collectTranscriptCandidates()).toEqual([
			transcript,
		]);
		// transcript at depth 12 is found
		const atBoundary = container([nested]);
		expect(
			new HostAdapter1731(atBoundary).collectTranscriptCandidates(),
		).toEqual([transcript]);
		// transcript at depth 13 is not found
		const deep = container([atBoundary]);
		expect(new HostAdapter1731(deep).collectTranscriptCandidates()).toEqual([]);
	});

	test("observeTree reports containers, stops at the first transcript, bounds depth", () => {
		const transcript = new FakeTranscript();
		const nested = container([transcript]);
		const root = container([nested]);
		const seenContainers: unknown[] = [];
		const seenTranscripts: unknown[] = [];
		const host = new HostAdapter1731(root);
		const found = host.observeTree(
			root,
			0,
			(value) => seenTranscripts.push(value),
			(value) => seenContainers.push(value),
		);
		expect(found).toBe(true);
		expect(seenTranscripts).toEqual([transcript]);
		expect(seenContainers).toEqual([root, nested]);

		// the walk stops after the first transcript and visits nothing else
		const first = new FakeTranscript();
		const second = new FakeTranscript();
		const seen: unknown[] = [];
		host.observeTree(
			container([first, second]),
			0,
			(value) => seen.push(value),
			() => {},
		);
		expect(seen).toEqual([first]);

		// containers without addChild are not reported
		const bare = { children: [] as unknown[] };
		const seenBare: unknown[] = [];
		host.observeTree(
			bare,
			0,
			() => {},
			(value) => seenBare.push(value),
		);
		expect(seenBare).toEqual([]);
		expect(
			host.observeTree(
				null,
				0,
				() => {},
				() => {},
			),
		).toBe(false);
	});
});

describe("HostAdapter1731 exact-instance patching", () => {
	test("patchAddChild wraps addChild and restores it", () => {
		const transcript = new FakeTranscript();
		const host = new HostAdapter1731(transcript);
		const added: unknown[] = [];
		const patch = host.patchAddChild(transcript, (child) => added.push(child));
		expect(Object.hasOwn(transcript, "addChild")).toBe(true);
		const child = { keep: true };
		transcript.addChild(child);
		expect(added).toEqual([child]);
		expect(transcript.children).toEqual([child]);
		patch.restore();
		expect(Object.hasOwn(transcript, "addChild")).toBe(false);
		expect(transcript.addChild).toBe(FakeTranscript.prototype.addChild);
	});

	test("patchAddChild rejects non-extensible transcripts and missing addChild", () => {
		const host = new HostAdapter1731({});
		expect(() =>
			host.patchAddChild(Object.freeze(new FakeTranscript()), () => {}),
		).toThrow("unpatchable transcript");
		const missing = {
			children: [] as unknown[],
			addChild: undefined,
			render() {},
			renderViewportTail() {},
			isBlockUncommitted() {},
			isBlockInLiveRegion() {},
		};
		expect(() =>
			host.patchAddChild(missing as unknown as TranscriptHost, () => {}),
		).toThrow("transcript addChild missing");
	});

	test("patchDiscoveryContainer wraps addChild and rejects unpatchable containers", () => {
		const target = container([]);
		const originalAddChild = target.addChild;
		const host = new HostAdapter1731(target);
		const added: unknown[] = [];
		const patch = host.patchDiscoveryContainer(target, (child) =>
			added.push(child),
		);
		const child = { keep: true };
		(target.addChild as (value: unknown) => void)(child);
		expect(added).toEqual([child]);
		expect(target.children).toEqual([child]);
		patch.restore();
		expect(target.addChild).toBe(originalAddChild);

		expect(() =>
			host.patchDiscoveryContainer(
				{ children: [], addChild: undefined },
				() => {},
			),
		).toThrow("unpatchable TUI container");
		expect(() =>
			host.patchDiscoveryContainer(Object.freeze(container()), () => {}),
		).toThrow("unpatchable TUI container");
	});

	test("patchToolComponent runs onBefore before the native method and restores", () => {
		const component = new ToolComponent();
		const host = new HostAdapter1731(component);
		const before: Array<[string, unknown[]]> = [];
		const patch = host.patchToolComponent(component, (name, args) =>
			before.push([name, args]),
		);
		component.updateArgs({ a: 1 }, "id-1");
		expect(component.calls).toEqual(["updateArgs:id-1:[object Object]"]);
		expect(before).toEqual([["updateArgs", [{ a: 1 }, "id-1"]]]);
		patch.restore();
		expect(Object.hasOwn(component, "updateArgs")).toBe(false);
		expect(component.updateArgs).toBe(ToolComponent.prototype.updateArgs);
	});

	test("patchToolComponent rejects missing methods and rolls back mid-install failures", () => {
		const host = new HostAdapter1731({});
		const partial = {
			render() {},
			updateArgs() {},
			updateResult() {},
			setArgsComplete() {},
		};
		expect(() =>
			host.patchToolComponent(partial as unknown as RenderableBlock, () => {}),
		).toThrow("tool component missing setExpanded");
		expect(() =>
			host.patchToolComponent(Object.freeze(new ToolComponent()), () => {}),
		).toThrow("unpatchable tool component");

		const component = new ToolComponent();
		const nativeUpdateArgs = component.updateArgs;
		Object.defineProperty(component, "updateResult", {
			value: component.updateResult,
			configurable: false,
			writable: true,
		});
		expect(() => host.patchToolComponent(component, () => {})).toThrow(
			TypeError,
		);
		expect(Object.hasOwn(component, "updateArgs")).toBe(false);
		expect(component.updateArgs).toBe(nativeUpdateArgs);
		expect(
			Object.getOwnPropertyDescriptor(component, "updateResult")?.configurable,
		).toBe(false);
	});

	test("patchReadGroup wraps methods and rejects incompatible groups", () => {
		const group = new ReadGroup();
		const host = new HostAdapter1731(group);
		const before: Array<[string, unknown[]]> = [];
		const patch = host.patchReadGroup(group, (name, args) =>
			before.push([name, args]),
		);
		group.renameEntry("old", "new");
		expect(before).toEqual([["renameEntry", ["old", "new"]]]);
		patch.restore();
		expect(Object.hasOwn(group, "renameEntry")).toBe(false);
		expect(group.renameEntry).toBe(ReadGroup.prototype.renameEntry);

		const partial = {
			render() {},
			updateArgs() {},
			updateResult() {},
			setExpanded() {},
			renameEntry() {},
		};
		expect(() =>
			host.patchReadGroup(partial as unknown as RenderableBlock, () => {}),
		).toThrow("read group missing removeEntry");
		expect(() =>
			host.patchReadGroup(Object.freeze(new ReadGroup()), () => {}),
		).toThrow("unpatchable read group");
	});

	test("patchClear runs the observer before the native clear exactly once and restores", () => {
		const transcript = new FakeTranscript();
		transcript.clear = () => {
			transcript.children.length = 0;
		};
		const nativeClear = transcript.clear;
		const host = new HostAdapter1731(transcript);
		let cleared = 0;
		const beforeLengths: number[] = [];
		const patch = host.patchClear(transcript, () => {
			cleared++;
			beforeLengths.push(transcript.children.length);
		});
		const child = { keep: true };
		transcript.addChild(child);
		transcript.clear();
		expect(beforeLengths).toEqual([1]);
		expect(transcript.children).toEqual([]);
		transcript.clear();
		expect(beforeLengths).toEqual([1, 0]);
		expect(cleared).toBe(2);
		patch.restore();
		expect(Object.hasOwn(transcript, "clear")).toBe(true);
		expect(transcript.clear).toBe(nativeClear);
	});

	test("patchClear rejects non-extensible transcripts and missing clear", () => {
		const host = new HostAdapter1731({});
		expect(() =>
			host.patchClear(Object.freeze(new FakeTranscript()), () => {}),
		).toThrow("unpatchable transcript");
		const missing = {
			children: [] as unknown[],
			addChild() {},
			render() {},
			renderViewportTail() {},
			isBlockUncommitted() {},
			isBlockInLiveRegion() {},
		};
		expect(() =>
			host.patchClear(missing as unknown as TranscriptHost, () => {}),
		).toThrow("transcript clear missing");
	});

	test("patchClear rolls back cleanly on a mid-install descriptor failure", () => {
		const transcript = new FakeTranscript();
		transcript.clear = () => {
			transcript.children.length = 0;
		};
		const nativeClear = transcript.clear;
		Object.defineProperty(transcript, "clear", {
			value: transcript.clear,
			configurable: false,
			writable: true,
		});
		const host = new HostAdapter1731(transcript);
		expect(() => host.patchClear(transcript, () => {})).toThrow(TypeError);
		expect(Object.getOwnPropertyDescriptor(transcript, "clear")?.value).toBe(
			nativeClear,
		);
		expect(
			Object.getOwnPropertyDescriptor(transcript, "clear")?.configurable,
		).toBe(false);
	});

	test("resetDisplay invokes the exact root capability and reports absence", () => {
		let calls = 0;
		const root = { resetDisplay: () => calls++ };
		expect(new HostAdapter1731(root).resetDisplay()).toBe(true);
		expect(calls).toBe(1);
		expect(new HostAdapter1731({}).resetDisplay()).toBe(false);
		expect(new HostAdapter1731(null).resetDisplay()).toBe(false);
		expect(new HostAdapter1731(undefined).resetDisplay()).toBe(false);
	});
});

stockTest("stock 17.3.8 host capability canary", async () => {
	const host = await loadStockHost();
	const transcript = new host.TranscriptContainer();
	await host.initTheme();
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
	expect(isTranscriptHost(transcript)).toBe(true);
	expect(transcriptCapabilities(transcript).clear).toBe(true);
	expect(isToolComponent(tool)).toBe(true);
	expect(isReadGroupComponent(readGroup)).toBe(true);
	expect(leafCapabilities(tool).kind).toBe("tool");
	expect(leafCapabilities(readGroup).kind).toBe("readGroup");
	// Version last: a pin mismatch must not blind the seam probes above.
	expect(stockHostVersion()).toBe("17.3.8");
});

stockTest(
	"stock 17.3.8 transcript forwards activity visibility to new children",
	async () => {
		const host = await loadStockHost();
		const transcript = new host.TranscriptContainer();
		const probe = new ToolActivityProbe();
		transcript.setToolActivityVisible(false);
		transcript.addChild(probe);
		expect(probe.visible).toBe(false);
		expect(transcript.render(120)).toEqual([]);
		transcript.setToolActivityVisible(true);
		expect(probe.visible).toBe(true);
		expect(transcript.render(120)).toEqual(["activity"]);
	},
);
