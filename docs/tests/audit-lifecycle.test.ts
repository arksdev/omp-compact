import { describe, expect, test } from "bun:test";
import type { MutationCandidate } from "../../.omp-plugin/audit";
import { AuditLifecycle } from "../../.omp-plugin/audit-lifecycle";
import type { MutationMessageDetails } from "../../.omp-plugin/messages";

/**
 * Deterministic contracts for the plugin audit lifecycle under stock OMP's
 * fire-and-forget extension event delivery: `tool_execution_start`,
 * `tool_execution_end`, and `agent_end` listeners are invoked without awaiting
 * their returned promises, so consecutive handlers can overlap. Every test
 * below models that overlap with controlled deferreds and a manual clock —
 * no timing sleeps.
 */

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Drain all pending microtasks (deterministic; no timers involved). */
async function flush(): Promise<void> {
	for (let i = 0; i < 24; i++) await Promise.resolve();
}

/** Injectable clock: time only moves when the test calls advance(). */
class ManualClock {
	time = 0;
	#waiters: Array<() => void> = [];
	now = (): number => this.time;
	sleep = (_ms: number): Promise<void> =>
		new Promise<void>((resolve) => {
			this.#waiters.push(resolve);
		});
	advance(ms: number): void {
		this.time += ms;
		const waiters = this.#waiters.splice(0);
		for (const waiter of waiters) waiter();
	}
}

interface Harness {
	life: AuditLifecycle;
	captures: Array<Deferred<MutationCandidate | undefined>>;
	completes: Array<Deferred<MutationMessageDetails[]>>;
	published: MutationMessageDetails[][];
	completedWith: Array<MutationCandidate | undefined>;
	clock: ManualClock;
}

function harness(): Harness {
	const clock = new ManualClock();
	const captures: Array<Deferred<MutationCandidate | undefined>> = [];
	const completes: Array<Deferred<MutationMessageDetails[]>> = [];
	const published: MutationMessageDetails[][] = [];
	const completedWith: Array<MutationCandidate | undefined> = [];
	const life = new AuditLifecycle({
		capture: () => {
			const pending = deferred<MutationCandidate | undefined>();
			captures.push(pending);
			return pending.promise;
		},
		complete: (candidate, _result, _isError) => {
			completedWith.push(candidate);
			// The real completeWriteCandidate returns no evidence without a
			// captured candidate (no-op write, unsupported target, error).
			if (!candidate) return Promise.resolve([]);
			const pending = deferred<MutationMessageDetails[]>();
			completes.push(pending);
			return pending.promise;
		},
		barrierMs: 5_000,
		now: clock.now,
		sleep: clock.sleep,
	});
	return { life, captures, completes, published, completedWith, clock };
}

function candidate(id: string): MutationCandidate {
	return {
		toolCallId: id,
		toolName: "write",
		displayPath: `/tmp/${id}.ts`,
		absolutePath: `/tmp/${id}.ts`,
		canonicalPath: `/tmp/${id}.ts`,
		before: "",
	};
}

function evidence(id: string): MutationMessageDetails {
	return {
		version: 1,
		toolCallId: id,
		toolName: "write",
		path: `/tmp/${id}.ts`,
		added: 3,
		removed: 0,
		exact: true,
	};
}

function writeStart(id: string): {
	toolCallId: string;
	args: unknown;
	cwd: string;
} {
	return {
		toolCallId: id,
		args: { path: `/tmp/${id}.ts`, content: "line\nline\nline" },
		cwd: "/tmp",
	};
}

function writeEnd(id: string): {
	toolCallId: string;
	result: unknown;
	isError: boolean;
} {
	return {
		toolCallId: id,
		result: { content: [], details: { resolvedPath: `/tmp/${id}.ts` } },
		isError: false,
	};
}

describe("synchronous write-audit registration", () => {
	test("end arriving before the capture settles still publishes exact evidence once", async () => {
		const h = harness();
		// Stock invokes the start listener without awaiting it; the capture is
		// still in flight when tool_execution_end arrives.
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));

		h.captures[0]?.resolve(candidate("w1"));
		await flush();
		h.completes[0]?.resolve([evidence("w1")]);
		await flush();

		expect(h.published).toEqual([[evidence("w1")]]);
		expect(h.published[0]?.[0]?.toolCallId).toBe("w1");
	});

	test("publish releases the pre-image after exact evidence is emitted", async () => {
		const h = harness();
		const held = candidate("w1");
		held.before = "pre-image payload that must not linger\n".repeat(8);
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.captures[0]?.resolve(held);
		await flush();
		// complete is still deferred: pre-image must remain for the diff.
		expect(held.before.length).toBeGreaterThan(0);
		h.completes[0]?.resolve([evidence("w1")]);
		await flush();
		expect(h.published).toEqual([[evidence("w1")]]);
		expect(held.before).toBe("");
	});

	test("discard releases a settled pre-image without publishing", async () => {
		const h = harness();
		const held = candidate("w1");
		held.before = "abandoned pre-image\n";
		h.life.startWrite(writeStart("w1"));
		h.captures[0]?.resolve(held);
		await flush();
		expect(held.before).toBe("abandoned pre-image\n");
		h.life.discard("w1");
		await flush();
		expect(held.before).toBe("");
		expect(h.published).toEqual([]);
	});

	test("supersede releases the outer pre-image and never publishes it", async () => {
		const h = harness();
		const outer = candidate("w1-old");
		outer.before = "outer pre-image\n";
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		// Outer completion suspended on capture; replacement abandons it.
		h.life.startWrite(writeStart("w1"));
		h.captures[0]?.resolve(outer);
		await flush();
		expect(h.completes).toHaveLength(0);
		expect(h.published).toEqual([]);
		expect(outer.before).toBe("");
	});

	test("a duplicate tool_execution_end publishes at most once", async () => {
		const h = harness();
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));

		h.captures[0]?.resolve(candidate("w1"));
		await flush();
		h.completes[0]?.resolve([evidence("w1")]);
		await flush();

		expect(h.published).toHaveLength(1);
		expect(h.published[0]).toEqual([evidence("w1")]);
	});

	test("a second startWrite for the same toolCallId publishes only the successor", async () => {
		// Nested xd:// device dispatch reuses the model's toolCallId while the
		// outer completion is still in flight. Exactly-once: register abandons
		// the superseded record so its later settle cannot emit evidence.
		const h = harness();
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		// Outer completion is suspended on capture when the replacement arrives.
		h.life.startWrite(writeStart("w1"));

		// Superseded capture settles — must not reach complete/publish.
		h.captures[0]?.resolve(candidate("w1-old"));
		await flush();
		expect(h.completes).toHaveLength(0);
		expect(h.published).toEqual([]);

		// Successor end + capture + complete publishes exactly once.
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.captures[1]?.resolve(candidate("w1"));
		await flush();
		h.completes[0]?.resolve([evidence("w1")]);
		await flush();

		expect(h.published).toEqual([[evidence("w1")]]);
		expect(h.published).toHaveLength(1);
		// Only the successor reached the post-image audit.
		expect(h.completedWith).toEqual([candidate("w1")]);
	});

	test("concurrent writes each publish their own evidence exactly once", async () => {
		const h = harness();
		h.life.startWrite(writeStart("w1"));
		h.life.startWrite(writeStart("w2"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.life.endWrite(writeEnd("w2"), (mutations) => h.published.push(mutations));

		h.captures[0]?.resolve(candidate("w1"));
		await flush();
		h.completes[0]?.resolve([evidence("w1")]);
		await flush();
		h.captures[1]?.resolve(candidate("w2"));
		await flush();
		h.completes[1]?.resolve([evidence("w2")]);
		await flush();

		expect(h.published).toEqual([[evidence("w1")], [evidence("w2")]]);
		expect(h.published[0]?.[0]?.toolCallId).toBe("w1");
		expect(h.published[1]?.[0]?.toolCallId).toBe("w2");
	});

	test("endWrite for an unknown tool call id is a safe no-op", async () => {
		const h = harness();
		h.life.endWrite(writeEnd("ghost"), (mutations) =>
			h.published.push(mutations),
		);
		await flush();
		expect(h.published).toEqual([]);
		expect(h.captures).toHaveLength(0);
		expect(await h.life.barrier(h.life.snapshot())).toEqual({
			settled: true,
			evidenceReady: true,
		});
	});
});

describe("agent_end drain", () => {
	test("barrier defers run finalization until the evidence is published", async () => {
		const h = harness();
		const order: string[] = [];
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => {
			order.push("publish");
			h.published.push(mutations);
		});

		const runIds = h.life.snapshot();
		const barrier = h.life.barrier(runIds, true);
		void barrier.then(() => order.push("barrier"));
		await flush();
		expect(order).toEqual([]);

		h.captures[0]?.resolve(candidate("w1"));
		await flush();
		h.completes[0]?.resolve([evidence("w1")]);
		await flush();
		await barrier;

		expect(order).toEqual(["publish", "barrier"]);
		expect(h.published).toEqual([[evidence("w1")]]);
		// Every record completed: the drain settled with evidence ready.
		expect(await barrier).toEqual({ settled: true, evidenceReady: true });
	});

	test("continuation drain leaves a pending write for a late end", async () => {
		const h = harness();
		h.life.startWrite(writeStart("w1"));
		const runIds = h.life.snapshot();
		let settled = false;
		const barrier = h.life.barrier(runIds, false);
		void barrier.then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(true);
		await barrier;

		// Stock can deliver tool_execution_end after agent_end(willContinue).
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.captures[0]?.resolve(candidate("w1"));
		await flush();
		h.completes[0]?.resolve([evidence("w1")]);
		await flush();
		expect(h.published).toEqual([[evidence("w1")]]);
	});
	test("continuation drain leaves pending Git records for a late end", async () => {
		const h = harness();
		h.life.startSync("git-late", { command: "git status --short" });
		const runIds = h.life.snapshot();
		let settled = false;
		const barrier = h.life.barrier(runIds, false);
		void barrier.then(() => {
			settled = true;
		});
		await flush();
		try {
			expect(settled).toBe(true);
		} finally {
			// Keep the red test bounded against the current abandonment behavior.
			h.clock.advance(5_000);
			await barrier;
		}

		h.life.endSync("git-late", () => h.published.push([evidence("git-late")]));
		await flush();
		expect(h.published).toEqual([[evidence("git-late")]]);
	});

	test("completion settling after the drain bound publishes nothing", async () => {
		const h = harness();
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.captures[0]?.resolve(candidate("w1"));
		await flush();

		const runIds = h.life.snapshot();
		const barrier = h.life.barrier(runIds, false);
		await flush();
		h.clock.advance(5_000);
		await flush();
		expect(await barrier).toEqual({ settled: false, evidenceReady: false });

		// The audit completes late: evidence is dropped, never appended after
		// the run was already finalized.
		h.completes[0]?.resolve([evidence("w1")]);
		await flush();
		expect(h.published).toEqual([]);
	});

	test("the drain ignores audit work started after its snapshot", async () => {
		const h = harness();
		h.life.startWrite(writeStart("old"));
		const runIds = h.life.snapshot(); // terminal drain scope

		// A continuation run starts new work while the previous drain is still
		// pending; it must neither block nor be blocked by the old snapshot.
		h.life.startWrite(writeStart("new"));
		h.life.endWrite(writeEnd("old"), (mutations) =>
			h.published.push(mutations),
		);
		h.life.endWrite(writeEnd("new"), (mutations) =>
			h.published.push(mutations),
		);

		h.captures[0]?.resolve(candidate("old"));
		await flush();
		h.completes[0]?.resolve([evidence("old")]);
		await flush();
		expect(h.published).toEqual([[evidence("old")]]);

		// The old-run drain resolves without waiting for the continuation
		// run's still-in-flight completion.
		let drained = false;
		const barrier = h.life.barrier(runIds, true);
		void barrier.then(() => {
			drained = true;
		});
		await flush();
		expect(drained).toBe(true);
		await barrier;

		h.captures[1]?.resolve(candidate("new"));
		await flush();
		h.completes[1]?.resolve([evidence("new")]);
		await flush();
		expect(h.published).toEqual([[evidence("old")], [evidence("new")]]);
	});

	test("dispose abandons in-flight work, unblocks the drain, and stays reusable", async () => {
		const h = harness();
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.captures[0]?.resolve(candidate("w1"));
		await flush();

		const runIds = h.life.snapshot();
		const barrier = h.life.barrier(runIds, true);
		await flush();
		h.life.dispose();
		await flush();
		expect(await barrier).toEqual({ settled: true, evidenceReady: false });
		h.life.dispose(); // idempotent

		// The abandoned audit settles without publishing.
		h.completes[0]?.resolve([evidence("w1")]);
		await flush();
		expect(h.published).toEqual([]);

		// A fresh session's audit still flows after dispose.
		h.life.startWrite(writeStart("fresh"));
		h.life.endWrite(writeEnd("fresh"), (mutations) =>
			h.published.push(mutations),
		);
		h.captures[1]?.resolve(candidate("fresh"));
		await flush();
		h.completes[1]?.resolve([evidence("fresh")]);
		await flush();
		expect(h.published).toEqual([[evidence("fresh")]]);
	});

	test("a no-op write drains without publishing", async () => {
		const h = harness();
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.captures[0]?.resolve(candidate("w1"));
		await flush();
		h.completes[0]?.resolve([]);
		await flush();

		expect(h.published).toEqual([]);
		expect(await h.life.barrier(h.life.snapshot(), true)).toEqual({
			settled: true,
			evidenceReady: true,
		});
	});

	test("a terminal commit purges started-but-unended records; a late end publishes nothing", async () => {
		const h = harness();
		const late: string[] = [];
		h.life.startWrite(writeStart("w1")); // capture in flight, end never fired before the commit
		h.life.startSync("b1", { command: "git push origin main" });

		const runIds = h.life.snapshot();
		let settled = false;
		const barrier = h.life.barrier(runIds, true);
		void barrier.then(() => {
			settled = true;
		});
		await flush();
		// The terminal drain does not wait for unended records.
		expect(settled).toBe(true);
		await barrier;
		// The purge abandoned the pending records: the drain settled so the
		// adapter's end-run finalization may run, but the evidence is not
		// ready and the run must not shake.
		expect(await barrier).toEqual({ settled: true, evidenceReady: false });

		// Late ends after the committed transcript: fail closed, no evidence.
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.life.endSync("b1", () => late.push("git"));
		await flush();
		expect(h.published).toEqual([]);
		expect(late).toEqual([]);
		expect(h.completedWith).toEqual([]);

		// The purged records do not block a later run's drain.
		let drained = false;
		const laterBarrier = h.life.barrier(h.life.snapshot(), true);
		void laterBarrier.then(() => {
			drained = true;
		});
		await flush();
		expect(drained).toBe(true);
		expect(await laterBarrier).toEqual({ settled: true, evidenceReady: true });
	});

	test("a terminal purge settles the drain for finalization but reports evidence not ready", async () => {
		const h = harness();
		h.life.startWrite(writeStart("w1")); // pending: end never arrives before the commit
		const runIds = h.life.snapshot();
		const order: string[] = [];
		// The enqueued link carries the adapter's end-run finalization, which
		// must still run after a terminal purge…
		const link = h.life.enqueueAgentEnd(runIds, true, () =>
			order.push("finalize"),
		);
		await flush();
		expect(order).toEqual(["finalize"]);
		// …but the run's evidence was purged, so the link must not report
		// evidence-ready and the post-run auto-shake must be skipped.
		expect(await link).toBe(false);
	});

	test("a terminal purge with an in-flight completion waits for the evidence and reports it ready", async () => {
		const h = harness();
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		const runIds = h.life.snapshot();
		const barrier = h.life.barrier(runIds, true);
		await flush();
		// The purge only removes *pending* records; the in-flight completion
		// is still awaited, so its evidence lands before the drain settles.
		h.captures[0]?.resolve(candidate("w1"));
		await flush();
		h.completes[0]?.resolve([evidence("w1")]);
		await flush();
		expect(h.published).toEqual([[evidence("w1")]]);
		expect(await barrier).toEqual({ settled: true, evidenceReady: true });
	});
});

function gitCommand(payload: unknown): string {
	if (payload && typeof payload === "object" && "command" in payload) {
		const command = payload.command; // unknown after `in` narrowing
		if (typeof command === "string") return command;
	}
	return "?";
}

describe("synchronous Git bookkeeping", () => {
	test("sync completion runs exactly once when a continuation end is late", async () => {
		const h = harness();
		const order: string[] = [];
		h.life.startSync("b1", { command: "git commit abc123 Fix" });
		h.life.endSync("b1", (payload) => order.push(`git:${gitCommand(payload)}`));
		h.life.endSync("b1", () => order.push("git-dup"));
		expect(order).toEqual(["git:git commit abc123 Fix"]);
		expect(order).not.toContain("git-dup");

		h.life.startSync("b2", { command: "git push origin main" });
		const runIds = h.life.snapshot();
		let settled = false;
		const barrier = h.life.barrier(runIds, false);
		void barrier.then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(true);
		await barrier;

		h.life.endSync("b2", () => order.push("git:git push origin main"));
		await flush();
		expect(order).toEqual([
			"git:git commit abc123 Fix",
			"git:git push origin main",
		]);
	});
});

describe("agent_end serial chain", () => {
	test("links run strictly in emission order after their drain", async () => {
		const h = harness();
		const order: string[] = [];
		h.life.startWrite(writeStart("w1"));
		const first = h.life.enqueueAgentEnd(h.life.snapshot(), false, () =>
			order.push("finalize-1"),
		);
		const second = h.life.enqueueAgentEnd(new Set(), true, () =>
			order.push("finalize-2"),
		);
		await first;
		await second;
		// Continuation finalization does not wait for an unended tool; the
		// second link still remains serialized behind the first.
		expect(order).toEqual(["finalize-1", "finalize-2"]);
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.captures[0].resolve(candidate("w1"));
		await flush();
		h.completes[0].resolve([evidence("w1")]);
		await flush();
		expect(order).toEqual(["finalize-1", "finalize-2"]);
		expect(await first).toBe(true);
		expect(await second).toBe(true);
	});

	test("dispose invalidates queued links: skipped before drain, no chain delay, next session unaffected", async () => {
		const h = harness();
		const order: string[] = [];
		// Old session: enqueue before the first microtask so generation invalidation
		// can skip the stale link before it finalizes.
		h.life.startWrite(writeStart("w1"));
		const stale = h.life.enqueueAgentEnd(h.life.snapshot(), false, () =>
			order.push("old-finalize"),
		);
		// Session switch/shutdown lands while the link is still queued.
		h.life.dispose();
		// New session: a fresh run enqueues after the stale link.
		const fresh = h.life.enqueueAgentEnd(h.life.snapshot(), true, () =>
			order.push("new-finalize"),
		);
		await flush();
		// The stale link short-circuits before its barrier (which would have
		// blocked on w1's never-settling capture), so the new session's link
		// runs without any clock advancement.
		expect(order).toEqual(["new-finalize"]);
		expect(await stale).toBe(false);
		expect(await fresh).toBe(true);
		expect(h.published).toEqual([]);
	});

	test("a switch landing mid-drain prevents the old run's finalization", async () => {
		const h = harness();
		const order: string[] = [];
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		const runIds = h.life.snapshot();
		let drained = false;
		const link = h.life.enqueueAgentEnd(runIds, true, () =>
			order.push("old-finalize"),
		);
		void link.then(() => {
			drained = true;
		});
		await flush();
		// The drain is blocked on w1's completion; the switch lands mid-drain.
		expect(drained).toBe(false);
		h.life.dispose();
		await flush();
		// Dispose abandons the records, the drain settles, but the generation
		// re-check drops the finalization.
		expect(drained).toBe(true);
		expect(order).toEqual([]);
		expect(await link).toBe(false);
		expect(h.published).toEqual([]);
	});

	test("a throwing finalization fails closed and does not stall the chain", async () => {
		const h = harness();
		const order: string[] = [];
		const first = h.life.enqueueAgentEnd(h.life.snapshot(), true, () => {
			throw new Error("endRun boom");
		});
		const second = h.life.enqueueAgentEnd(h.life.snapshot(), true, () =>
			order.push("after-boom"),
		);
		await flush();
		expect(await first).toBe(false);
		expect(await second).toBe(true);
		expect(order).toEqual(["after-boom"]);
	});

	test("a terminal drain timeout fails closed inside the chain", async () => {
		const h = harness();
		const order: string[] = [];
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		const link = h.life.enqueueAgentEnd(h.life.snapshot(), true, () =>
			order.push("finalize"),
		);
		await flush();
		h.clock.advance(5_000); // barrier bound expires for in-flight audit
		await flush();
		expect(await link).toBe(false);
		expect(order).toEqual([]);
		// The abandoned completion cannot publish later.
		h.captures[0]?.resolve(candidate("w1"));
		await flush();
		expect(h.published).toEqual([]);
		// The chain still serves the next run.
		const next = h.life.enqueueAgentEnd(h.life.snapshot(), true, () =>
			order.push("next-finalize"),
		);
		await flush();
		expect(await next).toBe(true);
		expect(order).toEqual(["next-finalize"]);
	});

	test("a same-id replacement abandons the superseded completion and never redirects the old drain", async () => {
		const h = harness();
		// Outer dispatch: record registered, end arrives, completion in
		// flight. The snapshot token pins the drain to this exact record.
		h.life.startWrite(writeStart("w1"));
		const runTokens = h.life.snapshot();
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		// Nested xd:// device dispatch reuses the model's toolCallId: the
		// inner start replaces the map entries while the outer completion is
		// still in flight. Exactly-once per toolCallId: the superseded
		// completion must never publish.
		h.life.startWrite(writeStart("w1"));
		h.captures[0].resolve(candidate("w1"));
		await flush();
		expect(h.completes).toEqual([]); // post-image audit never ran
		expect(h.published).toEqual([]);
		// The old terminal drain settles (nothing left to await) and does
		// not touch the successor record; the superseded record was
		// abandoned, so the evidence is not ready.
		const barrier = h.life.barrier(runTokens, true);
		await flush();
		expect(await barrier).toEqual({ settled: true, evidenceReady: false });
		// The successor's end publishes exactly once.
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.captures[1].resolve(candidate("w1"));
		await flush();
		// Only the successor reached the post-image audit: the harness's
		// `completes` list is indexed by invocation order, and the superseded
		// completion never invoked it.
		h.completes[0].resolve([evidence("w1")]);
		await flush();
		expect(h.published).toEqual([[evidence("w1")]]);
	});

	test("dispose reaches a replaced record's in-flight completion (no late publish)", async () => {
		const h = harness();
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.life.startWrite(writeStart("w1")); // replaced: old completion in flight
		h.life.dispose(); // teardown while both records exist
		h.captures[0].resolve(candidate("w1"));
		await flush();
		expect(h.completes).toEqual([]);
		expect(h.published).toEqual([]);
		// A late end after teardown finds nothing to consume.
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		await flush();
		expect(h.published).toEqual([]);
	});
});
