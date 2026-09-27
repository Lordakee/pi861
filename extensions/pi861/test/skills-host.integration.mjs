// AX5 host-level Skill lifecycle: real Pi RPC host, real extension loading, real durable
// repository persistence. Only the model outputs (classifier, compiler, capability turns) are
// deterministic local fixtures. Skipped unless PI861_TEST_PI_CLI points at a Pi CLI bundle.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpcSession } from "../src/live/pi-rpc.ts";
import { FileStateStore } from "../src/live/store.ts";
import { SkillRepository, emptySkillState } from "../src/live/skill-repository.ts";

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
const timeoutMs = Number(process.env.PI861_TEST_TIMEOUT_MS ?? 60000);

test("AX5 host skills: auto-grouping merges two generic debug sources, branches are mutually exclusive, default prompts stay clean, updates pin revisions, rollback restores and fences (deterministic local provider fixture; not model-quality evidence)", { skip: !cli, timeout: timeoutMs }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi861-ax5-"));
	let session;
	try {
		const home = join(root, "home"), state = join(root, "state"), work = join(root, "work");
		await Promise.all([mkdir(home), mkdir(state), mkdir(work)]);
		const skillDir = (name, body) => mkdir(join(root, name)).then(() => writeFile(join(root, name, "SKILL.md"), body));
		const debugA = join(root, "debug-a"), debugB = join(root, "debug-b"), debugC = join(root, "debug-c"), deploy = join(root, "deploy");
		await skillDir("debug-a", "---\nname: debug-a\ndescription: NEVER_AUTO_EXPOSE_ORIGINAL_A\n---\nRead the error. Preserve evidence. Validate the fix.");
		await skillDir("debug-b", "Generic debug procedure. Preserve evidence; production incidents need a distinct runbook phase.");
		await skillDir("debug-c", "Additional shared debug requirements: log the reproduction command.");
		await skillDir("deploy", "Deployment guard runbook. Only for release operations; never for debugging.");
		const configFile = join(root, "config.json");
		const config = {
			version: 2, projectId: "ax5", stateDirectory: state,
			role: { id: "developer", skillIds: ["debug", "deploy-guard"], grants: [] },
			models: {
				targets: [
					{ id: "cheap", revision: "1", provider: "pi861-fixture", model: "cheap", quality: 1, costRank: 1, contextWindow: 200000, capabilities: ["tools"], enabled: true },
					{ id: "strong", revision: "1", provider: "pi861-fixture", model: "strong", quality: 3, costRank: 3, contextWindow: 200000, capabilities: ["tools"], enabled: true },
				],
				preferred: "strong", intakeId: "strong", enableRouting: false,
				requirements: { minQuality: 1, contextTokens: 100, capabilities: ["tools"], allowedIds: ["cheap", "strong"] },
				recovery: { failoverEnabled: false, failbackEnabled: false, probeIntervalMs: 100, maxProbeIntervalMs: 1000, requiredProbeSuccesses: 2 },
				maxAttempts: 2, requestTimeoutMs: 20000, maxRequests: 200, maxProbeRequests: 2,
			},
			memory: { autoRecall: false, autoCapture: false, autoEnrich: false },
			skills: { compilerModelId: "strong" },
			budget: { maxRequests: 300 },
		};
		await writeFile(configFile, JSON.stringify(config));
		const env = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI861_CONFIG: configFile, PI861_FIXTURE_LOG: join(root, "calls.jsonl"), NO_COLOR: "1" };
		const processSpec = {
			command: process.execPath,
			args: [...launchPrefix(), cli, "--mode", "rpc", "--no-extensions", "--no-skills",
				"-e", fileURLToPath(new URL("./fixtures/ax5-provider.mjs", import.meta.url)),
				"-e", fileURLToPath(new URL("../runtime.ts", import.meta.url))],
			cwd: work, env,
		};
		session = new PiRpcSession(processSpec, { waitForSettled: true });
		const signal = AbortSignal.timeout(timeoutMs - 5000);

		const skillsFile = join(state, "skills.json");
		const readSkills = async () => JSON.parse(await readFile(skillsFile, "utf8"));
		const publishCandidate = async (predicate) => {
			const snapshot = await readSkills();
			const candidate = snapshot.candidates.find(predicate);
			assert.ok(candidate, "expected compiled candidate is missing");
			// Cross-process trusted publication through the same durable store: RPC hosts gate /skills
			// publish behind an interactive UI confirmation, so the operator validates here instead.
			await new SkillRepository(new FileStateStore(skillsFile, emptySkillState()))
				.publish(candidate.id, async () => ({ passed: true, evidence: ["structural:fixture-schema", "behavioral:fixture-run"] }));
			return candidate;
		};
		const capabilityResult = async (message) => {
			const run = await session.prompt(message, signal);
			const result = run.messages.filter((m) => m.role === "toolResult" && m.toolName === "pi861_capabilities").at(-1);
			assert.ok(result, `no pi861_capabilities result for: ${message}`);
			return { isError: result.isError, text: result.content.map((block) => block.text ?? "").join("\n") };
		};
		const browse = async (path) => JSON.parse((await capabilityResult(`ax5-browse ${path}`.trim())).text);

		// Install two generic debug Skills and one specialized Skill through the real host command.
		for (const [directory, id] of [[debugA, "debug-a"], [debugB, "debug-b"], [deploy, "deploy-guard-src"]]) {
			await session.command("prompt", { message: `/skills install ${directory} ${id}` }, signal);
		}
		const installed = await readSkills();
		const groups = Object.fromEntries(installed.sources.map((source) => [source.id, source.group]));
		assert.equal(groups["debug-a"], "development/debug"); // both generic sources land in ONE group
		assert.equal(groups["debug-b"], "development/debug");
		assert.equal(groups["deploy-guard-src"], "ops/deploy"); // the specialized Skill stays separate

		const merged = await publishCandidate((candidate) => candidate.skill.id === "debug" && candidate.skill.sources.length === 2);
		assert.deepEqual(merged.skill.sources.map((source) => source.id).sort(), ["debug-a", "debug-b"]); // compile kept both sources
		await publishCandidate((candidate) => candidate.skill.id === "deploy-guard");

		const overview = await browse("");
		assert.deepEqual(overview.categories.sort(), ["development", "ops"]);
		const debugSkills = await browse("development/debug");
		assert.equal(debugSkills.skills.length, 1); // browsing presents one merged Skill, not two
		assert.equal(debugSkills.skills[0].id, "debug");
		assert.equal((await browse("ops/deploy")).skills[0].id, "deploy-guard");
		assert.ok(!JSON.stringify([overview, debugSkills]).includes("NEVER_AUTO_EXPOSE_ORIGINAL")); // published view has no source descriptions

		const revision1 = debugSkills.skills[0].revision;
		const general = await capabilityResult(`ax5-activate debug ${revision1} general`);
		assert.equal(general.isError, false);
		assert.match(general.text, /Reproduce and verify locally/); // the ordinary-error branch
		const production = await capabilityResult(`ax5-activate debug ${revision1} production`);
		assert.equal(production.isError, false);
		assert.match(production.text, /Triage without mutation/); // the production-incident branch
		const conflict = await capabilityResult(`ax5-activate debug ${revision1} general,production`);
		assert.equal(conflict.isError, true); // activating conflicting branches fails
		assert.match(conflict.text, /Conflicting/);

		const calls = (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
		const mainTurns = calls.filter((entry) => entry.marker.startsWith("ax5-"));
		assert.ok(mainTurns.length >= 5, "expected the main-session turns to reach the fixture provider");
		assert.ok(mainTurns.every((entry) => !entry.systemHasSecret), "a source Skill secret leaked into a default prompt");
		assert.ok(mainTurns.every((entry) => entry.systemHasCapabilitySection), "the capability guidance section is missing from the default prompt");

		// Update: a third source publishes a new revision; running activations stay pinned to the old one.
		await session.command("prompt", { message: `/skills install ${debugC} debug-c` }, signal);
		await publishCandidate((candidate) => candidate.skill.id === "debug" && candidate.skill.sources.length === 3);
		const revision2 = (await browse("development/debug")).skills[0].revision;
		assert.notEqual(revision2, revision1);
		const activations = async () => (await session.command("get_entries", {}, signal))
			.entries.filter((entry) => entry.customType === "pi861.capabilities.v2").flatMap((entry) => entry.data);
		const beforeReactivation = await activations();
		assert.ok(beforeReactivation.some((entry) => entry.skillId === "debug" && entry.revision === revision1));
		assert.ok(!beforeReactivation.some((entry) => entry.skillId === "debug" && entry.revision === revision2)); // no silent re-pin
		const pinned = await capabilityResult(`ax5-activate debug ${revision1} general`);
		assert.equal(pinned.isError, false); // the running instance keeps using the old revision
		const reactivation = await capabilityResult(`ax5-activate debug ${revision2} general`);
		assert.equal(reactivation.isError, false); // a fresh activation can choose the new revision
		assert.ok((await activations()).some((entry) => entry.skillId === "debug" && entry.revision === revision2));

		// Rollback: the catalog returns to the old revision and fences the revoked one from NEW activations (AX5).
		await session.command("prompt", { message: `/skills rollback debug ${revision1}` }, signal);
		assert.equal((await browse("development/debug")).skills[0].revision, revision1);
		const revoked = await capabilityResult(`ax5-activate debug ${revision2} general`);
		assert.equal(revoked.isError, true); // the rolled-back revision is fenced from new activation
		assert.match(revoked.text, /rolled back/);
		const restored = await capabilityResult(`ax5-activate debug ${revision1} general`);
		assert.equal(restored.isError, false); // the restored active revision activates
		const afterRollback = await activations();
		assert.ok(afterRollback.some((entry) => entry.skillId === "debug" && entry.revision === revision2)); // the running activation keeps its pinned revision through the rollback (R4.10)
		assert.ok(afterRollback.some((entry) => entry.skillId === "debug" && entry.revision === revision1));
	} finally {
		await session?.close();
		await removeTree(root);
	}
});
