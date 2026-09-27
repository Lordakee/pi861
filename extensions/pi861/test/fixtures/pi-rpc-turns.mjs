// Fake Pi RPC worker speaking the line-JSON protocol: one scripted prompt with two turns,
// a duplicate assistant message_end, a turn_end that repeats usage, and an empty third turn.
import { createInterface } from "node:readline";

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const assistant = (text, usage) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "stop",
	...(usage ? { usage } : {}),
});
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	emit({ type: "response", id: message.id, success: true, data: {} });
	if (message.type !== "prompt") return;
	const events = [
		{ type: "turn_start" },
		{
			type: "message_end",
			message: assistant("turn one", { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 } }),
		},
		{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
		{ type: "message_end", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [] } },
		{ type: "message_end", message: assistant("duplicate", { input: 99, output: 99 }) }, // must not double-count
		{ type: "turn_end", message: assistant("turn one", { input: 999, output: 999 }), toolResults: [] }, // repeats usage: ignored
		{ type: "turn_start" },
		{ type: "message_end", message: assistant("turn two") }, // no usage block: stays unknown, never zero
		{ type: "turn_end", message: assistant("turn two"), toolResults: [] },
		{ type: "turn_start" }, // a turn with no assistant response records nothing
		{ type: "agent_end", messages: [] },
	];
	for (const event of events) emit(event);
});
