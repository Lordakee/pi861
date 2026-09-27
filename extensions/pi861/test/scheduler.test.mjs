import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskBoard, normalizeScope, scopesConflict, drainReadyTasks, explainConcurrency } from "../src/scheduler.ts";
const spec = (id, dependencies = [], scope = id) => ({
	id, title: `Implement ${id}`, dependsOn: dependencies, writeScopes: [scope],
	capabilities: ["code"], acceptance: ["verified test artifact"], retrySafe: false,
});
const board = () => new TaskBoard({ maxConcurrent: 2, maxAttempts: 2 });
test("newly unlocked work starts before an unrelated slower task ends", { timeout: 1000 }, async () => {
	const tasks = board();
	tasks.add([spec("a"), spec("b"), spec("c", ["a"])]);
	const trace = [];
	let releaseB;
	const bDone = new Promise((resolve) => { releaseB = resolve; });
	const worker = (id) => ({ id, capabilities: ["code"], run: async (task) => {
		trace.push(`start:${task.id}`);
		if (task.id === "b") await bDone;
		if (task.id === "c") releaseB();
		trace.push(`finish:${task.id}`);
		return [`artifact:${task.id}`];
	} });
	const result = await drainReadyTasks(tasks, [worker("w1"), worker("w2")],
		async () => ({ accepted: true, evidence: ["verified-by-test"] }),
		{ signal: new AbortController().signal });
	assert.ok(trace.indexOf("start:c") < trace.indexOf("finish:b"));
	assert.ok(result.tasks.every((task) => task.status === "done"));
});
test("a submitted but unverified dependency does not unlock dependent work", () => {
	const tasks = board();
	tasks.add([spec("a"), spec("c", ["a"])]);
	const first = tasks.claim("w1", ["code"], 0, 100);
	tasks.submit(first.lease, ["artifact"], 1);
	assert.equal(tasks.claim("w2", ["code"], 2, 100), undefined);
	tasks.accept(first.lease, ["test"], 3);
	assert.equal(tasks.claim("w2", ["code"], 4, 100).id, "c");
});
test("overlapping paths cannot execute simultaneously", () => {
	const tasks = board();
	tasks.add([spec("a", [], "src/auth"), spec("b", [], "src/auth/token.ts")]);
	assert.ok(tasks.claim("w1", ["code"], 0, 100));
	assert.equal(tasks.claim("w2", ["code"], 0, 100), undefined);
	assert.equal(scopesConflict(["src/auth"], ["src/authentication"]), false);
	assert.equal(scopesConflict(["."], ["src/authentication"]), true);
});
test("invalid scopes and dependency cycles are rejected atomically", () => {
	for (const path of ["../outside", "/tmp", "C:\\work", "", "src/../secret", "src//a"]) assert.throws(() => normalizeScope(path));
	const tasks = board();
	assert.throws(() => tasks.add([spec("a", ["b"]), spec("b", ["a"])]), /cycle/);
	assert.equal(tasks.state.tasks.length, 0);
	assert.throws(() => tasks.add([spec("a", ["missing"])]), /Unknown dependency/);
});
test("slots, capabilities and worker identity are enforced", () => {
	const tasks = board();
	tasks.add([spec("a"), spec("b"), spec("c")]);
	assert.equal(tasks.claim("w0", [], 0, 100), undefined);
	assert.ok(tasks.claim("w1", ["code"], 0, 100));
	assert.equal(tasks.claim("w1", ["code"], 0, 100), undefined);
	assert.ok(tasks.claim("w2", ["code"], 0, 100));
	assert.equal(tasks.claim("w3", ["code"], 0, 100), undefined);
});
test("expired retry-safe tasks can be reclaimed but reject old results", () => {
	const tasks = board();
	tasks.add([{ ...spec("a"), retrySafe: true }]);
	const old = tasks.claim("w1", ["code"], 0, 10);
	assert.equal(tasks.recoverExpired(10), 1);
	const next = tasks.claim("w2", ["code"], 11, 10);
	assert.equal(next.attempts, 2);
	assert.throws(() => tasks.submit(old.lease, ["late"], 12), /Stale/);
	tasks.recoverExpired(21);
	assert.equal(tasks.state.tasks[0].status, "blocked");
});
test("unknown side effects block recovery rather than reexecute", () => {
	const tasks = board();
	tasks.add([spec("a")]);
	tasks.claim("w", ["code"], 0, 10);
	tasks.recoverExpired(10);
	assert.equal(tasks.state.tasks[0].status, "blocked");
	assert.equal(tasks.claim("w2", ["code"], 11, 100), undefined);
});
test("persist failure does not mutate coordinator state", () => {
	let failing = false;
	const tasks = new TaskBoard({ maxConcurrent: 1, maxAttempts: 1 }, undefined, () => {
		if (failing) throw new Error("disk unavailable");
	});
	tasks.add([spec("a")]);
	const old = tasks.state;
	failing = true;
	assert.throws(() => tasks.claim("w", ["code"], 0, 100), /disk unavailable/);
	assert.deepEqual(tasks.state, old);
});
test("input, snapshots and persistence candidates are detached", () => {
	const task = spec("a");
	const tasks = board();
	tasks.add([task]);
	task.title = "mutated";
	const snapshot = tasks.state;
	snapshot.tasks[0].title = "also mutated";
	assert.equal(tasks.state.tasks[0].title, "Implement a");
});
test("rejected verification blocks and never marks work complete", async () => {
	const tasks = board();
	tasks.add([spec("a")]);
	await drainReadyTasks(tasks, [{ id: "w", capabilities: ["code"], run: async () => ["artifact"] }],
		async () => ({ accepted: false, evidence: [], reason: "tests failed" }),
		{ signal: new AbortController().signal });
	assert.equal(tasks.state.tasks[0].status, "blocked");
});
test("cancellation releases scheduler even when a worker ignores it", { timeout: 1000 }, async () => {
	const controller = new AbortController();
	const tasks = board();
	tasks.add([spec("a")]);
	await assert.rejects(drainReadyTasks(tasks, [{
		id: "w", capabilities: ["code"], run: async () => {
			controller.abort(new Error("cancel"));
			return new Promise(() => {});
		},
	}], async () => ({ accepted: true, evidence: ["test"] }), { signal: controller.signal }), /cancel/);
	assert.equal(tasks.state.tasks[0].status, "blocked");
});
test("success requires artifacts and external verification evidence", () => {
	const tasks = board();
	tasks.add([spec("a")]);
	const claim = tasks.claim("w", ["code"], 0, 100);
	assert.throws(() => tasks.submit(claim.lease, [], 1), /artifacts/);
	assert.throws(() => tasks.accept(claim.lease, ["fake"], 1), /not been submitted/);
	tasks.submit(claim.lease, ["file"], 1);
	assert.throws(() => tasks.accept(claim.lease, [], 2), /evidence/);
});
test("a separate review pool releases execution slots under audit backpressure", () => {
	const tasks = new TaskBoard({ maxConcurrent: 1, maxAttempts: 2, reviewSlots: 2 });
	tasks.add([spec("a"), spec("b"), spec("c")]);
	assert.ok(tasks.claim("w1", ["code"], 0, 100));
	assert.equal(tasks.claim("w2", ["code"], 0, 100), undefined); // execution slot held
	tasks.submit(tasks.state.tasks[0].lease, ["artifact"], 1);
	assert.equal(tasks.claim("w2", ["code"], 2, 100)?.id, "b"); // review released the execution slot
	tasks.submit(tasks.state.tasks.find((task) => task.id === "b").lease, ["artifact"], 3);
	assert.equal(tasks.claim("w3", ["code"], 4, 100), undefined); // review pool full: backpressure
	tasks.accept(tasks.state.tasks[0].lease, ["verified"], 5);
	assert.equal(tasks.claim("w3", ["code"], 6, 100)?.id, "c");
});
test("manual requeue unblocks without granting a new attempt budget", () => {
	const tasks = board();
	tasks.add([spec("a")]);
	const claim = tasks.claim("w", ["code"], 0, 100);
	tasks.block(claim.lease, "manual stop", 1);
	assert.throws(() => tasks.requeue("missing"), /Unknown/);
	tasks.requeue("a");
	assert.equal(tasks.claim("w2", ["code"], 2, 100)?.id, "a");
	const strict = new TaskBoard({ maxConcurrent: 1, maxAttempts: 1 });
	strict.add([spec("a")]);
	strict.block(strict.claim("w", ["code"], 0, 100).lease, "failed", 1);
	strict.requeue("a");
	assert.equal(strict.claim("w2", ["code"], 2, 100), undefined); // attempts stay exhausted
});
test("queued tasks can be withdrawn atomically", () => {
	const tasks = board();
	tasks.add([spec("a"), spec("b")]);
	const claim = tasks.claim("w", ["code"], 0, 100);
	assert.throws(() => tasks.remove(["a"]), /queued/); // running cannot be withdrawn
	tasks.remove(["b"]);
	assert.equal(tasks.state.tasks.length, 1);
	assert.throws(() => tasks.remove(["missing"]), /Unknown/);
});
test("explainConcurrency names each unsaturated-concurrency reason", () => {
	const record = (id, over = {}) => ({ ...spec(id), status: "queued", attempts: 0, artifacts: [], evidence: [], ...over });
	const lease = { taskId: "run", workerId: "w1", token: "t", attempt: 1 };
	const tasks = [
		record("run", { status: "running", lease, leaseUntil: 100, writeScopes: ["run"] }),
		record("rev", { status: "review", lease: { ...lease, taskId: "rev" }, leaseUntil: 100, writeScopes: ["rev"] }),
		record("dep", { dependsOn: ["later"], writeScopes: ["dep"] }),
		record("spent", { attempts: 2, writeScopes: ["spent"] }),
		record("clash", { writeScopes: ["run/inner"] }),
		record("gpu", { capabilities: ["gpu"], writeScopes: ["gpu"] }),
		record("bad", { status: "blocked" }),
	];
	const explained = explainConcurrency(tasks, { maxConcurrent: 2, maxAttempts: 2, reviewSlots: 1 }, [{ id: "w1", capabilities: ["code"] }]);
	const kinds = explained.reasons.map((reason) => reason.kind);
	for (const kind of ["dependency", "attempt-budget", "scope-conflict", "review-capacity", "capability", "blocked"]) assert.ok(kinds.includes(kind), kind);
	assert.deepEqual(explained.reasons.find((reason) => reason.kind === "dependency"), { kind: "dependency", detail: "queued tasks wait on unaccepted dependencies", taskIds: ["dep"] });
	assert.deepEqual(explained.executing, 1); assert.deepEqual(explained.reviewing, 1); assert.deepEqual(explained.slots, 2);
	// Without a review pool, review occupancy is ordinary capacity, and idle boards explain no-work.
	const withoutReview = explainConcurrency([], { maxConcurrent: 2, maxAttempts: 2 }, []);
	assert.deepEqual(withoutReview.reasons, [{ kind: "no-work", detail: "no queued work is claimable; waiting for a plan append or manual unblock", taskIds: [] }]);
	const saturated = explainConcurrency([record("busy", { status: "running", lease, leaseUntil: 100 })], { maxConcurrent: 1, maxAttempts: 2 }, []);
	assert.deepEqual(saturated.reasons, []);
});
