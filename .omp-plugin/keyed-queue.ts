/**
 * Per-key serialization of asynchronous operations. Callers keep one queue
 * per namespace (one queue owns one map): operations queued on the same key
 * run strictly in order, each starting only after the previous one settled,
 * and a rejected operation never poisons the chain — every tail is built on
 * `previous.catch(...)`, so later operations still run with fresh state.
 */
export function createKeyedQueue<K>(): <T>(
	key: K,
	operation: () => Promise<T>,
) => Promise<T> {
	const queues = new Map<K, Promise<void>>();
	return async function withKeyedQueue<T>(
		key: K,
		operation: () => Promise<T>,
	): Promise<T> {
		const previous = queues.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		// Both `catch` handlers are unreachable, and deliberately kept. A tail
		// is `previous.catch(…).then(() => current)`, and `current` resolves
		// from the `finally` below, so no tail this function stores can ever
		// reject — by induction the first `previous` is `Promise.resolve()`.
		// The handlers state the invariant the chain depends on: were a
		// rejecting link ever introduced, they are what keeps a failed
		// operation from poisoning every later one on the same key. This is
		// why the module reports 5 of 7 functions covered; the failure path
		// itself is covered, through the operation's own rejection.
		const tail = previous.catch(() => undefined).then(() => current);
		queues.set(key, tail);
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
			// Only the last queued operation cleans up the entry; earlier
			// operations find a newer tail and correctly skip the delete.
			if (queues.get(key) === tail) queues.delete(key);
		}
	};
}
