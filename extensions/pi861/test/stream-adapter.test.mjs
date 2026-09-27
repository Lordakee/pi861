import assert from "node:assert/strict";
import { test } from "node:test";
import { IncrementBuffer, ModelFailure } from "../src/routing.ts";
import { StreamAttempt } from "../src/live/stream-adapter.ts";

const attempt = { generation: 1, configId: "strong", configRevision: "1" };
const retry = { generation: 2, configId: "backup", configRevision: "1" };
const fresh = () => new AbortController().signal;
const classify = (message) => new ModelFailure(message.stopReason === "aborted" ? "cancelled" : "transient");
const terminal = (content) => ({
	stopReason: content?.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
	content,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
});
const toolCall = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });

test("sharded text deltas accumulate per attempt and the done message is the authoritative value", () => {
	const connected = [];
	const progress = [];
	const adapter = new StreamAttempt(attempt, {
		connected: () => connected.push(1),
		progress: () => progress.push(1),
	});
	// Pi's partial is one shared mutating object; the adapter must never read or retain it.
	const sharedPartial = terminal([{ type: "text", text: "" }]);
	assert.equal(adapter.ingest({ type: "start", partial: sharedPartial }), undefined);
	for (const shard of ["Hel", "lo ", "str", "eam"]) {
		sharedPartial.content[0].text += shard;
		adapter.ingest({ type: "text_delta", contentIndex: 0, delta: shard, partial: sharedPartial });
	}
	adapter.ingest({ type: "text_end", contentIndex: 0, content: "Hello stream", partial: sharedPartial });
	const message = terminal([{ type: "text", text: "Hello stream" }]);
	assert.equal(adapter.ingest({ type: "done", reason: "stop", message }), "done");
	assert.deepEqual(adapter.view(), { attempt, text: "Hello stream" });
	assert.equal(adapter.finish(fresh(), classify), message); // the done message itself is returned
	assert.deepEqual(connected, [1]);
	assert.equal(progress.length, 4);
	assert.equal(adapter.ingest({ type: "text_delta", contentIndex: 0, delta: "late" }), undefined); // after terminal: ignored
});

test("multi-tool interleaved fragments gate on the authoritative toolcall_end arguments", () => {
	const adapter = new StreamAttempt(attempt);
	adapter.ingest({ type: "start" });
	adapter.ingest({ type: "toolcall_start", contentIndex: 0 });
	adapter.ingest({ type: "toolcall_start", contentIndex: 1 });
	adapter.ingest({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":' });
	adapter.ingest({ type: "toolcall_delta", contentIndex: 1, delta: '{"query":"' });
	adapter.ingest({ type: "toolcall_delta", contentIndex: 0, delta: ' "a.txt"}' });
	adapter.ingest({ type: "toolcall_delta", contentIndex: 1, delta: 'x"}' });
	adapter.ingest({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall("call-1", "write", { path: "a.txt" }) });
	adapter.ingest({ type: "toolcall_end", contentIndex: 1, toolCall: toolCall("call-2", "search", { query: "x" }) });
	const message = terminal([toolCall("call-2", "search", { query: "x" }), toolCall("call-1", "write", { path: "a.txt" })]);
	assert.equal(adapter.ingest({ type: "done", reason: "toolUse", message }), "done");
	assert.equal(adapter.finish(fresh(), classify), message);
	assert.deepEqual(adapter.tools(), [
		{ id: "call-1", name: "write", args: { path: "a.txt" } },
		{ id: "call-2", name: "search", args: { query: "x" } },
	]);
});

test("tool arguments must be a JSON object; a call may not end twice; duplicate ids are refused", () => {
	for (const bad of [null, "x", [1, 2], 3]) {
		const adapter = new StreamAttempt(attempt);
		assert.throws(() => adapter.ingest({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall("c", "t", bad) }), ModelFailure);
	}
	const adapter = new StreamAttempt(attempt);
	adapter.ingest({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall("c", "t", {}) });
	assert.throws(() => adapter.ingest({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall("c", "t", {}) }), ModelFailure);
	assert.throws(() => adapter.ingest({ type: "toolcall_end", contentIndex: 1, toolCall: toolCall("c", "t", {}) }), ModelFailure);
	assert.throws(
		() => {
			const end = new StreamAttempt(attempt);
			end.ingest({ type: "done", reason: "toolUse", message: terminal([toolCall("a", "t", {}), toolCall("a", "t", {})]) });
		},
		ModelFailure,
	);
});

test("an incomplete stream never dispatches: truncation throws transient and invalidates", () => {
	const adapter = new StreamAttempt(attempt);
	adapter.ingest({ type: "start" });
	adapter.ingest({ type: "toolcall_delta", contentIndex: 0, delta: '{"proj' }); // stream cut mid-argument
	assert.throws(() => adapter.finish(fresh(), classify), /transient/);
	adapter.invalidate(); // failure cleanup: late fragments from the lost stream are refused
	assert.equal(adapter.ingest({ type: "toolcall_delta", contentIndex: 0, delta: 'ect":"p"}' }), undefined);
	assert.equal(adapter.ingest({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall("c", "t", { project: "p" }) }), undefined);
	assert.deepEqual(adapter.view(), { attempt: undefined, text: "" });
	assert.deepEqual(adapter.tools(), []); // nothing from the truncated attempt is dispatchable
});

test("a failed attempt dispatches nothing; its late stream loses authority before the retry starts", () => {
	const first = new StreamAttempt(attempt);
	first.ingest({ type: "start" });
	first.ingest({ type: "text_delta", contentIndex: 0, delta: "partial answ" });
	const failureMessage = { ...terminal([]), stopReason: "error", errorMessage: "ECONNRESET stream ended" };
	assert.equal(first.ingest({ type: "error", reason: "error", error: failureMessage }), "error");
	assert.throws(() => first.finish(fresh(), classify), /transient/); // ECONNRESET classifies as transient
	first.invalidate();
	// Late events from the failed attempt arrive before the retry's generation begins.
	assert.equal(first.ingest({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall("ghost", "write", { path: "x" }) }), undefined);
	assert.equal(first.tools().length, 0);
	// The retry is a fresh adapter with a fresh attempt identity; only its output dispatches.
	const second = new StreamAttempt(retry);
	second.ingest({ type: "start" });
	second.ingest({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall("real", "write", { path: "y" }) });
	const message = terminal([toolCall("real", "write", { path: "y" })]);
	second.ingest({ type: "done", reason: "toolUse", message });
	assert.equal(second.finish(fresh(), classify), message);
	assert.deepEqual(second.tools(), [{ id: "real", name: "write", args: { path: "y" } }]);
});

test("cancellation aborts before classification and an aborted stream classifies as cancelled", () => {
	const adapter = new StreamAttempt(attempt);
	adapter.ingest({ type: "done", reason: "stop", message: terminal([]) });
	const controller = new AbortController();
	controller.abort(new Error("user cancelled"));
	assert.throws(() => adapter.finish(controller.signal, classify), /user cancelled/);
	const aborted = new StreamAttempt(attempt);
	aborted.ingest({ type: "start" });
	assert.equal(
		aborted.ingest({ type: "error", reason: "aborted", error: { ...terminal([]), stopReason: "aborted" } }),
		"error",
	);
	assert.throws(() => aborted.finish(fresh(), classify), /cancelled/);
});

test("buffer limits fail the attempt instead of growing without bound", () => {
	const capped = new StreamAttempt(attempt, undefined, { maxTextChars: 8 });
	capped.ingest({ type: "start" });
	capped.ingest({ type: "text_delta", contentIndex: 0, delta: "01234567" });
	assert.throws(() => capped.ingest({ type: "text_delta", contentIndex: 0, delta: "x" }), /transient/);
	const args = new StreamAttempt(attempt, undefined, { maxToolArgsChars: 8 });
	args.ingest({ type: "start" });
	assert.throws(() => args.ingest({ type: "toolcall_delta", contentIndex: 0, delta: "012345678" }), /transient/);
	const calls = new StreamAttempt(attempt, undefined, { maxPendingToolCalls: 1 });
	calls.ingest({ type: "start" });
	calls.ingest({ type: "toolcall_delta", contentIndex: 0, delta: "{}" });
	assert.throws(() => calls.ingest({ type: "toolcall_delta", contentIndex: 1, delta: "{}" }), /transient/);
});

test("done messages with structurally invalid tool calls fail the attempt before the host sees them", () => {
	const adapter = new StreamAttempt(attempt);
	assert.throws(
		() => adapter.ingest({ type: "done", reason: "toolUse", message: terminal([toolCall("c", "t", "not-an-object")]) }),
		ModelFailure,
	);
});

test("IncrementBuffer.invalidate: a voided attempt never regains ownership, newer generations still can", () => {
	const buffer = new IncrementBuffer();
	assert.equal(buffer.textDelta(attempt, "own"), true);
	buffer.invalidate(attempt);
	assert.equal(buffer.textDelta(attempt, "late"), false);
	assert.equal(buffer.endToolArgs(attempt, "call-1").dispatchable, false);
	assert.deepEqual(buffer.view(), { attempt: undefined, text: "" });
	assert.equal(buffer.textDelta(retry, "fresh"), true);
});
