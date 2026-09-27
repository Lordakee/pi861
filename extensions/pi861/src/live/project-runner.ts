import type { RemoteWorkerClient } from "./remote-worker.ts";
import { digest } from "../memory.ts";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { ClaimResult, ExecutionSpec, ProjectCoordinator, WorkerIdentity } from "./coordinator.ts";
import type { Lease, TaskRecord } from "../scheduler.ts";
import { PiRpcSession, type PiRunResult } from "./pi-rpc.ts";
import type { ProcessSpec } from "./line-process.ts";
import { Workspaces, type Workspace, type CheckCommand } from "./workspace.ts";
const execute = promisify(execFile);
export interface ProjectWorkerOptions {
	identity: WorkerIdentity;
	process?: (workspace: Workspace, execution: ExecutionSpec) => ProcessSpec;
	remote?: RemoteWorkerClient;
	waitForSettled?: boolean;
}
export interface ProjectRunnerOptions {
	coordinator: ProjectCoordinator; workspaces: Workspaces; workers: ProjectWorkerOptions[];
	checks: CheckCommand[]; integration: Workspace;
	maxTaskMs?: number; leaseMs?: number;
	/** Idle re-check interval: persistent wakeup fallback for cross-process changes and node recovery. */
	idlePollMs?: number;
	/** Integration lease TTL; takeover of an expired lease waits for old Git processes to converge. */
	integrationLeaseMs?: number;
	onProgress?: (event: { taskId: string; state: string; detail?: string }) => void;
	/** Optional independent review; tests are still mandatory. */
	audit?: (task: TaskRecord, workspace: Workspace, result: PiRunResult, signal: AbortSignal) => Promise<boolean>;
}

/**
 * Real Pi processes with a persistent dispatch loop: it stays alive while the goal is active,
 * so plan appends, manual unblocks, control actions and node recovery re-dispatch without
 * recreating the runner. It settles only when the goal leaves the active state.
 */
export class ProjectRunner {
	private readonly options: ProjectRunnerOptions;
	private readonly runId = randomUUID();
	private controller: AbortController | undefined;
	private runPromise: Promise<void> | undefined;
	private integrationTail: Promise<unknown> = Promise.resolve();
	private wakeResolve: (() => void) | undefined;
	constructor(options: ProjectRunnerOptions) {
		if (!options.workers.length || new Set(options.workers.map((worker) => worker.identity.id)).size !== options.workers.length) throw new Error("Distinct worker identities required");
		this.options = options;
	}
	start(): Promise<void> {
		if (this.runPromise) return this.runPromise;
		this.controller = new AbortController();
		const unsubscribe = this.options.coordinator.onChange(() => this.wake());
		this.runPromise = this.loop(this.controller.signal).finally(() => { unsubscribe(); this.runPromise = undefined; });
		return this.runPromise;
	}
	/** External wakeup: coordinator mutations (append, unblock, control, recovery) resume dispatch. */
	wake(): void { this.wakeResolve?.(); }
	private waitIdle(signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			let onAbort: (() => void) | undefined;
			const finish = (): void => {
				if (this.wakeResolve === finish) this.wakeResolve = undefined;
				if (timer) clearTimeout(timer);
				if (onAbort) signal.removeEventListener("abort", onAbort);
				resolve();
			};
			this.wakeResolve = finish;
			onAbort = () => finish();
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) { finish(); return; }
			timer = setTimeout(finish, this.options.idlePollMs ?? 1000);
			timer.unref();
		});
	}
	async pause(): Promise<void> { await this.options.coordinator.control("pause"); this.controller?.abort(); this.wake(); await this.runPromise?.catch(() => {}); }
	/** Resume dispatch on the same runner instance; no reconstruction required. */
	async resume(): Promise<void> {
		try { await this.options.coordinator.control("resume"); }
		// A hard crash can leave the persisted goal active with no dispatch loop; resume then just restarts dispatch.
		catch (error) { if (!/Only a paused goal may resume/.test(String(error))) throw error; }
		// A resume landing while pause() is still draining the loop must wait out that drain,
		// mirroring pause(); otherwise the drained loop exits with no restart and the active goal strands.
		if (this.controller?.signal.aborted) await this.runPromise?.catch(() => {});
		if (!this.runPromise) void this.start().catch(() => {});
	}
	/** Single execution right over the integration workspace; waits out a live foreign holder. */
	private async acquireIntegration(holder: string, signal: AbortSignal): Promise<number> {
		const ttlMs = this.options.integrationLeaseMs ?? 120_000;
		const deadline = Date.now() + ttlMs * 2 + 5000;
		while (true) {
			signal.throwIfAborted();
			try {
				const { generation } = await this.options.coordinator.acquireIntegration(holder, this.options.integration.path, {
					ttlMs, probe: () => this.options.workspaces.gitLocks(this.options.integration)[0],
				});
				return generation;
			} catch (error) {
				if (Date.now() >= deadline || !/held|converged/i.test(String(error))) throw error;
				await sleep(250, undefined, { signal }).catch(() => signal.throwIfAborted());
			}
		}
	}
	private async execute(worker: ProjectWorkerOptions, claim: ClaimResult, outer: AbortSignal): Promise<void> {
		const { task, execution, baseCommit, goalId } = claim;
		const identity = { goal: goalId, run: this.runId };
		const lease = task.lease as Lease, leaseMs = this.options.leaseMs ?? 60_000;
		const local = new AbortController(), signal = AbortSignal.any([outer, local.signal, AbortSignal.timeout(this.options.maxTaskMs ?? 600_000)]);
		let session: PiRpcSession | undefined;
		const timer = setInterval(() => {
			void this.options.coordinator.heartbeat(worker.identity.id, lease, randomUUID(), leaseMs).catch((error: unknown) => local.abort(error));
		}, Math.max(10, Math.floor(leaseMs / 3)));
		try {
			this.options.onProgress?.({ taskId: task.id, state: "running" });
			const checks = execution.checkIds.map((id) => {
				const check = this.options.checks.find((check) => check.id === id); if (!check) throw new Error("Plan requests an unapproved validation command"); return check;
			});
			let workspace: Workspace, result: PiRunResult, commit: string;
			if (worker.remote) {
				const candidate = await worker.remote.run({ task, execution, baseCommit, baseBundle: await this.options.workspaces.exportCommit(baseCommit), identity }, signal);
				await this.options.workspaces.importCommit(candidate.bundle, candidate.commit);
				workspace = await this.options.workspaces.create(`inspect-${task.id}`, task.attempts, candidate.commit, identity);
				workspace.baseCommit = baseCommit; // Revalidate the complete remote diff, not only its claimed output.
				result = { text: candidate.text, messages: [], toolCalls: 0, usage: { input: 0, output: 0 } }; commit = candidate.commit;
			} else {
				workspace = await this.options.workspaces.create(task.id, task.attempts, baseCommit, identity);
				if (!worker.process) throw new Error("No configured worker transport");
				session = new PiRpcSession(worker.process(workspace, { ...execution, writeScopes: task.writeScopes }), { waitForSettled: worker.waitForSettled });
				result = await session.prompt([
					`Task: ${task.title}`, execution.instructions,
					`Permitted repository-relative write scopes: ${JSON.stringify(task.writeScopes)}`,
					`Acceptance: ${JSON.stringify(task.acceptance)}`,
					"Do not deploy, change other worktrees, expand permissions, create autonomous descendants, or run git commit. The host validates and commits your candidate.",
				].join("\n\n"), signal, this.options.maxTaskMs ?? 600_000);
				commit = "";
			}
			signal.throwIfAborted();
			const paths = await this.options.workspaces.changed(workspace, task.writeScopes);
			const evidence = await this.options.workspaces.check(workspace, checks, signal);
			if (this.options.audit && !await this.options.audit(task, workspace, result, signal)) throw new Error("Independent reviewer rejected candidate");
			if (!commit) commit = await this.options.workspaces.commit(workspace, paths, task.id);
			await this.options.coordinator.submit(worker.identity.id, lease, [`git:${commit}`, `workspace:${workspace.path}`, `response-sha:${digest(result.text)}`], randomUUID());
			this.options.onProgress?.({ taskId: task.id, state: "review" });
			const holder = `${worker.identity.id}:${this.runId}:${task.id}`;
			const integrate = this.integrationTail.then(async () => {
				// Cross-process mutual exclusion: durable lease + generation; stale executors cannot verify.
				const generation = await this.acquireIntegration(holder, signal);
				try {
					signal.throwIfAborted();
					await this.options.workspaces.integrate(this.options.integration, commit, signal);
					const integratedEvidence = await this.options.workspaces.check(this.options.integration, checks, signal);
					const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: this.options.integration.path })).stdout.trim();
					await this.options.coordinator.verify(lease, { accepted: true, evidence: [...evidence, ...integratedEvidence, `integration:${head}`] }, randomUUID(), head, generation);
					this.options.onProgress?.({ taskId: task.id, state: "done" });
				} catch (error) {
					await this.options.coordinator.reportIntegrationFailure(task.id, commit, this.options.integration.path,
						error instanceof Error ? error.message : "Integration failed").catch(() => {});
					throw error;
				} finally {
					await this.options.coordinator.releaseIntegration(holder, generation).catch(() => {});
				}
			});
			// The chain records settlement, never failure: a rejected tail would skip every later
			// callback and permanently block all integration. This task still awaits integrate below,
			// so its own failure is contained to this merge (blocked task + tracked repair entry).
			this.integrationTail = integrate.catch(() => {});
			await integrate;
		} catch {
			await this.options.coordinator.block(lease, "Execution or validation failed; inspect preserved workspace before retry", randomUUID()).catch(() => {});
			this.options.onProgress?.({ taskId: task.id, state: "blocked", detail: "Workspace and evidence retained; no task replay" });
		} finally { clearInterval(timer); await session?.close().catch(() => {}); }
	}
	private async loop(signal: AbortSignal): Promise<void> {
		const running = new Map<string, Promise<void>>();
		while (true) {
			if (!signal.aborted && (await this.options.coordinator.state()).status === "active") {
				for (const worker of this.options.workers) {
					if (running.has(worker.identity.id)) continue;
					const claim = await this.options.coordinator.claim(worker.identity, randomUUID(), this.options.leaseMs ?? 60_000);
					if (!claim) continue;
					const job = this.execute(worker, claim, signal).finally(() => running.delete(worker.identity.id));
					running.set(worker.identity.id, job);
				}
			}
			if (running.size) { await Promise.race(running.values()); continue; }
			if (signal.aborted || (await this.options.coordinator.state()).status !== "active") return;
			// Idle but the goal is active: settle a complete sealed plan, otherwise wait for a
			// persistent wakeup (append, unblock, node recovery, cross-process change) or the poll fallback.
			if (await this.options.coordinator.settleIfComplete() !== "active") return;
			await this.waitIdle(signal);
		}
	}
}
