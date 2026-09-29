// Goals page: goal creation, task kanban, DAG view, task operations.
import { bus, el, escapeHtml, send, store } from "../core.js";

const off = [];
let root = null;

const COLUMNS = [
	["queued", "Queued"],
	["running", "Running"],
	["done", "Done"],
	["blocked", "Blocked"],
];

function taskCard(task) {
	const buttons = [];
	if (task.status === "blocked")
		buttons.push(
			el(
				"button",
				{
					class: "small",
					onclick: (event) => {
						event.stopPropagation();
						send("task.unblock", { taskId: task.id });
					},
				},
				"Requeue",
			),
		);
	if (task.status === "queued")
		buttons.push(
			el(
				"button",
				{
					class: "small danger",
					onclick: (event) => {
						event.stopPropagation();
						send("task.withdraw", {
							expectedVersion: store.snapshot.goal.boardVersion,
							taskIds: [task.id],
						});
					},
				},
				"Withdraw",
			),
			el(
				"button",
				{
					class: "small",
					onclick: (event) => {
						event.stopPropagation();
						editTask(task);
					},
				},
				"Edit",
			),
		);
	return el(
		"div",
		{ class: "task-card", onclick: () => taskDetail(task) },
		el("div", { class: "title" }, el("span", { class: `dot ${task.status}` }), `${task.id} — ${task.title}`),
		el(
			"div",
			{ class: "sub" },
			[
				`attempt ${task.attempts}`,
				task.workerId ? ` · ${task.workerId}` : "",
				task.execution ? ` · ${task.execution.modelId}` : "",
				task.dependsOn.length ? ` · after ${task.dependsOn.join(", ")}` : "",
			].join(""),
		),
		task.reason
			? el("div", { class: "sub", style: "color:var(--error)" }, escapeHtml(task.reason.slice(0, 140)))
			: null,
		el("div", { class: "ops" }, ...buttons),
	);
}

function renderBoard(snapshot) {
	const tasks = snapshot.tasks ?? [];
	return el(
		"div",
		{ class: "board" },
		...COLUMNS.map(([status, label]) => {
			const column = tasks.filter((task) =>
				status === "done" ? task.status === "done" || task.status === "review" : task.status === status,
			);
			return el(
				"div",
				{ class: "column" },
				el("h4", {}, `${label}${status === "done" ? "/Review" : ""}`, el("span", {}, String(column.length))),
				...column.map(taskCard),
			);
		}),
	);
}

/** Layered DAG: node depth = longest dependency chain; edges drawn as elbow curves. */
function renderDag(tasks, onNode) {
	if (!tasks.length) return el("p", { class: "hint" }, "No tasks yet.");
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const depth = new Map();
	const compute = (task) => {
		if (depth.has(task.id)) return depth.get(task.id);
		depth.set(task.id, 0); // cycle guard; coordinator rejects real cycles
		const value = 1 + Math.max(0, ...task.dependsOn.map((id) => compute(byId.get(id) ?? { id, dependsOn: [] })));
		depth.set(task.id, value);
		return value;
	};
	for (const task of tasks) compute(task);
	const maxDepth = Math.max(...[...depth.values()]);
	const layers = Array.from({ length: maxDepth }, () => []);
	for (const task of tasks) layers[depth.get(task.id) - 1].push(task);
	const WIDTH = 190,
		HEIGHT = 62,
		GX = 70,
		GY = 26;
	const width = maxDepth * (WIDTH + GX) + 40;
	const height = Math.max(...layers.map((layer) => layer.length)) * (HEIGHT + GY) + 30;
	const positions = new Map();
	layers.forEach((layer, x) => {
		for (let y = 0; y < layer.length; y++) {
			const task = layer[y];
			positions.set(task.id, { x: 20 + x * (WIDTH + GX), y: 20 + y * (HEIGHT + GY) });
		}
	});
	const svgNS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(svgNS, "svg");
	svg.setAttribute("width", width);
	svg.setAttribute("height", height);
	svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#34343e"/></marker></defs>`;
	for (const task of tasks) {
		const from = positions.get(task.id);
		for (const dep of task.dependsOn) {
			const to = positions.get(dep);
			if (!to || !from) continue;
			const path = document.createElementNS(svgNS, "path");
			const startX = to.x + WIDTH,
				startY = to.y + HEIGHT / 2,
				endX = from.x,
				endY = from.y + HEIGHT / 2,
				midX = (startX + endX) / 2;
			path.setAttribute("d", `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX - 4} ${endY}`);
			path.setAttribute("class", "dag-edge");
			svg.append(path);
		}
	}
	for (const task of tasks) {
		const pos = positions.get(task.id);
		const group = document.createElementNS(svgNS, "g");
		group.setAttribute("class", `dag-node ${task.status}`);
		group.innerHTML =
			`<rect x="${pos.x}" y="${pos.y}" width="${WIDTH}" height="${HEIGHT}" rx="8"></rect>` +
			`<text x="${pos.x + 12}" y="${pos.y + 22}">${escapeHtml(task.id)}</text>` +
			`<text class="sub" x="${pos.x + 12}" y="${pos.y + 38}">${escapeHtml(task.title.slice(0, 26))}</text>` +
			`<text class="sub" x="${pos.x + 12}" y="${pos.y + 52}">${task.status} · a${task.attempts}</text>`;
		group.addEventListener("click", () => onNode?.(task));
		svg.append(group);
	}
	return el("div", { class: "dag-wrap" }, svg);
}

function taskDetail(task) {
	const body = el(
		"div",
		{ class: "modal-body" },
		el(
			"dl",
			{ class: "kv" },
			el("dt", {}, "id"),
			el("dd", {}, task.id),
			el("dt", {}, "title"),
			el("dd", {}, task.title),
			el("dt", {}, "status"),
			el("dd", {}, `${task.status} (attempt ${task.attempts})`),
			el("dt", {}, "dependsOn"),
			el("dd", {}, task.dependsOn.join(", ") || "—"),
			el("dt", {}, "writeScopes"),
			el("dd", {}, task.writeScopes.join(", ")),
			el("dt", {}, "worker"),
			el("dd", {}, task.workerId ?? "—"),
			el("dt", {}, "acceptance"),
			el("dd", {}, task.acceptance.map(escapeHtml).join("; ")),
			el("dt", {}, "evidence"),
			el("dd", {}, `${task.evidenceCount} entries`),
		),
		task.execution
			? el(
					"div",
					{},
					el("h3", { style: "color:var(--text-faint);font-size:12px;text-transform:uppercase" }, "Instructions"),
					el("pre", {}, escapeHtml(task.execution.instructions)),
					el(
						"p",
						{ class: "hint" },
						`model: ${task.execution.modelId} · role: ${task.execution.roleId} · checks: ${task.execution.checkIds.join(", ")}`,
					),
				)
			: null,
		task.reason ? el("p", { class: "error" }, escapeHtml(task.reason)) : null,
	);
	if (task.status === "queued")
		body.append(
			el(
				"div",
				{ class: "form-row" },
				el("button", { class: "primary", onclick: () => editTask(task) }, "Edit dependencies/scopes"),
				el(
					"button",
					{
						class: "danger",
						onclick: () => {
							send("task.withdraw", {
								expectedVersion: store.snapshot.goal.boardVersion,
								taskIds: [task.id],
							});
							closeModal();
						},
					},
					"Withdraw",
				),
			),
		);
	if (task.status === "blocked")
		body.append(
			el(
				"button",
				{
					class: "primary",
					onclick: () => {
						send("task.unblock", { taskId: task.id });
						closeModal();
					},
				},
				"Requeue",
			),
		);
	openModal(`${task.id} — ${task.title}`, body);
}

function editTask(task) {
	const deps = el("input", { value: task.dependsOn.join(", "), placeholder: "comma-separated task ids" });
	const scopes = el("input", { value: task.writeScopes.join(", "), placeholder: "comma-separated write scopes" });
	openModal(
		`Edit ${task.id}`,
		el(
			"div",
			{ class: "modal-body" },
			el("label", { class: "field" }, el("span", {}, "Depends on"), deps),
			el("label", { class: "field" }, el("span", {}, "Write scopes"), scopes),
			el(
				"button",
				{
					class: "primary",
					onclick: () => {
						send("task.edit", {
							taskId: task.id,
							dependsOn: deps.value
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean),
							writeScopes: scopes.value
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean),
						});
						closeModal();
					},
				},
				"Save",
			),
		),
	);
}

function goalControls(status) {
	const buttons = [];
	if (status === "active")
		buttons.push(el("button", { onclick: () => send("goal.control", { action: "pause" }) }, "Pause"));
	if (status === "paused")
		buttons.push(
			el("button", { class: "primary", onclick: () => send("goal.control", { action: "resume" }) }, "Resume"),
		);
	if (status === "review")
		buttons.push(
			el("button", { class: "primary", onclick: () => send("goal.control", { action: "accept" }) }, "Accept goal"),
		);
	if (["active", "paused", "review"].includes(status))
		buttons.push(
			el("button", { class: "danger", onclick: () => send("goal.control", { action: "cancel" }) }, "Cancel"),
		);
	return buttons;
}

function createGoalForm(templates) {
	const objective = el("textarea", { placeholder: "What should the team accomplish?" });
	const template = el(
		"select",
		{},
		...Object.entries(templates).map(([id, t]) =>
			el("option", { value: id }, `${t.label} — ${t.tasks.length} task(s)`),
		),
	);
	return el(
		"form",
		{
			class: "card",
			onsubmit: (event) => {
				event.preventDefault();
				send("goal.create", { objective: objective.value, templateId: template.value });
			},
		},
		el("h3", {}, "Create goal"),
		el("label", { class: "field" }, el("span", {}, "Objective"), objective),
		el("label", { class: "field" }, el("span", {}, "Task template"), template),
		el("p", { class: "hint" }, templates[template.value]?.description ?? ""),
		el("button", { class: "primary", type: "submit" }, "Create"),
	);
}

function addTaskForm(snapshot) {
	const titles = el("input", { placeholder: "Comma-separated task titles" });
	const instructions = el("textarea", { placeholder: "Instructions (shared by appended tasks)" });
	const dependsOn = el("input", { placeholder: "comma-separated task ids" });
	const scopes = el("input", { placeholder: "comma-separated write scopes (default .)" });
	const model = el(
		"select",
		{},
		...(snapshot.models?.targets ?? []).map((t) =>
			el("option", { value: t.id, selected: t.id === snapshot.models?.preferred }, t.id),
		),
	);
	const checks = el(
		"div",
		{ class: "checks" },
		...(snapshot.runner?.checks ?? []).map((check) =>
			el(
				"label",
				{},
				el("input", { type: "checkbox", value: check.id, checked: true, style: "width:auto" }),
				` ${check.id}`,
			),
		),
	);
	return el(
		"form",
		{
			class: "card",
			onsubmit: (event) => {
				event.preventDefault();
				const checkIds = [...checks.querySelectorAll("input:checked")].map((input) => input.value);
				send("task.append", {
					expectedVersion: snapshot.goal.boardVersion,
					tasks: titles.value
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean)
						.map((title) => ({
							title,
							instructions: instructions.value,
							dependsOn: dependsOn.value
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean),
							writeScopes: scopes.value
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean),
							modelId: model.value,
							checkIds,
						})),
				});
			},
		},
		el("h3", {}, "Append tasks (rolling plan)"),
		el("label", { class: "field" }, el("span", {}, "Titles"), titles),
		el("label", { class: "field" }, el("span", {}, "Instructions"), instructions),
		el(
			"div",
			{ class: "form-row" },
			el("label", { class: "field" }, el("span", {}, "Depends on"), dependsOn),
			el("label", { class: "field" }, el("span", {}, "Write scopes"), scopes),
		),
		el("label", { class: "field" }, el("span", {}, "Model"), model),
		el("label", { class: "field" }, el("span", {}, "Validation checks"), checks),
		el("button", { class: "primary", type: "submit" }, "Append"),
	);
}

let modalEl = null;
function openModal(title, body) {
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
	document.body.append(modalEl);
}
function closeModal() {
	modalEl?.remove();
	modalEl = null;
}

function rerender() {
	if (!root) return;
	const snapshot = store.snapshot;
	if (!snapshot) {
		root.replaceChildren(el("p", { class: "hint" }, "Waiting for project snapshot…"));
		return;
	}
	const goal = snapshot.goal;
	const header = el(
		"div",
		{ class: "card" },
		el(
			"div",
			{ style: "display:flex;align-items:center;gap:10px" },
			el("span", { class: `dot ${goal.status}` }),
			el("strong", {}, goal.objective || "(no goal)"),
			el("span", { class: "tag" }, goal.status),
			el("span", { class: "tag" }, `board v${goal.boardVersion}`),
			goal.planOpen ? el("span", { class: "tag" }, "plan open") : null,
			el("span", { class: "spacer" }),
			...goalControls(goal.status),
		),
		goal.reason ? el("p", { class: "hint" }, escapeHtml(goal.reason)) : null,
		snapshot.integrationFailures?.length
			? el(
					"p",
					{ class: "error" },
					`${snapshot.integrationFailures.length} open integration failure(s): ${snapshot.integrationFailures.map((f) => f.taskId).join(", ")}`,
				)
			: null,
		snapshot.accounting
			? el(
					"p",
					{ class: "hint" },
					`slots ${snapshot.accounting.executing}/${snapshot.accounting.slots} executing · ${snapshot.accounting.reviewing} reviewing · ${snapshot.accounting.done} done · ${snapshot.accounting.blocked} blocked`,
				)
			: null,
	);
	root.replaceChildren(
		header,
		el(
			"div",
			{ class: "grid cols-2" },
			["idle", "completed", "cancelled"].includes(goal.status)
				? createGoalForm(store.templates)
				: addTaskForm(snapshot),
			el("div", { class: "card" }, el("h3", {}, "Dependency DAG"), renderDag(snapshot.tasks, taskDetail)),
		),
		el("div", { class: "card" }, el("h3", {}, "Task board"), renderBoard(snapshot)),
	);
}

// Static template catalog mirrored from server templates; refreshed goal forms use it.
store.templates ??= {
	single: { label: "Single task", description: "One implementation task covering the whole repository.", tasks: [{}] },
	staged: {
		label: "Staged: implement then harden",
		description: "Two sequential tasks: implementation, then review/hardening pass.",
		tasks: [{}, {}],
	},
	survey: {
		label: "Survey then implement",
		description: "Read-only survey task, then implementation using the survey as dependency.",
		tasks: [{}, {}],
	},
};

export function render(container) {
	root = el("div", {});
	container.append(root);
	rerender();
	off.push(bus.on("snapshot", rerender));
}

export function destroy() {
	for (const fn of off.splice(0)) fn();
	closeModal();
	root = null;
}
