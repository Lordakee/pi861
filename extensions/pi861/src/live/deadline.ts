/** Cancelling the wait does not prove cancellation of an external operation. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let abort: (() => void) | undefined;
	try {
		return await Promise.race([work, new Promise<never>((_resolve, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
		})]);
	} finally { if (abort) signal.removeEventListener("abort", abort); }
}

export interface AttemptDeadlines {
	/** Time allowed to establish the transport connection. */
	connectMs?: number;
	/** Time allowed until the first response increment. */
	firstResponseMs?: number;
	/** Maximum gap between progress increments once the first response arrived. */
	progressMs?: number;
}
export interface TransportHooks {
	/** The transport calls this once the connection is established. */
	connected(): void;
	/** The transport calls this for every received increment. */
	progress(): void;
}
export type DeadlinePhase = "connect" | "first-response" | "progress" | "total";

/**
 * Fine-grained deadlines for one inference attempt: connection, first response,
 * progress gap and total. The transport reports activity through the hooks;
 * a violated deadline aborts the attempt through the supplied callback.
 */
export class AttemptClock {
	private readonly deadlines: AttemptDeadlines;
	private readonly totalMs: number;
	private readonly abort: (phase: DeadlinePhase) => void;
	private readonly now: () => number;
	private readonly startedAt: number;
	private connectedAt: number | undefined;
	private firstResponseAt: number | undefined;
	private lastEventAt: number;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	readonly hooks: TransportHooks;
	constructor(deadlines: AttemptDeadlines, totalMs: number, abort: (phase: DeadlinePhase) => void, now: () => number) {
		for (const value of [deadlines.connectMs, deadlines.firstResponseMs, deadlines.progressMs]) {
			if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error("Invalid attempt deadlines");
		}
		if (!Number.isSafeInteger(totalMs) || totalMs <= 0) throw new Error("Invalid total attempt deadline");
		this.deadlines = { ...deadlines };
		this.totalMs = totalMs;
		this.abort = abort;
		this.now = now;
		this.startedAt = this.lastEventAt = now();
		this.hooks = {
			connected: () => {
				if (this.stopped || this.connectedAt !== undefined) return;
				this.connectedAt = this.now();
				this.arm();
			},
			progress: () => {
				if (this.stopped) return;
				const at = this.now();
				if (this.firstResponseAt === undefined) this.firstResponseAt = at;
				this.lastEventAt = at;
				this.arm();
			},
		};
		this.arm();
	}
	private pending(): { at: number; phase: DeadlinePhase } {
		const candidates: { at: number; phase: DeadlinePhase }[] = [{ at: this.startedAt + this.totalMs, phase: "total" }];
		if (this.deadlines.connectMs !== undefined && this.connectedAt === undefined) {
			candidates.push({ at: this.startedAt + this.deadlines.connectMs, phase: "connect" });
		}
		if (this.deadlines.firstResponseMs !== undefined && this.firstResponseAt === undefined) {
			candidates.push({ at: this.startedAt + this.deadlines.firstResponseMs, phase: "first-response" });
		}
		if (this.deadlines.progressMs !== undefined && this.firstResponseAt !== undefined) {
			candidates.push({ at: this.lastEventAt + this.deadlines.progressMs, phase: "progress" });
		}
		candidates.sort((a, b) => a.at - b.at);
		const first = candidates[0];
		return first ?? { at: this.startedAt + this.totalMs, phase: "total" };
	}
	private arm(): void {
		if (this.stopped) return;
		if (this.timer !== undefined) clearTimeout(this.timer);
		const next = this.pending();
		this.timer = setTimeout(() => {
			this.stopped = true;
			this.abort(next.phase);
		}, Math.max(0, next.at - this.now()));
	}
	stop(): void {
		this.stopped = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
