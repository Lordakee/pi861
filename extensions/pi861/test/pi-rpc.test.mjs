// Per-turn usage association for out-of-process Pi planner sessions.
// Honest boundary (by design, recorded in the runtime wiring too): per-turn metering is
// post-hoc. The turn event arrives after the provider already served the request, so it
// cannot block the next turn, and observed turn responses are at most the real provider
// request count (internal retries and compaction stay invisible to the RPC event stream).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PiRpcSession } from "../src/live/pi-rpc.ts";

const fixture = fileURLToPath(new URL("./fixtures/pi-rpc-turns.mjs", import.meta.url));

test("per-prompt runId and turn ordinals associate usage from assistant message_end only", async () => {
	const session = new PiRpcSession({ command: process.execPath, args: [fixture], cwd: process.cwd() });
	try {
		const run = await session.prompt("inspect the repository", new AbortController().signal);
		assert.match(run.runId, /^[0-9a-f-]{36}$/);
		assert.deepEqual(run.turns, [
			{
				runId: run.runId,
				ordinal: 1,
				usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, cost: 0.5 },
			},
			{
				runId: run.runId,
				ordinal: 2,
				usage: {
					inputTokens: null,
					outputTokens: null,
					cacheReadTokens: null,
					cacheWriteTokens: null,
					cost: null,
				},
			},
		]);
		assert.equal(run.text, "turn two"); // last assistant text wins
		assert.equal(run.toolCalls, 1);
		assert.deepEqual(run.usage, { input: 10, output: 5 }); // duplicate message_end and turn_end never add
	} finally {
		await session.close();
	}
});
