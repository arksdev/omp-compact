import type { CompactMode } from "./config";

/**
 * Presentation phase of a logical run: `working` while it runs, `filtered`
 * once it ended with a visible answer (`live`/`clear` keep only evidence),
 * `full` once it ended any other way, or in `compact` mode, which keeps the
 * whole log.
 */
export type LedgerPhase = "working" | "filtered" | "full";

export interface AgentEndEvent {
	messages?: readonly unknown[];
	willContinue?: boolean;
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

/**
 * The phase a run ends in. `compact` keeps the entire log at a terminal
 * finalization (the phase an abort or error gets anyway), while `live` and
 * `clear` share the filtered retention — `clear` hides rows at the
 * presentation layer, never in persisted evidence.
 */
export function terminalPhase(
	classified: Exclude<LedgerPhase, "working">,
	mode: CompactMode,
): Exclude<LedgerPhase, "working"> {
	return mode === "compact" ? "full" : classified;
}
