import assert from "node:assert/strict";
import { test } from "node:test";
import { installPi861 } from "../index.ts";
import { LocalMemory } from "../src/memory.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 8));
function host(options = {}) {
	const commands = new Map();
	const tools = new Map();
	const handlers = new Map();
	const notices = [];
	const prompts = [];
	let branch = [];
	let session = "session-1";
	let idle = true;
	let pending = false;
	let aborted = 0;
	const ctx = {
		cwd: "/project",
		isIdle: () => idle, hasPendingMessages: () => pending,
		abort: () => { aborted++; idle = true; },
		sessionManager: { getSessionId: () => session, getBranch: () => branch },
		ui: { notify: (message, level) => notices.push({ message, level }), setStatus() {} },
	};
	const pi = {
		on(name, fn) { handlers.set(name, fn); },
		registerCommand(name, command) { assert.ok(!commands.has(name)); commands.set(name, command); },
		registerTool(tool) { assert.ok(!tools.has(tool.name)); tools.set(tool.name, tool); },
		appendEntry(type, data) { branch.push({ type: "custom", customType: type, data: structuredClone(data) }); },
		sendUserMessage(prompt) { prompts.push(prompt); idle = false; },
		sendMessage(message) { notices.push(message); },
	};
	installPi861(pi, { search: { enabled: false }, ...options });
	const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
	return {
		commands, tools, notices, prompts, ctx, pi, emit,
		get entries() { return branch; },
		get aborted() { return aborted; },
		setBranch(value) { branch = value; },
		setSession(value) { session = value; branch = []; },
		setPending(value) { pending = value; },
		async command(name, args = "") { return commands.get(name).handler(args, ctx); },
		async tool(name, params, id = "tool1") { return tools.get(name).execute(id, params, undefined, undefined, ctx); },
		async settle(stopReason = "stop") {
			idle = true;
			await emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
			await emit("agent_settled");
		},
		goal() { return [...branch].reverse().find((entry) => entry.customType === "pi861.goal.v1")?.data; },
	};
}
test("extension registers goal and memory but disabled search has no model tool", async () => {
	const h = host();
	await h.emit("session_start");
	for (const name of ["goal", "remember", "memory-forget", "web-search"]) assert.ok(h.commands.has(name));
	assert.ok(h.tools.has("pi861_goal_report"));
	assert.ok(!h.tools.has("pi861_web_search"));
	await h.command("web-search", "test");
	assert.match(h.notices.at(-1).message, /disabled/);
});
test("goal starts, records progress, and refills after settlement rather than agent_end", async () => {
	const h = host();
	await h.emit("session_start");
	await h.command("goal", "Implement and test the feature");
	assert.equal(h.prompts.length, 1);
	const token = h.goal().runToken;
	await h.tool("pi861_goal_report", { runToken: token, progress: "Inspected relevant files", nextAction: "Implement the change", evidence: ["source:read"], readyForReview: false });
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await tick();
	assert.equal(h.prompts.length, 1);
	await h.settle();
	await tick();
	assert.equal(h.prompts.length, 2);
	await h.command("goal", "pause");
});
test("completion enters review and requires a human accept command", async () => {
	const h = host();
	await h.emit("session_start");
	await h.command("goal", "Implement feature");
	await h.tool("pi861_goal_report", { runToken: h.goal().runToken, progress: "Candidate complete", evidence: ["test:passed"], readyForReview: true });
	await h.settle();
	await tick();
	assert.equal(h.goal().status, "review");
	assert.equal(h.prompts.length, 1);
	await h.command("goal", "accept");
	assert.equal(h.goal().status, "completed");
});
test("user pause cancels a queued continuation", async () => {
	const h = host();
	await h.emit("session_start");
	await h.command("goal", "Do authorized work");
	await h.tool("pi861_goal_report", { runToken: h.goal().runToken, progress: "step one", evidence: [], nextAction: "step two", readyForReview: false });
	await h.settle();
	await h.command("goal", "pause");
	await tick();
	assert.equal(h.prompts.length, 1);
	assert.equal(h.goal().status, "paused");
});
test("aborted model run never auto-resumes", async () => {
	const h = host();
	await h.emit("session_start");
	await h.command("goal", "Do work");
	await h.settle("aborted");
	await tick();
	assert.equal(h.prompts.length, 1);
	assert.equal(h.goal().status, "paused");
});
test("user input pauses an active autonomous goal without treating it as internal continuation", async () => {
	const h = host();
	await h.emit("session_start");
	await h.command("goal", "Do work");
	await h.emit("input", { text: "Change the requirements", source: "interactive" });
	await h.settle();
	await tick();
	assert.equal(h.prompts.length, 1);
	assert.equal(h.goal().status, "paused");
});
test("session restore never automatically replays an interrupted goal", async () => {
	const h = host();
	await h.emit("session_start");
	await h.command("goal", "Do work");
	await h.emit("session_start");
	await tick();
	assert.equal(h.prompts.length, 1);
	assert.equal(h.goal().status, "active"); // persisted old entry; controller restores passively
	await h.command("goal", "status");
	assert.match(h.notices.at(-1).message, /"status": "paused"/);
});
test("branch navigation discards memories from the abandoned future branch", async () => {
	const h = host();
	await h.emit("session_start");
	await h.command("remember", "codealpha belongs to this project");
	assert.equal((await h.tool("pi861_memory", { action: "search", query: "codealpha" })).details.length, 1);
	h.setBranch([]);
	await h.emit("session_tree");
	assert.equal((await h.tool("pi861_memory", { action: "search", query: "codealpha" })).details.length, 0);
});
test("auto capture excludes extension prompts, credentials, and does not echo the latest input into recall", async () => {
	const h = host();
	await h.emit("session_start");
	await h.emit("input", { source: "extension", text: "Internal continuation" });
	await h.emit("input", { source: "interactive", text: "api_key=abcdefghijklmnop123456789" });
	assert.equal(h.entries.filter((entry) => entry.customType === "pi861.memory.v1").length, 0);
	await h.emit("input", { source: "interactive", text: "codealpha is a local fact" });
	const recalled = await h.emit("before_agent_start", { prompt: "codealpha is a local fact" });
	assert.equal(recalled, undefined);
});
test("memory notes remain candidates while explicit remember is confirmed", async () => {
	const h = host();
	await h.emit("session_start");
	await h.tool("pi861_memory", { action: "note", content: "codealpha is a hypothesis" }, "note1");
	await h.command("remember", "codealpha is explicitly confirmed elsewhere");
	const items = (await h.tool("pi861_memory", { action: "search", query: "codealpha" })).details;
	assert.deepEqual(items.map((item) => item.status).sort(), ["candidate", "confirmed"]);
	const context = await h.emit("before_agent_start", { prompt: "What is codealpha?" });
	assert.match(context.message.content, /UNTRUSTED MEMORY DATA/);
	assert.match(context.message.content, /source/);
});
test("external backend spans sessions; no local fallback is created on a failed external write", async () => {
	const backend = new LocalMemory({ tenantId: "t", principalId: "p", readScopes: ["project:p1"], writeScopes: ["project:p1"] });
	const h = host({ memory: { backend, scope: "project:p1" } });
	await h.emit("session_start");
	await h.command("remember", "codealpha persists in the configured backend");
	h.setSession("session-2");
	await h.emit("session_start");
	assert.equal((await h.tool("pi861_memory", { action: "search", query: "codealpha" })).details.length, 1);
	assert.equal(h.entries.length, 0);
	backend.put = async () => { throw new Error("database offline"); };
	await h.command("remember", "this write must not use a local fallback");
	assert.match(h.notices.at(-1).message, /database offline/);
	assert.equal(h.entries.length, 0);
	assert.equal((await backend.search("local fallback")).length, 0);
});
test("external backend must have an explicit authorized scope", async () => {
	const backend = new LocalMemory({ tenantId: "t", principalId: "p", readScopes: ["project:p1"], writeScopes: ["project:p1"] });
	const h = host({ memory: { backend } });
	await h.emit("session_start");
	assert.match(h.notices.at(-1).message, /explicit scope/);
	await assert.rejects(h.tool("pi861_memory", { action: "search", query: "a" }), /unavailable/);
});
test("recall started in an old session is not injected into a new session", async () => {
	let resolve;
	const backend = {
		async search() { return new Promise((r) => { resolve = r; }); },
		async put() { throw new Error("offline"); }, async get() {}, async withdraw() {},
	};
	const h = host({ memory: { backend, scope: "project:p1" } });
	await h.emit("session_start");
	const old = h.emit("before_agent_start", { prompt: "x" });
	h.setSession("s2");
	await h.emit("session_start");
	resolve([]);
	assert.equal(await old, undefined);
});
test("a second pi861 composition on the same host is refused", async () => {
	const h = host();
	await h.emit("session_start");
	assert.throws(
		() => installPi861(h.pi, { memory: { backend: undefined } }),
		/already installed on this host; remove the duplicate pi861 extension load/,
	);
	// The refused install must not have registered a second goal command owner.
	assert.equal([...h.commands.keys()].filter((name) => name === "goal").length, 1);
});
test("a fresh host generation may install after the previous one shut down", async () => {
	const first = host();
	await first.emit("session_start");
	await first.emit("session_shutdown");
	const second = host();
	await second.emit("session_start");
	await second.command("goal", "status");
	assert.match(second.notices.at(-1).message, /none/);
});
