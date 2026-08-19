import type { MutationCandidate } from "./audit";
import type { MutationMessageDetails } from "./messages";

export interface AuditLifecycleOptions {
	capture(input: {
		toolCallId: string;
		args: unknown;
		cwd: string;
	}): Promise<MutationCandidate | undefined>;
	complete(
		candidate: MutationCandidate | undefined,
		result: unknown,
		isError: boolean,
	): Promise<MutationMessageDetails[]>;
	/**
	 * Bound for the end-run drain in milliseconds. Stock OMP bounds each
	 * extension handler at 30s; the drain must stay well below that so a
	 * pathological missing `tool_execution_end` can never stall a session.
	 * Defaults to 5_000.
	 */
	barrierMs?: number;
	/** Injectable clock for deterministic tests. */
	now?: () => number;
	/** Injectable sleep for deterministic tests. */
	sleep?: (ms: number) => Promise<void>;
}

export interface WriteStartInput {
	toolCallId: string;
	args: unknown;
	cwd: string;
}

export interface WriteEndInput {
	toolCallId: string;
	result: unknown;
	isError: boolean;
}

/**
 * Opaque run token returned by `snapshot` and consumed by `barrier`. The
 * token is the record itself so a drain pinned to one logical run can never
 * re-address itself to a replacement record registered later under the same
 * `toolCallId` (nested xd:// device dispatch reuses the model's id): map
 * lookups by id would see the successor, lookups through the token cannot.
 */
export interface AuditRunToken {
	readonly toolCallId: string;
	readonly capture: Promise<MutationCandidate | undefined> | undefined;
	readonly completion: Promise<void> | undefined;
	readonly payload: unknown;
	readonly abandoned: boolean;
}

/**
 * Outcome of an end-run drain (`barrier`), separating the two consumers of
 * the result:
 *
 * - `settled` gates the adapter's end-run finalization (`work`): `true`
 *   means the drain finished within its bound — every record either
 *   completed or was finally abandoned (terminal purge, dispose,
 *   replacement) — so finalization may run.
 * - `evidenceReady` gates post-run consumers such as the auto-shake: `true`
 *   only when the drain settled AND every record in scope completed, so the
 *   run's audit/Git evidence was persisted. A terminal purge of pending
 *   records, a teardown, a same-id replacement, or a timeout all abandon
 *   records without evidence and report `false` — the run must not shake.
 */
export interface BarrierOutcome {
	settled: boolean;
	evidenceReady: boolean;
}

interface AuditRecord extends AuditRunToken {
	toolCallId: string;
	capture: Promise<MutationCandidate | undefined> | undefined;
	completion: Promise<void> | undefined;
	payload: unknown;
	abandoned: boolean;
}

interface ResolvedOptions {
	capture: AuditLifecycleOptions["capture"];
	complete: AuditLifecycleOptions["complete"];
	barrierMs: number;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}

const DEFAULT_BARRIER_MS = 5_000;

const defaultNow = (): number => Date.now();

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Plugin-side lifecycle for write-audit and recognized-Git bookkeeping.
 *
 * Stock OMP invokes extension event listeners without awaiting their returned
 * promises, so the async handlers for `tool_execution_start`,
 * `tool_execution_end`, and `agent_end` can overlap freely. This module makes
 * that bookkeeping correct under such fire-and-forget delivery:
 *
 * - `startWrite` registers the audit record synchronously, before the first
 *   filesystem await, so a fast `tool_execution_end` always finds the record
 *   (a plain capture-then-register flow loses it and the write ends up with
 *   no `+N|0` evidence).
 * - `endWrite` consumes the same record synchronously and runs
 *   capture -> post-image audit -> publish exactly once inside a tracked
 *   promise; `endSync` does the same for synchronous Git bookkeeping.
 * - `barrier` waits for every already-consumed completion of the logical run
 *   (started or ended before the `agent_end` emission — see `snapshot`) to
 *   settle, bounded by `barrierMs`. Pending records at a continuation are
 *   deliberately left registered because stock OMP may deliver their end
 *   after `agent_end(willContinue)` on a separate serial chain.
 * - Terminal drains still purge unended records immediately and fail closed
 *   for late ends, preserving the committed transcript boundary.
 *
 * Nothing here touches native tool execution: it only orders plugin
 * bookkeeping. Missing/aborted/inexact evidence fails closed — no publish,
 * no hang.
 */
export class AuditLifecycle {
	#options: ResolvedOptions;
	/** Every record of the session, until its completion settles or it is abandoned. */
	#records = new Map<string, AuditRecord>();
	/** Records whose `tool_execution_end` has not arrived yet. */
	#pending = new Map<string, AuditRecord>();
	#changeWaiters: Array<() => void> = [];
	/**
	 * Serialized `agent_end` queue: links run strictly in emission order even
	 * though stock invokes the listeners fire-and-forget. Bumped by
	 * `dispose()` so links queued before a session switch/shutdown skip their
	 * work and cannot finalize a different session's adapter.
	 */
	#agentEndChain: Promise<boolean> = Promise.resolve(false);
	#generation = 0;

	constructor(options: AuditLifecycleOptions) {
		this.#options = {
			capture: options.capture,
			complete: options.complete,
			barrierMs: options.barrierMs ?? DEFAULT_BARRIER_MS,
			now: options.now ?? defaultNow,
			sleep: options.sleep ?? defaultSleep,
		};
	}

	/**
	 * Synchronously registers a write audit record and starts the pre-image
	 * capture in the background. Must be called before the first await of the
	 * `tool_execution_start` handler.
	 */
	startWrite(input: WriteStartInput): void {
		this.#register(input.toolCallId, {
			capture: this.#options.capture(input).catch(() => undefined),
			payload: undefined,
		});
	}

	/**
	 * Synchronously registers a synchronous (recognized Git) record. The
	 * payload is handed back to the completion work at `tool_execution_end`.
	 */
	startSync(toolCallId: string, payload?: unknown): void {
		this.#register(toolCallId, { capture: undefined, payload });
	}

	/**
	 * Consumes the record synchronously and runs capture -> complete ->
	 * publish exactly once inside a tracked promise. `publish` is invoked
	 * only with non-empty evidence, and only while the record is not
	 * abandoned, so a late completion after the drain bound or teardown
	 * appends nothing.
	 */
	endWrite(
		event: WriteEndInput,
		publish: (mutations: MutationMessageDetails[]) => void,
	): void {
		const record = this.#pending.get(event.toolCallId);
		if (!record || record.capture === undefined) return;
		this.#pending.delete(event.toolCallId);
		const completion = (async () => {
			if (record.abandoned) return;
			const candidate = await record.capture;
			if (record.abandoned) return;
			const mutations = await this.#options.complete(
				candidate,
				event.result,
				event.isError,
			);
			if (record.abandoned || mutations.length === 0) return;
			publish(mutations);
		})().catch(() => {
			// Fail closed: an audit error must not crash the fire-and-forget
			// handler, reject an untracked promise, or double-publish.
		});
		this.#trackCompletion(record, completion);
	}

	/**
	 * Consumes the record synchronously and runs the completion work exactly
	 * once. `work` executes synchronously at call time (preserving
	 * chronological entry order) while the tracked promise covers it in the
	 * end-run drain.
	 */
	endSync(toolCallId: string, work: (payload: unknown) => void): void {
		const record = this.#pending.get(toolCallId);
		if (!record || record.capture !== undefined) return;
		this.#pending.delete(toolCallId);
		const completion = (async () => {
			if (record.abandoned) return;
			work(record.payload);
		})().catch(() => {
			// Fail closed: bookkeeping errors never crash the session.
		});
		this.#trackCompletion(record, completion);
	}

	/**
	 * Abandons a record without an end (e.g. adapter not installed). Any
	 * in-flight completion of the record stays abandoned and publishes
	 * nothing when it settles. A replacement record registered later under
	 * the same id is untouched.
	 */
	discard(toolCallId: string): void {
		const record = this.#records.get(toolCallId);
		if (!record) return;
		record.abandoned = true;
		this.#removeIfCurrent(record);
		this.#signalChange();
	}

	/**
	 * Tokens of every record alive right now. Call synchronously inside the
	 * `agent_end` listener so the drain scope is exactly the logical run that
	 * just ended — work registered later (a continuation run) is ignored.
	 * Tokens (not ids) pin the drain to these exact records: a later
	 * `startWrite` under the same id (nested xd:// device dispatch) replaces
	 * the map entries, and the old drain must not re-address itself to the
	 * successor.
	 */
	snapshot(): ReadonlySet<AuditRunToken> {
		return new Set(this.#records.values());
	}

	/**
	 * Removes `record` from the bookkeeping maps only while it is still the
	 * current entry for its `toolCallId`; a replacement registered later
	 * under the same id is never touched by an older record's teardown.
	 */
	#removeIfCurrent(record: AuditRecord): void {
		if (this.#pending.get(record.toolCallId) === record) {
			this.#pending.delete(record.toolCallId);
		}
		if (this.#records.get(record.toolCallId) === record) {
			this.#records.delete(record.toolCallId);
		}
	}

	/**
	 * Drain gate for `agent_end`: settles once the audit work captured by
	 * `snapshot` has completed, timed out, or been finally abandoned.
	 *
	 * - In-flight completions (a `tool_execution_end` already consumed the
	 *   record) are always awaited, bounded by `barrierMs`.
	 * - Records still pending at a terminal commit (`terminal === true`,
	 *   classified like the ledger: not willContinue/toolUse) are purged
	 *   immediately. Stock may reorder a continuation end, but a terminal
	 *   transcript must never resurrect evidence after it is committed. The
	 *   purge abandons the records, so the drain still settles (the adapter's
	 *   end-run finalization may run) while `evidenceReady` is `false` — the
	 *   purged evidence was never persisted, so post-run consumers such as
	 *   the auto-shake must be skipped.
	 * - At a continuation (`terminal === false`) pending records are not part
	 *   of this drain: they remain in the maps so a late `tool_execution_end`
	 *   can consume and publish their evidence.
	 *
	 * Returns `{ settled, evidenceReady }`:
	 *
	 * - `settled: true` — every record completed or was finally abandoned
	 *   (terminal purge, dispose, same-id replacement) within the bound.
	 * - `evidenceReady: true` — the drain settled and no record in scope was
	 *   abandoned, so the run's audit/Git evidence was persisted.
	 *
	 * On timeout the outstanding records are abandoned (fail closed — no
	 * deadlock, no late publish) and `{ settled: false, evidenceReady: false }`
	 * is returned.
	 */
	async barrier(
		runIds?: ReadonlySet<AuditRunToken>,
		terminal = false,
	): Promise<BarrierOutcome> {
		const ids = runIds ?? this.snapshot();
		const start = this.#options.now();

		// Terminal boundary: purge pending records immediately before the drain.
		// Stock may reorder a continuation end, but a terminal transcript must
		// never resurrect evidence after commit. The purge abandons the
		// records, so `evidenceReady` reports false while the drain still
		// settles for the adapter's end-run finalization.
		if (terminal) {
			for (const token of ids) {
				const record = token as AuditRecord;
				if (this.#pending.get(record.toolCallId) === record) {
					record.abandoned = true;
					this.#removeIfCurrent(record);
				}
			}
		}

		for (;;) {
			let outstanding = false;
			for (const token of ids) {
				const record = token as AuditRecord;
				if (record.abandoned) continue; // fail-closed: settles nothing
				// Identity-checked: a record replaced under the same id is
				// neither awaited nor purged by this drain.
				if (record.completion) {
					outstanding = true;
					break;
				}
			}
			if (!outstanding) {
				return {
					settled: true,
					evidenceReady: this.#evidenceReady(ids),
				};
			}
			const remaining = this.#options.barrierMs - (this.#options.now() - start);
			if (remaining <= 0) {
				for (const token of ids) {
					const record = token as AuditRecord;
					if (
						this.#pending.get(record.toolCallId) === record ||
						record.completion
					) {
						record.abandoned = true;
						this.#removeIfCurrent(record);
					}
				}
				this.#signalChange();
				return { settled: false, evidenceReady: false };
			}
			await this.#waitForChangeOrTimeout(remaining);
		}
	}

	/**
	 * Evidence is ready only when every record in the drain scope completed:
	 * any abandoned record (terminal purge, dispose, same-id replacement)
	 * left its evidence unpublished, so the run must not shake.
	 */
	#evidenceReady(ids: ReadonlySet<AuditRunToken>): boolean {
		for (const token of ids) {
			if ((token as AuditRecord).abandoned) return false;
		}
		return true;
	}

	/**
	 * Queues the `agent_end` bookkeeping of one logical run onto the serial
	 * chain. `runIds`/`terminal` come from the synchronous `snapshot` at
	 * emission; `work` (the adapter's end-run finalization) runs only when
	 * this link is still current:
	 *
	 * - a link queued before `dispose()` (session switch/shutdown) short-
	 *   circuits before its drain, so it neither delays the next session's
	 *   chain nor touches a freshly created adapter;
	 * - a switch landing mid-drain is re-checked after the barrier, so the
	 *   old run's finalization cannot run against the new session's adapter.
	 *
	 * Resolves `true` only when the drain settled, `work` ran, and the run's
	 * evidence is ready (nothing was purged or abandoned) — the post-run
	 * auto-shake gate. Resolves `false` when the link was skipped, the drain
	 * failed closed (timeout/teardown), or a terminal purge abandoned the
	 * pending records: the run still finalized, but it must not shake.
	 */
	enqueueAgentEnd(
		runIds: ReadonlySet<AuditRunToken>,
		terminal: boolean,
		work: () => void,
	): Promise<boolean> {
		const generation = this.#generation;
		const link = this.#agentEndChain
			.then(async () => {
				if (generation !== this.#generation) return false;
				const outcome = await this.barrier(runIds, terminal);
				if (!outcome.settled || generation !== this.#generation) {
					return false;
				}
				work();
				return outcome.evidenceReady;
			})
			.catch(() => false);
		this.#agentEndChain = link;
		return link;
	}

	/**
	 * Abandons all records (session switch/shutdown) and invalidates every
	 * queued `agent_end` link. Idempotent; a fresh session may keep using
	 * this instance.
	 */
	dispose(): void {
		this.#generation++;
		for (const record of this.#records.values()) record.abandoned = true;
		this.#pending.clear();
		this.#records.clear();
		this.#signalChange();
	}

	#register(
		toolCallId: string,
		init: {
			capture?: Promise<MutationCandidate | undefined>;
			payload?: unknown;
		},
	): void {
		const previous = this.#records.get(toolCallId);
		if (previous) {
			// Superseded by a newer start under the same id (a nested xd://
			// device dispatch reuses the model's toolCallId): exactly-once
			// per toolCallId — the superseded record's in-flight completion
			// is abandoned and can never publish, and teardown/dispose needs
			// no separate reach into replaced records.
			previous.abandoned = true;
		}
		const record: AuditRecord = {
			toolCallId,
			capture: init.capture,
			completion: undefined,
			payload: init.payload,
			abandoned: false,
		};
		// Map swap is last-candidate-wins for the shared toolCallId: only the
		// new record is addressable. The previous entry was already abandoned
		// above, so any in-flight completion it still holds settles without
		// publishing (exactly-once — never a double-publish of mutation evidence).
		this.#records.set(toolCallId, record);
		this.#pending.set(toolCallId, record);
	}

	#trackCompletion(record: AuditRecord, completion: Promise<void>): void {
		record.completion = completion;
		completion.finally(() => {
			record.completion = undefined;
			if (this.#records.get(record.toolCallId) === record) {
				this.#records.delete(record.toolCallId);
			}
			this.#signalChange();
		});
		this.#signalChange();
	}

	/**
	 * Wait for state change or timeout, whichever comes first. Waiters are
	 * removed from the queue on completion to prevent memory accumulation in
	 * long-lived sessions with frequent drain cycles.
	 */
	#waitForChangeOrTimeout(ms: number): Promise<void> {
		return new Promise((resolve) => {
			let done = false;
			const finish = (): void => {
				if (done) return;
				done = true;
				// Remove waiter from queue to prevent memory accumulation.
				const index = this.#changeWaiters.indexOf(finish);
				if (index >= 0) this.#changeWaiters.splice(index, 1);
				resolve();
			};
			this.#changeWaiters.push(finish);
			void this.#options.sleep(ms).then(finish, finish);
		});
	}

	#signalChange(): void {
		const waiters = this.#changeWaiters.splice(0);
		for (const waiter of waiters) waiter();
	}
}
