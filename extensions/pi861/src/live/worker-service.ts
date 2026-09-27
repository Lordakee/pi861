/**
 * Standalone deployment entry for a Pi861 remote worker node (R3.13).
 * Run: node --experimental-strip-types src/live/worker-service.ts --config service.json
 * (or set PI861_WORKER_SERVICE_CONFIG to the absolute config path).
 *
 * The config is operator-owned JSON; the bearer token always comes from an environment
 * variable (tokenEnv) and never appears in the file. SIGTERM/SIGINT trigger convergent
 * shutdown: running jobs are aborted (state becomes "unknown", never replayed blindly),
 * the HTTP server closes and the process exits 0.
 *
 * Example service.json:
 * {
 *   "repository": "/srv checkout of the project repository",
 *   "worktreeRoot": "/var/lib/pi861/worker-trees",
 *   "statePath": "/var/lib/pi861/worker-state.json",
 *   "tokenEnv": "PI861_WORKER_TOKEN",
 *   "host": "127.0.0.1", "port": 8787, "heartbeatMs": 30000,
 *   "identity": { "id": "node-1", "capabilities": [], "roleIds": ["dev"], "modelIds": ["..."] },
 *   "maxConcurrent": 2,
 *   "checks": [{ "id": "verify", "command": "node", "args": ["-e", "..."] }],
 *   "worker": { "command": "node", "args": ["--experimental-strip-types", "runtime-entry.ts"] }
 * }
 * The worker command runs in each task workspace; the operator is responsible for pointing
 * it at the Pi861 runtime entry with worker-mode environment variables.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkerIdentity } from "./coordinator.ts";
import { RemoteWorkerServer } from "./remote-worker.ts";
import { FileStateStore } from "./store.ts";
import { type CheckCommand, Workspaces } from "./workspace.ts";

export interface WorkerServiceConfig {
	repository: string;
	worktreeRoot: string;
	statePath: string;
	tokenEnv: string;
	host?: string;
	port?: number;
	heartbeatMs?: number;
	identity: WorkerIdentity;
	maxConcurrent: number;
	checks: CheckCommand[];
	worker: { command: string; args: string[]; env?: Record<string, string> };
}
export function readWorkerServiceConfig(path: string): WorkerServiceConfig {
	if (!path) throw new Error("Worker service config path required");
	const config = JSON.parse(readFileSync(resolve(path), "utf8")) as Partial<WorkerServiceConfig>;
	if (
		!config.repository ||
		!config.worktreeRoot ||
		!config.statePath ||
		!config.tokenEnv ||
		!config.identity?.id ||
		!Array.isArray(config.checks) ||
		typeof config.maxConcurrent !== "number" ||
		!Number.isSafeInteger(config.maxConcurrent) ||
		config.maxConcurrent < 1 ||
		!config.worker?.command ||
		!Array.isArray(config.worker.args)
	)
		throw new Error("Invalid worker service configuration");
	return config as WorkerServiceConfig;
}
/**
 * Start the worker service. onHeartbeat receives the announced status (identity,
 * capacity, job counts, uptime) each heartbeatMs; the default prints one JSON line.
 * Resolves when the abort signal fires and shutdown has converged.
 */
export async function runWorkerService(
	config: WorkerServiceConfig,
	signal: AbortSignal,
	onHeartbeat?: (status: Record<string, unknown>) => void,
): Promise<void> {
	const token = process.env[config.tokenEnv];
	if (!token || token.length < 24) throw new Error(`Missing strong bearer token in ${config.tokenEnv}`);
	const announce =
		onHeartbeat ??
		((status): void => {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		});
	const server = new RemoteWorkerServer(new FileStateStore(resolve(config.statePath), { jobs: [] }), {
		token,
		identity: config.identity,
		maxConcurrent: config.maxConcurrent,
		checks: config.checks,
		workspaces: new Workspaces(config.repository, config.worktreeRoot),
		process: (workspace) => ({
			command: config.worker.command,
			args: config.worker.args,
			cwd: workspace.path,
			env: config.worker.env,
		}),
	});
	const url = await server.listen(config.port ?? 0, config.host ?? "127.0.0.1");
	announce({ event: "listening", url, ...(await server.status()) });
	const interval = Math.max(1000, config.heartbeatMs ?? 30_000);
	const timer = setInterval(() => {
		void server
			.status()
			.then((status) => announce({ event: "heartbeat", url, ...status }))
			.catch(() => {});
	}, interval);
	timer.unref();
	await new Promise<void>((resolveWait) => {
		if (signal.aborted) {
			resolveWait();
			return;
		}
		signal.addEventListener("abort", () => resolveWait(), { once: true });
	});
	clearInterval(timer);
	announce({ event: "stopping", url });
	await server.close();
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2);
	const index = args.indexOf("--config");
	const configPath = index >= 0 ? args[index + 1] : process.env.PI861_WORKER_SERVICE_CONFIG;
	if (!configPath) {
		process.stderr.write("Usage: worker-service.ts --config CONFIG.json (or set PI861_WORKER_SERVICE_CONFIG)\n");
		process.exit(2);
	}
	const controller = new AbortController();
	for (const name of ["SIGTERM", "SIGINT"] as const) process.on(name, () => controller.abort());
	try {
		await runWorkerService(readWorkerServiceConfig(configPath), controller.signal);
		process.exitCode = 0;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
