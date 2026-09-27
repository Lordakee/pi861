import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, lstatSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { normalizeScope } from "../scheduler.ts";
import { digest } from "../memory.ts";
const execute = promisify(execFile);
export interface CheckCommand { id: string; command: string; args: string[]; timeoutMs?: number; env?: Record<string, string>; }
export interface Workspace { path: string; baseCommit: string; branch: string; }

/** Isolated Git state and explicit path checks; a worktree is not an OS security sandbox. */
export class Workspaces {
	private readonly repository: string;
	private readonly root: string;
	constructor(repository: string, root: string) {
		this.repository = resolve(repository); this.root = resolve(root);
		if (this.root === this.repository || this.root.startsWith(`${this.repository}/`)) throw new Error("Worktrees must be outside the source working tree");
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
	}
	async head(): Promise<string> {
		return (await execute("git", ["rev-parse", "HEAD"], { cwd: this.repository })).stdout.trim();
	}
	/** Workspace identity is goal/run/task/attempt scoped: reusing a taskId in a later goal cannot collide. */
	async create(taskId: string, attempt: number, baseCommit: string, identity?: { goal?: string; run?: string }): Promise<Workspace> {
		if (!/^[a-f0-9]{40,64}$/.test(baseCommit) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Pinned commit and valid attempt required");
		const id = digest([identity?.goal ?? "", identity?.run ?? "", taskId, attempt]).slice(0, 24), path = join(this.root, id), branch = `pi861/task-${id}`;
		if (existsSync(path)) throw new Error("Task workspace already exists; reconcile before reuse");
		await execute("git", ["worktree", "add", "-b", branch, path, baseCommit], { cwd: this.repository, maxBuffer: 1_048_576 });
		return { path, branch, baseCommit };
	}
	async changed(workspace: Workspace, scopes: string[]): Promise<string[]> {
		const allowed = scopes.map(normalizeScope);
		const tracked = (await execute("git", ["diff", "--name-only", "-z", workspace.baseCommit, "--"], { cwd: workspace.path })).stdout;
		const untracked = (await execute("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: workspace.path })).stdout;
		const names = [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))];
		for (const name of names) {
			const path = normalizeScope(name);
			if (!allowed.some((scope) => scope === "." || path === scope || path.startsWith(`${scope}/`))) throw new Error(`Task changed an unreserved path: ${path}`);
			if (existsSync(join(workspace.path, path)) && lstatSync(join(workspace.path, path)).isSymbolicLink()) throw new Error("Task produced a symlink; requires explicit review");
		}
		return names;
	}
	async check(workspace: Workspace, checks: CheckCommand[], signal: AbortSignal): Promise<string[]> {
		const evidence: string[] = [];
		for (const check of checks) {
			signal.throwIfAborted();
			const result = await execute(check.command, check.args, { cwd: workspace.path, signal, timeout: check.timeoutMs ?? 120_000,
				maxBuffer: 4_194_304, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
					PI861_WORKSPACE: workspace.path, ...check.env } });
			evidence.push(`check:${check.id}:passed:sha256:${digest({ stdout: result.stdout, stderr: result.stderr })}`);
		}
		return evidence;
	}
	async commit(workspace: Workspace, paths: string[], taskId: string): Promise<string> {
		if (paths.length) {
			await execute("git", ["add", "--", ...paths], { cwd: workspace.path, maxBuffer: 1_048_576 });
			await execute("git", ["-c", "user.name=Pi861 Worker", "-c", "user.email=pi861-worker@localhost", "commit", "-m", `feat: candidate for task ${taskId.slice(0, 80)}`], { cwd: workspace.path, maxBuffer: 1_048_576 });
		}
		return (await execute("git", ["rev-parse", "HEAD"], { cwd: workspace.path })).stdout.trim();
	}
	async exportCommit(commit: string, exclude?: string): Promise<{ data: string; sha256: string }> {
		if (!/^[a-f0-9]{40,64}$/.test(commit) || exclude && !/^[a-f0-9]{40,64}$/.test(exclude)) throw new Error("Invalid transfer commit");
		if (commit === exclude) return { data: "", sha256: createHash("sha256").update("").digest("hex") };
		const id = randomUUID(), ref = `refs/pi861-transfers/${id}`, file = join(this.root, `${id}.bundle`);
		await execute("git", ["update-ref", ref, commit], { cwd: this.repository });
		try {
			await execute("git", ["bundle", "create", file, ref, ...(exclude ? [`^${exclude}`] : [])], { cwd: this.repository, maxBuffer: 1_048_576 });
			const bytes = readFileSync(file);
			if (bytes.length > 33_554_432) throw new Error("Transfer bundle exceeds 32 MiB; use an operator-managed artifact transport");
			return { data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
		} finally { rmSync(file, { force: true }); await execute("git", ["update-ref", "-d", ref, commit], { cwd: this.repository }); }
	}
	async importCommit(bundle: { data: string; sha256: string }, commit: string): Promise<void> {
		if (!/^[a-f0-9]{40,64}$/.test(commit) || bundle.data.length > 44_739_244) throw new Error("Invalid transfer object");
		const bytes = Buffer.from(bundle.data, "base64");
		if (createHash("sha256").update(bytes).digest("hex") !== bundle.sha256) throw new Error("Transfer checksum mismatch");
		if (!bytes.length) { await execute("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: this.repository }); return; }
		const file = join(this.root, `${randomUUID()}.bundle`);
		writeFileSync(file, bytes, { mode: 0o600 });
		try {
			await execute("git", ["bundle", "verify", file], { cwd: this.repository, maxBuffer: 1_048_576 });
			await execute("git", ["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", file, commit], { cwd: this.repository, maxBuffer: 1_048_576 });
		} finally { rmSync(file, { force: true }); }
	}

	/** Integrates into a dedicated worktree, never the user's main checkout. */
	async integrate(workspace: Workspace, commit: string, signal: AbortSignal): Promise<void> {
		if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid candidate commit");
		await execute("git", ["-c", "user.name=Pi861 Integrator", "-c", "user.email=pi861-integrator@localhost", "merge", "--no-ff", "--no-edit", commit], { cwd: workspace.path, signal, maxBuffer: 1_048_576 });
	}
	/** Lock files a still-running Git process may hold; integration lease takeover requires them gone. */
	gitLocks(workspace: Workspace): string[] {
		let gitDir = join(workspace.path, ".git");
		if (existsSync(gitDir) && lstatSync(gitDir).isFile()) {
			const pointer = readFileSync(gitDir, "utf8").trim();
			if (!pointer.startsWith("gitdir:")) return [];
			gitDir = pointer.slice("gitdir:".length).trim();
		}
		if (!existsSync(gitDir)) return [];
		return ["index.lock", "config.lock", "HEAD.lock", "shallow.lock", "gc.pid"]
			.map((name) => join(gitDir, name)).filter((path) => existsSync(path));
	}
}
