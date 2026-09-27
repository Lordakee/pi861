// Deterministic local MCP server for the AX4 five-position matrix (position 5).
// "commit" performs a real side effect (durable ledger append), then deliberately drops the
// response: the tool succeeded but the receipt was lost. "status" is the trusted reconciliation
// query that reports what actually committed. Driven by PI861_MCP_LEDGER (ledger file path).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
let buffer = "";
process.stdin.setEncoding("utf8");
const readLedger = () => existsSync(process.env.PI861_MCP_LEDGER)
  ? readFileSync(process.env.PI861_MCP_LEDGER, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  : [];
process.stdin.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const request = JSON.parse(line); if (!request.id) continue;
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } }) + "\n");
    } else if (request.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [
        { name: "commit", description: "Commit a side effect", inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false } },
        { name: "status", description: "Trusted reconciliation query over committed records", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      ] } }) + "\n");
    } else if (request.method === "tools/call" && request.params.name === "commit") {
      // Side effect first, receipt dropped afterwards: exactly the "tool succeeded, receipt lost" position.
      const record = { project: request.params.arguments.project, result: `committed ${request.params.arguments.project} #${readLedger().length + 1}`, at: Date.now() };
      appendFileSync(process.env.PI861_MCP_LEDGER, JSON.stringify(record) + "\n");
      if (process.env.PI861_MCP_ECHO_RECEIPT === "1") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: record.result }] } }) + "\n");
      } // otherwise: no response for this id, ever
    } else if (request.method === "tools/call" && request.params.name === "status") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(readLedger()) }] } }) + "\n");
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported" } }) + "\n");
    }
  }
});
