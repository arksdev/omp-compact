import type { CompactMode } from "./config";

export type LedgerPhase = "working" | "filtered" | "full";

export type LedgerEntryState =
	| "success"
	| "error"
	| "aborted"
	| "pending"
	| "running";

export type LedgerRetention = "discard" | "mutation" | "git";

export interface MutationRecord {
	added?: number;
	removed?: number;
	exact?: boolean;
}

export interface GitRecord {
	text: string;
	isError: boolean;
}

export interface LedgerEntry {
	id: string;
	toolCallId: string;
	toolName: string;
	state: LedgerEntryState;
	retention: LedgerRetention;
	mutation?: MutationRecord;
	git?: GitRecord;
}

export interface AgentEndEvent {
	messages?: readonly unknown[];
	willContinue?: boolean;
}

export interface TurnLedgerResult {
	mode: LedgerPhase;
	entries: readonly LedgerEntry[];
}

interface AssistantMessageLike {
	role?: unknown;
	content?: unknown;
	stopReason?: unknown;
}

interface ContentBlockLike {
	type?: unknown;
	text?: unknown;
}

const EMPTY_ENTRIES: readonly LedgerEntry[] = [];
const NON_BLANK = /\S/;

/**
 * `agent_end` is authoritative only once the agent will not continue. A
 * truncated response is still visible to the user, while tool, error, and
 * aborted messages leave the live transcript intact for diagnosis.
 */
export function classifyAgentEnd(
	event: AgentEndEvent | undefined,
): LedgerPhase {
	if (event?.willContinue === true) return "working";

	const messages = event?.messages;
	if (!Array.isArray(messages) || messages.length === 0) return "full";

	const candidate = messages[messages.length - 1];
	if (!candidate || typeof candidate !== "object") return "full";
	const message = candidate as AssistantMessageLike;
	if (message.role !== "assistant") return "full";
	if (message.stopReason === "toolUse") return "working";
	if (message.stopReason !== "stop" && message.stopReason !== "length")
		return "full";
	if (!Array.isArray(message.content)) return "full";

	let hasVisibleText = false;
	for (const value of message.content) {
		if (!value || typeof value !== "object") continue;
		const block = value as ContentBlockLike;
		// A provider may report `stop` alongside a tool call. It is not proof
		// that the visible text is a completed answer, so keep the complete log.
		if (block.type === "toolCall") return "full";
		if (
			block.type === "text" &&
			typeof block.text === "string" &&
			NON_BLANK.test(block.text)
		)
			hasVisibleText = true;
	}

	return hasVisibleText ? "filtered" : "full";
}

function isExactNonZeroMutation(entry: LedgerEntry): boolean {
	const mutation = entry.mutation;
	return (
		entry.state === "success" &&
		mutation?.exact === true &&
		((typeof mutation.added === "number" &&
			Number.isFinite(mutation.added) &&
			mutation.added > 0) ||
			(typeof mutation.removed === "number" &&
				Number.isFinite(mutation.removed) &&
				mutation.removed > 0))
	);
}

function retainedEntries(
	entries: readonly LedgerEntry[],
): readonly LedgerEntry[] {
	let retained: LedgerEntry[] | undefined;
	for (const entry of entries) {
		if (
			entry.retention !== "git" &&
			(entry.retention !== "mutation" || !isExactNonZeroMutation(entry))
		)
			continue;
		if (!retained) retained = [];
		retained.push(entry);
	}
	return retained ?? EMPTY_ENTRIES;
}

function cloneEntry(entry: LedgerEntry): LedgerEntry {
	return {
		...entry,
		mutation: entry.mutation ? { ...entry.mutation } : undefined,
		git: entry.git ? { ...entry.git } : undefined,
	};
}

/**
 * Keeps the current run mutable until a terminal `agent_end`; then caches the
 * exact committed view so later events cannot rewrite completed history.
 */
export class TurnLedger {
	readonly runId: string;

	#entries: LedgerEntry[] = [];
	#phase: LedgerPhase = "working";
	#workingResult: TurnLedgerResult;
	#finalResult: TurnLedgerResult | undefined;

	constructor(runId: string) {
		this.runId = runId;
		this.#workingResult = { mode: "working", entries: this.#entries };
	}

	get phase(): LedgerPhase {
		return this.#phase;
	}

	get entries(): readonly LedgerEntry[] {
		return this.#entries;
	}

	record(entry: LedgerEntry): void {
		if (this.#phase !== "working") return;
		this.#entries.push(entry);
	}

	/**
	 * Drop a superseded entry while the run is still mutable. Used by the
	 * provisional → real toolCallId migration so one component keeps exactly
	 * one ledger row; no-op once the ledger is finalized.
	 */
	removeEntry(entry: LedgerEntry): void {
		if (this.#phase !== "working") return;
		const index = this.#entries.indexOf(entry);
		if (index >= 0) this.#entries.splice(index, 1);
	}

	/**
	 * Finalize the run. `mode` is the runtime-mode snapshot captured at the
	 * logical-run start: `compact` keeps the entire compact tool log at a
	 * terminal finalization (the run settles with every entry retained,
	 * exactly the phase stock already uses for abort/error diagnostics), while
	 * `live` and `clear` share the stock filtered retention — `clear` hides
	 * rows at the rendering layer, never in the ledger or persisted evidence.
	 */
	finalize(
		event: AgentEndEvent | undefined,
		mode: CompactMode = "live",
	): TurnLedgerResult {
		if (this.#finalResult) return this.#finalResult;

		const classified = classifyAgentEnd(event);
		if (classified === "working") return this.#workingResult;

		const snapshot = this.#entries.map(cloneEntry);
		const terminalMode: LedgerPhase = mode === "compact" ? "full" : classified;
		const result: TurnLedgerResult = {
			mode: terminalMode,
			entries:
				terminalMode === "filtered" ? retainedEntries(snapshot) : snapshot,
		};
		this.#phase = terminalMode;
		this.#finalResult = result;
		return result;
	}
}
