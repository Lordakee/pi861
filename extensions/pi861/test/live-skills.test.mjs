import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FileStateStore } from "../src/live/store.ts";
import { SkillRepository, emptySkillState } from "../src/live/skill-repository.ts";
import { controlledToolCapture } from "../src/memory.ts";
import { McpClient } from "../src/live/mcp.ts";
import { installCapabilities } from "../src/live/skills-host.ts";
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi861-skill-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source"); mkdirSync(source); writeFileSync(join(source, "SKILL.md"), "---\nname: debug\ndescription: NEVER_AUTO_EXPOSE_ORIGINAL\n---\nRead the error. Preserve evidence. Validate the fix.");
  return { directory, source, repo: new SkillRepository(new FileStateStore(join(directory, "skills.json"), emptySkillState())) };
}
const compiler = { async compile(input) { assert.ok(input.documents.some(d => d.content.includes("Preserve evidence"))); return { id: "debug", revision: "tmp", title: "Debug", category: "development/debug", instructions: "Preserve evidence and validate fixes.", sources: [], branches: [{ id: "general", when: "Program failure; not unrelated research", instructions: "Reproduce, diagnose and verify", environment: [], conflictsWith: [], tools: [] }] }; } };
test("install archives full bytes; updates include changed scripts", async t => {
  const { repo, source } = setup(t); writeFileSync(join(source, "script.py"), "print('one')");
  const first = await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  writeFileSync(join(source, "script.py"), "print('two')");
  const second = await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  assert.notEqual(first.revision, second.revision);
  assert.match(Buffer.from((await repo.original("a", first.revision)).files.find(f => f.path === "script.py").base64, "base64").toString(), /one/);
});
test("source is not discoverable until a candidate passes trusted publication", async t => {
  const { repo, source } = setup(t), role = { id: "dev", skillIds: ["debug"], grants: [] };
  await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  assert.deepEqual((await repo.browse(role)).skills, []);
  const candidate = await repo.compile("debug", compiler, new AbortController().signal);
  assert.equal((await repo.catalog()).browse(role).length, 0);
  await assert.rejects(repo.publish(candidate.id, async () => ({ passed: false, evidence: [] })), /validation|evidence/i);
  await repo.publish(candidate.id, async () => ({ passed: true, evidence: ["structural:fixture-schema", "test:passed"] }));
  assert.deepEqual((await repo.browse(role)).categories, ["development"]);
  assert.equal((await repo.browse(role, "development/debug")).skills[0].id, "debug");
  assert.ok(!JSON.stringify(await repo.browse(role)).includes("NEVER_AUTO_EXPOSE"));
});
test("source changing during compilation rejects the stale candidate", async t => {
  const { repo, source } = setup(t); await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  await assert.rejects(repo.compile("debug", { async compile(input) {
    writeFileSync(join(source, "new.md"), "new requirements"); await repo.install(source, { id: "a", revision: "auto", group: "debug" }); return compiler.compile(input);
  } }, new AbortController().signal), /changed/);
});
test("symbolic links are not traversed during Skill installation", async t => {
  const { repo, source } = setup(t); symlinkSync("/tmp", join(source, "outside"));
  await assert.rejects(repo.install(source, { id: "a", revision: "auto", group: "debug" }), /symlinks/);
});
// R4.7: a regular file with a second hard link must be rejected instead of archived.
test("hard-linked files are rejected during Skill installation", async t => {
  const { repo, source } = setup(t); writeFileSync(join(source, "shared.txt"), "hard-linked content");
  try { linkSync(join(source, "shared.txt"), join(source, "alias.txt")); }
  catch { return t.skip("platform does not support hard links"); }
  await assert.rejects(repo.install(source, { id: "a", revision: "auto", group: "debug" }), /hard link/);
  rmSync(join(source, "alias.txt"));
  const restored = await repo.install(source, { id: "a", revision: "auto", group: "debug" });  // single-link file installs normally
  assert.ok(restored.files.some(file => file.path === "shared.txt"));
});

// R6.7: controlled results persist under an explicit owner; reads re-check current authorization
// so the reference id alone is never a bearer token.
test("controlled results page for their owner and deny revoked or foreign identities (R6.7)", async t => {
  const { repo } = setup(t);
  const binding = { toolId: "local/lookup", accountId: "a", resourceId: "project:p", schemaHash: "h", phase: "execute" };
  const ref = await repo.storeResult({ value: "x".repeat(20_000) }, { owner: "principal", tenantId: "t1", principalId: "main", roleId: "developer", toolName: "bash", toolCallId: "call-9" });
  const reader = { tenantId: "t1", principalId: "main", role: { id: "developer", skillIds: [], grants: [] } };
  const first = await repo.readResult(ref, reader);
  assert.equal(first.complete, false);                    // paged, not whole
  assert.ok(first.totalCharacters > 16_000);
  const last = await repo.readResult(ref, reader, first.nextOffset);
  assert.equal(last.complete, true);
  await assert.rejects(repo.readResult(ref, { ...reader, principalId: "other" }), /not found/);   // other principal
  await assert.rejects(repo.readResult(ref, { ...reader, role: { id: "reviewer", skillIds: [], grants: [] } }), /not found/);  // role switched/revoked
  await assert.rejects(repo.readResult(ref, { role: reader.role }), /not found/);  // missing identity is not a bearer bypass
  const skillRef = await repo.storeResult({ rows: 1 }, { owner: "skill", roleId: "developer", skillId: "debug", binding });
  const role = { id: "developer", skillIds: ["debug"], grants: [{ toolId: binding.toolId, accountId: "a", resourceIds: ["project:p"] }] };
  assert.match(JSON.stringify(await repo.readResult(skillRef, { role })), /rows/);
  await assert.rejects(repo.readResult(skillRef, { role: { ...role, grants: [] } }), /not found/);      // grant revoked -> immediate deny
  await assert.rejects(repo.readResult(skillRef, { role: { id: "developer", skillIds: [], grants: role.grants } }), /not found/);  // Skill revoked -> immediate deny
});
test("controlled tool capture persists raw output through the repository under the caller identity (R6.7)", async t => {
  const { repo, directory } = setup(t);
  const secret = 'api_key = "sk-abcdefghijklmnopqrstuvwxyz1234"';
  const capture = await controlledToolCapture({ toolName: "bash", toolCallId: "call-3", content: JSON.stringify({ tool: "bash", result: `config: ${secret}`, isError: false }), id: "t3", scope: "project:p1",
    saveRaw: raw => repo.storeResult(JSON.parse(raw), { owner: "principal", tenantId: "t1", principalId: "main", roleId: "dev", toolName: "bash", toolCallId: "call-3" }) });
  assert.equal(capture.stored, "controlled");
  assert.ok(!JSON.stringify(capture.item).includes(secret));  // the memory item stays digest-only
  const reopened = new SkillRepository(new FileStateStore(join(directory, "skills.json"), emptySkillState()));  // persisted, not in-process
  const page = await reopened.readResult(capture.reference.resultRef, { tenantId: "t1", principalId: "main", role: { id: "dev", skillIds: [], grants: [] } });
  assert.match(page.text, /sk-abcde/);                      // the raw copy is readable only through the controlled store
});
test("Skill activation registers real MCP tools lazily and enforces current grants", async t => {
  const { repo } = setup(t);
  const client = new McpClient({ id: "local", accountId: "a", transport: { kind: "stdio", process: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))], cwd: process.cwd() } } });
  t.after(() => client.close());
  const metadata = await client.tools(new AbortController().signal);
  const binding = { toolId: "local/lookup", accountId: "a", resourceId: "project:p", schemaHash: metadata[0].schemaHash, phase: "execute" };
  const id = await repo.publishMcp("local", "a", metadata, [binding]);
  let role = { id: "developer", skillIds: [id], grants: [{ toolId: binding.toolId, accountId: "a", resourceIds: ["project:p"] }] };
  const handlers = new Map(), tools = new Map(), entries = []; let active = ["read"];
  const host = { getActiveTools: () => active, setActiveTools: v => { active = v; },
    registerTool: tool => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn), appendEntry: (type, data) => entries.push({ type, data }) };
  const cap = installCapabilities(host, { repository: repo, role: () => role, clients: [client], environment: [], resourceRules: [{ ...binding, equals: { project: "p" } }] });
  t.after(() => cap.close());
  assert.ok(!active.some(name => name.startsWith("pi861_mcp_")));
  const catalog = await repo.catalog(), published = catalog.browse(role)[0], branch = catalog.branches(role, id)[0];
  await tools.get("pi861_capabilities").execute("act", { action: "activate", skillId: id, revision: published.revision, branches: [branch.id], phase: "execute" });
  const name = active.find(name => name.startsWith("pi861_mcp_")); assert.ok(name);
  const result = await tools.get(name).execute("one", { project: "p" }); assert.match(result.content[0].text, /looked up p/);
  await assert.rejects(tools.get(name).execute("two", { project: "other" }), /authorization/);
  role = { ...role, grants: [] };
  await assert.rejects(tools.get(name).execute("three", { project: "p" }), /authorized/);
  const prompt = { systemPromptOptions: { skills: [{ description: "NEVER_AUTO_EXPOSE" }], sections: {} } };
  await handlers.get("before_agent_start")(prompt); assert.deepEqual(prompt.systemPromptOptions.skills, []);
});

test("capability factory does not call unbound Pi action methods",()=>{
 const commands=new Map();const host={registerTool(){},on(name,handler){commands.set(name,handler);},appendEntry(){},getActiveTools(){throw new Error("not bound");},setActiveTools(){throw new Error("not bound");}};
 assert.doesNotThrow(()=>installCapabilities(host,{repository:{},role:()=>({id:"r",skillIds:[],grants:[]}),clients:[],environment:[],resourceRules:[]}));
});

test("installAuto classifies the group from full documents and reports related sources (R4.3)", async t => {
  const { repo, source, directory } = setup(t);
  const seen = [];
  const classify = async (draft, groups) => {
    seen.push({ documents: draft.files.map((file) => file.path), groups: [...groups], body: Buffer.from(draft.files[0].base64, "base64").toString("utf8") });
    return "development/debug";
  };
  const first = await repo.installAuto(source, { id: "a", revision: "auto" }, classify, new AbortController().signal);
  assert.equal(first.source.group, "development/debug");
  assert.deepEqual(first.related, []);
  assert.ok(seen[0].documents.includes("SKILL.md"));
  assert.match(seen[0].body, /Preserve evidence/); // the classifier sees full source bytes, not just descriptions
  const secondDir = join(directory, "debug2"); mkdirSync(secondDir);
  writeFileSync(join(secondDir, "SKILL.md"), "---\nname: debug2\ndescription: another generic debugger\n---\nRead the error. Preserve evidence.");
  const second = await repo.installAuto(secondDir, { id: "b" }, classify, new AbortController().signal);
  assert.equal(second.source.group, "development/debug");
  assert.deepEqual(second.related.map((item) => item.id), ["a"]); // related installed Skill found automatically
  assert.deepEqual(seen[1].groups, ["development/debug"]);
  const overridden = await repo.installAuto(secondDir, { id: "c" }, async () => { throw new Error("classifier must not run"); }, new AbortController().signal, { group: "ops/oncall" });
  assert.equal(overridden.source.group, "ops/oncall"); // manual group remains an override
  await assert.rejects(repo.installAuto(secondDir, { id: "bad" }, async () => "../escape", new AbortController().signal), /group/);
});
test("two generic debug sources compile into one deduplicated Skill with mutually exclusive branches (AX5)", async t => {
  const { repo, source, directory } = setup(t);
  await repo.installAuto(source, { id: "a" }, async () => "development/debug", new AbortController().signal);
  const secondDir = join(directory, "debug2"); mkdirSync(secondDir);
  writeFileSync(join(secondDir, "SKILL.md"), "Generic debug procedure; production incidents need a distinct runbook phase.");
  await repo.installAuto(secondDir, { id: "b" }, async () => "development/debug", new AbortController().signal);
  let input;
  const dedupCompiler = { async compile(value) {
    input = value;
    return { id: "debug", revision: "tmp", title: "Debug", category: "development/debug",
      instructions: "Shared: reproduce, preserve evidence, validate the fix.", sources: [],
      branches: [
        { id: "general", when: "Ordinary program failure without live traffic", instructions: "Reproduce and verify", environment: [], conflictsWith: ["production"], tools: [] },
        { id: "production", when: "Production incident with live traffic", instructions: "Triage without mutation", environment: [], conflictsWith: ["general"], tools: [] },
      ] };
  } };
  const candidate = await repo.compile("development/debug", dedupCompiler, new AbortController().signal);
  assert.equal(input.sources.length, 2); // both grouped sources enter ONE compile
  assert.ok(input.documents.some((doc) => doc.sourceId === "a" && doc.content.includes("Preserve evidence")));
  assert.ok(input.documents.some((doc) => doc.sourceId === "b"));
  await repo.publish(candidate.id, async () => ({ passed: true, evidence: ["structural:branch-contracts", "behavioral:fixture-run"] }));
  const role = { id: "dev", skillIds: ["debug"], grants: [] };
  assert.equal((await repo.browse(role, "development/debug")).skills.length, 1); // one runtime capability, not two
  const catalog = await repo.catalog();
  assert.throws(() => catalog.activate(role, "debug", candidate.skill.revision, ["general", "production"], "execute", [], []), /Conflicting/); // differences expressed as exclusive branches
});
test("compile carries approved tool bindings and rejects unapproved ones (R4.6)", async t => {
  const { repo, source } = setup(t);
  await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  const approved = [{ toolId: "local/lookup", accountId: "a", resourceId: "project:p", schemaHash: "h1", phase: "execute" }];
  let input;
  const compiler = { async compile(value) {
    input = value;
    return { id: "debug", revision: "tmp", title: "Debug", category: "development/debug", instructions: "Use the bound lookup only.", sources: [],
      branches: [{ id: "main", when: "Always", instructions: "Look up", environment: [], conflictsWith: [], tools: [approved[0]] }] };
  } };
  const candidate = await repo.compile("debug", compiler, new AbortController().signal, approved);
  assert.deepEqual(input.bindings, approved); // typed channel reaches the compiler
  assert.ok(input.documents.some((doc) => doc.path === "approved-tool-bindings.json" && doc.content.includes("local/lookup"))); // prompt-visible channel
  const rogue = { async compile() {
    return { id: "debug", revision: "tmp", title: "Debug", category: "development/debug", instructions: "Escalate.", sources: [],
      branches: [{ id: "main", when: "Always", instructions: "Invented binding", environment: [], conflictsWith: [],
        tools: [{ toolId: "local/admin", accountId: "a", resourceId: "project:p", schemaHash: "h1", phase: "execute" }] }] };
  } };
  await assert.rejects(repo.compile("debug", rogue, new AbortController().signal, approved), /not approved/);
  assert.equal(candidate.skill.branches[0].tools.length, 1);
});
test("publication requires distinct evidence kinds and records them (R4.9)", async t => {
  const { repo, source } = setup(t);
  await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  const candidate = await repo.compile("debug", compiler, new AbortController().signal);
  await assert.rejects(repo.publish(candidate.id, async () => ({ passed: true, evidence: ["user-reviewed:legacy-only"] })), /structural/);
  await assert.rejects(repo.publish(candidate.id, async () => ({ passed: true, evidence: ["structural:only"] })), /behavioral or human/);
  await assert.rejects(repo.publish(candidate.id, async () => ({ passed: true, evidence: ["mysterious:vibes"] })), /kind prefix/);
  await repo.publish(candidate.id, async () => ({ passed: true, evidence: [
    "structural:branch-contracts-validated",
    { kind: "behavioral", detail: "fixture run reproduced and validated the procedure" },
    { kind: "human-acceptance", detail: "operator accepted the runbook" },
  ] }));
  const recorded = await repo.candidate(candidate.id);
  assert.equal(recorded.state, "published");
  assert.deepEqual(recorded.checks.map((item) => item.kind).sort(), ["behavioral", "human-acceptance", "structural"]);
  assert.ok(recorded.checks.every((item) => Number.isInteger(item.at)));
});
test("uninstall removes the source, candidates and derived runtime versions (R4.10)", async t => {
  const { repo, source } = setup(t);
  await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  const candidate = await repo.compile("debug", compiler, new AbortController().signal);
  await repo.publish(candidate.id, async () => ({ passed: true, evidence: ["structural:fixture", "test:passed"] }));
  const role = { id: "dev", skillIds: ["debug"], grants: [] };
  assert.equal((await repo.browse(role, "development/debug")).skills.length, 1);
  const summary = await repo.uninstall("a");
  assert.equal(summary.removedSources.length, 1);
  assert.deepEqual(summary.removedVersions.map((item) => item.id), ["debug"]);
  assert.deepEqual((await repo.browse(role, "development/debug")).skills, []);
  assert.equal(await repo.original("a", summary.removedSources[0]), undefined);
  await repo.catalog(); // repository state stays consistent for later publications
  await assert.rejects(repo.uninstall("never-installed"), /Unknown/);
});
test("affected rebuild flags published versions whose source set changed (R4.10)", async t => {
  const { repo, source, directory } = setup(t);
  await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  const candidate = await repo.compile("debug", compiler, new AbortController().signal);
  await repo.publish(candidate.id, async () => ({ passed: true, evidence: ["structural:fixture", "test:passed"] }));
  assert.deepEqual(await repo.staleVersions(), []);
  const secondDir = join(directory, "debug2"); mkdirSync(secondDir);
  writeFileSync(join(secondDir, "SKILL.md"), "Additional debug requirements.");
  await repo.install(secondDir, { id: "b", revision: "auto", group: "debug" });
  const stale = await repo.staleVersions();
  assert.deepEqual(stale.map((item) => item.skillId), ["debug"]); // affected rebuild needed
  const rebuilt = await repo.compile("debug", compiler, new AbortController().signal);
  await repo.publish(rebuilt.id, async () => ({ passed: true, evidence: ["structural:fixture", "test:passed"] }));
  const staleAfter = await repo.staleVersions();
  assert.ok(!staleAfter.some((item) => item.revision === rebuilt.skill.revision)); // fresh version is not stale
});
test("updates do not replace a running activation; both revisions stay resolvable (R4.10)", async t => {
  const { repo, directory } = setup(t);
  const client = new McpClient({ id: "local", accountId: "a", transport: { kind: "stdio", process: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))], cwd: process.cwd() } } });
  t.after(() => client.close());
  const metadata = await client.tools(new AbortController().signal);
  const base = { toolId: "local/lookup", accountId: "a", resourceId: "project:p1", schemaHash: metadata[0].schemaHash, phase: "execute" };
  const id = await repo.publishMcp("local", "a", metadata, [base]);
  let role = { id: "developer", skillIds: [id], grants: [{ toolId: base.toolId, accountId: "a", resourceIds: ["project:p1"] }] };
  const handlers = new Map(), tools = new Map(); let active = ["read"];
  const host = { getActiveTools: () => active, setActiveTools: (v) => { active = v; }, registerTool: (tool) => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn), appendEntry: () => {} };
  const cap = installCapabilities(host, { repository: repo, role: () => role, clients: [client], environment: [], resourceRules: [{ ...base, equals: { project: "p1" } }] });
  t.after(() => cap.close());
  const cap2 = tools.get("pi861_capabilities");
  const publishedRevision = () => repo.catalog().then((catalog) => catalog.browse(role)[0].revision);
  const activation1 = JSON.parse((await cap2.execute("pin1", { action: "activate", skillId: id, revision: await publishedRevision(), branches: (await repo.catalog()).branches(role, id).map((b) => b.id), phase: "execute" })).content[0].text);
  const name1 = active.find((n) => n.startsWith("pi861_mcp_"));
  const second = { ...base, resourceId: "project:p2" };
  await repo.publishMcp("local", "a", metadata, [base, second]); // update: new published revision
  const activeRevision = await publishedRevision();
  assert.notEqual(activation1.skillRevision, activeRevision); // browse moved on
  assert.match((await tools.get(name1).execute("pin2", { project: "p1" })).content[0].text, /looked up p1/); // running activation still works, pinned to its revision
  await repo.bindingPlan(id, activation1.skillRevision, activation1.branchIds, "execute", role, []); // old revision stays resolvable
  await repo.rollback(id, activation1.skillRevision);
  await repo.bindingPlan(id, activeRevision, (await repo.catalog()).branches(role, id).map((b) => b.id), "execute", role, []); // rollback does not delete versions
  assert.match((await tools.get(name1).execute("pin3", { project: "p1" })).content[0].text, /looked up p1/);
});
test("same tool bound to two resources keeps distinct metadata and closures (R5.5)", async t => {
  const { repo, directory } = setup(t);
  const client = new McpClient({ id: "local", accountId: "a", transport: { kind: "stdio", process: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))], cwd: process.cwd() } } });
  t.after(() => client.close());
  const metadata = await client.tools(new AbortController().signal);
  const p1 = { toolId: "local/lookup", accountId: "a", resourceId: "project:p1", schemaHash: metadata[0].schemaHash, phase: "execute" };
  const p2 = { ...p1, resourceId: "project:p2" };
  const id = await repo.publishMcp("local", "a", metadata, [p1, p2]);
  const role = { id: "developer", skillIds: [id], grants: [{ toolId: "local/lookup", accountId: "a", resourceIds: ["project:p1", "project:p2"] }] };
  const handlers = new Map(), tools = new Map(); let active = ["read"];
  const host = { getActiveTools: () => active, setActiveTools: (v) => { active = v; }, registerTool: (tool) => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn), appendEntry: () => {} };
  const cap = installCapabilities(host, { repository: repo, role: () => role, clients: [client], environment: [],
    resourceRules: [{ ...p1, equals: { project: "p1" } }, { ...p2, equals: { project: "p2" } }] });
  t.after(() => cap.close());
  const statePath = join(directory, "skills.json");
  const before = readFileSync(statePath, "utf8");
  const capTool = tools.get("pi861_capabilities");
  await capTool.execute("r55-browse", { action: "browse" });
  await capTool.execute("r55-branches", { action: "branches", skillId: id });
  const branches = (await repo.catalog()).branches(role, id).map((b) => b.id);
  assert.equal(branches.length, 2);
  const current = (await repo.catalog()).browse(role)[0].revision;
  await capTool.execute("r55-activate", { action: "activate", skillId: id, revision: current, branches, phase: "execute" });
  await capTool.execute("r55-deactivate", { action: "deactivate", skillId: id });
  assert.equal(readFileSync(statePath, "utf8"), before); // AX6: browsing and activation cause zero business writes
  await capTool.execute("r55-reactivate", { action: "activate", skillId: id, revision: current, branches, phase: "execute" });
  const names = active.filter((n) => n.startsWith("pi861_mcp_"));
  assert.equal(new Set(names).size, 2); // two distinct registrations for the same toolId
  const outcomes = [];
  for (const name of names) {
    const results = [];
    for (const project of ["p1", "p2"]) {
      try { results.push((await tools.get(name).execute(`${name}-${project}`, { project })).content[0].text); } catch { results.push("blocked"); }
    }
    outcomes.push(results.sort().join("|"));
  }
  assert.ok(outcomes.some((o) => o.includes("looked up p1") && !o.includes("looked up p2")), `each closure serves exactly its own resource: ${JSON.stringify(outcomes)}`);
  assert.ok(outcomes.some((o) => o.includes("looked up p2") && !o.includes("looked up p1")), `each closure serves exactly its own resource: ${JSON.stringify(outcomes)}`);
  assert.ok(outcomes.every((o) => o.includes("blocked")), `the sibling resource stays unauthorized: ${JSON.stringify(outcomes)}`);
});
test("production-isolated mode refuses local transports and endpoint assertions at the capability host (R5.11)", () => {
  const host = { registerTool() {}, on() {}, appendEntry() {}, getActiveTools: () => [], setActiveTools: () => {} };
  const https = new McpClient({ id: "remote", accountId: "a", transport: { kind: "http", url: "https://mcp.example.com/mcp" } });
  const stdio = new McpClient({ id: "local", accountId: "a", transport: { kind: "stdio", process: { command: process.execPath, args: [], cwd: process.cwd() } } });
  const base = { repository: {}, role: () => ({ id: "r", skillIds: [], grants: [] }), environment: [], resourceRules: [] };
  assert.throws(() => installCapabilities(host, { ...base, clients: [stdio], deploymentMode: "production-isolated" }), /HTTPS/);
  assert.throws(() => installCapabilities(host, { ...base, clients: [https], deploymentMode: "production-isolated",
    resourceRules: [{ toolId: "t", accountId: "a", resourceId: "r", endpointConfined: true }] }), /confinement/);
  const closed = installCapabilities(host, { ...base, clients: [https], deploymentMode: "production-isolated" });
  closed.close();
  const local = installCapabilities(host, { ...base, clients: [stdio], resourceRules: [{ toolId: "t", accountId: "a", resourceId: "r", endpointConfined: true }] }); // trusted-local keeps both
  local.close();
});
test("two skills sharing one binding keep independent availability (R5.5 review fix)", async t => {
  const { repo, source, directory } = setup(t);
  const client = new McpClient({ id: "local", accountId: "a", transport: { kind: "stdio", process: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))], cwd: process.cwd() } } });
  t.after(() => client.close());
  const metadata = await client.tools(new AbortController().signal);
  const binding = { toolId: "local/lookup", accountId: "a", resourceId: "project:p1", schemaHash: metadata[0].schemaHash, phase: "execute" };
  const mcpSkill = await repo.publishMcp("local", "a", metadata, [binding]);
  await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  const candidate = await repo.compile("debug", { async compile() {
    return { id: "shared", revision: "tmp", title: "Shared", category: "development/shared", instructions: "Use the bound lookup.", sources: [],
      branches: [{ id: "main", when: "Always", instructions: "Use lookup.", environment: [], conflictsWith: [], tools: [binding] }] };
  } }, new AbortController().signal, [binding]);
  const shared = await repo.publish(candidate.id, async () => ({ passed: true, evidence: ["structural:contract-validated", "behavioral:fixture-run"] }));
  const sharedSkill = shared.id;
  const role = { id: "developer", skillIds: [mcpSkill, sharedSkill], grants: [{ toolId: "local/lookup", accountId: "a", resourceIds: ["project:p1"] }] };
  const handlers = new Map(), tools = new Map(); let active = ["read"];
  const host = { getActiveTools: () => active, setActiveTools: (v) => { active = v; }, registerTool: (tool) => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn), appendEntry: () => {} };
  const cap = installCapabilities(host, { repository: repo, role: () => role, clients: [client], environment: [],
    resourceRules: [{ ...binding, equals: { project: "p1" } }] });
  t.after(() => cap.close());
  const capTool = tools.get("pi861_capabilities");
  const catalog = await repo.catalog();
  const activate = async (skillId) => {
    const branches = catalog.branches(role, skillId).map((b) => b.id);
    const revision = catalog.browse(role).find((s) => s.id === skillId).revision;
    await capTool.execute(`act-${skillId}`, { action: "activate", skillId, revision, branches, phase: "execute" });
  };
  await activate(mcpSkill);
  await activate(sharedSkill);
  const name = active.find((n) => n.startsWith("pi861_mcp_"));
  assert.ok(name, "shared binding registered once");
  await capTool.execute("deact-shared", { action: "deactivate", skillId: sharedSkill });
  assert.ok(active.includes(name), "registration survives sibling deactivation");
  const result = (await tools.get(name).execute("after-deactivation", { project: "p1" })).content[0].text;
  assert.match(result, /looked up p1/);
  void directory;
});
