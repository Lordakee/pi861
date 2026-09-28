// stdio MCP fixture for disconnect classification (hot-update tolerance).
// PI861_MCP_MODE:
//  - "exit-after-list": answers the first tools/list, then exits once its response is flushed
//    (an established connection breaks exactly like an externally updated tool process).
//  - "crash-on-call": answers initialize/tools/list; each tools/call dispatch is appended to
//    PI861_MCP_LEDGER and the process exits without responding (dispatched, result unknown).
import { appendFileSync } from "node:fs";
const mode = process.env.PI861_MCP_MODE ?? "exit-after-list";
const schema = { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false };
const note = (text) => { if (process.env.PI861_MCP_LOG) appendFileSync(process.env.PI861_MCP_LOG, `${text}\n`); };
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const request = JSON.parse(line); if (!request.id) continue;
    if (request.method === "initialize") {
      note("initialize");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } } } }) + "\n");
    } else if (request.method === "tools/list") {
      const reply = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "lookup", description: "Read project data", inputSchema: schema }] } });
      if (mode === "exit-after-list") { process.stdout.write(`${reply}\n`, () => { note("exit"); process.exit(0); }); return; }
      process.stdout.write(`${reply}\n`);
    } else if (mode === "crash-on-call") {
      appendFileSync(process.env.PI861_MCP_LEDGER, `${JSON.stringify({ dispatched: request.params?.name ?? "?", at: Date.now() })}\n`);
      note("exit");
      process.exit(1); // dispatch recorded durably, response never sent
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ok" }] } }) + "\n");
    }
  }
});
