// Console core: WebSocket client, event bus, snapshot store, DOM helpers, markdown.
export const bus = {
	map: new Map(),
	on(type, fn) {
		if (!this.map.has(type)) this.map.set(type, new Set());
		this.map.get(type).add(fn);
		return () => this.map.get(type)?.delete(fn);
	},
	emit(type, payload) {
		for (const fn of this.map.get(type) ?? []) {
			try {
				fn(payload);
			} catch (error) {
				console.error(`[bus] ${type} handler failed`, error);
			}
		}
	},
};

export const store = {
	connected: false,
	readonly: true,
	projectId: "",
	snapshot: null,
	agentStatuses: new Map(), // conversationId -> status
	chatLog: new Map(), // conversationId -> [{role,text,usage?,pending?}]
	pending: new Map(), // conversationId -> live delta text
	token: localStorage.getItem("pi861-console-token") ?? "",
};

let ws = null;
let backoff = 1000;
let reconnectTimer = null;

export function connect() {
	if (reconnectTimer) clearTimeout(reconnectTimer);
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const url = `${scheme}://${location.host}/ws${store.token ? `?token=${encodeURIComponent(store.token)}` : ""}`;
	ws = new WebSocket(url);
	ws.onopen = () => {
		store.connected = true;
		backoff = 1000;
		bus.emit("connection", { connected: true });
	};
	ws.onclose = (event) => {
		store.connected = false;
		bus.emit("connection", { connected: false });
		if (event.code === 4401) {
			bus.emit("auth.required");
			return; // do not auto-reconnect with a bad token
		}
		reconnectTimer = setTimeout(connect, backoff);
		backoff = Math.min(backoff * 2, 10000);
	};
	ws.onerror = () => ws.close();
	ws.onmessage = (event) => {
		let message;
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}
		handleServer(message);
	};
}

function handleServer(message) {
	switch (message.type) {
		case "hello":
			store.readonly = message.readonly;
			store.projectId = message.projectId;
			for (const status of message.agentStatuses ?? []) store.agentStatuses.set(status.conversationId, status);
			store.runner = message.runner;
			bus.emit("hello", message);
			break;
		case "project.snapshot":
			store.snapshot = message.snapshot;
			bus.emit("snapshot", message.snapshot);
			break;
		case "chat.message": {
			const log = store.chatLog.get(message.conversationId) ?? [];
			if (message.message.role === "user") log.push({ role: "user", text: message.message.text });
			if (message.message.role === "assistant") {
				const pending = store.pending.get(message.conversationId);
				if (pending !== undefined && log[log.length - 1]?.role === "assistant" && log[log.length - 1]?.streaming) {
					log[log.length - 1] = { role: "assistant", text: message.message.text, usage: message.message.usage };
				} else {
					log.push({ role: "assistant", text: message.message.text, usage: message.message.usage });
				}
				store.pending.delete(message.conversationId);
			}
			store.chatLog.set(message.conversationId, log);
			bus.emit("chat", { conversationId: message.conversationId });
			break;
		}
		case "chat.delta": {
			const log = store.chatLog.get(message.conversationId) ?? [];
			const last = log[log.length - 1];
			if (last?.role === "assistant" && last.streaming) last.text = message.text;
			else log.push({ role: "assistant", text: message.text, streaming: true });
			store.chatLog.set(message.conversationId, log);
			store.pending.set(message.conversationId, message.text);
			bus.emit("chat", { conversationId: message.conversationId });
			break;
		}
		case "chat.tool":
			bus.emit("chat.tool", message);
			break;
		case "chat.completed":
		case "chat.error": {
			const log = store.chatLog.get(message.conversationId) ?? [];
			const last = log[log.length - 1];
			if (message.type === "chat.error") log.push({ role: "error", text: message.error });
			else if (last?.streaming) last.streaming = false;
			else if (message.cancelled && last?.streaming === false) {
				/* nothing */
			} else if (message.cancelled && !last) log.push({ role: "error", text: "Generation cancelled" });
			store.chatLog.set(message.conversationId, log);
			store.pending.delete(message.conversationId);
			bus.emit("chat", { conversationId: message.conversationId });
			break;
		}
		case "agent.status":
			store.agentStatuses.set(message.conversationId, message);
			bus.emit("agents", message);
			break;
		case "command.rejected":
			bus.emit("toast", { kind: "error", text: `${message.requestId ?? ""} ${message.error}`.trim() });
			break;
		case "protocol.error":
			bus.emit("toast", { kind: "error", text: message.error });
			break;
		default:
			bus.emit(message.type, message);
	}
}

let requestId = 0;
export function send(type, payload = {}) {
	if (!ws || ws.readyState !== 1) {
		bus.emit("toast", { kind: "error", text: "Not connected" });
		return;
	}
	ws.send(JSON.stringify({ type, requestId: `${type}:${++requestId}`, ...payload }));
}

export function setToken(token) {
	store.token = token;
	if (token) localStorage.setItem("pi861-console-token", token);
	else localStorage.removeItem("pi861-console-token");
	if (ws) ws.close();
	connect();
}

// ---------- DOM + format helpers ----------
export function el(tag, attrs = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined || value === null || value === false) continue;
		if (key === "class") node.className = value;
		else if (key === "dataset") Object.assign(node.dataset, value);
		else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
		else if (key === "html") node.innerHTML = value;
		else node.setAttribute(key, value === true ? "" : String(value));
	}
	for (const child of children.flat()) {
		if (child === undefined || child === null || child === false) continue;
		node.append(child.nodeType ? child : document.createTextNode(String(child)));
	}
	return node;
}

export function escapeHtml(text) {
	return String(text).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

/** Compact markdown subset: fenced code, inline code, bold/italic, headings, lists, links. */
export function md(text) {
	const codeBlocks = [];
	let source = escapeHtml(String(text ?? ""));
	source = source.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
		codeBlocks.push(`<pre><code>${code.replace(/\n$/, "")}</code></pre>`);
		return `\u0000${codeBlocks.length - 1}\u0000`;
	});
	source = source
		.replace(/`([^`\n]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
		.replace(/^### (.*)$/gm, "<h4>$1</h4>")
		.replace(/^## (.*)$/gm, "<h3>$1</h3>")
		.replace(/^# (.*)$/gm, "<h3>$1</h3>")
		.replace(
			/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
			'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
		);
	const lines = source.split("\n");
	const out = [];
	let inList = false;
	for (const line of lines) {
		const bullet = /^\s*[-*] (.*)$/.exec(line);
		if (bullet) {
			if (!inList) {
				out.push("<ul>");
				inList = true;
			}
			out.push(`<li>${bullet[1]}</li>`);
			continue;
		}
		if (inList) {
			out.push("</ul>");
			inList = false;
		}
		out.push(line.trim() === "" ? "" : `<p>${line}</p>`);
	}
	if (inList) out.push("</ul>");
	return out.join("").replace(/\u0000(\d+)\u0000/g, (_, index) => codeBlocks[Number(index)] ?? "");
}

export const STATUS_CLASS = {
	queued: "queued",
	running: "running",
	review: "review",
	done: "done",
	blocked: "blocked",
	active: "running",
	paused: "paused",
	idle: "idle",
	completed: "done",
	cancelled: "blocked",
};

export function statusDot(status) {
	return el("span", { class: `dot ${STATUS_CLASS[status] ?? "idle"}` });
}

export function timeAgo(iso) {
	if (!iso) return "";
	const ms = Date.now() - new Date(iso).getTime();
	const minutes = Math.floor(ms / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}
