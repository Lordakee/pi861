import type { PiContext, PiHost } from "../../index.ts";
import { type Activation, authorizeInvocation, type Role, type ToolBinding } from "../capabilities.ts";
import { digest } from "../memory.ts";
import { record } from "../search.ts";
import { type DeploymentMode, enforceDeploymentMode, type McpClient, type McpTool } from "./mcp.ts";
import type { OperationJournal } from "./operations.ts";
import type { SkillRepository } from "./skill-repository.ts";

export interface CapabilityHost extends PiHost {
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}
export interface ResourceRule {
	toolId: string;
	accountId: string;
	resourceId: string;
	equals?: Record<string, unknown>;
	/** Explicit operator assertion: this dedicated endpoint already confines the resource. */
	endpointConfined?: boolean;
	/** Trusted classification, never copied from server annotations. */
	readOnly?: boolean;
}
export interface CapabilityOptions {
	repository: SkillRepository;
	role: () => Role;
	clients: McpClient[];
	environment: string[];
	resourceRules: ResourceRule[];
	baseTools?: string[];
	maxResultBytes?: number;
	operations?: OperationJournal;
	/** Deployment boundary (R5.11); defaults to trusted-local. */
	deploymentMode?: DeploymentMode;
	/** Runtime principal behind principal-owned controlled results (R6.7); Skill results authorize through the role alone. */
	principal?: () => { tenantId: string; principalId: string };
}
function requireText(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Nonempty string required");
	return value;
}
function array(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((part) => typeof part !== "string"))
		throw new Error("String array required");
	return value;
}
/** Full tool identity: service, account, resource and schema version together name one binding (R5.5). */
function bindingName(binding: ToolBinding): string {
	return `pi861_mcp_${digest([binding.toolId, binding.accountId, binding.resourceId, binding.schemaHash]).slice(0, 20)}`;
}

export function installCapabilities(pi: CapabilityHost, options: CapabilityOptions): { close(): void } {
	const mode = options.deploymentMode ?? "trusted-local";
	enforceDeploymentMode(
		mode,
		options.clients.map((client) => client.server),
	);
	if (mode === "production-isolated") {
		// An operator assertion cannot substitute argument confinement on a shared host.
		for (const rule of options.resourceRules)
			if (rule.endpointConfined)
				throw new Error(
					"Production-isolated mode requires explicit argument confinement (equals), not endpoint assertions",
				);
	}
	const activations = new Map<string, Activation>();
	const registered = new Set<string>();
	let initial: string[] = [];
	let initialized = false;
	let epoch = 0;
	let base: string[] = [];
	function initialize(): void {
		if (initialized) return;
		initial = pi.getActiveTools();
		base = options.baseTools ?? initial.filter((name) => !name.startsWith("mcp_") && !name.startsWith("pi861_mcp_"));
		initialized = true;
	}
	function refresh(): void {
		if (!initialized) return;
		const names = [...activations.values()].flatMap((activation) => activation.tools.map(bindingName));
		pi.setActiveTools([...new Set([...base, "pi861_capabilities", ...names])]);
	}
	function save(): void {
		pi.appendEntry(
			"pi861.capabilities.v2",
			[...activations.values()].map((value) => ({
				skillId: value.skillId,
				revision: value.skillRevision,
				branches: value.branchIds,
				phase: value.phase,
			})),
		);
	}
	async function describe(
		bindings: ToolBinding[],
		signal: AbortSignal,
	): Promise<{
		byBinding: Map<string, { client: McpClient; tool: McpTool }>;
		definitions: { id: string; schemaHash: string }[];
	}> {
		// Keyed by the full binding identity so the same tool bound to several resources cannot overwrite
		// its siblings' metadata (R5.5).
		const byBinding = new Map<string, { client: McpClient; tool: McpTool }>();
		const definitions = new Map<string, { id: string; schemaHash: string }>();
		for (const binding of bindings) {
			const client = options.clients.find(
				(client) =>
					binding.toolId.startsWith(`${client.server.id}/`) && binding.accountId === client.server.accountId,
			);
			if (!client) throw new Error("Authorized MCP endpoint is not configured");
			const name = binding.toolId.slice(client.server.id.length + 1);
			const tool = (await client.tools(signal)).find((tool) => tool.name === name);
			if (!tool || tool.schemaHash !== binding.schemaHash) throw new Error("MCP metadata changed; rebuild binding");
			byBinding.set(bindingName(binding), { client, tool });
			definitions.set(binding.toolId, { id: binding.toolId, schemaHash: tool.schemaHash });
		}
		return { byBinding, definitions: [...definitions.values()] };
	}
	function enforceResource(binding: ToolBinding, args: Record<string, unknown>): void {
		const rule = options.resourceRules.find(
			(rule) =>
				rule.toolId === binding.toolId &&
				rule.accountId === binding.accountId &&
				rule.resourceId === binding.resourceId,
		);
		if (!rule || (!rule.endpointConfined && !Object.keys(rule.equals ?? {}).length))
			throw new Error("Missing executable resource confinement policy");
		for (const [path, value] of Object.entries(rule.equals ?? {})) {
			if (path.split(".").some((key) => ["__proto__", "prototype", "constructor"].includes(key)))
				throw new Error("Unsafe resource selector");
			let actual: unknown = args;
			for (const key of path.split(".")) actual = record(actual)?.[key];
			if (actual === undefined || digest(actual) !== digest(value))
				throw new Error("Tool arguments exceed resource authorization");
		}
	}
	// Resolve planned bindings without bypassing the catalog's grant check. It exposes no original source text.
	async function load(
		id: string,
		revision: string,
		branches: string[],
		phase: string,
		signal: AbortSignal,
	): Promise<Activation> {
		initialize();
		const generation = epoch;
		const catalog = await options.repository.catalog();
		const planned = await options.repository.bindingPlan(
			id,
			revision,
			branches,
			phase,
			options.role(),
			options.environment,
		);
		const metadata = await describe(planned, signal);
		const activation = catalog.activate(
			options.role(),
			id,
			revision,
			branches,
			phase,
			options.environment,
			metadata.definitions,
		);
		if (generation !== epoch) throw new Error("Session changed during skill activation");
		for (const binding of activation.tools) {
			const entry = metadata.byBinding.get(bindingName(binding));
			if (!entry) throw new Error("Tool metadata missing");
			const name = bindingName(binding);
			registered.add(name);
			pi.registerTool({
				name,
				label: entry.tool.name,
				description: `${entry.tool.description}\nBound resource: ${binding.resourceId}. Use only for the activated Skill.`,
				parameters: entry.tool.inputSchema,
				execute: async (callId, args, inputSignal, _onUpdate, ctx) => {
					// R5.5: the same binding can back multiple activations; resolve any live holder instead of
					// pinning one skill's closure, so deactivating a sibling never breaks this tool.
					const current = [...activations.values()].find((candidate) =>
						candidate.tools.some((tool) => bindingName(tool) === name),
					);
					if (!current) throw new Error("Skill is no longer active");
					const effectiveSignal = inputSignal ?? new AbortController().signal;
					const available = await entry.client.tools(effectiveSignal, true);
					authorizeInvocation(
						current,
						options.role(),
						available.map((tool) => ({
							id: `${entry.client.server.id}/${tool.name}`,
							schemaHash: tool.schemaHash,
						})),
						binding,
					);
					enforceResource(binding, args);
					const dispatch = async () => {
						const response = await entry.client.call(entry.tool.name, args, binding.schemaHash, effectiveSignal);
						const serialized = JSON.stringify(response);
						const maxBytes = options.maxResultBytes ?? 32_000;
						if (Buffer.byteLength(serialized) > maxBytes) {
							const reference = await options.repository.storeResult(response, {
								owner: "skill",
								roleId: options.role().id,
								skillId: current.skillId,
								binding,
							});
							return {
								content: [
									{
										type: "text" as const,
										text: JSON.stringify({
											resultRef: reference,
											bytes: Buffer.byteLength(serialized),
											complete: false,
											instruction:
												"Use pi861_capabilities action=result to read pages. Do not treat this as the full result.",
										}),
									},
								],
								details: { reference },
							};
						}
						return {
							content: [{ type: "text" as const, text: serialized }],
							details: { toolId: binding.toolId },
							isError: record(response)?.isError === true,
						};
					};
					if (!options.operations) return dispatch();
					const rule = options.resourceRules.find(
						(rule) =>
							rule.toolId === binding.toolId &&
							rule.accountId === binding.accountId &&
							rule.resourceId === binding.resourceId,
					);
					return (await options.operations.run(
						{
							requestId: digest([ctx.sessionManager.getSessionId(), callId]),
							principal: options.role().id,
							resource: digest([binding.toolId, binding.accountId, binding.resourceId]),
							fingerprint: digest(args),
							readOnly: rule?.readOnly === true,
						},
						dispatch,
					)) as Awaited<ReturnType<typeof dispatch>>;
				},
			});
		}
		activations.set(id, activation);
		refresh();
		save();
		return activation;
	}
	pi.registerTool({
		name: "pi861_capabilities",
		label: "Skill capabilities",
		description:
			"Browse approved capabilities, inspect branch conditions, activate a published Skill phase, or read bounded runtime resources/results. Tool access is role-checked; source Skill packages are not auto-loaded.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["browse", "branches", "activate", "deactivate", "resource", "result"] },
				path: { type: "string" },
				skillId: { type: "string" },
				revision: { type: "string" },
				branches: { type: "array", items: { type: "string" } },
				phase: { type: "string" },
				sourceId: { type: "string" },
				resultRef: { type: "string" },
				offset: { type: "integer", minimum: 0 },
				pointer: {
					type: "string",
					description:
						"RFC 6901 pointer selecting a field of the result; empty or omitted reads the whole artifact",
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
		execute: async (_id, args, signal) => {
			const role = options.role();
			let value: unknown;
			if (args.action === "browse")
				value = await options.repository.browse(role, typeof args.path === "string" ? args.path : "");
			else if (args.action === "branches")
				value = (await options.repository.catalog()).branches(role, requireText(args.skillId));
			else if (args.action === "activate")
				value = await load(
					requireText(args.skillId),
					requireText(args.revision),
					array(args.branches),
					requireText(args.phase),
					signal ?? new AbortController().signal,
				);
			else if (args.action === "deactivate") {
				activations.delete(requireText(args.skillId));
				refresh();
				save();
				value = { deactivated: true };
			} else if (args.action === "resource") {
				const active = activations.get(requireText(args.skillId));
				if (!active) throw new Error("Activate the Skill before reading its runtime resources");
				const file = await options.repository.resource(
					active.skillId,
					active.skillRevision,
					requireText(args.sourceId),
					requireText(args.path),
					role,
				);
				const buffer = Buffer.from(file.base64, "base64"),
					offset = Number(args.offset ?? 0);
				if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length)
					throw new Error("Invalid resource offset");
				value = {
					path: file.path,
					content: buffer.subarray(offset, offset + 16_000).toString("utf8"),
					bytes: buffer.length,
					offset,
					nextOffset: Math.min(offset + 16_000, buffer.length),
					complete: offset + 16_000 >= buffer.length,
				};
			} else if (args.action === "result")
				value = await options.repository.readResult(
					requireText(args.resultRef),
					{ role, ...options.principal?.() },
					Number(args.offset ?? 0),
					typeof args.pointer === "string" ? args.pointer : "",
				);
			else throw new Error("Invalid capability action");
			return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
		},
	});
	pi.on("before_agent_start", async (raw) => {
		initialize();
		const event = record(raw),
			options = record(event?.systemPromptOptions);
		if (!options) throw new Error("Pi host does not support managed Skill prompt sections");
		options.skills = []; // Explicit /skill:name invocation still works; only passive discovery is replaced.
		const sections = record(options.sections);
		if (sections)
			sections.pi861_capabilities =
				"Use pi861_capabilities to browse role-scoped categories. Activate only relevant branches and phases. Original installed Skills are available only by explicit invocation.";
		refresh();
	});
	pi.on("tool_call", (raw) => {
		const event = record(raw);
		if (
			typeof event?.toolName === "string" &&
			registered.has(event.toolName) &&
			![...activations.values()].some((activation) =>
				activation.tools.some((tool) => bindingName(tool) === event.toolName),
			)
		)
			return { block: true, reason: "MCP capability is not active" };
		return undefined;
	});
	const restore = async (_raw: unknown, ctx: PiContext): Promise<void> => {
		initialize();
		epoch++;
		activations.clear();
		refresh();
		let saved: unknown;
		for (const value of ctx.sessionManager.getBranch()) {
			const entry = record(value);
			if (entry?.customType === "pi861.capabilities.v2") saved = entry.data;
		}
		if (!Array.isArray(saved)) return;
		for (const value of saved) {
			const item = record(value);
			if (!item) continue;
			try {
				await load(
					requireText(item.skillId),
					requireText(item.revision),
					array(item.branches),
					requireText(item.phase),
					new AbortController().signal,
				);
			} catch {
				ctx.ui.notify(
					"A previously active Skill could not be restored; check authorization and endpoint health",
					"warning",
				);
			}
		}
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("session_shutdown", () => {
		epoch++;
		activations.clear();
		options.clients.forEach((client) => {
			client.close();
		});
	});
	refresh();
	return {
		close() {
			epoch++;
			activations.clear();
			options.clients.forEach((client) => {
				client.close();
			});
			if (initialized) pi.setActiveTools(initial);
		},
	};
}
