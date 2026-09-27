import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalController, readGoal } from "../src/goal.ts";
const create = (max = 20) => {
	const log = [];
	const goal = new GoalController((state) => log.push(structuredClone(state)));
	goal.create("Implement and verify a module; do not deploy", max);
	return { goal, log };
};
const report = { progress: "Implemented", nextAction: "Run tests", evidence: ["commit:abc"], readyForReview: false };
test("dispatch persists and consumes allowance before execution", () => {
	const { goal, log } = create();
	const run = goal.dispatch();
	assert.equal(log.at(-1).runToken, run.token);
	assert.equal(goal.state.usedRuns, 1);
	assert.equal(goal.dispatch(), undefined);
});
test("model completion only requests review; user acceptance is separate", () => {
	const { goal } = create();
	const run = goal.dispatch();
	goal.report(run.token, { ...report, readyForReview: true });
	goal.settle(run.token, "ok");
	assert.equal(goal.state.status, "review");
	goal.accept();
	assert.equal(goal.state.status, "completed");
	assert.equal(goal.dispatch(), undefined);
});
test("no evidence cannot request completion", () => {
	const { goal } = create();
	assert.throws(() => goal.accept(), /not ready/);
	const run = goal.dispatch();
	assert.throws(() => goal.report(run.token, { ...report, readyForReview: true, evidence: [] }), /evidence/);
});
test("paused goal rejects late reports and duplicate settle", () => {
	const { goal } = create();
	const run = goal.dispatch();
	goal.pause();
	assert.throws(() => goal.report(run.token, report), /Stale/);
	assert.equal(goal.settle(run.token, "ok"), false);
	assert.equal(goal.state.status, "paused");
});
test("unproductive continuation stops after two runs", () => {
	const { goal } = create();
	assert.equal(goal.settle(goal.dispatch().token, "ok"), true);
	assert.equal(goal.settle(goal.dispatch().token, "ok"), false);
	assert.equal(goal.state.status, "paused");
});
test("error and user cancellation pause rather than auto-restart", () => {
	for (const outcome of ["error", "aborted"]) {
		const { goal } = create();
		assert.equal(goal.settle(goal.dispatch().token, outcome), false);
		assert.equal(goal.state.status, "paused");
	}
});
test("run budget is monotonic across resume and setting changes", () => {
	const { goal } = create(1);
	const run = goal.dispatch();
	goal.report(run.token, report);
	goal.settle(run.token, "ok");
	assert.throws(() => goal.resume(), /budget/);
	goal.setBudget(3);
	assert.equal(goal.state.usedRuns, 1);
	assert.equal(goal.state.status, "paused");
	goal.resume();
	goal.dispatch();
	assert.equal(goal.state.usedRuns, 2);
});
test("restoring interrupted work is passive and preserves spent budget", () => {
	const { goal } = create();
	goal.dispatch();
	const resumed = new GoalController(() => {});
	resumed.restore(goal.state);
	assert.equal(resumed.state.status, "paused");
	assert.equal(resumed.state.runToken, undefined);
	assert.equal(resumed.state.usedRuns, 1);
});
test("invalid restore clears old state instead of leaking another session's goal", () => {
	const { goal } = create();
	assert.throws(() => goal.restore({ objective: "corrupt" }), /Invalid/);
	assert.equal(goal.state, undefined);
	assert.equal(readGoal(null), undefined);
});
test("editing requires pause and does not silently replenish runs", () => {
	const { goal } = create();
	assert.throws(() => goal.edit("new objective"), /Pause/);
	goal.dispatch();
	goal.pause();
	goal.edit("new objective");
	assert.equal(goal.state.usedRuns, 1);
	assert.equal(goal.state.status, "paused");
});
test("persistence failure leaves prior state untouched", () => {
	let fail = false;
	const goal = new GoalController(() => { if (fail) throw new Error("write failed"); });
	goal.create("Task");
	const prior = goal.state;
	fail = true;
	assert.throws(() => goal.dispatch(), /write failed/);
	assert.deepEqual(goal.state, prior);
});
test("clearing invalidates execution and allows a new goal", () => {
	const { goal } = create();
	const token = goal.dispatch().token;
	goal.clear();
	assert.equal(goal.settle(token, "ok"), false);
	assert.equal(goal.state.status, "cancelled");
	goal.create("Next task");
	assert.equal(goal.state.usedRuns, 0);
});
test("pause, resume and cancel transitions are explicit", () => {
	const { goal } = create();
	assert.throws(() => goal.resume(), /paused/);
	goal.dispatch();
	goal.pause("first");
	goal.pause("again"); // idempotent while paused
	assert.equal(goal.state.status, "paused");
	goal.resume();
	assert.equal(goal.state.status, "active");
	assert.equal(goal.state.noProgressRuns, 0);
	goal.clear();
	assert.throws(() => goal.resume(), /paused/);
	goal.pause("ignored"); // terminal goals ignore pause
	assert.equal(goal.state.status, "cancelled");
});
