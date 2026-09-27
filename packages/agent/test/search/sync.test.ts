import { readFile, writeFile } from "node:fs/promises";
import type { UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../src/harness/session/jsonl/index.ts";
import { MemorySessionRepo } from "../../src/harness/session/memory.ts";
import type { Branch, Session, SessionMetadata } from "../../src/harness/session/types.ts";
import type { SearchIndexBatch } from "../../src/search/index.ts";
import { createSessionSearchNotifier, syncSessionSearch } from "../../src/search/index.ts";
import { extractSearchableText } from "../../src/search/text.ts";
import { createTempDir } from "../harness/session-test-utils.ts";

type MessageContent = string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];

/** In-memory sync target recording batches for assertions. */
class RecordingTarget {
	readonly batches: SearchIndexBatch[] = [];
	readonly removed: string[] = [];
	readonly sessions = new Set<string>();

	async listSessions(): Promise<string[]> {
		return [...this.sessions];
	}

	async getCursor(sessionId: string, storeGeneration: number): Promise<number> {
		let cursor = 0;
		for (const batch of this.batches) {
			if (batch.sessionId === sessionId && batch.storeGeneration === storeGeneration) {
				cursor = Math.max(cursor, batch.toSeq);
			}
		}
		return cursor;
	}

	async indexBatch(batch: SearchIndexBatch): Promise<void> {
		this.batches.push(batch);
		this.sessions.add(batch.sessionId);
	}

	async remove(sessionId: string): Promise<void> {
		this.removed.push(sessionId);
		this.sessions.delete(sessionId);
	}

	indexedEntries(): { sessionId: string; entryId: string; text: string }[] {
		return this.batches.flatMap((batch) =>
			batch.entries.map((entry) => ({ sessionId: batch.sessionId, entryId: entry.entryId, text: entry.text })),
		);
	}
}

async function appendMessage(branch: Branch, timestamp: number, content: MessageContent): Promise<void> {
	await branch.appendMessage({ role: "user", content, timestamp: 1_700_000_000_000 + timestamp }, BACKGROUND_CONTEXT);
}

async function createMessageSession(
	repo: MemorySessionRepo,
	id: string,
	messages: MessageContent[],
): Promise<Session<SessionMetadata>> {
	const session = await repo.create({ id }, BACKGROUND_CONTEXT);
	const branch = await session.createBranch("main", null, BACKGROUND_CONTEXT);
	for (const [index, content] of messages.entries()) {
		await appendMessage(branch, index, content);
	}
	await session.close(BACKGROUND_CONTEXT);
	return session;
}

describe("syncSessionSearch", () => {
	it("indexes pre-existing sessions and catches up later entries without duplicates", async () => {
		const repo = new MemorySessionRepo();
		const target = new RecordingTarget();
		const session = await createMessageSession(repo, "s1", ["hello world", "second message"]);

		await syncSessionSearch({ repo, target }, BACKGROUND_CONTEXT);
		expect(target.indexedEntries().map((entry) => entry.text)).toEqual(["hello world", "second message"]);

		const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
		const branch = await reopened.branch("main", BACKGROUND_CONTEXT);
		if (branch === undefined) throw new Error("missing main branch");
		await appendMessage(branch, 2, "third message");
		await reopened.close(BACKGROUND_CONTEXT);

		await syncSessionSearch({ repo, target }, BACKGROUND_CONTEXT);
		const entries = target.indexedEntries();
		expect(entries).toHaveLength(3);
		expect(new Set(entries.map((entry) => entry.entryId)).size).toBe(3);
		expect(target.batches.at(-1)?.entries.map((entry) => entry.text)).toEqual(["third message"]);

		// Repeated sync with no new entries indexes nothing new.
		await syncSessionSearch({ repo, target }, BACKGROUND_CONTEXT);
		expect(target.indexedEntries()).toHaveLength(3);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("catches up all pages for long sessions", async () => {
		const repo = new MemorySessionRepo();
		const target = new RecordingTarget();
		const session = await repo.create({ id: "long" }, BACKGROUND_CONTEXT);
		const branch = await session.createBranch("main", null, BACKGROUND_CONTEXT);
		// SYNC_PAGE_LIMIT is 200; force a second page.
		for (let index = 0; index < 205; index++) {
			await appendMessage(branch, index, `page message ${index}`);
		}
		await session.close(BACKGROUND_CONTEXT);

		await syncSessionSearch({ repo, target }, BACKGROUND_CONTEXT);
		const batches = target.batches.filter((batch) => batch.entries.length > 0);
		expect(batches).toHaveLength(2);
		expect(batches[0]?.entries).toHaveLength(200);
		expect(batches[1]?.entries).toHaveLength(5);
		// Pages continue after the previous page without overlap.
		expect(batches[1]!.fromSeq).toBeGreaterThan(batches[0]!.toSeq);
		const entries = target.indexedEntries();
		expect(entries).toHaveLength(205);
		expect(new Set(entries.map((entry) => entry.entryId)).size).toBe(205);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("indexes only message text and skips non-text or non-message content", async () => {
		const repo = new MemorySessionRepo();
		const target = new RecordingTarget();
		const session = await repo.create({ id: "mixed" }, BACKGROUND_CONTEXT);
		const branch = await session.createBranch("main", null, BACKGROUND_CONTEXT);
		await appendMessage(branch, 0, "text before");
		await branch.appendCustomEntry("note", { payload: "custom data" }, BACKGROUND_CONTEXT);
		await appendMessage(branch, 1, [{ type: "image", data: "aGk=", mimeType: "image/png" }]);
		await appendMessage(branch, 2, [
			{ type: "text", text: "block one" },
			{ type: "text", text: "block two" },
		]);
		await session.close(BACKGROUND_CONTEXT);

		await syncSessionSearch({ repo, target }, BACKGROUND_CONTEXT);
		expect(target.indexedEntries().map((entry) => entry.text)).toEqual(["text before", "block one\nblock two"]);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("aborted sync closes the current session", async () => {
		const repo = new MemorySessionRepo();
		const session = await createMessageSession(repo, "abort", ["first", "second"]);
		const controller = new AbortController();
		const target = new RecordingTarget();
		const indexBatch = target.indexBatch.bind(target);
		let batches = 0;
		target.indexBatch = async (batch) => {
			await indexBatch(batch);
			batches += 1;
			if (batches === 1) controller.abort();
		};

		await syncSessionSearch({ repo, target, signal: controller.signal }, BACKGROUND_CONTEXT);
		expect(batches).toBe(1);

		// The aborted session was closed: the repository accepts another open.
		const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
		await reopened.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("removes projection rows for sessions no longer listed", async () => {
		const repo = new MemorySessionRepo();
		const target = new RecordingTarget();
		await createMessageSession(repo, "keep", ["kept message"]);
		const dropped = await createMessageSession(repo, "drop", ["dropped message"]);

		await syncSessionSearch({ repo, target }, BACKGROUND_CONTEXT);
		expect(target.sessions).toEqual(new Set(["keep", "drop"]));

		await repo.delete(dropped.metadata, BACKGROUND_CONTEXT);
		await syncSessionSearch({ repo, target }, BACKGROUND_CONTEXT);
		expect(target.removed).toEqual(["drop"]);
		expect(target.sessions).toEqual(new Set(["keep"]));
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("exposes a persisted JSONL storeGeneration and defaults fresh files to generation 1", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions" });
		const session = await repo.create({ id: "gen", cwd: "/workspace" }, BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);
		expect((await repo.list(undefined, BACKGROUND_CONTEXT))[0]?.storeGeneration).toBeUndefined();

		const path = session.metadata.path;
		const lines = (await readFile(path, "utf8")).split("\n");
		const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
		lines[0] = JSON.stringify({ ...header, storeGeneration: 3 });
		await writeFile(path, lines.join("\n"));

		const persisted = (await repo.list(undefined, BACKGROUND_CONTEXT)).find((metadata) => metadata.id === "gen");
		expect(persisted?.storeGeneration).toBe(3);
		await repo.close(BACKGROUND_CONTEXT);
	});
});

describe("createSessionSearchNotifier", () => {
	it("debounces pokes and schedules catch-up carrying only session ids", async () => {
		const trigger = vi.fn();
		const notify = createSessionSearchNotifier({ onCatchUp: trigger, debounceMs: 10 });

		notify("a");
		await sleep(5);
		notify("b");
		notify("a");
		expect(trigger).not.toHaveBeenCalled();

		await sleep(30);
		expect(trigger).toHaveBeenCalledTimes(1);
		expect(trigger).toHaveBeenCalledWith(["a", "b"]);
	});
});

describe("extractSearchableText", () => {
	it("extracts string and text-block content deterministically", () => {
		const message = (content: unknown) =>
			extractSearchableText({
				id: "e",
				parentId: null,
				seq: 1,
				timestamp: 0,
				type: "message",
				message: { role: "user", content, timestamp: 0 } as UserMessage,
			});
		expect(message("plain")).toBe("plain");
		expect(
			message([
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			]),
		).toBe("one\ntwo");
		expect(message([{ type: "image", data: "aGk=", mimeType: "image/png" }])).toBe("");
		expect(message("   ")).toBe("   ");
		expect(
			extractSearchableText({
				id: "e",
				parentId: null,
				seq: 1,
				timestamp: 0,
				type: "custom",
				customType: "note",
				data: { text: "hidden" },
			}),
		).toBe("");
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
