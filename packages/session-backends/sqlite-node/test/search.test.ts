import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SearchIndexBatch } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, createSqliteSessionSearch } from "../src/index.ts";

function fts5Available(): boolean {
	try {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x)");
			return true;
		} finally {
			db.close();
		}
	} catch {
		return false;
	}
}

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-search-"));
	try {
		return await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function batch(options: {
	sessionId: string;
	storeGeneration?: number;
	from: number;
	cwd?: string | null;
	texts: [entryId: string, text: string][];
}): SearchIndexBatch {
	const generation = options.storeGeneration ?? 1;
	return {
		sessionId: options.sessionId,
		storeGeneration: generation,
		fromSeq: options.from,
		toSeq: options.from + options.texts.length - 1,
		cwd: options.cwd ?? null,
		entries: options.texts.map(([entryId, text], index) => ({
			entryId,
			seq: options.from + index,
			text,
			timestamp: 1_700_000_000_000 + options.from + index,
		})),
	};
}

async function collect<T>(iterable: AsyncIterable<T> | undefined): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterable ?? []) items.push(item);
	return items;
}

describe.skipIf(!fts5Available())("SqliteSessionSearch projection", () => {
	it("matches message text and returns distinct sessions with limit counting sessions", async () => {
		await withTempDir(async (directory) => {
			const search = await createSqliteSessionSearch({
				path: join(directory, "search.sqlite"),
				databaseFactory: createNodeSqliteFactory(),
			});
			try {
				await search.indexBatch(
					batch({
						sessionId: "s1",
						from: 1,
						texts: [
							["e1", "alpha needle beta"],
							["e2", "unrelated"],
						],
					}),
				);
				await search.indexBatch(
					batch({
						sessionId: "s2",
						from: 1,
						texts: [
							["e3", "second needle"],
							["e4", "third needle"],
						],
					}),
				);

				const hits = await collect(search.searchEntries?.("needle"));
				expect(hits).toHaveLength(3);
				expect(hits.every((hit) => hit.snippet !== undefined && hit.score !== undefined)).toBe(true);

				expect(await search.searchSessions({ text: "needle" })).toEqual([
					expect.objectContaining({ sessionId: expect.any(String) }),
					expect.objectContaining({ sessionId: expect.any(String) }),
				]);
				expect(await search.searchSessions({ text: "needle", limit: 1 })).toHaveLength(1);
				expect(await search.searchSessions({ text: "missing" })).toEqual([]);
				expect(await search.searchSessions({ text: "   " })).toEqual([]);
			} finally {
				await search.close();
			}
		});
	});

	it("applies cwd and entry-type filters before rank and limit", async () => {
		await withTempDir(async (directory) => {
			const search = await createSqliteSessionSearch({
				path: join(directory, "search.sqlite"),
				databaseFactory: createNodeSqliteFactory(),
			});
			try {
				await search.indexBatch(
					batch({
						sessionId: "a",
						from: 1,
						cwd: "/a",
						texts: [
							["e1", "needle once"],
							["e2", "needle twice"],
						],
					}),
				);
				for (let index = 0; index < 3; index++) {
					await search.indexBatch(
						batch({
							sessionId: "b",
							from: 1 + index,
							cwd: "/b",
							texts: [[`b${index}`, `needle batch ${index}`]],
						}),
					);
				}

				const hits = await collect(search.searchEntries?.("needle", { cwd: "/b", limit: 1 }));
				expect(hits).toHaveLength(1);
				expect(hits[0]?.sessionId).toBe("b");

				expect(await search.searchSessions({ text: "needle", cwd: "/a" })).toEqual([{ sessionId: "a" }]);
				expect(await search.searchSessions({ text: "needle", cwd: "/missing" })).toEqual([]);

				// Only message entries carry indexed text, so non-message types match nothing.
				expect(await collect(search.searchEntries?.("needle", { entryTypes: ["custom"] }))).toEqual([]);
				expect((await collect(search.searchEntries?.("needle", { entryTypes: ["message"] }))).length).toBe(5);
			} finally {
				await search.close();
			}
		});
	});

	it("streams entry results lazily and honors abort", async () => {
		await withTempDir(async (directory) => {
			const search = await createSqliteSessionSearch({
				path: join(directory, "search.sqlite"),
				databaseFactory: createNodeSqliteFactory(),
			});
			try {
				await search.indexBatch(
					batch({
						sessionId: "s",
						from: 1,
						texts: [
							["e1", "stream needle one"],
							["e2", "stream needle two"],
							["e3", "stream needle three"],
						],
					}),
				);

				const controller = new AbortController();
				const hits: unknown[] = [];
				const stream = search.searchEntries?.("needle", { signal: controller.signal });
				for await (const hit of stream ?? []) {
					hits.push(hit);
					controller.abort();
				}
				expect(hits).toHaveLength(1);

				expect(await collect(search.searchEntries?.("needle", { signal: AbortSignal.abort() }))).toEqual([]);
			} finally {
				await search.close();
			}
		});
	});

	it("replays a batch idempotently and advances the cursor atomically", async () => {
		await withTempDir(async (directory) => {
			const path = join(directory, "search.sqlite");
			const search = await createSqliteSessionSearch({ path, databaseFactory: createNodeSqliteFactory() });
			try {
				const replay = batch({
					sessionId: "s",
					from: 1,
					texts: [
						["e1", "crash needle"],
						["e2", "before crash"],
					],
				});
				await search.indexBatch(replay);
				expect(await search.getCursor("s", 1)).toBe(2);

				// Crash/retry simulation: the same batch lands twice.
				await search.indexBatch(replay);
				expect(await search.getCursor("s", 1)).toBe(2);

				const db = new DatabaseSync(path);
				try {
					expect(db.prepare("SELECT COUNT(*) AS count FROM search_entries").get()).toEqual({ count: 2 });
				} finally {
					db.close();
				}

				// The cursor cannot move backward within one generation.
				await search.indexBatch(batch({ sessionId: "s", from: 1, texts: [["e1", "crash needle"]] }));
				expect(await search.getCursor("s", 1)).toBe(2);
			} finally {
				await search.close();
			}
		});
	});

	it("clears rows and restarts at sequence 1 on generation mismatch", async () => {
		await withTempDir(async (directory) => {
			const search = await createSqliteSessionSearch({
				path: join(directory, "search.sqlite"),
				databaseFactory: createNodeSqliteFactory(),
			});
			try {
				await search.indexBatch(
					batch({
						sessionId: "s",
						storeGeneration: 1,
						from: 1,
						texts: [
							["old1", "old needle"],
							["old2", "tail"],
						],
					}),
				);
				expect(await search.getCursor("s", 1)).toBe(2);

				// The store was rewritten: generation 2 resets the cursor and clears old rows.
				expect(await search.getCursor("s", 2)).toBe(0);
				expect(await search.searchSessions({ text: "old needle" })).toEqual([]);

				await search.indexBatch(
					batch({
						sessionId: "s",
						storeGeneration: 2,
						from: 1,
						texts: [
							["new1", "new needle one"],
							["new2", "new needle two"],
							["new3", "new needle three"],
						],
					}),
				);
				expect(await search.getCursor("s", 2)).toBe(3);
				expect(await search.searchSessions({ text: "needle" })).toEqual([{ sessionId: "s" }]);
				expect((await collect(search.searchEntries?.("old"))).length).toBe(0);

				// A stale generation-1 batch cannot regress the generation-2 cursor or rows.
				await search.indexBatch(
					batch({ sessionId: "s", storeGeneration: 1, from: 4, texts: [["stale", "stale needle"]] }),
				);
				expect(await search.getCursor("s", 2)).toBe(3);
				expect(await search.searchSessions({ text: "stale needle" })).toEqual([]);
			} finally {
				await search.close();
			}
		});
	});

	it("remove and close release projection resources", async () => {
		await withTempDir(async (directory) => {
			const path = join(directory, "search.sqlite");
			const search = await createSqliteSessionSearch({ path, databaseFactory: createNodeSqliteFactory() });
			await search.indexBatch(batch({ sessionId: "s", from: 1, texts: [["e1", "gone needle"]] }));
			expect(await search.listSessions()).toEqual(["s"]);

			await search.remove("s");
			expect(await search.listSessions()).toEqual([]);
			expect(await search.getCursor("s", 1)).toBe(0);
			expect(await search.searchSessions({ text: "gone needle" })).toEqual([]);

			await search.close();
			await expect(search.searchSessions({ text: "gone needle" })).rejects.toThrow();
			await search.close();

			// The database can be reopened over the same file.
			const reopened = await createSqliteSessionSearch({ path, databaseFactory: createNodeSqliteFactory() });
			await reopened.close();
		});
	});

	it("escapes FTS5 query syntax from arbitrary text", async () => {
		await withTempDir(async (directory) => {
			const search = await createSqliteSessionSearch({
				path: join(directory, "search.sqlite"),
				databaseFactory: createNodeSqliteFactory(),
			});
			try {
				await search.indexBatch(batch({ sessionId: "s", from: 1, texts: [["e1", 'quoted "text" here']] }));
				expect((await collect(search.searchEntries?.('"text"'))).length).toBe(1);
				expect((await collect(search.searchEntries?.("NEAR (a b)"))).length).toBe(0);
				expect(await search.searchSessions({ text: 'quoted "here"' })).toEqual([{ sessionId: "s" }]);
			} finally {
				await search.close();
			}
		});
	});
});
