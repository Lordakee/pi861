const $ = (id) => document.getElementById(id);
const COLUMNS = ["queued", "running", "done", "blocked"];
const fmt = (n) =>
  typeof n === "number" ? n.toLocaleString("en-US") : String(n ?? "-");

function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

function errorNote(section) {
  return `<span class="badge err">read error</span> <span class="muted">${esc(section.error)}</span>`;
}

function renderGoal(c) {
  if (!c.ok) {
    $("goalBody").innerHTML = errorNote(c);
    return;
  }
  const counts = COLUMNS.map(
    (s) => `${s}: ${c.tasks.filter((t) => t.status === s).length}`,
  ).join(" · ");
  $("goalBody").innerHTML = `
    <p class="objective">${esc(c.objective ?? c.id)}</p>
    <div>
      <span class="badge status-${esc(c.status)}">${esc(c.status)}</span>
      <span class="badge">board v${fmt(c.boardVersion)}</span>
      <span class="muted">${esc(counts)}</span>
    </div>`;
}

function renderBoard(c) {
  if (!c.ok) {
    $("board").innerHTML = `<div class="muted">${errorNote(c)}</div>`;
    return;
  }
  $("board").innerHTML = COLUMNS.map((col) => {
    const tasks = c.tasks.filter((t) => t.status === col);
    const cards = tasks
      .map(
        (t) => `<div class="task">
          <div class="task-title">${esc(t.title)}</div>
          <div class="task-meta">
            <code>${esc(t.id)}</code>
            <span>attempt ${fmt(t.attempts)}</span>
            ${t.workerId ? `<span class="badge">${esc(t.workerId)}</span>` : ""}
          </div>
        </div>`,
      )
      .join("");
    return `<div class="col col-${col}">
      <h3>${col} <span class="count">${tasks.length}</span></h3>
      ${cards || `<div class="muted">empty</div>`}
    </div>`;
  }).join("");
}

function renderWorkers(c) {
  if (!c.ok) {
    $("workers").innerHTML = errorNote(c);
    return;
  }
  const rows = c.workers.map(
    (w) =>
      `<div class="worker"><code>${esc(w.id)}</code><span> -> ${esc(w.taskId)} (running)</span></div>`,
  );
  $("workers").innerHTML = rows.length
    ? rows.join("")
    : `<span class="muted">no active workers</span>`;
}

function renderUsage(u) {
  if (!u.ok) {
    $("usage").innerHTML = errorNote(u);
    return;
  }
  const kinds = Object.entries(u.kinds);
  if (!kinds.length) {
    $("usage").innerHTML = `<span class="muted">no usage recorded</span>`;
  } else {
    $("usage").innerHTML = `<table>
      <thead><tr><th>kind</th><th>requests</th><th>in tok</th><th>out tok</th><th>cache R/W</th><th>cost</th></tr></thead>
      <tbody>${kinds
        .map(
          ([kind, v]) => `<tr>
            <td>${esc(kind)}</td><td>${fmt(v.requests)}</td>
            <td>${fmt(v.inputTokens)}</td><td>${fmt(v.outputTokens)}</td>
            <td>${fmt(v.cacheReadTokens)}/${fmt(v.cacheWriteTokens)}</td>
            <td>$${(v.cost ?? 0).toFixed(5)}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table>`;
  }
}

function renderBudget(b) {
  if (!b.ok) {
    $("budget").innerHTML = errorNote(b);
    return;
  }
  const pct = b.limit > 0 ? Math.min(100, (b.used / b.limit) * 100) : 0;
  $("budget").innerHTML = `
    <div class="meter"><div class="meter-fill" style="width:${pct.toFixed(1)}%"></div></div>
    <div class="muted">${fmt(b.used)} / ${fmt(b.limit)} requests (${pct.toFixed(1)}%)</div>`;
}

function renderMemory(m) {
  if (!m.ok) {
    $("memory").innerHTML = errorNote(m);
    return;
  }
  const jobs = Object.entries(m.jobsByState)
    .map(([state, n]) => `<span class="badge">${esc(state)}: ${fmt(n)}</span>`)
    .join(" ");
  $("memory").innerHTML = `
    <div><span class="badge">items: ${fmt(m.itemCount)}</span>
    <span class="badge">seq: ${fmt(m.sequence)}</span></div>
    <div class="muted">extraction jobs: ${jobs || "none"}</div>`;
}

function renderEvents(events) {
  if (!events.length) {
    $("events").innerHTML = `<li class="muted">no events</li>`;
    return;
  }
  $("events").innerHTML = events
    .map(
      (e) =>
        `<li><span class="badge kind-${esc(e.kind)}">${esc(e.kind)}</span> ${esc(e.text)}</li>`,
    )
    .join("");
}

function render(snapshot) {
  renderGoal(snapshot.coordinator);
  renderBoard(snapshot.coordinator);
  renderWorkers(snapshot.coordinator);
  renderUsage(snapshot.usage);
  renderBudget(snapshot.budget);
  renderMemory(snapshot.memory);
  renderEvents(snapshot.events ?? []);
  $("updatedAt").textContent = `updated ${snapshot.updatedAt}`;
}

const conn = $("conn");
const source = new EventSource("/api/stream");
source.onmessage = (e) => {
  conn.textContent = "live";
  conn.className = "badge ok";
  render(JSON.parse(e.data));
};
source.onerror = () => {
  conn.textContent = "reconnecting";
  conn.className = "badge err";
};
