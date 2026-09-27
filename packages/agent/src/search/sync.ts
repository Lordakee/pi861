import type { Context } from "../harness/context.ts";
import type { Entry, SessionMetadata, SessionRepo } from "../harness/session/types.ts";
import type { SearchIndexEntry, SessionSearchSyncOptions, SessionSearchSyncTarget } from "./index.ts";
import { extractSearchableText } from "./text.ts";

/** Upper bound on entries read per `findEntries` page during catch-up. */
const SYNC_PAGE_LIMIT = 200;

/**
 * Reconcile the projection with the repository: enumerate `repo.list()`, open each session,
 * index message-entry text in bounded ascending sequence pages, refresh indexed `cwd`
 * metadata, and remove projection rows for sessions no longer listed. Indexing failures
 * propagate to the caller and never touch the repository; an aborted `signal` ends the sweep
 * early with every opened session still closed.
 */
export async function syncSessionSearch<M extends SessionMetadata>(
	options: SessionSearchSyncOptions<M>,
	context: Context,
): Promise<void> {
	const { repo, target, signal } = options;
	const sessions = await repo.list(undefined, context);
	const listed = new Set(sessions.map((metadata) => metadata.id));
	for (const indexed of await target.listSessions()) {
		if (!listed.has(indexed)) await target.remove(indexed);
	}
	for (const metadata of sessions) {
		if (signal?.aborted) return;
		await syncSession(metadata, repo, target, signal, context);
	}
}

async function syncSession<M extends SessionMetadata>(
	metadata: M,
	repo: SessionRepo<M>,
	target: SessionSearchSyncTarget,
	signal: AbortSignal | undefined,
	context: Context,
): Promise<void> {
	const storeGeneration = metadata.storeGeneration ?? 1;
	const session = await repo.open(metadata, context);
	try {
		let cursor = await target.getCursor(metadata.id, storeGeneration);
		let indexed = false;
		while (signal?.aborted !== true) {
			const entries = await session.findEntries(
				{ order: "asc", limit: SYNC_PAGE_LIMIT, cursor: { seq: cursor } },
				context,
			);
			if (entries.length === 0) break;
			const first = entries[0]!;
			const last = entries[entries.length - 1]!;
			await target.indexBatch({
				sessionId: metadata.id,
				storeGeneration,
				fromSeq: first.seq,
				toSeq: last.seq,
				cwd: session.metadata.cwd ?? null,
				entries: toIndexEntries(entries),
			});
			indexed = true;
			cursor = last.seq;
			if (entries.length < SYNC_PAGE_LIMIT) break;
		}
		if (!indexed && signal?.aborted !== true) {
			// Refresh indexed cwd metadata even when no entries were added.
			await target.indexBatch({
				sessionId: metadata.id,
				storeGeneration,
				fromSeq: cursor,
				toSeq: cursor,
				cwd: session.metadata.cwd ?? null,
				entries: [],
			});
		}
	} finally {
		await session.close(context);
	}
}

function toIndexEntries(entries: Entry[]): SearchIndexEntry[] {
	const indexed: SearchIndexEntry[] = [];
	for (const entry of entries) {
		const text = extractSearchableText(entry);
		if (text.trim() === "") continue;
		indexed.push({ entryId: entry.id, seq: entry.seq, text, timestamp: entry.timestamp });
	}
	return indexed;
}

export interface SessionSearchNotifierOptions {
	/**
	 * Catch-up trigger invoked once per debounce window with the poked session ids. It performs
	 * the actual pull (for example `syncSessionSearch`); notifications carry no other content.
	 */
	onCatchUp: (sessionIds: string[]) => void;
	/** Debounce window in milliseconds. Defaults to 500. */
	debounceMs?: number;
}

/**
 * Notification sink for an application's session event stream: pokes carry only session ids,
 * repeated pokes inside the window collapse, and one debounced catch-up is scheduled per
 * window. A lost poke is recovered by the next full reconciliation sweep.
 */
export function createSessionSearchNotifier(options: SessionSearchNotifierOptions): (sessionId: string) => void {
	const debounceMs = options.debounceMs ?? 500;
	const pending = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (sessionId: string) => {
		pending.add(sessionId);
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			if (pending.size === 0) return;
			const sessionIds = [...pending];
			pending.clear();
			options.onCatchUp(sessionIds);
		}, debounceMs);
	};
}
