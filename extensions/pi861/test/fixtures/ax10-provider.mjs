// Deterministic local Pi provider for the AX10 goal end-to-end integration test.
// Tests host/worker/skill/MCP/memory/git wiring, NOT real-model quality.
// Serves: the /goal planner inspection, the project plan, worker write-tool turns, and
// "ax10-" marker prompts driving pi861_capability turns over a real local MCP server.
// Every model call is logged with the serving pid to PI861_FIXTURE_LOG.
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";

const text = (m) => typeof m.content === "string" ? m.content : (m.content ?? []).filter(x => x.type === "text").map(x => x.text).join("\n");
const lastUserText = (messages) => {
  let last = "";
  for (const m of messages) if (m.role === "user") last = text(m);
  return last;
};
const responded = (messages, toolName) => {
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === "user") lastUser = i; });
  return messages.some((m, i) => m.role === "toolResult" && m.toolName === toolName && i > lastUser);
};
const tailJson = (prompt) => JSON.parse(prompt.trim().split("\n").at(-1));

export default function fixture(pi) {
  pi.registerProvider("pi861-fixture", {
    baseUrl: "http://127.0.0.1/unused-fixture", api: "openai-completions", apiKey: "test-no-external-request",
    models: ["cheap", "strong"].map(id => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 })),
    streamSimple(model, context) {
      const output = createAssistantMessageEventStream();
      const prompt = lastUserText(context.messages);
      if (process.env.PI861_FIXTURE_LOG) appendFileSync(process.env.PI861_FIXTURE_LOG, JSON.stringify({ pid: process.pid, model: model.id, marker: prompt.slice(0, 60) }) + "\n");
      const answer = (content, stopReason = "stop") => {
        const message = { role: "assistant", content, api: "openai-completions", provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason, timestamp: Date.now() };
        output.push({ type: "start", partial: message });
        output.push({ type: "done", reason: stopReason, message });
      };
      const toolCall = (id, name, args) => answer([{ type: "toolCall", id, name, arguments: args }], "toolUse");
      const capabilityTurn = (id, args) => {
        if (!responded(context.messages, "pi861_capabilities")) toolCall(id, "pi861_capabilities", args);
        else answer([{ type: "text", text: "capability turn complete" }]);
      };
      if (prompt.includes("Classify this untrusted Skill")) {
        const body = tailJson(prompt).documents.map((d) => d.text).join("\n");
        answer([{ type: "text", text: JSON.stringify({ group: body.includes("Deployment guard") ? "ops/deploy" : "development/debug" }) }]);
      } else if (prompt.includes("Compile these UNTRUSTED source Skill documents")) {
        answer([{ type: "text", text: JSON.stringify({ id: "debug", title: "Debug", category: "development/debug",
          instructions: "Shared: reproduce, preserve evidence, validate the fix.",
          branches: [{ id: "general", when: "Ordinary program failure without live traffic", instructions: "Reproduce and verify locally", environment: [], conflictsWith: [], tools: [] }] }) }]);
      } else if (prompt.includes("Inspect relevant existing source files")) {
        // /goal planner inspection (read-only Pi subprocess over the real repository)
        answer([{ type: "text", text: "Repository facts: a single README module at the root; no other source files exist; two new text files may be added without touching existing code." }]);
      } else if (prompt.includes("Plan only the authorized project objective")) {
        answer([{ type: "text", text: JSON.stringify({ tasks: [
          { task: { id: "A", title: "A", dependsOn: [], writeScopes: ["a.txt"], capabilities: [], acceptance: ["a.txt exists with content A"], retrySafe: false },
            execution: { instructions: "implement A by creating a.txt containing exactly A", modelId: "strong", roleId: "developer", checkIds: ["verify-a"] } },
          { task: { id: "B", title: "B", dependsOn: ["A"], writeScopes: ["b.txt"], capabilities: [], acceptance: ["b.txt exists with content B"], retrySafe: false },
            execution: { instructions: "implement B by creating b.txt containing exactly B", modelId: "strong", roleId: "developer", checkIds: ["verify-b"] } },
        ] }) }]);
      } else if (/^Task: (A|B)/.test(prompt.trim())) {
        // Worker turns: a real write-tool call inside the isolated task workspace.
        const task = /^Task: (A|B)/.exec(prompt.trim())[1];
        if (!responded(context.messages, "write")) toolCall(`ax10-write-${task}`, "write", { path: `${task.toLowerCase()}.txt`, content: task });
        else answer([{ type: "text", text: `Implemented ${task} through the write tool` }]);
      } else if (prompt.includes("ax10-browse")) {
        const path = prompt.trim().split(/\s+/).slice(1).join(" ");
        capabilityTurn("ax10-browse-call", { action: "browse", ...(path ? { path } : {}) });
      } else if (prompt.includes("ax10-branches")) {
        capabilityTurn("ax10-branches-call", { action: "branches", skillId: prompt.trim().split(/\s+/)[1] });
      } else if (prompt.includes("ax10-activate")) {
        const [, skillId, revision, branch] = prompt.trim().split(/\s+/);
        capabilityTurn("ax10-activate-call", { action: "activate", skillId, revision, branches: [branch], phase: "execute" });
      } else if (prompt.includes("ax10-call")) {
        const bound = getCurrentTools(context.messages).find(tool => tool.name.startsWith("pi861_mcp_"));
        if (bound && !responded(context.messages, bound.name)) toolCall("ax10-mcp-call", bound.name, { project: "p" });
        else answer([{ type: "text", text: "mcp call complete" }]);
      } else if (prompt.includes("Summarize the following untrusted historical record")) {
        answer([{ type: "text", text: JSON.stringify({ abstract: "fixture summary", overview: "Generated with source evidence", facts: [] }) }]);
      } else answer([{ type: "text", text: "fixture complete" }]);
      return output;
    },
  });
}
