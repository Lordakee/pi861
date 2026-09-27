import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeScope } from "../scheduler.ts";

export interface FileGuard { root: string; writeScopes: string[]; allowShell: boolean; }
export interface IsolationBoundary { osSandbox: "none"; enforced: string[]; notEnforced: string[] }
/**
 * Explicit boundary of worker isolation. There is no OS sandbox: the guard constrains
 * native file tools only. Operators must not present this as process/network isolation.
 */
export function workerIsolationBoundary(): IsolationBoundary {
	return {
		osSandbox: "none",
		enforced: [
			"Native file tools (read/write/edit/grep/find/ls) cannot escape the worker workspace root, including through symlinks",
			"Writes stay inside the task's reserved write scopes",
			"Hardlinked and symbolic-linked targets cannot be written without explicit review",
			"The workspace .git directory is unreachable by native file tools",
			"Worker shell tools (bash/powershell) are disabled unless allowWorkerShell is explicitly configured",
		],
		notEnforced: [
			"No CPU, memory, wall-clock or process-count limits",
			"No network egress restriction; reachable endpoints stay callable by approved tools",
			"Operator-approved check commands execute with the service user's full privileges",
			"MCP server subprocesses and operator-selected programs are not sandboxed",
		],
	};
}
/** Defense in depth for native file tools. It does not sandbox operator-selected test programs or MCP servers. */
export function guardWorkerTool(guard: FileGuard, name: string, input: Record<string, unknown>): void {
	if (["bash", "powershell"].includes(name)) { if (!guard.allowShell) throw new Error("Worker shell access is disabled; use approved verification tools"); return; }
	if (!["read", "write", "edit", "grep", "find", "ls"].includes(name)) return;
	const writing = name === "write" || name === "edit";
	const path = typeof input.path === "string" ? input.path : ".";
	const root = realpathSync(guard.root), target = resolve(root, path), rel = relative(root, target);
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).includes(".git")) throw new Error("Tool path escapes the worker workspace");
	let existing = target;
	while (!existsSync(existing)) { const parent = dirname(existing); if (parent === existing) throw new Error("Invalid worker path"); existing = parent; }
	const actual = realpathSync(existing), realRelative = relative(root, actual);
	if (isAbsolute(realRelative) || realRelative === ".." || realRelative.startsWith(`..${sep}`)) throw new Error("Tool path resolves outside the worker workspace");
	if (writing) {
		const normalized = rel ? normalizeScope(rel) : ".";
		if (!guard.writeScopes.map(normalizeScope).some((scope) => scope === "." || normalized === scope || normalized.startsWith(`${scope}/`))) throw new Error("Write is outside the task reservation");
		if (existsSync(target) && (lstatSync(target).isSymbolicLink() || lstatSync(target).isFile() && lstatSync(target).nlink > 1)) throw new Error("Linked writes require explicit review");
	}
}
