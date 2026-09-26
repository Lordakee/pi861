-- Standalone S3 search projection. Shares no tables with the Session schema and
-- holds zero authority: delete the database and re-sync to rebuild it.

-- Projection metadata per indexed session. `cwd` is nullable because repositories
-- without a cwd concept never match a caller-supplied cwd filter.
CREATE TABLE IF NOT EXISTS search_sessions (
	session_id TEXT PRIMARY KEY,
	cwd TEXT
) WITHOUT ROWID;

-- Durable catch-up cursor: highest entry sequence indexed for one exact
-- (session_id, store_generation).
CREATE TABLE IF NOT EXISTS search_cursors (
	session_id TEXT PRIMARY KEY,
	store_generation INTEGER NOT NULL,
	last_seq INTEGER NOT NULL
) WITHOUT ROWID;

-- Searchable message text keyed by (session_id, entry_id). Only message-entry
-- text blocks are indexed.
CREATE VIRTUAL TABLE IF NOT EXISTS search_entries USING fts5(
	session_id UNINDEXED,
	entry_id UNINDEXED,
	timestamp UNINDEXED,
	text
);
