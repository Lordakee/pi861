import { randomUUID } from "node:crypto";
import { TaskBoard, type BoardOptions, type BoardSnapshot, type ConcurrencyExplanation, type ConcurrencyReason, type Lease, type TaskRecord, type TaskSpec, type Verification, explainConcurrency } from "../scheduler.ts";
import { digest } from "../memory.ts";
import type { StateStore } from "./store.ts";

export interface ExecutionSpec { instructions: string; modelId: string; roleId: string; checkIds: string[]; writeScopes?: string[]; }
export interface TeamMember extends WorkerIdentity { capacity: number; remote?: boolean; joinedAt: number; }
export interface IntegrationLeaseState { holder: string; generation: number; expiresAt: number; workspacePath: string; }
export interface IntegrationFailureEntry { id: string; taskId: string; commit: string; workspacePath: string; reason: string; reportedAt: number; status: "open" | "resolved"; }
export interface ProjectState {
	format: 1; id: string; objective: string; baseCommit: string;
	status: "idle" | "active" | "paused" | "review" | "completed" | "cancelled";
	board: BoardSnapshot; execution: Record<string, ExecutionSpec>;
	receipts: Record<string, { hash: string; result: unknown }>; reason?: string;
	goalId?: string; planOpen?: boolean;
	team?: { members: TeamMember[] };
	integration?: IntegrationLeaseState;
	integrationFailures?: IntegrationFailureEntry[];
}
export function emptyProject(id: string): ProjectState {
	return { format: 1, id, objective: "", baseCommit: "", status: "idle", board: { version: 0, tasks: [] }, execution: {}, receipts: {} };
}
export interface WorkerIdentity { id: string; capabilities: string[]; roleIds: string[]; modelIds: string[]; }
export interface ClaimResult { task: TaskRecord; execution: ExecutionSpec; baseCommit: string; goalId: string; }

/**
 * Durable project coordination. Mutations are idempotent per (principal, requestId) and
 * wake registered listeners, so idle runners resume dispatch after appends, unblocks,
 * control actions, recoveries and integration lease changes.
 */
export class ProjectCoordinator {
	private readonly store: StateStore<ProjectState>;
	private readonly limits: BoardOptions;
	private maxTasks: number;
	private readonly listeners = new Set<() => void>();
	constructor(store: StateStore<ProjectState>, limits: BoardOptions, maxTasks = 100) { this.store = store; this.limits = limits; this.maxTasks = maxTasks; }
	/** Subscribe to state-shaping mutations (never heartbeats or empty claims). Returns an unsubscribe function. */
	onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private wake(): void { for (const listener of [...this.listeners]) { try { listener(); } catch { /* listener failures never abort coordination */ } } }
	async state(): Promise<ProjectState> { return this.store.read(); }
	private async change<R>(principal: string, requestId: string, intent: unknown, fn: (state: ProjectState, board: TaskBoard) => R, wakeup = false): Promise<R> {
		if (!principal || !requestId || requestId.length > 200) throw new Error("Mutation identity required");
		const result = await this.store.update((state) => {
			const key = digest([principal, requestId]), hash = digest(intent), receipt = state.receipts[key];
			if (receipt) { if (receipt.hash !== hash) throw new Error("Coordinator idempotency conflict"); return structuredClone(receipt.result as R); }
			const beforeBoard = state.board;
			const board = new TaskBoard(this.limits, state.board);
			const result = fn(state, board); if (state.board === beforeBoard) state.board = board.state;
			state.receipts[key] = { hash, result: result ?? null };
			return result;
		});
		if (wakeup) this.wake();
		return result;
	}
	async create(objective: string, baseCommit: string, tasks: { task: TaskSpec; execution: ExecutionSpec }[], options: { planOpen?: boolean } = {}): Promise<void> {
		if (!objective.trim() || !/^[a-f0-9]{40,64}$/.test(baseCommit) || !tasks.length || tasks.length > this.maxTasks) throw new Error("Invalid project plan");
		await this.change("operator", randomUUID(), { objective, baseCommit, tasks, options }, (state, board) => {
			if (!["idle", "completed", "cancelled"].includes(state.status)) throw new Error("Project already has an unfinished goal");
			state.board = { version: 0, tasks: [] }; state.execution = {};
			delete state.integration; // A stale lease from the previous goal must not block the next one.
			const next = new TaskBoard(this.limits);
			next.add(tasks.map((item) => item.task));
			for (const item of tasks) {
				if (!item.execution.instructions.trim() || !item.execution.modelId || !item.execution.roleId || !item.execution.checkIds.length) throw new Error("Every task needs an executable/verifiable contract");
				state.execution[item.task.id] = structuredClone(item.execution);
			}
			state.board = next.state;
			state.objective = objective; state.baseCommit = baseCommit; state.status = "active";
			state.goalId = randomUUID(); state.planOpen = options.planOpen === true; delete state.reason;
		}, true);
	}
	/** Rolling planning entry: versioned append keeps concurrent planners from duplicating work. */
	async append(tasks: { task: TaskSpec; execution: ExecutionSpec }[], expectedVersion: number): Promise<void> {
		await this.change("planner", randomUUID(), { tasks, expectedVersion }, (state, board) => {
			if (state.status !== "active" || state.board.version !== expectedVersion || state.board.tasks.length + tasks.length > this.maxTasks) throw new Error("Stale plan or task budget exhausted");
			for (const item of tasks) if (!item.execution.instructions.trim() || !item.execution.modelId || !item.execution.roleId || !item.execution.checkIds.length) throw new Error("Missing task execution contract");
			board.add(tasks.map((item) => item.task));
			for (const item of tasks) state.execution[item.task.id] = item.execution;
		}, true);
	}
	/** Withdraw queued (never started) tasks; versioned like append. */
	async withdraw(taskIds: string[], expectedVersion: number): Promise<void> {
		await this.change("planner", randomUUID(), { taskIds, expectedVersion }, (state, board) => {
			if (state.status !== "active" || state.board.version !== expectedVersion) throw new Error("Stale plan");
			board.remove(taskIds);
			for (const id of taskIds) delete state.execution[id];
		}, true);
	}
	/** Close the plan: after this, all-done settles the goal instead of idle-waiting for more work. */
	async seal(expectedVersion: number): Promise<void> {
		await this.change("planner", randomUUID(), { op: "seal", expectedVersion }, (state) => {
			if (state.status !== "active" || state.board.version !== expectedVersion) throw new Error("Stale plan");
			if (state.planOpen !== true) throw new Error("Plan is already sealed");
			state.planOpen = false;
		}, true);
	}
	async claim(worker: WorkerIdentity, requestId: string, leaseMs = 60_000): Promise<ClaimResult | null> {
		// Idle polls stay read-only, but an already-served request replays its receipt first.
		const current = await this.state();
		const now = Date.now();
		if (!current.receipts[digest([worker.id, requestId])] && !current.board.tasks.some((task) =>
			task.status === "queued" || (task.status === "running" || task.status === "review") && (task.leaseUntil ?? 0) <= now)) return null;
		return this.change(worker.id, requestId, { op: "claim", worker, leaseMs }, (state, board) => {
			if (state.status !== "active") return null;
			board.recoverExpired(Date.now());
			// Ineligible role/model requirements become unmatchable capabilities in this worker's view.
			const allowed = state.board.tasks.filter((task) => {
				const execution = state.execution[task.id];
				return execution && worker.roleIds.includes(execution.roleId) && worker.modelIds.includes(execution.modelId);
			}).map((task) => task.id);
			const task = board.claim(worker.id, worker.capabilities, Date.now(), leaseMs, allowed);
			if (!task) return null;
			return { task, execution: state.execution[task.id] as ExecutionSpec, baseCommit: state.baseCommit, goalId: state.goalId ?? "" };
		});
	}
	async heartbeat(workerId: string, lease: Lease, requestId: string, leaseMs = 60_000): Promise<void> {
		if (workerId !== lease.workerId) throw new Error("Foreign task lease");
		await this.change(workerId, requestId, { op: "heartbeat", lease, leaseMs }, (state, board) => {
			if (state.status !== "active") throw new Error("Project is not active");
			board.heartbeat(lease, Date.now(), leaseMs);
		});
	}
	async submit(workerId: string, lease: Lease, artifacts: string[], requestId: string): Promise<void> {
		if (workerId !== lease.workerId) throw new Error("Foreign task lease");
		await this.change(workerId, requestId, { op: "submit", lease, artifacts }, (state, board) => {
			if (state.status !== "active") throw new Error("Project no longer active");
			board.submit(lease, artifacts, Date.now());
		}, true);
	}
	/** generation must match the current integration lease when a commit was merged by its holder. */
	async verify(lease: Lease, verdict: Verification, requestId: string, integratedCommit?: string, generation?: number): Promise<void> {
		await this.change("verifier", requestId, { op: "verify", lease, verdict, integratedCommit: integratedCommit ?? null, generation: generation ?? null }, (state, board) => {
			if (state.status !== "active") throw new Error("Project no longer active");
			if (generation !== undefined && state.integration?.generation !== generation) throw new Error("Stale integration generation; another executor owns the workspace");
			if (verdict.accepted) {
				board.accept(lease, verdict.evidence, Date.now());
				if (integratedCommit) { if (!/^[a-f0-9]{40,64}$/.test(integratedCommit)) throw new Error("Invalid integrated commit"); state.baseCommit = integratedCommit; }
			}
			else board.block(lease, verdict.reason ?? "Verification rejected", Date.now());
			if (board.state.tasks.every((task) => task.status === "done") && !state.planOpen) state.status = "review";
		}, true);
	}
	async block(lease: Lease, reason: string, requestId: string): Promise<void> {
		await this.change(lease.workerId, requestId, { op: "block", lease, reason }, (_state, board) => board.block(lease, reason, Date.now()), true);
	}
	/** Manual unblock: a blocked task becomes claimable again without a new attempt budget. */
	async unblock(taskId: string): Promise<void> {
		await this.change("operator", randomUUID(), { op: "unblock", taskId }, (_state, board) => board.requeue(taskId), true);
	}
	/** Idle-goal settlement: sealed plan with every task verified transitions to review. */
	async settleIfComplete(): Promise<ProjectState["status"]> {
		const current = await this.state();
		if (current.status !== "active" || current.planOpen === true || !current.board.tasks.every((task) => task.status === "done")) return current.status;
		return this.change("operator", randomUUID(), { op: "settle" }, (state) => {
			if (state.status === "active" && !state.planOpen && state.board.tasks.every((task) => task.status === "done")) {
				state.status = "review";
				state.reason = "All tasks verified; plan sealed";
			}
			return state.status;
		}, true);
	}
	async control(action: "pause" | "resume" | "accept" | "cancel"): Promise<void> {
		await this.change("operator", randomUUID(), { action }, (state) => {
			if (action === "accept") { if (state.status !== "review") throw new Error("Goal is not ready for acceptance"); state.status = "completed"; }
			else if (action === "cancel") state.status = "cancelled";
			else if (action === "pause") { if (state.status === "active") state.status = "paused"; }
			else { if (state.status !== "paused") throw new Error("Only a paused goal may resume"); state.status = "active"; }
		}, true);
	}
	async edit(objective: string): Promise<void> {
		await this.change("operator", randomUUID(), { op: "edit", objective }, (state) => {
			if (state.status !== "paused") throw new Error("Pause the project before editing the objective");
			if (!objective.trim() || objective.length > 16_000) throw new Error("A non-empty objective is required");
			state.objective = objective.trim();
		}, true);
	}
	async setBudget(maxTasks: number): Promise<void> {
		await this.change("operator", randomUUID(), { op: "budget", maxTasks }, (state) => {
			if (!Number.isSafeInteger(maxTasks) || maxTasks < 1) throw new Error("Invalid task budget");
			if (maxTasks < state.board.tasks.length) throw new Error("Task budget cannot be below the current plan size");
		});
		this.maxTasks = maxTasks;
	}
	/**
	 * Single-executor lease over the project's integration workspace. A live foreign holder blocks;
	 * taking over an expired lease requires the previous Git processes to have converged (probe finds
	 * no lock files). Generation numbers reject verify() calls from a superseded executor.
	 */
	async acquireIntegration(holder: string, workspacePath: string, options: { ttlMs?: number; probe?: () => string | undefined } = {}): Promise<{ generation: number }> {
		if (!holder || !workspacePath) throw new Error("Integration holder and workspace are required");
		const ttlMs = options.ttlMs ?? 120_000;
		return this.change("integrator", randomUUID(), { op: "integration-lease", holder, workspacePath, ttlMs }, (state) => {
			const lease = state.integration;
			const now = Date.now();
			if (lease && lease.workspacePath !== workspacePath && lease.expiresAt > now) throw new Error(`Project integrates through ${lease.workspacePath}; held by ${lease.holder}`);
			if (lease && lease.holder !== holder && lease.expiresAt > now) throw new Error(`Integration workspace held by ${lease.holder} until ${new Date(lease.expiresAt).toISOString()}`);
			if (lease && lease.holder !== holder && lease.expiresAt <= now) {
				const blocking = options.probe?.();
				if (blocking) throw new Error(`Previous Git process has not converged; lock present: ${blocking}`);
			}
			const generation = (lease?.generation ?? 0) + 1;
			state.integration = { holder, generation, expiresAt: now + ttlMs, workspacePath };
			return { generation };
		}, true);
	}
	async releaseIntegration(holder: string, generation: number): Promise<void> {
		await this.change(holder, randomUUID(), { op: "integration-release", holder, generation }, (state) => {
			if (state.integration?.holder === holder && state.integration.generation === generation) delete state.integration;
		}, true);
	}
	/** Tracked repair entry for a failed integration: preserved scene plus a resolvable record. */
	async reportIntegrationFailure(taskId: string, commit: string, workspacePath: string, reason: string): Promise<void> {
		await this.change("integrator", randomUUID(), { op: "integration-failure", taskId, commit, workspacePath, reason }, (state) => {
			state.integrationFailures = [...(state.integrationFailures ?? []).slice(-99), {
				id: randomUUID(), taskId, commit, workspacePath, reason: reason.slice(0, 2000), reportedAt: Date.now(), status: "open",
			}];
		}, true);
	}
	async resolveIntegrationFailure(entryId: string): Promise<void> {
		await this.change("operator", randomUUID(), { op: "integration-resolve", entryId }, (state) => {
			const entry = (state.integrationFailures ?? []).find((item) => item.id === entryId);
			if (!entry) throw new Error("Unknown integration failure entry");
			if (entry.status !== "open") throw new Error("Failure entry is already resolved");
			entry.status = "resolved";
		}, true);
	}
	async openIntegrationFailures(): Promise<IntegrationFailureEntry[]> {
		return (await this.state()).integrationFailures?.filter((entry) => entry.status === "open") ?? [];
	}
	/** Persistent team entity: members survive goal rotation. */
	async joinTeam(member: Omit<TeamMember, "joinedAt">): Promise<void> {
		if (!member.id || member.capacity < 1) throw new Error("Team member identity and positive capacity required");
		await this.change("operator", randomUUID(), { op: "join", member }, (state) => {
			const members = (state.team?.members ?? []).filter((existing) => existing.id !== member.id);
			state.team = { members: [...members, { ...structuredClone(member), joinedAt: Date.now() }] };
		}, true);
	}
	async leaveTeam(workerId: string): Promise<void> {
		await this.change("operator", randomUUID(), { op: "leave", workerId }, (state) => {
			if (state.team) state.team = { members: state.team.members.filter((member) => member.id !== workerId) };
		}, true);
	}
	/** Whole-task-tree capacity accounting: execution, review, integration, remote and waiting states. */
	async accounting(): Promise<{ slots: number; executing: number; remote: number; reviewing: number; integration: number; waiting: number; blocked: number; done: number; teamSize: number }> {
		const state = await this.state();
		const tasks = state.board.tasks;
		const remoteIds = new Set((state.team?.members ?? []).filter((member) => member.remote).map((member) => member.id));
		const running = tasks.filter((task) => task.status === "running");
		return {
			slots: this.limits.maxConcurrent,
			executing: running.filter((task) => !remoteIds.has(task.lease?.workerId ?? "")).length,
			remote: running.filter((task) => remoteIds.has(task.lease?.workerId ?? "")).length,
			reviewing: tasks.filter((task) => task.status === "review").length,
			integration: state.integration && state.integration.expiresAt > Date.now() ? 1 : 0,
			waiting: tasks.filter((task) => task.status === "queued" && task.dependsOn.some((id) => !tasks.some((other) => other.id === id && other.status === "done"))).length,
			blocked: tasks.filter((task) => task.status === "blocked").length,
			done: tasks.filter((task) => task.status === "done").length,
			teamSize: state.team?.members.length ?? 0,
		};
	}
	/** R8.7 view: why concurrency is not saturated. */
	async explain(workers?: WorkerIdentity[]): Promise<ConcurrencyExplanation & { reasons: ConcurrencyReason[] }> {
		const state = await this.state();
		const teamWorkers = state.team?.members.map((member) => ({ id: member.id, capabilities: member.capabilities })) ?? [];
		const views = (workers ?? teamWorkers).map((worker) => ({ id: worker.id, capabilities: worker.capabilities }));
		const explanation = explainConcurrency(state.board.tasks, this.limits, views);
		const reasons = [...explanation.reasons];
		if (state.board.tasks.length >= this.maxTasks) reasons.push({ kind: "plan-budget", detail: `task budget reached (${state.board.tasks.length}/${this.maxTasks}); /goal budget N raises it`, taskIds: [] });
		if (state.status === "paused") reasons.push({ kind: "paused", detail: "project is paused; /goal resume restarts dispatch", taskIds: [] });
		return { ...explanation, reasons };
	}
}

export interface PlanRefill { tasks: { task: TaskSpec; execution: ExecutionSpec }[]; withdraw?: string[]; seal?: boolean }
/**
 * Rolling planning caller: below the low watermark an authorized planner callback refills the plan.
 * Plan version conflicts (concurrent append) are retried once against a fresh snapshot.
 */
export class RollingPlanner {
	private readonly coordinator: ProjectCoordinator;
	private readonly options: { lowWatermark: number; signal: AbortSignal; plan: (state: ProjectState) => Promise<PlanRefill> };
	constructor(coordinator: ProjectCoordinator, options: { lowWatermark: number; signal: AbortSignal; plan: (state: ProjectState) => Promise<PlanRefill> }) {
		if (!Number.isSafeInteger(options.lowWatermark) || options.lowWatermark < 1) throw new Error("Positive low watermark required");
		this.coordinator = coordinator; this.options = options;
	}
	/** Returns the number of tasks appended by this tick. */
	async tick(): Promise<number> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const state = await this.coordinator.state();
			const open = state.board.tasks.filter((task) => ["queued", "running", "review"].includes(task.status)).length;
			if (state.status !== "active" || open >= this.options.lowWatermark) return 0;
			const refill = await this.options.plan(structuredClone(state));
			this.options.signal.throwIfAborted();
			if (!refill.tasks.length && !refill.seal && !refill.withdraw?.length) return 0;
			try {
				if (refill.withdraw?.length) await this.coordinator.withdraw(refill.withdraw, state.board.version);
				if (refill.tasks.length) await this.coordinator.append(refill.tasks, state.board.version);
				if (refill.seal) await this.coordinator.seal((await this.coordinator.state()).board.version);
				return refill.tasks.length;
			} catch (error) {
				if (attempt === 0 && /Stale plan/.test(String(error))) continue;
				throw error;
			}
		}
		return 0;
	}
}

export interface ProjectGoalHandle { pause(): Promise<void>; resume(): Promise<void>; }
/**
 * Full /goal verb set for the project runtime: status | pause | resume | edit TEXT | budget N |
 * accept | clear | explain | failures | unblock TASK. Runtime hosts delegate their command
 * handler here; goal creation (planner run) stays with the host.
 */
export async function projectGoalCommand(coordinator: ProjectCoordinator, runner: ProjectGoalHandle | undefined, workers: WorkerIdentity[] | undefined, input: string): Promise<string> {
	const trimmed = input.trim();
	const [verb, ...rest] = trimmed.split(/\s+/);
	const text = rest.join(" ").trim();
	if (!verb || verb === "status") return JSON.stringify({ ...(await coordinator.state()), accounting: await coordinator.accounting(), concurrency: await coordinator.explain(workers) }, null, 2);
	if (verb === "pause") { if (runner) await runner.pause(); else await coordinator.control("pause"); return "Project paused"; }
	if (verb === "resume") { if (runner) await runner.resume(); else await coordinator.control("resume"); return "Project resumed; dispatch continues"; }
	if (verb === "clear") { if (runner) await runner.pause(); await coordinator.control("cancel"); return "Project cancelled"; }
	if (verb === "accept") { await coordinator.control("accept"); return "Goal accepted"; }
	if (verb === "edit") { await coordinator.edit(text); return "Objective revised; reconcile completed work before resuming"; }
	if (verb === "budget") { await coordinator.setBudget(Number(text)); return "Task budget updated"; }
	if (verb === "explain") return JSON.stringify(await coordinator.explain(workers), null, 2);
	if (verb === "failures") return JSON.stringify(await coordinator.openIntegrationFailures(), null, 2);
	if (verb === "unblock") { await coordinator.unblock(text); return `Task ${text} requeued`; }
	throw new Error(`Unknown /goal verb: ${verb}. Use status | pause | resume | edit TEXT | budget N | accept | clear | explain | failures | unblock TASK`);
}
