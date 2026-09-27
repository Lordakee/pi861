// Protocol fixture, NOT an AI developer. Same contract as pi-worker.mjs, but it lingers on
// SIGTERM so a test can observe ProjectRunner.pause() while its loop is still draining.
import { writeFileSync, readFileSync, appendFileSync } from "node:fs";
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300));
let buffer = "";
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
process.stdin.on("data", chunk => {
	buffer += chunk; while (buffer.includes("\n")) {
		const n = buffer.indexOf("\n"), line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (!line.trim()) continue;
		const request = JSON.parse(line);
		if (request.type !== "prompt") { send({ type: "response", id: request.id, command: request.type, success: true, data: {} }); continue; }
		send({ type: "response", id: request.id, command: "prompt", success: true }); send({ type: "agent_start" });
		const task = /Task: ([^\n]+)/.exec(request.message)?.[1] ?? "task";
		if (process.env.TRACE) appendFileSync(process.env.TRACE, `${task}:start\n`);
		const ms = task === "B" ? 300 : 5;
		setTimeout(() => {
			try {
				if (task === "C" && readFileSync("a.txt", "utf8") !== "A") throw new Error("Dependency code not present");
				writeFileSync(`${task.toLowerCase()}.txt`, task);
				const message = { role: "assistant", content: [{ type: "text", text: `Implemented fixture ${task}` }], stopReason: "stop", usage: { input: 1, output: 1 } };
				send({ type: "message_end", message }); send({ type: "agent_end", messages: [message] });
			} catch { send({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error" }] }); }
		}, ms);
	}
});
