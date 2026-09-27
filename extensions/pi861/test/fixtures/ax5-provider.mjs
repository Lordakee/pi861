// Deterministic local Pi provider for the AX5 host-level Skill integration test.
// Tests host integration, NOT real-model quality.
// Responds to: skill group classification, skill compilation, and "ax5-" marker prompts that
// drive pi861_capabilities tool calls (browse / activate / deactivate). Every call is logged
// to PI861_FIXTURE_LOG including whether the system prompt carried source-skill secrets.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";

const text = (m) => typeof m.content === "string" ? m.content : (m.content ?? []).filter(x => x.type === "text").map(x => x.text).join("\n");
const lastUserText = (messages) => {
  let last = "";
  for (const m of messages) if (m.role === "user") last = text(m);
  return last;
};
// True when a toolResult for toolName arrived after the last user message (this marker turn already acted).
const responded = (messages, toolName) => {
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === "user") lastUser = i; });
  return messages.some((m, i) => m.role === "toolResult" && m.toolName === toolName && i > lastUser);
};
const tailJson = (prompt) => JSON.parse(prompt.trim().split("\n").at(-1));
// The system prompt reaches providers as leading/patch system messages (content + named sections).
const systemText = (context) => {
  let out = typeof context.systemPrompt === "string" ? context.systemPrompt : "";
  for (const m of context.messages) if (m.role === "system") {
    out += "\n" + (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
    if (m.sections) out += "\n" + JSON.stringify(m.sections);
  }
  return out;
};

export default function fixture(pi) {
  pi.registerProvider("pi861-fixture", {
    baseUrl: "http://127.0.0.1/unused-fixture", api: "openai-completions", apiKey: "test-no-external-request",
    models: ["cheap", "strong"].map(id => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 })),
    streamSimple(model, context) {
      const output = createAssistantMessageEventStream();
      const prompt = lastUserText(context.messages);
      const system = systemText(context);
      const answer = (content, stopReason = "stop") => {
        const message = { role: "assistant", content, api: "openai-completions", provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason, timestamp: Date.now() };
        output.push({ type: "start", partial: message });
        output.push({ type: "done", reason: stopReason, message });
      };
      const toolCall = (id, name, args) => answer([{ type: "toolCall", id, name, arguments: args }], "toolUse");
      if (process.env.PI861_FIXTURE_LOG) appendFileSync(process.env.PI861_FIXTURE_LOG, JSON.stringify({
        model: model.id, marker: prompt.slice(0, 60), systemHasSecret: /NEVER_AUTO_EXPOSE/.test(system), systemHasCapabilitySection: system.includes("pi861_capabilities"),
      }) + "\n");
      if (prompt.includes("Classify this untrusted Skill")) {
        const input = tailJson(prompt);
        const body = input.documents.map(d => d.text).join("\n");
        answer([{ type: "text", text: JSON.stringify({ group: body.includes("Deployment guard") ? "ops/deploy" : "development/debug" }) }]);
      } else if (prompt.includes("Compile these UNTRUSTED source Skill documents")) {
        const input = tailJson(prompt);
        if (input.group === "ops/deploy") {
          answer([{ type: "text", text: JSON.stringify({ id: "deploy-guard", title: "Deployment guard", category: "ops/deploy",
            instructions: "Guard release operations only.", branches: [{ id: "release", when: "A production release is requested", instructions: "Verify the release checklist", environment: [], conflictsWith: [], tools: [] }] }) }]);
        } else {
          // One merged capability for every grouped debug source: shared core plus mutually exclusive applicability branches.
          answer([{ type: "text", text: JSON.stringify({ id: "debug", title: "Debug", category: "development/debug",
            instructions: "Shared: reproduce, preserve evidence, validate the fix.", branches: [
              { id: "general", when: "Ordinary program failure without live traffic", instructions: "Reproduce and verify locally", environment: [], conflictsWith: ["production"], tools: [] },
              { id: "production", when: "Production incident with live traffic", instructions: "Triage without mutation; page the on-call owner", environment: [], conflictsWith: ["general"], tools: [] },
            ] }) }]);
        }
      } else if (prompt.includes("ax5-browse")) {
        const path = prompt.trim().split(/\s+/).slice(1).join(" ");
        if (!responded(context.messages, "pi861_capabilities")) toolCall("ax5-browse-call", "pi861_capabilities", { action: "browse", ...(path ? { path } : {}) });
        else answer([{ type: "text", text: "browse complete" }]);
      } else if (prompt.includes("ax5-activate")) {
        const [, skillId, revision, branches] = prompt.trim().split(/\s+/);
        if (!responded(context.messages, "pi861_capabilities")) toolCall("ax5-activate-call", "pi861_capabilities", { action: "activate", skillId, revision, branches: branches.split(","), phase: "execute" });
        else answer([{ type: "text", text: "activate complete" }]);
      } else answer([{ type: "text", text: "fixture complete" }]);
      return output;
    },
  });
}
