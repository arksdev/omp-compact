/**
 * Per-session plugin state, keyed by toolCallId (and, for the non-tool
 * blocks, by block id: the run open when each block first appeared).
 *
 * The transcript presenter is asked about blocks by id and gets the call's
 * arguments and result with every question, so this ledger keeps only what
 * the block does not carry: which logical run a call belongs to, that run's
 * frozen settings and phase, and the mutation and Git evidence the audit
 * produced for the call. It is filled from two sources that build the same
 * structure: live events (`agent_start` … `tool_execution_*`, the audit
 * callbacks, `agent_end`) and a walk of the session branch that reads the
 * persisted assistant tool calls, tool results and the plugin's
 * `MUTATION`/`GIT`/`STATS` entries.
 *
 * A logical run spans toolUse/willContinue continuations. It ends at a
 * terminal `agent_end` (live) or at the next user message (walk); its phase
 * then freezes and its Git projection (aggregate commit hashes plus the call
 * that carries the summary row) is computed once.
 */

import type { DisplayPathOptions } from "./display-path";
import {
	GIT_MESSAGE_TYPE,
	type GitMessageDetails,
	isBoundedString,
	isGitMessageDetails,
	isMutationMessageDetails,
	type LegacyMutationMessageDetails,
	MAX_MUTATION_ENTRIES,
	MAX_TOOL_CALL_ID_LENGTH,
	MAX_TOOL_NAME_LENGTH,
	MUTATION_MESSAGE_TYPE,
	type MutationMessageDetails,
} from "./messages";
import type { RunModeSnapshot } from "./mode-policy";
import { objectRecord } from "./object-record";
import { gitCommitHashes } from "./render";
import { isRunStatsEvidence, STATS_MESSAGE_TYPE } from "./run-stats";
import {
	classifyAgentEnd,
	type LedgerPhase,
	terminalPhase,
} from "./turn-ledger";

export type MutationEvidence =
	| MutationMessageDetails
	| LegacyMutationMessageDetails;

export interface CallRecord {
	readonly id: string;
	readonly toolName: string;
	readonly run: RunRecord;
	mutations: readonly MutationEvidence[];
	git?: GitMessageDetails;
	/**
	 * Wall clock of the settling result; undefined while in flight. Row
	 * grammars measuring elapsed time (vibe worker cards and their TTLs) use
	 * it as the frame clock, so a settled row draws the same whenever omp
	 * asks again.
	 */
	settledAt?: number;
}

export interface GitProjection {
	/** Aggregate commit hashes of the run, in call order. */
	readonly hashes: readonly string[];
	/** The call that carries the trailing summary row. */
	readonly anchor: CallRecord | undefined;
}

export interface RunRecord {
	/** Run id; stats evidence of a live run carries it. */
	readonly id: string;
	/** Settings frozen when the run started (or was restored). */
	readonly mode: RunModeSnapshot;
	/** Display-path options frozen with the mode. */
	readonly paths: DisplayPathOptions;
	readonly calls: CallRecord[];
	phase: LedgerPhase;
	/** Whether a click on the run's stats row showed the calls it hid. */
	revealed: boolean;
	/** Restored from the session branch rather than run in this process. */
	readonly restored: boolean;
	/** Wall clock when the run started. */
	readonly startedAt: number;
	/** Ids of the non-tool blocks (background notices, …) the run owns. */
	readonly leaves: string[];
	projection?: GitProjection;
}

export interface SessionLedgerOptions {
	/** Settings for a run restored from history. */
	restoredMode(): RunModeSnapshot;
	/** Display-path options for a new run. */
	displayPaths(): DisplayPathOptions;
	/** Injectable clock for deterministic tests. */
	now?(): number;
}

/** Keep non-zero line changes, proved empty creations, and deletes. */
function keptMutations(
	entries: readonly MutationEvidence[],
): readonly MutationEvidence[] {
	const kept = entries.filter(
		(entry) =>
			entry.toolName === "delete" ||
			("created" in entry && entry.created === true) ||
			(entry.added ?? 0) > 0 ||
			(entry.removed ?? 0) > 0,
	);
	return kept.length > MAX_MUTATION_ENTRIES
		? kept.slice(0, MAX_MUTATION_ENTRIES)
		: kept;
}

let runCounter = 0;

/** Unique within the process and across processes sharing a session file. */
function newRunId(prefix: string): string {
	return `${prefix}${Date.now().toString(36)}-${++runCounter}`;
}

export class SessionLedger {
	readonly #options: SessionLedgerOptions;
	readonly #now: () => number;
	/** Every known call, latest owner per id. */
	#calls = new Map<string, CallRecord>();
	/** Runs by the id their stats evidence names. */
	#runs = new Map<string, RunRecord>();
	#active: RunRecord | undefined;
	/** True while the open run waits for a continuation's agent_start. */
	#continuing = false;
	/** Finished run holding the calls that arrived with no run open. */
	#stray: RunRecord | undefined;
	/** Non-tool blocks by id: the run open when each first appeared. */
	#leafRuns = new Map<string, RunRecord | undefined>();
	/** Whether the current branch has been walked. */
	#restored = false;

	constructor(options: SessionLedgerOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	/** The run in progress, if any. */
	get active(): RunRecord | undefined {
		return this.#active;
	}

	/** Whether the current branch has been walked. */
	get restored(): boolean {
		return this.#restored;
	}

	/**
	 * Logical-run start. A continuation (`agent_end` with willContinue or a
	 * toolUse stop) keeps the open run; anything else opens a new one with
	 * the settings `mode` captures — asked only at a true run boundary, so a
	 * continuation never re-reads them.
	 */
	beginRun(mode: () => RunModeSnapshot): RunRecord {
		const open = this.#active;
		if (open && this.#continuing) {
			this.#continuing = false;
			return open;
		}
		// A run whose terminal `agent_end` never came keeps its full log.
		if (open) this.finalizeRun(open, "full");
		this.#continuing = false;
		const run = this.#newRun(newRunId("omp-compact-run-"), mode(), false);
		this.#active = run;
		return run;
	}

	/** Whether a logical run is open (between start and terminal end). */
	get running(): boolean {
		return this.#active !== undefined;
	}

	/** The call with this id, if the ledger knows it. */
	call(id: string): CallRecord | undefined {
		return this.#calls.get(id);
	}

	/** The run its stats evidence names. */
	run(id: string): RunRecord | undefined {
		return this.#runs.get(id);
	}

	/**
	 * The run a non-tool block belongs to: the run open when the block was
	 * first asked about, kept by block id. A block recorded before that run
	 * started (`timestamp`, a message's own clock) is earlier history, and
	 * so is every block seen with no run open: `undefined`.
	 */
	leafRun(id: string, timestamp?: number): RunRecord | undefined {
		if (this.#leafRuns.has(id)) return this.#leafRuns.get(id);
		const active = this.#active;
		const run =
			active && (timestamp === undefined || timestamp >= active.startedAt)
				? active
				: undefined;
		this.#leafRuns.set(id, run);
		run?.leaves.push(id);
		return run;
	}

	/**
	 * Record a call of the open run (`tool_execution_start`, or a block the
	 * presenter sees streaming before that event). A call already owned by
	 * the open run is returned unchanged; one owned by an earlier run (ids
	 * may repeat between runs) moves to the open run. A call with no open run
	 * (it arrived after the terminal `agent_end`) keeps its row and draws like
	 * history.
	 */
	startCall(id: string, toolName: string): CallRecord | undefined {
		if (
			!isBoundedString(id, MAX_TOOL_CALL_ID_LENGTH) ||
			id === "" ||
			!isBoundedString(toolName, MAX_TOOL_NAME_LENGTH)
		)
			return undefined;
		const run = this.#active ?? this.#strayRun();
		const existing = this.#calls.get(id);
		if (existing?.run === run) return existing;
		return this.#addCall(run, id, toolName);
	}

	/** A live call settled (`tool_execution_end`). */
	settleCall(id: string): void {
		const call = this.#calls.get(id);
		if (call?.run.phase === "working") call.settledAt ??= this.#now();
	}

	/**
	 * Verified mutation evidence for a call. Evidence of a finished run is
	 * frozen: the audit drain publishes before the run finalizes.
	 */
	setMutations(id: string, entries: readonly MutationEvidence[]): boolean {
		const call = this.#calls.get(id);
		if (call?.run.phase !== "working") return false;
		call.mutations = keptMutations(entries);
		return true;
	}

	/** Recognized Git evidence for a call; frozen once its run finished. */
	setGit(id: string, details: GitMessageDetails): boolean {
		const call = this.#calls.get(id);
		if (call?.run.phase !== "working") return false;
		call.git = details;
		return true;
	}

	/**
	 * `agent_end` for the open run: a continuation keeps it open; a terminal
	 * end detaches it from `active` and returns it, still working, so the
	 * caller can finalize it once the audit drain has published its evidence.
	 */
	endRun(event: {
		messages?: readonly unknown[];
		willContinue?: boolean;
	}): RunRecord | undefined {
		const run = this.#active;
		if (!run) return undefined;
		if (classifyAgentEnd(event) === "working") {
			this.#continuing = true;
			return undefined;
		}
		this.#active = undefined;
		this.#continuing = false;
		return run;
	}

	/** Freeze a run in its terminal phase; returns false when already final. */
	finalizeRun(
		run: RunRecord,
		classified: Exclude<LedgerPhase, "working">,
	): boolean {
		if (run.phase !== "working") return false;
		if (this.#active === run) {
			this.#active = undefined;
			this.#continuing = false;
		}
		run.phase = terminalPhase(classified, run.mode.mode);
		const now = this.#now();
		for (const call of run.calls) call.settledAt ??= now;
		return true;
	}

	/**
	 * The terminal Git projection of a finished run: aggregate commit hashes
	 * in call order and the last call carrying evidence, which draws the
	 * summary row. Computed once: a finished run's evidence is frozen.
	 */
	projection(run: RunRecord): GitProjection | undefined {
		if (run.phase === "working") return undefined;
		if (run.projection) return run.projection;
		const hashes: string[] = [];
		let anchor: CallRecord | undefined;
		for (const call of run.calls) {
			const commits = call.git ? gitCommitHashes(call.git) : [];
			hashes.push(...commits);
			if (call.mutations.length > 0 || commits.length > 0) anchor = call;
		}
		run.projection = { hashes, anchor };
		return run.projection;
	}

	/**
	 * Forget restored history: the branch changed (resume, tree navigation,
	 * branch, compaction), so the next `restore` walks it again. The open
	 * run, its calls, its blocks and its evidence stay — live events keep
	 * them current; an earlier run's blocks are history again.
	 */
	invalidateHistory(): void {
		this.#restored = false;
		this.#stray = undefined;
		const active = this.#active;
		for (const [id, call] of this.#calls)
			if (call.run !== active) this.#calls.delete(id);
		for (const [id, run] of this.#runs)
			if (run !== active) this.#runs.delete(id);
		for (const [id, run] of this.#leafRuns)
			if (run !== active) this.#leafRuns.delete(id);
	}

	/** Drop everything: a new session. */
	reset(): void {
		this.#calls = new Map();
		this.#runs = new Map();
		this.#leafRuns = new Map();
		this.#active = undefined;
		this.#continuing = false;
		this.#stray = undefined;
		this.#restored = false;
	}

	/**
	 * Walk a session branch into runs, calls and evidence, unless the current
	 * branch was already walked. Calls the open run owns keep their live state.
	 * Returns the ids of the restored calls.
	 */
	restore(entries: readonly unknown[]): readonly string[] {
		if (this.#restored) return [];
		this.#restored = true;
		const restored: string[] = [];
		const active = this.#active;
		let run: RunRecord | undefined;
		const ensureRun = (): RunRecord => {
			if (!run || run.phase !== "working")
				run = this.#newRun(
					newRunId("omp-compact-replay-"),
					this.#options.restoredMode(),
					true,
				);
			return run;
		};
		const close = (): void => {
			if (run?.phase === "working") this.finalizeRun(run, "full");
		};
		const addCall = (id: unknown, name: unknown): void => {
			if (
				!isBoundedString(id, MAX_TOOL_CALL_ID_LENGTH) ||
				id === "" ||
				!isBoundedString(name, MAX_TOOL_NAME_LENGTH)
			)
				return;
			const known = this.#calls.get(id);
			if (known && (known.run === active || known.run === run)) return;
			this.#addCall(ensureRun(), id, name);
			restored.push(id);
		};
		for (const value of entries) {
			const entry = objectRecord(value);
			if (entry.type === "message") {
				const message = objectRecord(entry.message);
				if (message.role === "user") {
					close();
					run = undefined;
					ensureRun();
				} else if (message.role === "assistant") {
					if (Array.isArray(message.content))
						for (const part of message.content) {
							const call = objectRecord(part);
							if (call.type === "toolCall") addCall(call.id, call.name);
						}
					const phase = classifyAgentEnd({
						messages: [message],
						willContinue: false,
					});
					if (phase === "filtered" && run) this.finalizeRun(run, phase);
				} else if (
					message.role === "toolResult" &&
					typeof message.toolCallId === "string"
				) {
					const call = this.#calls.get(message.toolCallId);
					if (call && call.run !== active && call.run.restored)
						call.settledAt ??= this.#now();
				}
				continue;
			}
			if (entry.type === "custom") {
				if (entry.customType === "tool_execution_start") {
					const data = objectRecord(entry.data);
					addCall(data.toolCallId, data.toolName);
				} else this.#restoreEvidence(entry.customType, entry.data, run);
				continue;
			}
			if (entry.type === "custom_message")
				this.#restoreEvidence(entry.customType, entry.details, run);
		}
		close();
		return restored;
	}

	#restoreEvidence(
		customType: unknown,
		details: unknown,
		run: RunRecord | undefined,
	): void {
		if (
			customType === MUTATION_MESSAGE_TYPE &&
			isMutationMessageDetails(details)
		) {
			const call = this.#calls.get(details.toolCallId);
			if (!call?.run.restored || call.run !== run) return;
			if (call.mutations.length >= MAX_MUTATION_ENTRIES) return;
			call.mutations = keptMutations([...call.mutations, details]);
			return;
		}
		if (customType === GIT_MESSAGE_TYPE && isGitMessageDetails(details)) {
			const call = this.#calls.get(details.toolCallId);
			if (call?.run.restored && call.run === run) call.git = details;
			return;
		}
		// The evidence sits right after its run's final answer, so the walk's
		// current run is the one it describes.
		if (
			customType === STATS_MESSAGE_TYPE &&
			isRunStatsEvidence(details) &&
			run &&
			!this.#runs.has(details.runId)
		)
			this.#runs.set(details.runId, run);
	}

	#strayRun(): RunRecord {
		if (this.#stray) return this.#stray;
		const run = this.#newRun(
			newRunId("omp-compact-replay-"),
			this.#options.restoredMode(),
			true,
		);
		this.finalizeRun(run, "full");
		this.#stray = run;
		return run;
	}

	#newRun(id: string, mode: RunModeSnapshot, restored: boolean): RunRecord {
		const paths = this.#options.displayPaths();
		const run: RunRecord = {
			id,
			mode,
			paths: { cwd: paths.cwd, enabled: paths.enabled },
			calls: [],
			phase: "working",
			revealed: false,
			restored,
			startedAt: this.#now(),
			leaves: [],
		};
		this.#runs.set(id, run);
		return run;
	}

	#addCall(run: RunRecord, id: string, toolName: string): CallRecord {
		const call: CallRecord = { id, toolName, run, mutations: [] };
		run.calls.push(call);
		this.#calls.set(id, call);
		return call;
	}
}
