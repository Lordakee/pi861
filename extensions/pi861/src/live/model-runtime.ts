import { randomUUID } from "node:crypto";
import { digest } from "../memory.ts";
import { abortable, type AttemptDeadlines, type TransportHooks } from "./deadline.ts";
import {
	eligible, estimateCost, inferWithRecovery, ModelFailure, ModelRecovery, UNKNOWN_USAGE,
	type ExecutionMode, type HealthService, type ModelTarget, type ModelUsage, type RecoveryOptions, type Requirements,
} from "../routing.ts";
import type { StateStore } from "./store.ts";

export type RouteSignal = "capability_gap" | "scope_changed" | "verification_failed" | "phase_complete" | "no_progress";
export const ROUTE_SIGNALS: readonly RouteSignal[] = ["capability_gap", "scope_changed", "verification_failed", "phase_complete", "no_progress"];
/** A route report as submitted through pi861_model_route or by the host; reason and evidence feed later routing decisions. */
export interface RouteReport {
	signal: RouteSignal;
	reason: string;
	phase: string | undefined;
	verificationPassed: boolean | undefined;
	at: number;
}
export interface RouteDecision { mode: ExecutionMode; targetId: string; minQuality: number; reason: string; }
export interface RouteClassifier {
	classify(task: string, candidates: ModelTarget[], signal: AbortSignal, evidence?: RouteReport[]): Promise<RouteDecision>;
}
export interface ModelPolicy {
	targets: ModelTarget[]; preferred: string; requirements: Requirements;
	recovery: RecoveryOptions; maxAttempts: number; requestTimeoutMs: number;
	maxRequests: number; maxProbeRequests: number;
	/** Fine-grained per-attempt deadlines: connection, first response, progress gap. */
	requestDeadlines?: AttemptDeadlines;
}
export interface ModelRuntimeState {
	mode: ExecutionMode; preferred: string; active: string; reason: string;
	requests: number; probes: number; cancelled: boolean;
	evidence: RouteReport[];
}
export interface ModelCheckpoint {
	version: 1; policyHash: string; taskKey: string; classified: boolean;
	requirements: Requirements; recovery: ReturnType<ModelRecovery["exportState"]>;
	state: ModelRuntimeState;
}
export interface UsageReservation { limit: number; used: number; intents: Record<string, number>; }

/** Global request admission, shared by planners, workers and maintenance when backed by the same store. */
export class RequestBudget {
	private readonly store: StateStore<UsageReservation>;
	constructor(store: StateStore<UsageReservation>) { this.store = store; }
	async reserve(intent: string, count = 1): Promise<void> {
		if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid request reservation");
		await this.store.update((state) => {
			if (state.intents[intent] !== undefined) {
				if (state.intents[intent] !== count) throw new Error("Budget intent changed");
				return;
			}
			if (state.used + count > state.limit) throw new Error("Global model request budget exhausted");
			state.used += count; state.intents[intent] = count;
		});
	}
}

export type UsageKind = "main" | "probe" | "auxiliary";
interface UsageBucket {
	requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number;
	cacheWriteTokens: number; cost: number; unknownReports: number;
}
export interface UsageLedgerState { kinds: Record<string, UsageBucket>; targets: Record<string, UsageBucket>; }
export interface UsageTotals {
	requests: number;
	inputTokens: number | "unknown";
	outputTokens: number | "unknown";
	cacheReadTokens: number | "unknown";
	cacheWriteTokens: number | "unknown";
	cost: number | "unknown";
	unknownReports: number;
}
const emptyBucket = (): UsageBucket => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, unknownReports: 0 });

/**
 * Metering for every actual model request: tokens, cost, probes and auxiliary
 * calls. Unknown usage stays visibly unknown; it is never summed as zero.
 */
export class UsageLedger {
	private readonly store: StateStore<UsageLedgerState>;
	constructor(store: StateStore<UsageLedgerState>) { this.store = store; }
	async record(target: ModelTarget, kind: UsageKind, usage: ModelUsage, label: string = kind): Promise<void> {
		if (!target.id || !["main", "probe", "auxiliary"].includes(kind) ||
			(usage.inputTokens !== null && (!Number.isFinite(usage.inputTokens) || usage.inputTokens < 0)) ||
			(usage.outputTokens !== null && (!Number.isFinite(usage.outputTokens) || usage.outputTokens < 0)) ||
			(usage.cacheReadTokens !== null && (!Number.isFinite(usage.cacheReadTokens) || usage.cacheReadTokens < 0)) ||
			(usage.cacheWriteTokens !== null && (!Number.isFinite(usage.cacheWriteTokens) || usage.cacheWriteTokens < 0)) ||
			(usage.cost !== null && (!Number.isFinite(usage.cost) || usage.cost < 0))) throw new Error("Invalid usage report");
		const cost = estimateCost(target, usage);
		const unknown = usage.inputTokens === null || usage.outputTokens === null || usage.cacheReadTokens === null ||
			usage.cacheWriteTokens === null || cost === null;
		await this.store.update((state) => {
			state.kinds ??= {}; state.targets ??= {};
			for (const [group, id] of [[state.kinds, label], [state.targets, target.id]] as const) {
				const bucket = group[id] ?? emptyBucket();
				bucket.requests++;
				if (usage.inputTokens !== null) bucket.inputTokens += usage.inputTokens;
				if (usage.outputTokens !== null) bucket.outputTokens += usage.outputTokens;
				if (usage.cacheReadTokens !== null) bucket.cacheReadTokens += usage.cacheReadTokens;
				if (usage.cacheWriteTokens !== null) bucket.cacheWriteTokens += usage.cacheWriteTokens;
				if (cost !== null) bucket.cost += cost;
				if (unknown) bucket.unknownReports++;
				group[id] = bucket;
			}
		});
	}
	async summary(): Promise<UsageTotals> {
		const state = await this.store.read();
		return UsageLedger.totals(Object.values(state.kinds ?? {}));
	}
	async breakdown(): Promise<Record<string, UsageTotals>> {
		const state = await this.store.read();
		const result: Record<string, UsageTotals> = {};
		for (const [label, bucket] of Object.entries(state.kinds ?? {})) result[`kind:${label}`] = UsageLedger.totals([bucket]);
		for (const [id, bucket] of Object.entries(state.targets ?? {})) result[`target:${id}`] = UsageLedger.totals([bucket]);
		return result;
	}
	private static totals(buckets: UsageBucket[]): UsageTotals {
		const total = emptyBucket();
		for (const bucket of buckets) {
			total.requests += bucket.requests; total.inputTokens += bucket.inputTokens; total.outputTokens += bucket.outputTokens;
			total.cacheReadTokens += bucket.cacheReadTokens; total.cacheWriteTokens += bucket.cacheWriteTokens;
			total.cost += bucket.cost; total.unknownReports += bucket.unknownReports;
		}
		const scale = (value: number): number | "unknown" => (total.unknownReports > 0 ? "unknown" : value);
		return {
			requests: total.requests,
			inputTokens: scale(total.inputTokens), outputTokens: scale(total.outputTokens),
			cacheReadTokens: scale(total.cacheReadTokens), cacheWriteTokens: scale(total.cacheWriteTokens),
			cost: scale(total.cost), unknownReports: total.unknownReports,
		};
	}
}

/** Services shared between the main runtime and auxiliary model calls. */
export interface RuntimeServices<TResponse> {
	/** Shared health registry so health is not per-instance. */
	health?: HealthService;
	/** Global request admission; every main and auxiliary attempt reserves here. */
	budget?: { reserve(intent: string, count?: number): Promise<void> };
	/** Shared usage metering. */
	ledger?: UsageLedger;
	/** Extracts provider usage from a response; without it usage is recorded as unknown. */
	usageOf?: (response: TResponse) => ModelUsage;
}

/** Controls inference requests only; a completed tool invocation is never put inside this retry loop. */
export class ModelRuntime<TContext, TResponse> {
	private readonly policy: ModelPolicy;
	private requirements: Requirements;
	private recovery: ModelRecovery;
	private mode: ExecutionMode = "fixed";
	private reason = "Configured initial model";
	private requests = 0;
	private probes = 0;
	private cancelled = false;
	private classified = false;
	private failures = 0;
	private evidence: RouteReport[] = [];
	private pending: "escalate" | "reassess" | "downgrade" | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private lifetime = new AbortController();
	private task = "";
	private taskKey = "";
	private readonly classify: RouteClassifier | undefined;
	private readonly infer: (target: ModelTarget, context: TContext, signal: AbortSignal, hooks: TransportHooks) => Promise<TResponse>;
	private readonly probeCall: (target: ModelTarget, signal: AbortSignal) => Promise<boolean>;
	private readonly save: (state: ModelRuntimeState, checkpoint: ModelCheckpoint) => void;
	private readonly services: RuntimeServices<TResponse>;
	constructor(policy: ModelPolicy,
		infer: (target: ModelTarget, context: TContext, signal: AbortSignal) => Promise<TResponse>,
		probe: (target: ModelTarget, signal: AbortSignal) => Promise<boolean>,
		classifier?: RouteClassifier, save: (state: ModelRuntimeState, checkpoint: ModelCheckpoint) => void = () => {},
		services: RuntimeServices<TResponse> = {}) {
		if (policy.maxRequests < 1 || policy.maxProbeRequests < 0) throw new Error("Invalid model budget");
		this.policy = structuredClone(policy); this.requirements = structuredClone(policy.requirements);
		this.recovery = new ModelRecovery(policy.targets, policy.preferred, policy.requirements, policy.recovery, services.health);
		this.infer = infer; this.probeCall = probe; this.classify = classifier; this.save = save; this.services = services;
	}
	get state(): ModelRuntimeState { return { mode: this.mode, preferred: this.recovery.state.preferred, active: this.recovery.state.active,
		reason: this.reason, requests: this.requests, probes: this.probes, cancelled: this.cancelled,
		evidence: structuredClone(this.evidence) }; }
	private persist(): void { this.save(this.state, this.checkpoint); }
	get checkpoint(): ModelCheckpoint {
		return { version: 1, policyHash: digest(this.policy), taskKey: this.taskKey, classified: this.classified,
			requirements: structuredClone(this.requirements), recovery: this.recovery.exportState(), state: this.state };
	}
	restore(checkpoint: ModelCheckpoint): void {
		if (checkpoint.version !== 1 || checkpoint.policyHash !== digest(this.policy)) return;
		if (!Number.isSafeInteger(checkpoint.state.requests) || checkpoint.state.requests < 0 || !Number.isSafeInteger(checkpoint.state.probes) || checkpoint.state.probes < 0 ||
			!["direct", "fixed", "dynamic"].includes(checkpoint.state.mode) || typeof checkpoint.taskKey !== "string") throw new Error("Invalid model checkpoint");
		const evidence = checkpoint.state.evidence ?? [];
		if (!Array.isArray(evidence) || evidence.length > 16 || evidence.some((entry) => !entry || !ROUTE_SIGNALS.includes(entry.signal) ||
			typeof entry.reason !== "string" || entry.reason.length > 2000 ||
			(entry.phase !== undefined && typeof entry.phase !== "string") ||
			(entry.verificationPassed !== undefined && typeof entry.verificationPassed !== "boolean") ||
			!Number.isFinite(entry.at))) throw new Error("Invalid model checkpoint");
		this.requirements = structuredClone(checkpoint.requirements);
		this.recovery = new ModelRecovery(this.policy.targets, checkpoint.recovery.preferred, this.requirements, checkpoint.recovery.options, this.services.health);
		this.recovery.restore(checkpoint.recovery);
		this.requests = checkpoint.state.requests; this.probes = checkpoint.state.probes; this.mode = checkpoint.state.mode;
		this.reason = checkpoint.state.reason; this.classified = checkpoint.classified; this.taskKey = checkpoint.taskKey;
		this.evidence = evidence.map((entry) => ({ signal: entry.signal, reason: entry.reason, phase: entry.phase, verificationPassed: entry.verificationPassed, at: entry.at }));
		this.ensureProbeTimer();
	}
	setTask(task: string): void {
		const key = digest(task); if (key !== this.taskKey) this.classified = false;
		this.taskKey = key; this.task = task;
	}
	private ensureProbeTimer(): void {
		if (!this.timer && !this.cancelled && this.recovery.state.options.failbackEnabled && this.state.active !== this.state.preferred) {
			this.timer = setInterval(() => { void this.checkRecovery().catch(() => {}); }, Math.max(10, this.recovery.state.options.probeIntervalMs));
			this.timer.unref();
		}
	}
	/** Reports a routing signal with its reason and phase/verification evidence; all of it feeds later routing decisions. */
	report(kind: RouteSignal, detail: { reason?: string; phase?: string; verificationPassed?: boolean } = {}): void {
		const entry: RouteReport = {
			signal: kind,
			reason: typeof detail.reason === "string" ? detail.reason.slice(0, 2000) : "",
			phase: typeof detail.phase === "string" && detail.phase ? detail.phase.slice(0, 200) : undefined,
			verificationPassed: detail.verificationPassed,
			at: Date.now(),
		};
		this.evidence.push(entry);
		if (this.evidence.length > 16) this.evidence.shift();
		if (kind === "verification_failed" || kind === "no_progress") {
			this.failures++;
			if (this.failures >= 2) this.pending = "escalate";
		} else if (kind === "capability_gap") this.pending = "escalate";
		else if (kind === "phase_complete" && detail.verificationPassed === true && entry.phase !== undefined &&
			this.requirements.minQuality > this.policy.requirements.minQuality) this.pending = "downgrade";
		else if (kind === "scope_changed" || this.mode === "dynamic") this.pending = "reassess";
	}
	setRecoveryOptions(options: Partial<RecoveryOptions>): void {
		this.recovery.setOptions(options); this.persist();
		if (!this.recovery.state.options.failbackEnabled && this.timer) { clearInterval(this.timer); this.timer = undefined; }
		this.ensureProbeTimer();
	}
	private async choose(signal: AbortSignal): Promise<void> {
		if (this.pending === "escalate") {
			const current = this.recovery.current;
			const next = this.policy.targets.filter((target) => target.quality > current.quality && eligible(target, this.requirements))
				.sort((a, b) => b.quality - a.quality || a.costRank - b.costRank)[0];
			if (!next) throw new Error("No authorized stronger model is available; task paused");
			this.requirements.minQuality = Math.max(this.requirements.minQuality, next.quality);
			this.recovery.setPreferred(next.id, this.requirements); this.reason = "Capability/verification escalation";
			this.pending = undefined; this.failures = 0; this.classified = true; this.persist(); return;
		}
		if (this.pending === "downgrade") {
			// Explicit downgrade conditions were proven at report time: a completed phase with verified quality.
			this.requirements = { ...this.requirements, minQuality: this.policy.requirements.minQuality };
			this.reason = "Verified phase complete; quality floor returned to the policy baseline";
			this.classified = false; this.pending = undefined; this.failures = 0;
		}
		if ((!this.classified || this.pending === "reassess") && this.classify && this.task) {
			const candidates = this.policy.targets.filter((target) => eligible(target, this.policy.requirements));
			const decision = await abortable(this.classify.classify(this.task, structuredClone(candidates), signal, structuredClone(this.evidence)), signal);
			signal.throwIfAborted();
			if (!["direct", "fixed", "dynamic"].includes(decision.mode) || !Number.isFinite(decision.minQuality) || decision.minQuality < this.policy.requirements.minQuality) throw new Error("Invalid routing decision");
			const requirements = { ...this.policy.requirements, minQuality: decision.minQuality };
			const target = candidates.find((target) => target.id === decision.targetId && eligible(target, requirements));
			if (!target) throw new Error("Router selected an unauthorized or inadequate model");
			this.mode = decision.mode; this.reason = decision.reason.slice(0, 1000); this.requirements = requirements;
			this.recovery.setPreferred(target.id, requirements);
		}
		this.classified = true; this.pending = undefined; this.persist();
	}
	async call(context: TContext, signal: AbortSignal): Promise<TResponse> {
		if (this.cancelled) throw new Error("Model runtime is closed");
		const effective = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.policy.requestTimeoutMs * (this.policy.maxAttempts + 1))]);
		await this.choose(effective); this.recovery.atBoundary();
		try {
			return await inferWithRecovery(this.recovery, async (target, attempt, requestSignal, hooks) => {
				if (this.requests >= this.policy.maxRequests) throw new ModelFailure("budget_exhausted");
				await this.services.budget?.reserve(digest(["main", attempt.generation, attempt.configId, attempt.configRevision]));
				this.requests++; this.persist();
				try {
					const result = await this.infer(target, context, requestSignal, hooks);
					if (this.services.ledger) await this.services.ledger.record(target, "main",
						this.services.usageOf ? this.services.usageOf(result) : UNKNOWN_USAGE).catch(() => undefined);
					return result;
				} catch (error) {
					if (this.services.ledger) await this.services.ledger.record(target, "main", UNKNOWN_USAGE).catch(() => undefined);
					throw error;
				}
			}, { signal: effective, maxAttempts: this.policy.maxAttempts, timeoutMs: this.policy.requestTimeoutMs, deadlines: this.policy.requestDeadlines });
		} finally {
			this.persist();
			this.ensureProbeTimer();
		}
	}
	async checkRecovery(now = Date.now()): Promise<void> {
		if (this.cancelled || this.probes >= this.policy.maxProbeRequests) return;
		const probe = this.recovery.beginProbe(now); if (!probe) return;
		const target = this.policy.targets.find((target) => target.id === probe.configId && target.revision === probe.configRevision);
		if (!target) { this.recovery.abandonProbe(); return; }
		this.probes++; this.persist();
		let ok = false;
		try { const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.policy.requestTimeoutMs)]); ok = await abortable(this.probeCall(target, signal), signal); }
		catch { ok = false; }
		this.recovery.finishProbe(probe, ok, now);
		if (this.services.ledger) await this.services.ledger.record(target, "probe", UNKNOWN_USAGE).catch(() => undefined);
		this.persist();
	}
	close(): void { this.cancelled = true; this.lifetime.abort(); if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

export interface AuxiliaryModelConfig {
	targets: ModelTarget[];
	preferred: string;
	requirements: Requirements;
	recovery: RecoveryOptions;
	maxAttempts: number;
	requestTimeoutMs: number;
	requestDeadlines?: AttemptDeadlines;
}
export type AuxiliaryTransport = (target: ModelTarget, prompt: string, signal: AbortSignal, hooks: TransportHooks) => Promise<{ text: string; usage: ModelUsage }>;
export interface AuxiliaryServices {
	health?: HealthService;
	budget?: { reserve(intent: string, count?: number): Promise<void> };
	ledger?: UsageLedger;
}

/**
 * Auxiliary model calls (intake classification, planning, memory extraction,
 * Skill compilation) under the same recovery machine, request budget and usage
 * metering as main execution. The preferred target's quality becomes the floor,
 * so failover never silently downgrades an auxiliary call.
 */
export class AuxiliaryModelService {
	/** Per-startup salt: a restarted instance must never hit a predecessor's reservation intent. */
	private readonly instanceSalt = randomUUID();
	private readonly config: AuxiliaryModelConfig;
	private readonly recovery: ModelRecovery;
	private readonly infer: AuxiliaryTransport;
	private readonly services: AuxiliaryServices;
	constructor(config: AuxiliaryModelConfig, infer: AuxiliaryTransport, services: AuxiliaryServices = {}) {
		if (!Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 1 ||
			!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) throw new Error("Invalid auxiliary model configuration");
		const preferred = config.targets.find((target) => target.id === config.preferred);
		if (!preferred) throw new Error("Unknown auxiliary preferred model");
		this.config = structuredClone(config);
		this.infer = infer;
		this.services = services;
		this.recovery = new ModelRecovery(config.targets, config.preferred,
			{ ...config.requirements, minQuality: Math.max(config.requirements.minQuality, preferred.quality) },
			config.recovery, services.health);
	}
	get state() { return this.recovery.state; }
	/** One auxiliary generation under recovery, budget and metering; the reservation is idempotent per attempt. */
	async generate(kind: string, prompt: string, signal: AbortSignal): Promise<string> {
		if (!kind || typeof prompt !== "string") throw new Error("Invalid auxiliary call");
		const result = await inferWithRecovery(this.recovery, async (target, attempt, requestSignal, hooks) => {
			await this.services.budget?.reserve(digest(["auxiliary", this.instanceSalt, kind, prompt, attempt.generation, attempt.configId]));
			try {
				const outcome = await this.infer(target, prompt, requestSignal, hooks);
				if (this.services.ledger) await this.services.ledger.record(target, "auxiliary", outcome.usage, `auxiliary:${kind}`).catch(() => undefined);
				return outcome;
			} catch (error) {
				if (this.services.ledger) await this.services.ledger.record(target, "auxiliary", UNKNOWN_USAGE, `auxiliary:${kind}`).catch(() => undefined);
				throw error;
			}
		}, { signal, maxAttempts: this.config.maxAttempts, timeoutMs: this.config.requestTimeoutMs, deadlines: this.config.requestDeadlines });
		return result.text;
	}
	/** Accounts an out-of-process model consumer (for example the read-only Pi planner session): reserve plus unknown usage. */
	async meterExternal(kind: string, intent: string, targetId: string): Promise<void> {
		const target = this.config.targets.find((entry) => entry.id === targetId);
		if (!target) throw new Error("Unknown external model target");
		await this.services.budget?.reserve(intent);
		if (this.services.ledger) await this.services.ledger.record(target, "auxiliary", UNKNOWN_USAGE, `auxiliary:${kind}`);
	}
}

/** One policy layer; every field may only narrow the inherited policy. */
export interface PolicyLayer {
	/** Restricts the inherited catalog by removing targets (same-id entries must match the parent). */
	targets?: ModelTarget[];
	allowedIds?: string[];
	preferred?: string;
	minQuality?: number;
	contextTokens?: number;
	capabilities?: string[];
	dataBoundary?: string;
	recovery?: Partial<RecoveryOptions>;
	maxAttempts?: number;
	requestTimeoutMs?: number;
	maxRequests?: number;
	maxProbeRequests?: number;
}
function narrowRecovery(parent: RecoveryOptions, patch: Partial<RecoveryOptions>): RecoveryOptions {
	if (patch.failoverEnabled === true && parent.failoverEnabled === false) throw new Error("Policy layer cannot enable failover disabled by the parent");
	if (patch.failbackEnabled === true && parent.failbackEnabled === false) throw new Error("Policy layer cannot enable failback disabled by the parent");
	if (patch.probeIntervalMs !== undefined && patch.probeIntervalMs < parent.probeIntervalMs) throw new Error("Policy layer cannot probe faster than the parent floor");
	if (patch.maxProbeIntervalMs !== undefined && patch.maxProbeIntervalMs > parent.maxProbeIntervalMs) throw new Error("Policy layer cannot extend the probe backoff cap");
	if (patch.requiredProbeSuccesses !== undefined && patch.requiredProbeSuccesses < parent.requiredProbeSuccesses) throw new Error("Policy layer cannot require fewer probe successes");
	if (patch.maxConcurrentProbes !== undefined && parent.maxConcurrentProbes !== undefined && patch.maxConcurrentProbes > parent.maxConcurrentProbes) throw new Error("Policy layer cannot raise probe concurrency");
	if (patch.probeBudget !== undefined && parent.probeBudget !== undefined && patch.probeBudget > parent.probeBudget) throw new Error("Policy layer cannot raise the probe budget");
	return { ...parent, ...patch };
}

/** Resolves the global default, then Agent and sub-Agent layers, into one effective policy. */
export function resolveModelPolicy(base: ModelPolicy, ...layers: PolicyLayer[]): ModelPolicy {
	let resolved: ModelPolicy = structuredClone(base);
	for (const layer of layers) {
		const next: ModelPolicy = structuredClone(resolved);
		if (layer.targets) {
			for (const target of layer.targets) {
				const parent = resolved.targets.find((entry) => entry.id === target.id);
				if (!parent || digest(parent) !== digest(target)) throw new Error("Policy layer may only restrict the inherited model catalog");
			}
			next.targets = structuredClone(layer.targets);
		}
		if (layer.allowedIds) {
			if (layer.allowedIds.some((id) => !resolved.requirements.allowedIds.includes(id))) throw new Error("Policy layer cannot allow models the parent did not allow");
			next.requirements = { ...next.requirements, allowedIds: [...layer.allowedIds] };
		}
		if (layer.minQuality !== undefined) {
			if (layer.minQuality < resolved.requirements.minQuality) throw new Error("Policy layer cannot lower the quality floor");
			next.requirements = { ...next.requirements, minQuality: layer.minQuality };
		}
		if (layer.contextTokens !== undefined) {
			if (layer.contextTokens < resolved.requirements.contextTokens) throw new Error("Policy layer cannot shrink the context requirement");
			next.requirements = { ...next.requirements, contextTokens: layer.contextTokens };
		}
		if (layer.capabilities) {
			const capabilities = layer.capabilities;
			if (resolved.requirements.capabilities.some((capability) => !capabilities.includes(capability))) throw new Error("Policy layer cannot drop required capabilities");
			next.requirements = { ...next.requirements, capabilities: [...capabilities] };
		}
		if (layer.dataBoundary !== undefined) {
			if (resolved.requirements.dataBoundary !== undefined && resolved.requirements.dataBoundary !== layer.dataBoundary) throw new Error("Policy layer cannot loosen the data boundary");
			next.requirements = { ...next.requirements, dataBoundary: layer.dataBoundary };
		}
		if (layer.recovery) next.recovery = narrowRecovery(resolved.recovery, layer.recovery);
		if (layer.maxAttempts !== undefined) {
			if (layer.maxAttempts > resolved.maxAttempts || layer.maxAttempts < 1) throw new Error("Policy layer cannot raise the attempt limit");
			next.maxAttempts = layer.maxAttempts;
		}
		if (layer.requestTimeoutMs !== undefined) {
			if (layer.requestTimeoutMs > resolved.requestTimeoutMs || layer.requestTimeoutMs < 1) throw new Error("Policy layer cannot extend the request timeout");
			next.requestTimeoutMs = layer.requestTimeoutMs;
		}
		if (layer.maxRequests !== undefined) {
			if (layer.maxRequests > resolved.maxRequests || layer.maxRequests < 1) throw new Error("Policy layer cannot raise the request budget");
			next.maxRequests = layer.maxRequests;
		}
		if (layer.maxProbeRequests !== undefined) {
			if (layer.maxProbeRequests > resolved.maxProbeRequests || layer.maxProbeRequests < 0) throw new Error("Policy layer cannot raise the probe budget");
			next.maxProbeRequests = layer.maxProbeRequests;
		}
		if (layer.preferred !== undefined) next.preferred = layer.preferred;
		resolved = next;
	}
	if (!Number.isSafeInteger(resolved.maxAttempts) || resolved.maxAttempts < 1 ||
		!Number.isSafeInteger(resolved.requestTimeoutMs) || resolved.requestTimeoutMs <= 0 ||
		!Number.isSafeInteger(resolved.maxRequests) || resolved.maxRequests < 1 ||
		!Number.isSafeInteger(resolved.maxProbeRequests) || resolved.maxProbeRequests < 0) throw new Error("Invalid resolved model policy");
	// Constructing the control state rejects inconsistent combinations (unknown preferred, ineligible targets, ...).
	new ModelRecovery(resolved.targets, resolved.preferred, resolved.requirements, resolved.recovery);
	return resolved;
}
