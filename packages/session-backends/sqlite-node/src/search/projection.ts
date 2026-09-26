import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	SearchEntryHit,
	SearchEntryOptions,
	SearchIndexBatch,
	SearchSessionQuery,
	SearchSessionResult,
	SessionSearchService,
	SessionSearchSyncTarget,
} from "@earendil-works/pi-agent-core";
import { joinSqlFragments, type SqlQuery, sql } from "../sqlite/sql.ts";
import type { SqliteDatabase, SqliteDatabaseFactory } from "../sqlite/types.ts";

interface CursorRow {
	store_generation: number;
	last_seq: number;
}

interface EntryHitRow {
	sessionId: string;
	entryId: string;
	timestamp: number;
	snippet: string;
	score: number;
}

export interface SqliteSessionSearchOptions {
	/** File path of the standalone projection database. Parent directories are created. */
	path: string;
	databaseFactory: SqliteDatabaseFactory;
}

/** One standalone SQLite search projection acting as both query service and sync target. */
export interface SqliteSessionSearch extends SessionSearchService, SessionSearchSyncTarget {}

/** Throws when the SQLite build lacks the FTS5 extension this projection requires. */
function assertFts5Available(db: SqliteDatabase): void {
	try {
		db.exec("CREATE VIRTUAL TABLE temp.pi_search_fts5_probe USING fts5(x)");
	} catch (error) {
		throw new Error(
			"SQLite FTS5 is not available; the session search projection requires an FTS5-enabled SQLite build",
			{ cause: error },
		);
	} finally {
		db.exec("DROP TABLE IF EXISTS temp.pi_search_fts5_probe");
	}
}

async function applySearchSchema(db: SqliteDatabase): Promise<void> {
	const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
	db.exec(schema);
}

/**
 * Deterministic FTS5 match expression: every whitespace-separated token becomes a quoted
 * string, so arbitrary user text never produces FTS5 query syntax errors and tokens combine
 * with implicit AND semantics.
 */
function ftsMatchExpression(text: string): string {
	return text
		.split(/\s+/)
		.filter((token) => token !== "")
		.map((token) => `"${token.replaceAll('"', '""')}"`)
		.join(" ");
}

class SqliteSessionSearchProjection implements SqliteSessionSearch {
	private readonly db: SqliteDatabase;
	private closed = false;

	constructor(db: SqliteDatabase) {
		this.db = db;
	}

	async listSessions(): Promise<string[]> {
		this.assertOpen();
		return sql`SELECT session_id FROM search_sessions ORDER BY session_id`
			.all<{ session_id: string }>(this.db)
			.map((row) => row.session_id);
	}

	async getCursor(sessionId: string, storeGeneration: number): Promise<number> {
		this.assertOpen();
		this.db.transaction(() => this.resetForNewerGeneration(sessionId, storeGeneration));
		const row = this.readCursor(sessionId);
		return row === undefined ? 0 : row.last_seq;
	}

	async indexBatch(batch: SearchIndexBatch): Promise<void> {
		this.assertOpen();
		this.db.transaction(() => {
			this.resetForNewerGeneration(batch.sessionId, batch.storeGeneration);
			const cursor = this.readCursor(batch.sessionId);
			// A batch from a stale generation cannot regress a newer cursor or rows.
			if (cursor !== undefined && cursor.store_generation > batch.storeGeneration) return;
			sql`INSERT INTO search_sessions (session_id, cwd) VALUES (${batch.sessionId}, ${batch.cwd ?? null})
				ON CONFLICT(session_id) DO UPDATE SET cwd = excluded.cwd`.run(this.db);
			for (const entry of batch.entries) {
				sql`DELETE FROM search_entries WHERE session_id = ${batch.sessionId} AND entry_id = ${entry.entryId}`.run(
					this.db,
				);
				sql`INSERT INTO search_entries (session_id, entry_id, timestamp, text)
					VALUES (${batch.sessionId}, ${entry.entryId}, ${entry.timestamp}, ${entry.text})`.run(this.db);
			}
			if (cursor === undefined) {
				sql`INSERT INTO search_cursors (session_id, store_generation, last_seq)
					VALUES (${batch.sessionId}, ${batch.storeGeneration}, ${batch.toSeq})`.run(this.db);
			} else {
				sql`UPDATE search_cursors SET last_seq = MAX(last_seq, ${batch.toSeq})
					WHERE session_id = ${batch.sessionId}`.run(this.db);
			}
		});
	}

	async remove(sessionId: string): Promise<void> {
		this.assertOpen();
		this.db.transaction(() => {
			sql`DELETE FROM search_entries WHERE session_id = ${sessionId}`.run(this.db);
			sql`DELETE FROM search_cursors WHERE session_id = ${sessionId}`.run(this.db);
			sql`DELETE FROM search_sessions WHERE session_id = ${sessionId}`.run(this.db);
		});
	}

	async searchSessions(query: SearchSessionQuery): Promise<SearchSessionResult[]> {
		this.assertOpen();
		const match = ftsMatchExpression(query.text);
		if (match === "") return [];
		const conditions = [sql`search_entries MATCH ${match}`, ...this.cwdCondition(query.cwd)];
		const limit = query.limit === undefined ? sql`` : sql` LIMIT ${query.limit}`;
		return sql`SELECT session_id FROM search_entries
			WHERE ${joinSqlFragments(conditions, " AND ")}
			GROUP BY session_id
			ORDER BY MIN(rank), session_id${limit}`
			.all<{ session_id: string }>(this.db)
			.map((row) => ({ sessionId: row.session_id }));
	}

	async *searchEntries(text: string, options: SearchEntryOptions = {}): AsyncIterable<SearchEntryHit> {
		this.assertOpen();
		// Only message entries are indexed, so entry-type filtering reduces to this check.
		if (options.entryTypes !== undefined && !options.entryTypes.includes("message")) return;
		const match = ftsMatchExpression(text);
		if (match === "" || options.signal?.aborted) return;
		const conditions = [sql`search_entries MATCH ${match}`, ...this.cwdCondition(options.cwd)];
		const limit = options.limit === undefined ? sql`` : sql` LIMIT ${options.limit}`;
		const rows = sql`SELECT session_id AS sessionId, entry_id AS entryId, timestamp,
				snippet(search_entries, 3, '[', ']', '…', 16) AS snippet, rank AS score
			FROM search_entries
			WHERE ${joinSqlFragments(conditions, " AND ")}
			ORDER BY rank, entry_id${limit}`.iterate<EntryHitRow>(this.db);
		for (const row of rows) {
			if (options.signal?.aborted) return;
			yield {
				sessionId: row.sessionId,
				entryId: row.entryId,
				timestamp: row.timestamp,
				snippet: row.snippet,
				score: row.score,
			};
		}
	}

	close(): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.closed = true;
		this.db.close();
		return Promise.resolve();
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("SqliteSessionSearch is closed");
	}

	private cwdCondition(cwd: string | undefined): SqlQuery[] {
		return cwd === undefined ? [] : [sql`session_id IN (SELECT session_id FROM search_sessions WHERE cwd = ${cwd})`];
	}

	private readCursor(sessionId: string): CursorRow | undefined {
		return sql`SELECT store_generation, last_seq FROM search_cursors WHERE session_id = ${sessionId}`.get<CursorRow>(
			this.db,
		);
	}

	/**
	 * Clear a session's projected rows and cursor when indexing arrives with a newer
	 * store generation, so catch-up restarts from sequence 1 over the renumbered store.
	 */
	private resetForNewerGeneration(sessionId: string, storeGeneration: number): void {
		const cursor = this.readCursor(sessionId);
		if (cursor === undefined || cursor.store_generation >= storeGeneration) return;
		sql`DELETE FROM search_entries WHERE session_id = ${sessionId}`.run(this.db);
		sql`DELETE FROM search_cursors WHERE session_id = ${sessionId}`.run(this.db);
	}
}

/**
 * Create the standalone SQLite session search projection. Fails with a clear error when the
 * SQLite build has no FTS5 support. The returned object owns its database handle; service
 * and sync-target views share it until `close()`.
 */
export async function createSqliteSessionSearch(options: SqliteSessionSearchOptions): Promise<SqliteSessionSearch> {
	await mkdir(dirname(options.path), { recursive: true });
	const db = await options.databaseFactory.open(options.path);
	try {
		db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
		assertFts5Available(db);
		await applySearchSchema(db);
	} catch (error) {
		db.close();
		throw error;
	}
	return new SqliteSessionSearchProjection(db);
}
