/**
 * B03: pure, table-driven compact-vs-native presentation decision.
 *
 * Extracted from the decision embedded in RuntimeAdapter#renderBlock. The
 * module maps route + frozen run mode + ledger phase + expansion/native
 * fallback + result/evidence flags to one of four block render kinds:
 * native (stock renderer), empty (hide the row), tool-rows (compact tool
 * rows) and read-rows (compact read-group rows).
 *
 * The layer is deliberately host-free: no component instances, no UI, no
 * theme. Inputs are plain data flags; line construction and theme coloring
 * stay in the caller. Decision order is load-bearing — it must stay
 * byte-identical to the original adapter chain, so the rules are a constant
 * ordered table, not a condition soup.
 */

import type { CompactMode } from "./config";
import type { ToolRoute } from "./tool-presentation-rules";
import type { LedgerPhase } from "./turn-ledger";

/** How the block renders. */
export type BlockRenderKind = "native" | "empty" | "tool-rows" | "read-rows";

export interface ToolRenderInput {
	/**
	 * Presentation route of the tool's registry rule; `undefined` when the
	 * tool is unknown. Unknown tools fail open to the native renderer
	 * before any compact/filtered/clear decision.
	 */
	route: ToolRoute | undefined;
	/** Frozen runtime-mode snapshot of the run (compact/live/clear). */
	mode: CompactMode;
	/** The run's frozen `retainGitLive` flag. */
	retainGitLive: boolean;
	/** Ledger phase: working / filtered (terminal answer) / full (abort). */
	phase: LedgerPhase;
	/** Expanded state of the component (native inspection escape hatch). */
	expanded: boolean;
	/**
	 * Registry opt-out of the native expansion escape hatch: when true,
	 * explicit expansion keeps the compact rows instead of falling back to
	 * the native renderer (browser, computer, resolve, reject).
	 */
	compactOnExpand: boolean;
	/** True when the state carries retained mutation evidence. */
	hasMutations: boolean;
	/** True when the state carries Git evidence. */
	hasGit: boolean;
	/**
	 * Raw aggregate commit-hash count of the ledger's terminal projection.
	 * The decision applies `retainGitLive` itself — the caller always
	 * passes the full projection count.
	 */
	hashesLength: number;
	/** True when this state renders the trailing aggregate Git summary. */
	isAnchor: boolean;
}

export interface ToolRowsDecision {
	readonly kind: "tool-rows";
	/** Filtered phase: rows come from the terminal retention view. */
	readonly filtered: boolean;
	/** Render the aggregate commit-hash summary row after mutations. */
	readonly summary: boolean;
	/** Include Git evidence rows in the compact view (working/full). */
	readonly includeGit: boolean;
}

export type ToolRenderDecision =
	| { readonly kind: "native" }
	| { readonly kind: "empty" }
	| ToolRowsDecision;

export interface ReadGroupRenderInput {
	/** Frozen runtime-mode snapshot of the group's run (if bound). */
	mode: CompactMode;
	/**
	 * Ledger phase of the group's run; `undefined` when the group has no
	 * bound ledger yet (its native entries belong to untracked ids).
	 */
	phase: LedgerPhase | undefined;
	/** Expanded state of the group (native inspection escape hatch). */
	expanded: boolean;
	/**
	 * False when any observed id fails to resolve to a read state mapped to
	 * this group — the raw native renderer must stay in every phase.
	 */
	completelyMapped: boolean;
	/** Number of read states mapped to this group. */
	readCount: number;
}

export type ReadGroupRenderDecision =
	| { readonly kind: "native" }
	| { readonly kind: "empty" }
	| { readonly kind: "read-rows" };

interface ToolRenderRule {
	readonly when?: (input: ToolRenderInput, hashes: number) => boolean;
	readonly decide: (
		input: ToolRenderInput,
		hashes: number,
	) => ToolRenderDecision;
}

/**
 * Effective aggregate-hash count for the terminal view: the summary exists
 * only for a filtered ledger when `retainGitLive` is on; otherwise Git rows
 * and the aggregate line stay visually suppressed (`live` default) while
 * persisted evidence and ledger entries are never mutated by the toggle.
 */
function effectiveHashes(input: ToolRenderInput): number {
	return input.phase === "filtered" && input.retainGitLive
		? input.hashesLength
		: 0;
}

// Rules evaluated top-to-bottom; first match wins. Order is critical:
// specific conditions (registry routing, native-live) before fallbacks.
const TOOL_RENDER_TABLE: readonly ToolRenderRule[] = Object.freeze([
	{
		// Registry routing: only explicitly registered tools get compact
		// presentation; an unknown tool fails open to the native renderer
		// before any compact/filtered/clear decision.
		when: (input) => input.route === undefined,
		decide: (): ToolRenderDecision => ({ kind: "native" }),
	},
	{
		// native-live (ask and any future interactive stock chrome) stays on
		// the stock renderer in every mode and every phase — working, filtered
		// terminal answer, and full abort/error alike. clear never hides it;
		// filtered retention never drops it; full never forces tool-rows.
		when: (input) => input.route === "native-live",
		decide: (): ToolRenderDecision => ({ kind: "native" }),
	},
	{
		// `clear` hides normal tool rows while working and at the terminal
		// answer; abort/full finalizations keep compact diagnostic rows.
		when: (input) => input.mode === "clear" && input.phase !== "full",
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
		// Expanded mode uses the original native render as inspection escape
		// hatch for ordinary compact tools. `compactOnExpand` tools (browser,
		// computer, resolve, reject) deliberately stay compact when explicitly
		// expanded.
		when: (input) =>
			input.phase === "working" &&
			input.expanded &&
			!input.compactOnExpand,
		decide: (): ToolRenderDecision => ({ kind: "native" }),
	},
	{
		// Terminal retention: mutation rows stay in chronological position;
		// the aggregate commit-summary line is appended only to the run's
		// anchor state (the last retained row of the ledger).
		when: (input) => input.phase === "filtered",
		decide: (_input, hashes): ToolRenderDecision => ({
			kind: "tool-rows",
			filtered: true,
			summary: hashes > 0 && _input.isAnchor,
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
			includeGit: true,
		}),
	},
]);

/**
 * Compact-vs-native decision for a bound tool block. Pure: consumes plain
 * flags, returns a render kind; the caller owns theme and line construction.
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
		includeGit: true,
	};
}

// Rules evaluated top-to-bottom; first match wins. Clear mode and
// expanded checks precede the default filtered/working decisions.
const READ_GROUP_RENDER_TABLE: readonly {
	readonly when?: (input: ReadGroupRenderInput) => boolean;
	readonly decide: () => ReadGroupRenderDecision;
}[] = Object.freeze([
	{
		// Incompletely mapped groups (untracked observed ids, or none yet)
		// keep the raw native renderer in every phase — even terminal
		// filtering — so no native entry is silently dropped.
		when: (input) => !input.completelyMapped,
		decide: (): ReadGroupRenderDecision => ({ kind: "native" }),
	},
	{
		// `clear` hides mapped read rows while working and at the terminal
		// answer; abort/full keeps diagnostics. Groups without a bound
		// ledger (phase undefined) are never hidden.
		when: (input) =>
			input.mode === "clear" &&
			input.phase !== undefined &&
			input.phase !== "full",
		decide: (): ReadGroupRenderDecision => ({ kind: "empty" }),
	},
	{
		// Read groups are entirely routine: filtered terminal answers remove
		// the whole group.
		when: (input) => input.phase === "filtered",
		decide: (): ReadGroupRenderDecision => ({ kind: "empty" }),
	},
	{
		// Expanded groups keep the raw native renderer; the fold never
		// recolors or rewrites them.
		when: (input) => input.expanded,
		decide: (): ReadGroupRenderDecision => ({ kind: "native" }),
	},
	{
		// Nothing mapped to render yet stays native.
		when: (input) => input.readCount === 0,
		decide: (): ReadGroupRenderDecision => ({ kind: "native" }),
	},
	{
		decide: (): ReadGroupRenderDecision => ({ kind: "read-rows" }),
	},
]);

/**
 * Compact-vs-native decision for a bound read group block. Same purity
 * contract as `decideToolRender`.
 */
export function decideReadGroupRender(
	input: ReadGroupRenderInput,
): ReadGroupRenderDecision {
	for (const rule of READ_GROUP_RENDER_TABLE) {
		if (rule.when && !rule.when(input)) continue;
		return rule.decide();
	}
	return { kind: "read-rows" };
}
