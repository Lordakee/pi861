import { OperationJournal } from "./src/live/operations.ts";
import { guardWorkerTool } from "./src/live/worker-guard.ts";
/** Full runtime entry. Requires a user-selected PI861_CONFIG; never reads executable project config. */
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installPi861, type PiContext, type PiHost } from "./index.ts";
import { digest } from "./src/memory.ts";
import { record } from "./src/search.ts";
import { ModelFailure, type ModelTarget } from "./src/routing.ts";
import type { Role } from "./src/capabilities.ts";
import type { SqlPool } from "./src/postgres.ts";
import { FileStateStore, PostgresStateStore, type StateStore } from "./src/live/store.ts";
import { LayeredMemory, emptyLayeredMemory } from "./src/live/layered-memory.ts";
import { SkillRepository, emptySkillState } from "./src/live/skill-repository.ts";
import { McpClient, type McpServer } from "./src/live/mcp.ts";
import { installCapabilities, type CapabilityHost, type ResourceRule } from "./src/live/skills-host.ts";
import { ModelRuntime, type ModelPolicy, type ModelCheckpoint, RequestBudget } from "./src/live/model-runtime.ts";
import { memoryExtractor, projectPlan, routeClassifier, skillCompiler, type GenerateText } from "./src/live/compilers.ts";
import { ProjectCoordinator, emptyProject, type ExecutionSpec, type WorkerIdentity } from "./src/live/coordinator.ts";
import { RemoteWorkerClient } from "./src/live/remote-worker.ts";
import { ProjectRunner } from "./src/live/project-runner.ts";
import { Workspaces, type CheckCommand, type Workspace } from "./src/live/workspace.ts";
import { PiRpcSession } from "./src/live/pi-rpc.ts";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

interface RemoteWorkerEntry {
	identity: WorkerIdentity;
	url: string;
	tokenEnv: string;
	allowLoopbackHttp?: boolean;
}
interface ProjectConfig {
	repository: string;
	worktreeRoot: string;
	cli: string;
	maxConcurrent: number;
	maxTasks?: number;
	checks: CheckCommand[];
	plannerModelId: string;
	allowWorkerShell?: boolean;
	workerEnv?: Record<string, string>;
	workerExtensionPaths?: string[];
	remoteWorkers?: RemoteWorkerEntry[];
}
interface RuntimeConfig {
	version: 2;
	projectId: string;
	stateDirectory: string;
	tenantId?: string;
	agentId?: string;
	database?: { urlEnv: string; driverRoot?: string };
	role: Role;
	roles?: Role[];
	environment?: string[];
	mcp?: McpServer[];
	resourceRules?: ResourceRule[];
	models?: ModelPolicy & { intakeId: string; enableRouting?: boolean; maxOutputTokens?: number };
	memory?: { autoRecall?: boolean; autoCapture?: boolean; autoEnrich?: boolean; modelId?: string; maxJobsPerWake?: number };
	skills?: { compilerModelId?: string };
	project?: ProjectConfig;
	budget?: { maxRequests: number };
}
function configFromFile(): RuntimeConfig {
	const path = process.env.PI861_CONFIG;
	if (!path || !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) {
		throw new Error("Set PI861_CONFIG to an absolute trusted JSON configuration path");
	}
	const config = JSON.parse(readFileSync(path, "utf8")) as RuntimeConfig;
	if (config.version !== 2 || !/^[a-zA-Z0-9_-]+$/.test(config.projectId) || !config.stateDirectory || !config.role?.id) {
		throw new Error("Invalid Pi861 runtime configuration");
	}
	config.stateDirectory = resolve(config.stateDirectory);
	return config;
}
function bodyText(message: AssistantMessage): string {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function failure(message: AssistantMessage, status: number): ModelFailure {
	const text = message.errorMessage ?? "";
	if (message.stopReason === "aborted") return new ModelFailure("cancelled");
	if (status === 401 || status === 403) return new ModelFailure("auth");
	if (/insufficient_quota|billing|credit.*exhaust/i.test(text)) return new ModelFailure("quota");
	if (status === 429 || /rate.limit|too many requests/i.test(text)) return new ModelFailure("rate-limit");
	if (status >= 500 || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|connection.*closed|overloaded|network|stream.*(ended|closed)/i.test(text)) {
		return new ModelFailure("transient");
	}
	if (/context.*(length|window|limit)|too many tokens/i.test(text)) return new ModelFailure("context");
	return new ModelFailure("invalid");
}

/**
 * Events carried by the narrow structural port below. Names are validated at
 * registration time; handler signatures for the real host are checked by
 * tsconfig.host.json against the installed Pi package.
 */
type NarrowEventName = "session_start" | "session_tree" | "session_shutdown" | "input" |
	"before_agent_start" | "agent_end" | "agent_settled" | "tool_call";
const NARROW_EVENTS: ReadonlySet<string> = new Set([
	"session_start", "session_tree", "session_shutdown", "input", "before_agent_start", "agent_end", "agent_settled", "tool_call",
]);
type NarrowEventHandler = (event: unknown, context: PiContext) => unknown;

/**
 * Explicit adaptation from the real Pi host to the dependency-free narrow port.
 * The single cast below bridges Pi's typed event overloads; every concrete
 * handler is still type-checked against the real event shapes by the host
 * configs, and event names are validated instead of trusted.
 */
function hostPort(pi: ExtensionAPI): PiHost {
	const registerHostEvent = pi.on.bind(pi) as (name: NarrowEventName, handler: NarrowEventHandler) => void;
	return {
		on: (name, handler) => {
			if (!NARROW_EVENTS.has(name)) throw new Error(`Pi861 narrow host port does not carry event ${name}`);
			registerHostEvent(name as NarrowEventName, handler);
		},
		registerCommand: (name, command) => pi.registerCommand(name, command),
		registerTool: (tool) => pi.registerTool(tool),
		appendEntry: (type, data) => pi.appendEntry(type, data),
		sendUserMessage: (text, options) => pi.sendUserMessage(text, options),
		sendMessage: (message, options) => pi.sendMessage(message, options),
		events: pi.events,
	};
}
/** Capability port adds the tool activation surface the real host exposes directly. */
function capabilityPort(pi: ExtensionAPI): CapabilityHost {
	return {
		...hostPort(pi),
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names) => pi.setActiveTools(names),
	};
}

export default function runtimeExtension(pi: ExtensionAPI): void {
	// Fixed startup order: trusted config -> identity/storage -> budget/receipts ->
	// model service -> memory/capability services -> goal/worker; restore runs on session events.
	const config = configFromFile(), tenantId = config.tenantId ?? "local", scope = `project:${config.projectId}`;
	mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
	let pool: (SqlPool & { end(): Promise<void> }) | undefined;
	if (config.database) {
		const url = process.env[config.database.urlEnv];
		if (!url) throw new Error("Configured PostgreSQL credential environment variable is missing");
		const load = config.database.driverRoot ? createRequire(join(resolve(config.database.driverRoot), "package.json")) : require;
		const driver = load("pg") as { Pool: new (options: { connectionString: string; max: number; connectionTimeoutMillis: number }) => SqlPool & { end(): Promise<void> } };
		pool = new driver.Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000 });
	}
	function store<T>(name: string, initial: T): StateStore<T> {
		return pool ? new PostgresStateStore(pool, tenantId, `${config.projectId}:${name}`, initial) : new FileStateStore(join(config.stateDirectory, `${name}.json`), initial);
	}
	const memory = new LayeredMemory(store("memory", emptyLayeredMemory(tenantId)), {
		tenantId, principalId: config.agentId ?? "main", readScopes: [scope], writeScopes: [scope],
	});
	const repository = new SkillRepository(store("skills", emptySkillState()));
	const operations = new OperationJournal(store("operations", { receipts: {} }));
	function currentRole(): Role {
		const current = configFromFile();
		const requested = process.env.PI861_ROLE_ID ?? current.role.id;
		const found = [current.role, ...(current.roles ?? [])].find((role) => role.id === requested);
		if (!found) throw new Error("Agent role has been revoked");
		return found;
	}
	const budget = new RequestBudget(store("budget", { limit: config.budget?.maxRequests ?? 1000, used: 0, intents: {} }));
	const workerMode = process.env.PI861_WORKER === "1";
	// One Pi861 owner per host: installPi861 refuses a second composition on the same host generation.
	installPi861(hostPort(pi), {
		memory: { backend: memory, scope, autoCapture: config.memory?.autoCapture, autoRecall: config.memory?.autoRecall },
		managedGoal: Boolean(config.project && !workerMode),
	});
	const clients = (config.mcp ?? []).map((server) => new McpClient(server));
	let context: ExtensionContext | undefined;
	let modelRuntime: ModelRuntime<{ transcript: Context; options?: ModelsSimpleStreamOptions }, AssistantMessage> | undefined;
	let enrichment: Promise<unknown> | undefined;
	let projectRunner: ProjectRunner | undefined;
	let wakeController = new AbortController();
	const coordinator = new ProjectCoordinator(store("project", emptyProject(config.projectId)), { maxConcurrent: config.project?.maxConcurrent ?? 2, maxAttempts: 2 }, config.project?.maxTasks ?? 100);

	function target(id: string): ModelTarget {
		const found = config.models?.targets.find((target) => target.id === id && target.enabled);
		if (!found) throw new Error("Configured model target is unavailable");
		return found;
	}
	async function direct(
		selected: ModelTarget, transcript: Context, signal: AbortSignal, maxTokens = 4096,
		requestOptions?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> {
		if (!context) throw new Error("Pi context is not initialized");
		const model = context.modelRegistry.find(selected.provider, selected.model);
		if (!model || model.provider === "pi861-runtime") throw new ModelFailure("invalid");
		// A conservative text-size gate prevents silently routing oversized context to a small model.
		const textSize = Buffer.byteLength(JSON.stringify(transcript));
		if (textSize > selected.contextWindow * 3) throw new ModelFailure("context");
		await budget.reserve(randomUUID());
		let status = 200;
		const stream = context.modelRegistry.streamSimple(model, transcript, {
			...requestOptions, signal, maxTokens: Math.min(maxTokens, model.maxTokens),
			onResponse: async (response, requestModel) => {
				status = response.status;
				await requestOptions?.onResponse?.(response, requestModel);
			},
		});
		let terminal: AssistantMessage | undefined;
		for await (const event of stream) {
			if (event.type === "done") terminal = event.message;
			if (event.type === "error") terminal = event.error;
		}
		if (!terminal) throw new ModelFailure("transient");
		if (terminal.stopReason === "error" || terminal.stopReason === "aborted") throw failure(terminal, status);
		signal.throwIfAborted();
		return terminal;
	}
	function generator(id: string): GenerateText {
		return async (prompt, signal) => bodyText(await direct(target(id), {
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		}, signal, 8192));
	}
	const initialize = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		context = ctx;
		wakeController.abort();
		wakeController = new AbortController();
		modelRuntime?.close();
		if (config.models) {
			const selected = process.env.PI861_INITIAL_MODEL_ID;
			const policy = selected
				? {
					...config.models, preferred: target(selected).id,
					requirements: { ...config.models.requirements, minQuality: Math.max(config.models.requirements.minQuality, target(selected).quality) },
				}
				: config.models;
			modelRuntime = new ModelRuntime<{ transcript: Context; options?: ModelsSimpleStreamOptions }, AssistantMessage>(
				policy,
				(model, request, signal) => direct(model, request.transcript, signal, policy.maxOutputTokens ?? 8192, request.options),
				async (model, signal) => bodyText(await direct(model, {
					messages: [{ role: "user", content: "Reply exactly OK. This is a health probe, do not call tools.", timestamp: Date.now() }],
				}, signal, 32)).trim() === "OK",
				policy.enableRouting === false ? undefined : routeClassifier(generator(policy.intakeId)),
				(state, checkpoint) => {
					pi.appendEntry("pi861.model-runtime.v2", { ...state, checkpoint });
					ctx.ui.setStatus("pi861-model", `${state.mode}:${state.active}${state.active !== state.preferred ? ` (preferred ${state.preferred})` : ""}`);
				},
			);
			const saved = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === "pi861.model-runtime.v2");
			if (saved?.type === "custom") {
				const checkpoint = record(saved.data)?.checkpoint;
				if (checkpoint) modelRuntime.restore(checkpoint as ModelCheckpoint);
			}
			const wrapper = ctx.modelRegistry.find("pi861-runtime", "managed");
			if (wrapper && ctx.isIdle()) await pi.setModel(wrapper);
		}
	};
	pi.on("session_start", initialize);
	pi.on("session_tree", initialize);
	if (config.models) {
		pi.registerProvider("pi861-runtime", {
			baseUrl: "http://127.0.0.1/unused-pi861-route", api: "openai-completions", apiKey: "local-routing-no-remote-credential",
			models: [{
				id: "managed", name: "Pi861 managed model", reasoning: false, input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: Math.max(...config.models.targets.map((target) => target.contextWindow)),
				maxTokens: config.models.maxOutputTokens ?? 8192,
			}],
			streamSimple: (_model, transcript, options) => {
				const output = createAssistantMessageEventStream();
				void (async () => {
					try {
						if (!modelRuntime) throw new Error("Model runtime not initialized");
						const message = await modelRuntime.call({ transcript, options }, options?.signal ?? new AbortController().signal);
						if (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") {
							throw new Error("Managed model returned an unresolved stop reason");
						}
						output.push({ type: "start", partial: message });
						output.push({ type: "done", reason: message.stopReason, message });
					} catch (error) {
						const reason = options?.signal?.aborted ? "aborted" : "error";
						const message: AssistantMessage = {
							role: "assistant", content: [], api: "openai-completions", provider: "pi861-runtime", model: "managed",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
							stopReason: reason, timestamp: Date.now(),
							errorMessage: error instanceof ModelFailure ? error.message : "Pi861 request stopped; inspect runtime state",
						};
						output.push({ type: "error", reason, error: message });
					}
				})();
				return output;
			},
		});
		pi.on("before_agent_start", (event) => { modelRuntime?.setTask(event.prompt); });
		pi.registerTool({
			name: "pi861_model_route", label: "Model capability signal",
			description: "Report a concrete capability gap, changed scope, failed verification, or completed phase. The runtime changes models only at the next safe request boundary.",
			parameters: {
				type: "object",
				properties: {
					reason: { type: "string", minLength: 1 },
					signal: { type: "string", enum: ["capability_gap", "scope_changed", "verification_failed", "phase_complete"] },
				},
				required: ["reason", "signal"], additionalProperties: false,
			},
			execute: async (_id, input) => {
				const value = record(input);
				const reason = value?.reason;
				const signal = value?.signal;
				if (typeof reason !== "string" || !reason.trim() ||
					!["capability_gap", "scope_changed", "verification_failed", "phase_complete"].includes(String(signal))) {
					throw new Error("Model route report requires a reason and a known signal");
				}
				modelRuntime?.report(signal as "capability_gap" | "scope_changed" | "verification_failed" | "phase_complete");
				return { content: [{ type: "text", text: "Recorded; route policy is evaluated before the next model request." }], details: {} };
			},
		});
		pi.registerCommand("model-policy", {
			description: "status | failover on/off | failback on/off | escalate",
			handler: async (args, ctx) => {
				const [key, value] = args.trim().split(/\s+/);
				if (key === "failover" || key === "failback") {
					if (!["on", "off"].includes(value ?? "")) throw new Error("Use on or off");
					modelRuntime?.setRecoveryOptions(key === "failover" ? { failoverEnabled: value === "on" } : { failbackEnabled: value === "on" });
				} else if (key === "escalate") modelRuntime?.report("capability_gap");
				ctx.ui.notify(JSON.stringify(modelRuntime?.state ?? { enabled: false }), "info");
			},
		});
	}
	function enrich(): void {
		const id = config.memory?.modelId;
		if (!config.memory?.autoEnrich || !id || enrichment || !context) return;
		enrichment = memory.enrich(memoryExtractor(id, generator(id)), { signal: wakeController.signal, maxJobs: config.memory.maxJobsPerWake ?? 2 })
			.catch(() => { context?.ui.notify("Memory enrichment failed; canonical records are retained", "warning"); })
			.finally(() => { enrichment = undefined; });
	}
	pi.on("agent_settled", (_event, ctx) => {
		const last = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
		const message = last?.type === "message" ? last.message : undefined;
		const outcome = message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted") ? message.stopReason : "ok";
		pi.appendEntry("pi861.run-settled.v2", { outcome, timestamp: Date.now() });
		enrich();
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (config.memory?.autoCapture === false || event.toolName.startsWith("pi861_memory") || event.toolName === "pi861_capabilities") return;
		const full = JSON.stringify({ tool: event.toolName, result: event.result, isError: event.isError });
		if (full.length > 64_000 || /(?:sk-|ghp_|github_pat_|Bearer\s)[A-Za-z0-9._-]{12,}|password\s*[:=]/i.test(full)) return;
		const id = digest([ctx.sessionManager.getSessionId(), event.toolCallId]);
		await memory.put({
			requestId: id,
			expectedRevision: null,
			item: {
				id, scope, kind: "evidence", status: "candidate", full,
				abstract: `Tool result: ${event.toolName}`,
				overview: full.slice(0, 1000),
				source: { kind: "tool", ref: `pi-session:${ctx.sessionManager.getSessionId()}/tool:${event.toolCallId}` },
			},
		});
	});
	pi.registerCommand("memory-maintain", {
		description: "Process a bounded batch of memory enrichment jobs",
		handler: async (_args, ctx) => {
			const id = config.memory?.modelId;
			if (!id) throw new Error("Configure memory.modelId");
			const outcome = await memory.enrich(memoryExtractor(id, generator(id)), { signal: wakeController.signal, maxJobs: config.memory?.maxJobsPerWake ?? 2 });
			ctx.ui.notify(JSON.stringify(outcome), "info");
		},
	});
	pi.registerCommand("mcp", {
		description: "refresh SERVER: discover metadata and publish its deterministic resource-bound Skill",
		handler: async (args, ctx) => {
			const [verb, serverId, ...details] = args.trim().split(/\s+/);
			if (verb === "operations") { ctx.ui.notify(JSON.stringify(await operations.list(currentRole().id)), "info"); return; }
			if (verb === "resolve" && serverId) {
				await operations.resolve(currentRole().id, serverId, details.join(" "));
				ctx.ui.notify("Reconciliation recorded; a new explicitly intended operation may now run", "info");
				return;
			}
			if (verb !== "refresh" || !serverId) {
				ctx.ui.notify(JSON.stringify(clients.map((client) => ({ id: client.server.id, account: client.server.accountId }))), "info");
				return;
			}
			const client = clients.find((client) => client.server.id === serverId);
			if (!client) throw new Error("Configured MCP server not found");
			const tools = await client.tools(wakeController.signal, true);
			const bindings = (config.resourceRules ?? [])
				.filter((rule) => rule.toolId.startsWith(`${serverId}/`) && rule.accountId === client.server.accountId)
				.map((rule) => {
					const tool = tools.find((tool) => `${serverId}/${tool.name}` === rule.toolId);
					if (!tool) throw new Error("Resource rule refers to a missing MCP tool");
					return { toolId: rule.toolId, accountId: rule.accountId, resourceId: rule.resourceId, schemaHash: tool.schemaHash, phase: "execute" };
				});
			const id = await repository.publishMcp(serverId, client.server.accountId, tools, bindings);
			ctx.ui.notify(`Published ${id}. Only authorized branches appear in the role view; tools remain inactive until Skill activation.`, "info");
		},
	});
	pi.registerCommand("skills", {
		description: "install PATH ID GROUP | compile GROUP | publish CANDIDATE | browse | rollback ID REVISION",
		handler: async (args, ctx) => {
			const [action, ...parts] = args.trim().split(/\s+/);
			if (action === "install") {
				const [path, id, group] = parts;
				if (!path || !id || !group) throw new Error("Usage: /skills install PATH ID GROUP (use JSON config for paths containing spaces)");
				const revision = "auto";
				const source = await repository.install(path, { id, group, revision });
				ctx.ui.notify(`Archived ${source.id}@${source.revision}`, "info");
				if (config.skills?.compilerModelId) {
					const candidate = await repository.compile(group, skillCompiler(generator(config.skills.compilerModelId)), wakeController.signal);
					ctx.ui.notify(`Compiled candidate ${candidate.id}; validate and /skills publish before use`, "info");
				}
			} else if (action === "compile") {
				const model = config.skills?.compilerModelId;
				if (!model || !parts[0]) throw new Error("Configure compilerModelId and specify a group");
				ctx.ui.notify(JSON.stringify(await repository.compile(parts[0], skillCompiler(generator(model)), wakeController.signal)), "info");
			} else if (action === "publish") {
				if (!parts[0] || !ctx.hasUI || !await ctx.ui.confirm("Publish Skill candidate", "Confirm you reviewed applicability, constraints and tool bindings. This publishes a new runtime version.")) return;
				await repository.publish(parts[0], async () => ({ passed: true, evidence: [`user-reviewed:${Date.now()}`] }));
				ctx.ui.notify("Published reviewed runtime Skill", "info");
			} else if (action === "rollback") {
				if (!parts[0] || !parts[1]) throw new Error("Specify ID and revision");
				await repository.rollback(parts[0], parts[1]);
			} else ctx.ui.notify(JSON.stringify(await repository.browse(currentRole(), parts[0] ?? "")), "info");
		},
	});
	if (workerMode) {
		const parsed = JSON.parse(process.env.PI861_WRITE_SCOPES ?? "[]") as unknown;
		if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error("Invalid worker write scopes");
		const writeScopes = parsed as string[];
		pi.on("tool_call", (event, ctx) => {
			try {
				guardWorkerTool({ root: ctx.cwd, writeScopes, allowShell: config.project?.allowWorkerShell === true }, event.toolName, event.input as Record<string, unknown>);
			} catch (error) { return { block: true, reason: error instanceof Error ? error.message : "Worker tool blocked" }; }
			return undefined;
		});
	}
	const capabilities = installCapabilities(capabilityPort(pi), {
		repository, role: currentRole, clients,
		environment: config.environment ?? [], resourceRules: config.resourceRules ?? [], operations,
		baseTools: workerMode && !config.project?.allowWorkerShell
			? ["read", "write", "edit", "grep", "find", "ls", "pi861_memory", "pi861_model_route"]
			: undefined,
	});
	if (config.project && !workerMode) {
		pi.registerCommand("goal", {
			description: "Create a planned parallel project goal; status | pause | resume | accept | clear",
			handler: async (args, ctx) => {
				const project = config.project;
				if (!project) return;
				const input = args.trim();
				if (!input || input === "status") { ctx.ui.notify(JSON.stringify(await coordinator.state()), "info"); return; }
				if (input === "pause") { if (projectRunner) await projectRunner.pause(); else await coordinator.control("pause"); return; }
				if (input === "accept") { await coordinator.control("accept"); return; }
				if (input === "clear") { if (projectRunner) await projectRunner.pause(); await coordinator.control("cancel"); return; }
				const workspaces = new Workspaces(project.repository, project.worktreeRoot);
				if (input !== "resume") {
					const base = await workspaces.head();
					// Read-only Pi planner inspects real source files; its tools exclude shell and writes.
					const planner = target(project.plannerModelId);
					const plannerSession = new PiRpcSession({
						command: process.execPath,
						args: [
							project.cli, "--mode", "rpc", "--no-session", "--no-extensions",
							...((project.workerExtensionPaths ?? []).flatMap((path) => ["-e", resolve(path)])),
							"--no-skills", "--tools", "read,grep,find,ls", "--provider", planner.provider, "--model", planner.model,
						],
						cwd: project.repository, env: project.workerEnv,
					});
					let facts: string;
					try {
						facts = (await plannerSession.prompt(
							`Inspect relevant existing source files for this requested goal. Do not modify anything. Report actual architecture, reusable modules and interface boundaries, with paths. Goal: ${input}`,
							wakeController.signal,
						)).text;
					} finally { await plannerSession.close(); }
					const tasks = await projectPlan(
						input, facts,
						config.models?.targets.filter((target) => target.enabled).map((target) => target.id) ?? [],
						[config.role, ...(config.roles ?? [])].map((role) => role.id),
						project.checks.map((check) => check.id),
						generator(project.plannerModelId), wakeController.signal,
					);
					await coordinator.create(input, base, tasks);
				} else await coordinator.control("resume");
				const state = await coordinator.state();
				const integrationFile = join(config.stateDirectory, "integration.json");
				const integration = input === "resume" && existsSync(integrationFile)
					? JSON.parse(readFileSync(integrationFile, "utf8")) as Awaited<ReturnType<Workspaces["create"]>>
					: await workspaces.create(`integration-${randomUUID()}`, 1, state.baseCommit);
				writeFileSync(integrationFile, JSON.stringify(integration), { mode: 0o600 });
				const runtimeEntry = resolve(process.env.PI861_RUNTIME_ENTRY ?? join(dirname(fileURLToPath(import.meta.url)), "runtime.ts"));
				const localWorkers = Array.from({ length: project.maxConcurrent }, (_, index) => ({
					identity: {
						id: `local-${index}`,
						capabilities: config.environment ?? [],
						roleIds: [config.role, ...(config.roles ?? [])].map((role) => role.id),
						modelIds: config.models?.targets.map((target) => target.id) ?? [],
					},
					waitForSettled: true,
					process: (workspace: Workspace, execution: ExecutionSpec) => ({
						command: process.execPath,
						args: [
							project.cli, "--mode", "rpc", "--no-skills", "--no-extensions",
							...((project.workerExtensionPaths ?? []).flatMap((path) => ["-e", resolve(path)])),
							"-e", runtimeEntry,
							"--session-dir", join(config.stateDirectory, "sessions"),
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
				const remoteWorkers = (project.remoteWorkers ?? []).map((worker) => {
					const token = process.env[worker.tokenEnv];
					if (!token) throw new Error("Remote worker credential missing");
					return { identity: worker.identity, remote: new RemoteWorkerClient({ url: worker.url, token, allowLoopbackHttp: worker.allowLoopbackHttp }) };
				});
				projectRunner = new ProjectRunner({
					coordinator, workspaces, integration, checks: project.checks,
					workers: [...localWorkers, ...remoteWorkers],
					onProgress: (event) => {
						pi.sendMessage({ customType: "pi861.project-progress", content: JSON.stringify(event), display: true }, { triggerTurn: false });
					},
				});
				void projectRunner.start()
					.then(async () => { ctx.ui.notify(`Project execution settled: ${(await coordinator.state()).status}`, "info"); })
					.catch(() => ctx.ui.notify("Project scheduler failed; inspect durable state", "error"));
				ctx.ui.notify(`Started ${project.maxConcurrent} worker slots; only ready non-conflicting tasks will run`, "info");
			},
		});
		pi.on("input", async (event) => {
			if (event.source === "interactive" || event.source === "rpc") {
				if ((await coordinator.state()).status === "active") await projectRunner?.pause();
			}
		});
	}
	pi.on("session_shutdown", async () => {
		// Stop dispatch and cancel owned work first, await controlled convergence,
		// then close MCP clients and the database pool last.
		wakeController.abort();
		modelRuntime?.close();
		await projectRunner?.pause();
		await enrichment;
		capabilities.close();
		await pool?.end();
	});
}
