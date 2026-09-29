// WebSocket message protocol for the pi861 web console.
// Client -> server commands carry a requestId; every command answers with
// command.accepted or command.rejected. State changes broadcast as project.snapshot
// (2s change-detection poll plus wake-driven pushes from the coordinator).
const WRITE_COMMANDS = new Set([
	"chat.send",
	"chat.cancel",
	"goal.create",
	"goal.control",
	"task.append",
	"task.withdraw",
	"task.unblock",
	"task.edit",
	"team.join",
	"team.leave",
	"agent.control",
	"agent.steer",
	"model.assign",
	"model.control",
	"runner.start",
	"runner.stop",
	"settings.update",
]);

export function createProtocol({ bridge, chat, token, readonly }) {
	const clients = new Set(); // { ws, authed }
	let lastSnapshotHash = "";

	function send(client, message) {
		if (client.ws.readyState === 1) client.ws.send(JSON.stringify(message));
	}

	function broadcast(message) {
		const payload = JSON.stringify(message);
		for (const client of clients) if (client.authed && client.ws.readyState === 1) client.ws.send(payload);
	}

	async function refreshSnapshot() {
		try {
			const snapshot = await bridge.snapshot();
			const hash = JSON.stringify({ ...snapshot, updatedAt: null });
			if (hash === lastSnapshotHash) return;
			lastSnapshotHash = hash;
			broadcast({ type: "project.snapshot", snapshot });
		} catch (error) {
			broadcast({ type: "protocol.error", error: `snapshot failed: ${String(error?.message ?? error)}` });
		}
	}

	/** New connections always get the current snapshot, even when the hash is already stable. */
	async function sendSnapshotTo(client) {
		try {
			send(client, { type: "project.snapshot", snapshot: await bridge.snapshot() });
		} catch (error) {
			send(client, { type: "protocol.error", error: `snapshot failed: ${String(error?.message ?? error)}` });
		}
	}

	const poll = setInterval(() => void refreshSnapshot(), 2000);
	poll.unref?.();

	function chatEmit(event) {
		broadcast(event);
	}

	async function dispatch(client, message) {
		const { type, requestId } = message ?? {};
		const reply = (extra) => send(client, { type: "command.accepted", requestId, ...extra });
		const reject = (error) =>
			send(client, { type: "command.rejected", requestId, error: String(error?.message ?? error) });
		if (typeof type !== "string") return reject("Missing command type");
		if (!client.authed) return reject("Authenticate first (auth message or ?token=)");
		if (WRITE_COMMANDS.has(type) && readonly)
			return reject("Console is read-only: set PI861_CONSOLE_TOKEN to enable write operations");
		try {
			switch (type) {
				case "auth":
					return reply({ authenticated: true });
				case "subscribe":
					await refreshSnapshot();
					return reply({ snapshot: true });
				case "chat.send":
					return reply(await chat.send(message.conversationId, message.text));
				case "chat.history":
					return reply(await chat.history(message.conversationId));
				case "chat.cancel":
					return reply(await chat.cancel(message.conversationId));
				case "goal.create":
					await bridge.goalCreate(message);
					await refreshSnapshot();
					return reply({ created: true });
				case "goal.control":
					await bridge.goalControl(message.action);
					await refreshSnapshot();
					return reply({ action: message.action });
				case "task.append":
					await bridge.taskAppend(message);
					await refreshSnapshot();
					return reply({ appended: true });
				case "task.withdraw":
					await bridge.taskWithdraw(message);
					await refreshSnapshot();
					return reply({ withdrawn: true });
				case "task.unblock":
					await bridge.taskUnblock(message);
					await refreshSnapshot();
					return reply({ unblocked: true });
				case "task.edit":
					await bridge.taskEdit(message);
					await refreshSnapshot();
					return reply({ edited: true });
				case "team.join":
					await bridge.teamJoin(message.member);
					await refreshSnapshot();
					return reply({ joined: true });
				case "team.leave":
					await bridge.teamLeave({ agentId: message.agentId });
					await refreshSnapshot();
					return reply({ left: true });
				case "agent.control":
					return reply(await chat.control(message.agentId, message.action));
				case "agent.steer":
					return reply(await chat.send(message.agentId, message.text));
				case "model.assign":
					await bridge.modelAssign(message);
					if (message.agentId) await chat.reassign(message.agentId).catch(() => {});
					await refreshSnapshot();
					return reply({ assigned: true });
				case "model.control":
					await bridge.modelControl(message);
					await refreshSnapshot();
					return reply({ updated: true });
				case "runner.start":
					await bridge.runnerStart();
					await refreshSnapshot();
					return reply({ running: true });
				case "runner.stop":
					await bridge.runnerStop();
					await refreshSnapshot();
					return reply({ running: false });
				case "settings.update":
					await bridge.settingsUpdate(message);
					await refreshSnapshot();
					return reply({ updated: true });
				default:
					return reject(`Unknown command type: ${type}`);
			}
		} catch (error) {
			return reject(error);
		}
	}

	function handleConnection(ws, request) {
		const client = { ws, authed: false };
		const url = new URL(request.url ?? "/", "http://localhost");
		const presented = url.searchParams.get("token");
		if (!token) {
			// No token configured: read-only anonymous mode (bind to localhost in index.mjs).
			client.authed = true;
		} else if (presented === token) {
			client.authed = true;
		}
		clients.add(client);
		if (!client.authed) {
			send(client, {
				type: "protocol.error",
				error: "Authentication required: reconnect with ?token= or send auth",
			});
			ws.close(4401, "unauthorized");
			clients.delete(client);
			return;
		}
		send(client, {
			type: "hello",
			readonly,
			projectId: bridge.config.projectId,
			agentStatuses: chat.allStatuses(),
			runner: bridge.runnerStatus(),
		});
		void sendSnapshotTo(client);
		ws.on("message", (data) => {
			let message;
			try {
				message = JSON.parse(String(data));
			} catch {
				send(client, { type: "protocol.error", error: "Invalid JSON frame" });
				return;
			}
			if (message.type === "auth") {
				client.authed = !token || message.token === token;
				return send(
					client,
					client.authed ? { type: "hello", readonly } : { type: "protocol.error", error: "Invalid token" },
				);
			}
			void dispatch(client, message);
		});
		ws.on("close", () => clients.delete(client));
		ws.on("error", () => clients.delete(client));
	}

	return { handleConnection, chatEmit, refreshSnapshot, close: () => clearInterval(poll) };
}
