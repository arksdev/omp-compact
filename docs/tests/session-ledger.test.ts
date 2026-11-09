import { describe, expect, test } from "bun:test";
import type { ToolDisplay } from "../../.omp-plugin/config";
import { DEFAULT_RUN_MODE } from "../../.omp-plugin/mode-policy";
import { SessionLedger } from "../../.omp-plugin/session-ledger";

function ledgerWith(tools: Record<string, ToolDisplay>) {
	const ledger = new SessionLedger({
		restoredMode: () => DEFAULT_RUN_MODE,
		displayPaths: () => ({ cwd: "", enabled: false }),
	});
	const run = ledger.beginRun(() => ({ ...DEFAULT_RUN_MODE, tools }));
	ledger.startCall("b1", "bash", { command: "git commit -m change" });
	ledger.setGit("b1", {
		version: 1,
		toolCallId: "b1",
		subcommand: "commit",
		text: "git commit abc1234 change",
		isError: false,
	});
	ledger.startCall("w1", "write", { path: "a.ts", content: "x" });
	ledger.setMutations("w1", [
		{
			version: 1,
			toolCallId: "w1",
			toolName: "write",
			path: "a.ts",
			added: 1,
			removed: 0,
			exact: true,
		},
	]);
	ledger.finalizeRun(run, "filtered");
	return { ledger, run };
}

describe("Git summary anchor", () => {
	test("the run's last evidence call carries the commit summary", () => {
		const { ledger, run } = ledgerWith({});
		const projection = ledger.projection(run);
		expect(projection?.hashes).toEqual(["abc1234"]);
		expect(projection?.anchor?.id).toBe("w1");
	});

	test("a call shown as omp's full card never anchors it, so the summary survives", () => {
		// The open write card cannot carry the summary row; the commit's own
		// row takes it instead.
		const { ledger, run } = ledgerWith({ write: "open" });
		const projection = ledger.projection(run);
		expect(projection?.hashes).toEqual(["abc1234"]);
		expect(projection?.anchor?.id).toBe("b1");
	});
});
