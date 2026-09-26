import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import {
	JSONL_FORMAT_VERSION,
	type JsonlCompactionOptions,
	JsonlSessionRepo,
	JsonlStorage,
	type JsonlStorageHeader,
} from "../../src/harness/session/jsonl/index.ts";
import * as storedValues from "../../src/harness/session/values.ts";
import { err, FileError, getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

const NOW = 1_700_000_000_000;

function header(id: string): JsonlStorageHeader {
	return {
		v: JSONL_FORMAT_VERSION,
		kind: "header",
		id,
		storageVersion: 1,
		createdAt: NOW,
		cwd: "/workspace",
	};
}

describe("JsonlStorage persistence", () => {
	it("replays whole-list deletion without resurrecting earlier appends", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "list-delete.jsonl", now: () => NOW };
		const events = storedValues.list<string>("test.events");
		const storage = await JsonlStorage.create(options, header("list-delete"), [], BACKGROUND_CONTEXT);
		await storage.commit(
			[storedValues.appendList(events, "first"), storedValues.appendList(events, "second")],
			BACKGROUND_CONTEXT,
		);
		await storage.commit([storedValues.deleteList(events)], BACKGROUND_CONTEXT);
		await storage.close(BACKGROUND_CONTEXT);

		const reopened = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
		expect(await reopened.readList(events, undefined, BACKGROUND_CONTEXT)).toEqual([]);
		const recreated = await reopened.commit([storedValues.appendList(events, "after")], BACKGROUND_CONTEXT);
		expect(recreated.firstSeq).toBe(4);
		expect(await reopened.readList(events, undefined, BACKGROUND_CONTEXT)).toEqual([{ seq: 4, value: "after" }]);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("writes one line per transaction and replays stamped state", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "session.jsonl", now: () => NOW };
		const storage = await JsonlStorage.create(options, header("round-trip"), [], BACKGROUND_CONTEXT);
		const committed = await storage.commit(
			[
				sessionWrites.insertEntry({
					id: "root",
					parentId: null,
					type: "message",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
				storedValues.setValue(storedValues.branchTip("main"), "root"),
				sessionWrites.insertUsage({
					id: "usage",
					entryId: "root",
					adjustment: false,
					usage: {
						input: 1,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 3,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
			],
			BACKGROUND_CONTEXT,
		);
		await storage.commit([storedValues.setValue(storedValues.sessionName, "name")], BACKGROUND_CONTEXT);

		const lines = getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))
			.trimEnd()
			.split("\n");
		expect(JSON.parse(lines[0]!)).toEqual(header("round-trip"));
		expect(JSON.parse(lines[1]!)).toHaveLength(3);
		expect(Array.isArray(JSON.parse(lines[2]!))).toBe(false);
		await storage.close(BACKGROUND_CONTEXT);

		const reopened = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
		expect((await reopened.getEntries(["root"], BACKGROUND_CONTEXT)).get("root")).toEqual({
			id: "root",
			parentId: null,
			type: "message",
			message: { role: "user", content: "hello", timestamp: 1 },
			seq: committed.seqs[0],
			timestamp: committed.timestamp,
		});
		expect(await reopened.getValue(storedValues.branchTip("main"), BACKGROUND_CONTEXT)).toEqual({
			address: storedValues.branchTip("main"),
			value: "root",
			seq: committed.seqs[1],
		});
		expect(
			(await reopened.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id, seq }) => ({ id, seq })),
		).toEqual([{ id: "usage", seq: committed.seqs[2] }]);
		const historicalStats = {
			messageCount: 1,
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		expect(await reopened.getStats(BACKGROUND_CONTEXT)).toEqual(historicalStats);
		const next = await reopened.commit([], BACKGROUND_CONTEXT);
		expect(next.firstSeq).toBe(5);
		expect(next.stats).toEqual(historicalStats);
		await reopened.close(BACKGROUND_CONTEXT);
	});
});

describe("JsonlStorage torn tail", () => {
	function entryWrite(id: string) {
		return sessionWrites.insertEntry({
			id,
			parentId: null,
			type: "message",
			message: { role: "user", content: id, timestamp: 1 },
		});
	}

	async function seed() {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "session.jsonl" as const, now: () => NOW };
		const storage = await JsonlStorage.create(options, header("torn"), [], BACKGROUND_CONTEXT);
		await storage.commit([entryWrite("kept")], BACKGROUND_CONTEXT);
		await storage.close(BACKGROUND_CONTEXT);
		const prefix = getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT));
		return { fileSystem, options, prefix };
	}

	it("discards an unterminated final object line and truncates before admitting writes", async () => {
		const { fileSystem, options, prefix } = await seed();
		await fileSystem.appendFile(
			"session.jsonl",
			JSON.stringify({
				kind: "entry",
				id: "torn",
				parentId: null,
				type: "message",
				message: { role: "user", content: "torn", timestamp: 1 },
				seq: 2,
				timestamp: NOW,
			}),
			BACKGROUND_CONTEXT,
		);

		const reopened = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
		expect((await reopened.getEntries(["kept", "torn"], BACKGROUND_CONTEXT)).has("torn")).toBe(false);
		expect((await reopened.getEntries(["kept"], BACKGROUND_CONTEXT)).get("kept")?.id).toBe("kept");
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))).toBe(prefix);
		expect(getOrThrow(await fileSystem.exists("session.jsonl.tmp", BACKGROUND_CONTEXT))).toBe(false);

		const next = await reopened.commit([entryWrite("after")], BACKGROUND_CONTEXT);
		expect(next.firstSeq).toBe(2);
		expect((await reopened.getEntries(["after"], BACKGROUND_CONTEXT)).get("after")?.seq).toBe(2);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("discards a torn array line wholly, including list elements", async () => {
		const { fileSystem, options, prefix } = await seed();
		const events = storedValues.list<string>("test.events");
		await fileSystem.appendFile(
			"session.jsonl",
			JSON.stringify([
				{
					kind: "entry",
					id: "torn-a",
					parentId: null,
					type: "message",
					message: { role: "user", content: "torn-a", timestamp: 1 },
					seq: 2,
					timestamp: NOW,
				},
				storedValues.setValue(storedValues.sessionName, "lost"),
				storedValues.appendList(events, "lost"),
			]),
			BACKGROUND_CONTEXT,
		);

		const reopened = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
		expect((await reopened.getEntries(["torn-a"], BACKGROUND_CONTEXT)).has("torn-a")).toBe(false);
		expect(await reopened.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await reopened.readList(events, undefined, BACKGROUND_CONTEXT)).toEqual([]);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))).toBe(prefix);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("rejects a malformed interior line without rewriting", async () => {
		const { fileSystem, options, prefix } = await seed();
		const corrupted = `${prefix}not-json\n${JSON.stringify(storedValues.setValue(storedValues.sessionName, "after"))}\n`;
		await fileSystem.writeFile("session.jsonl", corrupted, BACKGROUND_CONTEXT);

		await expect(JsonlStorage.open(options, BACKGROUND_CONTEXT)).rejects.toThrow(/line 3/);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))).toBe(corrupted);
		expect(getOrThrow(await fileSystem.exists("session.jsonl.tmp", BACKGROUND_CONTEXT))).toBe(false);
	});

	it("rejects the unsupported pre-WP01 scalar record spelling", async () => {
		const { fileSystem, options, prefix } = await seed();
		const legacyKind = ["reg", "ister"].join("");
		const corrupted = `${prefix}${JSON.stringify({
			kind: legacyKind,
			op: "set",
			seq: 2,
			namespace: "legacy.value",
			key: "state",
			value: true,
		})}\n`;
		await fileSystem.writeFile("session.jsonl", corrupted, BACKGROUND_CONTEXT);

		await expect(JsonlStorage.open(options, BACKGROUND_CONTEXT)).rejects.toThrow(/line 3/);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))).toBe(corrupted);
	});

	it("rejects a complete malformed final line without rewriting", async () => {
		const { fileSystem, options, prefix } = await seed();
		const corrupted = `${prefix}not-json\n`;
		await fileSystem.writeFile("session.jsonl", corrupted, BACKGROUND_CONTEXT);

		await expect(JsonlStorage.open(options, BACKGROUND_CONTEXT)).rejects.toThrow(/line 3/);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))).toBe(corrupted);
	});

	it("rejects a complete final line with invalid transaction framing", async () => {
		const { fileSystem, options, prefix } = await seed();
		const corrupted = `${prefix}${JSON.stringify({ kind: "nope", seq: 2 })}\n`;
		await fileSystem.writeFile("session.jsonl", corrupted, BACKGROUND_CONTEXT);

		await expect(JsonlStorage.open(options, BACKGROUND_CONTEXT)).rejects.toThrow(/line 3/);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))).toBe(corrupted);
	});

	describe("JsonlStorage snapshot compaction", () => {
		const always: JsonlCompactionOptions = { enabled: true, minBytes: 1, minDeadBytes: 1, deadRatio: 0 };

		function entryWrite(id: string, parentId: string | null = null) {
			return sessionWrites.insertEntry({
				id,
				parentId,
				type: "message",
				message: { role: "user", content: id, timestamp: 1 },
			});
		}

		function usageWrite(id: string, entryId?: string) {
			return sessionWrites.insertUsage({
				id,
				...(entryId === undefined ? {} : { entryId }),
				adjustment: false,
				usage: {
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 3,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
		}

		async function readContent(fileSystem: NodeExecutionEnv, path: string): Promise<string> {
			return getOrThrow(await fileSystem.readTextFile(path, BACKGROUND_CONTEXT));
		}

		function parseLines(content: string): Record<string, unknown>[] {
			return content
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		}

		function recordSummary(content: string): Record<string, unknown>[] {
			return parseLines(content).map((record) => ({
				kind: record.kind,
				op: record.op,
				seq: record.seq,
				namespace: record.namespace,
				key: record.key,
				id: record.id,
			}));
		}

		it("compacts on open while preserving entries, usage, current values, list cursors, and nextSeq", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = { fileSystem, path: "session.jsonl", now: () => NOW };
			const events = storedValues.list<string>("test.events");
			const pending = storedValues.value<string>("test.pending", "x");
			const storage = await JsonlStorage.create(options, header("compact-open"), [], BACKGROUND_CONTEXT);
			await storage.commit(
				[entryWrite("root"), storedValues.setValue(storedValues.sessionName, "one"), usageWrite("usage")],
				BACKGROUND_CONTEXT,
			);
			await storage.commit([storedValues.setValue(storedValues.sessionName, "two")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.setValue(pending, "payload")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.deleteValue(pending)], BACKGROUND_CONTEXT);
			await storage.commit(
				[storedValues.appendList(events, "a"), storedValues.appendList(events, "b")],
				BACKGROUND_CONTEXT,
			);
			await storage.close(BACKGROUND_CONTEXT);
			expect(parseLines(await readContent(fileSystem, "session.jsonl"))).toHaveLength(6);

			const reopened = await JsonlStorage.open({ ...options, compaction: always }, BACKGROUND_CONTEXT);
			const content = await readContent(fileSystem, "session.jsonl");
			expect(recordSummary(content)).toEqual([
				{ kind: "header", op: undefined, seq: undefined, namespace: undefined, key: undefined, id: "compact-open" },
				{ kind: "entry", op: undefined, seq: 1, namespace: undefined, key: undefined, id: "root" },
				{ kind: "usage", op: undefined, seq: 3, namespace: undefined, key: undefined, id: "usage" },
				{ kind: "value", op: "set", seq: 4, namespace: "pi.session.name", key: "", id: undefined },
				{ kind: "list", op: "append", seq: 7, namespace: "test.events", key: "", id: undefined },
				{ kind: "list", op: "append", seq: 8, namespace: "test.events", key: "", id: undefined },
			]);
			expect(parseLines(content)[0]).toMatchObject({ nextSeq: 9 });
			expect(await reopened.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toMatchObject({
				value: "two",
				seq: 4,
			});
			expect(await reopened.readList(events, undefined, BACKGROUND_CONTEXT)).toEqual([
				{ seq: 7, value: "a" },
				{ seq: 8, value: "b" },
			]);
			expect(await reopened.readList(events, { order: "asc", cursor: { seq: 7 } }, BACKGROUND_CONTEXT)).toEqual([
				{ seq: 8, value: "b" },
			]);
			expect(await reopened.getStats(BACKGROUND_CONTEXT)).toMatchObject({ messageCount: 1 });
			expect(await reopened.commit([], BACKGROUND_CONTEXT)).toMatchObject({ firstSeq: 9 });
			await reopened.close(BACKGROUND_CONTEXT);

			// An already compact snapshot is not rewritten again.
			const reread = await JsonlStorage.open({ ...options, compaction: always }, BACKGROUND_CONTEXT);
			await reread.close(BACKGROUND_CONTEXT);
			expect(await readContent(fileSystem, "session.jsonl")).toBe(content);
		});

		it("compacts after a value or list deletion commit and stays writable", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = {
				fileSystem,
				path: "session.jsonl",
				now: () => NOW,
				compaction: always,
			};
			const pending = storedValues.value<string>("test.pending", "x");
			const events = storedValues.list<string>("test.events");
			const storage = await JsonlStorage.create(options, header("compact-commit"), [], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.setValue(pending, "payload")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.deleteValue(pending)], BACKGROUND_CONTEXT);

			expect(recordSummary(await readContent(fileSystem, "session.jsonl"))).toEqual([
				{
					kind: "header",
					op: undefined,
					seq: undefined,
					namespace: undefined,
					key: undefined,
					id: "compact-commit",
				},
			]);
			expect(parseLines(await readContent(fileSystem, "session.jsonl"))[0]).toMatchObject({ nextSeq: 3 });
			expect(await storage.getValue(pending, BACKGROUND_CONTEXT)).toBeUndefined();

			await storage.commit([storedValues.appendList(events, "a")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.appendList(events, "b")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.deleteList(events)], BACKGROUND_CONTEXT);
			expect(await storage.readList(events, undefined, BACKGROUND_CONTEXT)).toEqual([]);
			const recreated = await storage.commit([storedValues.appendList(events, "after")], BACKGROUND_CONTEXT);
			expect(recreated.firstSeq).toBe(6);
			expect(await storage.readList(events, undefined, BACKGROUND_CONTEXT)).toEqual([{ seq: 6, value: "after" }]);
			await storage.close(BACKGROUND_CONTEXT);
		});

		it("preserves pi.result terminal outcomes and entry labels while reclaiming operation state", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = { fileSystem, path: "session.jsonl", now: () => NOW };
			const result = storedValues.value<Record<string, unknown>>("pi.result", "op-1");
			const opState = storedValues.value<Record<string, unknown>>("pi.op.state", "op-1");
			const frames = storedValues.list<Record<string, unknown>>("pi.pending.assistant_frame", "op-1:entry");
			const label = storedValues.value<string>("pi.entry.label", "root");
			const storage = await JsonlStorage.create(options, header("compact-result"), [], BACKGROUND_CONTEXT);
			await storage.commit(
				[
					entryWrite("root"),
					storedValues.setValue(result, { outcome: "finished" }),
					storedValues.setValue(label, "checkpoint"),
					storedValues.setValue(opState, { phase: "deciding" }),
				],
				BACKGROUND_CONTEXT,
			);
			await storage.commit([storedValues.setValue(opState, { phase: "admitting" })], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.deleteValue(opState)], BACKGROUND_CONTEXT);
			await storage.commit(
				[storedValues.appendList(frames, { delta: 1 }), storedValues.appendList(frames, { delta: 2 })],
				BACKGROUND_CONTEXT,
			);
			await storage.commit([storedValues.deleteList(frames)], BACKGROUND_CONTEXT);
			await storage.close(BACKGROUND_CONTEXT);

			const reopened = await JsonlStorage.open({ ...options, compaction: always }, BACKGROUND_CONTEXT);
			const content = await readContent(fileSystem, "session.jsonl");
			expect(recordSummary(content)).toEqual([
				{
					kind: "header",
					op: undefined,
					seq: undefined,
					namespace: undefined,
					key: undefined,
					id: "compact-result",
				},
				{ kind: "entry", op: undefined, seq: 1, namespace: undefined, key: undefined, id: "root" },
				{ kind: "value", op: "set", seq: 2, namespace: "pi.result", key: "op-1", id: undefined },
				{ kind: "value", op: "set", seq: 3, namespace: "pi.entry.label", key: "root", id: undefined },
			]);
			expect(await reopened.getValue(result, BACKGROUND_CONTEXT)).toMatchObject({
				value: { outcome: "finished" },
				seq: 2,
			});
			expect(await reopened.getValue(label, BACKGROUND_CONTEXT)).toMatchObject({ value: "checkpoint", seq: 3 });
			expect(await reopened.getValue(opState, BACKGROUND_CONTEXT)).toBeUndefined();
			expect(await reopened.readList(frames, undefined, BACKGROUND_CONTEXT)).toEqual([]);
			await reopened.close(BACKGROUND_CONTEXT);
		});

		it("preserves the nextSeq high-water mark when the highest surviving record is earlier", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = { fileSystem, path: "session.jsonl", now: () => NOW };
			const doomed = storedValues.value<string>("test.doomed", "x");
			const storage = await JsonlStorage.create(options, header("compact-tail"), [], BACKGROUND_CONTEXT);
			await storage.commit([entryWrite("root")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.setValue(doomed, "x")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.deleteValue(doomed)], BACKGROUND_CONTEXT);
			await storage.close(BACKGROUND_CONTEXT);

			const reopened = await JsonlStorage.open({ ...options, compaction: always }, BACKGROUND_CONTEXT);
			const lines = parseLines(await readContent(fileSystem, "session.jsonl"));
			expect(lines).toHaveLength(2);
			expect(lines[0]).toMatchObject({ nextSeq: 4 });
			expect(lines[1]).toMatchObject({ kind: "entry", seq: 1 });
			expect(await reopened.commit([], BACKGROUND_CONTEXT)).toMatchObject({ firstSeq: 4 });
			await reopened.close(BACKGROUND_CONTEXT);
		});

		it("preserves the storeGeneration header field across snapshot rewrites", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = { fileSystem, path: "session.jsonl", now: () => NOW };
			const pending = storedValues.value<string>("test.pending", "x");
			const doomed = storedValues.value<string>("test.doomed", "y");
			const storage = await JsonlStorage.create(
				options,
				{ ...header("compact-generation"), storeGeneration: 3 },
				[],
				BACKGROUND_CONTEXT,
			);
			await storage.commit(
				[entryWrite("root"), storedValues.setValue(doomed, "first"), storedValues.setValue(pending, "payload")],
				BACKGROUND_CONTEXT,
			);
			await storage.commit([storedValues.setValue(doomed, "second")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.deleteValue(pending)], BACKGROUND_CONTEXT);
			await storage.close(BACKGROUND_CONTEXT);

			// Open-time compaction must carry storeGeneration into the rewritten header.
			const reopened = await JsonlStorage.open({ ...options, compaction: always }, BACKGROUND_CONTEXT);
			expect(parseLines(await readContent(fileSystem, "session.jsonl"))[0]).toMatchObject({
				id: "compact-generation",
				storeGeneration: 3,
			});

			// A post-open delete commit that triggers another rewrite must preserve it too.
			const other = storedValues.value<string>("test.other", "z");
			await reopened.commit([storedValues.setValue(other, "v")], BACKGROUND_CONTEXT);
			await reopened.commit([storedValues.deleteValue(doomed)], BACKGROUND_CONTEXT);
			await reopened.close(BACKGROUND_CONTEXT);
			expect(parseLines(await readContent(fileSystem, "session.jsonl"))[0]).toMatchObject({
				id: "compact-generation",
				storeGeneration: 3,
			});
		});

		it("does not rewrite below thresholds or when disabled", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = { fileSystem, path: "session.jsonl", now: () => NOW };
			const pending = storedValues.value<string>("test.pending", "x");
			const storage = await JsonlStorage.create(options, header("compact-skip"), [], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.setValue(pending, "payload")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.deleteValue(pending)], BACKGROUND_CONTEXT);
			await storage.close(BACKGROUND_CONTEXT);
			const before = await readContent(fileSystem, "session.jsonl");
			expect(parseLines(before)).toHaveLength(3);

			for (const compaction of [undefined, { enabled: false }, { minDeadBytes: 2 ** 30 }] as const) {
				const reopened = await JsonlStorage.open({ ...options, compaction }, BACKGROUND_CONTEXT);
				await reopened.close(BACKGROUND_CONTEXT);
			}
			expect(await readContent(fileSystem, "session.jsonl")).toBe(before);
		});

		it("compacts only after repairing a torn tail and rejects malformed interior lines without rewriting", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = { fileSystem, path: "session.jsonl", now: () => NOW };
			const pending = storedValues.value<string>("test.pending", "x");
			const storage = await JsonlStorage.create(options, header("compact-torn"), [], BACKGROUND_CONTEXT);
			await storage.commit([entryWrite("root")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.setValue(pending, "payload")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.deleteValue(pending)], BACKGROUND_CONTEXT);
			await storage.close(BACKGROUND_CONTEXT);
			await fileSystem.appendFile("session.jsonl", '{"kind":"value","op":"set",', BACKGROUND_CONTEXT);

			const repaired = await JsonlStorage.open({ ...options, compaction: always }, BACKGROUND_CONTEXT);
			expect(recordSummary(await readContent(fileSystem, "session.jsonl"))).toEqual([
				{ kind: "header", op: undefined, seq: undefined, namespace: undefined, key: undefined, id: "compact-torn" },
				{ kind: "entry", op: undefined, seq: 1, namespace: undefined, key: undefined, id: "root" },
			]);
			expect(getOrThrow(await fileSystem.exists("session.jsonl.tmp", BACKGROUND_CONTEXT))).toBe(false);
			await repaired.close(BACKGROUND_CONTEXT);

			const corrupted = `${(await readContent(fileSystem, "session.jsonl")).trimEnd()}\nnot-json\n`;
			getOrThrow(await fileSystem.writeFile("session.jsonl", corrupted, BACKGROUND_CONTEXT));
			await expect(JsonlStorage.open({ ...options, compaction: always }, BACKGROUND_CONTEXT)).rejects.toThrow(
				/line 3/,
			);
			expect(await readContent(fileSystem, "session.jsonl")).toBe(corrupted);
			expect(getOrThrow(await fileSystem.exists("session.jsonl.tmp", BACKGROUND_CONTEXT))).toBe(false);
		});

		it("keeps the durable commit when a rewrite fails and retries on the next trigger", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = {
				fileSystem,
				path: "session.jsonl",
				now: () => NOW,
				compaction: always,
			};
			const pending = storedValues.value<string>("test.pending", "x");
			const storage = await JsonlStorage.create(options, header("compact-retry"), [], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.setValue(pending, "payload")], BACKGROUND_CONTEXT);
			const failure = new FileError("unknown", "injected I/O failure", "session.jsonl");
			const rename = vi.spyOn(fileSystem, "renameFile").mockResolvedValueOnce(err(failure));

			const deleted = await storage.commit([storedValues.deleteValue(pending)], BACKGROUND_CONTEXT);
			expect(deleted.seqs).toEqual([2]);
			expect(await storage.getValue(pending, BACKGROUND_CONTEXT)).toBeUndefined();
			expect(recordSummary(await readContent(fileSystem, "session.jsonl"))).toEqual([
				{
					kind: "header",
					op: undefined,
					seq: undefined,
					namespace: undefined,
					key: undefined,
					id: "compact-retry",
				},
				{ kind: "value", op: "set", seq: 1, namespace: "test.pending", key: "x", id: undefined },
				{ kind: "value", op: "delete", seq: 2, namespace: "test.pending", key: "x", id: undefined },
			]);
			expect(getOrThrow(await fileSystem.exists("session.jsonl.tmp", BACKGROUND_CONTEXT))).toBe(false);
			expect(rename).toHaveBeenCalledTimes(1);

			await storage.commit([storedValues.setValue(pending, "again")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.deleteValue(pending)], BACKGROUND_CONTEXT);
			expect(recordSummary(await readContent(fileSystem, "session.jsonl"))).toEqual([
				{
					kind: "header",
					op: undefined,
					seq: undefined,
					namespace: undefined,
					key: undefined,
					id: "compact-retry",
				},
			]);
			expect(parseLines(await readContent(fileSystem, "session.jsonl"))[0]).toMatchObject({ nextSeq: 5 });
			expect(await storage.commit([], BACKGROUND_CONTEXT)).toMatchObject({ firstSeq: 5 });
			await storage.close(BACKGROUND_CONTEXT);
		});

		it("propagates open-time rewrite failures without touching the original file", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = { fileSystem, path: "session.jsonl", now: () => NOW };
			const pending = storedValues.value<string>("test.pending", "x");
			const storage = await JsonlStorage.create(options, header("compact-open-fail"), [], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.setValue(pending, "payload")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.deleteValue(pending)], BACKGROUND_CONTEXT);
			await storage.close(BACKGROUND_CONTEXT);
			const before = await readContent(fileSystem, "session.jsonl");

			const failure = new FileError("unknown", "injected I/O failure", "session.jsonl");
			vi.spyOn(fileSystem, "renameFile").mockResolvedValueOnce(err(failure));
			await expect(JsonlStorage.open({ ...options, compaction: always }, BACKGROUND_CONTEXT)).rejects.toMatchObject({
				cause: failure,
			});
			expect(await readContent(fileSystem, "session.jsonl")).toBe(before);
			expect(getOrThrow(await fileSystem.exists("session.jsonl.tmp", BACKGROUND_CONTEXT))).toBe(false);
			vi.restoreAllMocks();

			const reopened = await JsonlStorage.open({ ...options, compaction: always }, BACKGROUND_CONTEXT);
			expect(parseLines(await readContent(fileSystem, "session.jsonl"))).toHaveLength(1);
			await reopened.close(BACKGROUND_CONTEXT);
		});

		it("opens successfully with a stale temp file left by a crash before rename", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = { fileSystem, path: "session.jsonl", now: () => NOW };
			const pending = storedValues.value<string>("test.pending", "x");
			const storage = await JsonlStorage.create(options, header("compact-crash"), [], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.setValue(pending, "payload")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.deleteValue(pending)], BACKGROUND_CONTEXT);
			await storage.close(BACKGROUND_CONTEXT);
			getOrThrow(await fileSystem.writeFile("session.jsonl.tmp", "partial snapshot", BACKGROUND_CONTEXT));

			const reopened = await JsonlStorage.open({ ...options, compaction: always }, BACKGROUND_CONTEXT);
			expect(parseLines(await readContent(fileSystem, "session.jsonl"))).toHaveLength(1);
			expect(getOrThrow(await fileSystem.exists("session.jsonl.tmp", BACKGROUND_CONTEXT))).toBe(false);
			expect(await reopened.commit([entryWrite("after")], BACKGROUND_CONTEXT)).toMatchObject({ firstSeq: 3 });
			await reopened.close(BACKGROUND_CONTEXT);
		});

		it("rejects invalid compaction policies at construction", () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = {
				fileSystem,
				path: "session.jsonl",
				now: () => NOW,
				compaction: { minBytes: -1 } as JsonlCompactionOptions,
			};
			expect(() => JsonlStorage.create(options, header("compact-invalid"), [], BACKGROUND_CONTEXT)).rejects.toThrow(
				/minBytes/,
			);
			const fractional = {
				fileSystem,
				path: "session.jsonl",
				now: () => NOW,
				compaction: { deadRatio: Number.NaN } as JsonlCompactionOptions,
			};
			expect(() =>
				JsonlStorage.create(fractional, header("compact-invalid"), [], BACKGROUND_CONTEXT),
			).rejects.toThrow(/deadRatio/);
		});

		it("forks a compacted source preserving branch selection, sequence gaps, and high-water marks", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const repo = new JsonlSessionRepo({
				fileSystem,
				sessionsRoot: "sessions",
				now: () => NOW,
				compaction: always,
			});
			const session = await repo.create({ id: "source", cwd: "/workspace" }, BACKGROUND_CONTEXT);
			const doomed = storedValues.value<string>("test.doomed", "x");
			const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
			await mutation.commit(
				[
					entryWrite("root"),
					storedValues.setValue(storedValues.branchTip("main"), "root"),
					storedValues.setValue(storedValues.laneConfig("main"), {
						model: { provider: "provider", modelId: "model" },
						thinkingLevel: "off",
						activeToolNames: [],
					}),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: null,
						lastOperationId: null,
						inbox: [],
					}),
					storedValues.setValue(doomed, "x"),
					storedValues.deleteValue(doomed),
				],
				BACKGROUND_CONTEXT,
			);
			await mutation.end(BACKGROUND_CONTEXT);

			// Forking the still-open source captures its boundary under the held commit queue.
			const openFork = await repo.fork(session.metadata, { id: "fork-open", scope: "tree" }, BACKGROUND_CONTEXT);
			expect(parseLines(await readContent(fileSystem, openFork.metadata.path))[0]).toMatchObject({
				nextSeq: 7,
				parentSessionId: "source",
			});
			await openFork.close(BACKGROUND_CONTEXT);
			await session.close(BACKGROUND_CONTEXT);

			const sourceLines = parseLines(await readContent(fileSystem, session.metadata.path));
			expect(sourceLines).toHaveLength(5); // compacted: header, entry, tip, lane config, lane state
			expect(sourceLines[0]).toMatchObject({ nextSeq: 7 });

			const treeFork = await repo.fork(session.metadata, { id: "fork-tree", scope: "tree" }, BACKGROUND_CONTEXT);
			expect(recordSummary(await readContent(fileSystem, treeFork.metadata.path))).toEqual([
				{ kind: "header", op: undefined, seq: undefined, namespace: undefined, key: undefined, id: "fork-tree" },
				{ kind: "entry", op: undefined, seq: 1, namespace: undefined, key: undefined, id: "root" },
				{ kind: "value", op: "set", seq: 2, namespace: "pi.branch.tip", key: "main", id: undefined },
				{ kind: "value", op: "set", seq: 3, namespace: "pi.lane.config", key: "main", id: undefined },
				{ kind: "value", op: "set", seq: 4, namespace: "pi.lane.state", key: "main", id: undefined },
			]);
			expect(parseLines(await readContent(fileSystem, treeFork.metadata.path))[0]).toMatchObject({
				nextSeq: 7,
				parentSessionId: "source",
			});
			await treeFork.close(BACKGROUND_CONTEXT);

			const branchFork = await repo.fork(
				session.metadata,
				{ id: "fork-branch", scope: "branch", branch: "main" },
				BACKGROUND_CONTEXT,
			);
			const branchLines = parseLines(await readContent(fileSystem, branchFork.metadata.path));
			expect(branchLines[0]).toMatchObject({ nextSeq: 7, parentSessionId: "source" });
			expect(branchLines.map((line) => [line.kind, line.namespace ?? line.id, line.seq])).toEqual([
				["header", "fork-branch", undefined],
				["entry", "root", 1],
				["value", "pi.branch.tip", 2],
				["value", "pi.lane.config", 3],
				["value", "pi.lane.state", 4],
			]);
			expect(branchLines.at(-1)).toMatchObject({
				value: { currentOperationId: null, lastOperationId: null, inbox: [] },
			});
			await branchFork.close(BACKGROUND_CONTEXT);
			const reopenedFork = await repo.open(branchFork.metadata, BACKGROUND_CONTEXT);
			const forkMutation = await reopenedFork.beginMutation(BACKGROUND_CONTEXT);
			expect(await forkMutation.commit([], BACKGROUND_CONTEXT)).toMatchObject({ firstSeq: 7 });
			await forkMutation.end(BACKGROUND_CONTEXT);
			await reopenedFork.close(BACKGROUND_CONTEXT);
			await repo.close(BACKGROUND_CONTEXT);
		});

		it("compacts interleaved rounds into a sequence-ordered snapshot that reopens", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = {
				fileSystem,
				path: "session.jsonl",
				now: () => NOW,
				compaction: always,
			};
			const doomed = storedValues.value<string>("test.doomed", "x");
			const storage = await JsonlStorage.create(options, header("compact-interleaved"), [], BACKGROUND_CONTEXT);
			const ids = ["first", "second", "third"];
			let parent: string | null = null;
			for (const id of ids) {
				await storage.commit(
					[
						entryWrite(id, parent),
						usageWrite(`usage-${id}`),
						storedValues.setValue(storedValues.branchTip("main"), id),
					],
					BACKGROUND_CONTEXT,
				);
				parent = id;
			}
			await storage.commit([storedValues.setValue(doomed, "x")], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.deleteValue(doomed)], BACKGROUND_CONTEXT);
			await storage.close(BACKGROUND_CONTEXT);

			// Reopen must succeed: the rewrite keeps every surviving write in one ascending sequence.
			const reopened = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
			expect(recordSummary(await readContent(fileSystem, "session.jsonl"))).toEqual([
				{
					kind: "header",
					op: undefined,
					seq: undefined,
					namespace: undefined,
					key: undefined,
					id: "compact-interleaved",
				},
				...ids.flatMap((id, index) => {
					const seq = 3 * index + 1;
					return [
						{ kind: "entry", op: undefined, seq, namespace: undefined, key: undefined, id },
						{
							kind: "usage",
							op: undefined,
							seq: seq + 1,
							namespace: undefined,
							key: undefined,
							id: `usage-${id}`,
						},
					];
				}),
				// Only the last branch-tip set survives; the surviving write keeps its sequence (9).
				{
					kind: "value",
					op: "set",
					seq: 9,
					namespace: "pi.branch.tip",
					key: "main",
					id: undefined,
				},
			]);
			expect((await reopened.getEntries(ids, BACKGROUND_CONTEXT)).get("third")).toMatchObject({
				parentId: "second",
				seq: 7,
			});
			expect((await reopened.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id)).toEqual([
				"usage-first",
				"usage-second",
				"usage-third",
			]);
			expect(await reopened.getValue(storedValues.branchTip("main"), BACKGROUND_CONTEXT)).toMatchObject({
				value: "third",
				seq: 9,
			});
			expect(await reopened.getStats(BACKGROUND_CONTEXT)).toMatchObject({ messageCount: 3 });
			expect(await reopened.commit([], BACKGROUND_CONTEXT)).toMatchObject({ firstSeq: 12 });
			await reopened.close(BACKGROUND_CONTEXT);
		});

		it("forks a session compacted after an early scalar without sequence reordering errors", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const repo = new JsonlSessionRepo({
				fileSystem,
				sessionsRoot: "sessions",
				now: () => NOW,
				compaction: always,
			});
			const session = await repo.create({ id: "source", cwd: "/workspace" }, BACKGROUND_CONTEXT);
			const doomed = storedValues.value<string>("test.doomed", "x");
			// The session-name scalar at sequence 1 must sort before the later entry when the rewrite fires.
			const seed = await session.beginMutation(BACKGROUND_CONTEXT);
			await seed.commit([storedValues.setValue(storedValues.sessionName, "seed")], BACKGROUND_CONTEXT);
			await seed.end(BACKGROUND_CONTEXT);
			const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
			await mutation.commit(
				[
					entryWrite("root"),
					storedValues.setValue(storedValues.branchTip("main"), "root"),
					storedValues.setValue(doomed, "x"),
					storedValues.deleteValue(doomed),
				],
				BACKGROUND_CONTEXT,
			);
			await mutation.end(BACKGROUND_CONTEXT);

			const openFork = await repo.fork(session.metadata, { id: "fork-open", scope: "tree" }, BACKGROUND_CONTEXT);
			expect(recordSummary(await readContent(fileSystem, openFork.metadata.path)).slice(1)).toEqual([
				{ kind: "value", op: "set", seq: 1, namespace: "pi.session.name", key: "", id: undefined },
				{ kind: "entry", op: undefined, seq: 2, namespace: undefined, key: undefined, id: "root" },
				{ kind: "value", op: "set", seq: 3, namespace: "pi.branch.tip", key: "main", id: undefined },
			]);
			await openFork.close(BACKGROUND_CONTEXT);
			await session.close(BACKGROUND_CONTEXT);

			const closedFork = await repo.fork(session.metadata, { id: "fork-closed", scope: "tree" }, BACKGROUND_CONTEXT);
			expect(await closedFork.getName(BACKGROUND_CONTEXT)).toBe("seed");
			expect(await closedFork.getValue(storedValues.branchTip("main"), BACKGROUND_CONTEXT)).toMatchObject({
				value: "root",
				seq: 3,
			});
			await closedFork.close(BACKGROUND_CONTEXT);
			await repo.close(BACKGROUND_CONTEXT);
		});

		it("holds queued commits until an in-progress fork source read completes", async () => {
			const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
			const options = {
				fileSystem,
				path: "session.jsonl",
				now: () => NOW,
				compaction: always,
			};
			const storage = await JsonlStorage.create(options, header("fork-hold"), [], BACKGROUND_CONTEXT);
			await storage.commit([storedValues.setValue(storedValues.sessionName, "one")], BACKGROUND_CONTEXT);
			const before = await readContent(fileSystem, "session.jsonl");
			const events: string[] = [];
			let releaseGate: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});

			const read = storage.forkSourceRead(async (nextSeq) => {
				events.push(`read:${nextSeq}`);
				await gate;
				return nextSeq;
			});
			const committing = storage
				.commit([storedValues.setValue(storedValues.sessionName, "two")], BACKGROUND_CONTEXT)
				.then(() => events.push("commit"));

			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(events).toEqual(["read:2"]);
			expect(await readContent(fileSystem, "session.jsonl")).toBe(before);

			releaseGate();
			expect(await read).toBe(2);
			await committing;
			expect(events).toEqual(["read:2", "commit"]);
			expect(await storage.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toMatchObject({ value: "two" });
			await storage.close(BACKGROUND_CONTEXT);
		});
	});

	it("rejects an unterminated header", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "session.jsonl", now: () => NOW };
		await fileSystem.writeFile("session.jsonl", JSON.stringify(header("torn")).slice(0, -4), BACKGROUND_CONTEXT);

		await expect(JsonlStorage.open(options, BACKGROUND_CONTEXT)).rejects.toThrow(/missing header/);
	});
});
