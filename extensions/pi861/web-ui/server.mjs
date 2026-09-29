#!/usr/bin/env node
// pi861 read-only web dashboard: static files + JSON snapshot + SSE stream.
// No write endpoints, no request bodies, no secrets. GET/HEAD only.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./lib/config.mjs";
import { readSnapshot } from "./lib/readers/state.mjs";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.join(publicDir, rel);
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
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

async function handleStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  const tick = async () => {
    try {
      const snapshot = await readSnapshot(config.stateDir);
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    } catch (err) {
      res.write(`event: read-error\ndata: ${JSON.stringify(String(err.message))}\n\n`);
    }
  };
  await tick();
  const timer = setInterval(tick, config.pollMs);
  const stop = () => clearInterval(timer);
  req.on("close", stop);
  res.on("close", stop);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }
  const pathname = new URL(req.url, "http://localhost").pathname;
  try {
    if (pathname === "/api/snapshot") {
      sendJson(res, 200, await readSnapshot(config.stateDir));
    } else if (pathname === "/api/stream") {
      await handleStream(req, res);
    } else {
      await serveStatic(req, res, pathname);
    }
  } catch (err) {
    sendJson(res, 500, { error: String(err.message ?? err) });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`pi861 web-ui listening on http://${config.host}:${config.port}`);
  console.log(`state dir: ${config.stateDir}`);
});
