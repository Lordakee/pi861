import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStateStore, ResilientBackend } from "../src/live/store.ts";
import { ContextAssembler, hostAssemblyTrigger, LayeredMemory, emptyLayeredMemory } from "../src/live/layered-memory.ts";
import { LocalMemory } from "../src/memory.ts";
const principal = { tenantId: "t", principalId: "a", readScopes: ["project:p"], writeScopes: ["project:p"] };
const item = (id, full = "用户决定使用 PostgreSQL，记录来自验收会议。") => ({ id, scope: "project:p", kind: "project", status: "confirmed", full, abstract: full, overview: full, source: { kind: "user", ref: `event:${id}` } });
function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi861-memory-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStateStore(join(dir, "memory.json"), emptyLayeredMemory("t"));
  return { dir, store, memory: new LayeredMemory(store, principal, options) };
}
test("durable memory survives a new backend/session instance", async t => {
  const { store, memory } = setup(t);
  await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const next = new LayeredMemory(store, principal);
  assert.match((await next.get("project:p", "a")).full, /PostgreSQL/);
  assert.equal((await next.search("为什么使用 PostgreSQL"))[0].id, "a");
});
test("two file writers cannot overwrite the same revision", async t => {
  const { store, memory } = setup(t), other = new LayeredMemory(store, { ...principal, principalId: "b" });
  await memory.put({ requestId: "start", expectedRevision: null, item: item("a") });
  const outcomes = await Promise.allSettled([
    memory.put({ requestId: "u1", expectedRevision: 1, item: item("a", "first change") }),
    other.put({ requestId: "u2", expectedRevision: 1, item: item("a", "second change") })]);
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
  assert.equal((await memory.get("project:p", "a")).revision, 2);
});
test("write replay does not append a second delta or extraction job", async t => {
  const { store, memory } = setup(t), request = { requestId: "r1", expectedRevision: null, item: item("a") };
  assert.deepEqual(await memory.put(request), await memory.put(request));
  assert.equal((await store.read()).jobs.length, 1); assert.equal((await memory.delta()).changes.length, 1);
});
test("delta paging does not lose simultaneous writes", async t => {
  const { memory } = setup(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => memory.put({ requestId: `r${i}`, expectedRevision: null, item: item(`id${i}`) })));
  let cursor = 0, count = 0, more;
  do { const page = await memory.delta(cursor, 3); count += page.changes.length; cursor = page.cursor; more = page.hasMore; } while (more);
  assert.equal(count, 12); assert.equal(cursor, 12);
});
test("generated L0/L1 does not replace full evidence", async t => {
  const { memory } = setup(t), source = item("a"); await memory.put({ requestId: "r1", expectedRevision: null, item: source });
  const stats = await memory.enrich({ modelId: "test", async extract(input) {
    assert.equal(input.text, source.full);
    return { abstract: "数据库选型", overview: "已记录的数据库选择：PostgreSQL。", facts: [{ text: "选择 PostgreSQL", quote: "使用 PostgreSQL" }] };
  } }, { signal: new AbortController().signal });
  assert.equal(stats.completed, 1);
  const stored = await memory.get("project:p", "a");
  assert.equal(stored.abstract, "数据库选型"); assert.equal(stored.full, source.full); assert.equal(stored.revision, 1);
});
test("withdrawal while an extractor runs cannot resurrect memory", async t => {
  const { memory, store } = setup(t); await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  let release, started; const ready = new Promise(r => { started = r; });
  const job = memory.enrich({ modelId: "test", extract() { started(); return new Promise(r => { release = r; }); } }, { signal: new AbortController().signal });
  await ready; await memory.withdraw("withdraw", "project:p", "a", 1);
  release({ abstract: "数据库", overview: "使用 PostgreSQL", facts: [] });
  assert.equal((await job).obsolete, 1); assert.equal(await memory.get("project:p", "a"), undefined);
  assert.equal(Object.keys((await store.read()).projections).length, 0);
});
test("fabricated extraction quotations fail closed", async t => {
  const { memory } = setup(t); await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const outcome = await memory.enrich({ modelId: "test", async extract() { return { abstract: "bad", overview: "bad", facts: [{ text: "invented", quote: "not in source" }] }; } }, { signal: new AbortController().signal });
  assert.equal(outcome.failed, 1); assert.equal((await memory.get("project:p", "a")).abstract, item("a").abstract);
});
test("other project cannot search, list or receive delta", async t => {
  const { store, memory } = setup(t); await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const other = new LayeredMemory(store, { ...principal, readScopes: ["project:q"], writeScopes: ["project:q"] });
  assert.equal((await other.search("PostgreSQL")).length, 0);
  assert.deepEqual((await other.list("project:p")).items, []); assert.equal((await other.delta()).changes.length, 0);
});

test("failed extraction retries with backoff and then succeeds", async t => {
  const { memory, store } = setup(t, { retry: { baseDelayMs: 60_000, maxAttempts: 3 } });
  await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const startedAt = Date.now();
  let calls = 0;
  const extractor = { modelId: "test", async extract() { calls++; if (calls === 1) throw new Error("temporary network failure"); return { abstract: "数据库选型", overview: "已记录的数据库选择：PostgreSQL。", facts: [] }; } };
  const first = await memory.enrich(extractor, { signal: new AbortController().signal });
  assert.equal(first.failed, 1); assert.equal(first.completed, 0); assert.equal(calls, 1);
  const job = (await store.read()).jobs[0];
  assert.equal(job.state, "failed");
  assert.equal(job.attempts, 1);
  assert.equal(job.failure.class, "transient");
  assert.ok(job.nextAttemptAt > startedAt);
  // Still inside the backoff window: the same loop and later wakes cannot reclaim it.
  assert.equal((await memory.enrich(extractor, { signal: new AbortController().signal })).failed, 0);
  assert.equal(calls, 1);
  // The backoff window elapses (simulated deterministically).
  await store.update(state => { state.jobs[0].nextAttemptAt = 0; });
  const second = await memory.enrich(extractor, { signal: new AbortController().signal });
  assert.equal(second.completed, 1); assert.equal(second.failed, 0);
  assert.equal(calls, 2);
  assert.match((await memory.get("project:p", "a")).abstract, /数据库选型/);
});

test("backoff delays reclaim and exhausted retries become dead with manual entries", async t => {
  const { memory, store } = setup(t, { retry: { baseDelayMs: 60_000, maxAttempts: 2 } });
  await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const failing = { modelId: "test", async extract() { throw new Error("model overloaded, try later"); } };
  assert.equal((await memory.enrich(failing, { signal: new AbortController().signal })).failed, 1);
  assert.equal((await memory.enrich(failing, { signal: new AbortController().signal })).failed, 0); // still backing off
  await store.update(state => { state.jobs[0].nextAttemptAt = 0; });
  const exhausted = await memory.enrich(failing, { signal: new AbortController().signal });
  assert.equal(exhausted.failed, 1); assert.equal(exhausted.dead, 1);
  const dead = await memory.deadJobs();
  assert.equal(dead.length, 1);
  assert.equal(dead[0].state, "dead");
  assert.equal(dead[0].attempts, 2);
  assert.equal(dead[0].failure.class, "transient");
  // No further automatic claim after exhaustion.
  assert.equal((await memory.enrich(failing, { signal: new AbortController().signal })).failed, 0);
  // Manual entry: abandon the dead job.
  assert.equal(await memory.abandonJob(dead[0].id), true);
  assert.equal((await memory.deadJobs()).length, 0);
  assert.equal(await memory.abandonJob("missing"), false);
});

test("a dead job can be requeued manually and then completes", async t => {
  const { memory, store } = setup(t, { retry: { baseDelayMs: 60_000, maxAttempts: 1 } });
  await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  assert.equal((await memory.enrich({ modelId: "test", async extract() { throw new Error("connection closed"); } }, { signal: new AbortController().signal })).dead, 1);
  const [dead] = await memory.deadJobs();
  assert.equal(await memory.retryJob(dead.id), true);
  const outcome = await memory.enrich({ modelId: "test", async extract() { return { abstract: "摘要", overview: "概览", facts: [] }; } }, { signal: new AbortController().signal });
  assert.equal(outcome.completed, 1);
  assert.equal((await memory.deadJobs()).length, 0);
  assert.equal((await store.read()).jobs[0].state, "done");
});

test("context assembly covers model change, compaction and node switch", async t => {
  const { memory } = setup(t);
  const constraint = { ...item("policy"), kind: "constraint", full: "禁止在未经批准时访问生产数据库。", abstract: "生产访问约束", overview: "生产访问约束" };
  const working = { ...item("state"), kind: "working", full: "当前正在迁移 store.ts。", abstract: "当前工作状态", overview: "当前工作状态" };
  const experience = { ...item("lesson"), kind: "experience", full: "曾经通过重试解决了 PostgreSQL 超时。", abstract: "历史经验", overview: "历史经验" };
  for (const [index, entry] of [constraint, working, experience].entries()) {
    await memory.put({ requestId: `r${index}`, expectedRevision: null, item: entry });
  }
  const assembler = new ContextAssembler(memory, "project:p", { maxBytes: 8000 });
  for (const trigger of ["session_start", "model_change", "compaction", "node_change"]) {
    const assembled = await assembler.assemble(trigger);
    assert.equal(assembled.trigger, trigger);
    assert.match(assembled.text, /生产访问约束/);   // fixed constraints assemble directly
    assert.match(assembled.text, /当前工作状态/);   // working state assembles directly
    assert.ok(!assembled.text.includes("历史经验"));  // long-term experience is not auto-assembled
  }
  const queried = await assembler.assemble("session_resume", "PostgreSQL 超时");
  assert.ok(queried.text.includes("历史经验"));      // query-matched experience fills the budget
  // Event-recall: incremental model since the cursor.
  const drained = await assembler.recallEvents();
  assert.equal(drained.changes.length, 3);                       // consume the initial writes
  const before = assembler.eventCursor;
  await memory.put({ requestId: "r-new", expectedRevision: null, item: item("new") });
  const recalled = await assembler.recallEvents();
  assert.equal(recalled.cursor, before + 1);
  assert.deepEqual(recalled.changes.map(change => change.id), ["new"]);
  assert.match(recalled.text, /PostgreSQL/);
  const empty = await assembler.recallEvents();
  assert.equal(empty.changes.length, 0); assert.equal(empty.hasMore, false);
});

// R6.3: host events map to assembly triggers; every non-resume start reason stays inert.
test("host assembly trigger mapping covers resume and tree navigation without false positives", () => {
  assert.equal(hostAssemblyTrigger({ type: "session_start", reason: "resume", previousSessionFile: "/old.jsonl" }), "session_resume");
  assert.equal(hostAssemblyTrigger({ type: "session_tree", newLeafId: "n1", oldLeafId: null }), "node_change");
  for (const reason of ["startup", "reload", "new", "fork"]) assert.equal(hostAssemblyTrigger({ type: "session_start", reason }), undefined);
  assert.equal(hostAssemblyTrigger({ type: "session_shutdown", reason: "quit" }), undefined);
  assert.equal(hostAssemblyTrigger(undefined), undefined);
});

// m3r-F008 regression: one record with several changes in a page used to be packed once per change.
test("event recall packs each changed record once per page", async t => {
  const { memory } = setup(t);
  await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  await memory.enrich({ modelId: "test", async extract() { return { abstract: "数据库选型", overview: "已记录的数据库选择：PostgreSQL。", facts: [] }; } }, { signal: new AbortController().signal });
  const assembler = new ContextAssembler(memory, "project:p");
  const recalled = await assembler.recallEvents();
  assert.equal(recalled.changes.length, 2);              // the change feed keeps both events (write plus projection)
  const packedIds = recalled.text.split("\n").filter(Boolean).map(line => JSON.parse(line).id);
  assert.deepEqual(packedIds, ["a"]);                   // but the current view is packed once, not twice
});

// m3r-F006 regression: fixed assembly used to see only the first 100 records of a scope.
test("fixed assembly pages past the first hundred records", async t => {
  const { memory } = setup(t);
  for (let index = 0; index < 150; index++) {
    const full = `当前工作状态条目 ${index}`;
    await memory.put({ requestId: `r${index}`, expectedRevision: null,
      item: { ...item(`w${String(index).padStart(3, "0")}`, full), kind: "working" } });
  }
  const assembler = new ContextAssembler(memory, "project:p", { maxBytes: 2_000_000 });
  const assembled = await assembler.assemble("session_start");
  assert.equal(assembled.omitted, 0);
  assert.equal(new Set(assembled.text.split("\n").map(line => JSON.parse(line).id)).size, 150);  // every fixed record reached the pack
  const tight = new ContextAssembler(memory, "project:p", { maxBytes: 400 });
  const trimmed = await tight.assemble("session_start");
  assert.ok(trimmed.usedBytes <= 400); assert.ok(trimmed.omitted > 0);  // the byte budget still bounds the output
});

// m3r-F007 regression: a delegated backend without listing used to answer with a silent empty page.
test("delegated authority without listing fails fast instead of hiding records", async t => {
  const { store } = setup(t);
  const memory = new LayeredMemory(store, principal, { items: {
    async get() { return undefined; }, async search() { return []; },
    async put() { throw new Error("unused"); }, async withdraw() { throw new Error("unused"); },
  } });
  await assert.rejects(memory.list("project:p"), /does not support listing/);
});

// m3r-F004 regression: items committed to the delegate while the control-state transaction never ran.
test("reconcile rebuilds control state lost in the delegated-commit crash window", async t => {
  const { store } = setup(t);
  const authority = new LocalMemory(principal);
  await authority.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  await authority.put({ requestId: "r2", expectedRevision: null, item: item("b") });
  await authority.withdraw("w1", "project:p", "a", 1);
  const memory = new LayeredMemory(store, principal, { items: authority });
  assert.equal((await memory.delta()).changes.length, 0);  // the crash window left no control state
  const healed = await memory.reconcile();
  assert.equal(healed.addedChanges, 2);   // a@2 withdrawn plus b@1; the intermediate a@1 has no authority record anymore
  assert.equal(healed.addedJobs, 1);      // an extraction job only for the live record
  const rerun = await memory.reconcile();
  assert.equal(rerun.addedChanges, 0); assert.equal(rerun.addedJobs, 0);  // re-running adds nothing
  const state = await store.read();
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].memoryId, "b"); assert.equal(state.jobs[0].state, "queued");
  assert.deepEqual((await memory.delta()).changes.map(change => [change.id, change.revision, change.withdrawn]).sort(),
    [["a", 2, true], ["b", 1, false]]);
  const outcome = await memory.enrich({ modelId: "test", async extract() { return { abstract: "数据库选型", overview: "使用 PostgreSQL。", facts: [] }; } }, { signal: new AbortController().signal });
  assert.equal(outcome.completed, 1);     // the healed job runs normally
  const embedded = setup(t);
  assert.deepEqual(await embedded.memory.reconcile(), { addedChanges: 0, addedJobs: 0 });  // embedded mode has nothing to reconcile
});

test("reconcile falls back to listing when the authority cannot export", async t => {
  const { store } = setup(t);
  const authority = new LocalMemory(principal);
  const memory = new LayeredMemory(store, principal, { items: {
    get: (scope, id) => authority.get(scope, id), search: (query, limit) => authority.search(query, limit),
    put: write => authority.put(write), withdraw: (requestId, scope, id, revision) => authority.withdraw(requestId, scope, id, revision),
    list: (scope, afterId, limit) => authority.list(scope, afterId, limit),  // listing only: no exportItems
  } });
  await authority.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const healed = await memory.reconcile();
  assert.equal(healed.addedChanges, 1); assert.equal(healed.addedJobs, 1);
  assert.deepEqual(await memory.reconcile(), { addedChanges: 0, addedJobs: 0 });
});

test("layered memory delegates item authority and keeps only control state", async t => {
  const { dir, store } = setup(t);
  const authorityPath = join(dir, "authority.json");
  const loadAuthority = () => existsSync(authorityPath) ? JSON.parse(readFileSync(authorityPath, "utf8")) : undefined;
  const delegate = () => new LocalMemory(principal, loadAuthority(), next => writeFileSync(authorityPath, JSON.stringify(next)));
  const memory = new LayeredMemory(store, principal, { items: delegate() });
  await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const stored = JSON.parse(readFileSync(authorityPath, "utf8"));
  assert.equal(stored.items.length, 1);                       // the item lives in the per-record authority
  assert.equal((await store.read()).memory.items.length, 0);  // control state carries no second copy
  assert.equal((await memory.delta()).changes.length, 1);
  const replay = await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  assert.equal(replay.revision, 1);
  assert.equal((await memory.delta()).changes.length, 1);     // replay adds no second delta or job
  assert.equal((await store.read()).jobs.length, 1);
  const outcome = await memory.enrich({ modelId: "test", async extract() { return { abstract: "数据库选型", overview: "使用 PostgreSQL。", facts: [] }; } }, { signal: new AbortController().signal });
  assert.equal(outcome.completed, 1);
  assert.match((await memory.get("project:p", "a")).abstract, /数据库选型/);
  await memory.withdraw("w1", "project:p", "a", 1);
  assert.equal(await memory.get("project:p", "a"), undefined);
  assert.equal(JSON.parse(readFileSync(authorityPath, "utf8")).items[0].status, "withdrawn");
  const withdrawnChange = (await memory.delta()).changes.find(change => change.id === "a" && change.withdrawn);
  assert.ok(withdrawnChange);
});

test("unavailable database leaves explicitly uncommitted local records that flush later", async t => {
  const { dir } = setup(t);
  const pendingStore = new FileStateStore(join(dir, "pending.json"), { pending: [] });
  const writes = [];
  const failing = { async put(input) { writes.push(input.requestId); throw new Error("connection refused"); } };
  const buffer = new ResilientBackend(failing, pendingStore);
  const receipt = await buffer.put({ requestId: "req-1", expectedRevision: null, item: item("a") }, { critical: true });
  assert.equal(receipt.state, "pending");
  const report = await buffer.pendingReport();
  assert.equal(report.count, 1); assert.equal(report.critical, 1); assert.equal(report.reasons[0], "connection refused");
  assert.deepEqual(report.dead, []);
  await assert.rejects(buffer.assertCommitted("goal milestone"), /"goal milestone" paused/);
  // Restart with a working delegate; the queue itself survived the instance change.
  const live = new LocalMemory(principal);
  const resumed = new ResilientBackend(live, pendingStore);
  const flushed = await resumed.flush();
  assert.equal(flushed.committed, 1); assert.equal(flushed.remaining, 0);
  assert.equal(writes.length, 1);                                 // same requestId, no duplicate submission
  assert.equal((await live.get("project:p", "a")).id, "a");
  await resumed.assertCommitted("goal milestone");               // the boundary gate opens again
  const replay = await resumed.flush();
  assert.equal(replay.committed, 0);
});

const queuedPut = (requestId, id, critical = false) => ({ kind: "put", queuedAt: 1, reason: "down", critical,
  input: { requestId, expectedRevision: null, item: item(id) } });

// m3r-F002 regression: two concurrent flush() calls used to consume the same head and silently drop the entries behind it.
test("concurrent flush serializes so no queued operation is lost", async t => {
  const { dir } = setup(t);
  const pendingStore = new FileStateStore(join(dir, "pending.json"), { pending: [] });
  const submitted = [];
  let release; const gate = new Promise(resolve => { release = resolve; }); let holding = true;
  const backend = {
    async get() {}, async search() { return []; },
    async put(input) {
      submitted.push(input.requestId);
      if (holding) { holding = false; await gate; }  // stall the first submission while the second flush is already waiting
      return { requestId: input.requestId, state: "committed", id: input.item.id, scope: input.item.scope, revision: 1 };
    },
    async withdraw() { throw new Error("unused"); },
  };
  await pendingStore.update(state => { state.pending.push(queuedPut("op1", "a"), queuedPut("op2", "b")); });
  const resilient = new ResilientBackend(backend, pendingStore);
  const first = resilient.flush();   // enters put(op1) and stalls inside the backend
  const second = resilient.flush();  // must queue behind the first, not re-read the same head
  await new Promise(resolve => setImmediate(resolve));
  release();
  const outcomes = await Promise.all([first, second]);
  const queue = (await pendingStore.read()).pending;
  for (const requestId of ["op1", "op2"]) {                       // every queue item is committed or still queued
    assert.ok(submitted.includes(requestId) || queue.some(entry => entry.input.requestId === requestId),
      `${requestId} vanished from both the backend and the queue`);
  }
  assert.deepEqual(submitted.sort(), ["op1", "op2"]);            // each item reached the backend exactly once
  assert.equal(queue.length, 0);
  assert.deepEqual(outcomes.map(outcome => outcome.remaining), [0, 0]);
});

// m3r-F003 regression: a permanently conflicting head used to block every later queue entry forever.
test("a poison head is dead-lettered instead of blocking the queue forever", async t => {
  const { dir } = setup(t);
  const pendingStore = new FileStateStore(join(dir, "pending.json"), { pending: [] });
  const submitted = [];
  const backend = {
    async get() {}, async search() { return []; },
    async put(input) {
      submitted.push(input.requestId);
      if (input.requestId === "poison") throw new Error("Memory revision conflict");  // DB recovered; the record moved on
      return { requestId: input.requestId, state: "committed", id: input.item.id, scope: input.item.scope, revision: 1 };
    },
    async withdraw() { throw new Error("unused"); },
  };
  await pendingStore.update(state => { state.pending.push({ ...queuedPut("poison", "a"), critical: true }, queuedPut("tail", "b")); });
  const resilient = new ResilientBackend(backend, pendingStore);
  assert.deepEqual(await resilient.flush(), { committed: 0, remaining: 2 });  // attempt 1 fails, head stays queued
  assert.deepEqual(await resilient.flush(), { committed: 0, remaining: 2 });  // attempt 2
  const drained = await resilient.flush();                                    // attempt 3 crosses the threshold
  assert.equal(drained.committed, 1);            // the entry behind the poison head still flushes
  assert.equal(drained.remaining, 0);            // the live queue is empty again
  assert.deepEqual(submitted.filter(id => id === "tail"), ["tail"]);
  const report = await resilient.pendingReport();
  assert.equal(report.count, 1); assert.equal(report.critical, 1);  // the dead letter stays visible and critical
  assert.equal(report.dead.length, 1);
  assert.equal(report.dead[0].requestId, "poison");
  assert.equal(report.dead[0].kind, "put");
  assert.equal(report.dead[0].id, "a");
  assert.match(report.dead[0].reason, /revision conflict/);
  assert.equal(report.dead[0].failures, 3);
  // A dead critical record is still uncommitted: the checkpoint stays paused until a human decides.
  await assert.rejects(resilient.assertCommitted("goal milestone"), /still uncommitted/);
  assert.equal(await resilient.abandonPending("poison"), true);   // manual entry: drop the dead letter
  assert.equal(await resilient.abandonPending("poison"), false);  // already gone
  const cleared = await resilient.pendingReport();
  assert.equal(cleared.count, 0); assert.equal(cleared.critical, 0); assert.deepEqual(cleared.dead, []);
  await resilient.assertCommitted("goal milestone");              // the gate opens
  assert.deepEqual(await resilient.flush(), { committed: 0, remaining: 0 });  // the queue keeps draining
});
