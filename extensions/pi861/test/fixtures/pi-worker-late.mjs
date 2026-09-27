// Protocol fixture, NOT an AI developer. Same contract as pi-worker.mjs, but the task
// titled K can be held in flight via PI861_FIXTURE_K_DELAY_MS so a test can terminate a
// worker service while its remote job is still running. Exits when stdin closes so a
// hard-killed service never leaves this child behind as an orphan.
import { writeFileSync, appendFileSync } from "node:fs";
let buffer = "";
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
process.stdin.on("close", () => process.exit(0));
process.stdin.on("data", chunk => {
	buffer += chunk; while (buffer.includes("\n")) {
		const n = buffer.indexOf("\n"), line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (!line.trim()) continue;
		const request = JSON.parse(line);
		if (request.type !== "prompt") { send({ type: "response", id: request.id, command: request.type, success: true, data: {} }); continue; }
		send({ type: "response", id: request.id, command: "prompt", success: true }); send({ type: "agent_start" });
		const task = /Task: ([^\n]+)/.exec(request.message)?.[1] ?? "task";
		if (process.env.TRACE) appendFileSync(process.env.TRACE, `${task}:start\n`);
		const ms = task === "K" ? Number(process.env.PI861_FIXTURE_K_DELAY_MS ?? 5) : 5;
		setTimeout(() => {
			writeFileSync(`${task.toLowerCase()}.txt`, task);
			const message = { role: "assistant", content: [{ type: "text", text: `Implemented fixture ${task}` }], stopReason: "stop", usage: { input: 1, output: 1 } };
			send({ type: "message_end", message }); send({ type: "agent_end", messages: [message] });
		}, ms);
	}
});
