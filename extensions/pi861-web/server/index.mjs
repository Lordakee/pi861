#!/usr/bin/env node
import { readFile } from "node:fs/promises";
// pi861 interactive web console: static SPA + WebSocket control plane on port 3901.
// HTTPS is terminated by the existing Caddy reverse proxy (see README.md).
// Start:
//   PI861_CONFIG=/path/to/config.json PI861_CONSOLE_TOKEN=... node server/index.mjs
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createConsoleBridge, preferredModelId } from "./coordinator-bridge.mjs";
import { createProtocol } from "./protocol.mjs";
import { createChatBridge } from "./rpc-bridge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "web-v2", "dist");
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json; charset=utf-8",
};

const token = process.env.PI861_CONSOLE_TOKEN || "";
const readonly = !token;
if (readonly) console.warn("[pi861-console] PI861_CONSOLE_TOKEN not set: running read-only");
const host = process.env.PI861_CONSOLE_HOST ?? (readonly ? "127.0.0.1" : "0.0.0.0");
const port = Number(process.env.PI861_CONSOLE_PORT ?? 3901);

const bridge = createConsoleBridge({ onChange: () => void protocol.refreshSnapshot() });
const runtimeEntry = () => path.resolve(process.env.PI861_RUNTIME_ENTRY ?? path.join(here, "../../pi861/runtime.ts"));
const chat = createChatBridge({
	config: bridge.config,
	stateDir: bridge.stateDir,
	runtimeEntry: runtimeEntry(),
	preferredModelId,
	emit: (event) => protocol.chatEmit(event),
});
const protocol = createProtocol({ bridge, chat, token, readonly });

function sendJson(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function authorized(req) {
	if (!token) return true;
	return req.headers.authorization === `Bearer ${token}`;
}

async function serveStatic(req, res, pathname) {
	const rel = pathname === "/" ? "index.html" : pathname.slice(1);
	const filePath = path.join(webDir, rel);
	if (!filePath.startsWith(webDir + path.sep)) {
		res.writeHead(403).end("Forbidden");
		return;
	}
	try {
		const data = await readFile(filePath);
		res.writeHead(200, {
			"Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream",
			"Cache-Control": "no-cache",
		});
		res.end(req.method === "HEAD" ? undefined : data);
	} catch {
		res.writeHead(404).end("Not found");
	}
}

const server = http.createServer(async (req, res) => {
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
		return;
	}
	try {
		if (pathname === "/healthz") {
			return sendJson(res, 200, {
				ok: true,
				mode: readonly ? "read-only" : "write",
				projectId: bridge.config.projectId,
				runner: bridge.runnerStatus(),
			});
		}
		if (pathname === "/api/snapshot") {
			if (!authorized(req)) return sendJson(res, 401, { error: "Bearer token required" });
			return sendJson(res, 200, await bridge.snapshot());
		}
		await serveStatic(req, res, pathname);
	} catch (error) {
		sendJson(res, 500, { error: String(error?.message ?? error) });
	}
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", protocol.handleConnection);

server.listen(port, host, () => {
	console.log(`[pi861-console] listening on http://${host}:${port} (ws at /ws)`);
	console.log(`[pi861-console] state dir: ${bridge.stateDir}, mode: ${readonly ? "read-only" : "write"}`);
});

const controller = new AbortController();
for (const name of ["SIGTERM", "SIGINT"]) process.on(name, () => controller.abort());
await new Promise((resolve) => {
	if (controller.signal.aborted) return resolve();
	controller.signal.addEventListener("abort", resolve, { once: true });
});
console.log("[pi861-console] shutting down");
protocol.close();
wss.close();
await Promise.allSettled([chat.shutdown(), bridge.shutdown()]);
server.close();
