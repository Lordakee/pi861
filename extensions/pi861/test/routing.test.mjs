import assert from "node:assert/strict";
import { test } from "node:test";
import { eligible, selectInitial, ModelRecovery, ModelFailure, inferWithRecovery, HealthService, IncrementBuffer } from "../src/routing.ts";

const models = [
	{ id: "cheap", revision: "1", provider: "p1", model: "a", quality: 1, costRank: 1, contextWindow: 100, capabilities: ["tools"], enabled: true,
		account: "acct-a", endpoint: "edge-1", billing: { inputPerMillionTokens: 1, outputPerMillionTokens: 2 }, dataEgress: "global" },
	{ id: "strong", revision: "1", provider: "p2", model: "b", quality: 3, costRank: 3, contextWindow: 1000, capabilities: ["tools", "vision"], enabled: true,
		account: "acct-b", endpoint: "edge-2", billing: { inputPerMillionTokens: 3, outputPerMillionTokens: 6 }, dataEgress: "global" },
	{ id: "backup", revision: "1", provider: "p3", model: "c", quality: 3, costRank: 4, contextWindow: 1000, capabilities: ["tools", "vision"], enabled: true,
		account: "acct-c", endpoint: "edge-3", billing: { inputPerMillionTokens: 3, outputPerMillionTokens: 6 }, dataEgress: "global" },
];
const requirements = { minQuality: 3, contextTokens: 200, capabilities: ["tools"], allowedIds: ["cheap", "strong", "backup"] };
const defaults = { failoverEnabled: true, failbackEnabled: true, probeIntervalMs: 10, maxProbeIntervalMs: 100, requiredProbeSuccesses: 2 };
const make = (options = {}) => new ModelRecovery(models, "strong", requirements, { ...defaults, ...options });
const signal = () => new AbortController().signal;

test("quality, context, capability, and allowlist are hard filters", () => {
	assert.equal(eligible(models[0], requirements), false);
	assert.equal(eligible(models[1], { ...requirements, allowedIds: ["cheap"] }), false);
	assert.equal(eligible(models[1], { ...requirements, capabilities: ["audio"] }), false);
	assert.throws(() => selectInitial(models, { ...requirements, minQuality: 9 }, { canFinishDirectly: false, variableNeeds: true }));
});
test("the data egress boundary is a hard filter", () => {
	assert.equal(eligible(models[1], { ...requirements, dataBoundary: "eu-only" }), false);
	assert.equal(eligible(models[1], { ...requirements, dataBoundary: "global" }), true);
});
test("mode and initial model are selected together", () => {
	assert.deepEqual(selectInitial(models, requirements, { canFinishDirectly: true, variableNeeds: false }), { mode: "direct", configId: "strong" });
	assert.equal(selectInitial(models, requirements, { canFinishDirectly: false, variableNeeds: false }).mode, "fixed");
	assert.equal(selectInitial(models, requirements, { canFinishDirectly: false, variableNeeds: true }).mode, "dynamic");
});
for (const failoverEnabled of [false, true]) for (const failbackEnabled of [false, true]) {
	test(`independent switches: fallback=${failoverEnabled}, return=${failbackEnabled}`, () => {
		const recovery = make({ failoverEnabled, failbackEnabled });
		assert.equal(recovery.fail(recovery.beginAttempt(), "transient", 0), failoverEnabled);
		assert.equal(recovery.state.preferred, "strong");
		assert.equal(recovery.state.active, failoverEnabled ? "backup" : "strong");
		assert.equal(!!recovery.beginProbe(10), failoverEnabled && failbackEnabled);
	});
}
test("two successful probes and an idle operation boundary are required for failback", () => {
	const recovery = make();
	recovery.fail(recovery.beginAttempt(), "transient", 0);
	assert.equal(recovery.beginProbe(9), undefined);
	const first = recovery.beginProbe(10);
	assert.equal(recovery.beginProbe(10), undefined);
	recovery.finishProbe(first, true, 10);
	assert.equal(recovery.atBoundary(), false);
	const second = recovery.beginProbe(20);
	recovery.finishProbe(second, true, 20);
	assert.equal(recovery.atBoundary(1), false);
	const inFlight = recovery.beginAttempt();
	assert.equal(recovery.atBoundary(), false);
	recovery.succeed(inFlight);
	assert.equal(recovery.atBoundary(), true);
	assert.equal(recovery.state.active, "strong");
});
test("a new preferred model invalidates the old probe", () => {
	const recovery = make();
	recovery.fail(recovery.beginAttempt(), "transient", 0);
	const probe = recovery.beginProbe(10);
	recovery.setPreferred("backup", requirements);
	assert.equal(recovery.finishProbe(probe, true, 20), false);
	assert.equal(recovery.atBoundary(), false);
});
test("turning off failover does not forcibly abandon an already active backup", () => {
	const recovery = make();
	recovery.fail(recovery.beginAttempt(), "transient", 0);
	recovery.setOptions({ failoverEnabled: false });
	assert.equal(recovery.state.active, "backup");
	const probe = recovery.beginProbe(10);
	assert.ok(probe);
	recovery.setOptions({ failbackEnabled: false });
	assert.equal(recovery.finishProbe(probe, true, 11), false);
});
test("turning failback off releases the shared in-flight probe slot", () => {
	const spare = { ...models[1], id: "spare", model: "d", costRank: 5, account: "acct-d", endpoint: "edge-4" };
	const all = [...models, spare];
	const allowed = { ...requirements, allowedIds: [...requirements.allowedIds, "spare"] };
	const shared = new HealthService();
	const first = new ModelRecovery(all, "strong", allowed, defaults, shared);
	const second = new ModelRecovery(all, "backup", allowed, defaults, shared);
	first.fail(first.beginAttempt(), "transient", 0);
	second.fail(second.beginAttempt(), "transient", 0);
	assert.ok(first.beginProbe(10));
	assert.equal(second.beginProbe(10), undefined);
	first.setOptions({ failbackEnabled: false });
	assert.ok(second.beginProbe(10));
});
test("health is shared per provider, account and endpoint fault domain", () => {
	const mirror = { ...models[1], id: "mirror", model: "b2", costRank: 5 };
	const shared = new HealthService();
	const recovery = new ModelRecovery([models[1], mirror], "strong", requirements, defaults, shared);
	assert.equal(recovery.fail(recovery.beginAttempt(), "transient", 0), false);
	const other = new ModelRecovery([models[1], mirror], "mirror", { ...requirements, allowedIds: ["strong", "mirror"] }, defaults, shared);
	assert.equal(other.state.health.find((entry) => entry.id === "strong")?.ready, false);
	const isolated = new ModelRecovery([models[1], mirror], "mirror", { ...requirements, allowedIds: ["strong", "mirror"] }, defaults);
	assert.deepEqual(isolated.state.health, []);
});
test("probes are single-flight per fault domain across shared recoveries", () => {
	const shared = new HealthService();
	const first = new ModelRecovery(models, "strong", requirements, defaults, shared);
	first.fail(first.beginAttempt(), "transient", 0);
	const snapshot = first.exportState();
	const probe = first.beginProbe(10);
	assert.ok(probe);
	const second = new ModelRecovery(models, "strong", requirements, defaults, shared);
	second.restore(snapshot);
	assert.equal(second.beginProbe(10), undefined);
	assert.equal(shared.probeCount, 1);
	first.finishProbe(probe, true, 10);
	assert.equal(second.beginProbe(15), undefined);
	assert.ok(second.beginProbe(20));
});
test("probe concurrency is backpressured across fault domains", () => {
	const spare = { ...models[1], id: "spare", model: "d", costRank: 5, account: "acct-d", endpoint: "edge-4" };
	const all = [...models, spare];
	const allowed = { ...requirements, allowedIds: [...requirements.allowedIds, "spare"] };
	const shared = new HealthService({ maxConcurrentProbes: 1 });
	const first = new ModelRecovery(all, "strong", allowed, defaults, shared);
	const second = new ModelRecovery(all, "backup", allowed, defaults, shared);
	first.fail(first.beginAttempt(), "transient", 0);
	second.fail(second.beginAttempt(), "transient", 0);
	assert.ok(first.beginProbe(10));
	assert.equal(second.beginProbe(10), undefined);
});
test("a shared probe budget stops further probes", () => {
	const shared = new HealthService({ probeBudget: 1 });
	const recovery = new ModelRecovery(models, "strong", requirements, defaults, shared);
	recovery.fail(recovery.beginAttempt(), "transient", 0);
	const probe = recovery.beginProbe(10);
	assert.ok(probe);
	recovery.finishProbe(probe, false, 10);
	assert.equal(recovery.beginProbe(500), undefined);
	assert.equal(shared.probeCount, 1);
});
test("late successful output cannot revive a failed or cancelled attempt", () => {
	const recovery = make();
	const old = recovery.beginAttempt();
	recovery.fail(old, "transient", 0);
	assert.equal(recovery.succeed(old), false);
	const next = recovery.beginAttempt();
	recovery.cancel(next);
	assert.equal(recovery.succeed(next), false);
	assert.equal(recovery.state.inFlight, false);
});
for (const kind of ["cancelled", "invalid", "context"]) {
	test(`${kind} does not trigger fallback`, () => {
		const recovery = make();
		assert.equal(recovery.fail(recovery.beginAttempt(), kind, 0), false);
		assert.equal(recovery.state.active, "strong");
	});
}
test("retry-after and backoff are honored by probe eligibility", () => {
	const recovery = make();
	recovery.fail(recovery.beginAttempt(), "rate-limit", 0, 500);
	assert.equal(recovery.beginProbe(499), undefined);
	const probe = recovery.beginProbe(500);
	recovery.finishProbe(probe, false, 500);
	assert.equal(recovery.beginProbe(519), undefined);
	assert.ok(recovery.beginProbe(520));
});
test("buffered inference switches once after a classified transient failure", async () => {
	const recovery = make();
	const called = [];
	const result = await inferWithRecovery(recovery, async (target) => {
		called.push(target.id);
		if (target.id === "strong") throw new ModelFailure("transient");
		return "complete answer";
	}, { signal: signal(), timeoutMs: 100, maxAttempts: 3 });
	assert.deepEqual(called, ["strong", "backup"]);
	assert.equal(result, "complete answer");
});
test("an unclassified programming error is not retried on another model", async () => {
	const recovery = make();
	let calls = 0;
	await assert.rejects(inferWithRecovery(recovery, async () => { calls++; throw new Error("programming bug"); },
		{ signal: signal(), timeoutMs: 100, maxAttempts: 3 }), /invalid/);
	assert.equal(calls, 1);
});
test("deadline fences noncooperative provider output", async () => {
	const recovery = make();
	let release;
	const hung = new Promise((resolve) => { release = resolve; });
	const result = await inferWithRecovery(recovery, async (target) => target.id === "strong" ? hung : "backup result",
		{ signal: signal(), timeoutMs: 10, maxAttempts: 2 });
	release("late original result");
	assert.equal(result, "backup result");
	assert.equal(recovery.state.active, "backup");
});
test("a connection deadline fences a transport that never connects", async () => {
	const recovery = make();
	const result = await inferWithRecovery(recovery, async (target, _attempt, _requestSignal, hooks) => {
		if (target.id !== "strong") return "backup result";
		hooks.connected();
		await new Promise(() => {});
	}, { signal: signal(), timeoutMs: 1000, maxAttempts: 2, deadlines: { firstResponseMs: 20 } });
	assert.equal(result, "backup result");
});
test("a first-response deadline fences a silent connection", async () => {
	const recovery = make();
	const result = await inferWithRecovery(recovery, async (target, _attempt, _requestSignal, hooks) => {
		if (target.id !== "strong") return "backup result";
		hooks.connected();
		await new Promise(() => {});
	}, { signal: signal(), timeoutMs: 1000, maxAttempts: 2, deadlines: { connectMs: 10, firstResponseMs: 20 } });
	assert.equal(result, "backup result");
});
test("a stalled progress stream fails over within the progress deadline", async () => {
	const recovery = make();
	const result = await inferWithRecovery(recovery, async (target, _attempt, _requestSignal, hooks) => {
		if (target.id !== "strong") return "backup result";
		hooks.connected();
		hooks.progress();
		await new Promise(() => {});
	}, { signal: signal(), timeoutMs: 1000, maxAttempts: 2, deadlines: { progressMs: 20 } });
	assert.equal(result, "backup result");
});
test("user cancellation never starts a backup request", async () => {
	const controller = new AbortController();
	const recovery = make();
	let calls = 0;
	await assert.rejects(inferWithRecovery(recovery, async () => {
		calls++;
		controller.abort(new Error("user cancelled"));
		return new Promise(() => {});
	}, { signal: controller.signal, timeoutMs: 100, maxAttempts: 3 }), /user cancelled/);
	assert.equal(calls, 1);
	assert.equal(recovery.state.inFlight, false);
});
test("invalid configuration is rejected", () => {
	assert.throws(() => make({ probeIntervalMs: 0 }));
	assert.throws(() => make({ requiredProbeSuccesses: 0 }));
	assert.throws(() => new ModelRecovery([...models, models[0]], "strong", requirements, defaults));
	assert.throws(() => make().setPreferred("cheap", requirements));
	assert.throws(() => new ModelRecovery([{ ...models[1], account: "" }], "strong", requirements, defaults));
	assert.throws(() => new ModelRecovery([{ ...models[1], endpoint: "" }], "strong", requirements, defaults));
	assert.throws(() => new ModelRecovery([{ ...models[1], billing: { inputPerMillionTokens: -1, outputPerMillionTokens: 2 } }], "strong", requirements, defaults));
	assert.throws(() => new HealthService({ maxConcurrentProbes: 0 }));
	assert.throws(() => new HealthService({ probeBudget: -1 }));
});
test("text increments stay attributed and stale attempts lose authority", () => {
	const buffer = new IncrementBuffer();
	const first = { generation: 1, configId: "strong", configRevision: "1" };
	assert.equal(buffer.textDelta(first, "hel"), true);
	assert.equal(buffer.toolArgs(first, "call-1", '{"path":'), true);
	const stale = { generation: 0, configId: "backup", configRevision: "1" };
	assert.equal(buffer.textDelta(stale, "x"), false);
	assert.equal(buffer.toolArgs(first, "call-1", ' "a"}'), true);
	assert.deepEqual(buffer.endToolArgs(first, "call-1"), { dispatchable: true, args: { path: "a" } });
	assert.equal(buffer.endToolArgs(first, "call-1").dispatchable, false);
	assert.equal(buffer.toolArgs(first, "call-1", "more"), false);
	const newer = { generation: 2, configId: "backup", configRevision: "1" };
	assert.equal(buffer.textDelta(newer, "fresh"), true);
	assert.equal(buffer.view().text, "fresh");
	assert.equal(buffer.endToolArgs(first, "call-1").dispatchable, false);
});
test("incomplete or invalid tool arguments are never dispatched", () => {
	const buffer = new IncrementBuffer();
	const attempt = { generation: 1, configId: "strong", configRevision: "1" };
	buffer.toolArgs(attempt, "broken", "[1,2,");
	assert.equal(buffer.endToolArgs(attempt, "broken").dispatchable, false);
	buffer.toolArgs(attempt, "array", "[1,2]");
	const decision = buffer.endToolArgs(attempt, "array");
	assert.equal(decision.dispatchable, false);
	assert.match(decision.error, /JSON object/);
	buffer.toolArgs(attempt, "unknown", "{}");
	assert.equal(buffer.endToolArgs(attempt, "ghost").dispatchable, false);
});
