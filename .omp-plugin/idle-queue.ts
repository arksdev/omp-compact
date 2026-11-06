/**
 * Work that must wait until the session is idle.
 *
 * `agent_end` fires while the session still reports busy, and a message sent
 * then (`pi.sendMessage`, even with `triggerTurn: false`) is steered into the
 * run and starts another turn. Work queued here runs once `isIdle()` holds,
 * in queue order; when the next run starts first, it stays queued until that
 * run ends and the session is idle again. A short unref'd timer polls, so a
 * pending item never keeps the process alive.
 */
export class IdleQueue {
	readonly #pending: Array<() => void> = [];
	readonly #pollMs: number;
	#isIdle: (() => boolean) | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(pollMs = 50) {
		this.#pollMs = pollMs;
	}

	/** Queue `work` to run once `isIdle` (the latest one given) is true. */
	push(work: () => void, isIdle: () => boolean): void {
		this.#pending.push(work);
		this.#isIdle = isIdle;
		this.#schedule();
	}

	/** Drop pending work: its session is gone. */
	clear(): void {
		this.#pending.length = 0;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#schedule(): void {
		if (this.#timer !== undefined) return;
		const timer = setTimeout(() => this.#poll(), this.#pollMs);
		timer.unref?.();
		this.#timer = timer;
	}

	#poll(): void {
		this.#timer = undefined;
		let idle = false;
		try {
			idle = this.#isIdle?.() === true;
		} catch {
			// A context that can no longer answer belongs to a closed session.
			this.#pending.length = 0;
			return;
		}
		if (!idle) {
			this.#schedule();
			return;
		}
		for (const work of this.#pending.splice(0)) {
			try {
				work();
			} catch {
				// One failing item must not drop the rest.
			}
		}
	}
}
