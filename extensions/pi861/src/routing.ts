/** Model policy is separate from inference transport and tool side effects. */
import { AttemptClock, type AttemptDeadlines, type TransportHooks } from "./live/deadline.ts";

export interface ModelBilling {
	inputPerMillionTokens: number;
	outputPerMillionTokens: number;
	cacheReadPerMillionTokens?: number;
	cacheWritePerMillionTokens?: number;
	currency?: string;
}
export interface ModelTarget {
	id: string;
	revision: string;
	provider: string;
	model: string;
	quality: number;
	costRank: number;
	contextWindow: number;
	capabilities: string[];
	enabled: boolean;
	/** Account fault domain: failures are shared between targets on one account. */
	account: string;
	/** Endpoint fault domain (gateway or host identity). */
	endpoint: string;
	/** Known pricing; used to estimate cost when the provider reports none. */
	billing: ModelBilling;
	/** Data egress boundary label; requirements may pin an exact boundary. */
	dataEgress: string;
}

export interface Requirements {
	minQuality: number;
	contextTokens: number;
	capabilities: string[];
	allowedIds: string[];
	/** When set, only targets with an exactly matching dataEgress label are eligible. */
	dataBoundary?: string;
}

/** Usage as reported by the transport; null means unknown and is never recorded as zero. */
export interface ModelUsage {
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	cost: number | null;
}
export const UNKNOWN_USAGE: ModelUsage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cost: null };
/** Provider-reported cost wins; otherwise known token usage is priced from the target's billing. */
export function estimateCost(target: ModelTarget, usage: ModelUsage): number | null {
	if (usage.cost !== null) return usage.cost;
	if (usage.inputTokens === null || usage.outputTokens === null) return null;
	const cacheRead = usage.cacheReadTokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? 0;
	const readRate = target.billing.cacheReadPerMillionTokens ?? target.billing.inputPerMillionTokens;
	const writeRate = target.billing.cacheWritePerMillionTokens ?? target.billing.inputPerMillionTokens;
	return (usage.inputTokens * target.billing.inputPerMillionTokens + usage.outputTokens * target.billing.outputPerMillionTokens +
		cacheRead * readRate + cacheWrite * writeRate) / 1_000_000;
}

export type ExecutionMode = "direct" | "fixed" | "dynamic";
export interface Assessment {
	canFinishDirectly: boolean;
	variableNeeds: boolean;
}
export interface RecoveryOptions {
	failoverEnabled: boolean;
	failbackEnabled: boolean;
	probeIntervalMs: number;
	maxProbeIntervalMs: number;
	requiredProbeSuccesses: number;
	/** Backpressure: at most this many probes in flight across a shared health service (default 1). */
	maxConcurrentProbes?: number;
	/** Total probe budget shared across a health service (default unlimited). */
	probeBudget?: number;
}
export interface Attempt {
	generation: number;
	configId: string;
	configRevision: string;
}
export interface Probe extends Attempt {
	probeId: number;
}
export interface HealthEntry {
	failures: number;
	successes: number;
	nextProbeAt: number;
	ready: boolean;
}
export type FailureKind = "transient" | "rate-limit" | "auth" | "quota" | "invalid" | "context" | "cancelled";

function validateRequirements(requirements: Requirements): void {
	if (!Number.isFinite(requirements.minQuality) || requirements.minQuality < 0 ||
		!Number.isSafeInteger(requirements.contextTokens) || requirements.contextTokens < 0 ||
		requirements.allowedIds.length === 0 ||
		(requirements.dataBoundary !== undefined && (typeof requirements.dataBoundary !== "string" || !requirements.dataBoundary))) throw new Error("Invalid model requirements");
}
function validateOptions(options: RecoveryOptions): void {
	if (typeof options.failoverEnabled !== "boolean" || typeof options.failbackEnabled !== "boolean" ||
		!Number.isSafeInteger(options.probeIntervalMs) || options.probeIntervalMs <= 0 ||
		!Number.isSafeInteger(options.maxProbeIntervalMs) || options.maxProbeIntervalMs < options.probeIntervalMs ||
		!Number.isSafeInteger(options.requiredProbeSuccesses) || options.requiredProbeSuccesses < 1 ||
		(options.maxConcurrentProbes !== undefined && (!Number.isSafeInteger(options.maxConcurrentProbes) || options.maxConcurrentProbes < 1)) ||
		(options.probeBudget !== undefined && (!Number.isSafeInteger(options.probeBudget) || options.probeBudget < 0))) {
		throw new Error("Invalid recovery options");
	}
}
function validateBilling(billing: ModelBilling): void {
	if (!billing || !Number.isFinite(billing.inputPerMillionTokens) || billing.inputPerMillionTokens < 0 ||
		!Number.isFinite(billing.outputPerMillionTokens) || billing.outputPerMillionTokens < 0 ||
		(billing.cacheReadPerMillionTokens !== undefined && (!Number.isFinite(billing.cacheReadPerMillionTokens) || billing.cacheReadPerMillionTokens < 0)) ||
		(billing.cacheWritePerMillionTokens !== undefined && (!Number.isFinite(billing.cacheWritePerMillionTokens) || billing.cacheWritePerMillionTokens < 0))) throw new Error("Invalid model configuration");
}
export function eligible(target: ModelTarget, requirements: Requirements): boolean {
	return target.enabled && requirements.allowedIds.includes(target.id) &&
		target.quality >= requirements.minQuality && target.contextWindow >= requirements.contextTokens &&
		requirements.capabilities.every((capability) => target.capabilities.includes(capability)) &&
		(requirements.dataBoundary === undefined || target.dataEgress === requirements.dataBoundary);
}
export function selectInitial(
	targets: readonly ModelTarget[], requirements: Requirements, assessment: Assessment,
): { mode: ExecutionMode; configId: string } {
	validateRequirements(requirements);
	const candidates = targets.filter((target) => eligible(target, requirements))
		.sort((a, b) => a.costRank - b.costRank || a.id.localeCompare(b.id));
	const target = candidates[0];
	if (!target) throw new Error("No authorized model satisfies the task");
	return {
		mode: assessment.canFinishDirectly ? "direct" : assessment.variableNeeds ? "dynamic" : "fixed",
		configId: target.id,
	};
}

/** Health shared per account and endpoint fault domain (provider, account, endpoint). Probes are single-flight, budgeted and backpressured. */
export class HealthService {
	private readonly entries = new Map<string, HealthEntry>();
	private readonly inFlight = new Set<string>();
	private readonly maxConcurrentProbes: number;
	private readonly probeBudget: number;
	private probes = 0;
	constructor(options: { maxConcurrentProbes?: number; probeBudget?: number } = {}) {
		if (options.maxConcurrentProbes !== undefined && (!Number.isSafeInteger(options.maxConcurrentProbes) || options.maxConcurrentProbes < 1)) throw new Error("Invalid probe concurrency");
		if (options.probeBudget !== undefined && (!Number.isSafeInteger(options.probeBudget) || options.probeBudget < 0)) throw new Error("Invalid probe budget");
		this.maxConcurrentProbes = options.maxConcurrentProbes ?? 1;
		this.probeBudget = options.probeBudget ?? Number.POSITIVE_INFINITY;
	}
	static key(target: ModelTarget): string {
		return `${target.provider}|${target.account}|${target.endpoint}`;
	}
	entry(target: ModelTarget): HealthEntry | undefined {
		const found = this.entries.get(HealthService.key(target));
		return found ? { ...found } : undefined;
	}
	setEntry(target: ModelTarget, entry: HealthEntry): void {
		this.entries.set(HealthService.key(target), { ...entry });
	}
	clear(target: ModelTarget): void {
		this.entries.delete(HealthService.key(target));
	}
	recordFailure(target: ModelTarget, now: number, retryAfterMs: number, backoff: { probeIntervalMs: number; maxProbeIntervalMs: number }): HealthEntry {
		const previous = this.entries.get(HealthService.key(target));
		const failures = (previous?.failures ?? 0) + 1;
		const delay = Math.min(backoff.maxProbeIntervalMs, backoff.probeIntervalMs * 2 ** Math.min(failures - 1, 20));
		const entry: HealthEntry = {
			failures, successes: 0, ready: false,
			nextProbeAt: now + Math.max(delay, Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0),
		};
		this.entries.set(HealthService.key(target), entry);
		return { ...entry };
	}
	/** Admission for one probe: requires an unhealthy entry, single-flight per domain, global backpressure and a shared budget. */
	beginProbe(target: ModelTarget, now: number, backoff: { probeIntervalMs: number; maxProbeIntervalMs: number }): boolean {
		const key = HealthService.key(target);
		const entry = this.entries.get(key);
		if (!entry || entry.ready || now < entry.nextProbeAt) return false;
		if (this.inFlight.has(key) || this.inFlight.size >= this.maxConcurrentProbes) return false;
		if (this.probes >= this.probeBudget) return false;
		this.inFlight.add(key);
		this.probes++;
		return true;
	}
	finishProbe(target: ModelTarget, successful: boolean, now: number, backoff: { probeIntervalMs: number; maxProbeIntervalMs: number; requiredProbeSuccesses: number }): HealthEntry | undefined {
		const key = HealthService.key(target);
		if (!this.inFlight.delete(key)) return undefined;
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		entry.successes = successful ? entry.successes + 1 : 0;
		if (!successful) entry.failures++;
		entry.ready = entry.successes >= backoff.requiredProbeSuccesses;
		entry.nextProbeAt = now + (successful ? backoff.probeIntervalMs :
			Math.min(backoff.maxProbeIntervalMs, backoff.probeIntervalMs * 2 ** Math.min(entry.failures - 1, 20)));
		return { ...entry };
	}
	/** Releases an admitted probe without recording a health outcome. */
	cancelProbe(target: ModelTarget): void {
		this.inFlight.delete(HealthService.key(target));
	}
	get probeCount(): number { return this.probes; }
}

/** Single-owner control state. A service must serialize commands and persist its snapshot. */
export class ModelRecovery {
	private readonly targets: Map<string, ModelTarget>;
	private requirements: Requirements;
	private options: RecoveryOptions;
	private readonly health: HealthService;
	private generation = 0;
	private probeSequence = 0;
	private attempt: Attempt | undefined;
	private probe: Probe | undefined;
	private preferred: string;
	private active: string;

	constructor(targets: ModelTarget[], preferred: string, requirements: Requirements, options: RecoveryOptions, sharedHealth?: HealthService) {
		validateRequirements(requirements);
		validateOptions(options);
		this.targets = new Map();
		for (const target of targets) {
			if (!target.id || !target.revision || !target.provider || !target.model ||
				this.targets.has(target.id) || !Number.isFinite(target.quality) || target.quality < 0 ||
				!Number.isFinite(target.costRank) || target.costRank < 0 ||
				!Number.isSafeInteger(target.contextWindow) || target.contextWindow <= 0 ||
				!target.account || !target.endpoint || !target.dataEgress) {
				throw new Error("Invalid or duplicate model configuration");
			}
			validateBilling(target.billing);
			this.targets.set(target.id, structuredClone(target));
		}
		this.requirements = structuredClone(requirements);
		this.options = { ...options };
		this.health = sharedHealth ?? new HealthService({ maxConcurrentProbes: options.maxConcurrentProbes ?? 1, probeBudget: options.probeBudget });
		this.requireEligible(preferred);
		this.preferred = preferred;
		this.active = preferred;
	}

	private requireEligible(id: string): ModelTarget {
		const target = this.targets.get(id);
		if (!target || !eligible(target, this.requirements)) throw new Error("Ineligible model configuration");
		return target;
	}
	get current(): ModelTarget { return structuredClone(this.requireEligible(this.active)); }
	get state() {
		return {
			preferred: this.preferred, active: this.active, generation: this.generation,
			inFlight: this.attempt !== undefined, options: { ...this.options },
			health: this.healthEntries(),
		};
	}
	private healthEntries(): { id: string; failures: number; successes: number; nextProbeAt: number; ready: boolean }[] {
		const entries: { id: string; failures: number; successes: number; nextProbeAt: number; ready: boolean }[] = [];
		for (const target of this.targets.values()) {
			const entry = this.health.entry(target);
			if (entry) entries.push({ id: target.id, ...entry });
		}
		return entries;
	}
	exportState(): { version: 1; preferred: string; active: string; generation: number; options: RecoveryOptions; health: { id: string; revision: string; failures: number; successes: number; nextProbeAt: number; ready: boolean }[] } {
		return { version: 1, preferred: this.preferred, active: this.active, generation: this.generation, options: { ...this.options },
			health: this.healthEntries().map((entry) => ({ ...entry, revision: this.targets.get(entry.id)?.revision ?? "" })) };
	}
	restore(snapshot: ReturnType<ModelRecovery["exportState"]>): void {
		if (this.attempt || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0) throw new Error("Invalid recovery checkpoint");
		validateOptions(snapshot.options); this.requireEligible(snapshot.preferred); this.requireEligible(snapshot.active);
		const health = new Map<string, HealthEntry>();
		for (const entry of snapshot.health) {
			if (health.has(entry.id) || this.targets.get(entry.id)?.revision !== entry.revision || !Number.isSafeInteger(entry.failures) || entry.failures < 1 ||
				!Number.isSafeInteger(entry.successes) || entry.successes < 0 || !Number.isFinite(entry.nextProbeAt) || typeof entry.ready !== "boolean") throw new Error("Invalid recovery health checkpoint");
			health.set(entry.id, { failures: entry.failures, successes: entry.successes, nextProbeAt: entry.nextProbeAt, ready: entry.ready });
		}
		this.dropProbe(); // Never restore an old request's execution authority.
		for (const [id, value] of health) {
			const target = this.targets.get(id);
			if (target) this.health.setEntry(target, value);
		}
		this.preferred = snapshot.preferred; this.active = snapshot.active; this.options = { ...snapshot.options };
		this.generation = snapshot.generation + 1;
	}

	setOptions(patch: Partial<RecoveryOptions>): void {
		const next = { ...this.options, ...patch };
		validateOptions(next);
		this.options = next;
		if (!next.failbackEnabled) this.dropProbe();
	}
	/** Capability routing calls this only at a safe boundary, not during inference. */
	setPreferred(id: string, requirements: Requirements): void {
		if (this.attempt) throw new Error("Model routing requires a safe boundary");
		validateRequirements(requirements);
		const target = this.targets.get(id);
		if (!target || !eligible(target, requirements)) throw new Error("Ineligible preferred model");
		this.requirements = structuredClone(requirements);
		this.preferred = id;
		this.active = id;
		this.dropProbe();
		this.generation++;
	}
	beginAttempt(): Attempt {
		if (this.attempt) throw new Error("An inference attempt is already active");
		const target = this.current;
		const attempt = { generation: ++this.generation, configId: target.id, configRevision: target.revision };
		this.attempt = attempt;
		return { ...attempt };
	}
	private owns(attempt: Attempt): boolean {
		return this.attempt?.generation === attempt.generation &&
			this.attempt.configId === attempt.configId && this.attempt.configRevision === attempt.configRevision;
	}
	succeed(attempt: Attempt): boolean {
		if (!this.owns(attempt)) return false;
		this.attempt = undefined;
		const target = this.targets.get(attempt.configId);
		if (target) this.health.clear(target);
		return true;
	}
	/** Cancellation never authorizes a new provider call. */
	cancel(attempt: Attempt): void {
		if (this.owns(attempt)) {
			this.attempt = undefined;
			this.generation++;
		}
	}
	fail(attempt: Attempt, kind: FailureKind, now: number, retryAfterMs = 0): boolean {
		if (!this.owns(attempt)) return false;
		this.cancel(attempt);
		if (kind === "cancelled" || kind === "invalid" || kind === "context") return false;
		const failed = this.targets.get(attempt.configId);
		if (failed) this.health.recordFailure(failed, now, retryAfterMs, this.options);
		if (!this.options.failoverEnabled) return false;
		const next = [...this.targets.values()].find((target) => {
			if (target.id === attempt.configId || !eligible(target, this.requirements)) return false;
			const entry = this.health.entry(target);
			return entry === undefined || entry.ready;
		});
		if (!next) return false;
		this.active = next.id;
		return true;
	}
	private dropProbe(): void {
		if (!this.probe) return;
		const target = this.targets.get(this.probe.configId);
		if (target) this.health.cancelProbe(target);
		this.probe = undefined;
	}
	beginProbe(now: number): Probe | undefined {
		if (!this.options.failbackEnabled || this.active === this.preferred || this.probe) return undefined;
		const target = this.requireEligible(this.preferred);
		const entry = this.health.entry(target);
		if (!entry || entry.ready || now < entry.nextProbeAt) return undefined;
		if (!this.health.beginProbe(target, now, this.options)) return undefined;
		this.probe = {
			probeId: ++this.probeSequence, generation: this.generation,
			configId: target.id, configRevision: target.revision,
		};
		return { ...this.probe };
	}
	finishProbe(probe: Probe, successful: boolean, now: number): boolean {
		if (!this.options.failbackEnabled || this.probe?.probeId !== probe.probeId ||
			probe.configId !== this.preferred || this.probe.configRevision !== probe.configRevision) return false;
		this.probe = undefined;
		const target = this.targets.get(probe.configId);
		if (!target) return false;
		return this.health.finishProbe(target, successful, now, this.options) !== undefined;
	}
	/** Releases an admitted probe without recording a health outcome (for example on configuration drift). */
	abandonProbe(): void { this.dropProbe(); }
	/** Called before a NEW model request, after outstanding tool results are settled. */
	atBoundary(pendingOperations = 0): boolean {
		if (!this.options.failbackEnabled || this.attempt || pendingOperations > 0 ||
			this.active === this.preferred || !this.health.entry(this.requireEligible(this.preferred))?.ready) return false;
		this.requireEligible(this.preferred);
		this.active = this.preferred;
		this.dropProbe();
		this.generation++;
		return true;
	}
}

export class ModelFailure extends Error {
	readonly kind: FailureKind;
	readonly retryAfterMs: number;
	readonly phase: string | undefined;
	constructor(kind: FailureKind, retryAfterMs = 0, phase?: string) {
		super(`Model request failed: ${kind}${phase ? ` (${phase} deadline)` : ""}`);
		this.kind = kind;
		this.retryAfterMs = retryAfterMs;
		this.phase = phase;
	}
}

export interface ToolDispatchDecision { dispatchable: boolean; args?: Record<string, unknown>; error?: string; }

/**
 * Streaming-evolution hook for the buffered wrapper: text increments and tool
 * arguments stay attributed to one attempt; a tool call becomes dispatchable
 * only when its arguments are complete and parse into a JSON object. Late
 * output from a superseded attempt never gains dispatch authority.
 */
export class IncrementBuffer {
	private owner: Attempt | undefined;
	private text = "";
	private readonly pendingTools = new Map<string, { args: string; complete: boolean }>();
	private current(attempt: Attempt): boolean {
		if (this.owner === undefined) {
			this.owner = { ...attempt };
			return true;
		}
		const owner = this.owner;
		if (owner.generation === attempt.generation && owner.configId === attempt.configId && owner.configRevision === attempt.configRevision) return true;
		if (attempt.generation > owner.generation) {
			this.owner = { ...attempt };
			this.text = "";
			this.pendingTools.clear();
			return true;
		}
		return false;
	}
	textDelta(attempt: Attempt, delta: string): boolean {
		if (!this.current(attempt)) return false;
		this.text += delta;
		return true;
	}
	toolArgs(attempt: Attempt, callId: string, fragment: string): boolean {
		if (!this.current(attempt) || !callId) return false;
		const slot = this.pendingTools.get(callId) ?? { args: "", complete: false };
		if (slot.complete) return false;
		slot.args += fragment;
		this.pendingTools.set(callId, slot);
		return true;
	}
	/** Marks the argument stream for this call complete and validates; only complete valid object arguments dispatch. */
	endToolArgs(attempt: Attempt, callId: string): ToolDispatchDecision {
		if (!this.current(attempt)) return { dispatchable: false, error: "stale attempt" };
		const slot = this.pendingTools.get(callId);
		if (!slot) return { dispatchable: false, error: "unknown tool call" };
		if (slot.complete) return { dispatchable: false, error: "tool call already ended" };
		slot.complete = true;
		let parsed: unknown;
		try { parsed = JSON.parse(slot.args); } catch { return { dispatchable: false, error: "tool arguments are not valid JSON" }; }
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { dispatchable: false, error: "tool arguments must be a JSON object" };
		return { dispatchable: true, args: parsed as Record<string, unknown> };
	}
	/** Accumulated text of the owning attempt. */
	view(): { attempt: Attempt | undefined; text: string } {
		return { attempt: this.owner ? { ...this.owner } : undefined, text: this.text };
	}
}

/**
 * Runs buffered, side-effect-free inference ONLY. Never wrap tools in this retry loop.
 * Partial provider output must remain tentative inside the transport adapter.
 */
export async function inferWithRecovery<T>(
	recovery: ModelRecovery,
	call: (target: ModelTarget, attempt: Attempt, signal: AbortSignal, hooks: TransportHooks) => Promise<T>,
	options: { signal: AbortSignal; maxAttempts: number; timeoutMs: number; deadlines?: AttemptDeadlines; now?: () => number },
): Promise<T> {
	if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 ||
		!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Invalid attempt limits");
	const now = options.now ?? Date.now;
	for (let index = 0; index < options.maxAttempts; index++) {
		options.signal.throwIfAborted();
		const attempt = recovery.beginAttempt();
		const timed = new AbortController();
		const signal = AbortSignal.any([options.signal, timed.signal]);
		const clock = new AttemptClock(options.deadlines ?? {}, options.timeoutMs,
			(phase) => timed.abort(new ModelFailure("transient", 0, phase)), now);
		let onAbort: (() => void) | undefined;
		try {
			const interrupted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			});
			const result = await Promise.race([call(recovery.current, attempt, signal, clock.hooks), interrupted]);
			options.signal.throwIfAborted();
			if (!recovery.succeed(attempt)) throw new Error("Stale inference result");
			return result;
		} catch (error) {
			if (options.signal.aborted) {
				recovery.cancel(attempt);
				throw options.signal.reason;
			}
			const failure = error instanceof ModelFailure ? error : new ModelFailure("invalid");
			const switched = recovery.fail(attempt, failure.kind, now(), failure.retryAfterMs);
			if (!switched || index + 1 >= options.maxAttempts) throw failure;
		} finally {
			clock.stop();
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}
	throw new Error("Attempt budget exhausted");
}
