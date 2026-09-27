import { createHash } from "node:crypto";

export type MemoryKind = "constraint" | "working" | "project" | "experience" | "evidence";
export interface MemoryPrincipal {
	tenantId: string;
	principalId: string;
	readScopes: string[];
	writeScopes: string[];
}
export interface MemoryInput {
	id: string;
	scope: string;
	kind: MemoryKind;
	abstract: string;
	overview: string;
	full: string;
	source: { kind: "user" | "tool" | "inference" | "recall"; ref: string };
	status: "candidate" | "confirmed";
}
export interface MemoryItem extends Omit<MemoryInput, "status"> {
	status: "candidate" | "confirmed" | "withdrawn";
	revision: number;
	updatedAt: number;
}
export interface MemoryWrite {
	requestId: string;
	expectedRevision: number | null;
	item: MemoryInput;
}
export interface MemoryReceipt {
	requestId: string;
	/** "pending" is returned only by a buffering wrapper: the record is explicitly NOT committed to the shared authority yet. */
	state: "committed" | "pending";
	id: string;
	scope: string;
	revision: number;
}
export interface MemoryBackend {
	get(scope: string, id: string): Promise<MemoryItem | undefined>;
	search(query: string, limit?: number): Promise<MemoryItem[]>;
	put(input: MemoryWrite): Promise<MemoryReceipt>;
	withdraw(requestId: string, scope: string, id: string, expectedRevision: number): Promise<MemoryReceipt>;
	/** Key-ordered pagination including this scope; omitted by minimal adapters. */
	list?(scope: string, afterId?: string, limit?: number): Promise<{ items: MemoryItem[]; nextId?: string }>;
	/** Every item in read scopes including withdrawn ones; authority reconciliation and migration verification, not a general read path. */
	exportItems?(): Promise<MemoryItem[]>;
}
export function canonical(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
			.join(",")}}`;
	}
	throw new Error("Only finite, plain JSON is accepted");
}
export function digest(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
export function contentFingerprint(item: Pick<MemoryInput, "scope" | "full">): string {
	return digest({ scope: item.scope, full: item.full.trim().replace(/\s+/g, " ") });
}
export function sourceFingerprint(item: Pick<MemoryInput, "scope" | "source">): string {
	return digest({ scope: item.scope, source: item.source });
}
export function checkPrincipal(principal: MemoryPrincipal): void {
	if (
		!principal.tenantId ||
		!principal.principalId ||
		!principal.readScopes.every((scope) => /^[a-z]+:[^*:\s]+$/.test(scope)) ||
		!principal.writeScopes.every((scope) => principal.readScopes.includes(scope))
	) {
		throw new Error("Invalid memory principal");
	}
}
export function requireWrite(principal: MemoryPrincipal, scope: string): void {
	if (!principal.writeScopes.includes(scope)) throw new Error("Memory scope not authorized");
}
export function validateMemory(input: MemoryWrite): void {
	const item = input.item;
	if (
		!input.requestId ||
		input.requestId.length > 200 ||
		!item.id ||
		item.id.length > 200 ||
		!item.scope ||
		!item.full.trim() ||
		Buffer.byteLength(item.full, "utf8") > 262_144 ||
		!item.abstract.trim() ||
		!item.overview.trim() ||
		!item.source.ref.trim() ||
		!["constraint", "working", "project", "experience", "evidence"].includes(item.kind) ||
		!["candidate", "confirmed"].includes(item.status) ||
		!["user", "tool", "inference", "recall"].includes(item.source.kind) ||
		(input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1))
	) {
		throw new Error("Invalid memory write");
	}
	if (item.source.kind === "recall") throw new Error("Recalled memory is not new evidence");
	if (item.source.kind === "inference" && (item.status === "confirmed" || item.kind === "constraint")) {
		throw new Error("Model inference cannot promote itself to a confirmed fact or policy");
	}
}
export interface MemorySnapshot {
	tenantId: string;
	items: MemoryItem[];
	receipts: { principalId: string; requestId: string; hash: string; receipt: MemoryReceipt }[];
	tombstones: string[];
}

/** Single-tenant, single-process reference backend; persistence is supplied by the owner. */
export class LocalMemory implements MemoryBackend {
	private state: MemorySnapshot;
	private readonly principal: MemoryPrincipal;
	private readonly persist: (snapshot: MemorySnapshot) => void;
	constructor(
		principal: MemoryPrincipal,
		snapshot: MemorySnapshot | undefined = undefined,
		persist: (snapshot: MemorySnapshot) => void = () => {},
	) {
		checkPrincipal(principal);
		this.principal = structuredClone(principal);
		if (snapshot && snapshot.tenantId !== principal.tenantId)
			throw new Error("Memory snapshot belongs to another tenant");
		if (snapshot) {
			if (
				!Array.isArray(snapshot.items) ||
				!Array.isArray(snapshot.receipts) ||
				!Array.isArray(snapshot.tombstones) ||
				!snapshot.tombstones.every((hash) => typeof hash === "string")
			) {
				throw new Error("Invalid memory snapshot");
			}
			const ids = new Set<string>();
			for (const item of snapshot.items) {
				if (
					!Number.isSafeInteger(item.revision) ||
					item.revision < 1 ||
					!Number.isFinite(item.updatedAt) ||
					!["candidate", "confirmed", "withdrawn"].includes(item.status)
				)
					throw new Error("Invalid memory snapshot");
				validateMemory({
					requestId: "restore",
					expectedRevision: item.revision,
					item: { ...item, status: item.status === "withdrawn" ? "candidate" : item.status },
				});
				const key = JSON.stringify([item.scope, item.id]);
				if (ids.has(key)) throw new Error("Duplicate memory snapshot identity");
				ids.add(key);
			}
			for (const entry of snapshot.receipts) {
				if (
					!entry.principalId ||
					!entry.requestId ||
					typeof entry.hash !== "string" ||
					entry.receipt?.requestId !== entry.requestId ||
					entry.receipt.state !== "committed" ||
					!Number.isSafeInteger(entry.receipt.revision) ||
					entry.receipt.revision < 1
				) {
					throw new Error("Invalid memory receipt snapshot");
				}
			}
		}
		this.state = structuredClone(
			snapshot ?? { tenantId: principal.tenantId, items: [], receipts: [], tombstones: [] },
		);
		this.persist = persist;
	}
	get snapshot(): MemorySnapshot {
		return structuredClone(this.state);
	}
	async get(scope: string, id: string): Promise<MemoryItem | undefined> {
		if (!this.principal.readScopes.includes(scope)) return undefined;
		const item = this.state.items.find(
			(candidate) => candidate.scope === scope && candidate.id === id && candidate.status !== "withdrawn",
		);
		return item ? structuredClone(item) : undefined;
	}
	async search(query: string, limit = 8): Promise<MemoryItem[]> {
		if (!query.trim() || query.length > 2000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new Error("Invalid memory query");
		}
		const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
		return this.state.items
			.filter(
				(item) =>
					item.status !== "withdrawn" &&
					this.principal.readScopes.includes(item.scope) &&
					words.every((word) =>
						`${item.abstract}\n${item.overview}\n${item.full}`.toLocaleLowerCase().includes(word),
					),
			)
			.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
			.slice(0, limit)
			.map((item) => structuredClone(item));
	}
	private replay(requestId: string, hash: string): MemoryReceipt | undefined {
		const previous = this.state.receipts.find(
			(entry) => entry.principalId === this.principal.principalId && entry.requestId === requestId,
		);
		if (!previous) return undefined;
		if (previous.hash !== hash) throw new Error("Memory idempotency conflict");
		requireWrite(this.principal, previous.receipt.scope);
		return structuredClone(previous.receipt);
	}
	private commit(next: MemorySnapshot, hash: string, receipt: MemoryReceipt): MemoryReceipt {
		next.receipts.push({ principalId: this.principal.principalId, requestId: receipt.requestId, hash, receipt });
		this.persist(structuredClone(next));
		this.state = next;
		return structuredClone(receipt);
	}
	async put(input: MemoryWrite): Promise<MemoryReceipt> {
		validateMemory(input);
		requireWrite(this.principal, input.item.scope);
		const hash = digest({ operation: "put", input });
		const prior = this.replay(input.requestId, hash);
		if (prior) return prior;
		const next = structuredClone(this.state);
		if (
			[contentFingerprint(input.item), sourceFingerprint(input.item)].some((hash) => next.tombstones.includes(hash))
		)
			throw new Error("Withdrawn content requires explicit restoration");
		const index = next.items.findIndex((item) => item.id === input.item.id && item.scope === input.item.scope);
		const previous = next.items[index];
		if ((previous?.revision ?? null) !== input.expectedRevision) throw new Error("Memory revision conflict");
		if (previous?.status === "withdrawn") throw new Error("Withdrawn memory cannot be silently restored");
		const item: MemoryItem = {
			...structuredClone(input.item),
			revision: (previous?.revision ?? 0) + 1,
			updatedAt: Date.now(),
		};
		if (index < 0) next.items.push(item);
		else next.items[index] = item;
		return this.commit(next, hash, {
			requestId: input.requestId,
			state: "committed",
			id: item.id,
			scope: item.scope,
			revision: item.revision,
		});
	}
	async withdraw(requestId: string, scope: string, id: string, expectedRevision: number): Promise<MemoryReceipt> {
		if (!requestId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
			throw new Error("Invalid withdrawal");
		requireWrite(this.principal, scope);
		const hash = digest({ operation: "withdraw", requestId, scope, id, expectedRevision });
		const prior = this.replay(requestId, hash);
		if (prior) return prior;
		const next = structuredClone(this.state);
		const item = next.items.find((entry) => entry.scope === scope && entry.id === id);
		if (!item || item.revision !== expectedRevision) throw new Error("Memory revision conflict");
		for (const fingerprint of [contentFingerprint(item), sourceFingerprint(item)]) {
			if (!next.tombstones.includes(fingerprint)) next.tombstones.push(fingerprint);
		}
		item.status = "withdrawn";
		item.revision++;
		item.updatedAt = Date.now();
		return this.commit(next, hash, { requestId, state: "committed", id, scope, revision: item.revision });
	}
	async list(scope: string, afterId = "", limit = 50): Promise<{ items: MemoryItem[]; nextId?: string }> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid page limit");
		if (!this.principal.readScopes.includes(scope)) return { items: [] };
		const available = this.state.items
			.filter((item) => item.scope === scope && item.status !== "withdrawn" && item.id > afterId)
			.sort((a, b) => (a.id < b.id ? -1 : 1));
		const items = available.slice(0, limit).map((item) => structuredClone(item));
		return { items, ...(available.length > limit ? { nextId: items.at(-1)?.id } : {}) };
	}
	async exportItems(): Promise<MemoryItem[]> {
		return this.state.items
			.filter((item) => this.principal.readScopes.includes(item.scope))
			.map((item) => structuredClone(item));
	}
}

/** Byte-budgeted, not tokenizer-exact. Whole entries only; candidates remain explicitly labelled. */
export function contextPack(
	items: MemoryItem[],
	options: { level: 0 | 1 | 2; maxBytes: number; confirmedOnly?: boolean },
): { text: string; usedBytes: number; omitted: number } {
	if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || ![0, 1, 2].includes(options.level)) {
		throw new Error("Invalid context budget");
	}
	const lines: string[] = [];
	let usedBytes = 0;
	let omitted = 0;
	for (const item of items) {
		if (item.status === "withdrawn" || (options.confirmedOnly && item.status !== "confirmed")) continue;
		const body = options.level === 0 ? item.abstract : options.level === 1 ? item.overview : item.full;
		const line = JSON.stringify({
			id: item.id,
			scope: item.scope,
			revision: item.revision,
			status: item.status,
			source: item.source,
			content: body,
		});
		const size = Buffer.byteLength(line, "utf8") + (lines.length ? 1 : 0);
		if (usedBytes + size > options.maxBytes) {
			omitted++;
			continue;
		}
		lines.push(line);
		usedBytes += size;
	}
	return { text: lines.join("\n"), usedBytes, omitted };
}

/** Overlaps the host-side capture filter in index.ts; kept local so the memory core stays dependency-free. */
export function sensitivePattern(value: string): boolean {
	return /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}|(?:password|api[_-]?key|secret)\s*[:=]\s*["']?[^\s"']{8,}/i.test(
		value,
	);
}

/** Necessary state for a tool result whose raw content stays outside the searchable corpus. */
export interface ControlledReference {
	resultRef: string;
	reason: "oversize" | "sensitive";
	bytes: number;
	contentDigest: string;
	tool: string;
	toolCallId: string;
	storedAt: number;
}

/**
 * Tool-result capture that never discards oversized or sensitive output: the memory item
 * stores only the controlled reference (digest, size, reason, pointer). Raw content stays
 * where the host already recorded it, or is copied through the injected saveRaw store
 * (for example the SkillRepository resultRef mechanism). Secrets never enter abstract,
 * overview, full text or any later index built from them.
 */
export async function controlledToolCapture(input: {
	toolName: string;
	toolCallId: string;
	content: string;
	id: string;
	scope: string;
	maxBytes?: number;
	saveRaw?: (content: string) => Promise<string>;
}): Promise<{ item: MemoryInput; reference?: ControlledReference; stored: "inline" | "controlled" }> {
	if (!input.toolName || !input.toolCallId || !input.id || !input.scope || typeof input.content !== "string") {
		throw new Error("Invalid tool capture input");
	}
	const bytes = Buffer.byteLength(input.content, "utf8");
	const oversize = bytes > (input.maxBytes ?? 65_536);
	const sensitive = !oversize && sensitivePattern(input.content);
	if (!oversize && !sensitive) {
		return {
			item: {
				id: input.id,
				scope: input.scope,
				kind: "evidence",
				status: "candidate",
				full: input.content,
				abstract: `Tool result: ${input.toolName}`,
				overview:
					input.content.length > 1000
						? `${input.content.slice(0, 1000)} [excerpt; read full record]`
						: input.content,
				source: { kind: "tool", ref: `tool:${input.toolCallId}` },
			},
			stored: "inline",
		};
	}
	const resultRef = input.saveRaw ? await input.saveRaw(input.content) : `pi-session-tool:${input.toolCallId}`;
	const reference: ControlledReference = {
		resultRef,
		reason: oversize ? "oversize" : "sensitive",
		bytes,
		contentDigest: digest(input.content),
		tool: input.toolName,
		toolCallId: input.toolCallId,
		storedAt: Date.now(),
	};
	const note =
		`Controlled reference: raw ${reference.reason} tool result (${bytes} bytes, digest ${reference.contentDigest}). ` +
		`Read it back through the controlled resultRef ${resultRef}; it is not part of searchable memory.`;
	return {
		item: {
			id: input.id,
			scope: input.scope,
			kind: "evidence",
			status: "candidate",
			full: JSON.stringify(reference),
			abstract: `Tool result ${input.toolName}: ${reference.reason} controlled reference (${bytes} bytes)`,
			overview: note,
			source: { kind: "tool", ref: resultRef },
		},
		reference,
		stored: "controlled",
	};
}

export interface MemoryAutomationSettings {
	autoRecall?: boolean;
	autoCapture?: boolean;
	autoEnrich?: boolean;
}
export interface MemorySettingsChain {
	tenant?: MemoryAutomationSettings;
	project?: MemoryAutomationSettings;
	role?: MemoryAutomationSettings;
}

/** Project/role (岗位) settings override tenant defaults key by key; unset keys inherit, all-off is the safe floor. */
export function resolveMemorySettings(chain: MemorySettingsChain): Required<MemoryAutomationSettings> {
	const levels = [chain.tenant, chain.project, chain.role];
	const pick = (key: keyof MemoryAutomationSettings): boolean => {
		for (let index = levels.length - 1; index >= 0; index--) {
			const value = levels[index]?.[key];
			if (value === undefined) continue;
			if (typeof value !== "boolean") throw new Error(`Memory setting ${key} must be boolean`);
			return value;
		}
		return true;
	};
	return { autoRecall: pick("autoRecall"), autoCapture: pick("autoCapture"), autoEnrich: pick("autoEnrich") };
}
