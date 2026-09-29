// Models page: registry cards, per-agent assignment matrix, budget and usage.
import { bus, el, send, store } from "../core.js";

const off = [];
let root = null;

function targetCard(target, preferred) {
	const health = target.enabled ? "running" : "idle";
	return el(
		"div",
		{ class: "card" },
		el(
			"div",
			{ style: "display:flex;align-items:center;gap:8px" },
			el("span", { class: `dot ${health}` }),
			el("strong", {}, target.id),
			target.id === preferred ? el("span", { class: "tag" }, "preferred") : null,
			el("span", { class: "spacer" }),
			el(
				"label",
				{ class: "hint", style: "display:flex;align-items:center;gap:6px;margin:0" },
				el("input", {
					type: "checkbox",
					style: "width:auto",
					checked: target.enabled,
					onchange: (event) => send("model.control", { targetId: target.id, enabled: event.target.checked }),
				}),
				"enabled",
			),
		),
		el("p", { class: "hint", style: "margin:10px 0 4px" }, `${target.provider} / ${target.model}`),
		el(
			"p",
			{ class: "hint", style: "margin:0" },
			[
				target.quality !== null ? `quality ${target.quality}` : null,
				target.costRank !== null ? `cost rank ${target.costRank}` : null,
				target.contextWindow ? `${Math.round(target.contextWindow / 1000)}k ctx` : null,
			]
				.filter(Boolean)
				.join(" · "),
		),
	);
}

function assignmentMatrix(snapshot) {
	const targets = snapshot.models?.targets ?? [];
	const ids = ["main", ...(snapshot.team ?? []).map((m) => m.id)];
	return el(
		"table",
		{ class: "table" },
		el("thead", {}, el("tr", {}, el("th", {}, "agent"), ...targets.map((t) => el("th", {}, t.id)))),
		el(
			"tbody",
			{},
			...ids.map((id) => {
				const assignment = snapshot.models?.agentModels?.[id];
				return el(
					"tr",
					{},
					el("td", {}, id),
					...targets.map((target) =>
						el(
							"td",
							{},
							assignment?.primaryId === target.id
								? "primary"
								: (assignment?.fallbackIds ?? []).includes(target.id)
									? "fallback"
									: "—",
						),
					),
				);
			}),
		),
	);
}

function usagePanel(snapshot) {
	const usage = snapshot.usage;
	const budget = snapshot.budget;
	const rows = Object.entries(usage?.targets ?? {});
	const used = budget?.used ?? 0;
	const limit = budget?.limit ?? 0;
	const percent = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
	return el(
		"div",
		{ class: "card" },
		el("h3", {}, "Budget & usage"),
		el("div", { class: "meter" }, el("span", { style: `width:${percent}%` })),
		el("p", { class: "hint" }, `${used} / ${limit} admitted requests (${percent}%)`),
		rows.length
			? el(
					"table",
					{ class: "table" },
					el(
						"thead",
						{},
						el(
							"tr",
							{},
							el("th", {}, "target"),
							el("th", {}, "requests"),
							el("th", {}, "tokens in/out"),
							el("th", {}, "cost"),
						),
					),
					el(
						"tbody",
						{},
						...rows.map(([id, u]) =>
							el(
								"tr",
								{},
								el("td", {}, id),
								el("td", {}, String(u.requests ?? 0)),
								el("td", {}, `${u.inputTokens ?? 0} / ${u.outputTokens ?? 0}`),
								el("td", {}, `$${(u.cost ?? 0).toFixed(5)}`),
							),
						),
					),
				)
			: el("p", { class: "hint" }, "No usage recorded yet."),
	);
}

function rerender() {
	if (!root) return;
	const snapshot = store.snapshot;
	if (!snapshot) {
		root.replaceChildren(el("p", { class: "hint" }, "Waiting for project snapshot…"));
		return;
	}
	root.replaceChildren(
		el(
			"h3",
			{ style: "margin:0 0 12px;color:var(--text-dim);font-size:12px;text-transform:uppercase;letter-spacing:.6px" },
			"Model registry",
		),
		el(
			"div",
			{ class: "grid cols-4" },
			...(snapshot.models?.targets ?? []).map((t) => targetCard(t, snapshot.models?.preferred)),
		),
		el("div", { class: "card" }, el("h3", {}, "Assignments"), assignmentMatrix(snapshot)),
		usagePanel(snapshot),
	);
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
