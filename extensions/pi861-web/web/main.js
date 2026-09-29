// Console bootstrap: router, nav, connection UI, toasts.
import { bus, connect, el, setToken, store } from "./core.js";
import * as agents from "./pages/agents.js";
import * as chat from "./pages/chat.js";
import * as goals from "./pages/goals.js";
import * as models from "./pages/models.js";
import * as settings from "./pages/settings.js";

const PAGES = {
	chat: { title: "Chat", module: chat },
	goals: { title: "Goals", module: goals },
	agents: { title: "Agents", module: agents },
	models: { title: "Models", module: models },
	settings: { title: "Settings", module: settings },
};

const content = document.getElementById("content");
let currentPage = null;

function route() {
	const name = (location.hash.replace(/^#\//, "") || "chat").split("?")[0];
	const page = PAGES[name] ?? PAGES.chat;
	for (const link of document.querySelectorAll("[data-nav]"))
		link.classList.toggle("active", link.dataset.nav === name);
	document.getElementById("page-title").textContent = page.title;
	currentPage?.destroy?.();
	content.replaceChildren();
	currentPage = page.module;
	page.module.render(content);
}

window.addEventListener("hashchange", route);

// Topbar state
function topbar() {
	const pill = document.getElementById("conn-pill");
	pill.textContent = store.connected ? "online" : "offline";
	pill.className = `pill ${store.connected ? "online" : "offline"}`;
	const snapshot = store.snapshot;
	document.getElementById("top-project").textContent = store.projectId ? `project: ${store.projectId}` : "";
	const goal = snapshot?.goal;
	const goalEl = document.getElementById("top-goal");
	if (goal?.objective) {
		goalEl.replaceChildren(
			el("span", { class: `dot ${goal.status}` }),
			`${goal.status} · ${goal.objective.slice(0, 80)}`,
		);
	} else goalEl.textContent = "";
	document.getElementById("readonly-pill").classList.toggle("hidden", !store.readonly);
	const runnerEl = document.getElementById("runner-pill");
	const running = snapshot?.runner?.running;
	runnerEl.textContent = `runner: ${running ? "dispatching" : "stopped"}`;
	runnerEl.className = `pill ${running ? "online" : "idle"}`;
}

bus.on("connection", topbar);
bus.on("snapshot", topbar);
bus.on("hello", topbar);

// Toasts
bus.on("toast", ({ kind, text }) => {
	const toast = el("div", { class: `toast ${kind ?? ""}` }, text);
	document.getElementById("toasts").append(toast);
	setTimeout(() => toast.remove(), 5000);
});

// Token gate: shown when the server rejects the connection (4401) or on demand.
const unlock = document.getElementById("unlock");
document.getElementById("unlock-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const token = document.getElementById("unlock-token").value.trim();
	setToken(token);
	unlock.classList.add("hidden");
});
bus.on("auth.required", () => unlock.classList.remove("hidden"));
if (!store.token) {
	// First visit with token auth configured will surface 4401 -> auth.required.
	// Without token auth the server is anonymous read-only and connects fine.
}
connect();
route();
