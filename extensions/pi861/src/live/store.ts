import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
		return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as T) : structuredClone(this.initial);
	}
	async update<R>(change: (state: T) => R | Promise<R>): Promise<R> {
		const lock = `${this.path}.lock`;
		const start = Date.now();
		let acquired = false;
		while (!acquired) {
			try {
				mkdirSync(lock, { mode: 0o700 });
				acquired = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (Date.now() - start >= this.timeoutMs)
					throw new Error(`State lock unavailable for ${this.path}; inspect abandoned owner before recovery`);
				await sleep(10);
			}
		}
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			const state = await this.read();
			const result = await change(state);
			const bytes = JSON.stringify(state);
			const fd = openSync(temporary, "wx", 0o600);
			try {
				writeFileSync(fd, bytes, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(temporary, this.path);
			// POSIX requires syncing the directory to durably publish the rename.
			if (process.platform !== "win32") {
				const directory = openSync(dirname(this.path), "r");
				try {
					fsyncSync(directory);
				} finally {
					closeSync(directory);
				}
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
		this.pool = pool;
		this.tenant = tenant;
		this.key = key;
		this.initial = structuredClone(initial);
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
			await connection.query(
				"SELECT set_config('pi861.tenant_id',$1,true), set_config('lock_timeout','5000',true), set_config('statement_timeout','10000',true)",
				[this.tenant],
			);
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				JSON.stringify([this.tenant, this.key]),
			]);
			const selected = await connection.query(
				"SELECT body FROM pi861_runtime_state WHERE tenant_id=$1 AND state_key=$2 FOR UPDATE",
				[this.tenant, this.key],
			);
			const state = selected.rows[0] ? structuredClone(selected.rows[0].body as T) : structuredClone(this.initial);
			const result = change ? await change(state) : state;
			if (change)
				await connection.query(
					"INSERT INTO pi861_runtime_state(tenant_id,state_key,body) VALUES($1,$2,$3::jsonb) ON CONFLICT(tenant_id,state_key) DO UPDATE SET body=EXCLUDED.body, updated_at=clock_timestamp()",
					[this.tenant, this.key, JSON.stringify(state)],
				);
			await connection.query("COMMIT");
			return structuredClone(result);
		} catch (error) {
			await connection.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			connection.release();
		}
	}
}

export interface DeadLetterState {
	reason: string;
	at: number;
}
export type PendingMemoryOperation =
	| {
			kind: "put";
			queuedAt: number;
			reason: string;
			critical: boolean;
			input: MemoryWrite;
			failures?: number;
			dead?: DeadLetterState;
	  }
	| {
			kind: "withdraw";
			queuedAt: number;
			reason: string;
			critical: boolean;
			requestId: string;
			scope: string;
			id: string;
			expectedRevision: number;
			failures?: number;
			dead?: DeadLetterState;
	  };

/** A terminally failed queue entry parked for a human decision; visible through pendingReport() and removable with abandonPending(). */
export interface PendingDeadLetter {
	requestId: string;
	kind: "put" | "withdraw";
	scope: string;
	id: string;
	critical: boolean;
	queuedAt: number;
	failures: number;
	reason: string;
	deadAt: number;
}

/**
 * Database-unavailable buffer: failed writes become explicitly uncommitted local records
 * instead of being dropped. flush() replays the original requestId, so an ambiguous commit
 * confirms rather than duplicates. Reads still fail honestly; a pending record is never
 * presented as a shared commit.
 */
export class ResilientBackend implements MemoryBackend {
	private readonly backend: MemoryBackend;
	private readonly store: StateStore<{ pending: PendingMemoryOperation[] }>;
	private readonly deadLetterAfter: number;
	private flushChain: Promise<unknown> = Promise.resolve();
	constructor(
		backend: MemoryBackend,
		store: StateStore<{ pending: PendingMemoryOperation[] }>,
		options: { deadLetterAfter?: number } = {},
	) {
		this.backend = backend;
		this.store = store;
		this.deadLetterAfter = options.deadLetterAfter ?? 3;
		if (!Number.isSafeInteger(this.deadLetterAfter) || this.deadLetterAfter < 1 || this.deadLetterAfter > 100) {
			throw new Error("Invalid dead-letter threshold");
		}
	}
	private queue(operation: PendingMemoryOperation): Promise<void> {
		return this.store.update((state) => {
			state.pending.push(operation);
		});
	}
	async put(input: MemoryWrite, options: { critical?: boolean } = {}): Promise<MemoryReceipt> {
		try {
			const receipt = await this.backend.put(input);
			void this.flush().catch(() => {}); // opportunistic drain, never blocks the caller
			return receipt;
		} catch (error) {
			await this.queue({
				kind: "put",
				queuedAt: Date.now(),
				reason: reasonOf(error),
				critical: options.critical === true,
				input: structuredClone(input),
			});
			return {
				requestId: input.requestId,
				state: "pending",
				id: input.item.id,
				scope: input.item.scope,
				revision: input.expectedRevision ?? 0,
			};
		}
	}
	async withdraw(
		requestId: string,
		scope: string,
		id: string,
		expectedRevision: number,
		options: { critical?: boolean } = {},
	): Promise<MemoryReceipt> {
		try {
			const receipt = await this.backend.withdraw(requestId, scope, id, expectedRevision);
			void this.flush().catch(() => {});
			return receipt;
		} catch (error) {
			await this.queue({
				kind: "withdraw",
				queuedAt: Date.now(),
				reason: reasonOf(error),
				critical: options.critical === true,
				requestId,
				scope,
				id,
				expectedRevision,
			});
			return { requestId, state: "pending", id, scope, revision: expectedRevision };
		}
	}
	async get(scope: string, id: string): Promise<MemoryItem | undefined> {
		return this.backend.get(scope, id);
	}
	async search(query: string, limit?: number): Promise<MemoryItem[]> {
		return this.backend.search(query, limit);
	}
	async list(scope: string, afterId = "", limit = 50): Promise<{ items: MemoryItem[]; nextId?: string }> {
		if (!this.backend.list) throw new Error("Buffered backend does not support listing");
		return this.backend.list(scope, afterId, limit);
	}
	/**
	 * Replays queued operations oldest-first with their original requestIds, so an ambiguous
	 * commit confirms rather than duplicates. Serialized per instance: concurrent callers queue
	 * up instead of both consuming the same head and dropping the entries behind it. A head that
	 * keeps failing crosses deadLetterAfter and is parked as a dead letter (pendingReport lists
	 * it) instead of blocking every later entry.
	 */
	async flush(): Promise<{ committed: number; remaining: number }> {
		const run = this.flushChain.then(
			() => this.flushOnce(),
			() => this.flushOnce(),
		);
		this.flushChain = run.catch(() => {});
		return run;
	}
	private async flushOnce(): Promise<{ committed: number; remaining: number }> {
		let committed = 0;
		while (true) {
			const head = (await this.store.read()).pending.find((entry) => !entry.dead);
			if (!head) break;
			try {
				if (head.kind === "put") await this.backend.put(head.input);
				else await this.backend.withdraw(head.requestId, head.scope, head.id, head.expectedRevision);
			} catch (error) {
				if (!(await this.recordFailure(head, error))) break; // still under the threshold: retry on a later flush
				continue; // freshly dead-lettered: the rest of the queue still drains now
			}
			await this.store.update((state) => {
				const index = state.pending.findIndex((entry) => sameOperation(entry, head));
				if (index >= 0) state.pending.splice(index, 1);
			});
			committed++;
		}
		const pending = (await this.store.read()).pending;
		return { committed, remaining: pending.filter((entry) => !entry.dead).length };
	}
	/** Counts one flush failure for the entry and parks it as a dead letter once the threshold is crossed. */
	private async recordFailure(head: PendingMemoryOperation, error: unknown): Promise<boolean> {
		const failures = (head.failures ?? 0) + 1;
		const dead = failures >= this.deadLetterAfter;
		await this.store.update((state) => {
			const entry = state.pending.find((candidate) => sameOperation(candidate, head));
			if (!entry) return;
			entry.failures = failures;
			if (dead && !entry.dead) entry.dead = { reason: reasonOf(error), at: Date.now() };
		});
		return dead;
	}
	async pendingReport(): Promise<{
		count: number;
		critical: number;
		oldestQueuedAt: number | undefined;
		reasons: string[];
		dead: PendingDeadLetter[];
	}> {
		const pending = (await this.store.read()).pending;
		return {
			count: pending.length,
			critical: pending.filter((entry) => entry.critical).length,
			oldestQueuedAt: pending[0]?.queuedAt,
			reasons: [...new Set(pending.map((entry) => entry.reason))],
			dead: pending.flatMap((entry) =>
				entry.dead
					? [
							{
								requestId: requestIdOf(entry),
								kind: entry.kind,
								scope: entry.kind === "put" ? entry.input.item.scope : entry.scope,
								id: entry.kind === "put" ? entry.input.item.id : entry.id,
								critical: entry.critical,
								queuedAt: entry.queuedAt,
								failures: entry.failures ?? 0,
								reason: entry.dead.reason,
								deadAt: entry.dead.at,
							},
						]
					: [],
			),
		};
	}
	/** Manual dead-letter entry: drops a terminally failed operation after human review. Live entries stay queued. */
	async abandonPending(requestId: string): Promise<boolean> {
		if (!requestId) throw new Error("Request id required");
		return this.store.update((state) => {
			const index = state.pending.findIndex((entry) => requestIdOf(entry) === requestId && entry.dead);
			if (index < 0) return false;
			state.pending.splice(index, 1);
			return true;
		});
	}
	/** Execution-boundary gate: critical records that are not committed yet pause the named checkpoint. */
	async assertCommitted(boundary: string): Promise<void> {
		const report = await this.pendingReport();
		if (report.critical > 0) {
			throw new Error(
				`Checkpoint "${boundary}" paused: ${report.critical} critical memory record(s) still uncommitted (first queued ${report.oldestQueuedAt})`,
			);
		}
	}
}

function reasonOf(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
function requestIdOf(entry: PendingMemoryOperation): string {
	return entry.kind === "put" ? entry.input.requestId : entry.requestId;
}
function sameOperation(left: PendingMemoryOperation, right: PendingMemoryOperation): boolean {
	return left.kind === right.kind && requestIdOf(left) === requestIdOf(right);
}
