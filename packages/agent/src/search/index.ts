import type { EntryType, SessionMetadata, SessionRepo } from "../harness/session/types.ts";

export { createSessionSearchNotifier, type SessionSearchNotifierOptions, syncSessionSearch } from "./sync.ts";
export { extractSearchableText } from "./text.ts";

/** Text query with `limit` counting sessions, plus an optional `cwd` filter. */
export interface SearchSessionQuery {
	text: string;
	limit?: number;
	cwd?: string;
}

/** Distinct session match; display services may extend this with their own fields. */
export interface SearchSessionResult {
	sessionId: string;
}

export interface SearchEntryOptions {
	/** Restrict hits to these entry types. Only `message` entries carry indexed text. */
	entryTypes?: EntryType[];
	limit?: number;
	cwd?: string;
	signal?: AbortSignal;
}

export interface SearchEntryHit {
	sessionId: string;
	entryId: string;
	timestamp: number;
	snippet?: string;
	score?: number;
}

/**
 * Standalone query service over a rebuildable search projection. The repository knows
 * nothing about it; callers join metadata and fetch entries through their own repository.
 */
export interface SessionSearchService {
	searchSessions(query: SearchSessionQuery): Promise<SearchSessionResult[]>;
	/** Optional streaming entry search for implementations that can stream results. */
	searchEntries?: (text: string, options?: SearchEntryOptions) => AsyncIterable<SearchEntryHit>;
	remove(sessionId: string): Promise<void>;
	close(): Promise<void>;
}

export interface SearchIndexEntry {
	entryId: string;
	seq: number;
	text: string;
	timestamp: number;
}

export interface SearchIndexBatch {
	sessionId: string;
	storeGeneration: number;
	/** Sequence bounds of the scanned batch (all entries), not only indexed messages. */
	fromSeq: number;
	toSeq: number;
	/** Session `cwd` projection metadata; `null` when the repository has no cwd concept. */
	cwd?: string | null;
	entries: SearchIndexEntry[];
}

/** Write-side contract of one search projection store. */
export interface SessionSearchSyncTarget {
	/** Session ids this projection currently holds rows for. */
	listSessions(): Promise<string[]>;
	/**
	 * Highest entry sequence indexed for `(sessionId, storeGeneration)`. A stored cursor from a
	 * lower generation is cleared (rows and cursor) before returning 0 for re-index from
	 * sequence 1; a higher stored generation returns its cursor and rejects later stale batches.
	 */
	getCursor(sessionId: string, storeGeneration: number): Promise<number>;
	/** Upsert one batch's rows and advance the cursor in a single store transaction. Idempotent. */
	indexBatch(batch: SearchIndexBatch): Promise<void>;
	remove(sessionId: string): Promise<void>;
}

export interface SessionSearchSyncOptions<M extends SessionMetadata> {
	repo: SessionRepo<M>;
	target: SessionSearchSyncTarget;
	signal?: AbortSignal;
}
