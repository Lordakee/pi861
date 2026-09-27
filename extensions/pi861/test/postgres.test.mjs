import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrateMemoryAuthority, OutboxConsumer, PostgresMemory } from "../src/postgres.ts";
import { FileStateStore } from "../src/live/store.ts";
import { LayeredMemory, emptyLayeredMemory } from "../src/live/layered-memory.ts";

const principal = { tenantId: "tenant1", principalId: "agent1", readScopes: ["project:p1"], writeScopes: ["project:p1"] };
const input = { requestId: "request1", expectedRevision: null, item: {
	id: "fact1", scope: "project:p1", kind: "project", abstract: "A", overview: "Overview", full: "A durable fact",
	source: { kind: "user", ref: "event:1" }, status: "confirmed",
} };
function database(handler = () => ({ rows: [] })) {
	const calls = [];
	let releases = 0;
	let connections = 0;
	const pool = { async connect() {
		connections++;
		return { async query(sql, params) {
			calls.push({ sql, params });
			return handler(sql, params);
		}, release() { releases++; } };
	} };
	return { calls, pool, get releases() { return releases; }, get connections() { return connections; } };
}
/** Minimal in-memory model of the memory tables so multi-statement flows can be exercised without PostgreSQL. */
function memoryTables() {
	const items = new Map();       // `${tenant}|${scope}|${id}` -> body
	const receipts = new Map();    // `${tenant}|${principal}|${requestId}` -> { intent_hash, receipt }
	const tombstones = new Set();  // `${tenant}|${scope}|${fingerprint}`
	const outbox = [];             // [tenant, scope, id, revision, action]
	const statements = [];
	const key = (tenant, scope, id) => `${tenant}|${scope}|${id}`;
	const handler = (sql, params) => {
		statements.push(sql);
		if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SELECT set_config") || sql.startsWith("SELECT pg_advisory")) return { rows: [] };
		if (sql.startsWith("SELECT intent_hash, receipt FROM pi861_memory_receipts")) {
			const found = receipts.get(`${params[0]}|${params[1]}|${params[2]}`);
			return { rows: found ? [found] : [] };
		}
		if (sql.startsWith("INSERT INTO pi861_memory_receipts")) {
			receipts.set(`${params[0]}|${params[1]}|${params[2]}`, { intent_hash: params[4], receipt: JSON.parse(params[5]) });
			return { rows: [] };
		}
		if (sql.startsWith("SELECT fingerprint FROM pi861_memory_tombstones")) {
			return { rows: params[2].filter((fingerprint) => tombstones.has(`${params[0]}|${params[1]}|${fingerprint}`)).map(() => ({})) };
		}
		if (sql.startsWith("INSERT INTO pi861_memory_tombstones")) {
			tombstones.add(`${params[0]}|${params[1]}|${params[2]}`);
			return { rows: [] };
		}
		if (sql.startsWith("INSERT INTO pi861_memory_items")) {
			items.set(key(params[0], params[1], params[2]), JSON.parse(params[4]));
			return { rows: [] };
		}
		if (sql.startsWith("INSERT INTO pi861_memory_versions") || sql.startsWith("INSERT INTO pi861_memory_outbox")) {
			if (sql.startsWith("INSERT INTO pi861_memory_outbox")) outbox.push([params[0], params[1], params[2], params[3], params[4]]);
			return { rows: [] };
		}
		if (sql.startsWith("SELECT scope_key, memory_id, body FROM pi861_memory_items")) {
			return { rows: [...items.entries()].filter(([k]) => k.startsWith(`${params[0]}|`) && params[1].includes(k.split("|")[1]))
				.sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, body]) => ({ scope_key: k.split("|")[1], memory_id: k.split("|")[2], body })) };
		}
		if (sql.startsWith("SELECT scope_key, memory_id, revision, action FROM pi861_memory_outbox")) {
			return { rows: outbox.filter((entry) => entry[0] === params[0]).map(entry => ({ scope_key: entry[1], memory_id: entry[2], revision: entry[3], action: entry[4] })) };
		}
		if (sql.startsWith("DELETE FROM pi861_memory_outbox")) {
			for (let index = outbox.length - 1; index >= 0; index--) {
				const entry = outbox[index];
			if (entry[0] === params[0] && entry[1] === params[1] && entry[2] === params[2] && entry[3] === params[3]) outbox.splice(index, 1);
			}
			return { rows: [] };
		}
		if (sql.startsWith("SELECT body FROM pi861_memory_items") && sql.includes("FOR UPDATE")) {
			const body = items.get(key(params[0], params[1], params[2]));
			return { rows: body ? [{ body }] : [] };
		}
		if (sql.startsWith("SELECT body FROM pi861_memory_items") && sql.includes("ORDER BY memory_id")) {
			const rows = [...items.entries()].filter(([k, body]) => k.startsWith(`${params[0]}|${params[1]}|`) &&
				body.status !== "withdrawn" && k.split("|")[2] > params[2])
				.sort((a, b) => a[0] < b[0] ? -1 : 1).slice(0, params[3]).map(([, body]) => ({ body }));
			return { rows };
		}
		if (sql.startsWith("SELECT body FROM pi861_memory_items")) {
			const body = items.get(key(params[0], params[1], params[2]));
			return { rows: body && body.status !== "withdrawn" ? [{ body }] : [] };
		}
		throw new Error(`Simulated database does not implement: ${sql.slice(0, 60)}`);
	};
	return { handler, items, outbox, tombstones, statements, pool: { async connect() { return { query: async (sql, params) => handler(sql, params), release() {} }; } } };
}
test("writes commit canonical item, version, outbox and receipt together", async () => {
	const db = database();
	const result = await new PostgresMemory(db.pool, principal).put(input);
	assert.equal(result.state, "committed");
	assert.equal(db.calls[0].sql, "BEGIN");
	assert.equal(db.calls.at(-1).sql, "COMMIT");
	for (const table of ["pi861_memory_items", "pi861_memory_versions", "pi861_memory_outbox", "pi861_memory_receipts"])
		assert.ok(db.calls.some((call) => call.sql.startsWith(`INSERT INTO ${table}`)));
	assert.equal(db.releases, 1);
	const settings = db.calls.find((call) => call.sql.includes("set_config"));
	assert.deepEqual(settings.params.slice(0, 2), ["tenant1", "agent1"]);
	assert.match(settings.sql, /true/);
});
test("no committed receipt is exposed before database commit completes", async () => {
	let unblock;
	const commit = new Promise((resolve) => { unblock = resolve; });
	const db = database(async (sql) => { if (sql === "COMMIT") await commit; return { rows: [] }; });
	let resolved = false;
	const operation = new PostgresMemory(db.pool, principal).put(input).then((value) => { resolved = true; return value; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(resolved, false);
	unblock();
	assert.equal((await operation).state, "committed");
});
test("ambiguous commit response rejects and keeps original request identity replayable", async () => {
	const db = database((sql) => { if (sql === "COMMIT") throw new Error("lost commit response"); return { rows: [] }; });
	await assert.rejects(new PostgresMemory(db.pool, principal).put(input), /lost commit/);
	assert.equal(db.calls.at(-1).sql, "ROLLBACK");
	assert.equal(db.releases, 1);
	const receiptWrite = db.calls.find((call) => call.sql.startsWith("INSERT INTO pi861_memory_receipts"));
	assert.equal(receiptWrite.params[2], "request1");
});
test("replay returns original receipt and never rewrites data", async () => {
	let stored;
	const first = database((sql, params) => {
		if (sql.startsWith("INSERT INTO pi861_memory_receipts")) stored = { intent_hash: params[4], receipt: JSON.parse(params[5]) };
		return { rows: [] };
	});
	const original = await new PostgresMemory(first.pool, principal).put(input);
	const second = database((sql) => ({ rows: sql.startsWith("SELECT intent_hash") ? [stored] : [] }));
	assert.deepEqual(await new PostgresMemory(second.pool, principal).put(input), original);
	assert.ok(second.calls.every((call) => !call.sql.startsWith("INSERT")));
});
test("idempotency mismatch rejects without changing an existing record", async () => {
	const db = database((sql) => ({ rows: sql.startsWith("SELECT intent_hash") ? [{ intent_hash: "different", receipt: {} }] : [] }));
	await assert.rejects(new PostgresMemory(db.pool, principal).put(input), /idempotency/);
	assert.equal(db.calls.at(-1).sql, "ROLLBACK");
	assert.ok(db.calls.every((call) => !call.sql.startsWith("INSERT")));
});
test("stale revisions fail before publication", async () => {
	const db = database((sql) => ({ rows: sql.startsWith("SELECT body") ? [{ body: { ...input.item, revision: 2, updatedAt: 0 } }] : [] }));
	await assert.rejects(new PostgresMemory(db.pool, principal).put({ ...input, expectedRevision: 1 }), /revision/);
	assert.ok(db.calls.every((call) => !call.sql.startsWith("INSERT")));
});
test("unauthorized scope does not connect to the database", async () => {
	const db = database();
	const store = new PostgresMemory(db.pool, principal);
	assert.equal(await store.get("project:other", "fact1"), undefined);
	await assert.rejects(store.put({ ...input, item: { ...input.item, scope: "project:other" } }), /authorized/);
	assert.equal(db.connections, 0);
});
test("search uses parameters and explicit tenant and allowed scopes", async () => {
	const db = database();
	await new PostgresMemory(db.pool, principal).search("'); DROP TABLE t; --");
	const call = db.calls.find((entry) => entry.sql.startsWith("SELECT body"));
	assert.ok(!call.sql.includes("DROP TABLE"));
	assert.equal(call.params[0], "tenant1");
	assert.deepEqual(call.params[1], ["project:p1"]);
	assert.equal(call.params[2], "'); DROP TABLE t; --");
});
test("withdrawal commits content and source tombstones and an invalidation event", async () => {
	const db = database((sql) => ({ rows: sql.startsWith("SELECT body") ? [{ body: { ...input.item, revision: 1, updatedAt: 0 } }] : [] }));
	await new PostgresMemory(db.pool, principal).withdraw("withdraw1", "project:p1", "fact1", 1);
	assert.equal(db.calls.filter((call) => call.sql.startsWith("INSERT INTO pi861_memory_tombstones")).length, 2);
	const event = db.calls.find((call) => call.sql.startsWith("INSERT INTO pi861_memory_outbox"));
	assert.equal(event.params[4], "withdraw");
	assert.equal(db.calls.at(-1).sql, "COMMIT");
});
test("listing pages key-ordered without withdrawn records and hides other scopes", async () => {
	const tables = memoryTables();
	const store = new PostgresMemory(tables.pool, principal);
	for (const id of ["b", "a", "c"]) await store.put({ ...input, requestId: `r-${id}`, item: { ...input.item, id } });
	const first = await store.list("project:p1", "", 2);
	assert.deepEqual(first.items.map((item) => item.id), ["a", "b"]);
	assert.equal(first.nextId, "b");
	const second = await store.list("project:p1", "b", 2);
	assert.deepEqual(second.items.map((item) => item.id), ["c"]);
	assert.equal(second.nextId, undefined);
	await store.withdraw("w-c", "project:p1", "c", 1);
	assert.deepEqual((await store.list("project:p1", "b", 2)).items, []);
	assert.deepEqual((await store.list("project:other", "", 2)).items, []);
});

test("outbox consumer applies events, deletes only accepted rows and keeps failures queued", async () => {
	const tables = memoryTables();
	const store = new PostgresMemory(tables.pool, principal);
	await store.put(input);
	await store.withdraw("w1", "project:p1", "fact1", 1);
	assert.equal(tables.outbox.length, 2); // queued events are not yet an updated index
	const applied = [];
	let fail = true;
	const consumer = new OutboxConsumer(tables.pool, principal);
	await assert.rejects(consumer.consume(10, async (event) => {
		if (fail) throw new Error("index rebuild failed");
		applied.push(event);
	}), /index rebuild failed/);
	assert.equal(tables.outbox.length, 2); // failure keeps the events queued
	assert.ok(tables.statements.includes("ROLLBACK"));
	fail = false;
	const outcome = await consumer.consume(10, async (event) => applied.push(event));
	assert.equal(outcome.processed, 2);
	assert.deepEqual(applied.map((event) => event.action), ["index", "withdraw"]);
	assert.deepEqual(applied.map((event) => `${event.scope}/${event.memoryId}@${event.revision}`), ["project:p1/fact1@1", "project:p1/fact1@2"]);
	assert.equal(tables.outbox.length, 0); // accepted rows are removed in the same transaction
	assert.equal((await consumer.consume(10, async () => {})).processed, 0);
	const select = tables.statements.find((sql) => sql.startsWith("SELECT scope_key, memory_id, revision, action FROM pi861_memory_outbox"));
	assert.ok(select.includes("FOR UPDATE SKIP LOCKED"));
});

test("explicit migration moves snapshot authority into per-record rows, verifies and cuts over", async t => {
	const dir = mkdtempSync(join(tmpdir(), "pi861-migrate-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fileStore = new FileStateStore(join(dir, "memory.json"), emptyLayeredMemory("tenant1"));
	const layered = new LayeredMemory(fileStore, principal);
	const entry = (id, full) => ({ id, scope: "project:p1", kind: "project", status: "confirmed", full,
		abstract: full.slice(0, 20), overview: full, source: { kind: "user", ref: `event:${id}` } });
	await layered.put({ requestId: "r-a", expectedRevision: null, item: entry("a", "Keep pnpm.") });
	await layered.put({ requestId: "r-b", expectedRevision: null, item: entry("b", "Use PostgreSQL.") });
	await layered.put({ requestId: "r-c", expectedRevision: null, item: entry("c", "Old choice, withdrawn.") });
	await layered.withdraw("w-c", "project:p1", "c", 1);
	const tables = memoryTables();
	const target = new PostgresMemory(tables.pool, principal);
	const backupPath = join(dir, "backup.json");
	const report = await migrateMemoryAuthority(fileStore, target, { backupPath, sourceLabel: "file state store" });
	assert.equal(report.source, "file state store");
	assert.equal(report.itemsMigrated, 3);
	assert.equal(report.withdrawnMigrated, 1);
	assert.equal(report.tombstonesMigrated, 2);
	assert.equal(report.receiptsDropped, 4);
	assert.equal(report.verified, true); assert.equal(report.cutOver, true);
	assert.equal(report.sourceDigest, report.targetDigest);
	// Revisions are preserved exactly.
	const exported = await target.exportItems();
	assert.deepEqual(exported.map((item) => [item.id, item.revision, item.status]).sort(),
		[["a", 1, "confirmed"], ["b", 1, "confirmed"], ["c", 2, "withdrawn"]]);
	// The backup keeps the complete old authority.
	const backup = JSON.parse(readFileSync(backupPath, "utf8"));
	assert.equal(backup.memory.items.length, 3);
	// Cutover: the old snapshot no longer duplicates the items.
	const after = await fileStore.read();
	assert.equal(after.memory.items.length, 0);
	assert.equal(after.jobs.length, 3); // control state (extraction jobs, one obsoleted) survives
	// Tombstones suppress resurrection through the new authority.
	await assert.rejects(target.put({ requestId: "resurrect", expectedRevision: null,
		item: { ...entry("z", "Old choice, withdrawn."), source: { kind: "user", ref: "event:c" } } }), /Withdrawn/);
	// Re-running the migration is a verified no-op.
	const again = await migrateMemoryAuthority(fileStore, target, { backupPath: join(dir, "backup2.json") });
	assert.equal(again.itemsMigrated, 0); assert.equal(again.verified, true);
});

test("migration refuses unexplainable tombstones instead of copying them silently", async t => {
	const dir = mkdtempSync(join(tmpdir(), "pi861-migrate-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fileStore = new FileStateStore(join(dir, "memory.json"), emptyLayeredMemory("tenant1"));
	const layered = new LayeredMemory(fileStore, principal);
	await layered.put({ requestId: "r-a", expectedRevision: null, item: { id: "a", scope: "project:p1", kind: "project", status: "confirmed",
		full: "Fact", abstract: "Fact", overview: "Fact", source: { kind: "user", ref: "event:a" } } });
	await fileStore.update((state) => { state.memory.tombstones.push("orphan-fingerprint"); });
	const tables = memoryTables();
	await assert.rejects(
		migrateMemoryAuthority(fileStore, new PostgresMemory(tables.pool, principal), { backupPath: join(dir, "backup.json") }),
		/not derived from withdrawn items/,
	);
	assert.equal((await fileStore.read()).memory.items.length, 1); // nothing was cut over
});

// m3r-F004 regression: control state lost while the PostgreSQL authority already committed.
test("reconcile rebuilds control state from the PostgreSQL item authority, withdrawn included", async t => {
	const dir = mkdtempSync(join(tmpdir(), "pi861-reconcile-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fileStore = new FileStateStore(join(dir, "memory.json"), emptyLayeredMemory("tenant1"));
	const authority = new PostgresMemory(memoryTables().pool, principal);
	// Items committed directly to the authority; the control-state transaction after them never ran.
	await authority.put(input);
	await authority.put({ ...input, requestId: "request2", item: { ...input.item, id: "fact2" } });
	await authority.withdraw("w1", "project:p1", "fact1", 1);
	const memory = new LayeredMemory(fileStore, principal, { items: authority });
	assert.equal((await memory.delta()).changes.length, 0);
	const healed = await memory.reconcile();
	assert.equal(healed.addedChanges, 2);   // fact1@2 withdrawn plus fact2@1
	assert.equal(healed.addedJobs, 1);      // an extraction job only for the live record
	assert.deepEqual(await memory.reconcile(), { addedChanges: 0, addedJobs: 0 });  // re-running adds nothing
	assert.deepEqual((await memory.delta()).changes.map(change => [change.id, change.revision, change.withdrawn]).sort(),
		[["fact1", 2, true], ["fact2", 1, false]]);
});
