import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { digest } from "../memory.ts";
import { record } from "../search.ts";
import type { TaskRecord } from "../scheduler.ts";
import type { ExecutionSpec, WorkerIdentity } from "./coordinator.ts";
import type { StateStore } from "./store.ts";
import type { ProcessSpec } from "./line-process.ts";
import { PiRpcSession } from "./pi-rpc.ts";
import { Workspaces, type Workspace, type CheckCommand } from "./workspace.ts";

export interface CommitBundle { data: string; sha256: string; }
/** identity carries the goal/run scope so a reused taskId cannot collide across goals. */
export interface RemoteJobIdentity { goal: string; run: string; }
export interface RemoteJobInput { id: string; task: TaskRecord; execution: ExecutionSpec; baseCommit: string; baseBundle: CommitBundle; identity?: RemoteJobIdentity; }
export interface RemoteCandidate { commit: string; bundle: CommitBundle; evidence: string[]; text: string; }
interface RemoteJob { id: string; hash: string; state: "queued" | "running" | "done" | "failed" | "unknown"; result?: RemoteCandidate; }
export interface RemoteJobs { jobs: RemoteJob[]; }
export interface RemoteWorkerConfig { url: string; token: string; allowLoopbackHttp?: boolean; pollMs?: number; }
const MAX_BODY = 48_000_000;
function authorized(value: string | undefined, expected: string): boolean {
	if (expected.length < 24 || !value?.startsWith("Bearer ")) return false;
	return timingSafeEqual(createHash("sha256").update(value.slice(7)).digest(), createHash("sha256").update(expected).digest());
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	let size = 0; const chunks: Buffer[] = [];
	for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY) throw new Error("Request too large"); chunks.push(chunk); }
	const parsed = record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); if (!parsed) throw new Error("Object required"); return parsed;
}
function reply(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value));
}
/** Fixed operator-owned executor configuration. Requests cannot supply commands, credentials or host paths. */
export class RemoteWorkerServer {
	private readonly state: StateStore<RemoteJobs>;
	private readonly config: { token: string; identity: WorkerIdentity; workspaces: Workspaces; checks: CheckCommand[]; process: (workspace: Workspace, execution: ExecutionSpec) => ProcessSpec; maxConcurrent: number; timeoutMs?: number; waitForSettled?: boolean };
	private readonly active = new Map<string, AbortController>();
	private readonly running = new Set<Promise<void>>();
	private readonly startedAt = Date.now();
	private server: Server | undefined;
	constructor(state: StateStore<RemoteJobs>, config: RemoteWorkerServer["config"]) {
		if (config.token.length < 24 || config.maxConcurrent < 1) throw new Error("Strong bearer token and positive capacity required");
		this.state = state; this.config = config;
	}
	async listen(port = 0, host = "127.0.0.1"): Promise<string> {
		if (this.server) throw new Error("Already listening");
		this.server = createServer((request, response) => { void this.handle(request, response).catch(() => { if (!response.headersSent) reply(response, 400, { error: "Request refused; inspect authorized operator diagnostics" }); else response.end(); }); });
		this.server.requestTimeout = 30_000; this.server.headersTimeout = 10_000;
		await new Promise<void>((resolve, reject) => { this.server?.once("error", reject); this.server?.listen(port, host, resolve); });
		// A crashed producer's state is not proof that its operations never happened.
		await this.state.update((state) => { for (const job of state.jobs) if (["queued", "running"].includes(job.state)) job.state = "unknown"; });
		const address = this.server.address(); if (!address || typeof address === "string") throw new Error("Missing listen address");
		return `http://${host}:${address.port}`;
	}
	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!authorized(request.headers.authorization, this.config.token)) { reply(response, 401, { error: "Unauthorized" }); return; }
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (request.method === "GET" && path === "/status") { reply(response, 200, await this.status()); return; }
		if (request.method === "GET" && path.startsWith("/jobs/")) {
			const id = path.slice(6), job = (await this.state.read()).jobs.find((job) => job.id === id);
			reply(response, job ? 200 : 404, job ? { id, state: job.state, result: job.result } : { error: "Not found" }); return;
		}
		if (request.method === "POST" && path === "/cancel") {
			const input = await body(request); this.active.get(String(input.id))?.abort(); reply(response, 202, { cancellationRequested: true }); return;
		}
		if (request.method !== "POST" || path !== "/jobs") { reply(response, 404, { error: "Not found" }); return; }
		const input = await body(request) as unknown as RemoteJobInput;
		if (!/^[a-f0-9]{64}$/.test(input.id) || !input.task?.lease || !Array.isArray(input.task.writeScopes) || !Array.isArray(input.task.acceptance) ||
			!input.task.acceptance.length || !Array.isArray(input.task.capabilities) || input.task.capabilities.some((capability) => !this.config.identity.capabilities.includes(capability)) || typeof input.execution?.instructions !== "string" || input.execution.instructions.length > 100_000 ||
			!this.config.identity.roleIds.includes(input.execution.roleId) || !this.config.identity.modelIds.includes(input.execution.modelId) ||
			(input.identity !== undefined && (typeof input.identity.goal !== "string" || typeof input.identity.run !== "string" || input.identity.goal.length > 200 || input.identity.run.length > 200)) ||
			!Array.isArray(input.execution.checkIds) || !input.execution.checkIds.length || input.execution.checkIds.some((id) => !this.config.checks.some((check) => check.id === id))) throw new Error("Unapproved task contract");
		const hash = digest(input);
		const accepted = await this.state.update((state) => {
			const prior = state.jobs.find((job) => job.id === input.id);
			if (prior) { if (prior.hash !== hash) throw new Error("Idempotency conflict"); return { fresh: false, state: prior.state }; }
			if (state.jobs.filter((job) => job.state === "running" || job.state === "queued").length >= this.config.maxConcurrent || state.jobs.length >= 10_000) throw new Error("Worker capacity exhausted");
			state.jobs.push({ id: input.id, hash, state: "queued" }); return { fresh: true, state: "queued" };
		});
		if (accepted.fresh) {
			const controller = new AbortController(); this.active.set(input.id, controller);
			const running = this.run(input, controller).catch(() => {}).finally(() => { this.active.delete(input.id); this.running.delete(running); });
			this.running.add(running);
		}
		reply(response, 202, { id: input.id, state: accepted.state });
	}
	private async run(input: RemoteJobInput, controller: AbortController): Promise<void> {
		let session: PiRpcSession | undefined;
		try {
			await this.state.update((state) => { const job = state.jobs.find((job) => job.id === input.id); if (job) job.state = "running"; });
			await this.config.workspaces.importCommit(input.baseBundle, input.baseCommit);
			controller.signal.throwIfAborted();
			const workspace = await this.config.workspaces.create(input.id, input.task.attempts, input.baseCommit, { goal: input.identity?.goal, run: input.identity?.run });
			session = new PiRpcSession(this.config.process(workspace, { ...input.execution, writeScopes: input.task.writeScopes }), { waitForSettled: this.config.waitForSettled });
			const result = await session.prompt(`Task: ${input.task.title}\n\n${input.execution.instructions}\nAllowed write scopes: ${JSON.stringify(input.task.writeScopes)}\nAcceptance: ${JSON.stringify(input.task.acceptance)}\nDo not deploy, change another worktree, commit, or create unmanaged descendants.`, controller.signal, this.config.timeoutMs ?? 600_000);
			const paths = await this.config.workspaces.changed(workspace, input.task.writeScopes);
			const evidence = await this.config.workspaces.check(workspace, this.config.checks.filter((check) => input.execution.checkIds.includes(check.id)), controller.signal);
			const commit = await this.config.workspaces.commit(workspace, paths, input.task.id);
			const bundle = await this.config.workspaces.exportCommit(commit, input.baseCommit);
			controller.signal.throwIfAborted();
			await this.state.update((state) => { const job = state.jobs.find((job) => job.id === input.id); if (job) { job.state = "done"; job.result = { commit, bundle, evidence, text: result.text.slice(0, 32_000) }; } });
		} catch { await this.state.update((state) => { const job = state.jobs.find((job) => job.id === input.id); if (job) job.state = controller.signal.aborted ? "unknown" : "failed"; }); }
		finally { session?.close(); }
	}
	/** Heartbeat/capacity announcement view used by the deployment entry and /status. */
	async status(): Promise<{ identity: WorkerIdentity; capacity: { maxConcurrent: number; busy: number }; jobs: Record<string, number>; uptimeMs: number }> {
		const jobs = (await this.state.read()).jobs;
		const counts: Record<string, number> = {};
		for (const job of jobs) counts[job.state] = (counts[job.state] ?? 0) + 1;
		return {
			identity: structuredClone(this.config.identity),
			capacity: { maxConcurrent: this.config.maxConcurrent, busy: jobs.filter((job) => job.state === "running" || job.state === "queued").length },
			jobs: counts, uptimeMs: Date.now() - this.startedAt,
		};
	}
	async close(): Promise<void> {
		for (const controller of this.active.values()) controller.abort();
		if (this.server) await new Promise<void>((resolve) => { this.server?.close(() => resolve()); this.server?.closeAllConnections(); });
		this.server = undefined;
		await Promise.allSettled(this.running);
	}
}
export class RemoteWorkerClient {
	private readonly config: RemoteWorkerConfig;
	constructor(config: RemoteWorkerConfig) {
		const url = new URL(config.url);
		if (url.username || url.password || url.search || url.hash || url.pathname !== "/" && url.pathname !== "" || config.token.length < 24 ||
			url.protocol !== "https:" && !(config.allowLoopbackHttp && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Trusted HTTPS worker endpoint required");
		this.config = config;
	}
	private async request(path: string, method: string, value: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
		const response = await fetch(`${this.config.url.replace(/\/$/, "")}${path}`, { method, redirect: "error", headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
			...(method === "GET" ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
		if (!response.ok) throw new Error(`Remote worker HTTP ${response.status}`);
		let size = 0; const chunks: Uint8Array[] = []; const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing worker response");
		try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_BODY) throw new Error("Worker response exceeds limit"); chunks.push(part.value); } }
		finally { await reader.cancel().catch(() => {}); }
		const parsed = record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); if (!parsed) throw new Error("Invalid worker response"); return parsed;
	}
	/** Capacity and health announcement of the remote node. */
	async status(): Promise<Record<string, unknown>> { return this.request("/status", "GET", null, AbortSignal.timeout(30_000)); }
	async run(input: Omit<RemoteJobInput, "id">, signal: AbortSignal): Promise<RemoteCandidate> {
		const id = digest({ identity: input.identity ?? null, lease: input.task.lease, execution: input.execution, baseCommit: input.baseCommit });
		const cancel = (): void => { void this.request("/cancel", "POST", { id }, AbortSignal.timeout(5000)).catch(() => {}); };
		signal.addEventListener("abort", cancel, { once: true });
		try {
			// Same ID can be queried after lost acknowledgement; task execution itself is never replayed here.
			try { await this.request("/jobs", "POST", { ...input, id }, signal); }
			catch (error) { if (signal.aborted) throw error; await this.request(`/jobs/${id}`, "GET", null, signal); }
			while (true) {
				signal.throwIfAborted(); const job = await this.request(`/jobs/${id}`, "GET", null, signal);
				if (job.state === "done") {
					const value = record(job.result), bundle = record(value?.bundle);
					if (!value || typeof value.commit !== "string" || !bundle || typeof bundle.data !== "string" || typeof bundle.sha256 !== "string" || !Array.isArray(value.evidence) || typeof value.text !== "string") throw new Error("Invalid remote candidate");
					return value as unknown as RemoteCandidate;
				}
				if (job.state === "failed" || job.state === "unknown") throw new Error("Remote attempt requires reconciliation; no automatic replay");
				await sleep(this.config.pollMs ?? 1000, undefined, { signal });
			}
		} finally { signal.removeEventListener("abort", cancel); }
	}
}
