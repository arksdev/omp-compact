/**
 * Defensive decoding of untrusted OMP vibe tool payloads into
 * validated structures: pure type guards and record access only — never
 * throws, no host calls. The renderer (vibe-cards-render.ts) consumes
 * these shapes as its typed input.
 */

/** CLI execution mode of a worker session. */
export type VibeCli = "fast" | "good";

/** Lifecycle state of a worker session. */
export type VibeSessionState = "running" | "starting" | "idle" | "dead";

/** Single session screen snapshot. */
export interface VibeScreenSnapshot {
	id: string;
	cli: VibeCli;
	state: VibeSessionState;
	model?: string;
	turns: number;
	queued: number;
	turnStartedAt?: number;
	turnMessage?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	trace: readonly string[];
	outputTail: readonly string[];
	lastActivity?: string;
	lastActivityAt: number;
}

/** Vibe tool operation kind. */
export type VibeOp = "spawn" | "send" | "wait" | "kill" | "list";

/** Outcome of a spawn call. */
export interface VibeSpawnInfo {
	id: string;
	cli: VibeCli;
	jobId: string;
}

/** Outcome of a send call. */
export interface VibeSendInfo {
	id: string;
	mode: "turn" | "steered" | "queued";
	jobId?: string;
}

/** Settled entry in a wait outcome. */
export interface VibeWaitSettled {
	id: string;
	jobId: string;
	status: "completed" | "failed" | "cancelled";
}

/** Outcome of a wait call. */
export interface VibeWaitInfo {
	settled: readonly VibeWaitSettled[];
	stillRunning: readonly string[];
	timedOut: boolean;
	waiting?: boolean;
}

/** Outcome of a kill call. */
export interface VibeKillInfo {
	id: string;
	cancelledTurn: boolean;
}

/** Full structured details payload of a vibe tool call. */
export interface VibeToolDetails {
	op: VibeOp;
	screens: readonly VibeScreenSnapshot[];
	spawned?: VibeSpawnInfo;
	send?: VibeSendInfo;
	wait?: VibeWaitInfo;
	killed?: VibeKillInfo;
}

/**
 * Parse and validate a single session screen snapshot defensively.
 */
function sanitizeScreenSnapshot(
	candidate: unknown,
): VibeScreenSnapshot | undefined {
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
		return undefined;
	}
	const rec = candidate as Record<string, unknown>;
	const id = typeof rec.id === "string" ? rec.id.trim() : "";
	if (!id) return undefined;

	const cli: VibeCli = rec.cli === "good" ? "good" : "fast";
	const stateRaw = rec.state;
	const state: VibeSessionState =
		stateRaw === "running" ||
		stateRaw === "starting" ||
		stateRaw === "idle" ||
		stateRaw === "dead"
			? stateRaw
			: "idle";

	const turns =
		typeof rec.turns === "number" &&
		Number.isFinite(rec.turns) &&
		rec.turns >= 0
			? Math.floor(rec.turns)
			: 0;
	const queued =
		typeof rec.queued === "number" &&
		Number.isFinite(rec.queued) &&
		rec.queued >= 0
			? Math.floor(rec.queued)
			: 0;

	const lastActivityAt =
		typeof rec.lastActivityAt === "number" &&
		Number.isFinite(rec.lastActivityAt)
			? rec.lastActivityAt
			: 0;

	const model =
		typeof rec.model === "string" && rec.model.trim()
			? rec.model.trim()
			: undefined;
	const turnStartedAt =
		typeof rec.turnStartedAt === "number" &&
		Number.isFinite(rec.turnStartedAt) &&
		rec.turnStartedAt > 0
			? rec.turnStartedAt
			: undefined;
	const turnMessage =
		typeof rec.turnMessage === "string" && rec.turnMessage.trim()
			? rec.turnMessage.trim()
			: undefined;
	const currentTool =
		typeof rec.currentTool === "string" && rec.currentTool.trim()
			? rec.currentTool.trim()
			: undefined;
	const currentToolArgs =
		typeof rec.currentToolArgs === "string" && rec.currentToolArgs.trim()
			? rec.currentToolArgs.trim()
			: undefined;
	const lastIntent =
		typeof rec.lastIntent === "string" && rec.lastIntent.trim()
			? rec.lastIntent.trim()
			: undefined;
	const lastActivity =
		typeof rec.lastActivity === "string" && rec.lastActivity.trim()
			? rec.lastActivity.trim()
			: undefined;

	const trace = Array.isArray(rec.trace)
		? rec.trace.filter((s): s is string => typeof s === "string")
		: [];
	const outputTail = Array.isArray(rec.outputTail)
		? rec.outputTail.filter((s): s is string => typeof s === "string")
		: [];

	return {
		id,
		cli,
		state,
		model,
		turns,
		queued,
		turnStartedAt,
		turnMessage,
		currentTool,
		currentToolArgs,
		lastIntent,
		trace,
		outputTail,
		lastActivity,
		lastActivityAt,
	};
}

/**
 * Unpack and validate structured vibe tool details from an unknown value.
 *
 * Accepts either the tool result wrapper `{ details: ... }` or the direct details payload.
 * Never throws exceptions on malformed, unexpected, or cyclic inputs.
 */
export function unpackVibeToolDetails(
	result: unknown,
): VibeToolDetails | undefined {
	if (!result || typeof result !== "object") return undefined;
	try {
		const rec = result as Record<string, unknown>;
		const candidate =
			rec.details !== null &&
			typeof rec.details === "object" &&
			!Array.isArray(rec.details)
				? (rec.details as Record<string, unknown>)
				: rec;

		const opRaw = candidate.op;
		if (
			opRaw !== "spawn" &&
			opRaw !== "send" &&
			opRaw !== "wait" &&
			opRaw !== "kill" &&
			opRaw !== "list"
		) {
			return undefined;
		}
		const op = opRaw as VibeOp;

		if (!Array.isArray(candidate.screens)) {
			return undefined;
		}

		const screens: VibeScreenSnapshot[] = [];
		for (const item of candidate.screens) {
			const sanitized = sanitizeScreenSnapshot(item);
			if (sanitized) screens.push(sanitized);
		}

		let spawned: VibeSpawnInfo | undefined;
		if (
			candidate.spawned &&
			typeof candidate.spawned === "object" &&
			!Array.isArray(candidate.spawned)
		) {
			const s = candidate.spawned as Record<string, unknown>;
			if (
				typeof s.id === "string" &&
				typeof s.jobId === "string" &&
				(s.cli === "fast" || s.cli === "good")
			) {
				spawned = {
					id: s.id,
					cli: s.cli,
					jobId: s.jobId,
				};
			}
		}

		let send: VibeSendInfo | undefined;
		if (
			candidate.send &&
			typeof candidate.send === "object" &&
			!Array.isArray(candidate.send)
		) {
			const s = candidate.send as Record<string, unknown>;
			if (
				typeof s.id === "string" &&
				(s.mode === "turn" || s.mode === "steered" || s.mode === "queued")
			) {
				send = {
					id: s.id,
					mode: s.mode,
					jobId: typeof s.jobId === "string" ? s.jobId : undefined,
				};
			}
		}

		let wait: VibeWaitInfo | undefined;
		if (
			candidate.wait &&
			typeof candidate.wait === "object" &&
			!Array.isArray(candidate.wait)
		) {
			const w = candidate.wait as Record<string, unknown>;
			const settled: VibeWaitSettled[] = [];
			if (Array.isArray(w.settled)) {
				for (const item of w.settled) {
					if (item && typeof item === "object" && !Array.isArray(item)) {
						const entry = item as Record<string, unknown>;
						if (
							typeof entry.id === "string" &&
							typeof entry.jobId === "string" &&
							(entry.status === "completed" ||
								entry.status === "failed" ||
								entry.status === "cancelled")
						) {
							settled.push({
								id: entry.id,
								jobId: entry.jobId,
								status: entry.status,
							});
						}
					}
				}
			}

			const stillRunning = Array.isArray(w.stillRunning)
				? w.stillRunning.filter((s): s is string => typeof s === "string")
				: [];

			wait = {
				settled,
				stillRunning,
				timedOut: w.timedOut === true,
				waiting: w.waiting === true ? true : undefined,
			};
		}

		let killed: VibeKillInfo | undefined;
		if (
			candidate.killed &&
			typeof candidate.killed === "object" &&
			!Array.isArray(candidate.killed)
		) {
			const k = candidate.killed as Record<string, unknown>;
			if (typeof k.id === "string") {
				killed = {
					id: k.id,
					cancelledTurn: k.cancelledTurn === true,
				};
			}
		}

		return {
			op,
			screens,
			spawned,
			send,
			wait,
			killed,
		};
	} catch {
		return undefined;
	}
}
