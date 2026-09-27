import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { enforceDeploymentMode, McpClient } from "../src/live/mcp.ts";
const signal = () => new AbortController().signal;
const schema = { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false };
async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}
test("real stdio MCP process: initialize, discover and call", async t => {
  const client = new McpClient({ id: "local", accountId: "test", transport: { kind: "stdio", process: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))], cwd: process.cwd() } } });
  t.after(() => client.close());
  const tools = await client.tools(signal()); assert.equal(tools.length, 1);
  assert.equal((await client.call("lookup", { project: "p" }, tools[0].schemaHash, signal())).content[0].text, "looked up p");
  await assert.rejects(client.call("lookup", {}, "old-schema", signal()), /schema changed/);
});
for (const mode of ["json", "sse"]) test(`real HTTP MCP ${mode}: session and protocol headers`, async t => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const input = JSON.parse(body); seen.push({ input, headers: req.headers });
    if (!input.id) { res.writeHead(202).end(); return; }
    let result;
    if (input.method === "initialize") { res.setHeader("Mcp-Session-Id", "s-test"); result = { protocolVersion: "2025-11-25", capabilities: { tools: {} } }; }
    else if (input.method === "tools/list") result = { tools: [{ name: "lookup", inputSchema: schema }] };
    else result = { content: [{ type: "text", text: "ok" }] };
    const output = JSON.stringify({ jsonrpc: "2.0", id: input.id, result });
    res.setHeader("Content-Type", mode === "sse" ? "text/event-stream" : "application/json");
    res.end(mode === "sse" ? `: ping\r\n\r\ndata: ${output}\r\n\r\n` : output);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const client = new McpClient({ id: "http", accountId: "test", transport: { kind: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, allowLoopbackHttp: true, headers: { Authorization: "Bearer test-only" } } });
  t.after(() => client.close()); const [tool] = await client.tools(signal()); await client.call("lookup", { project: "p" }, tool.schemaHash, signal());
  assert.equal(seen[1].headers["mcp-session-id"], "s-test"); assert.equal(seen[1].headers["mcp-protocol-version"], "2025-11-25");
});
test("unsafe remote plain HTTP is rejected", () => {
  assert.throws(() => new McpClient({ id: "x", accountId: "a", transport: { kind: "http", url: "http://example.com/mcp" } }), /HTTPS/);
});
test("cancellation propagates to the server; ping is answered; notifications surface (R5.6)", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pi861-slow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "events.log");
  const client = new McpClient({ id: "slow", accountId: "t", transport: { kind: "stdio", process: {
    command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-slow.mjs", import.meta.url))], cwd: process.cwd(), env: { PI861_MCP_LOG: log } } } });
  t.after(() => client.close());
  const notifications = [];
  client.onNotification((event) => notifications.push(String(event.method)));
  const tools = await client.tools(signal()); // the fixture only lists tools after its ping is answered with a result
  assert.equal(tools[0].name, "slow");
  const controller = new AbortController();
  const pending = client.call("slow", {}, tools[0].schemaHash, controller.signal);
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(pending, /cancelled/);
  assert.ok(await waitFor(() => {
    try { return readFileSync(log, "utf8").includes("cancelled:"); } catch { return false; }
  }, 4000), "server did not record the cancellation notice");
  assert.ok(notifications.includes("notifications/progress"));
});
test("bounded reconnect policy retries connection establishment only", async t => {
  let initializes = 0;
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const input = JSON.parse(body);
      if (input.method === "initialize") {
        initializes++;
        if (initializes === 1) { res.destroy(); return; }
        res.setHeader("Mcp-Session-Id", "s1"); res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } }));
        return;
      }
      const result = input.method === "tools/list" ? { tools: [{ name: "lookup", inputSchema: schema }] } : { content: [{ type: "text", text: "ok" }] };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const strict = new McpClient({ id: "flaky", accountId: "t", transport: { kind: "http", url, allowLoopbackHttp: true } });
  t.after(() => strict.close());
  await assert.rejects(strict.tools(signal()), /transport failed|HTTP/); // default policy does not retry
  const patient = new McpClient({ id: "flaky2", accountId: "t", transport: { kind: "http", url, allowLoopbackHttp: true }, reconnect: { maxAttempts: 3, baseDelayMs: 10 } });
  t.after(() => patient.close());
  assert.equal((await patient.tools(signal())).length, 1);
});
test("deployment modes: trusted-local vs production-isolated boundaries (R5.11)", () => {
  const stdio = { id: "s", accountId: "a", transport: { kind: "stdio", process: { command: process.execPath, args: [], cwd: process.cwd() } } };
  const loopback = { id: "l", accountId: "a", transport: { kind: "http", url: "http://127.0.0.1:1/mcp", allowLoopbackHttp: true } };
  assert.doesNotThrow(() => enforceDeploymentMode("trusted-local", [stdio, loopback]));
  assert.throws(() => enforceDeploymentMode("production-isolated", [stdio]), /HTTPS/);
  assert.throws(() => enforceDeploymentMode("production-isolated", [loopback]), /HTTPS/);
  assert.doesNotThrow(() => enforceDeploymentMode("production-isolated", [{ id: "r", accountId: "a", transport: { kind: "http", url: "https://mcp.example.com/mcp" } }]));
});
