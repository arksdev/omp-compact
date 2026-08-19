import { type AgentEndEvent, classifyAgentEnd } from "./turn-ledger";

/**
 * Post-turn auto-shake: after a visible, successful
 * terminal assistant answer — never after toolUse/willContinue/abort/error —
 * and strictly after the plugin's audit/Git evidence has been persisted,
 * invoke the NATIVE shake/elide behavior on the main agent session.
 *
 * The module deliberately does not reimplement pruning or context rewriting:
 * it resolves the live `AgentSession` through the public SDK registry
 * (`pi.pi.AgentRegistry.global().get(MAIN_AGENT_ID)`), verifies by identity
 * that the resolved session is the very session the event context belongs to
 * (`session.sessionManager === ctx.sessionManager`, so a subagent session can
 * never shake the main transcript or its own child transcript), and calls the
 * session's public `shake("elide", { signal })`. No typed `/shake` input is
 * ever imitated: no `sendUserMessage`, no terminal input, no shell.
 *
 * When the native shake resolves successfully (including a successful
 * no-op), the module reports the actual `ShakeResult` through the ephemeral
 * `notify` success sink as the stock `formatShakeSummary` one-liner — never
 * as an appended session/custom entry, at most once per logical run, and
 * never on gate skips, persistence failure, abort/dispose, or shake errors.
 *
 * All failure paths are fail-open: a missing registry, a detached session,
 * a rejected persistence wait, a fail-closed drain (the audit lifecycle's
 * agent_end barrier resolves `false` — timeout/teardown), or a throwing
 * native shake only warn once per distinct message and never throw into the
 * extension runner.
 */

export interface AutoShakeSettings {
	enabled: boolean;
	thresholdTokens: number;
}

export interface ShakeResultLike {
	mode: string;
	toolResultsDropped: number;
	blocksDropped: number;
	tokensFreed: number;
	imagesDropped?: number;
	artifactId?: string;
}

/**
 * One-line operator summary of a {@link ShakeResultLike}, a faithful port of
 * stock `formatShakeSummary` (anchor:
 * `oh-my-pi/packages/coding-agent/src/session/shake-types.ts`) so the
 * auto-shake confirmation reads exactly like a manual `/shake`:
 * `Shook 35 tool results (~11593 tokens freed).`, regions joined with ` + `,
 * and `Nothing to shake.` for a successful no-op.
 */
export function formatShakeSummary(result: ShakeResultLike): string {
	if (result.mode === "images") {
		const n = result.imagesDropped ?? 0;
		return n === 0
			? "No images found in this session."
			: `Dropped ${n} image${n === 1 ? "" : "s"} from this session.`;
	}
	const parts: string[] = [];
	if (result.toolResultsDropped > 0) {
		parts.push(
			`${result.toolResultsDropped} tool result${result.toolResultsDropped === 1 ? "" : "s"}`,
		);
	}
	if (result.blocksDropped > 0) {
		parts.push(
			`${result.blocksDropped} block${result.blocksDropped === 1 ? "" : "s"}`,
		);
	}
	if (parts.length === 0) return "Nothing to shake.";
	return `Shook ${parts.join(" + ")} (~${result.tokensFreed} tokens freed).`;
}

/** Minimal structural view of the stock `AgentSession.shake` contract. */
export interface ShakeableSession {
	readonly sessionManager: unknown;
	shake(
		mode: "elide",
		opts?: { signal?: AbortSignal },
	): Promise<ShakeResultLike>;
}

/** The parts of `ExtensionContext` the module relies on. */
export interface ShakeContext {
	sessionManager: unknown;
	getContextUsage?(): { tokens: number } | undefined;
}

export interface PostTurnShakeDeps {
	/** Context usage for the active model; undefined when unknown. */
	getContextUsage(ctx: ShakeContext): { tokens: number } | undefined;
	/** Resolve the session that may be shaken for this event context. */
	resolveSession(ctx: ShakeContext): ShakeableSession | undefined;
	/**
	 * Invoke the native shake. Defaults to the public
	 * `AgentSession.shake("elide", { signal })` contract. Only called with a
	 * resolved session.
	 */
	shake?(
		session: ShakeableSession,
		signal?: AbortSignal,
	): Promise<ShakeResultLike>;
	/**
	 * Ephemeral success sink: invoked once per logical run after the
	 * native shake resolves successfully — including a successful no-op —
	 * with the stock-formatted one-line summary (see `formatShakeSummary`).
	 * Never invoked for gate skips, persistence failure, abort/dispose, or
	 * shake errors. The default is a no-op; a throwing sink is caught.
	 */
	notify?(ctx: ShakeContext, message: string): void;
	/** Warning sink; defaults to console.warn. */
	warn?(message: string): void;
}

export const MAIN_AGENT_ID = "Main";

/**
 * `OMP_COMPACT_SHAKE=1` enables and `OMP_COMPACT_SHAKE=0` disables auto-shake
 * regardless of the stored settings (the documented environment switch from
 * auto-shake). Any other value leaves the configured settings untouched.
 * The threshold is never changed by the environment.
 */
export function resolveAutoShake(
	settings: AutoShakeSettings,
	env: Record<string, string | undefined>,
): AutoShakeSettings {
	if (env.OMP_COMPACT_SHAKE === "1") {
		return { enabled: true, thresholdTokens: settings.thresholdTokens };
	}
	if (env.OMP_COMPACT_SHAKE === "0") {
		return { enabled: false, thresholdTokens: settings.thresholdTokens };
	}
	return settings;
}

/**
 * Build the default session resolver: look up the main agent in the public
 * `AgentRegistry` and require an identity match between the registered
 * session's `sessionManager` and the event context's `sessionManager`.
 * Every failure mode (absent registry, detached session, identity mismatch,
 * throwing getter) resolves to `undefined` — the caller fails open.
 */
export function createSessionResolver(
	registry: unknown,
	mainAgentId: string = MAIN_AGENT_ID,
): (ctx: ShakeContext) => ShakeableSession | undefined {
	return (ctx) => {
		const registryType = typeof registry;
		if (
			!registry ||
			(registryType !== "object" && registryType !== "function")
		) {
			return undefined;
		}
		const candidate = registry as { global?: unknown };
		if (typeof candidate.global !== "function") return undefined;
		const lookup = candidate.global as () => {
			get(id: string):
				| {
						id: string;
						kind: string;
						status: string;
						session: ShakeableSession | null;
				  }
				| undefined;
		};
		try {
			const ref = lookup().get(mainAgentId);
			const session = ref?.session;
			if (!session) return undefined;
			// Identity check: only shake the session the event actually belongs to.
			if (session.sessionManager !== ctx.sessionManager) return undefined;
			return session;
		} catch {
			return undefined;
		}
	};
}

export class PostTurnShake {
	#deps: PostTurnShakeDeps;
	#warn: (message: string) => void;
	#settings: AutoShakeSettings = { enabled: false, thresholdTokens: 0 };
	#globalEnabled = false;
	#shakenThisRun = false;
	#inFlight: Promise<void> | undefined;
	#abort = new AbortController();
	#generation = 0;
	// Distinguishes one logical run from the next inside the same session.
	// `#generation` remains the session/dispose lifecycle guard.
	#runEpoch = 0;
	#warned = new Set<string>();

	constructor(deps: PostTurnShakeDeps) {
		this.#deps = deps;
		this.#warn = deps.warn ?? ((message) => console.warn(message));
	}

	/**
	 * Start a logical run (called ONCE from `agent_start`, only at the true
	 * run boundary — never from a toolUse/willContinue continuation).
	 * Captures the settings snapshot for the whole run — a settings change
	 * applies from the next run, never mid-run. `globallyEnabled` freezes
	 * the runtime gate resolved at the same boundary: a globally disabled
	 * run must pass an explicit disarm here (settings.enabled=false,
	 * globallyEnabled=false) even if the prior run was armed or
	 * `OMP_COMPACT_SHAKE=1` forces auto-shake on, so a stale `agent_end`
	 * can never shake a run the runtime does not own.
	 */
	beginRun(
		settings: AutoShakeSettings,
		globallyEnabled = settings.enabled,
	): void {
		this.#runEpoch++;
		this.#settings = settings;
		this.#globalEnabled = globallyEnabled;
		this.#shakenThisRun = false;
	}

	/**
	 * Called at `agent_end` once the plugin's audit/Git (and stats) evidence
	 * has been persisted. `persistence` is the drain promise the evidence
	 * awaits; the shake never starts before it settles, and a drain that
	 * settles on `false` (fail-closed: barrier timeout/teardown, evidence
	 * never persisted) skips the shake.
	 */
	async onAgentEnd(
		event: AgentEndEvent,
		ctx: ShakeContext,
		persistence?: Promise<unknown>,
	): Promise<void> {
		// Only runs whose frozen global-enabled snapshot is true may shake;
		// the frozen auto-shake toggle gates the env-resolved settings.
		if (!this.#globalEnabled || !this.#settings.enabled) return;
		// Only a visible successful terminal answer qualifies: toolUse,
		// willContinue, aborted, error, and empty assistant messages are all
		// classified as non-filtered and keep the live context intact.
		if (classifyAgentEnd(event) !== "filtered") return;
		// Once per logical run: duplicate/overlapping agent_end events never
		// shake twice. Marked synchronously below, before any await, so a
		// continuation that resumes after the persistence wait can never
		// dispatch a second shake.
		if (this.#shakenThisRun) return;
		const runEpoch = this.#runEpoch;
		const generation = this.#generation;

		// Threshold 0 means every eligible run; a positive threshold requires
		// provider-anchored context usage at or above it. Unknown usage with a
		// positive threshold fails closed (cannot prove eligibility).
		const threshold = this.#settings.thresholdTokens;
		if (threshold > 0) {
			const usage = this.#deps.getContextUsage(ctx);
			if (!usage || usage.tokens < threshold) return;
		}

		// From here the run is committed: at most one shake per logical run,
		// even if the persistence wait is slow or the session disappears.
		this.#shakenThisRun = true;

		if (persistence) {
			let drained = true;
			try {
				// The audit lifecycle's agent_end drain resolves `false` when
				// it failed closed (barrier timeout / teardown): the audit/Git
				// evidence was never persisted, so the run must not shake —
				// eliding tool results whose evidence rows are missing would
				// corrupt the committed projection.
				drained = (await persistence) !== false;
			} catch (error) {
				this.#warnOnce(
					`omp-compact: auto-shake skipped; evidence persistence failed: ${messageOf(error)}`,
				);
				return;
			}
			if (!drained) {
				this.#warnOnce(
					"omp-compact: auto-shake skipped; evidence persistence failed (drain did not complete)",
				);
				return;
			}
		}
		// The session may have switched/shut down, or another logical run may
		// have started while this run waited for persistence.
		if (generation !== this.#generation || runEpoch !== this.#runEpoch) return;

		const session = this.#deps.resolveSession(ctx);
		if (!session) {
			this.#warnOnce(
				"omp-compact: auto-shake unavailable (main agent session not found)",
			);
			return;
		}

		await this.#dispatch(session, ctx);
	}

	/**
	 * End the current session/run (session switch, shutdown, or runtime
	 * disable): aborts any in-flight native shake, drops run state, and
	 * disarms the captured settings so a stale `agent_end` cannot shake the
	 * next session. Idempotent; `beginRun` re-arms for the next run.
	 */
	dispose(): void {
		this.#generation++;
		this.#abort.abort();
		this.#abort = new AbortController();
		this.#shakenThisRun = false;
		this.#settings = { enabled: false, thresholdTokens: 0 };
		this.#globalEnabled = false;
		this.#inFlight = undefined;
		this.#warned.clear();
	}

	async #dispatch(session: ShakeableSession, ctx: ShakeContext): Promise<void> {
		// Reentrancy guard: if a second dispatch arrives while the first is
		// still in flight, await the running shake instead of starting a new
		// one. The second caller receives the first's result (success or error).
		if (this.#inFlight) {
			await this.#inFlight;
			return;
		}
		const signal = this.#abort.signal;
		const generation = this.#generation;
		const run = (async () => {
			try {
				const shake =
					this.#deps.shake ??
					((target, passedSignal) =>
						target.shake("elide", { signal: passedSignal }));
				const result = await shake(session, signal);
				// Report success only while the session still owns the
				// run — dispose()/session switch bumps the generation and
				// aborts the controller, so a late resolution after an abort
				// is never confirmed.
				if (generation !== this.#generation) return;
				this.#reportSuccess(ctx, result);
			} catch (error) {
				this.#warnOnce(`omp-compact: auto-shake failed: ${messageOf(error)}`);
			}
		})();
		this.#inFlight = run;
		try {
			await run;
		} finally {
			if (this.#inFlight === run) this.#inFlight = undefined;
		}
	}

	#reportSuccess(ctx: ShakeContext, result: ShakeResultLike): void {
		const notify = this.#deps.notify;
		if (!notify) return;
		try {
			notify(ctx, formatShakeSummary(result));
		} catch {
			// A failing success sink must never break the shake path.
		}
	}

	#warnOnce(message: string): void {
		if (this.#warned.has(message)) return;
		this.#warned.add(message);
		try {
			this.#warn(message);
		} catch {
			// A failing warning sink must never break the shake path.
		}
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
