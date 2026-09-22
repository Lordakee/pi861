import { LineProcess, type ProcessSpec } from "./line-process.ts";
import { record } from "../search.ts";
import { setTimeout as sleep } from "node:timers/promises";

export interface PiRunResult { text: string; messages: Record<string, unknown>[]; toolCalls: number; usage: { input: number; output: number }; }
export class PiRpcSession {
	private readonly process: LineProcess;
	private running = false;
	private readonly waitForSettled: boolean;
	constructor(spec: ProcessSpec, options: { waitForSettled?: boolean } = {}) { this.process = new LineProcess(spec, 16_777_216); this.waitForSettled = options.waitForSettled ?? false; }
	async command(type: string, fields: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		const response = await this.process.request({ ...fields, type }, signal);
		if (response.success !== true) throw new Error(`Pi command rejected: ${type}`);
		return response.data;
	}
	async prompt(message: string, signal: AbortSignal, timeoutMs = 600_000): Promise<PiRunResult> {
		if (this.running) throw new Error("Pi session already has a running prompt");
		this.running = true;
		const effective = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
		const result: PiRunResult = { text: "", messages: [], toolCalls: 0, usage: { input: 0, output: 0 } };
		let resolve!: (result: PiRunResult) => void, reject!: (error: Error) => void;
		const finished = new Promise<PiRunResult>((res, rej) => { resolve = res; reject = rej; });
		// The event can arrive while the acceptance response is still pending.
		finished.catch(() => {});
		const remove = this.process.onEvent((event) => {
			if (event.type === "process_error") reject(new Error("Pi worker exited; reconcile previously dispatched tools"));
			if (event.type === "tool_execution_start") result.toolCalls++;
			if (event.type === "message_end") {
				const current = record(event.message); if (!current) return;
				result.messages.push(current);
				if (current.role === "assistant") {
					const usage = record(current.usage);
					result.usage.input += Number(usage?.input ?? 0); result.usage.output += Number(usage?.output ?? 0);
					result.text = (Array.isArray(current.content) ? current.content : []).map(record).filter((block) => block?.type === "text").map((block) => block?.text ?? "").join("\n");
				}
			}
			if (event.type === "agent_end" && !this.waitForSettled) {
				const messages = Array.isArray(event.messages) ? event.messages.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : result.messages;
				const last = [...messages].reverse().find((item) => item.role === "assistant");
				if (last?.stopReason === "error" || last?.stopReason === "aborted") reject(new Error("Pi inference ended unsuccessfully; task-level automatic replay is disabled"));
				else resolve(result);
			}
		});
		const abort = (): void => { reject(new Error("Pi task interrupted; preserve worktree and reconcile tools")); this.process.close(); };
		effective.addEventListener("abort", abort, { once: true });
		try {
			effective.throwIfAborted();
			await this.command("set_auto_retry", { enabled: false }, effective);
			const previous = this.waitForSettled ? record(await this.command("get_entries", {}, effective)) : undefined;
			await this.command("prompt", { message }, effective);
			if (this.waitForSettled) {
				// The native adapter persists this only at agent_settled, after automatic compaction/queues settle.
				const cursor = typeof previous?.leafId === "string" ? previous.leafId : undefined;
				while (true) {
					effective.throwIfAborted();
					const state = record(await this.command("get_entries", cursor ? { since: cursor } : {}, effective));
					const settled = Array.isArray(state?.entries) ? state.entries.map(record).find(entry => entry?.customType === "pi861.run-settled.v2") : undefined;
					if (settled) {
						const outcome = record(settled.data)?.outcome;
						if (outcome !== "ok") throw new Error("Pi execution did not settle successfully; reconcile prior operations");
						resolve(result); break;
					}
					await Promise.race([sleep(25, undefined, { signal: effective }), finished]);
				}
			}
			return await finished;
		} finally { effective.removeEventListener("abort", abort); remove(); this.running = false; }
	}
	close(): Promise<void> { return this.process.close(); }
}
