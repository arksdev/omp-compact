/**
 * Pure, table-driven presentation decision for one tool call.
 *
 * Maps route + frozen run mode + run phase + evidence flags to one of four
 * kinds: native (omp's full card), host-compact (omp's own one-row summary),
 * empty (hidden) and tool-rows (the plugin's compact rows).
 *
 * The layer is deliberately host-free: no blocks, no UI, no theme. Inputs are
 * plain data flags; row construction and theme coloring stay in the caller.
 * Decision order is load-bearing, so the rules are a constant ordered table,
 * not a condition soup. Expansion is omp's: an expanded block is drawn in full
 * whatever this table answers.
 */

import type { CompactMode } from "./config";
import type { ToolRoute } from "./tool-presentation-rules";
import type { LedgerPhase } from "./turn-ledger";

export interface ToolRenderInput {
	/**
	 * Presentation route of the tool's registry rule; `undefined` when the
	 * tool is unknown. Unknown tools get omp's own one-row summary in every
	 * mode and phase, so a new or renamed tool needs no plugin update.
	 */
	route: ToolRoute | undefined;
	/** Frozen runtime-mode snapshot of the run (compact/live/clear). */
	mode: CompactMode;
	/** The run's frozen `retainGitLive` flag. */
	retainGitLive: boolean;
	/**
	 * The run's frozen opt-out of compact rows for this tool, derived from
	 * settings by the caller. True means the tool family the user switched
	 * off owns this block, so it renders with the stock card. The flag stays
	 * plain data: this module never learns tool names — the caller pairs the
	 * name with the frozen settings snapshot and passes the result.
	 */
	compactSuppressedBySettings: boolean;
	/** Run phase: working / filtered (terminal answer) / full (abort). */
	phase: LedgerPhase;
	/** True when the call carries retained mutation evidence. */
	hasMutations: boolean;
	/** True when the call carries Git evidence. */
	hasGit: boolean;
	/**
	 * Raw aggregate commit-hash count of the run's terminal projection.
	 * The decision applies `retainGitLive` itself — the caller always
	 * passes the full projection count.
	 */
	hashesLength: number;
	/** True when this call renders the trailing aggregate Git summary. */
	isAnchor: boolean;
}

export interface ToolRowsDecision {
	readonly kind: "tool-rows";
	/** Filtered phase: rows come from the terminal retention view. */
	readonly filtered: boolean;
	/** Render the aggregate commit-hash summary row after mutations. */
	readonly summary: boolean;
	/**
	 * Drop the mutation rows and keep only the summary. Set for `clear`,
	 * whose quiet view shows created commits and nothing else; every other
	 * mode keeps mutation rows in chronological position.
	 */
	readonly summaryOnly: boolean;
	/** Include Git evidence rows in the compact view (working/full). */
	readonly includeGit: boolean;
}

export type ToolRenderDecision =
	| { readonly kind: "native" }
	| { readonly kind: "host-compact" }
	| { readonly kind: "empty" }
	| ToolRowsDecision;

export interface BackgroundCompletionRenderInput {
	/** Frozen mode of the run that owns the notice, else the current mode. */
	mode: CompactMode;
	/**
	 * Ledger phase of the run that owns the notice; `undefined` when no run
	 * owns it (earlier history).
	 */
	phase: LedgerPhase | undefined;
}

export type BackgroundCompletionRenderDecision =
	| { readonly kind: "native" }
	| { readonly kind: "empty" };

interface ToolRenderRule {
	readonly when?: (input: ToolRenderInput, hashes: number) => boolean;
	readonly decide: (
		input: ToolRenderInput,
		hashes: number,
	) => ToolRenderDecision;
}

/**
 * Effective aggregate-hash count for the terminal view: the summary exists
 * only once a run has ended and only when `retainGitLive` is on; otherwise
 * Git rows and the aggregate line stay visually suppressed (`live` default)
 * while persisted evidence is never mutated by the toggle. `clear` treats an
 * interrupted or failed finalization as terminal too — the commits it created
 * exist either way, and its quiet view has no second chance to show them.
 */
function effectiveHashes(input: ToolRenderInput): number {
	if (!input.retainGitLive) return 0;
	const terminal =
		input.phase === "filtered" ||
		(input.mode === "clear" && input.phase === "full");
	return terminal ? input.hashesLength : 0;
}

// Rules evaluated top-to-bottom; first match wins. Order is critical:
// specific conditions (registry routing, native-live) before fallbacks.
const TOOL_RENDER_TABLE: readonly ToolRenderRule[] = Object.freeze([
	{
		// Registry routing: a tool the registry does not know gets omp's own
		// one-row summary in every mode and phase. omp's row names the tool
		// and its target from the tool's own renderer, which is right for a
		// tool this plugin has no grammar for, and hiding a call it cannot
		// describe would hide work the user never saw summarized.
		when: (input) => input.route === undefined,
		decide: (): ToolRenderDecision => ({ kind: "host-compact" }),
	},
	{
		// native-live (ask and any future interactive stock chrome) stays on
		// the stock renderer in every mode and every phase — working, filtered
		// terminal answer, and full abort/error alike.
		when: (input) => input.route === "native-live",
		decide: (): ToolRenderDecision => ({ kind: "native" }),
	},
	{
		// Settings opt-out: a tool family whose compact rows the user
		// switched off renders with the stock card in every mode and phase.
		// The choice is the user's, so it outranks every mode and phase rule.
		when: (input) => input.compactSuppressedBySettings,
		decide: (): ToolRenderDecision => ({ kind: "native" }),
	},
	{
		// The one row `clear` never swallows: the trailing aggregate line with
		// the hashes of the commits the run created. Effective hashes are zero
		// while working and with the Git toggle off, so this exception can
		// neither break the silence of a live turn nor override the toggle.
		when: (input, hashes) =>
			input.mode === "clear" && input.isAnchor && hashes > 0,
		decide: (): ToolRenderDecision => ({
			kind: "tool-rows",
			filtered: true,
			summary: true,
			summaryOnly: true,
			includeGit: false,
		}),
	},
	{
		// `clear` hides normal tool rows in every phase — while working, at
		// the terminal answer, and in the abort/error finalization alike.
		when: (input) => input.mode === "clear",
		decide: (): ToolRenderDecision => ({ kind: "empty" }),
	},
	{
		// Terminal retention: no mutations and no aggregate commit hashes
		// (effective — `retainGitLive=false` suppresses the summary) means
		// the row disappears from the filtered log.
		when: (input, hashes) =>
			input.phase === "filtered" && !input.hasMutations && hashes === 0,
		decide: (): ToolRenderDecision => ({ kind: "empty" }),
	},
	{
		// Working phase with Git rows visually suppressed (`live` without
		// retainGitLive): the individual Git row is hidden while working.
		when: (input) =>
			input.phase === "working" &&
			input.mode === "live" &&
			!input.retainGitLive &&
			input.hasGit,
		decide: (): ToolRenderDecision => ({ kind: "empty" }),
	},
	{
		// Terminal retention: mutation rows stay in chronological position;
		// the aggregate commit-summary line is appended only to the run's
		// anchor call (the last call carrying evidence).
		when: (input) => input.phase === "filtered",
		decide: (input, hashes): ToolRenderDecision => ({
			kind: "tool-rows",
			filtered: true,
			summary: hashes > 0 && input.isAnchor,
			summaryOnly: false,
			includeGit: false,
		}),
	},
	{
		// Working and full (abort/error/compact-mode terminal) phases render
		// the full compact row including Git evidence.
		decide: (): ToolRenderDecision => ({
			kind: "tool-rows",
			filtered: false,
			summary: false,
			summaryOnly: false,
			includeGit: true,
		}),
	},
]);

/**
 * Presentation decision for one tool call. Pure: consumes plain flags,
 * returns a render kind; the caller owns theme and row construction.
 */
export function decideToolRender(input: ToolRenderInput): ToolRenderDecision {
	const hashes = effectiveHashes(input);
	for (const rule of TOOL_RENDER_TABLE) {
		if (rule.when && !rule.when(input, hashes)) continue;
		return rule.decide(input, hashes);
	}
	return {
		kind: "tool-rows",
		filtered: false,
		summary: false,
		summaryOnly: false,
		includeGit: true,
	};
}

// Rules evaluated top-to-bottom; first match wins. Terminal retention comes
// first: it holds in every mode, `clear` included.
const BACKGROUND_COMPLETION_RENDER_TABLE: readonly {
	readonly when?: (input: BackgroundCompletionRenderInput) => boolean;
	readonly decide: () => BackgroundCompletionRenderDecision;
}[] = Object.freeze([
	{
		// A finished background process or job changed nothing in the
		// workspace, so the terminal answer keeps no trace of it — same
		// retention verdict read groups get.
		when: (input) => input.phase === "filtered",
		decide: (): BackgroundCompletionRenderDecision => ({ kind: "empty" }),
	},
	{
		// `clear` hides the notice in every phase, exactly like an ordinary
		// tool card: the quiet view owes the screen nothing but the answer.
		when: (input) => input.mode === "clear",
		decide: (): BackgroundCompletionRenderDecision => ({ kind: "empty" }),
	},
	{
		// A notice belonging to no run (phase undefined) comes from restored
		// history, so it follows how that history is presented: `compact`
		// shows the restored rows, the other modes fold them away. Showing
		// the line unconditionally left it as the single surviving row of an
		// otherwise folded history.
		when: (input) => input.phase === undefined && input.mode === "compact",
		decide: (): BackgroundCompletionRenderDecision => ({ kind: "native" }),
	},
	{
		when: (input) => input.phase === undefined,
		decide: (): BackgroundCompletionRenderDecision => ({ kind: "empty" }),
	},
	{
		decide: (): BackgroundCompletionRenderDecision => ({ kind: "native" }),
	},
]);

/**
 * Show-or-drop decision for a background job or supervised process notice:
 * `native` keeps omp's own card, `empty` hides it.
 */
export function decideBackgroundCompletionRender(
	input: BackgroundCompletionRenderInput,
): BackgroundCompletionRenderDecision {
	for (const rule of BACKGROUND_COMPLETION_RENDER_TABLE) {
		if (rule.when && !rule.when(input)) continue;
		return rule.decide();
	}
	return { kind: "native" };
}
