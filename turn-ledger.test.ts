import { describe, expect, test } from "bun:test";

import { classifyAgentEnd, type LedgerEntry, TurnLedger } from "./turn-ledger";

const assistant = (text: string, stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason,
});

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
	return {
		id: overrides.id ?? "entry-1",
		toolCallId: overrides.toolCallId ?? "call-1",
		toolName: overrides.toolName ?? "bash",
		state: overrides.state ?? "success",
		retention: overrides.retention ?? "discard",
		mutation: overrides.mutation,
		git: overrides.git,
	};
}

describe("TurnLedger terminal classification", () => {
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

describe("TurnLedger retention", () => {
	test("keeps mutations and Git rows in original order", () => {
		const ledger = new TurnLedger("run-1");
		ledger.record(entry({ id: "read", toolCallId: "r", toolName: "read" }));
		ledger.record(
			entry({
				id: "write",
				toolCallId: "w",
				toolName: "write",
				retention: "mutation",
				mutation: { added: 2, removed: 0, exact: true },
			}),
		);
		ledger.record(
			entry({
				id: "git",
				toolCallId: "g",
				toolName: "bash",
				retention: "git",
				git: { text: "git commit abc123 Subject", isError: false },
			}),
		);
		ledger.record(
			entry({
				id: "noop",
				toolCallId: "n",
				toolName: "edit",
				retention: "mutation",
				mutation: { added: 0, removed: 0, exact: true },
			}),
		);

		const result = ledger.finalize({
			messages: [assistant("done")],
			willContinue: false,
		});

		expect(result.mode).toBe("filtered");
		expect(result.entries.map((item) => item.id)).toEqual(["write", "git"]);
		expect(ledger.phase).toBe("filtered");
	});

	describe("TurnLedger runtime modes", () => {
		const terminal = { messages: [assistant("done")], willContinue: false };

		test("compact terminal finalization keeps the entire compact tool log", () => {
			const ledger = new TurnLedger("run-compact");
			ledger.record(entry({ id: "read", toolCallId: "r", toolName: "read" }));
			ledger.record(
				entry({
					id: "write",
					toolCallId: "w",
					toolName: "write",
					retention: "mutation",
					mutation: { added: 2, removed: 0, exact: true },
				}),
			);
			ledger.record(
				entry({
					id: "git",
					toolCallId: "g",
					toolName: "bash",
					retention: "git",
					git: { text: "git status --short", isError: false },
				}),
			);

			const result = ledger.finalize(terminal, "compact");

			expect(result.mode).toBe("full");
			expect(result.entries.map((item) => item.id)).toEqual([
				"read",
				"write",
				"git",
			]);
			expect(ledger.phase).toBe("full");
		});

		test("compact continuation stays working", () => {
			const ledger = new TurnLedger("run-compact-continue");
			ledger.record(entry({ id: "bash" }));
			const result = ledger.finalize(
				{ messages: [assistant("work", "toolUse")], willContinue: false },
				"compact",
			);
			expect(result.mode).toBe("working");
			expect(ledger.phase).toBe("working");
		});

		test("live and clear share the filtered terminal retention", () => {
			for (const mode of ["live", "clear"] as const) {
				const ledger = new TurnLedger(`run-${mode}`);
				ledger.record(entry({ id: "read", toolCallId: "r", toolName: "read" }));
				ledger.record(
					entry({
						id: "write",
						toolCallId: "w",
						toolName: "write",
						retention: "mutation",
						mutation: { added: 1, removed: 0, exact: true },
					}),
				);
				const result = ledger.finalize(terminal, mode);
				expect(result.mode).toBe("filtered");
				expect(result.entries.map((item) => item.id)).toEqual(["write"]);
			}
		});

		test("abort stays full in every mode", () => {
			for (const mode of ["compact", "live", "clear"] as const) {
				const ledger = new TurnLedger(`run-abort-${mode}`);
				ledger.record(entry({ id: "bash" }));
				const result = ledger.finalize(
					{ messages: [assistant("", "aborted")], willContinue: false },
					mode,
				);
				expect(result.mode).toBe("full");
				expect(result.entries.map((item) => item.id)).toEqual(["bash"]);
			}
		});

		test("no mode argument keeps the live contract", () => {
			const ledger = new TurnLedger("run-default");
			ledger.record(entry({ id: "read", toolCallId: "r", toolName: "read" }));
			ledger.record(
				entry({
					id: "write",
					toolCallId: "w",
					toolName: "write",
					retention: "mutation",
					mutation: { added: 1, removed: 0, exact: true },
				}),
			);
			const result = ledger.finalize(terminal);
			expect(result.mode).toBe("filtered");
			expect(result.entries.map((item) => item.id)).toEqual(["write"]);
		});
	});

	test("finalization is idempotent and keeps a full abort log", () => {
		const ledger = new TurnLedger("run-2");
		ledger.record(entry({ id: "bash" }));
		const event = { messages: [assistant("", "aborted")], willContinue: false };
		expect(ledger.finalize(event).entries.map((item) => item.id)).toEqual([
			"bash",
		]);
		expect(ledger.finalize(event).entries.map((item) => item.id)).toEqual([
			"bash",
		]);
		expect(ledger.phase).toBe("full");
	});
});
