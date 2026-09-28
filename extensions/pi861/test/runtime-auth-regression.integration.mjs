// Regression test for the P0 credential-shadowing fix (b790cd255): the managed wrapper
// provider registers apiKey "local-routing-no-remote-credential"; before the fix that
// placeholder leaked into nested target-provider streamSimple calls, shadowing the
// target provider's own registered credential, and a body-401 on HTTP 200 was classified
// "invalid" so failover never ran. Exercises real Pi auth resolution and runtime routing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpcSession } from "../src/live/pi-rpc.ts";
const cli = process.env.PI861_TEST_PI_CLI;
/** Optional JSON string array inserted before the CLI entry, e.g. a tsx source-host launch: ["<tsx>/cli.mjs","--tsconfig","<tsconfig>"]. */
function launchPrefix() {
	const raw = process.env.PI861_TEST_PI_LAUNCH_PREFIX;
	if (!raw) return [];
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string"))
		throw new Error("PI861_TEST_PI_LAUNCH_PREFIX must be a JSON array of strings");
	return parsed;
}
/** Windows releases child working-directory handles slightly after process exit; retry a bounded number of times. */
async function removeTree(path) {
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
			await sleep(250);
		}
	}
	await rm(path, { recursive: true, force: true });
}
// Narrow single-prompt regression gets an independent 30s budget; suite-level runs are
// still governed by PI861_TEST_TIMEOUT_MS through the outer runner.
const budgetMs = 30_000;
test("wrapper credential does not shadow target provider auth; body-401 on HTTP 200 fails over", { skip: !cli, timeout: budgetMs }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi861-auth-shadow-"));
	let session;
	try {
		const home = join(root, "home"),
			work = join(root, "project"),
			state = join(root, "state"),
			configFile = join(root, "config.json"),
			logFile = join(root, "auth-calls.jsonl");
		await mkdir(home);
		await mkdir(work);
		const config = {
			version: 2,
			projectId: "auth-shadow-test",
			stateDirectory: state,
			role: { id: "developer", skillIds: [], grants: [] },
			models: {
				targets: [
					{ id: "faulty", revision: "1", provider: "pi861-auth-fixture", model: "faulty", quality: 1, costRank: 1, contextWindow: 200000, capabilities: ["tools"], enabled: true },
					{ id: "healthy", revision: "1", provider: "pi861-auth-fixture", model: "healthy", quality: 3, costRank: 3, contextWindow: 200000, capabilities: ["tools"], enabled: true },
				],
				preferred: "faulty",
				intakeId: "faulty",
				enableRouting: false,
				requirements: { minQuality: 1, contextTokens: 100, capabilities: ["tools"], allowedIds: ["faulty", "healthy"] },
				recovery: { failoverEnabled: true, failbackEnabled: false, probeIntervalMs: 1000, maxProbeIntervalMs: 1000, requiredProbeSuccesses: 1 },
				maxAttempts: 2,
				requestTimeoutMs: 10000,
				maxRequests: 20,
				maxProbeRequests: 2,
			},
			budget: { maxRequests: 50 },
		};
		await writeFile(configFile, JSON.stringify(config));
		const env = {
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
			PI861_CONFIG: configFile,
			PI861_AUTH_LOG: logFile,
			NO_COLOR: "1",
		};
		const processSpec = {
			command: process.execPath,
			args: [
				...launchPrefix(),
				cli,
				"--mode",
				"rpc",
				"--no-extensions",
				"--no-skills",
				"-e",
				fileURLToPath(new URL("./fixtures/auth-shadow-provider.mjs", import.meta.url)),
				"-e",
				fileURLToPath(new URL("../runtime.ts", import.meta.url)),
			],
			cwd: work,
			env,
		};
		session = new PiRpcSession(processSpec, { waitForSettled: true });
		const signal = AbortSignal.timeout(budgetMs - 5000);
		// Before the fix this prompt failed outright: body-401 on HTTP 200 was classified
		// "invalid", so recovery never failed over and the turn settled unsuccessfully.
		const run = await session.prompt("auth-shadow: report status in one short line", signal);
		assert.ok(run.text.includes("healthy-model-ok"), "prompt must complete through the backup model");
		const calls = (await readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse);
		assert.ok(calls.some((c) => c.model === "faulty"), "the faulty primary must be attempted first");
		const healthy = calls.filter((c) => c.model === "healthy");
		assert.ok(healthy.length >= 1, "body-401 must trigger failover to the backup model");
		for (const call of healthy) {
			assert.equal(call.apiKey, "target-registered-key", "nested call must use the target provider's registered credential");
			assert.notEqual(call.apiKey, "local-routing-no-remote-credential", "wrapper placeholder credential must never shadow target auth");
		}
		const entries = await session.command("get_entries", {}, signal);
		const routing = entries.entries.filter((e) => e.customType === "pi861.model-runtime.v2");
		const last = routing.at(-1);
		assert.ok(last, "model runtime state must be recorded");
		assert.equal(last.data.active, "healthy", "active target must switch to the backup after the primary's auth failure");
		assert.equal(last.data.preferred, "faulty");
		assert.ok(last.data.requests >= 2, "both the failed primary attempt and the backup attempt must be metered");
	} finally {
		await session?.close();
		await removeTree(root);
	}
});
