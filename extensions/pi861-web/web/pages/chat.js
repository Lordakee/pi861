// Chat page: main agent conversation over the console WebSocket.
import { bus, el, md, send, store } from "../core.js";

const conversationId = "main";
let logEl = null;
let inputEl = null;
let sendBtn = null;
let cancelBtn = null;
let statusLine = null;
let typingEl = null;
const off = [];

function busy() {
	return store.agentStatuses.get(conversationId)?.busy ?? Boolean(store.pending.get(conversationId));
}

function renderMessage(entry) {
	if (entry.role === "error") return el("div", { class: "msg error" }, entry.text);
	const node = el("div", { class: `msg ${entry.role}` });
	node.innerHTML = md(entry.text);
	if (entry.usage && (entry.usage.input || entry.usage.output))
		node.append(el("span", { class: "meta" }, `${entry.usage.input ?? "?"} in / ${entry.usage.output ?? "?"} out`));
	if (entry.streaming) node.append(el("span", { class: "meta" }, "generating…"));
	return node;
}

function renderLog() {
	if (!logEl) return;
	const entries = store.chatLog.get(conversationId) ?? [];
	logEl.replaceChildren(...entries.map(renderMessage));
	if (busy()) {
		typingEl = typingEl ?? el("div", { class: "typing" }, el("span"), el("span"), el("span"));
		logEl.append(typingEl);
	} else typingEl = null;
	logEl.scrollTop = logEl.scrollHeight;
	updateControls();
}

function updateControls() {
	const isBusy = busy();
	sendBtn.disabled = !inputEl.value.trim() && !isBusy;
	if (isBusy && inputEl.value.trim()) sendBtn.textContent = "Steer";
	else sendBtn.textContent = "Send";
	cancelBtn.classList.toggle("hidden", !isBusy);
	statusLine.textContent = "";
	const status = store.agentStatuses.get(conversationId);
	if (status?.paused) statusLine.textContent = "paused";
	if (status?.queued) statusLine.textContent = `${status.queued} queued`;
}

function doSend() {
	const text = inputEl.value.trim();
	if (!text) return;
	send("chat.send", { conversationId, text });
	inputEl.value = "";
	updateControls();
}

export function render(container) {
	logEl = el("div", { class: "chat-log" });
	inputEl = el("textarea", {
		placeholder: "Message the main agent… (Enter to send, Shift+Enter for newline)",
		oninput: updateControls,
		onkeydown: (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				doSend();
			}
		},
	});
	sendBtn = el("button", { class: "primary", onclick: doSend }, "Send");
	cancelBtn = el("button", { class: "danger", onclick: () => send("chat.cancel", { conversationId }) }, "Stop");
	statusLine = el("span", { class: "hint" });
	container.append(
		el(
			"div",
			{ class: "chat-wrap" },
			logEl,
			el("div", { class: "chat-input" }, inputEl, sendBtn, cancelBtn),
			statusLine,
		),
	);
	send("chat.history", { conversationId });
	renderLog();
	off.push(bus.on("chat", (event) => event.conversationId === conversationId && renderLog()));
	off.push(bus.on("agents", () => updateControls()));
	off.push(bus.on("connection", ({ connected }) => connected && send("chat.history", { conversationId })));
}

export function destroy() {
	for (const fn of off.splice(0)) fn();
	logEl = inputEl = sendBtn = cancelBtn = statusLine = typingEl = null;
}
