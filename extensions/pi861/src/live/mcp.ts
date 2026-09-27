import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { digest } from "../memory.ts";
import { record } from "../search.ts";
import { LineProcess, type ProcessSpec } from "./line-process.ts";

export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; schemaHash: string; }
export type McpTransport = { kind: "stdio"; process: ProcessSpec } |
	{ kind: "http"; url: string; headers?: Record<string, string>; allowLoopbackHttp?: boolean };
export interface McpServer { id: string; accountId: string; transport: McpTransport; timeoutMs?: number; maxBytes?: number;
	/** Bounded reconnection for connection establishment only; tool dispatches are never replayed. */
	reconnect?: { maxAttempts?: number; baseDelayMs?: number };
}
export type DeploymentMode = "trusted-local" | "production-isolated";
/**
 * Boundary contract between deployment modes (R5.11):
 * - trusted-local: one operator-controlled machine. Local stdio servers and explicitly flagged loopback HTTP are
 *   accepted; raw Skill sources, shell and scripts stay behind the same role checks and state stays single-tenant.
 * - production-isolated: a shared runtime host. MCP servers must be remote HTTPS endpoints (no local child processes,
 *   no plain HTTP even on loopback) so one tenant's server cannot read another tenant's process or filesystem.
 */
export function enforceDeploymentMode(mode: DeploymentMode, servers: McpServer[]): void {
	if (mode !== "production-isolated") return;
	for (const server of servers) {
		if (server.transport.kind !== "http" || new URL(server.transport.url).protocol !== "https:") {
			throw new Error("Production-isolated mode requires HTTPS MCP endpoints; local transports are not trusted boundaries");
		}
	}
}
export class McpFailure extends Error {
	readonly outcome: "not_dispatched" | "unknown" | "reported_error";
	constructor(message: string, outcome: McpFailure["outcome"]) { super(message); this.outcome = outcome; }
}

/** A bounded tool client, not an OAuth broker. Endpoint credentials are resolved by the trusted host. */
export class McpClient {
	readonly server: McpServer;
	private process: LineProcess | undefined;
	private connected: Promise<void> | undefined;
	private session: string | undefined;
	private protocol = "2025-11-25";
	private generation = 0;
	private dirty = true;
	private cached: McpTool[] = [];
	private readonly observers = new Set<(event: Record<string, unknown>) => void>();
	constructor(server: McpServer) {
		if (!/^[a-zA-Z0-9_-]+$/.test(server.id) || !server.accountId) throw new Error("Invalid MCP server identity");
		if (server.transport.kind === "http") {
			const endpoint = new URL(server.transport.url);
			const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
			if (endpoint.username || endpoint.password || endpoint.hash ||
				(endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && local && server.transport.allowLoopbackHttp))) {
				throw new Error("MCP requires HTTPS, or explicitly allowed loopback HTTP");
			}
		}
		this.server = structuredClone(server);
	}
	private message(event: Record<string, unknown>): void {
		const method = typeof event.method === "string" ? event.method : "";
		if (method.startsWith("notifications/")) {
			// Full notification set: list changes invalidate caches; progress and log messages surface to observers.
			if (method === "notifications/tools/list_changed") this.dirty = true;
			for (const observer of this.observers) {
				try {
					observer(event);
				} catch {
					// Observer failures must never break transport dispatch.
				}
			}
		}
		if (event.type === "process_error") { this.connected = undefined; this.dirty = true; }
		if (event.id !== undefined && typeof event.method === "string") {
			// Protocol ping is answered; no model sampling, elicitation or execution initiated by an untrusted server.
			const reply = method === "ping" ? { jsonrpc: "2.0", id: event.id, result: {} }
				: { jsonrpc: "2.0", id: event.id, error: { code: -32601, message: "Client capability not supported" } };
			this.process?.send(reply);
		}
	}
	onNotification(listener: (event: Record<string, unknown>) => void): () => void {
		this.observers.add(listener); return () => this.observers.delete(listener);
	}
	async connect(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!this.connected) {
			this.connected = this.establish(signal).catch((error: unknown) => { this.connected = undefined; this.teardown(); throw error; });
		}
		await this.connected;
		signal.throwIfAborted();
	}
	private teardown(): void {
		this.generation++; this.process?.close(); this.process = undefined; this.session = undefined; this.dirty = true;
	}
	private async establish(signal: AbortSignal): Promise<void> {
		const maxAttempts = Math.max(1, Math.min(8, this.server.reconnect?.maxAttempts ?? 1));
		const baseDelayMs = this.server.reconnect?.baseDelayMs ?? 200;
		for (let attempt = 1; ; attempt++) {
			try {
				if (this.server.transport.kind === "stdio") {
					this.process?.close();
					this.process = new LineProcess(this.server.transport.process, this.server.maxBytes);
					this.process.onEvent((event) => this.message(event));
				}
				const epoch = this.generation;
				const reply = record(await this.raw("initialize", {
					protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pi861", version: "0.2.0-alpha.1" },
				}, signal));
				if (!reply || !["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(String(reply.protocolVersion)) || !record(reply.capabilities)?.tools) {
					throw new Error("Unsupported MCP version or missing tools capability");
				}
				this.protocol = String(reply.protocolVersion);
				await this.notify("notifications/initialized", {}, signal);
				if (epoch !== this.generation) throw new Error("Stale MCP connection");
				return;
			} catch (error) {
				// Reconnect policy applies to establishment only; a failed tools/call is never redispatched.
				if (attempt >= maxAttempts || signal.aborted || !(error instanceof McpFailure) || error.outcome !== "not_dispatched") throw error;
				this.teardown();
				const closedEpoch = this.generation;
				await sleep(baseDelayMs * 2 ** (attempt - 1), undefined, { signal });
				if (closedEpoch !== this.generation) throw new Error("MCP client closed during reconnect");
			}
		}
	}
	private async notify(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<void> {
		const payload = { jsonrpc: "2.0", method, params };
		if (this.process) { this.process.send(payload); return; }
		await this.http(payload, signal);
	}
	private async http(payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
		const transport = this.server.transport;
		if (transport.kind !== "http") throw new Error("MCP process unavailable");
		const effective = AbortSignal.any([signal, AbortSignal.timeout(this.server.timeoutMs ?? 30_000)]);
		const headers: Record<string, string> = {
			...transport.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
		};
		if (this.session) headers["Mcp-Session-Id"] = this.session;
		if (payload.method !== "initialize") headers["MCP-Protocol-Version"] = this.protocol;
		const response = await fetch(transport.url, { method: "POST", headers, body: JSON.stringify(payload), signal: effective, redirect: "error" });
		if (!response.ok) {
			await response.body?.cancel();
			if (response.status === 404) { this.session = undefined; this.connected = undefined; this.dirty = true; }
			throw new McpFailure(`MCP HTTP ${response.status}`, payload.method === "tools/call" ? "unknown" : "not_dispatched");
		}
		if (payload.method === "initialize") {
			const session = response.headers.get("Mcp-Session-Id");
			if (session && !/^[\x21-\x7e]{1,1024}$/.test(session)) throw new Error("Invalid MCP session header");
			this.session = session ?? undefined;
		}
		if (payload.id === undefined || payload.method === undefined) { await response.body?.cancel(); return undefined; }
		if (!response.body) throw new Error("MCP response has no body");
		const isSse = response.headers.get("content-type")?.includes("text/event-stream");
		if (!isSse && !response.headers.get("content-type")?.includes("application/json")) {
			await response.body.cancel(); throw new Error("Unexpected MCP content type");
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "", total = 0;
		const max = this.server.maxBytes ?? 4_194_304;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > max) throw new Error("MCP response exceeds byte limit");
				buffer += decoder.decode(value, { stream: true });
				if (!isSse) continue;
				let boundary: RegExpExecArray | null;
				while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
					const frame = buffer.slice(0, boundary.index);
					buffer = buffer.slice(boundary.index + boundary[0].length);
					const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
					if (!data) continue;
					const message = record(JSON.parse(data));
					if (!message) throw new Error("Invalid MCP SSE message");
					if (message.id === payload.id && ("result" in message || "error" in message)) return message;
					this.message(message);
					if (message.id !== undefined && typeof message.method === "string") {
						const answer = typeof message.method === "string" && message.method === "ping"
							? { jsonrpc: "2.0", id: message.id, result: {} }
							: { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not supported" } };
						await this.http(answer, effective);
					}
				}
			}
			buffer += decoder.decode();
			if (isSse) throw new McpFailure("MCP stream ended before its response; do not replay tool operations", "unknown");
			const message = record(JSON.parse(buffer));
			if (!message || message.id !== payload.id) throw new Error("MCP response id mismatch");
			return message;
		} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
	}
	private async raw(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		const id = randomUUID();
		const payload = { jsonrpc: "2.0", method, params, id };
		// Cancellation propagation: tell the server the request is abandoned so it can stop work (R5.6).
		const propagateCancel = (): void => {
			void this.notify("notifications/cancelled", { requestId: id, reason: "cancelled" }, AbortSignal.timeout(2_000)).catch(() => {});
		};
		signal.addEventListener("abort", propagateCancel, { once: true });
		let reply: Record<string, unknown> | undefined;
		try {
			reply = this.process ? await this.process.request(payload, signal, this.server.timeoutMs ?? 30_000) : await this.http(payload, signal);
		} catch (error) {
			if (error instanceof McpFailure) throw error;
			throw new McpFailure(signal.aborted ? "MCP call cancelled; reconcile any dispatched operation" : "MCP transport failed", method === "tools/call" ? "unknown" : "not_dispatched");
		} finally {
			signal.removeEventListener("abort", propagateCancel);
		}
		if (reply?.error) throw new McpFailure("MCP server reported an operation error", "reported_error");
		if (!reply || !("result" in reply)) throw new Error("Missing MCP result");
		return reply.result;
	}
	async tools(signal: AbortSignal, refresh = false): Promise<McpTool[]> {
		await this.connect(signal);
		if (!this.dirty && !refresh) return structuredClone(this.cached);
		const tools: McpTool[] = [], seen = new Set<string>(), cursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < 100; page++) {
			const result = record(await this.raw("tools/list", cursor ? { cursor } : {}, signal));
			if (!result || !Array.isArray(result.tools)) throw new Error("Invalid MCP tool list");
			for (const value of result.tools) {
				const tool = record(value);
				if (!tool || typeof tool.name !== "string" || !/^[\w./:-]{1,128}$/.test(tool.name) || !record(tool.inputSchema) || seen.has(tool.name)) throw new Error("Invalid or duplicate MCP tool");
				seen.add(tool.name);
				const inputSchema = tool.inputSchema as Record<string, unknown>;
				tools.push({ name: tool.name, description: typeof tool.description === "string" ? tool.description.slice(0, 16_000) : tool.name,
					inputSchema, schemaHash: digest({ name: tool.name, inputSchema }) });
				if (tools.length > 10_000) throw new Error("MCP tool list too large");
			}
			if (!result.nextCursor) { this.cached = tools; this.dirty = false; return structuredClone(tools); }
			if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) throw new Error("Invalid MCP pagination");
			cursor = result.nextCursor; cursors.add(cursor);
		}
		throw new Error("MCP pagination limit exceeded");
	}
	async call(name: string, args: Record<string, unknown>, schemaHash: string, signal: AbortSignal): Promise<unknown> {
		// Refresh before dispatch so old definitions cannot silently target changed schemas.
		const tool = (await this.tools(signal, true)).find((item) => item.name === name);
		if (!tool || tool.schemaHash !== schemaHash) throw new McpFailure("MCP schema changed; reactivate the skill", "not_dispatched");
		signal.throwIfAborted();
		return this.raw("tools/call", { name, arguments: args }, signal); // Deliberately never retry.
	}
	close(): void {
		this.teardown(); this.connected = undefined;
	}
}
