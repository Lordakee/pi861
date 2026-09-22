/** Real Pi RPC smoke test. Does not submit a model task or contact a search backend. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = process.env.PI861_TEST_PI_CLI;
/** Optional JSON string array inserted before the CLI entry, e.g. a tsx source-host launch: ["<tsx>/cli.mjs","--tsconfig","<tsconfig>"]. */
function launchPrefix() {
	const raw = process.env.PI861_TEST_PI_LAUNCH_PREFIX;
	if (!raw) return [];
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string")) {
		throw new Error("PI861_TEST_PI_LAUNCH_PREFIX must be a JSON array of strings");
	}
	return parsed;
}
test("real Pi: load extension, commands and memory without an LLM", { skip: !cli, timeout: Number(process.env.PI861_TEST_TIMEOUT_MS ?? 60_000) }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi861-host-test-"));
	const home = join(directory, "home");
	await mkdir(home);
	const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
	const pending = new Map();
	let output = "";
	let stderr = "";
	let sequence = 0;
	let fatal;
	let closed = false;
	const child = spawn(process.execPath, [...launchPrefix(), cli, "--mode", "rpc", "--no-session", "--no-skills", "-e", extension], {
		cwd: directory,
		env: {
			PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home,
			XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
			PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
			PI861_AUTO_CAPTURE: "0", PI861_AUTO_RECALL: "0", PI861_WEB_SEARCH_ENABLED: "0",
			PI861_PROJECT_ID: "host-smoke", NO_COLOR: "1", LANG: "C.UTF-8",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	function fail(error) {
		fatal = error;
		for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
		pending.clear();
	}
	const exited = new Promise((resolve) => {
		child.once("exit", (code, signal) => {
			closed = true;
			fail(new Error(`Pi exited (${code ?? signal}); ${stderr.slice(-3000)}`));
			resolve();
		});
	});
	child.on("error", fail);
	child.stdin.on("error", fail);
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		output += chunk;
		if (output.length > 2_000_000) { fail(new Error("RPC output exceeded test bound")); child.kill(); return; }
		while (output.includes("\n")) {
			const end = output.indexOf("\n");
			const line = output.slice(0, end);
			output = output.slice(end + 1);
			let message;
			try { message = JSON.parse(line); } catch { continue; }
			if (message.type === "agent_start") { fail(new Error("Smoke test unexpectedly started model inference")); child.kill(); return; }
			if (message.type !== "response" || !pending.has(message.id)) continue;
			const waiter = pending.get(message.id);
			pending.delete(message.id);
			clearTimeout(waiter.timer);
			if (message.success) waiter.resolve(message.data);
			else waiter.reject(new Error(`RPC ${message.command}: ${message.error}`));
		}
	});
	const rpcTimeoutMs = Number(process.env.PI861_TEST_PI_RPC_TIMEOUT_MS ?? 20_000);
	function rpc(type, fields = {}) {
		if (fatal) return Promise.reject(fatal);
		const id = `smoke-${++sequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`RPC ${type} timed out; ${stderr.slice(-3000)}`));
			}, rpcTimeoutMs);
			pending.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
		});
	}
	try {
		const catalog = await rpc("get_commands");
		for (const name of ["goal", "remember", "memory-forget", "web-search"]) {
			assert.ok(catalog.commands.some((command) => command.name === name), `Missing command ${name}; ${stderr}`);
		}
		const marker = `pi861-smoke-${randomUUID()}`;
		await rpc("prompt", { message: `/remember ${marker}` });
		const snapshot = await rpc("get_entries");
		const saved = [...snapshot.entries].reverse().find((entry) => entry.type === "custom" && entry.customType === "pi861.memory.v1");
		assert.ok(saved, `Memory was not saved by the real host; ${stderr}`);
		const item = saved.data.snapshot.items.find((entry) => entry.full === marker);
		assert.equal(item.status, "confirmed");
		await rpc("prompt", { message: `/memory-forget ${item.id}` });
		const updated = await rpc("get_entries");
		const withdrawn = [...updated.entries].reverse().find((entry) => entry.type === "custom" && entry.customType === "pi861.memory.v1");
		assert.equal(withdrawn.data.snapshot.items.find((entry) => entry.id === item.id).status, "withdrawn");
		await rpc("prompt", { message: "/goal status" });
		assert.equal((await rpc("get_state")).isStreaming, false);
		assert.equal(fatal, undefined);
	} finally {
		for (const waiter of pending.values()) clearTimeout(waiter.timer);
		pending.clear();
		if (!closed) child.kill("SIGTERM");
		let killTimer;
		await Promise.race([exited, new Promise((resolve) => {
			killTimer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); resolve(); }, 3000);
		})]);
		clearTimeout(killTimer);
		await rm(directory, { recursive: true, force: true });
	}
});
