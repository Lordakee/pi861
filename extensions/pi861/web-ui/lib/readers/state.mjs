// Read-only snapshot builder. Reads the pi861 state directory JSON files and
// emits a field-whitelisted snapshot: no lease tokens, workspace paths,
// instructions, or memory contents leave this module.
import { readFile } from "node:fs/promises";
import path from "node:path";

async function readJson(stateDir, file) {
  try {
    const data = JSON.parse(
      await readFile(path.join(stateDir, file), "utf8"),
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `${file}: ${err.code ?? err.message}` };
  }
}

function coordinatorView(r) {
  if (!r.ok) return { ok: false, error: r.error };
  const c = r.data;
  const tasks = (c.board?.tasks ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    attempts: t.attempts,
    dependsOn: t.dependsOn ?? [],
    workerId: t.lease?.workerId ?? null,
  }));
  const workers = Object.values(
    tasks.reduce((acc, t) => {
      if (t.status === "running" && t.workerId) {
        acc[t.workerId] = { id: t.workerId, taskId: t.id };
      }
      return acc;
    }, {}),
  );
  return {
    ok: true,
    id: c.id,
    objective: c.objective,
    status: c.status,
    boardVersion: c.board?.version ?? null,
    tasks,
    workers,
  };
}

function eventsView(coordRaw) {
  // Derive events from coordinator receipts; receipts carry no timestamps,
  // so entries are ordered by insertion (newest last) and reversed here.
  if (!coordRaw.ok) return [];
  const receipts = coordRaw.data.receipts ?? {};
  return Object.entries(receipts)
    .map(([intent, r]) => {
      const short = intent.slice(0, 8);
      const result = r.result;
      if (result === null || result === undefined)
        return { kind: "receipt", text: `${short} pending` };
      if (result.task)
        return {
          kind: "task",
          text: `${result.task.id} -> ${result.task.status} (attempt ${result.task.attempts})`,
        };
      if (typeof result.generation === "number")
        return { kind: "board", text: `board generation ${result.generation}` };
      return { kind: "receipt", text: `${short} settled` };
    })
    .reverse()
    .slice(0, 50);
}

function usageView(r) {
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, kinds: r.data.kinds ?? {}, targets: r.data.targets ?? {} };
}

function budgetView(r) {
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, limit: r.data.limit ?? 0, used: r.data.used ?? 0 };
}

function memoryView(r) {
  if (!r.ok) return { ok: false, error: r.error };
  const m = r.data;
  const jobs = m.jobs ?? [];
  const jobsByState = jobs.reduce((acc, j) => {
    acc[j.state] = (acc[j.state] ?? 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    sequence: m.sequence ?? 0,
    itemCount: m.memory?.items?.length ?? 0,
    jobsByState,
  };
}

export async function readSnapshot(stateDir) {
  const [coordRaw, usageRaw, budgetRaw, memoryRaw] = await Promise.all([
    readJson(stateDir, "coordinator.json"),
    readJson(stateDir, "usage.json"),
    readJson(stateDir, "budget.json"),
    readJson(stateDir, "memory.json"),
  ]);
  return {
    updatedAt: new Date().toISOString(),
    coordinator: coordinatorView(coordRaw),
    usage: usageView(usageRaw),
    budget: budgetView(budgetRaw),
    memory: memoryView(memoryRaw),
    events: eventsView(coordRaw),
  };
}
