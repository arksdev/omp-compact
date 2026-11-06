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

import { nativeText } from "./native-text";
import { decideToolRender, type ToolRenderDecision } from "./render-decision";
import {
	isVibeToolName,
	renderCompactToolRows,
	terminalGitSummaryLine,
} from "./render";
import type { CallRecord, RunRecord, SessionLedger } from "./session-ledger";
import type { Theme } from "./theme-types";
import { resolveToolRule } from "./tool-presentation-rules";

type ToolCallBlock = Extract<TranscriptBlock, { type: "toolCall" }>;
type LeafBlock = Exclude<TranscriptBlock, { type: "toolCall" }>;

export interface PresenterDeps {
	readonly ledger: SessionLedger;
	/**
	 * Walk the current session branch into the ledger unless it was walked
	 * already; a no-op before the plugin knows the session.
	 */
	restore(): void;
	/** The active theme, or `undefined` before the plugin saw a UI. */
	theme(): Theme | undefined;
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

	/**
	 * Non-tool blocks (advisor, skill, late diagnostics, `!`/`$` runs, TTSR,
	 * todo reminders, background job notices): omp's own drawing for now.
	 */
	#presentLeaf(_block: LeafBlock): TranscriptPresentation {
		return undefined;
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
				? [...renderCompactToolRows(view, theme, undefined, run.paths)]
				: [];
			if (decision.kind === "tool-rows" && decision.summary) {
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
				...renderCompactToolRows(view, theme, undefined, run.paths),
			];
			if (decision.summary) {
				const projection = this.#deps.ledger.projection(run);
				if (projection)
					rows.push(terminalGitSummaryLine(projection.hashes, theme));
			}
			return compactAnswer(rows);
		}
		return compactAnswer(
			renderCompactToolRows(
				{ ...view, git: decision.includeGit ? call.git : undefined },
				theme,
				undefined,
				run.paths,
			),
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
		const known = ledger.call(block.id);
		if (known) return known;
		this.#deps.restore();
		const restored = ledger.call(block.id);
		if (restored) return restored;
		const run = ledger.active;
		if (run && block.id === "")
			return { id: "", toolName: block.toolName, run, mutations: [] };
		return ledger.startCall(block.id, block.toolName);
	}
}
