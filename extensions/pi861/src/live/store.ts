import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { MemoryBackend, MemoryItem, MemoryReceipt, MemoryWrite } from "../memory.ts";
import type { SqlPool } from "../postgres.ts";

export interface StateStore<T> {
	read(): Promise<T>;
	update<R>(change: (state: T) => R | Promise<R>): Promise<R>;
}

/** Mutation callbacks may await local work only: never call inference or remote tools under a storage lock. */
export class FileStateStore<T> implements StateStore<T> {
	readonly path: string;
	private readonly initial: T;
	private readonly timeoutMs: number;
	constructor(path: string, initial: T, timeoutMs = 5000) {
		this.path = resolve(path);
		this.initial = structuredClone(initial);
		this.timeoutMs = timeoutMs;
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
	}
	async read(): Promise<T> {
		return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) as T : structuredClone(this.initial);
	}
	async update<R>(change: (state: T) => R | Promise<R>): Promise<R> {
		const lock = `${this.path}.lock`;
		const start = Date.now();
		let acquired = false;
		while (!acquired) {
			try { mkdirSync(lock, { mode: 0o700 }); acquired = true; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (Date.now() - start >= this.timeoutMs) throw new Error("State lock unavailable; inspect abandoned owner before recovery");
				await sleep(10);
			}
		}
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			const state = await this.read();
			const result = await change(state);
			const bytes = JSON.stringify(state);
			const fd = openSync(temporary, "wx", 0o600);
			try { writeFileSync(fd, bytes, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
			renameSync(temporary, this.path);
			// POSIX requires syncing the directory to durably publish the rename.
			if (process.platform !== "win32") {
				const directory = openSync(dirname(this.path), "r");
				try { fsyncSync(directory); } finally { closeSync(directory); }
			}
			return structuredClone(result);
		} finally {
			rmSync(temporary, { force: true });
			rmSync(lock, { recursive: true });
		}
	}
}

/** For trusted services only. Callers cannot choose tenant/key through model tool arguments. */
export class PostgresStateStore<T> implements StateStore<T> {
	private readonly pool: SqlPool;
	private readonly tenant: string;
	private readonly key: string;
	private readonly initial: T;
	constructor(pool: SqlPool, tenant: string, key: string, initial: T) {
		if (!tenant || !key) throw new Error("Stable state identity required");
		this.pool = pool; this.tenant = tenant; this.key = key; this.initial = structuredClone(initial);
	}
	async read(): Promise<T> {
		return this.transaction(undefined);
	}
	async update<R>(change: (state: T) => R | Promise<R>): Promise<R> {
		return this.transaction(change);
	}
	private async transaction<R>(change: ((state: T) => R | Promise<R>) | undefined): Promise<R>;
	private async transaction(change: undefined): Promise<T>;
	private async transaction<R>(change: ((state: T) => R | Promise<R>) | undefined): Promise<R | T> {
		const connection = await this.pool.connect();
		try {
			await connection.query("BEGIN");
			await connection.query("SELECT set_config('pi861.tenant_id',$1,true), set_config('lock_timeout','5000',true), set_config('statement_timeout','10000',true)", [this.tenant]);
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([this.tenant, this.key])]);
			const selected = await connection.query("SELECT body FROM pi861_runtime_state WHERE tenant_id=$1 AND state_key=$2 FOR UPDATE", [this.tenant, this.key]);
			const state = selected.rows[0] ? structuredClone(selected.rows[0].body as T) : structuredClone(this.initial);
			const result = change ? await change(state) : state;
			if (change) await connection.query("INSERT INTO pi861_runtime_state(tenant_id,state_key,body) VALUES($1,$2,$3::jsonb) ON CONFLICT(tenant_id,state_key) DO UPDATE SET body=EXCLUDED.body, updated_at=clock_timestamp()", [this.tenant, this.key, JSON.stringify(state)]);
			await connection.query("COMMIT");
			return structuredClone(result);
		} catch (error) { await connection.query("ROLLBACK").catch(() => {}); throw error; }
		finally { connection.release(); }
	}
}

export type PendingMemoryOperation =
	| { kind: "put"; queuedAt: number; reason: string; critical: boolean; input: MemoryWrite }
	| { kind: "withdraw"; queuedAt: number; reason: string; critical: boolean; requestId: string; scope: string; id: string; expectedRevision: number };

/**
 * Database-unavailable buffer: failed writes become explicitly uncommitted local records
 * instead of being dropped. flush() replays the original requestId, so an ambiguous commit
 * confirms rather than duplicates. Reads still fail honestly; a pending record is never
 * presented as a shared commit.
 */
export class ResilientBackend implements MemoryBackend {
	private readonly backend: MemoryBackend;
	private readonly store: StateStore<{ pending: PendingMemoryOperation[] }>;
	constructor(backend: MemoryBackend, store: StateStore<{ pending: PendingMemoryOperation[] }>) {
		this.backend = backend;
		this.store = store;
	}
	private queue(operation: PendingMemoryOperation): Promise<void> {
		return this.store.update((state) => { state.pending.push(operation); });
	}
	async put(input: MemoryWrite, options: { critical?: boolean } = {}): Promise<MemoryReceipt> {
		try {
			const receipt = await this.backend.put(input);
			void this.flush().catch(() => {}); // opportunistic drain, never blocks the caller
			return receipt;
		} catch (error) {
			await this.queue({ kind: "put", queuedAt: Date.now(), reason: reasonOf(error), critical: options.critical === true,
				input: structuredClone(input) });
			return { requestId: input.requestId, state: "pending", id: input.item.id, scope: input.item.scope, revision: input.expectedRevision ?? 0 };
		}
	}
	async withdraw(requestId: string, scope: string, id: string, expectedRevision: number, options: { critical?: boolean } = {}): Promise<MemoryReceipt> {
		try {
			const receipt = await this.backend.withdraw(requestId, scope, id, expectedRevision);
			void this.flush().catch(() => {});
			return receipt;
		} catch (error) {
			await this.queue({ kind: "withdraw", queuedAt: Date.now(), reason: reasonOf(error), critical: options.critical === true,
				requestId, scope, id, expectedRevision });
			return { requestId, state: "pending", id, scope, revision: expectedRevision };
		}
	}
	async get(scope: string, id: string): Promise<MemoryItem | undefined> { return this.backend.get(scope, id); }
	async search(query: string, limit?: number): Promise<MemoryItem[]> { return this.backend.search(query, limit); }
	async list(scope: string, afterId = "", limit = 50): Promise<{ items: MemoryItem[]; nextId?: string }> {
		if (!this.backend.list) throw new Error("Buffered backend does not support listing");
		return this.backend.list(scope, afterId, limit);
	}
	/** Replays queued operations oldest-first with their original requestIds; stops at the first failure. */
	async flush(): Promise<{ committed: number; remaining: number }> {
		let committed = 0;
		while (true) {
			const head = (await this.store.read()).pending[0];
			if (!head) break;
			try {
				if (head.kind === "put") await this.backend.put(head.input);
				else await this.backend.withdraw(head.requestId, head.scope, head.id, head.expectedRevision);
			} catch { break; }
			await this.store.update((state) => { state.pending.shift(); });
			committed++;
		}
		return { committed, remaining: (await this.store.read()).pending.length };
	}
	async pendingReport(): Promise<{ count: number; critical: number; oldestQueuedAt: number | undefined; reasons: string[] }> {
		const pending = (await this.store.read()).pending;
		return {
			count: pending.length,
			critical: pending.filter((entry) => entry.critical).length,
			oldestQueuedAt: pending[0]?.queuedAt,
			reasons: [...new Set(pending.map((entry) => entry.reason))],
		};
	}
	/** Execution-boundary gate: critical records that are not committed yet pause the named checkpoint. */
	async assertCommitted(boundary: string): Promise<void> {
		const report = await this.pendingReport();
		if (report.critical > 0) {
			throw new Error(`Checkpoint "${boundary}" paused: ${report.critical} critical memory record(s) still uncommitted (first queued ${report.oldestQueuedAt})`);
		}
	}
}

function reasonOf(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
