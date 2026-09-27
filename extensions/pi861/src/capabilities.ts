import { digest } from "./memory.ts";

export interface RawSkill {
	id: string;
	revision: string;
	files: Record<string, string>;
}
export interface ToolBinding {
	toolId: string;
	accountId: string;
	resourceId: string;
	schemaHash: string;
	phase: string;
}
export interface SkillBranch {
	id: string;
	when: string;
	instructions: string;
	environment: string[];
	conflictsWith: string[];
	tools: ToolBinding[];
}
export interface RuntimeSkill {
	id: string;
	revision: string;
	title: string;
	category: string;
	instructions: string;
	sources: { id: string; revision: string; hash: string }[];
	branches: SkillBranch[];
}
export interface Role {
	id: string;
	skillIds: string[];
	grants: { toolId: string; accountId: string; resourceIds: string[] }[];
}
export interface ToolDefinition {
	id: string;
	schemaHash: string;
}
export interface Activation {
	skillId: string;
	skillRevision: string;
	branchIds: string[];
	phase: string;
	instructions: string;
	tools: ToolBinding[];
}
function granted(role: Role, binding: ToolBinding): boolean {
	return role.grants.some(
		(grant) =>
			grant.toolId === binding.toolId &&
			grant.accountId === binding.accountId &&
			grant.resourceIds.includes(binding.resourceId),
	);
}

/**
 * Repository-neutral capability catalog. It never runs source scripts.
 * publish() is an operator/validator entry point, not an agent-callable tool.
 */
export class SkillCatalog {
	private readonly originals = new Map<string, RawSkill>();
	private readonly published = new Map<string, RuntimeSkill>();
	private readonly versions = new Map<string, RuntimeSkill>();
	private readonly revoked = new Set<string>();
	archive(raw: RawSkill): string {
		if (!raw.id || !raw.revision || typeof raw.files["SKILL.md"] !== "string")
			throw new Error("Missing skill source");
		for (const path of Object.keys(raw.files)) {
			if (
				path.startsWith("/") ||
				path.includes("\\") ||
				path.includes(":") ||
				path.split("/").some((part) => part === ".." || part === "." || !part)
			)
				throw new Error("Unsafe source path");
		}
		const key = JSON.stringify([raw.id, raw.revision]);
		const existing = this.originals.get(key);
		if (existing && digest(existing) !== digest(raw)) throw new Error("Original skill versions are immutable");
		this.originals.set(key, structuredClone(raw));
		return digest(raw);
	}
	/** Explicit access only; original skills are never returned by browse(). */
	readOriginal(id: string, revision: string): RawSkill | undefined {
		const source = this.originals.get(JSON.stringify([id, revision]));
		return source ? structuredClone(source) : undefined;
	}
	publish(skill: RuntimeSkill): void {
		if (
			!skill.id ||
			!skill.revision ||
			!skill.instructions.trim() ||
			!skill.sources.length ||
			!skill.branches.length ||
			new Set(skill.branches.map((branch) => branch.id)).size !== skill.branches.length
		) {
			throw new Error("Invalid runtime skill");
		}
		for (const source of skill.sources) {
			const raw = this.originals.get(JSON.stringify([source.id, source.revision]));
			if (!raw || digest(raw) !== source.hash) throw new Error("Unverified or changed skill source");
		}
		for (const branch of skill.branches) {
			if (!branch.id || !branch.when.trim() || !branch.instructions.trim())
				throw new Error("Missing branch selection rules");
			if (branch.conflictsWith.some((id) => id === branch.id || !skill.branches.some((other) => other.id === id))) {
				throw new Error("Invalid branch conflict");
			}
			for (const tool of branch.tools) {
				if (!tool.toolId || !tool.accountId || !tool.resourceId || !tool.schemaHash || !tool.phase) {
					throw new Error("Incomplete tool binding");
				}
			}
		}
		const key = JSON.stringify([skill.id, skill.revision]);
		const existing = this.versions.get(key);
		if (existing && digest(existing) !== digest(skill)) throw new Error("Published versions are immutable");
		this.versions.set(key, structuredClone(skill));
		this.published.set(skill.id, structuredClone(skill));
	}
	browse(role: Role, category?: string): { id: string; revision: string; title: string; category: string }[] {
		return [...this.published.values()]
			.filter((skill) => role.skillIds.includes(skill.id) && (category === undefined || skill.category === category))
			.map(({ id, revision, title, category: group }) => ({ id, revision, title, category: group }));
	}
	branches(role: Role, skillId: string): { id: string; when: string; environment: string[] }[] {
		if (!role.skillIds.includes(skillId)) throw new Error("Skill not available");
		const skill = this.published.get(skillId);
		if (!skill) throw new Error("Skill not available");
		return skill.branches
			.filter((branch) => branch.tools.every((tool) => granted(role, tool)))
			.map(({ id, when, environment }) => ({ id, when, environment: [...environment] }));
	}
	/** Withdraws a published version from NEW activations (rollback fence, AX5). Already-activated instances keep their pinned snapshot (R4.10). */
	revoke(skillId: string, revision: string): void {
		this.revoked.add(JSON.stringify([skillId, revision]));
	}
	activate(
		role: Role,
		skillId: string,
		revision: string,
		branchIds: string[],
		phase: string,
		environment: string[],
		definitions: ToolDefinition[],
	): Activation {
		const key = JSON.stringify([skillId, revision]);
		const skill = this.versions.get(key);
		if (!skill || !role.skillIds.includes(skillId)) throw new Error("Skill not available");
		if (this.revoked.has(key))
			throw new Error(
				`Skill ${skillId} revision ${revision} was rolled back and is fenced from activation; the active revision is ${
					this.published.get(skillId)?.revision ?? "unknown"
				}`,
			);
		if (!branchIds.length || new Set(branchIds).size !== branchIds.length)
			throw new Error("Select distinct skill branches");
		const branches = branchIds.map((id) => {
			const branch = skill.branches.find((item) => item.id === id);
			if (!branch || !branch.environment.every((item) => environment.includes(item)))
				throw new Error("Branch prerequisites not met");
			if (branch.conflictsWith.some((other) => branchIds.includes(other)))
				throw new Error("Conflicting skill branches");
			return branch;
		});
		const tools = branches.flatMap((branch) => branch.tools.filter((tool) => tool.phase === phase));
		for (const binding of tools) {
			if (!granted(role, binding)) throw new Error("Required tool not authorized");
			if (!definitions.some((tool) => tool.id === binding.toolId && tool.schemaHash === binding.schemaHash)) {
				throw new Error("Tool schema missing or changed");
			}
		}
		return structuredClone({
			skillId,
			skillRevision: revision,
			branchIds,
			phase,
			instructions: [skill.instructions, ...branches.map((branch) => branch.instructions)].join("\n\n"),
			tools: [...new Map(tools.map((tool) => [digest(tool), tool])).values()],
		});
	}
}

/** Call this with the CURRENT role and tool metadata, not a cached permission snapshot. */
export function authorizeInvocation(
	activation: Activation,
	currentRole: Role,
	currentDefinitions: ToolDefinition[],
	request: { toolId: string; accountId: string; resourceId: string },
): ToolBinding {
	if (!currentRole.skillIds.includes(activation.skillId)) throw new Error("Skill authorization revoked");
	const binding = activation.tools.find(
		(tool) =>
			tool.toolId === request.toolId &&
			tool.accountId === request.accountId &&
			tool.resourceId === request.resourceId,
	);
	if (!binding || !granted(currentRole, binding)) throw new Error("Tool call not authorized");
	if (!currentDefinitions.some((tool) => tool.id === binding.toolId && tool.schemaHash === binding.schemaHash)) {
		throw new Error("Tool schema changed; reactivate the skill");
	}
	return structuredClone(binding);
}
