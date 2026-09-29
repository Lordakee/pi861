// Coordinator/Runner bridge for the pi861 web console.
// Reuses the real runtime classes (ProjectCoordinator, ProjectRunner, Workspaces) so
// console mutations go through the same idempotent, lease- and lock-protected paths
// as the runtime host. Requires Node >= 23.6 for native .ts type stripping.

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { emptyProject, ProjectCoordinator } from "../../pi861/src/live/coordinator.ts";
import { ProjectRunner } from "../../pi861/src/live/project-runner.ts";
import { FileStateStore } from "../../pi861/src/live/store.ts";
import { Workspaces } from "../../pi861/src/live/workspace.ts";
import { TaskBoard } from "../../pi861/src/scheduler.ts";

/** Mirrors runtime.ts configFromFile validation; never imports the extension itself. */
export function readRuntimeConfig() {
	const path = process.env.PI861_CONFIG;
	if (!path || (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)))
		throw new Error("Set PI861_CONFIG to an absolute trusted JSON configuration path");
	const config = JSON.parse(readFileSync(path, "utf8"));
	if (config.version !== 2 || !/^[a-zA-Z0-9_-]+$/.test(config.projectId) || !config.stateDirectory || !config.role?.id)
		throw new Error("Invalid Pi861 runtime configuration");
	config.stateDirectory = resolve(config.stateDirectory);
	return { config, path };
}

function writeConfigFile(path, config) {
	// Preserve the operator's file mode; atomic tmp+rename like FileStateStore.
	let mode = 0o600;
	try {
		mode = statSync(path).mode & 0o777;
	} catch {
		/* default 0600 for a new file */
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", mode);
	try {
		writeFileSync(fd, JSON.stringify(config, null, "\t"), "utf8");
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
}

/** Console agent model assignments persisted inside PI861_CONFIG under console.agentModels. */
export function readAgentModels(config) {
	return config.console?.agentModels ?? {};
}

/** Exposes the private abort controller through a subclass (TS private is erased at runtime). */
class ConsoleRunner extends ProjectRunner {
	stopDispatch() {
		this.controller?.abort();
		this.wake();
		return this.runPromise?.catch(() => {}) ?? Promise.resolve();
	}
}

/** Goal creation templates: validated task/execution pairs over the configured checks. */
function templates(config) {
	const role = config.role.id;
	const modelId = preferredModelId(config);
	const checks = (config.project?.checks ?? []).map((check) => check.id);
	const execution = (instructions) => ({ instructions, modelId, roleId: role, checkIds: checks });
	const task = (id, title, dependsOn = [], writeScopes = ["."]) => ({
		id,
		title,
		dependsOn,
		writeScopes,
		capabilities: [],
		acceptance: [`All configured checks pass for ${title}`],
		priority: 5,
		retrySafe: true,
	});
	return {
		single: {
			label: "Single task",
			description: "One implementation task covering the whole repository.",
			tasks: [
				{
					task: task("impl", "Implement objective"),
					execution: execution(
						"Implement the stated objective completely and carefully. Work scoped to the permitted write scopes. Run the validation checks before declaring completion.",
					),
				},
			],
		},
		staged: {
			label: "Staged: implement then harden",
			description: "Two sequential tasks: implementation, then review/hardening pass.",
			tasks: [
				{
					task: task("impl", "Implement objective"),
					execution: execution(
						"Implement the stated objective. Keep the change focused; defer polish to the next stage.",
					),
				},
				{
					task: task("harden", "Review and harden", ["impl"]),
					execution: execution(
						"Review the implementation from the previous task, fix defects, close gaps against the acceptance criteria, and harden edge cases.",
					),
				},
			],
		},
		survey: {
			label: "Survey then implement",
			description: "Read-only survey task, then implementation using the survey as dependency.",
			tasks: [
				{
					task: task("survey", "Survey codebase", [], ["."]),
					execution: execution(
						"Survey the repository relevant to the objective. Produce a concise findings summary the next task can rely on. Do not modify files unless a check requires artifacts.",
					),
				},
				{
					task: task("impl", "Implement objective", ["survey"]),
					execution: execution(
						"Implement the stated objective using the survey findings from the dependency task.",
					),
				},
			],
		},
	};
}

export function preferredModelId(config) {
	const models = config.models;
	if (!models) return "";
	const target = models.targets.find((item) => item.id === models.preferred && item.enabled !== false);
	return (target ?? models.targets.find((item) => item.enabled !== false) ?? models.targets[0])?.id ?? "";
}

/**
 * Owns the coordinator, workspaces and (optionally) a ProjectRunner instance.
 * Browser disconnects never stop dispatch: the runner keeps running until stopped explicitly.
 */
export function createConsoleBridge({ onChange }) {
	const { config, path: configPath } = readRuntimeConfig();
	const stateDir = config.stateDirectory;
	const store = new FileStateStore(join(stateDir, "coordinator.json"), emptyProject(config.projectId));
	const limits = () => ({
		maxConcurrent: config.project?.maxConcurrent ?? 1,
		maxAttempts: 3,
		reviewSlots: config.project?.reviewSlots,
	});
	let coordinator = new ProjectCoordinator(store, limits(), config.project?.maxTasks ?? 100);
	const workspaces = new Workspaces(config.project.repository, config.project.worktreeRoot);
	const runnerState = { runner: null, startedAt: 0, stopping: false };
	let broadcastQueued = false;
	coordinator.onChange(() => queueBroadcast());

	function queueBroadcast() {
		// Wake-driven push, debounced; the 2s poll in protocol.mjs is the fallback.
		if (broadcastQueued) return;
		broadcastQueued = true;
		setTimeout(() => {
			broadcastQueued = false;
			onChange?.();
		}, 300);
	}

	function runtimeEntry() {
		return resolve(
			process.env.PI861_RUNTIME_ENTRY ?? join(dirname(new URL(import.meta.url).pathname), "../../pi861/runtime.ts"),
		);
	}

	/** Mirrors runtime.ts buildRunner: local pi RPC workers + reused integration workspace. */
	async function buildRunner() {
		const project = config.project;
		const integrationFile = join(stateDir, "integration.json");
		let integration;
		if (existsSync(integrationFile)) {
			const recorded = JSON.parse(readFileSync(integrationFile, "utf8"));
			if (recorded?.path && existsSync(recorded.path)) integration = recorded;
		}
		if (!integration) {
			integration = await workspaces.create(`integration-${randomUUID()}`, 1, await workspaces.head());
			writeFileSync(integrationFile, JSON.stringify(integration), { mode: 0o600 });
		}
		const localWorkers = Array.from({ length: project.maxConcurrent ?? 1 }, (_, index) => ({
			identity: {
				id: `local-${index}`,
				capabilities: config.environment ?? [],
				roleIds: [config.role, ...(config.roles ?? [])].map((role) => role.id),
				modelIds: config.models?.targets.map((target) => target.id) ?? [],
			},
			waitForSettled: true,
			process: (workspace, execution) => ({
				command: process.execPath,
				args: [
					project.cli,
					"--mode",
					"rpc",
					"--no-skills",
					"--no-extensions",
					...(project.workerExtensionPaths ?? []).flatMap((ext) => ["-e", resolve(ext)]),
					"-e",
					runtimeEntry(),
					"--session-dir",
					join(stateDir, "sessions"),
				],
				cwd: workspace.path,
				env: {
					...project.workerEnv,
					PI861_CONFIG: process.env.PI861_CONFIG ?? "",
					PI861_WORKER: "1",
					PI861_INITIAL_MODEL_ID: execution.modelId,
					PI861_ROLE_ID: execution.roleId,
					PI861_WRITE_SCOPES: JSON.stringify(execution.writeScopes ?? []),
				},
			}),
		}));
		const runner = new ConsoleRunner({
			coordinator,
			workspaces,
			integration,
			checks: project.checks ?? [],
			workers: localWorkers,
			onProgress: (event) => onChange?.(event),
		});
		return runner;
	}

	const bridge = {
		config,
		configPath,
		stateDir,
		templates: templates(config),
		readAgentModels: () => readAgentModels(config),
		async snapshot() {
			const state = await coordinator.state();
			const [accounting, usage, budget] = await Promise.all([
				coordinator.accounting().catch(() => null),
				readJsonCatch(join(stateDir, "usage.json")),
				readJsonCatch(join(stateDir, "budget.json")),
			]);
			const agentModels = readAgentModels(config);
			return {
				updatedAt: new Date().toISOString(),
				goal: {
					id: state.id,
					objective: state.objective,
					status: state.status,
					baseCommit: state.baseCommit,
					boardVersion: state.board.version,
					planOpen: state.planOpen ?? false,
					reason: state.reason ?? null,
					goalId: state.goalId ?? null,
				},
				tasks: state.board.tasks.map((task) => ({
					id: task.id,
					title: task.title,
					status: task.status,
					attempts: task.attempts,
					dependsOn: task.dependsOn,
					writeScopes: task.writeScopes,
					capabilities: task.capabilities,
					acceptance: task.acceptance,
					priority: task.priority ?? 5,
					workerId: task.lease?.workerId ?? null,
					leaseUntil: task.leaseUntil ?? null,
					reason: task.reason ?? null,
					evidenceCount: (task.evidence ?? []).length,
					execution: state.execution[task.id] ?? null,
				})),
				team: state.team?.members ?? [],
				integration: state.integration
					? {
							holder: state.integration.holder,
							generation: state.integration.generation,
							expiresAt: state.integration.expiresAt,
						}
					: null,
				integrationFailures: (state.integrationFailures ?? []).filter((entry) => entry.status === "open"),
				accounting,
				models: {
					preferred: config.models?.preferred ?? null,
					targets: (config.models?.targets ?? []).map((target) => ({
						id: target.id,
						provider: target.provider,
						model: target.model,
						quality: target.quality ?? null,
						costRank: target.costRank ?? null,
						contextWindow: target.contextWindow ?? null,
						enabled: target.enabled !== false,
						billing: target.billing ?? null,
					})),
					agentModels,
				},
				usage,
				budget,
				runner: {
					running: Boolean(runnerState.runner && runnerState.startedAt),
					startedAt: runnerState.startedAt || null,
					workers: config.project?.maxConcurrent ?? 1,
					checks: (config.project?.checks ?? []).map((check) => ({
						id: check.id,
						command: [check.command, ...(check.args ?? [])].join(" "),
					})),
				},
				project: {
					repository: config.project.repository,
					worktreeRoot: config.project.worktreeRoot,
					maxConcurrent: config.project.maxConcurrent ?? 1,
					reviewSlots: config.project.reviewSlots ?? null,
					maxTasks: config.project?.maxTasks ?? 100,
				},
			};
		},
		async goalCreate({ objective, templateId }) {
			const template = bridge.templates[templateId];
			if (!template) throw new Error(`Unknown template: ${templateId}`);
			if (!objective?.trim()) throw new Error("Objective text is required");
			const baseCommit = await workspaces.head();
			await coordinator.create(objective.trim(), baseCommit, structuredClone(template.tasks));
			return { objective: objective.trim(), tasks: template.tasks.length };
		},
		async goalControl(action) {
			if (action === "pause") {
				if (runnerState.runner) await runnerState.runner.pause();
				else await coordinator.control("pause");
				return { status: "paused" };
			}
			if (action === "resume") {
				if (runnerState.runner) await runnerState.runner.resume();
				else await coordinator.control("resume");
				return { status: "active" };
			}
			if (action === "accept") {
				await coordinator.control("accept");
				return { status: "completed" };
			}
			if (action === "cancel") {
				if (runnerState.runner) await runnerState.runner.pause().catch(() => {});
				await coordinator.control("cancel");
				return { status: "cancelled" };
			}
			throw new Error(`Unknown goal action: ${action}`);
		},
		async taskAppend({ expectedVersion, tasks }) {
			const role = config.role.id;
			const modelId = preferredModelId(config);
			const known = new Set((config.project?.checks ?? []).map((check) => check.id));
			const prepared = tasks.map((task, index) => {
				if (!task.title?.trim()) throw new Error(`Task ${index}: title required`);
				const id = task.id?.trim() || `task-${Date.now().toString(36)}-${index}`;
				const checkIds = task.checkIds?.length ? task.checkIds : (config.project?.checks ?? []).map((c) => c.id);
				if (!checkIds.length)
					throw new Error("Task needs at least one validation check (configure project.checks)");
				for (const check of checkIds) if (!known.has(check)) throw new Error(`Unknown check: ${check}`);
				return {
					task: {
						id,
						title: task.title.trim(),
						dependsOn: task.dependsOn ?? [],
						writeScopes: task.writeScopes?.length ? task.writeScopes : ["."],
						capabilities: task.capabilities ?? [],
						acceptance: task.acceptance?.length ? task.acceptance : [`Checks pass: ${checkIds.join(", ")}`],
						priority: task.priority ?? 5,
						retrySafe: true,
					},
					execution: {
						instructions: task.instructions?.trim() || `Implement: ${task.title.trim()}`,
						modelId: task.modelId || modelId,
						roleId: task.roleId || role,
						checkIds,
					},
				};
			});
			await coordinator.append(prepared, expectedVersion);
			return { appended: prepared.map((item) => item.task.id) };
		},
		async taskWithdraw({ expectedVersion, taskIds }) {
			await coordinator.withdraw(taskIds, expectedVersion);
			return { withdrawn: taskIds };
		},
		async taskUnblock({ taskId }) {
			await coordinator.unblock(taskId);
			return { taskId };
		},
		/** DAG edit on queued tasks: mutates within the store lock, revalidating via TaskBoard. */
		async taskEdit({ taskId, dependsOn, writeScopes }) {
			if (dependsOn === undefined && writeScopes === undefined) throw new Error("Nothing to edit");
			return store.update((state) => {
				const task = state.board.tasks.find((item) => item.id === taskId);
				if (!task) throw new Error(`Unknown task: ${taskId}`);
				if (task.status !== "queued") throw new Error("Only queued tasks can be edited");
				if (Array.isArray(dependsOn)) task.dependsOn = dependsOn;
				if (Array.isArray(writeScopes) && writeScopes.length) task.writeScopes = writeScopes;
				// Constructor runs full validation (duplicate deps, cycles, canonical scopes).
				new TaskBoard(limits(), state.board);
				return { taskId, dependsOn: task.dependsOn, writeScopes: task.writeScopes };
			});
		},
		async teamJoin(member) {
			if (!member?.id?.trim()) throw new Error("Agent id required");
			await coordinator.joinTeam({
				id: member.id.trim(),
				capabilities: member.capabilities ?? [],
				roleIds: member.roleIds?.length ? member.roleIds : [config.role.id],
				modelIds: member.modelIds?.length ? member.modelIds : (config.models?.targets.map((t) => t.id) ?? []),
				capacity: member.capacity ?? 1,
			});
			return { id: member.id.trim() };
		},
		async teamLeave({ agentId }) {
			await coordinator.leaveTeam(agentId);
			return { agentId };
		},
		async modelAssign({ agentId, primaryId, fallbackIds, recovery }) {
			if (!agentId?.trim()) throw new Error("Agent id required");
			if (primaryId) {
				const target = config.models?.targets.find((item) => item.id === primaryId);
				if (!target) throw new Error(`Unknown model target: ${primaryId}`);
			}
			config.console = { ...(config.console ?? {}), agentModels: { ...(readAgentModels(config) ?? {}) } };
			config.console.agentModels[agentId] = {
				primaryId: primaryId ?? null,
				fallbackIds: fallbackIds ?? [],
				recovery: recovery ?? { failover: false, failback: false },
			};
			writeConfigFile(configPath, config);
			return { agentId, assignment: config.console.agentModels[agentId] };
		},
		async modelControl({ targetId, enabled }) {
			const target = config.models?.targets.find((item) => item.id === targetId);
			if (!target) throw new Error(`Unknown model target: ${targetId}`);
			target.enabled = Boolean(enabled);
			writeConfigFile(configPath, config);
			return { targetId, enabled: target.enabled };
		},
		async settingsUpdate({ maxConcurrent, reviewSlots, maxTasks }) {
			const project = config.project ?? {};
			config.project = project;
			if (maxConcurrent !== undefined) {
				if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16)
					throw new Error("maxConcurrent must be an integer in [1,16]");
				project.maxConcurrent = maxConcurrent;
			}
			if (reviewSlots !== undefined) {
				if (!Number.isSafeInteger(reviewSlots) || reviewSlots < 0 || reviewSlots > 16)
					throw new Error("reviewSlots must be an integer in [0,16]");
				project.reviewSlots = reviewSlots;
			}
			if (maxTasks !== undefined) {
				if (!Number.isSafeInteger(maxTasks) || maxTasks < 1) throw new Error("maxTasks must be a positive integer");
				project.maxTasks = maxTasks;
			}
			writeConfigFile(configPath, config);
			// Coordinator instance carries limits; rebuild it so new values apply immediately.
			const previous = coordinator;
			coordinator = new ProjectCoordinator(store, limits(), config.project?.maxTasks ?? 100);
			coordinator.onChange(() => queueBroadcast());
			if (runnerState.runner) await previous.pause().catch(() => {});
			runnerState.runner = null;
			runnerState.startedAt = 0;
			return {
				maxConcurrent: project.maxConcurrent,
				reviewSlots: project.reviewSlots ?? null,
				maxTasks: project.maxTasks ?? 100,
			};
		},
		async runnerStart() {
			if (runnerState.runner && runnerState.startedAt) return { running: true, reused: true };
			runnerState.runner = await buildRunner();
			await runnerState.runner.start();
			runnerState.startedAt = Date.now();
			return { running: true };
		},
		async runnerStop() {
			const runner = runnerState.runner;
			if (!runner) return { running: false };
			// Stop dispatch without touching goal status: leases expire and a later
			// runner (console or runtime host) recovers the board.
			await runner.stopDispatch();
			runnerState.runner = null;
			runnerState.startedAt = 0;
			return { running: false };
		},
		runnerStatus() {
			return {
				running: Boolean(runnerState.runner && runnerState.startedAt),
				startedAt: runnerState.startedAt || null,
			};
		},
		/** Re-resolve config (tests hot-reload config edits made by other tools). */
		reloadConfig() {
			Object.assign(config, JSON.parse(readFileSync(configPath, "utf8")));
			return config;
		},
		async shutdown() {
			await bridge.runnerStop().catch(() => {});
		},
	};
	return bridge;
}

async function readJsonCatch(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}
