import { describe, expect, test } from "bun:test";

import {
	type AutoShakeSettings,
	createSessionResolver,
	formatShakeSummary,
	PostTurnShake,
	type PostTurnShakeDeps,
	resolveAutoShake,
	type ShakeableSession,
	type ShakeContext,
	type ShakeResultLike,
} from "./post-turn-shake";
import type { AgentEndEvent } from "./turn-ledger";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Drain all pending microtasks (deterministic; no timers involved). */
async function flush(): Promise<void> {
	for (let i = 0; i < 24; i++) await Promise.resolve();
}

function assistant(text: string, stopReason = "stop") {
	return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

const terminalEvent: AgentEndEvent = {
	messages: [assistant("done")],
	willContinue: false,
};

const toolUseEvent: AgentEndEvent = {
	messages: [assistant("working", "toolUse")],
	willContinue: false,
};

const continuationEvent: AgentEndEvent = {
	messages: [assistant("working")],
	willContinue: true,
};

const abortEvent: AgentEndEvent = {
	messages: [assistant("", "aborted")],
	willContinue: false,
};

const errorEvent: AgentEndEvent = {
	messages: [assistant("", "error")],
	willContinue: false,
};

const emptyEvent: AgentEndEvent = {
	messages: [assistant("")],
	willContinue: false,
};

function shakeResult(
	overrides: Partial<ShakeResultLike> = {},
): ShakeResultLike {
	return {
		mode: "elide",
		toolResultsDropped: 3,
		blocksDropped: 1,
		tokensFreed: 12_000,
		...overrides,
	};
}

function makeSession(
	manager: unknown = {},
	calls: Array<{ mode: string; signal: AbortSignal | undefined }> = [],
): ShakeableSession {
	return {
		sessionManager: manager,
		async shake(mode, opts) {
			calls.push({ mode, signal: opts?.signal });
			return shakeResult();
		},
	};
}

interface Harness {
	shake: PostTurnShake;
	session: ShakeableSession | undefined;
	calls: Array<{ mode: string; signal: AbortSignal | undefined }>;
	warns: string[];
	notifies: string[];
	resolveSession: (ctx: ShakeContext) => ShakeableSession | undefined;
}

function harness(
	settings: AutoShakeSettings,
	overrides: Partial<{
		usage: { tokens: number } | undefined;
		session: ShakeableSession | undefined;
		shakeImpl: (
			session: ShakeableSession,
			signal?: AbortSignal,
		) => Promise<ShakeResultLike>;
		notify: (ctx: ShakeContext, message: string) => void;
	}> = {},
): Harness {
	const calls: Array<{ mode: string; signal: AbortSignal | undefined }> = [];
	const session =
		"session" in overrides ? overrides.session : makeSession({}, calls);
	const warns: string[] = [];
	const notifies: string[] = [];
	const shakeImpl = overrides.shakeImpl;
	const deps: PostTurnShakeDeps = {
		getContextUsage: () => overrides.usage,
		resolveSession: () => session,
		warn: (message) => warns.push(message),
		notify: overrides.notify ?? ((_ctx, message) => notifies.push(message)),
		shake: shakeImpl
			? (target, signal) => shakeImpl(target, signal)
			: (target, signal) => target.shake("elide", { signal }),
	};
	const shake = new PostTurnShake(deps);
	shake.beginRun(settings);
	return {
		shake,
		session,
		calls,
		warns,
		notifies,
		resolveSession: deps.resolveSession,
	};
}

describe("PostTurnShake gates", () => {
	test("disabled auto-shake never shakes or resolves the session", async () => {
		const h = harness({ enabled: false, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
		expect(h.warns).toEqual([]);
	});

	test("toolUse continuation end is not a terminal answer", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(toolUseEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
	});

	test("willContinue end is not a terminal answer", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(continuationEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
	});

	test("aborted and error runs keep their context intact", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(abortEvent, { sessionManager: {} });
		await h.shake.onAgentEnd(errorEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
	});

	test("an assistant message without visible text is not an answer", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(emptyEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
	});

	test("a run frozen globally disabled never shakes even when auto-shake settings are armed", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		// The wiring freezes the global runtime gate at the run boundary;
		// auto-shake armed does not override a global-disable freeze.
		h.shake.beginRun({ enabled: true, thresholdTokens: 0 }, false);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
	});

	test("a globally disabled run explicitly disarms shake armed by the prior run", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toHaveLength(1);
		// The wiring calls beginRun with an explicit disarm on the disabled
		// boundary; the previous run's armed snapshot must not survive.
		h.shake.beginRun({ enabled: false, thresholdTokens: 0 }, false);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toHaveLength(1);
	});

	test("an explicitly frozen globally enabled run can re-arm after a disabled run", async () => {
		const h = harness({ enabled: false, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
		// Global freeze on does not force shake when auto-shake stays off.
		h.shake.beginRun({ enabled: false, thresholdTokens: 0 }, true);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
		// Auto-shake armed on the same frozen-enabled run shakes once.
		h.shake.beginRun({ enabled: true, thresholdTokens: 0 }, true);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toHaveLength(1);
	});
});

describe("PostTurnShake thresholds", () => {
	test("threshold 0 shakes every eligible run", async () => {
		const h = harness(
			{ enabled: true, thresholdTokens: 0 },
			{ usage: undefined },
		);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]?.mode).toBe("elide");
	});

	test("positive threshold below usage does not shake and does not mark the run", async () => {
		const h = harness(
			{ enabled: true, thresholdTokens: 100 },
			{ usage: { tokens: 99 } },
		);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
		// Duplicate agent_end in the same run still does not shake, and the
		// next run is free to check again.
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
		h.shake.beginRun({ enabled: true, thresholdTokens: 100 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
	});

	test("positive threshold met shakes exactly once per run", async () => {
		const h = harness(
			{ enabled: true, thresholdTokens: 100 },
			{ usage: { tokens: 101 } },
		);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toHaveLength(1);
	});

	test("unknown context usage with a positive threshold fails closed", async () => {
		const h = harness(
			{ enabled: true, thresholdTokens: 100 },
			{ usage: undefined },
		);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
	});
});

describe("PostTurnShake once per logical run", () => {
	test("a second agent_end for the same run does not shake again", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toHaveLength(1);
	});

	test("a new run (beginRun) shakes again", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		h.shake.beginRun({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toHaveLength(2);
	});

	test("continuation followed by a terminal end shakes only at the end", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(continuationEvent, { sessionManager: {} });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toHaveLength(1);
	});

	test("overlapping agent_end events dispatch a single shake", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		const persistence = deferred<void>();
		const first = h.shake.onAgentEnd(
			terminalEvent,
			{ sessionManager: {} },
			persistence.promise,
		);
		const second = h.shake.onAgentEnd(
			terminalEvent,
			{ sessionManager: {} },
			persistence.promise,
		);
		persistence.resolve();
		await Promise.all([first, second]);
		expect(h.calls).toHaveLength(1);
	});
});

describe("PostTurnShake persistence ordering", () => {
	test("shake waits for audit/stats persistence to resolve first", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		const order: string[] = [];
		const persistence = deferred<void>();
		const pending = h.shake.onAgentEnd(
			terminalEvent,
			{ sessionManager: {} },
			persistence.promise.then(() => {
				order.push("persistence");
			}),
		);
		await flush();
		expect(order).toEqual([]);
		expect(h.calls).toEqual([]);
		persistence.resolve();
		await pending;
		expect(order).toEqual(["persistence"]);
		expect(h.calls).toHaveLength(1);
	});

	test("a deferred prior-run terminal cannot shake during the next run", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		const persistence = deferred<void>();
		const priorRun = h.shake.onAgentEnd(
			terminalEvent,
			{ sessionManager: {} },
			persistence.promise,
		);
		// A new logical run starts before the first run's evidence drain.
		h.shake.beginRun({ enabled: true, thresholdTokens: 0 });
		persistence.resolve();
		await priorRun;
		expect(h.calls).toEqual([]);

		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toHaveLength(1);
	});

	test("a failed persistence skips the shake and warns once", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		const persistence = deferred<void>();
		const pending = h.shake.onAgentEnd(
			terminalEvent,
			{ sessionManager: {} },
			persistence.promise,
		);
		persistence.reject(new Error("write failed"));
		await pending;
		expect(h.calls).toEqual([]);
		expect(h.warns.filter((w) => w.includes("persistence"))).toHaveLength(1);
	});
});

describe("PostTurnShake session lifecycle", () => {
	test("dispose while waiting for persistence cancels the shake", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		const persistence = deferred<void>();
		const pending = h.shake.onAgentEnd(
			terminalEvent,
			{ sessionManager: {} },
			persistence.promise,
		);
		h.shake.dispose();
		persistence.resolve();
		await pending;
		expect(h.calls).toEqual([]);
	});

	test("dispose before agent_end means nothing shakes", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		h.shake.dispose();
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
	});

	test("dispose aborts an in-flight native shake", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]?.signal?.aborted).toBe(false);
		h.shake.dispose();
		expect(h.calls[0]?.signal?.aborted).toBe(true);
	});

	test("a later run after dispose shakes again", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		h.shake.dispose();
		h.shake.beginRun({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toHaveLength(2);
	});
});

describe("PostTurnShake failure and unavailable seam", () => {
	test("native shake failure warns once and never throws", async () => {
		const h = harness(
			{ enabled: true, thresholdTokens: 0 },
			{
				shakeImpl: async () => {
					throw new Error("boom");
				},
			},
		);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.warns.filter((w) => w.includes("failed"))).toHaveLength(1);
	});

	test("a later run retries after a failure", async () => {
		const h = harness(
			{ enabled: true, thresholdTokens: 0 },
			{
				shakeImpl: async () => {
					throw new Error("boom");
				},
			},
		);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		h.shake.beginRun({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.warns.filter((w) => w.includes("failed"))).toHaveLength(1);
	});

	test("unavailable main session skips the shake and warns once", async () => {
		const h = harness(
			{ enabled: true, thresholdTokens: 0 },
			{ session: undefined },
		);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toEqual([]);
		expect(h.warns.filter((w) => w.includes("unavailable"))).toHaveLength(1);
	});

	test('default shake path calls the native AgentSession.shake("elide") contract', async () => {
		const calls: Array<{ mode: string; signal: AbortSignal | undefined }> = [];
		const session = makeSession({}, calls);
		const deps: PostTurnShakeDeps = {
			getContextUsage: () => undefined,
			resolveSession: () => session,
		};
		const shake = new PostTurnShake(deps);
		shake.beginRun({ enabled: true, thresholdTokens: 0 });
		await shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(calls).toEqual([{ mode: "elide", signal: expect.any(AbortSignal) }]);
	});
});

describe("formatShakeSummary", () => {
	test("canonical stock summary for tool results only", () => {
		expect(
			formatShakeSummary(
				shakeResult({
					mode: "elide",
					toolResultsDropped: 35,
					blocksDropped: 0,
					tokensFreed: 11_593,
				}),
			),
		).toBe("Shook 35 tool results (~11593 tokens freed).");
	});

	test("reports the exact tokensFreed value", () => {
		expect(
			formatShakeSummary(
				shakeResult({ toolResultsDropped: 2, tokensFreed: 123 }),
			),
		).toBe("Shook 2 tool results + 1 block (~123 tokens freed).");
	});

	test("pluralizes tool results and blocks", () => {
		expect(
			formatShakeSummary(
				shakeResult({ toolResultsDropped: 1, blocksDropped: 0 }),
			),
		).toBe("Shook 1 tool result (~12000 tokens freed).");
		expect(
			formatShakeSummary(
				shakeResult({ toolResultsDropped: 0, blocksDropped: 1 }),
			),
		).toBe("Shook 1 block (~12000 tokens freed).");
	});

	test("joins mixed regions with a plus separator", () => {
		expect(
			formatShakeSummary(
				shakeResult({ toolResultsDropped: 35, blocksDropped: 7 }),
			),
		).toBe("Shook 35 tool results + 7 blocks (~12000 tokens freed).");
	});

	test("successful no-op is Nothing to shake", () => {
		expect(
			formatShakeSummary(
				shakeResult({
					toolResultsDropped: 0,
					blocksDropped: 0,
					tokensFreed: 0,
				}),
			),
		).toBe("Nothing to shake.");
	});

	test("images mode follows the stock format", () => {
		expect(
			formatShakeSummary(shakeResult({ mode: "images", imagesDropped: 2 })),
		).toBe("Dropped 2 images from this session.");
		expect(
			formatShakeSummary(shakeResult({ mode: "images", imagesDropped: 1 })),
		).toBe("Dropped 1 image from this session.");
		expect(
			formatShakeSummary(shakeResult({ mode: "images", imagesDropped: 0 })),
		).toBe("No images found in this session.");
	});
});

describe("PostTurnShake success feedback", () => {
	test("a successfully resolved shake reports the stock summary from the actual result", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.calls).toHaveLength(1);
		expect(h.notifies).toEqual([
			"Shook 3 tool results + 1 block (~12000 tokens freed).",
		]);
	});

	test("a successful no-op reports Nothing to shake", async () => {
		const h = harness(
			{ enabled: true, thresholdTokens: 0 },
			{
				shakeImpl: async () =>
					shakeResult({
						toolResultsDropped: 0,
						blocksDropped: 0,
						tokensFreed: 0,
					}),
			},
		);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.notifies).toEqual(["Nothing to shake."]);
	});

	test("at most one confirmation per logical run", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.notifies).toHaveLength(1);
	});

	test("a new logical run confirms again", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		h.shake.beginRun({ enabled: true, thresholdTokens: 0 });
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.notifies).toHaveLength(2);
	});

	test("gate skips never confirm", async () => {
		const disabled = harness({ enabled: false, thresholdTokens: 0 });
		await disabled.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(disabled.notifies).toEqual([]);
		const nonTerminal = harness({ enabled: true, thresholdTokens: 0 });
		await nonTerminal.shake.onAgentEnd(toolUseEvent, { sessionManager: {} });
		await nonTerminal.shake.onAgentEnd(continuationEvent, {
			sessionManager: {},
		});
		await nonTerminal.shake.onAgentEnd(abortEvent, { sessionManager: {} });
		await nonTerminal.shake.onAgentEnd(errorEvent, { sessionManager: {} });
		await nonTerminal.shake.onAgentEnd(emptyEvent, { sessionManager: {} });
		expect(nonTerminal.notifies).toEqual([]);
	});

	test("below-threshold and unknown-usage runs never confirm", async () => {
		const below = harness(
			{ enabled: true, thresholdTokens: 100 },
			{ usage: { tokens: 99 } },
		);
		await below.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(below.notifies).toEqual([]);
		const unknown = harness(
			{ enabled: true, thresholdTokens: 100 },
			{ usage: undefined },
		);
		await unknown.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(unknown.notifies).toEqual([]);
	});

	test("a failed persistence wait never confirms", async () => {
		const h = harness({ enabled: true, thresholdTokens: 0 });
		const persistence = deferred<void>();
		const pending = h.shake.onAgentEnd(
			terminalEvent,
			{ sessionManager: {} },
			persistence.promise,
		);
		persistence.reject(new Error("write failed"));
		await pending;
		expect(h.notifies).toEqual([]);
	});

	test("a throwing native shake never confirms", async () => {
		const h = harness(
			{ enabled: true, thresholdTokens: 0 },
			{
				shakeImpl: async () => {
					throw new Error("boom");
				},
			},
		);
		await h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		expect(h.notifies).toEqual([]);
		expect(h.warns.filter((w) => w.includes("failed"))).toHaveLength(1);
	});

	test("dispose before the shake resolves never confirms a late result", async () => {
		const gate = deferred<ShakeResultLike>();
		const h = harness(
			{ enabled: true, thresholdTokens: 0 },
			{ shakeImpl: async () => gate.promise },
		);
		const pending = h.shake.onAgentEnd(terminalEvent, { sessionManager: {} });
		h.shake.dispose();
		gate.resolve(shakeResult());
		await pending;
		expect(h.notifies).toEqual([]);
	});

	test("a throwing success sink never breaks the shake path", async () => {
		const h = harness(
			{ enabled: true, thresholdTokens: 0 },
			{
				notify: () => {
					throw new Error("ui broken");
				},
			},
		);
		await expect(
			h.shake.onAgentEnd(terminalEvent, { sessionManager: {} }),
		).resolves.toBeUndefined();
		expect(h.calls).toHaveLength(1);
	});
});

describe("createSessionResolver", () => {
	const mainManager = { id: "main-manager" };
	const subManager = { id: "sub-manager" };

	function registryWith(
		ref:
			| {
					id?: string;
					kind?: string;
					status?: string;
					session: ShakeableSession | null;
			  }
			| undefined,
	) {
		return {
			global: () => ({
				get: (id: string) =>
					ref && ref.id === id
						? {
								id: ref.id ?? "Main",
								kind: ref.kind ?? "main",
								status: ref.status ?? "idle",
								session: ref.session,
							}
						: undefined,
			}),
		};
	}

	test("resolves the main session only when its manager matches the context", () => {
		const session = makeSession(mainManager);
		const resolve = createSessionResolver(
			registryWith({ id: "Main", session }),
		);
		expect(resolve({ sessionManager: mainManager })).toBe(session);
		expect(resolve({ sessionManager: subManager })).toBeUndefined();
	});

	test("accepts the stock constructor-shaped AgentRegistry export", () => {
		const session = makeSession(mainManager);
		const StockAgentRegistry = Object.assign(
			function AgentRegistry() {
				return undefined;
			},
			{
				global: () => ({
					get: (id: string) =>
						id === "Main"
							? { id, kind: "main", status: "idle", session }
							: undefined,
				}),
			},
		);

		const resolve = createSessionResolver(StockAgentRegistry);
		expect(resolve({ sessionManager: mainManager })).toBe(session);
	});

	test("returns undefined when the registry has no session attached", () => {
		const resolve = createSessionResolver(
			registryWith({ id: "Main", session: null }),
		);
		expect(resolve({ sessionManager: mainManager })).toBeUndefined();
	});

	test("returns undefined when the registry is absent or not callable", () => {
		expect(
			createSessionResolver(undefined)({ sessionManager: mainManager }),
		).toBeUndefined();
		expect(
			createSessionResolver({ global: undefined } as never)({
				sessionManager: mainManager,
			}),
		).toBeUndefined();
	});

	test("returns undefined when the registry getter throws", () => {
		const resolve = createSessionResolver({
			global: () => {
				throw new Error("registry broken");
			},
		});
		expect(resolve({ sessionManager: mainManager })).toBeUndefined();
	});
});

describe("resolveAutoShake", () => {
	const settings: AutoShakeSettings = {
		enabled: false,
		thresholdTokens: 2_000_000,
	};

	test("environment override enables auto-shake without touching the threshold", () => {
		expect(resolveAutoShake(settings, { OMP_COMPACT_SHAKE: "1" })).toEqual({
			enabled: true,
			thresholdTokens: 2_000_000,
		});
	});

	test("environment override disables auto-shake", () => {
		expect(
			resolveAutoShake(
				{ enabled: true, thresholdTokens: 5 },
				{ OMP_COMPACT_SHAKE: "0" },
			),
		).toEqual({ enabled: false, thresholdTokens: 5 });
	});

	test("unset or unknown environment keeps the configured settings", () => {
		expect(resolveAutoShake(settings, {})).toBe(settings);
		expect(resolveAutoShake(settings, { OMP_COMPACT_SHAKE: "maybe" })).toBe(
			settings,
		);
	});
});
