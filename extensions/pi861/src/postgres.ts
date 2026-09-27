import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LayeredMemoryState } from "./live/layered-memory.ts";
import type { StateStore } from "./live/store.ts";
import {
	checkPrincipal,
	contentFingerprint,
	digest,
	type MemoryBackend,
	type MemoryInput,
	type MemoryItem,
	type MemoryPrincipal,
	type MemoryReceipt,
	type MemoryWrite,
	requireWrite,
	sourceFingerprint,
	validateMemory,
} from "./memory.ts";

/** Compatible with an adapter around pg.Pool; no driver or secret is exposed to an LLM. */
export interface SqlConnection {
	query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
	release(): void;
}
export interface SqlPool {
	connect(): Promise<SqlConnection>;
}

/**
 * PostgreSQL authoritative store. Provision sql/memory-v1.sql separately.
 * All writes, revisions, outbox events and idempotency receipts commit together.
 */
export class PostgresMemory implements MemoryBackend {
	private readonly pool: SqlPool;
	private readonly principal: MemoryPrincipal;
	constructor(pool: SqlPool, principal: MemoryPrincipal) {
		checkPrincipal(principal);
		this.pool = pool;
		this.principal = structuredClone(principal);
	}
	private async transaction<T>(fn: (connection: SqlConnection) => Promise<T>): Promise<T> {
		const connection = await this.pool.connect();
		try {
			await connection.query("BEGIN");
			await connection.query(
				"SELECT set_config('pi861.tenant_id', $1, true), set_config('pi861.principal_id', $2, true), " +
					"set_config('pi861.read_scopes', $3, true), set_config('pi861.write_scopes', $4, true), " +
					"set_config('statement_timeout', '10000', true), set_config('lock_timeout', '5000', true)",
				[
					this.principal.tenantId,
					this.principal.principalId,
					JSON.stringify(this.principal.readScopes),
					JSON.stringify(this.principal.writeScopes),
				],
			);
			const result = await fn(connection);
			await connection.query("COMMIT");
			return result;
		} catch (error) {
			await connection.query("ROLLBACK").catch(() => {});
			throw error; // Caller retains requestId after an ambiguous COMMIT response.
		} finally {
			connection.release();
		}
	}
	async get(scope: string, id: string): Promise<MemoryItem | undefined> {
		if (!this.principal.readScopes.includes(scope)) return undefined;
		return this.transaction(async (connection) => {
			const result = await connection.query(
				"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3 " +
					"AND body->>'status' <> 'withdrawn'",
				[this.principal.tenantId, scope, id],
			);
			return result.rows[0] ? structuredClone(result.rows[0].body as MemoryItem) : undefined;
		});
	}
	async search(query: string, limit = 8): Promise<MemoryItem[]> {
		if (!query.trim() || query.length > 2000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new Error("Invalid memory query");
		}
		return this.transaction(async (connection) => {
			const result = await connection.query(
				"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=ANY($2::text[]) " +
					"AND body->>'status' <> 'withdrawn' AND " +
					"(to_tsvector('simple', coalesce(body->>'full','')) @@ plainto_tsquery('simple',$3) " +
					"OR strpos(lower(body->>'full'),lower($3)) > 0) ORDER BY updated_at DESC, memory_id LIMIT $4",
				[this.principal.tenantId, this.principal.readScopes, query.trim(), limit],
			);
			return result.rows.map((row) => structuredClone(row.body as MemoryItem));
		});
	}
	private async mutate(
		requestId: string,
		scope: string,
		id: string,
		expectedRevision: number | null,
		item: MemoryInput | undefined,
	): Promise<MemoryReceipt> {
		requireWrite(this.principal, scope);
		const hash = digest({ requestId, scope, id, expectedRevision, item: item ?? null });
		return this.transaction(async (connection) => {
			// Fixed ordering prevents receipt races followed by scope-write races.
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				JSON.stringify([this.principal.tenantId, this.principal.principalId, requestId]),
			]);
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				JSON.stringify([this.principal.tenantId, scope]),
			]);
			const stored = await connection.query(
				"SELECT intent_hash, receipt FROM pi861_memory_receipts WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3",
				[this.principal.tenantId, this.principal.principalId, requestId],
			);
			const replay = stored.rows[0];
			if (replay) {
				if (replay.intent_hash !== hash) throw new Error("Memory idempotency conflict");
				return structuredClone(replay.receipt as MemoryReceipt);
			}
			const result = await connection.query(
				"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3 FOR UPDATE",
				[this.principal.tenantId, scope, id],
			);
			const previous = result.rows[0]?.body as MemoryItem | undefined;
			if ((previous?.revision ?? null) !== expectedRevision) throw new Error("Memory revision conflict");
			let next: MemoryItem;
			if (item) {
				const suppressed = await connection.query(
					"SELECT fingerprint FROM pi861_memory_tombstones WHERE tenant_id=$1 AND scope_key=$2 AND fingerprint=ANY($3::text[])",
					[this.principal.tenantId, scope, [contentFingerprint(item), sourceFingerprint(item)]],
				);
				if (suppressed.rows.length || previous?.status === "withdrawn")
					throw new Error("Withdrawn memory requires explicit restoration");
				next = { ...structuredClone(item), revision: (previous?.revision ?? 0) + 1, updatedAt: Date.now() };
			} else {
				if (!previous) throw new Error("Memory not found");
				next = { ...previous, status: "withdrawn", revision: previous.revision + 1, updatedAt: Date.now() };
				for (const fingerprint of [contentFingerprint(previous), sourceFingerprint(previous)]) {
					await connection.query(
						"INSERT INTO pi861_memory_tombstones(tenant_id,scope_key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
						[this.principal.tenantId, scope, fingerprint],
					);
				}
			}
			await connection.query(
				"INSERT INTO pi861_memory_items(tenant_id,scope_key,memory_id,revision,body,fingerprint) " +
					"VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,scope_key,memory_id) " +
					"DO UPDATE SET revision=EXCLUDED.revision,body=EXCLUDED.body,fingerprint=EXCLUDED.fingerprint,updated_at=clock_timestamp()",
				[this.principal.tenantId, scope, id, next.revision, JSON.stringify(next), contentFingerprint(next)],
			);
			await connection.query(
				"INSERT INTO pi861_memory_versions(tenant_id,scope_key,memory_id,revision,body) VALUES($1,$2,$3,$4,$5::jsonb)",
				[this.principal.tenantId, scope, id, next.revision, JSON.stringify(next)],
			);
			await connection.query(
				"INSERT INTO pi861_memory_outbox(tenant_id,scope_key,memory_id,revision,action) VALUES($1,$2,$3,$4,$5)",
				[this.principal.tenantId, scope, id, next.revision, item ? "index" : "withdraw"],
			);
			const receipt: MemoryReceipt = { requestId, state: "committed", id, scope, revision: next.revision };
			await connection.query(
				"INSERT INTO pi861_memory_receipts(tenant_id,principal_id,request_id,scope_key,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
				[this.principal.tenantId, this.principal.principalId, requestId, scope, hash, JSON.stringify(receipt)],
			);
			return receipt;
		});
	}
	async put(input: MemoryWrite): Promise<MemoryReceipt> {
		validateMemory(input);
		return this.mutate(input.requestId, input.item.scope, input.item.id, input.expectedRevision, input.item);
	}
	async withdraw(requestId: string, scope: string, id: string, expectedRevision: number): Promise<MemoryReceipt> {
		if (!requestId || !id || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
			throw new Error("Invalid withdrawal");
		}
		return this.mutate(requestId, scope, id, expectedRevision, undefined);
	}
	async list(scope: string, afterId = "", limit = 50): Promise<{ items: MemoryItem[]; nextId?: string }> {
		if (!this.principal.readScopes.includes(scope)) return { items: [] };
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof afterId !== "string")
			throw new Error("Invalid page limit");
		return this.transaction(async (connection) => {
			const result = await connection.query(
				"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND body->>'status' <> 'withdrawn' " +
					"AND memory_id > $3 ORDER BY memory_id LIMIT $4",
				[this.principal.tenantId, scope, afterId, limit + 1],
			);
			const rows = result.rows.slice(0, limit);
			const items = rows.map((row) => structuredClone(row.body as MemoryItem));
			return { items, ...(result.rows.length > limit ? { nextId: items.at(-1)?.id } : {}) };
		});
	}
	/** All items in read scopes including withdrawn ones; authority reconciliation and migration verification, not a general read path. */
	async exportItems(): Promise<MemoryItem[]> {
		return this.transaction(async (connection) => {
			const result = await connection.query(
				"SELECT scope_key, memory_id, body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=ANY($2::text[]) " +
					"ORDER BY scope_key, memory_id",
				[this.principal.tenantId, this.principal.readScopes],
			);
			return result.rows.map((row) => structuredClone(row.body as MemoryItem));
		});
	}
	/**
	 * Idempotent adoption of an exact stored record (body, revision, updatedAt) for the explicit
	 * migration from a JSON-snapshot authority. Emits the same outbox events as a live write so
	 * derived indexes learn about adopted items; no caller receipt is created.
	 */
	async adopt(item: MemoryItem): Promise<void> {
		requireWrite(this.principal, item.scope);
		if (
			!Number.isSafeInteger(item.revision) ||
			item.revision < 1 ||
			!Number.isFinite(item.updatedAt) ||
			!item.id ||
			!item.scope ||
			!["candidate", "confirmed", "withdrawn"].includes(item.status)
		)
			throw new Error("Invalid adoption record");
		validateMemory({
			requestId: "adopt",
			expectedRevision: item.revision,
			item: { ...item, status: item.status === "withdrawn" ? "candidate" : item.status },
		});
		await this.transaction(async (connection) => {
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				JSON.stringify([this.principal.tenantId, item.scope]),
			]);
			await connection.query(
				"INSERT INTO pi861_memory_items(tenant_id,scope_key,memory_id,revision,body,fingerprint) " +
					"VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,scope_key,memory_id) " +
					"DO UPDATE SET revision=EXCLUDED.revision,body=EXCLUDED.body,fingerprint=EXCLUDED.fingerprint,updated_at=clock_timestamp()",
				[
					this.principal.tenantId,
					item.scope,
					item.id,
					item.revision,
					JSON.stringify(item),
					contentFingerprint(item),
				],
			);
			await connection.query(
				"INSERT INTO pi861_memory_versions(tenant_id,scope_key,memory_id,revision,body) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING",
				[this.principal.tenantId, item.scope, item.id, item.revision, JSON.stringify(item)],
			);
			if (item.status === "withdrawn") {
				for (const fingerprint of [contentFingerprint(item), sourceFingerprint(item)]) {
					await connection.query(
						"INSERT INTO pi861_memory_tombstones(tenant_id,scope_key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
						[this.principal.tenantId, item.scope, fingerprint],
					);
				}
			}
			await connection.query(
				"INSERT INTO pi861_memory_outbox(tenant_id,scope_key,memory_id,revision,action) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
				[
					this.principal.tenantId,
					item.scope,
					item.id,
					item.revision,
					item.status === "withdrawn" ? "withdraw" : "index",
				],
			);
		});
	}
}

export interface MemoryOutboxEvent {
	tenantId: string;
	scope: string;
	memoryId: string;
	revision: number;
	action: "index" | "withdraw";
}

/**
 * Outbox consumer for derived-index rebuilds: a queued event only disappears after the
 * apply callback accepted it. Handler failure rolls the transaction back, so the row stays
 * queued. Handlers must be idempotent: apply runs before the delete commits.
 */
export class OutboxConsumer {
	private readonly pool: SqlPool;
	private readonly identity: { tenantId: string; principalId: string; readScopes: string[]; writeScopes: string[] };
	constructor(
		pool: SqlPool,
		identity: { tenantId: string; principalId: string; readScopes: string[]; writeScopes: string[] },
	) {
		checkPrincipal(identity);
		this.pool = pool;
		this.identity = structuredClone(identity);
	}
	async consume(limit: number, apply: (event: MemoryOutboxEvent) => Promise<void>): Promise<{ processed: number }> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid outbox batch size");
		const connection = await this.pool.connect();
		try {
			await connection.query("BEGIN");
			await connection.query(
				"SELECT set_config('pi861.tenant_id', $1, true), set_config('pi861.principal_id', $2, true), " +
					"set_config('pi861.read_scopes', $3, true), set_config('pi861.write_scopes', $4, true), " +
					"set_config('statement_timeout', '10000', true), set_config('lock_timeout', '5000', true)",
				[
					this.identity.tenantId,
					this.identity.principalId,
					JSON.stringify(this.identity.readScopes),
					JSON.stringify(this.identity.writeScopes),
				],
			);
			const selected = await connection.query(
				"SELECT scope_key, memory_id, revision, action FROM pi861_memory_outbox WHERE tenant_id=$1 " +
					"ORDER BY created_at, scope_key, memory_id, revision LIMIT $2 FOR UPDATE SKIP LOCKED",
				[this.identity.tenantId, limit],
			);
			const events: MemoryOutboxEvent[] = selected.rows.map((row) => ({
				tenantId: this.identity.tenantId,
				scope: String(row.scope_key),
				memoryId: String(row.memory_id),
				revision: Number(row.revision),
				action: row.action === "withdraw" ? "withdraw" : "index",
			}));
			for (const event of events) await apply(event);
			for (const event of events) {
				await connection.query(
					"DELETE FROM pi861_memory_outbox WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3 AND revision=$4",
					[event.tenantId, event.scope, event.memoryId, event.revision],
				);
			}
			await connection.query("COMMIT");
			return { processed: events.length };
		} catch (error) {
			await connection.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			connection.release();
		}
	}
}

export interface MemoryMigrationReport {
	source: string;
	itemsMigrated: number;
	withdrawnMigrated: number;
	tombstonesMigrated: number;
	receiptsDropped: number;
	sourceDigest: string;
	targetDigest: string;
	verified: boolean;
	backupPath: string;
	cutOver: boolean;
}

/**
 * Explicit one-time migration from a JSON-snapshot authority (FileStateStore or PostgresStateStore
 * holding a LayeredMemoryState) to the per-record PostgreSQL model, which is the single authority
 * afterwards. Records source and counts, verifies item count and a canonical digest, keeps a full
 * backup file and only then empties the old snapshot. Old receipts have no per-record equivalent
 * and are dropped (counted). Quiesce writers before running; re-running is idempotent.
 */
export async function migrateMemoryAuthority(
	source: StateStore<LayeredMemoryState>,
	target: PostgresMemory,
	options: { backupPath: string; sourceLabel?: string },
): Promise<MemoryMigrationReport> {
	if (!options?.backupPath) throw new Error("Backup path required");
	const state = await source.read();
	if (state?.format !== 1 || !Array.isArray(state.memory?.items) || !Array.isArray(state.memory?.tombstones)) {
		throw new Error("Source is not a layered memory state");
	}
	const items = [...state.memory.items].sort((a, b) =>
		a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.id < b.id ? -1 : 1,
	);
	const derivedTombstones = new Set<string>();
	for (const item of items) {
		if (item.status === "withdrawn") {
			derivedTombstones.add(contentFingerprint(item));
			derivedTombstones.add(sourceFingerprint(item));
		}
	}
	// Tombstones must be explainable by withdrawn items; unexplained fingerprints need manual review, not a silent copy.
	const unexplained = state.memory.tombstones.filter((fingerprint) => !derivedTombstones.has(fingerprint));
	if (unexplained.length)
		throw new Error(
			`Source contains ${unexplained.length} tombstone(s) not derived from withdrawn items; review before migrating`,
		);
	for (const item of items) await target.adopt(item);
	const byScopeAndId = (a: MemoryItem, b: MemoryItem) =>
		a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.id < b.id ? -1 : 1;
	const exported = (await target.exportItems()).sort(byScopeAndId);
	// Per-item exact verification: every source record must exist in the target with an identical
	// body, which keeps a re-run after cutover (empty source) a verified no-op instead of a
	// spurious count mismatch, while a diverged target still fails closed.
	const matched = exported.filter((stored) => {
		const origin = items.find((candidate) => candidate.scope === stored.scope && candidate.id === stored.id);
		return origin !== undefined && digest(origin) === digest(stored);
	});
	const sourceDigest = digest(items);
	const targetDigest = digest(matched);
	const verified = matched.length === items.length;
	if (!verified)
		throw new Error(
			`Migration verification failed: ${matched.length}/${items.length} source item(s) matched exactly; nothing was cut over`,
		);
	// Durable backup of the complete old authority before the snapshot is emptied.
	mkdirSync(dirname(options.backupPath), { recursive: true, mode: 0o700 });
	const temporary = `${options.backupPath}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(state), "utf8");
		renameSync(temporary, options.backupPath);
	} finally {
		rmSync(temporary, { force: true });
	}
	// Cutover: the state store keeps only control state (jobs, projections, changes); items stop being double authority.
	await source.update((current) => {
		current.memory = { tenantId: current.memory.tenantId, items: [], receipts: [], tombstones: [] };
	});
	return {
		source: options.sourceLabel ?? "layered memory state",
		itemsMigrated: items.length,
		withdrawnMigrated: items.filter((item) => item.status === "withdrawn").length,
		tombstonesMigrated: derivedTombstones.size,
		receiptsDropped: state.memory.receipts.length,
		sourceDigest,
		targetDigest,
		verified: true,
		backupPath: options.backupPath,
		cutOver: true,
	};
}
