// AX10 goal end-to-end integration: a real Pi RPC host loads the runtime extension; /goal
// creates a planned goal through a deterministic local planner fixture; two real Pi worker
// subprocesses modify isolated git workspaces; results pass through a real local MCP server
// and a host-installed Skill; memory persists; checks gate integration; an independent audit
// reads the committed artifacts; controlled integration lands on git.
// deterministic local provider fixture; not model-quality evidence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpcSession } from "../src/live/pi-rpc.ts";

const execute = promisify(execFile);
const cli = process.env.PI861_TEST_PI_CLI;
/** Optional JSON string array inserted before the CLI entry, e.g. a tsx source-host launch. */
function launchPrefix() {
	const raw = process.env.PI861_TEST_PI_LAUNCH_PREFIX;
	if (!raw) return [];
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string")) throw new Error("PI861_TEST_PI_LAUNCH_PREFIX must be a JSON array of strings");
	return parsed;
}
/** Windows releases child working-directory handles slightly after process exit; retry a bounded number of times. */
async function removeTree(path) {
	for (let attempt = 0; attempt < 20; attempt++) {
		try { await rm(path, { recursive: true, force: true }); return; } catch (error) {
			if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
			await sleep(250);
		}
	}
	await rm(path, { recursive: true, force: true });
}
const timeoutMs = Number(process.env.PI861_TEST_TIMEOUT_MS ?? 120000);

test("AX10 goal e2e: /goal plans, two real worker subprocesses execute, skills and MCP serve results, memory persists, checks gate integration and an independent audit accepts (deterministic local provider fixture; not model-quality evidence)", { skip: !cli, timeout: timeoutMs }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi861-ax10-"));
	let session;
	try {
		// Temporary real git repository with an initial commit (the project under development).
		const repo = join(root, "repo");
		await mkdir(repo);
		await execute("git", ["init", repo]);
		await writeFile(join(repo, "README"), "ax10 fixture\n");
		await execute("git", ["add", "README"], { cwd: repo });
		await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "base"], { cwd: repo });
		const base = (await execute("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

		const home = join(root, "home"), state = join(root, "state"), work = join(root, "work");
		await Promise.all([mkdir(home), mkdir(state), mkdir(work)]);
		const skillSource = join(root, "skill-src");
		await mkdir(skillSource);
		await writeFile(join(skillSource, "SKILL.md"), "Goal helper procedure: reproduce the objective, preserve evidence, validate the result.");

		const configFile = join(root, "config.json");
		const config = {
			version: 2, projectId: "ax10", stateDirectory: state,
			role: { id: "developer", skillIds: ["mcp-local"], grants: [{ toolId: "local/lookup", accountId: "a", resourceIds: ["project:p"] }] },
			mcp: [{ id: "local", accountId: "a", transport: { kind: "stdio", process: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))], cwd: work } } }],
			resourceRules: [{ toolId: "local/lookup", accountId: "a", resourceId: "project:p", equals: { project: "p" } }],
			models: {
				targets: [
					{ id: "cheap", revision: "1", provider: "pi861-fixture", model: "cheap", quality: 1, costRank: 1, contextWindow: 200000, capabilities: ["tools"], enabled: true },
					{ id: "strong", revision: "1", provider: "pi861-fixture", model: "strong", quality: 3, costRank: 3, contextWindow: 200000, capabilities: ["tools"], enabled: true },
				],
				preferred: "strong", intakeId: "strong", enableRouting: false,
				requirements: { minQuality: 1, contextTokens: 100, capabilities: ["tools"], allowedIds: ["cheap", "strong"] },
				recovery: { failoverEnabled: false, failbackEnabled: false, probeIntervalMs: 100, maxProbeIntervalMs: 1000, requiredProbeSuccesses: 2 },
				maxAttempts: 2, requestTimeoutMs: 20000, maxRequests: 300, maxProbeRequests: 2,
			},
			memory: { autoRecall: false, autoCapture: true, autoEnrich: false, modelId: "strong" },
			skills: { compilerModelId: "strong" },
			project: {
				repository: repo, worktreeRoot: join(root, "trees"), cli,
				maxConcurrent: 2,
				checks: [
					{ id: "verify-a", command: process.execPath, args: ["-e", "if(require('fs').readFileSync('a.txt','utf8')!=='A')process.exit(1)"] },
					{ id: "verify-b", command: process.execPath, args: ["-e", "if(require('fs').readFileSync('b.txt','utf8')!=='B')process.exit(1)"] },
				],
				plannerModelId: "strong",
				workerExtensionPaths: [fileURLToPath(new URL("./fixtures/ax10-provider.mjs", import.meta.url))],
				workerEnv: { HOME: home, NO_COLOR: "1", PI861_FIXTURE_LOG: join(root, "calls.jsonl") },
			},
			budget: { maxRequests: 400 },
		};
		await writeFile(configFile, JSON.stringify(config));
		const env = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI861_CONFIG: configFile, PI861_FIXTURE_LOG: join(root, "calls.jsonl"), NO_COLOR: "1" };
		const processSpec = {
			command: process.execPath,
			args: [...launchPrefix(), cli, "--mode", "rpc", "--no-extensions", "--no-skills",
				"-e", fileURLToPath(new URL("./fixtures/ax10-provider.mjs", import.meta.url)),
				"-e", fileURLToPath(new URL("../runtime.ts", import.meta.url))],
			cwd: work, env,
		};
		session = new PiRpcSession(processSpec, { waitForSettled: true });
		const signal = AbortSignal.timeout(timeoutMs - 20000);
		const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
		const capabilityTurn = async (message) => {
			const run = await session.prompt(message, signal);
			const result = run.messages.filter((m) => m.role === "toolResult" && m.toolName === "pi861_capabilities").at(-1);
			assert.ok(result, `no pi861_capabilities result for: ${message}`);
			return { isError: result.isError, text: result.content.map((block) => block.text ?? "").join("\n") };
		};
		const waitFor = async (predicate, label, budgetMs = 70000) => {
			const end = Date.now() + budgetMs;
			while (Date.now() < end) {
				if (await predicate()) return;
				await sleep(200);
			}
			throw new Error(`condition not reached in time: ${label}`);
		};

		// 1. Skill install through the host: source archived, auto-classified, compiled by the fixture.
		await session.command("prompt", { message: `/skills install ${skillSource} goal-helper` }, signal);
		const skillsAfterInstall = await readJson(join(state, "skills.json"));
		assert.equal(skillsAfterInstall.sources.find((s) => s.id === "goal-helper")?.group, "development/debug");
		assert.ok(skillsAfterInstall.candidates.some((c) => c.skill.id === "debug" && c.skill.sources.length === 1), "compiled candidate missing");

		// 2. Real local MCP server: publish its deterministic resource-bound Skill through the host.
		await session.command("prompt", { message: "/mcp refresh local" }, signal);
		const skillsAfterMcp = await readJson(join(state, "skills.json"));
		assert.ok(skillsAfterMcp.versions.some((v) => v.id === "mcp-local"), "MCP skill was not published");

		// 3. Activate the MCP Skill through the host tool and execute the bound tool against the real server.
		const browsed = JSON.parse((await capabilityTurn("ax10-browse tools/local")).text);
		assert.equal(browsed.skills[0].id, "mcp-local");
		const mcpRevision = browsed.skills[0].revision;
		const branches = JSON.parse((await capabilityTurn("ax10-branches mcp-local")).text);
		assert.equal(branches.length, 1);
		const activation = await capabilityTurn(`ax10-activate mcp-local ${mcpRevision} ${branches[0].id}`);
		assert.equal(activation.isError, false);
		const mcpRun = await session.prompt("ax10-call", signal);
		const mcpResult = mcpRun.messages.filter((m) => m.role === "toolResult" && m.toolName.startsWith("pi861_mcp_")).at(-1);
		assert.ok(mcpResult, "the bound MCP tool was never called");
		assert.equal(mcpResult.isError, false);
		assert.match(mcpResult.content.map((block) => block.text ?? "").join("\n"), /looked up p/);

		// 4. Durable memory write through the host.
		await session.command("prompt", { message: "/remember ax10-memory-marker: goal fixture memory entry" }, signal);
		assert.ok((await readJson(join(state, "memory.json"))).memory.items.some((item) => item.full.includes("ax10-memory-marker")));

		// 5. /goal creates the planned goal; the planner fixture runs; two real worker subprocesses execute.
		await session.command("prompt", { message: "/goal Ship the ax10 fixture feature" }, signal);
		const projectState = async () => readJson(join(state, "project.json"));
		await waitFor(async () => (await projectState()).status === "review", "project reaches review");
		const review = await projectState();
		const tasks = Object.fromEntries(review.board.tasks.map((task) => [task.id, task]));
		assert.equal(tasks.A.status, "done");
		assert.equal(tasks.B.status, "done");
		assert.deepEqual(tasks.B.dependsOn, ["A"]); // the plan carries a real dependency
		assert.ok(tasks.A.acceptance.length >= 1, "the plan carries acceptance criteria");
		assert.ok(tasks.A.evidence.some((item) => item.startsWith("check:verify-a:passed")), "task checks ran before submission");
		assert.ok(tasks.B.evidence.some((item) => item.startsWith("integration:")), "integration evidence recorded");

		const calls = (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
		assert.ok(calls.some((c) => c.marker.startsWith("Inspect relevant existing source files")), "planner inspection never ran");
		assert.ok(calls.some((c) => c.marker.startsWith("Plan only the authorized project objective")), "plan generation never ran");
		const usageState = await readJson(join(state, "usage.json"));
		// Honest boundary: these are observed planner turns (<= real provider requests), metered post-hoc.
		assert.ok(usageState.kinds["auxiliary:planner"]?.requests >= 1, "planner turns must be metered per turn");
		assert.equal(typeof usageState.kinds["auxiliary:planner"]?.inputTokens, "number", "planner turns report known fixture usage");
		assert.ok(Object.keys(usageState.receipts ?? {}).length >= 1, "planner receipts must persist");
		const workerCalls = calls.filter((c) => /^Task: /.test(c.marker));
		assert.ok(workerCalls.some((c) => c.marker.startsWith("Task: A")) && workerCalls.some((c) => c.marker.startsWith("Task: B")));
		assert.ok(new Set(workerCalls.map((c) => c.pid)).size >= 2, "two distinct worker subprocesses must serve the tasks");
		const workerWorkspaces = [tasks.A, tasks.B].map((task) => task.artifacts.find((a) => a.startsWith("workspace:")));
		assert.equal(new Set(workerWorkspaces).size, 2, "each worker modified its own isolated workspace");
		assert.ok([tasks.A, tasks.B].every((task) => task.artifacts.some((a) => a.startsWith("response-sha:"))), "worker self-reports recorded");

		// 6. Independent audit: read the committed git objects, never the workers' self-reports.
		const integrationPath = (await readJson(join(state, "integration.json"))).path;
		const history = (await execute("git", ["log", "--format=%H %P", "--reverse", `${base}..HEAD`], { cwd: integrationPath }))
			.stdout.trim().split("\n").map((line) => line.split(" "));
		assert.equal(history.length, 4, "two candidate commits plus two controlled merges");
		assert.equal(history[0].length, 2); // task A candidate: exactly one parent (the base)
		assert.equal(history[1].length, 3); // controlled merge of A into the integration workspace
		assert.equal(history[2].length, 2); // task B candidate
		assert.equal(history[3].length, 3); // controlled merge of B
		const auditA = (await execute("git", ["show", `${history[0][0]}:a.txt`], { cwd: integrationPath })).stdout;
		const auditB = (await execute("git", ["show", `${history[2][0]}:b.txt`], { cwd: integrationPath })).stdout;
		assert.equal(auditA, "A");
		assert.equal(auditB, "B");
		assert.equal((await execute("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(), base, "main repository must remain at the base commit");
		const selfReports = [...tasks.A.artifacts, ...tasks.B.artifacts].filter((a) => a.startsWith("response-sha:"));
		const auditEvidence = `ax10-audit: independent git audit read a.txt=${JSON.stringify(auditA)} b.txt=${JSON.stringify(auditB)} from committed objects in the integration workspace`;
		assert.ok(!selfReports.some((report) => auditEvidence.includes(report)), "audit evidence must be derived from git objects, not worker self-reports");
		await session.command("prompt", { message: `/remember ${auditEvidence}` }, signal);
		assert.ok((await readJson(join(state, "memory.json"))).memory.items.some((item) => item.full.includes("ax10-audit: independent git audit")));

		// 7. Acceptance: the audit-verified goal completes.
		await session.command("prompt", { message: "/goal accept" }, signal);
		assert.equal((await projectState()).status, "completed");
		assert.equal(await readFile(join(integrationPath, "a.txt"), "utf8"), "A");
		assert.equal(await readFile(join(integrationPath, "b.txt"), "utf8"), "B");
	} finally {
		await session?.close();
		await removeTree(root);
	}
});
