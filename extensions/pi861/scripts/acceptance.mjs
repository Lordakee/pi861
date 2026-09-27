#!/usr/bin/env node
/**
 * Unified acceptance runner for the pi861 extension (M5).
 *
 * Records code version, environment, executed commands, results and evidence
 * summaries into a JSON report under .artifacts/acceptance/. Commands come only
 * from the trusted registry below (checked into the repository); the runner
 * never executes arbitrary command strings.
 *
 * Usage (from extensions/pi861, Node >= 22.18):
 *   node scripts/acceptance.mjs                 # run every deterministic check
 *   node scripts/acceptance.mjs --only search-tests,web-read-tests
 *   node scripts/acceptance.mjs --list
 *   node scripts/acceptance.mjs --real-search   # default-off real network acceptance
 *   node scripts/acceptance.mjs --real-model    # default-off skeleton (not implemented)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import path from "node:path";
import process from "node:process";
import { webSearch } from "../src/search.ts";

const extensionDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(extensionDir, "../..");
const OUTPUT_TAIL_BYTES = 8_192;

// --- trusted check registry (the only commands this runner executes) ----------

function resolveTypescript() {
	const candidates = [
		process.env.PI861_TSC,
		path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
		"/tmp/m5-tools/node_modules/typescript/bin/tsc",
	];
	return candidates.find((candidate) => candidate && existsSync(candidate));
}
function resolveTypeRoots(tscPath) {
	// Types next to the resolved tsc (isolated toolchain) or in the repo root.
	const beside = path.resolve(path.dirname(path.dirname(path.dirname(tscPath))), "@types");
	const candidates = [path.join(repoRoot, "node_modules", "@types"), beside].filter((dir) => existsSync(dir));
	return candidates.length ? ["--typeRoots", candidates.join(path.delimiter)] : [];
}
const tsc = resolveTypescript();
const typeRootFlags = tsc ? resolveTypeRoots(tsc) : [];

const CHECKS = [
	{
		name: "search-tests",
		description: "Search adapter unit tests (HTTP fixture via fetch injection)",
		command: ["node", "--experimental-strip-types", "--test", "test/search.test.mjs"],
		timeoutMs: 120_000,
	},
	{
		name: "web-read-tests",
		description: "Bounded web reading and network boundary tests (local fixture servers)",
		command: ["node", "--experimental-strip-types", "--test", "test/web-read.test.mjs"],
		timeoutMs: 120_000,
	},
	{
		name: "typecheck",
		description: "Extension strict tsc (layer 2 of the check chain)",
		command: tsc ? ["node", tsc, "--noEmit", "--project", "tsconfig.json", ...typeRootFlags] : null,
		detail: tsc ? `tsc resolved to ${tsc}` : "typescript not found; set PI861_TSC",
		timeoutMs: 120_000,
	},
	{
		name: "host-tests",
		description: "Published and source Pi host integration tests",
		command: ["node", "--experimental-strip-types", "--test", "test/pi-host.integration.mjs", "test/runtime-host.integration.mjs"],
		requiresEnv: "PI861_TEST_PI_CLI",
		timeoutMs: 300_000,
	},
];

// --- helpers -------------------------------------------------------------------

function runCommand(command, options) {
	return new Promise((resolve) => {
		const child = spawn(command[0], command.slice(1), { cwd: extensionDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
		const tail = (text, chunk) => (text + chunk).slice(-OUTPUT_TAIL_BYTES * 4);
		child.stdout.on("data", (chunk) => { stdout = tail(stdout, chunk.toString("utf8")); });
		child.stderr.on("data", (chunk) => { stderr = tail(stderr, chunk.toString("utf8")); });
		child.on("error", (error) => { clearTimeout(timer); resolve({ exitCode: -1, stdout, stderr: tail(stderr, String(error)) }); });
		child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout, stderr }); });
	});
}

async function gitInfo() {
	const run = async (args) => {
		const result = await runCommand(["git", ...args], { timeoutMs: 15_000 });
		return result.exitCode === 0 ? result.stdout.trim() : undefined;
	};
	const [sha, branch, status] = await Promise.all([run(["rev-parse", "HEAD"]), run(["branch", "--show-current"]), run(["status", "--porcelain"])]);
	const dirtyFiles = (status ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
	return { gitSha: sha, branch, dirty: dirtyFiles.length > 0, dirtyFiles: dirtyFiles.slice(0, 50) };
}

function redact(text, secrets) {
	let output = text;
	for (const secret of secrets) {
		if (secret && secret.length >= 8) output = output.split(secret).join("[redacted]");
	}
	return output;
}

async function writeReport(report) {
	const dir = path.join(extensionDir, ".artifacts", "acceptance");
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `acceptance-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
	const secrets = [process.env.BRAVE_SEARCH_API_KEY];
	const serialized = redact(JSON.stringify(report, null, 2), secrets);
	for (const secret of secrets) {
		if (secret && serialized.includes(secret)) throw new Error("Refusing to write a report that contains a credential");
	}
	writeFileSync(file, serialized);
	console.log(`report: ${path.relative(process.cwd(), file)}`);
}

// --- deterministic checks ------------------------------------------------------

async function runChecks(selected) {
	if (selected && selected.length > 0 && !CHECKS.some((check) => selected.includes(check.name))) {
		console.error(`--only matched no known check (known: ${CHECKS.map((check) => check.name).join(", ")})`);
		process.exit(2);
	}
	const results = [];
	for (const check of CHECKS) {
		if (selected && !selected.includes(check.name)) continue;
		const entry = { name: check.name, description: check.description, command: check.command ? check.command.map(String) : [], skipped: false };
		if (check.requiresEnv && !process.env[check.requiresEnv]) {
			entry.skipped = true;
			entry.skipReason = `${check.requiresEnv} is not set`;
			entry.exitCode = null;
			results.push(entry);
			continue;
		}
		if (!check.command) {
			entry.skipped = true;
			entry.skipReason = check.detail;
			entry.exitCode = null;
			results.push(entry);
			continue;
		}
		const started = Date.now();
		const result = await runCommand(check.command.map(String), { timeoutMs: check.timeoutMs ?? 120_000 });
		entry.command = check.command.map(String);
		entry.exitCode = result.exitCode;
		entry.durationMs = Date.now() - started;
		entry.stdoutTail = result.stdout.slice(-OUTPUT_TAIL_BYTES);
		entry.stderrTail = result.stderr.slice(-OUTPUT_TAIL_BYTES);
		results.push(entry);
		console.log(`${result.exitCode === 0 ? "pass" : "FAIL"}  ${check.name} (${entry.durationMs}ms)`);
	}
	return results;
}

// --- default-off real acceptance ----------------------------------------------

// Fixed public query set: the real-search acceptance only sends these strings and
// never private project content. Budget bounds the number of paid requests.
const REAL_SEARCH_QUERIES = ["TypeScript documentation", "Node.js file system module"];

async function realSearch() {
	if (process.env.PI861_ACCEPT_REAL_SEARCH !== "1") {
		console.error("Real search acceptance is default-off. Set PI861_ACCEPT_REAL_SEARCH=1, export BRAVE_SEARCH_API_KEY,");
		console.error("and optionally PI861_ACCEPTANCE_SEARCH_BUDGET_REQUESTS (default 3) to opt in. No request was made.");
		process.exit(3);
	}
	const apiKey = process.env.BRAVE_SEARCH_API_KEY;
	if (!apiKey) {
		console.error("BRAVE_SEARCH_API_KEY is not set; real search acceptance cannot run.");
		process.exit(3);
	}
	const budget = Number(process.env.PI861_ACCEPTANCE_SEARCH_BUDGET_REQUESTS ?? 3);
	if (!Number.isInteger(budget) || budget < 1 || budget > 10) {
		console.error("PI861_ACCEPTANCE_SEARCH_BUDGET_REQUESTS must be an integer between 1 and 10.");
		process.exit(3);
	}
	const attempts = [];
	for (const query of REAL_SEARCH_QUERIES.slice(0, budget)) {
		const started = Date.now();
		try {
			const found = await webSearch(query, { enabled: true, apiKey });
			attempts.push({ query, outcome: "ok", resultCount: found.results.length, truncated: found.truncated, retrievedAt: found.retrievedAt, durationMs: Date.now() - started });
			console.log(`ok    "${query}" -> ${found.results.length} results`);
		} catch (error) {
			attempts.push({ query, outcome: "error", error: String(error.message).slice(0, 300), durationMs: Date.now() - started });
			console.log(`error "${query}" -> ${error.message}`);
		}
	}
	return {
		kind: "real-search",
		provider: "brave",
		budgetRequests: budget,
		spentRequests: attempts.length,
		dataScope: "fixed public queries only; no private project content is sent",
		cleanup: "stateless: no files, no backend writes; only this JSON report is produced; unset the credential variable afterwards",
		attempts,
	};
}

async function realModel() {
	const missing = ["PI861_ACCEPT_REAL_MODEL", "PI861_REAL_MODEL"].filter((name) => !process.env[name]);
	// Skeleton: model-side acceptance is owned by the routing module (M1). This
	// entry records the contract without executing anything, so nothing is claimed.
	const skeleton = {
		kind: "real-model",
		status: "not-implemented-skeleton",
		requires: ["PI861_ACCEPT_REAL_MODEL=1 (explicit opt-in)", "PI861_REAL_MODEL (model id)", "provider credential variable", "PI861_ACCEPTANCE_MODEL_BUDGET (token/request cap)"],
		dataScope: "fixture prompts only; no private project content",
		cleanup: "no persistent state; unset credential variables afterwards",
		missing,
	};
	if (process.env.PI861_ACCEPT_REAL_MODEL !== "1") {
		console.error("Real model acceptance is default-off and, in M5 scope, a skeleton only. Nothing was executed or claimed.");
		process.exit(3);
	}
	console.error("Real model acceptance skeleton: environment recorded, execution is not implemented in M5 (owned by the routing module).");
	return skeleton;
}

// --- main ----------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--list")) {
	for (const check of CHECKS) console.log(`${check.name} - ${check.description}${check.requiresEnv ? ` (requires ${check.requiresEnv})` : ""}`);
	process.exit(0);
}
const only = args.includes("--only") ? args[args.indexOf("--only") + 1]?.split(",") : undefined;
const wantsRealSearch = args.includes("--real-search");
const wantsRealModel = args.includes("--real-model");

const real = wantsRealSearch ? await realSearch() : wantsRealModel ? await realModel() : null;
const checks = wantsRealSearch || wantsRealModel ? [] : await runChecks(only);
const summary = {
	pass: checks.filter((entry) => !entry.skipped && entry.exitCode === 0).length,
	fail: checks.filter((entry) => !entry.skipped && entry.exitCode !== 0).length,
	skipped: checks.filter((entry) => entry.skipped).length,
};
const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	code: await gitInfo(),
	environment: {
		node: process.version,
		platform,
		arch,
		osRelease: release(),
		argv: args,
		envFlagsPresent: Object.fromEntries(["PI861_WEB_SEARCH_ENABLED", "BRAVE_SEARCH_API_KEY", "PI861_WEB_READ_ENABLED", "PI861_WEB_READ_HOSTS", "PI861_WEB_READ_INTERNAL_ENDPOINTS", "PI861_TEST_PI_CLI", "PI861_ACCEPT_REAL_SEARCH"].map((name) => [name, Boolean(process.env[name])])),
	},
	checks,
	realAcceptance: real,
	summary,
};
await writeReport(report);
console.log(`summary: ${summary.pass} pass, ${summary.fail} fail, ${summary.skipped} skipped`);
if (summary.fail > 0) process.exit(1);
