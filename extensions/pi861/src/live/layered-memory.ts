import { abortable } from "./deadline.ts";
import { randomUUID } from "node:crypto";
import { checkPrincipal, contextPack, digest, LocalMemory, type MemoryBackend, type MemoryInput, type MemoryItem, type MemoryPrincipal, type MemoryReceipt, type MemorySnapshot, type MemoryWrite } from "../memory.ts";
import { record } from "../search.ts";
import type { StateStore } from "./store.ts";

export interface MemoryChange { sequence: number; scope: string; id: string; revision: number; withdrawn: boolean; }
export interface Projection {
	sourceRevision: number; abstract: string; overview: string;
	facts: { text: string; quote: string }[]; model: string; createdAt: number;
}
interface EnrichmentJob {
	id: string; scope: string; memoryId: string; revision: number;
	state: "queued" | "running" | "done" | "obsolete" | "failed" | "dead";
	attempts: number; token?: string; expiresAt?: number;
	nextAttemptAt?: number; failure?: { class: ExtractionFailureClass; message: string; at: number };
}
export interface EnrichmentJobView {
	id: string; scope: string; memoryId: string; revision: number; state: EnrichmentJob["state"];
	attempts: number; nextAttemptAt?: number; failure?: EnrichmentJob["failure"];
}
export interface LayeredMemoryState {
	format: 1; sequence: number; memory: MemorySnapshot;
	changes: MemoryChange[]; projections: Record<string, Projection>; jobs: EnrichmentJob[];
}
export function emptyLayeredMemory(tenantId: string): LayeredMemoryState {
	return { format: 1, sequence: 0, memory: { tenantId, items: [], receipts: [], tombstones: [] }, changes: [], projections: {}, jobs: [] };
}
export interface MemoryExtractor {
	modelId: string;
	extract(input: { id: string; revision: number; text: string; source: MemoryInput["source"] }, signal: AbortSignal): Promise<unknown>;
}

export type ExtractionFailureClass = "transient" | "invalid_output" | "unknown";
/** Classifies extraction failures so retries can back off transient causes and stop early never. */
export function classifyExtractionFailure(error: unknown): ExtractionFailureClass {
	const text = error instanceof Error ? error.message : String(error);
	if (/quote|extraction output|abstract|overview|facts|literal|parse|json/i.test(text)) return "invalid_output";
	if (/timeout|timed out|abort|econn|fetch failed|overloaded|rate.?limit|network|temporarily|unavailable/i.test(text)) return "transient";
	return "unknown";
}

export interface LayeredMemoryOptions {
	/** Per-record item authority (for example PostgresMemory). The state store then carries control state only. */
	items?: MemoryBackend;
	/** Extraction retry policy; attempts are total attempts per job, backoff doubles per failure. */
	retry?: { maxAttempts?: number; baseDelayMs?: number };
}

/** Authoritative items, derived views and durable extraction jobs share one transaction. */
export class LayeredMemory implements MemoryBackend {
	private readonly store: StateStore<LayeredMemoryState>;
	private readonly principal: MemoryPrincipal;
	private readonly items: MemoryBackend | undefined;
	private readonly maxAttempts: number;
	private readonly baseDelayMs: number;
	constructor(store: StateStore<LayeredMemoryState>, principal: MemoryPrincipal, options: LayeredMemoryOptions = {}) {
		checkPrincipal(principal);
		this.store = store; this.principal = structuredClone(principal);
		this.items = options.items;
		this.maxAttempts = options.retry?.maxAttempts ?? 3;
		this.baseDelayMs = options.retry?.baseDelayMs ?? 30_000;
		if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 50 ||
			!Number.isSafeInteger(this.baseDelayMs) || this.baseDelayMs < 0) throw new Error("Invalid extraction retry policy");
	}
	private local(state: LayeredMemoryState): LocalMemory {
		if (state.format !== 1 || state.memory.tenantId !== this.principal.tenantId) throw new Error("Memory store identity mismatch");
		return new LocalMemory(this.principal, state.memory, (next) => { state.memory = next; });
	}
	/** Item authority: the per-record delegate when configured, otherwise the state-embedded snapshot. */
	private backend(state: LayeredMemoryState): MemoryBackend {
		if (!this.items) return this.local(state);
		this.local(state); // identity and snapshot validation only
		return this.items;
	}
	private async findItem(state: LayeredMemoryState, scope: string, id: string): Promise<MemoryItem | undefined> {
		if (this.items) return this.principal.readScopes.includes(scope) ? this.items.get(scope, id) : undefined;
		return state.memory.items.find((item) => item.scope === scope && item.id === id);
	}
	private view(state: LayeredMemoryState, item: MemoryItem): MemoryItem {
		const projection = state.projections[digest([item.scope, item.id])];
		return projection?.sourceRevision === item.revision ? {
			...structuredClone(item), abstract: projection.abstract,
			overview: `${projection.overview}\n[Generated from revision ${item.revision}; original source: ${item.source.ref}]`,
		} : structuredClone(item);
	}
	async get(scope: string, id: string): Promise<MemoryItem | undefined> {
		const state = await this.store.read();
		const item = await this.backend(state).get(scope, id);
		return item ? this.view(state, item) : undefined;
	}
	async search(query: string, limit = 8): Promise<MemoryItem[]> {
		const state = await this.store.read();
		if (this.items) {
			return (await this.items.search(query, limit)).map((item) => this.view(state, item));
		}
		// Validate the same API constraints as the baseline backend.
		await this.local(state).search(query, limit);
		const words = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(query.toLowerCase())]
			.filter((entry) => entry.isWordLike).map((entry) => entry.segment);
		return state.memory.items.filter((item) => item.status !== "withdrawn" && this.principal.readScopes.includes(item.scope))
			.map((item) => this.view(state, item)).map((item) => ({ item, score: words.reduce((score, word) => score +
				(`${item.abstract}\n${item.overview}\n${item.full}`.toLowerCase().includes(word) ? 1 : 0), 0) }))
			.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt || a.item.id.localeCompare(b.item.id))
			.slice(0, limit).map((entry) => entry.item);
	}
	/** Records the control effects of a committed item mutation; replayed receipts are recognized by revision and skipped. */
	private integrate(state: LayeredMemoryState, scope: string, id: string, receipt: MemoryReceipt, withdrawn: boolean, source: MemoryInput["source"]): MemoryReceipt {
		// Each committed mutation of one (scope, id) produces a fresh revision, so an already
		// recorded revision can only be a replayed receipt, never a second mutation.
		const known = state.changes.some((change) =>
			change.scope === scope && change.id === id && change.revision === receipt.revision && change.withdrawn === withdrawn);
		if (!known) {
			state.changes.push({ sequence: ++state.sequence, scope, id, revision: receipt.revision, withdrawn });
			delete state.projections[digest([scope, id])];
			for (const job of state.jobs) if (job.scope === scope && job.memoryId === id && job.state !== "done") job.state = "obsolete";
			if (!withdrawn && (source.kind === "user" || source.kind === "tool")) {
				state.jobs.push({ id: digest([scope, id, receipt.revision]), scope,
					memoryId: id, revision: receipt.revision, state: "queued", attempts: 0 });
			}
		}
		return receipt;
	}
	async put(input: MemoryWrite): Promise<MemoryReceipt> {
		if (this.items) {
			// The delegate is the single authority; control effects are derived and idempotent.
			const receipt = await this.items.put(input);
			if (receipt.state !== "committed") throw new Error("Memory delegate returned an uncommitted receipt");
			return this.store.update((state) => this.integrate(state, input.item.scope, input.item.id, receipt, false, input.item.source));
		}
		return this.store.update(async (state) => {
			const receipt = await this.local(state).put(input);
			return this.integrate(state, input.item.scope, input.item.id, receipt, false, input.item.source);
		});
	}
	async withdraw(requestId: string, scope: string, id: string, expectedRevision: number): Promise<MemoryReceipt> {
		if (this.items) {
			const receipt = await this.items.withdraw(requestId, scope, id, expectedRevision);
			if (receipt.state !== "committed") throw new Error("Memory delegate returned an uncommitted receipt");
			return this.store.update((state) => this.integrate(state, scope, id, receipt, true, { kind: "user", ref: requestId }));
		}
		return this.store.update(async (state) => this.integrate(state, scope, id, await this.local(state).withdraw(requestId, scope, id, expectedRevision), true, { kind: "user", ref: requestId }));
	}
	async list(scope: string, afterId = "", limit = 50): Promise<{ items: MemoryItem[]; nextId?: string }> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid page limit");
		const state = await this.store.read();
		if (this.items) {
			if (!this.items.list) throw new Error("Delegated memory backend does not support listing");
			const page = await this.items.list(scope, afterId, limit);
			return { items: page.items.map((item) => this.view(state, item)), ...(page.nextId ? { nextId: page.nextId } : {}) };
		}
		this.local(state);
		if (!this.principal.readScopes.includes(scope)) return { items: [] };
		const available = state.memory.items.filter((item) => item.scope === scope && item.status !== "withdrawn" && item.id > afterId)
			.sort((a, b) => a.id < b.id ? -1 : 1);
		const items = available.slice(0, limit).map((item) => this.view(state, item));
		return { items, ...(available.length > limit ? { nextId: items.at(-1)?.id } : {}) };
	}
	async delta(afterSequence = 0, limit = 50): Promise<{ changes: MemoryChange[]; cursor: number; hasMore: boolean }> {
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid memory cursor");
		const state = await this.store.read(); this.local(state);
		const visible = state.changes.filter((item) => item.sequence > afterSequence && this.principal.readScopes.includes(item.scope));
		const changes = visible.slice(0, limit);
		return { changes, cursor: changes.at(-1)?.sequence ?? afterSequence, hasMore: visible.length > limit };
	}
	async pack(query: string, maxBytes = 6000): Promise<ReturnType<typeof contextPack>> {
		const found = await this.search(query, 12);
		return contextPack(found, { level: 1, maxBytes });
	}
	async enrich(extractor: MemoryExtractor, options: { signal: AbortSignal; maxJobs?: number; timeoutMs?: number }): Promise<{ completed: number; failed: number; obsolete: number; dead: number }> {
		const max = options.maxJobs ?? 4, timeoutMs = options.timeoutMs ?? 60_000;
		if (!Number.isInteger(max) || max < 1 || max > 100 || timeoutMs < 1) throw new Error("Invalid enrichment budget");
		const stats = { completed: 0, failed: 0, obsolete: 0, dead: 0 };
		for (let index = 0; index < max; index++) {
			options.signal.throwIfAborted();
			const work = await this.store.update(async (state) => {
				this.local(state);
				// ponytail: delegate item reads run inside the control-state lock; safe while enrichment
				// is single-flight per process (runtime guards it), per-account locks if that changes.
				const job = state.jobs.find((job) => this.principal.writeScopes.includes(job.scope) && job.attempts < this.maxAttempts &&
					(job.state === "queued" ||
						job.state === "running" && (job.expiresAt ?? Infinity) <= Date.now() ||
						job.state === "failed" && (job.nextAttemptAt ?? 0) <= Date.now()));
				if (!job) return undefined;
				const item = await this.findItem(state, job.scope, job.memoryId);
				if (!item || item.revision !== job.revision || item.status === "withdrawn") { job.state = "obsolete"; return { obsolete: true as const }; }
				job.state = "running"; job.attempts++; job.token = randomUUID(); job.expiresAt = Date.now() + timeoutMs + 5000;
				return { obsolete: false as const, job: structuredClone(job), item: structuredClone(item) };
			});
			if (!work) break;
			if (work.obsolete) { stats.obsolete++; continue; }
			const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
			try {
				const result = record(await abortable(extractor.extract({ id: work.item.id, revision: work.item.revision, text: work.item.full, source: work.item.source }, signal), signal));
				signal.throwIfAborted();
				if (!result || typeof result.abstract !== "string" || !result.abstract.trim() || result.abstract.length > 600 ||
					typeof result.overview !== "string" || !result.overview.trim() || result.overview.length > 6000 || !Array.isArray(result.facts) || result.facts.length > 20) throw new Error("Invalid extraction output");
				const facts = result.facts.map((raw) => {
					const fact = record(raw);
					if (!fact || typeof fact.text !== "string" || !fact.text.trim() || fact.text.length > 2000 || typeof fact.quote !== "string" ||
						!fact.quote.trim() || !work.item.full.includes(fact.quote)) throw new Error("Extraction lacks a literal source quotation");
					return { text: fact.text, quote: fact.quote };
				});
				const projection: Projection = { sourceRevision: work.item.revision, abstract: result.abstract, overview: result.overview, facts, model: extractor.modelId, createdAt: Date.now() };
				const committed = await this.store.update(async (state) => {
					const job = state.jobs.find((job) => job.id === work.job.id);
					const item = await this.findItem(state, work.item.scope, work.item.id);
					if (job?.state !== "running" || job.token !== work.job.token || (job.expiresAt ?? 0) <= Date.now() ||
						!item || item.revision !== work.item.revision || item.status === "withdrawn") return false;
					state.projections[digest([item.scope, item.id])] = projection;
					job.state = "done"; delete job.token; delete job.expiresAt;
					// Derived-view publication is also a change: peers refresh the view without pretending it is new evidence.
					state.changes.push({ sequence: ++state.sequence, scope: item.scope, id: item.id, revision: item.revision, withdrawn: false });
					return true;
				});
				if (committed) stats.completed++; else stats.obsolete++;
			} catch (error) {
				const failure = {
					class: classifyExtractionFailure(error),
					message: (error instanceof Error ? error.message : String(error)).slice(0, 300), at: Date.now(),
				};
				const died = await this.store.update((state) => {
					const job = state.jobs.find((job) => job.id === work.job.id);
					if (job?.state === "running" && job.token === work.job.token) {
						delete job.token; delete job.expiresAt; job.failure = failure;
						if (job.attempts >= this.maxAttempts) { job.state = "dead"; delete job.nextAttemptAt; }
						else { job.state = "failed"; job.nextAttemptAt = failure.at + this.baseDelayMs * 2 ** (job.attempts - 1); }
						return job.state === "dead";
					}
					return false;
				});
				stats.failed++;
				if (died) stats.dead++;
				if (options.signal.aborted) throw error;
			}
		}
		return stats;
	}
	/** Failed extraction jobs that exhausted their retries and now need a human decision. */
	async deadJobs(): Promise<EnrichmentJobView[]> {
		const state = await this.store.read(); this.local(state);
		return state.jobs.filter((job) => job.state === "dead" && this.principal.writeScopes.includes(job.scope))
			.map((job) => structuredClone(job) as EnrichmentJobView);
	}
	/** Manual handling entry: requeue a dead or failed job with a fresh attempt budget. */
	async retryJob(id: string): Promise<boolean> {
		if (!id) throw new Error("Job id required");
		return this.store.update((state) => {
			this.local(state);
			const job = state.jobs.find((job) => job.id === id && this.principal.writeScopes.includes(job.scope));
			if (!job || (job.state !== "dead" && job.state !== "failed")) return false;
			job.state = "queued"; job.attempts = 0; delete job.failure; delete job.nextAttemptAt;
			return true;
		});
	}
	/** Manual handling entry: drop a dead job without deriving anything from it. */
	async abandonJob(id: string): Promise<boolean> {
		if (!id) throw new Error("Job id required");
		return this.store.update((state) => {
			this.local(state);
			const job = state.jobs.find((job) => job.id === id && this.principal.writeScopes.includes(job.scope));
			if (!job || job.state !== "dead") return false;
			job.state = "obsolete";
			return true;
		});
	}
	/**
	 * Heals the delegated two-phase-commit crash window: a committed item whose control-state
	 * transaction never ran. The items backend is the authority, so every current record is
	 * re-integrated (change entry plus extraction job) exactly when its change is missing.
	 * Idempotent: re-running adds nothing. Embedded mode is single-transaction and reconciles
	 * to zero. The authority is enumerated through exportItems when available, otherwise live
	 * list pages, which cannot see withdrawn records; intermediate revisions of a record are
	 * not reconstructable without an event log and stay absent.
	 */
	async reconcile(): Promise<{ addedChanges: number; addedJobs: number }> {
		if (!this.items) return { addedChanges: 0, addedJobs: 0 };
		const authority = await this.authorityItems();
		return this.store.update((state) => {
			this.local(state);
			const beforeChanges = state.changes.length, beforeJobs = state.jobs.length;
			for (const item of authority) {
				if (!this.principal.writeScopes.includes(item.scope)) continue;
				this.integrate(state, item.scope, item.id, {
					requestId: `reconcile:${item.scope}:${item.id}:${item.revision}`, state: "committed",
					id: item.id, scope: item.scope, revision: item.revision,
				}, item.status === "withdrawn", item.source);
			}
			return { addedChanges: state.changes.length - beforeChanges, addedJobs: state.jobs.length - beforeJobs };
		});
	}
	private async authorityItems(): Promise<MemoryItem[]> {
		const items = this.items;
		if (!items) throw new Error("No item authority configured");
		if (items.exportItems) return items.exportItems();
		const list = items.list;
		if (!list) throw new Error("Delegated memory backend supports neither exportItems nor listing; cannot reconcile");
		const collected: MemoryItem[] = [];
		for (const scope of this.principal.readScopes) {
			let afterId = "";
			// A cursor that stops advancing ends the walk instead of spinning.
			while (true) {
				const page = await list.call(items, scope, afterId, 100);
				collected.push(...page.items);
				if (!page.nextId || page.nextId === afterId) break;
				afterId = page.nextId;
			}
		}
		return collected;
	}
}


export type AssemblyTrigger = "session_start" | "session_resume" | "model_change" | "compaction" | "node_change";

/**
 * R6.3: maps host session events to assembly triggers. Only a session_start whose reason is
 * "resume" restores; session_tree is branch navigation inside one host process, not a
 * distributed node change (workers are separate task processes with no node-change event).
 */
export function hostAssemblyTrigger(event: unknown): AssemblyTrigger | undefined {
	const parsed = record(event);
	if (parsed?.type === "session_start") return parsed.reason === "resume" ? "session_resume" : undefined;
	if (parsed?.type === "session_tree") return "node_change";
	return undefined;
}

/** Event-driven context assembly for model switch, compaction and node change (R6.3), plus event-recall (R6.4). */
export interface AssemblyOutcome {
	trigger: AssemblyTrigger;
	text: string; usedBytes: number; omitted: number;
	eventCursor: number;
}
export interface EventRecallOutcome {
	changes: MemoryChange[]; cursor: number; hasMore: boolean;
	text: string; usedBytes: number; omitted: number;
}
export class ContextAssembler {
	private readonly memory: LayeredMemory;
	private readonly scope: string;
	private readonly maxBytes: number;
	private readonly level: 0 | 1 | 2;
	private cursor = 0;
	constructor(memory: LayeredMemory, scope: string, options: { maxBytes?: number; level?: 0 | 1 | 2 } = {}) {
		if (!scope) throw new Error("Assembly scope required");
		this.memory = memory; this.scope = scope;
		this.maxBytes = options.maxBytes ?? 6000; this.level = options.level ?? 1;
	}
	get eventCursor(): number { return this.cursor; }
	/** Fixed constraints and working state assemble directly; query matches fill the remaining budget. */
	async assemble(trigger: AssemblyTrigger, query = ""): Promise<AssemblyOutcome> {
		const fixed: MemoryItem[] = [];
		let afterId = "";
		// Fixed sets are usually small, but they are not capped at one page; the byte budget still bounds the packed output.
		while (true) {
			const page = await this.memory.list(this.scope, afterId, 100);
			fixed.push(...page.items.filter((item) => item.status === "confirmed" && (item.kind === "constraint" || item.kind === "working")));
			if (!page.nextId || !page.items.length || page.nextId === afterId) break;
			afterId = page.nextId;
		}
		const found = query.trim() ? await this.memory.search(query, 12) : [];
		const merged = [...new Map([...fixed, ...found].map((item) => [JSON.stringify([item.scope, item.id, item.revision]), item])).values()];
		const pack = contextPack(merged, { level: this.level, maxBytes: this.maxBytes });
		return { trigger, ...pack, eventCursor: this.cursor };
	}
	/** Incremental recall: pack current views of everything changed since the last cursor position. */
	async recallEvents(): Promise<EventRecallOutcome> {
		const page = await this.memory.delta(this.cursor, 100);
		const items = (await Promise.all(page.changes.map(async (change) => await this.memory.get(change.scope, change.id))))
			.filter((item): item is MemoryItem => Boolean(item));
		// One record can carry several changes per page (write plus projection); pack its current view once.
		const unique = [...new Map(items.map((item) => [JSON.stringify([item.scope, item.id]), item])).values()];
		const pack = contextPack(unique, { level: this.level, maxBytes: this.maxBytes });
		this.cursor = page.cursor;
		return { changes: page.changes, cursor: page.cursor, hasMore: page.hasMore, ...pack };
	}
}
