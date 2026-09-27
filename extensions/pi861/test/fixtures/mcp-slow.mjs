import { appendFileSync } from "node:fs";
import readline from "node:readline";

// stdio MCP fixture: answers ping requests, emits progress notifications, honors cancellation notices.
const logFile = process.env.PI861_MCP_LOG;
const note = (text) => { if (logFile) appendFileSync(logFile, `${text}\n`); };
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const waiters = new Map();
const timers = new Map();

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message; try { message = JSON.parse(line); } catch { process.exit(1); return; }
  if (message.id !== undefined && waiters.has(message.id)) {
    const waiter = waiters.get(message.id); waiters.delete(message.id); waiter(message); return;
  }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
  } else if (message.method === "tools/list") {
    // Only answer after the client correctly answers our ping request with a result.
    send({ jsonrpc: "2.0", id: "fixture-ping", method: "ping" });
    waiters.set("fixture-ping", (response) => {
      if (!response || !("result" in response)) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "client did not answer ping" } });
        return;
      }
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "slow", description: "Waits before finishing", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });
    });
  } else if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "slow", progress: 1 } });
    timers.set(message.id, setTimeout(() => {
      timers.delete(message.id);
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "finally done" }] } });
    }, 4000));
  } else if (message.method === "notifications/cancelled") {
    note(`cancelled:${message.params?.requestId ?? "?"}`);
    const id = message.params?.requestId;
    if (id !== undefined && timers.has(id)) {
      clearTimeout(timers.get(id)); timers.delete(id);
      send({ jsonrpc: "2.0", id, error: { code: -32800, message: "request cancelled" } });
    }
  }
});
