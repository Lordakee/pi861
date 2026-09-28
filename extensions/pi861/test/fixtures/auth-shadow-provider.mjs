// Regression fixture for the wrapper credential-shadowing fix (b790cd255):
// the provider's registered apiKey is a sentinel; the managed wrapper must not leak its
// routing placeholder credential into nested target-provider streamSimple calls.
// The faulty model answers HTTP 200 (reported via onResponse) with a 401 JSON error body,
// which the runtime must classify as an auth failure and recover by failover.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
const text = (m) =>
	typeof m.content === "string" ? m.content : (m.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
export default function authShadowFixture(pi) {
	pi.registerProvider("pi861-auth-fixture", {
		baseUrl: "http://127.0.0.1/unused-auth-fixture",
		api: "openai-completions",
		apiKey: "target-registered-key",
		models: ["faulty", "healthy"].map((id) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		})),
		streamSimple(model, context, options) {
			const output = createAssistantMessageEventStream();
			const users = context.messages.filter((m) => m.role === "user");
			const prompt = users.map(text).join("\n");
			if (process.env.PI861_AUTH_LOG)
				appendFileSync(
					process.env.PI861_AUTH_LOG,
					JSON.stringify({ model: model.id, apiKey: options?.apiKey ?? null }) + "\n",
				);
			// The transport succeeds (status 200); the auth rejection lives only in the body.
			options?.onResponse?.({ status: 200, headers: {} }, model);
			const result = {
				role: "assistant",
				content: [{ type: "text", text: "healthy-model-ok" }],
				api: "openai-completions",
				provider: model.provider,
				model: model.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};
			if (model.id === "faulty" && prompt.includes("auth-shadow")) {
				result.content = [];
				result.stopReason = "error";
				result.errorMessage = '{"code":"401","message":"unauthorized"}';
			}
			output.push({ type: "start", partial: result });
			if (result.stopReason === "error") {
				output.push({ type: "error", reason: "error", error: result });
			} else {
				output.push({ type: "text_start", contentIndex: 0, partial: result });
				output.push({ type: "text_delta", contentIndex: 0, delta: "healthy-model-ok", partial: result });
				output.push({ type: "text_end", contentIndex: 0, content: "healthy-model-ok", partial: result });
				output.push({ type: "done", reason: result.stopReason, message: result });
			}
			return output;
		},
	});
}
