// Pi RPC bridge for the pi861 web console: manages console-owned chat sessions
// (the main agent plus per-agent conversations) as spawned pi RPC subprocesses.
// Reuses the runtime's PiRpcSession; process events are observed for live deltas
// through LineProcess's multi-listener support (TS-private field, erased at runtime).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiRpcSession } from "../../pi861/src/live/pi-rpc.ts";

class ObservedSession extends PiRpcSession {
	observe(listener) {
		return this.process.onEvent(listener);
	}
}

function sessionSpec(config, stateDir, modelId, runtimeEntry) {
	const project = config.project;
	const target = config.models?.targets.find((item) => item.id === modelId);
	return {
		command: process.execPath,
		args: [
			project.cli,
			"--mode",
			"rpc",
			"--no-skills",
			"--no-extensions",
			...(project.workerExtensionPaths ?? []).flatMap((ext) => ["-e", ext]),
			"-e",
			runtimeEntry,
			"--session-dir",
			join(stateDir, "sessions"),
			...(target ? ["--provider", target.provider, "--model", target.model] : []),
		],
		cwd: project.repository,
		env: {
			...project.workerEnv,
			PI861_CONFIG: process.env.PI861_CONFIG ?? "",
			...(target ? { PI861_INITIAL_MODEL_ID: target.id } : {}),
		},
	};
}

/** Conversation persistence: records the pi session file per console conversation. */
function conversationStore(stateDir) {
	const path = join(stateDir, "console-chat.json");
	const read = () => {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return {};
		}
	};
	return {
		sessionFile: (id) => read()[id]?.sessionFile ?? null,
		record(id, sessionFile) {
			if (!sessionFile) return;
			const data = read();
			data[id] = { sessionFile, updatedAt: new Date().toISOString() };
			writeFileSync(path, JSON.stringify(data, null, "\t"), { mode: 0o600 });
		},
	};
}

function entryText(message) {
	return (Array.isArray(message?.content) ? message.content : [])
		.filter((block) => block?.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

/**
 * Chat session registry. Emits protocol events through the `emit` callback:
 * chat.delta / chat.tool / chat.message / chat.completed / chat.error / agent.status.
 */
export function createChatBridge({ config, stateDir, runtimeEntry, preferredModelId, emit }) {
	const conversations = conversationStore(stateDir);
	const sessions = new Map(); // id -> { session, controller, busy, paused, queue: [] }
	const activeDeltas = new Map(); // id -> latest assistant text while generating

	function status(id) {
		const entry = sessions.get(id);
		return {
			conversationId: id,
			alive: Boolean(entry?.session),
			busy: Boolean(entry?.busy),
			paused: Boolean(entry?.paused),
			queued: entry?.queue.length ?? 0,
		};
	}

	function allStatuses() {
		return [...sessions.keys()].map(status);
	}

	function modelFor(id) {
		const assignment = config.console?.agentModels?.[id];
		return assignment?.primaryId || preferredModelId(config);
	}

	function entryFor(id) {
		let entry = sessions.get(id);
		if (!entry) {
			entry = { session: null, controller: null, busy: false, paused: false, queue: [], observe: null };
			sessions.set(id, entry);
		}
		return entry;
	}

	async function ensureSession(id) {
		const entry = entryFor(id);
		if (entry.session) return entry;
		entry.session = new ObservedSession(sessionSpec(config, stateDir, modelFor(id), runtimeEntry), {
			waitForSettled: true,
		});
		entry.observe?.();
		entry.observe = entry.session.observe((event) => onProcessEvent(id, event));
		// Resume the recorded conversation when the subprocess is fresh.
		const recorded = conversations.sessionFile(id);
		if (recorded && existsSync(recorded)) {
			await entry.session
				.command("switch_session", { sessionPath: recorded }, AbortSignal.timeout(30_000))
				.catch(() => {}); // stale/moved session files degrade to a fresh conversation
		}
		return entry;
	}

	function onProcessEvent(id, event) {
		const entry = sessions.get(id);
		if (!entry?.busy) return;
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = entryText(event.message);
			if (text) {
				activeDeltas.set(id, text);
				emit({ type: "chat.delta", conversationId: id, text });
			}
		} else if (event.type === "tool_execution_start") {
			emit({ type: "chat.tool", conversationId: id, tool: event.toolName ?? "tool" });
		}
	}

	async function persistSessionFile(id) {
		const entry = sessions.get(id);
		if (!entry?.session) return;
		const state = await entry.session.command("get_state", {}, AbortSignal.timeout(30_000)).catch(() => null);
		if (state?.sessionFile) conversations.record(id, state.sessionFile);
	}

	async function runPrompt(id, text) {
		const entry = await ensureSession(id);
		entry.busy = true;
		activeDeltas.set(id, "");
		emit({ type: "agent.status", ...status(id) });
		const controller = new AbortController();
		entry.controller = controller;
		try {
			const result = await entry.session.prompt(text, controller.signal);
			emit({
				type: "chat.message",
				conversationId: id,
				message: { role: "assistant", text: result.text, usage: result.usage },
			});
			emit({ type: "chat.completed", conversationId: id, usage: result.usage });
		} catch (error) {
			const cancelled =
				entry.cancelRequested ||
				controller.signal.aborted ||
				/interrupted|unsuccessfully|aborted|did not settle/i.test(String(error?.message));
			emit({
				type: cancelled ? "chat.completed" : "chat.error",
				conversationId: id,
				...(cancelled ? { cancelled: true } : { error: String(error?.message ?? error) }),
			});
			if (!cancelled && /exited|closed|could not start/i.test(String(error?.message))) await destroySession(id);
		} finally {
			entry.busy = false;
			entry.controller = null;
			entry.cancelRequested = false;
			activeDeltas.delete(id);
			emit({ type: "agent.status", ...status(id) });
			void persistSessionFile(id);
			void drainQueue(id);
		}
	}

	async function drainQueue(id) {
		const entry = sessions.get(id);
		if (!entry || entry.busy || entry.paused || !entry.queue.length) return;
		const next = entry.queue.shift();
		await runPrompt(id, next);
	}

	async function send(id, text) {
		if (!id || typeof text !== "string" || !text.trim())
			throw new Error("conversationId and non-empty text required");
		const entry = sessions.get(id);
		if (entry?.busy) {
			// Real steering: pi RPC supports steer during generation.
			await entry.session.command("steer", { message: text }, AbortSignal.timeout(30_000));
			return { steered: true };
		}
		emit({ type: "chat.message", conversationId: id, message: { role: "user", text } });
		if (entry?.paused) {
			entry.queue.push(text);
			emit({ type: "agent.status", ...status(id) });
			return { queued: true };
		}
		void runPrompt(id, text);
		return { accepted: true };
	}

	async function history(id) {
		const entry = await ensureSession(id);
		const state = await entry.session.command("get_entries", {}, AbortSignal.timeout(30_000));
		const messages = (state?.entries ?? [])
			.filter((e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"))
			.map((e) => ({
				role: e.message.role,
				text: entryText(e.message),
				timestamp: e.timestamp,
			}))
			.filter((m) => m.text.trim());
		if (state?.leafId !== undefined) void persistSessionFile(id);
		return { conversationId: id, messages };
	}

	async function cancel(id) {
		const entry = sessions.get(id);
		if (!entry?.busy) return { cancelled: false };
		// Abort the in-flight turn through the RPC protocol so the session survives.
		entry.cancelRequested = true;
		await entry.session.command("abort", {}, AbortSignal.timeout(30_000)).catch(async (error) => {
			entry.cancelRequested = false;
			await destroySession(id);
			throw error;
		});
		return { cancelled: true };
	}

	async function control(id, action) {
		const entry = entryFor(id); // control works before any session exists (lazy spawn)
		if (action === "pause") entry.paused = true;
		else if (action === "resume") {
			entry.paused = false;
			void drainQueue(id);
		} else if (action === "abort") {
			entry.queue.length = 0;
			if (entry.busy) await cancel(id);
		} else throw new Error(`Unknown agent action: ${action}`);
		emit({ type: "agent.status", ...status(id) });
		return status(id);
	}

	async function destroySession(id) {
		const entry = sessions.get(id);
		if (!entry) return;
		sessions.delete(id);
		entry.queue.length = 0;
		try {
			entry.controller?.abort();
		} catch {
			/* already settled */
		}
		await entry.session?.close().catch(() => {});
		emit({ type: "agent.status", ...status(id) });
	}

	/** Model reassignment takes effect by respawning the conversation's subprocess. */
	async function reassign(id) {
		await destroySession(id);
		return { conversationId: id, respawn: true };
	}

	async function shutdown() {
		for (const id of [...sessions.keys()]) await destroySession(id).catch(() => {});
	}

	mkdirSync(join(stateDir, "sessions"), { recursive: true });

	return { send, history, cancel, control, status, allStatuses, reassign, shutdown, sessions };
}
