import { type Attempt, IncrementBuffer, ModelFailure } from "../routing.ts";
import { record } from "../search.ts";
import type { TransportHooks } from "./deadline.ts";

/** Structural, dependency-free subset of Pi's AssistantMessageEvent stream, so the
 * adapter consumes real Pi streams and hand-built test events without importing the
 * host package. `partial` is deliberately absent: Pi's partial is a shared mutating
 * object, never an event-time snapshot, so it must never be read or retained. */
export type StreamEvent<TMessage> =
	| { type: "start" }
	| { type: "text_start" | "text_end" | "thinking_start" | "thinking_end" | "toolcall_start" }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: unknown }
	| { type: "done"; message: TMessage }
	| { type: "error"; error: TMessage };

/** Terminal message subset the adapter classifies; `content` is structurally gated. */
export interface StreamTerminal {
	stopReason: string;
	errorMessage?: string;
	content?: unknown;
}

/** A tool call that passed the streaming gate. */
export interface GatedToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export interface StreamLimits {
	maxTextChars: number;
	maxToolArgsChars: number;
	maxPendingToolCalls: number;
}
export const DEFAULT_STREAM_LIMITS: StreamLimits = {
	maxTextChars: 2_000_000,
	maxToolArgsChars: 4_000_000,
	maxPendingToolCalls: 128,
};

const contentIndexOf = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
const callKey = (contentIndex: number): string => `content:${contentIndex}`;
function gateToolCall(value: unknown): GatedToolCall {
	const call = record(value);
	if (!call || typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.name)
		throw new ModelFailure("invalid");
	const args = call.arguments;
	if (typeof args !== "object" || args === null || Array.isArray(args))
		throw new ModelFailure("invalid"); // tool arguments must be a JSON object
	return { id: call.id, name: call.name, args: args as Record<string, unknown> };
}
/** The final gate before the host sees the message: every tool call it carries must be
 * structurally dispatchable (JSON object arguments, unique id). Anything else fails the
 * whole attempt; the existing tool schema and permission flow stay the final authority. */
function validateMessageTools(message: StreamTerminal): void {
	const blocks = Array.isArray(message.content) ? message.content : [];
	const seen = new Set<string>();
	for (const block of blocks) {
		const entry = record(block);
		if (!entry || entry.type !== "toolCall") continue;
		const gated = gateToolCall(entry);
		if (seen.has(gated.id)) throw new ModelFailure("invalid");
		seen.add(gated.id);
	}
}

/**
 * Adapts one inference attempt's event stream:
 * - every increment is attributed to the attempt through an IncrementBuffer; late
 *   increments from superseded or invalidated attempts are refused, never errors;
 * - connection and progress hooks fire so attempt deadlines track a streaming response;
 * - tool arguments are gated when the call ends: `toolcall_end.toolCall` is the
 *   authoritative complete argument object, must be a JSON object, and a call may end
 *   only once. Dispatch itself stays at the successful-response boundary: a failed,
 *   truncated or invalidated attempt throws and its output dispatches nothing.
 */
export class StreamAttempt<TMessage extends StreamTerminal> {
	private readonly buffer = new IncrementBuffer();
	private readonly attempt: Attempt;
	private readonly hooks: TransportHooks | undefined;
	private readonly limits: StreamLimits;
	private readonly endedCalls = new Set<number>();
	private readonly pendingCalls = new Set<string>();
	private readonly gated = new Map<string, GatedToolCall>();
	private terminal: { message: TMessage; failed: boolean } | undefined;
	private voided = false;
	private textChars = 0;
	private toolChars = 0;
	constructor(attempt: Attempt, hooks?: TransportHooks, limits: Partial<StreamLimits> = {}) {
		this.attempt = { ...attempt };
		this.hooks = hooks;
		this.limits = { ...DEFAULT_STREAM_LIMITS, ...limits };
	}
	/** Ingests one event; returns the terminal kind once done or error arrived.
	 * Events after the terminal are ignored. Throws ModelFailure on protocol violations. */
	ingest(event: StreamEvent<TMessage>): "done" | "error" | undefined {
		if (this.terminal || this.voided) return undefined;
		switch (event.type) {
			case "start":
				this.hooks?.connected();
				return undefined;
			case "text_delta":
			case "thinking_delta": {
				if (typeof event.delta !== "string") throw new ModelFailure("invalid");
				this.hooks?.progress();
				if (event.type === "text_delta") {
					this.textChars += event.delta.length;
					if (this.textChars > this.limits.maxTextChars) throw new ModelFailure("transient");
					this.buffer.textDelta(this.attempt, event.delta);
				}
				return undefined;
			}
			case "toolcall_delta": {
				if (typeof event.delta !== "string") throw new ModelFailure("invalid");
				const index = contentIndexOf(event.contentIndex);
				if (index === undefined) throw new ModelFailure("invalid");
				this.hooks?.progress();
				if (this.endedCalls.has(index)) return undefined; // fragment after end is refused
				this.toolChars += event.delta.length;
				if (this.toolChars > this.limits.maxToolArgsChars) throw new ModelFailure("transient");
				const key = callKey(index);
				if (this.pendingCalls.size >= this.limits.maxPendingToolCalls && !this.pendingCalls.has(key))
					throw new ModelFailure("transient");
				this.pendingCalls.add(key);
				this.buffer.toolArgs(this.attempt, key, event.delta);
				return undefined;
			}
			case "toolcall_end": {
				const index = contentIndexOf(event.contentIndex);
				if (index === undefined) throw new ModelFailure("invalid");
				this.hooks?.progress();
				if (this.endedCalls.has(index)) throw new ModelFailure("invalid"); // a call may not end twice
				this.endedCalls.add(index);
				const call = gateToolCall(event.toolCall);
				if (this.gated.has(call.id)) throw new ModelFailure("invalid"); // duplicate streamed call id
				this.gated.set(call.id, call);
				// Close the buffer slot so later fragments for this index are refused; the
				// authoritative toolcall_end arguments supersede the accumulated fragments.
				this.buffer.endToolArgs(this.attempt, callKey(index));
				return undefined;
			}
			case "done": {
				validateMessageTools(event.message);
				this.terminal = { message: event.message, failed: false };
				return "done";
			}
			case "error":
				this.terminal = { message: event.error, failed: true };
				return "error";
			default:
				return undefined; // block start/end markers carry no dispatch authority
		}
	}
	/** Terminal classification. Throws when the stream was truncated or the response
	 * failed; the attempt is invalidated so its output never dispatches. */
	finish(signal: AbortSignal, classify: (message: TMessage) => ModelFailure): TMessage {
		signal.throwIfAborted();
		if (!this.terminal) {
			this.invalidate();
			throw new ModelFailure("transient"); // truncated stream: no terminal event ever arrived
		}
		if (this.terminal.failed) {
			this.invalidate();
			throw classify(this.terminal.message);
		}
		return this.terminal.message;
	}
	/** Voids the attempt: every later event from this stream, including toolcall_end,
	 * is refused, so a failed attempt can never gain dispatch authority. */
	invalidate(): void {
		this.voided = true;
		this.buffer.invalidate(this.attempt);
	}
	/** Attempt-attributed text accumulated so far (observability; the final message stays authoritative). */
	view(): { attempt: Attempt | undefined; text: string } {
		return this.buffer.view();
	}
	/** Tool calls that passed the streaming gate, in end order. */
	tools(): GatedToolCall[] {
		return [...this.gated.values()];
	}
}
