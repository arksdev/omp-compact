/**
 * The plugin's transcript presenter: how each block of the main transcript
 * is drawn, decided from the block omp hands over and the session ledger.
 *
 * omp asks again whenever a block's data changes, when the plugin calls
 * `refreshTranscript`, and whenever it rebuilds the transcript, and keeps no
 * earlier answer, so every answer is a function of the block and the ledger
 * state keyed by the block's id. It runs while the transcript draws: no I/O
 * beyond the one branch walk that restores history, no caches.
 */

import type {
	TranscriptBlock,
	TranscriptPresentation,
} from "@oh-my-pi/pi-coding-agent";

import {
	advisorNoteViews,
	injectRuleViews,
	lateDiagnosticsView,
	skillMessageView,
	todoReminderView,
	userExecutionView,
} from "./leaf-views";
import type { RunModeSnapshot } from "./mode-policy";
import { nativeText } from "./native-text";
import {
	decideBackgroundCompletionRender,
	decideToolRender,
	type ToolRenderDecision,
} from "./render-decision";
import {
	isVibeToolName,
	type RowHead,
	renderAdvisorRows,
	renderCompactToolRows,
	renderInjectRuleRows,
	renderLateDiagnosticsRow,
	renderSkillMessageRow,
	renderTodoReminderRow,
	renderUserExecutionRow,
	repeatsStockTitle,
	terminalGitSummaryLine,
	type CompactToolView,
} from "./render";
import type { CallRecord, RunRecord, SessionLedger } from "./session-ledger";
import type { Theme } from "./theme-types";
import { resolveToolRule } from "./tool-presentation-rules";

type ToolCallBlock = Extract<TranscriptBlock, { type: "toolCall" }>;
type LeafBlock = Exclude<TranscriptBlock, { type: "toolCall" }>;
type MessageBlock = Extract<TranscriptBlock, { type: "message" }>;

export interface PresenterDeps {
	readonly ledger: SessionLedger;
	/**
	 * Walk the current session branch into the ledger unless it was walked
	 * already; a no-op before the plugin knows the session.
	 */
	restore(): void;
	/** The active theme, or `undefined` before the plugin saw a UI. */
	theme(): Theme | undefined;
	/** Settings for a block no run owns: earlier history. */
	historicalMode(): RunModeSnapshot;
	/** Whether non-blocking advisor notes are shown compact (live setting). */
	compactAdvisorNotes(): boolean;
	/** Whether omp draws Tern's native view, where a block's title leads its label. */
	nativeView(): boolean;
}

/**
 * Whether omp draws Tern's native view, by the probe omp itself uses. omp
 * gives no signal, and inside tmux `TERM_PROGRAM` names tmux: a wrong
 * guess only changes whether a label repeats its card's title.
 */
export function ternNativeView(
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	return (
		env.TERM_PROGRAM?.toLowerCase() === "tern" && env.PI_TUI_NATIVE !== "0"
	);
}

/** A leading dim `•` and its space: omp draws the row's own glyph. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches SGR escapes
const LEADING_BULLET = /^((?:\x1b\[[0-9;:]*m)*)•((?:\x1b\[[0-9;:]*m)*) /;

/**
 * Rows as omp's compact answer: the first row replaces omp's one-row
 * summary, the rest go below it. Nothing to show is `hidden`.
 */
function compactAnswer(rows: readonly string[]): TranscriptPresentation {
	const [first, ...rest] = rows;
	if (first === undefined) return "hidden";
	// Rows keep their own bullets: omp only indents them.
	return {
		compact: {
			label: nativeText(first.replace(LEADING_BULLET, "$1$2")),
			rows: rest.map(nativeText),
		},
	};
}

/**
 * Whether a run's presentation leaves out the call's own row: hidden
 * outright, or filtered to nothing but the aggregate Git summary line (a
 * routine call, or every call in `clear`).
 */
function hidesOwnRow(call: CallRecord, decision: ToolRenderDecision): boolean {
	if (decision.kind === "empty") return true;
	return (
		decision.kind === "tool-rows" &&
		decision.filtered &&
		(decision.summaryOnly || call.mutations.length === 0)
	);
}

export class TranscriptPresenterState {
	readonly #deps: PresenterDeps;
	readonly #hidesCalls = new WeakMap<RunRecord, boolean>();
	/** Advisor blocks omp asked about: a change of the advisor setting asks again. */
	readonly #advisorIds = new Set<string>();
	#asked = false;

	constructor(deps: PresenterDeps) {
		this.#deps = deps;
	}

	/** Whether omp has asked anything yet (the setting may be off). */
	get asked(): boolean {
		return this.#asked;
	}

	/** The presenter omp calls (`pi.registerTranscriptPresenter`). */
	readonly present = (block: TranscriptBlock): TranscriptPresentation => {
		this.#asked = true;
		if (block.type === "toolCall") return this.#presentToolCall(block);
		if (block.type === "message" || block.type === "event")
			return this.#presentLeaf(block);
		return undefined;
	};

	/**
	 * Whether a finished run hid any of its calls, which is when its stats
	 * row offers to show them. Settled once the run ends: its mode is frozen
	 * and its calls no longer change.
	 */
	hidesCalls(run: RunRecord): boolean {
		if (run.phase === "working") return false;
		const known = this.#hidesCalls.get(run);
		if (known !== undefined) return known;
		const hides = run.calls.some((call) =>
			hidesOwnRow(call, this.#decide(call, call.toolName)),
		);
		this.#hidesCalls.set(run, hides);
		return hides;
	}

	/** Ids of the calls a finished run's presentation hides. */
	hiddenCallIds(run: RunRecord): string[] {
		if (run.phase === "working") return [];
		return run.calls
			.filter((call) => hidesOwnRow(call, this.#decide(call, call.toolName)))
			.map((call) => call.id);
	}

	/** Ids of the advisor blocks omp asked about. */
	advisorIds(): string[] {
		return [...this.#advisorIds];
	}

	/**
	 * The label's head: in Tern's native view the block's stock title leads
	 * the label, so a row leaves out the same word.
	 */
	#head(stockTitle: string): RowHead {
		return this.#deps.nativeView() ? { stockTitle } : {};
	}

	/**
	 * Non-tool blocks: one compact row (or a few) from the block's data,
	 * as the plugin drew them before omp asked presenters. A kind the plugin
	 * does not know, or a disabled plugin, stays omp's own card.
	 */
	#presentLeaf(block: LeafBlock): TranscriptPresentation {
		const theme = this.#deps.theme();
		if (!theme) return undefined;
		if (block.type === "message") return this.#presentMessage(block, theme);
		const { event } = block;
		if (event.type !== "ttsr_triggered" && event.type !== "todo_reminder")
			return undefined;
		if (!this.#leafMode(block.id).enabled) return undefined;
		if (event.type === "ttsr_triggered") {
			const rules = injectRuleViews(event.rules);
			return rules ? compactAnswer(renderInjectRuleRows(rules, theme)) : "full";
		}
		const view = todoReminderView(event);
		return view ? compactAnswer(renderTodoReminderRow(view, theme)) : "full";
	}

	#presentMessage(block: MessageBlock, theme: Theme): TranscriptPresentation {
		const { message } = block;
		if (
			message.role === "bashExecution" ||
			message.role === "pythonExecution"
		) {
			if (!this.#leafMode(block.id, message.timestamp).enabled)
				return undefined;
			const view = userExecutionView(message);
			if (!view) return "full";
			const title = message.role === "bashExecution" ? "Bash" : "Python";
			return compactAnswer(
				renderUserExecutionRow(view, theme, undefined, this.#head(title)),
			);
		}
		if (message.role !== "custom") return undefined;
		switch (message.customType) {
			case "advisor": {
				this.#advisorIds.add(block.id);
				if (!this.#deps.compactAdvisorNotes()) return undefined;
				const notes = advisorNoteViews(message.details);
				return notes
					? compactAnswer(
							renderAdvisorRows(notes, theme, undefined, this.#head("Advisor")),
						)
					: "full";
			}
			case "skill-prompt": {
				if (!this.#leafMode(block.id, message.timestamp).enabled)
					return undefined;
				return compactAnswer(
					renderSkillMessageRow(
						skillMessageView(message.details),
						theme,
						undefined,
						this.#head("Skill"),
					),
				);
			}
			case "lsp-late-diagnostic": {
				if (!this.#leafMode(block.id, message.timestamp).enabled)
					return undefined;
				const view = lateDiagnosticsView(message.details);
				return view
					? compactAnswer(
							renderLateDiagnosticsRow(
								view,
								theme,
								undefined,
								this.#head("Late diagnostics"),
							),
						)
					: "full";
			}
			case "async-result":
			case "launch-completion": {
				// The notice keeps the verdict of the run that produced it; one
				// no run owns is earlier history and follows the current mode.
				const run = this.#deps.ledger.leafRun(block.id, message.timestamp);
				const mode = run?.mode ?? this.#deps.historicalMode();
				if (!mode.enabled) return undefined;
				const decision = decideBackgroundCompletionRender({
					mode: mode.mode,
					phase: run?.phase,
				});
				return decision.kind === "native" || run?.revealed ? "full" : "hidden";
			}
		}
		return undefined;
	}

	/** Settings of the run a non-tool block belongs to, else the current ones. */
	#leafMode(id: string, timestamp?: number): RunModeSnapshot {
		return (
			this.#deps.ledger.leafRun(id, timestamp)?.mode ??
			this.#deps.historicalMode()
		);
	}

	#presentToolCall(block: ToolCallBlock): TranscriptPresentation {
		const call = this.#callFor(block);
		if (!call?.run.mode.enabled) return undefined;
		const theme = this.#deps.theme();
		if (!theme) return undefined;
		const decision = this.#decide(call, block.toolName);
		if (decision.kind === "native") return "full";
		if (decision.kind === "host-compact") return "compact";
		const run = call.run;
		// omp's card is titled by the tool's label, which is its name.
		const head = this.#head(block.toolName);
		// A finished run never shows a call as in flight: an end omp never
		// delivered must not keep the row (and its evidence rows) pending.
		const view = {
			toolName: block.toolName,
			args: block.args,
			result: block.result,
			isError: block.isError,
			isPartial: run.phase === "working" && block.isPartial,
			settledAt: call.settledAt,
			mutationEntries: call.mutations,
		};
		if (decision.kind === "empty" || hidesOwnRow(call, decision)) {
			// Hidden calls come back, as `compact` mode would keep them, while
			// a click on the run's stats row shows them.
			const rows = run.revealed
				? [...renderCompactToolRows(view, theme, undefined, run.paths, head)]
				: [];
			const summary = decision.kind === "tool-rows" && decision.summary;
			if (!summary && this.#stockHeadSuffices(call, view, rows, run))
				return "compact";
			if (summary) {
				const projection = this.#deps.ledger.projection(run);
				if (projection)
					rows.push(terminalGitSummaryLine(projection.hashes, theme));
			}
			return compactAnswer(rows);
		}
		if (decision.filtered) {
			// Terminal retention: write/edit mutation rows stay in their
			// chronological place; individual Git rows collapse into one
			// aggregate commit-summary line after the run's last evidence.
			const rows = [
				...renderCompactToolRows(view, theme, undefined, run.paths, head),
			];
			if (decision.summary) {
				const projection = this.#deps.ledger.projection(run);
				if (projection)
					rows.push(terminalGitSummaryLine(projection.hashes, theme));
			}
			return compactAnswer(rows);
		}
		const shown = { ...view, git: decision.includeGit ? call.git : undefined };
		const rows = renderCompactToolRows(
			shown,
			theme,
			undefined,
			run.paths,
			head,
		);
		return this.#stockHeadSuffices(call, shown, rows, run)
			? "compact"
			: compactAnswer(rows);
	}

	/**
	 * In Tern's native view omp's head already shows the target, its meta and
	 * any error, so a lone row with no evidence and the same title adds nothing.
	 */
	#stockHeadSuffices(
		call: CallRecord,
		view: CompactToolView,
		rows: readonly string[],
		run: RunRecord,
	): boolean {
		return (
			this.#deps.nativeView() &&
			rows.length === 1 &&
			!view.git &&
			call.mutations.length === 0 &&
			!isVibeToolName(view.toolName) &&
			repeatsStockTitle(view, run.paths, view.toolName)
		);
	}

	#decide(call: CallRecord, toolName: string): ToolRenderDecision {
		const run = call.run;
		// Rows draw against the Git projection only once the run ended.
		const projection =
			run.phase === "filtered" ||
			(run.phase === "full" && run.mode.mode === "clear")
				? this.#deps.ledger.projection(run)
				: undefined;
		return decideToolRender({
			route: resolveToolRule(toolName)?.route,
			mode: run.mode.mode,
			retainGitLive: run.mode.retainGitLive,
			compactSuppressedBySettings:
				!run.mode.compactVibeRows && isVibeToolName(toolName),
			phase: run.phase,
			hasMutations: call.mutations.length > 0,
			hasGit: call.git !== undefined,
			hashesLength: projection?.hashes.length ?? 0,
			isAnchor: projection?.anchor === call,
		});
	}

	/**
	 * The ledger's record of a call: live, restored from the branch (walked on
	 * the first unknown id), or a call of the open run whose arguments stream
	 * before its `tool_execution_start` event arrives. A call still streaming
	 * without an id belongs to the open run but has no record to keep.
	 */
	#callFor(block: ToolCallBlock): CallRecord | undefined {
		const ledger = this.#deps.ledger;
		const known = ledger.call(block.id, block.args);
		if (known) return known;
		this.#deps.restore();
		const restored = ledger.call(block.id, block.args);
		if (restored) return restored;
		const run = ledger.active;
		if (run && block.id === "")
			return { id: "", toolName: block.toolName, run, mutations: [] };
		return ledger.startCall(block.id, block.toolName);
	}
}
