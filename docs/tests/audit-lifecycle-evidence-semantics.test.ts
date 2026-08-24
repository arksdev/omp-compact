import { describe, expect, test } from "bun:test";
import type { MutationCandidate } from "../../.omp-plugin/audit";
import { AuditLifecycle } from "../../.omp-plugin/audit-lifecycle";
import type { MutationMessageDetails } from "../../.omp-plugin/messages";

/**
 * The `BarrierOutcome` contract, pinned at the drain boundaries that the main
 * lifecycle suite leaves unasserted:
 *
 * - `evidenceReady` is an "evidence not lost" flag: a record that is only
 *   deferred (still pending at a continuation) is not abandoned, so the
 *   drain settles with `evidenceReady: true` and the record stays registered
 *   for a late `tool_execution_end`.
 * - A failed pre-image capture (capture-failed, warn-once) settles the record
 *   without publishing; it is not an abandonment, so a terminal drain still
 *   reports `evidenceReady: true` — the row is final (evidence will never
 *   arrive), the shake cannot race it.
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
	clock: ManualClock;
}

function harness(options?: { captureError?: Error }): Harness {
	const clock = new ManualClock();
	const captures: Array<Deferred<MutationCandidate | undefined>> = [];
	const completes: Array<Deferred<MutationMessageDetails[]>> = [];
	const published: MutationMessageDetails[][] = [];
	const life = new AuditLifecycle({
		capture: () => {
			if (options?.captureError) {
				return Promise.reject(options.captureError);
			}
			const pending = deferred<MutationCandidate | undefined>();
			captures.push(pending);
			return pending.promise;
		},
		complete: (candidate) => {
			// The real completeWriteCandidate returns no evidence without a
			// captured candidate (capture-failed, no-op write).
			if (!candidate) return Promise.resolve([]);
			const pending = deferred<MutationMessageDetails[]>();
			completes.push(pending);
			return pending.promise;
		},
		barrierMs: 5_000,
		now: clock.now,
		sleep: clock.sleep,
		warn: () => {},
	});
	return { life, captures, completes, published, clock };
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

describe("BarrierOutcome contract at the deferred and failed boundaries", () => {
	test("a continuation drain reports evidenceReady:true for a still-pending record and leaves it for a late end", async () => {
		const h = harness();
		h.life.startWrite(writeStart("w1"));
		const runIds = h.life.snapshot();

		// The pending record is not part of a continuation drain: it is
		// neither completed nor abandoned, and its evidence is deferred.
		await expect(h.life.barrier(runIds, false)).resolves.toEqual({
			settled: true,
			evidenceReady: true,
		});
		// The record stays registered for the late tool_execution_end.
		expect(h.life.snapshot().size).toBe(1);

		// Stock can deliver tool_execution_end after agent_end(willContinue).
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		h.captures[0]?.resolve(candidate("w1"));
		await flush();
		h.completes[0]?.resolve([evidence("w1")]);
		await flush();

		expect(h.published).toEqual([[evidence("w1")]]);
		expect(h.life.snapshot().size).toBe(0);
	});

	test("a failed capture drains evidenceReady:true: the record settled without evidence, nothing is lost or pending", async () => {
		const h = harness({ captureError: new Error("EIO nfs stale") });
		h.life.startWrite(writeStart("w1"));
		h.life.endWrite(writeEnd("w1"), (mutations) => h.published.push(mutations));
		await flush();

		// Fail-closed: nothing published, the record completed without
		// evidence, and no abandonment means the terminal drain reports the
		// run's evidence ready (a shake cannot race a row that is final).
		expect(h.published).toEqual([]);
		expect(h.completes).toHaveLength(0);
		await expect(h.life.barrier(h.life.snapshot(), true)).resolves.toEqual({
			settled: true,
			evidenceReady: true,
		});
		expect(h.life.snapshot().size).toBe(0);
	});
});
