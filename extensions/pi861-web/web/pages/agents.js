// Agents page: team member cards, local workers, per-agent chat detail and controls.
import { bus, el, md, send, store } from "../core.js";

const off = [];
let root = null;
let modalEl = null;

function agentCard({ id, model, currentTask, status, source }) {
	return el(
		"div",
		{ class: "card", style: "cursor:pointer", onclick: () => agentDetail(id) },
		el(
			"div",
			{ style: "display:flex;align-items:center;gap:10px" },
			el("span", { class: `dot ${status}` }),
			el("strong", {}, id),
			el("span", { class: "tag" }, source),
		),
		el("p", { class: "hint", style: "margin:10px 0 6px" }, currentTask ? `running: ${currentTask}` : "idle"),
		el("p", { class: "hint", style: "margin:0" }, model ? `model: ${model}` : "model: default"),
	);
}

function agentDetail(id) {
	const snapshot = store.snapshot;
	const status = store.agentStatuses.get(id) ?? { conversationId: id, busy: false, paused: false, queued: 0 };
	const targets = snapshot?.models?.targets ?? [];
	const assignment = snapshot?.models?.agentModels?.[id];
	const primary = el(
		"select",
		{ class: "compact" },
		el("option", { value: "" }, "(project default)"),
		...targets.map((t) => el("option", { value: t.id, selected: t.id === assignment?.primaryId }, t.id)),
	);
	const fallback = el("input", {
		class: "compact",
		value: (assignment?.fallbackIds ?? []).join(", "),
		placeholder: "fallback ids",
	});
	const failover = el("input", {
		type: "checkbox",
		style: "width:auto",
		checked: Boolean(assignment?.recovery?.failover),
	});
	const chatLog = el("div", {
		class: "chat-log",
		style: "max-height:260px;min-height:80px;border:1px solid var(--border);border-radius:8px;padding:10px",
	});
	const input = el("input", { placeholder: `Message ${id}…` });
	const renderLog = () => {
		const entries = store.chatLog.get(id) ?? [];
		chatLog.replaceChildren(
			...(entries.length
				? entries.map((entry) => {
						const node = el("div", { class: `msg ${entry.role}`, style: "max-width:100%" });
						node.innerHTML = md(entry.text);
						return node;
					})
				: [el("p", { class: "hint" }, "No conversation yet. Send a message to open this agent's session.")]),
		);
		chatLog.scrollTop = chatLog.scrollHeight;
	};
	renderLog();
	const offChat = bus.on("chat", (event) => event.conversationId === id && renderLog());
	const close = () => offChat();
	send("chat.history", { conversationId: id }).valueOf();
	openModal(
		`Agent ${id}`,
		el(
			"div",
			{ class: "modal-body" },
			el(
				"div",
				{ class: "form-row" },
				el(
					"button",
					{ class: "small", onclick: () => send("agent.control", { agentId: id, action: "pause" }) },
					"Pause",
				),
				el(
					"button",
					{ class: "small", onclick: () => send("agent.control", { agentId: id, action: "resume" }) },
					"Resume",
				),
				el(
					"button",
					{ class: "small danger", onclick: () => send("agent.control", { agentId: id, action: "abort" }) },
					"Abort",
				),
				el(
					"span",
					{ class: "hint", style: "align-self:center" },
					status.busy ? "busy" : status.paused ? "paused" : "idle",
				),
			),
			chatLog,
			el(
				"div",
				{ class: "form-row" },
				input,
				el(
					"button",
					{
						class: "primary",
						onclick: () => {
							if (!input.value.trim()) return;
							send("chat.send", { conversationId: id, text: input.value.trim() });
							input.value = "";
						},
					},
					"Send",
				),
			),
			el("h3", {}, "Model assignment"),
			el("label", { class: "field" }, el("span", {}, "Primary model"), primary),
			el("label", { class: "field" }, el("span", {}, "Fallback models"), fallback),
			el("label", { class: "field" }, el("span", {}, "Enable failover"), failover),
			el(
				"button",
				{
					class: "primary",
					onclick: () =>
						send("model.assign", {
							agentId: id,
							primaryId: primary.value || undefined,
							fallbackIds: fallback.value
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean),
							recovery: { failover: failover.checked, failback: false },
						}),
				},
				"Assign (respawns session)",
			),
		),
		close,
	);
}

function openModal(title, body, onClose) {
	closeModal();
	modalEl = el(
		"div",
		{ class: "modal-backdrop", onclick: (event) => event.target === modalEl && closeModal() },
		el(
			"div",
			{ class: "modal" },
			el(
				"div",
				{ class: "modal-header" },
				title,
				el("span", { class: "spacer" }),
				el("button", { class: "ghost small", onclick: closeModal }, "✕"),
			),
			body,
		),
	);
	modalEl.dataset.onClose = "";
	modalEl.addEventListener("close", onClose ?? (() => {}));
	document.body.append(modalEl);
}
function closeModal() {
	if (modalEl) modalEl.dispatchEvent(new Event("close"));
	modalEl?.remove();
	modalEl = null;
}

function addAgentForm() {
	const id = el("input", { placeholder: "agent id, e.g. reviewer-1" });
	const capabilities = el("input", { placeholder: "comma-separated capabilities" });
	const capacity = el("input", { type: "number", value: "1", min: "1", max: "8" });
	return el(
		"form",
		{
			class: "card",
			onsubmit: (event) => {
				event.preventDefault();
				send("team.join", {
					member: {
						id: id.value.trim(),
						capabilities: capabilities.value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean),
						capacity: Number(capacity.value) || 1,
					},
				});
				id.value = "";
			},
		},
		el("h3", {}, "Add team member"),
		el(
			"div",
			{ class: "form-row" },
			el("label", { class: "field" }, el("span", {}, "Id"), id),
			el("label", { class: "field" }, el("span", {}, "Capacity"), capacity),
		),
		el("label", { class: "field" }, el("span", {}, "Capabilities"), capabilities),
		el("button", { class: "primary", type: "submit" }, "Add"),
	);
}

function rerender() {
	if (!root) return;
	const snapshot = store.snapshot;
	if (!snapshot) {
		root.replaceChildren(el("p", { class: "hint" }, "Waiting for project snapshot…"));
		return;
	}
	const runningBy = new Map(snapshot.tasks.filter((t) => t.status === "running").map((t) => [t.workerId, t]));
	const members = (snapshot.team ?? []).map((member) => ({
		id: member.id,
		model: snapshot.models?.agentModels?.[member.id]?.primaryId ?? snapshot.models?.preferred ?? "default",
		currentTask: runningBy.get(member.id)?.id ?? null,
		status: runningBy.has(member.id) ? "running" : "idle",
		source: "team",
	}));
	const workers = Array.from({ length: snapshot.runner?.workers ?? 0 }, (_, index) => {
		const id = `local-${index}`;
		return {
			id,
			model: snapshot.models?.agentModels?.[id]?.primaryId ?? snapshot.models?.preferred ?? "default",
			currentTask: runningBy.get(id)?.id ?? null,
			status: runningBy.has(id) ? "running" : snapshot.runner?.running ? "active" : "idle",
			source: "local worker",
		};
	});
	root.replaceChildren(
		el(
			"div",
			{ class: "grid cols-2" },
			el(
				"div",
				{ class: "card" },
				el("h3", {}, "Runner"),
				el(
					"p",
					{ class: "hint" },
					snapshot.runner?.running
						? `Dispatching since ${new Date(snapshot.runner.startedAt).toLocaleString()}`
						: "Runner stopped",
				),
				el(
					"div",
					{ class: "form-row" },
					el("button", { class: "primary", onclick: () => send("runner.start") }, "Start runner"),
					el("button", { class: "danger", onclick: () => send("runner.stop") }, "Stop runner"),
				),
				el(
					"p",
					{ class: "hint" },
					"Stop ends dispatch in this console only; leases expire and any runner can recover tasks.",
				),
			),
			addAgentForm(snapshot),
		),
		el(
			"h3",
			{ style: "margin:18px 0 0;color:var(--text-dim);font-size:12px;text-transform:uppercase;letter-spacing:.6px" },
			"Agents",
		),
		el("div", { class: "grid cols-4" }, ...[...workers, ...members].map(agentCard)),
	);
}

export function render(container) {
	root = el("div", {});
	container.append(root);
	rerender();
	off.push(bus.on("snapshot", rerender));
	off.push(bus.on("agents", rerender));
}

export function destroy() {
	for (const fn of off.splice(0)) fn();
	closeModal();
	root = null;
}
