// Settings page: team/slot configuration, storage paths, security info.
import { bus, el, send, store } from "../core.js";

const off = [];
let root = null;

function projectForm(snapshot) {
	const maxConcurrent = el("input", {
		type: "number",
		value: String(snapshot.project.maxConcurrent),
		min: "1",
		max: "16",
	});
	const reviewSlots = el("input", {
		type: "number",
		value: String(snapshot.project.reviewSlots ?? 0),
		min: "0",
		max: "16",
	});
	const maxTasks = el("input", { type: "number", value: String(snapshot.project.maxTasks), min: "1", max: "1000" });
	return el(
		"form",
		{
			class: "card",
			onsubmit: (event) => {
				event.preventDefault();
				send("settings.update", {
					maxConcurrent: Number(maxConcurrent.value),
					reviewSlots: Number(reviewSlots.value),
					maxTasks: Number(maxTasks.value),
				});
			},
		},
		el("h3", {}, "Team & scheduling"),
		el(
			"div",
			{ class: "form-row" },
			el("label", { class: "field" }, el("span", {}, "Concurrent workers"), maxConcurrent),
			el("label", { class: "field" }, el("span", {}, "Review slots"), reviewSlots),
			el("label", { class: "field" }, el("span", {}, "Max tasks"), maxTasks),
		),
		el("p", { class: "hint" }, "Applies to PI861_CONFIG immediately; a running runner restarts on the next start."),
		el("button", { class: "primary", type: "submit" }, "Save"),
	);
}

function infoPanel(snapshot) {
	return el(
		"div",
		{ class: "card" },
		el("h3", {}, "Storage & security"),
		el(
			"dl",
			{ class: "kv" },
			el("dt", {}, "repository"),
			el("dd", {}, snapshot.project.repository),
			el("dt", {}, "worktreeRoot"),
			el("dd", {}, snapshot.project.worktreeRoot),
			el("dt", {}, "checks"),
			el("dd", {}, (snapshot.runner?.checks ?? []).map((c) => c.id).join(", ") || "none"),
			el("dt", {}, "write auth"),
			el("dd", {}, store.readonly ? "read-only (no token)" : "bearer token"),
		),
		el(
			"p",
			{ class: "hint" },
			store.readonly
				? "Set PI861_CONSOLE_TOKEN in the server environment and restart to enable write operations."
				: "Rotate the token by updating PI861_CONSOLE_TOKEN and restarting the console process.",
		),
	);
}

function rerender() {
	if (!root) return;
	const snapshot = store.snapshot;
	if (!snapshot) {
		root.replaceChildren(el("p", { class: "hint" }, "Waiting for project snapshot…"));
		return;
	}
	root.replaceChildren(el("div", { class: "grid cols-2" }, projectForm(snapshot), infoPanel(snapshot)));
}

export function render(container) {
	root = el("div", {});
	container.append(root);
	rerender();
	off.push(bus.on("snapshot", rerender));
}

export function destroy() {
	for (const fn of off.splice(0)) fn();
	root = null;
}
