import { describe, expect, test } from "bun:test";

import { classifyAgentEnd, terminalPhase } from "../../.omp-plugin/turn-ledger";

const assistant = (text: string, stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason,
});

describe("agent_end classification", () => {
	test("does not compact tool-use or automatic continuation ends", () => {
		expect(
			classifyAgentEnd({
				messages: [assistant("working", "toolUse")],
				willContinue: false,
			}),
		).toBe("working");
		expect(
			classifyAgentEnd({
				messages: [assistant("working")],
				willContinue: true,
			}),
		).toBe("working");
	});

	test("filters only at a terminal visible assistant answer", () => {
		expect(
			classifyAgentEnd({
				messages: [assistant("done")],
				willContinue: false,
			}),
		).toBe("filtered");
	});

	test("keeps the complete log when the run aborts without an answer", () => {
		expect(
			classifyAgentEnd({
				messages: [assistant("", "aborted")],
				willContinue: false,
			}),
		).toBe("full");
	});
});

describe("terminal phase by mode", () => {
	test("compact keeps the whole log; live and clear keep the classified phase", () => {
		expect(terminalPhase("filtered", "compact")).toBe("full");
		expect(terminalPhase("full", "compact")).toBe("full");
		expect(terminalPhase("filtered", "live")).toBe("filtered");
		expect(terminalPhase("filtered", "clear")).toBe("filtered");
		expect(terminalPhase("full", "live")).toBe("full");
		expect(terminalPhase("full", "clear")).toBe("full");
	});
});
