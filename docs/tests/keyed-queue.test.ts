import { describe, expect, test } from "bun:test";

import { createKeyedQueue } from "../../.omp-plugin/keyed-queue";

/**
 * Direct contract coverage for `createKeyedQueue` (keyed-queue.ts). The two
 * production consumers — the config-path update queue in config.ts and the
 * save-flow queue in save-flow.ts — exercise it only indirectly through
 * settings writes; these tests pin the queue's own contract so a future
 * "simplification" cannot silently break settings persistence:
 *
 * - operations on the same key run strictly in order, each starting only
 *   after the previous one settled (fulfilled or rejected);
 * - operations on different keys are never serialized against each other;
 * - a rejected operation surfaces to its own caller and never poisons the
 *   chain — later operations on that key still run with fresh state;
 * - only the last queued operation removes the map entry (tail identity),
 *   so the queue neither leaks entries nor lets a later operation chain
 *   onto a removed tail.
 *
 * Timing is microtask-only (deferred gates plus a bounded flush), so the
 * suite is deterministic and needs no real timers.
 */
describe("createKeyedQueue", () => {
	test("operations on one key run strictly in order, each starting only after the previous settled", async () => {
		const withKeyedQueue = createKeyedQueue<string>();
		const starts: string[] = [];
		const firstGate = deferred();
		const secondGate = deferred();

		const first = withKeyedQueue("k", async () => {
			starts.push("first");
			await firstGate.promise;
		});
		const second = withKeyedQueue("k", async () => {
			starts.push("second");
			await secondGate.promise;
		});

		await flush();
		expect(starts).toEqual(["first"]);

		firstGate.resolve();
		await flush();
		expect(starts).toEqual(["first", "second"]);

		const third = withKeyedQueue("k", async () => {
			starts.push("third");
		});
		await flush();
		expect(starts).toEqual(["first", "second"]);

		secondGate.resolve();
		await first;
		await second;
		await third;
		expect(starts).toEqual(["first", "second", "third"]);
	});

	test("operations on different keys are not serialized against each other", async () => {
		const withKeyedQueue = createKeyedQueue<string>();
		const starts: string[] = [];
		const gateA = deferred();
		const gateB = deferred();

		const a = withKeyedQueue("a", async () => {
			starts.push("a");
			await gateA.promise;
		});
		const b = withKeyedQueue("b", async () => {
			starts.push("b");
			await gateB.promise;
		});

		await flush();
		// Both start even though neither key's operation has settled.
		expect(starts).toEqual(["a", "b"]);

		gateA.resolve();
		gateB.resolve();
		await a;
		await b;
	});

	test("a rejected operation surfaces to its own caller and does not poison the chain", async () => {
		const withKeyedQueue = createKeyedQueue<string>();
		const starts: string[] = [];
		const gate = deferred();

		const failing = withKeyedQueue("k", async () => {
			starts.push("failing");
			await gate.promise;
			throw new Error("boom");
		});
		const following = withKeyedQueue("k", async () => {
			starts.push("following");
			return 42;
		});

		await flush();
		expect(starts).toEqual(["failing"]);

		gate.reject(new Error("boom"));
		// The rejection belongs to its own caller, not to the chain.
		await expect(failing).rejects.toThrow("boom");
		await flush();
		expect(starts).toEqual(["failing", "following"]);
		expect(await following).toBe(42);

		// A later operation on the same key still gets fresh state.
		const later = withKeyedQueue("k", async () => {
			starts.push("later");
			return "ok";
		});
		expect(await later).toBe("ok");
		expect(starts).toEqual(["failing", "following", "later"]);
	});

	test("only the last queued operation removes the entry; a later operation still chains onto the pending tail", async () => {
		const withKeyedQueue = createKeyedQueue<string>();
		const starts: string[] = [];
		const firstGate = deferred();
		const secondGate = deferred();

		const first = withKeyedQueue("k", async () => {
			starts.push("first");
			await firstGate.promise;
		});
		const second = withKeyedQueue("k", async () => {
			starts.push("second");
			await secondGate.promise;
		});

		await flush();
		expect(starts).toEqual(["first"]);

		// first settles while second is still pending. first must NOT be the
		// one removing the entry, or the third operation would chain onto an
		// empty tail and run concurrently with second.
		firstGate.resolve();
		await flush();
		expect(starts).toEqual(["first", "second"]);

		const third = withKeyedQueue("k", async () => {
			starts.push("third");
		});
		await flush();
		expect(starts).toEqual(["first", "second"]);

		secondGate.resolve();
		await first;
		await second;
		await third;
		expect(starts).toEqual(["first", "second", "third"]);
	});
});

/** A manually settled promise gate; microtask-only, no timers. */
function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
} {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

/**
 * Drain the microtask queue until every operation that was due to start has
 * started. Queue links resolve purely by promise adoption, so eight turns
 * are far beyond the depth any test here needs.
 */
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}
