import { isJsonValue, jsonByteLength } from "./json.ts";
import type { JsonValue, RpcChannel } from "./types.ts";

/** Loopback channel with deterministic delivery control and failure injection. */
export interface LoopbackRpcChannel extends RpcChannel {
	/** Deliver all queued inbound messages to this channel's listeners in order. */
	deliver(): void;
	/** Make this channel's next send reject with `reason` and close the pair. */
	failNextSend(reason?: unknown): void;
}

interface LoopbackState {
	readonly messageListeners: Set<(message: unknown) => void>;
	readonly closeListeners: Set<(reason?: unknown) => void>;
	readonly inbound: unknown[];
	failNext: { readonly armed: boolean; readonly reason?: unknown };
	closed: boolean;
}

/**
 * Deterministic in-memory duplex channel pair for tests and local adapters.
 *
 * Messages are delivered in send order through per-direction FIFO queues. With `autoDeliver`
 * disabled, delivery happens only when `deliver()` is called, giving race tests exact control.
 * The pair never bypasses peer envelope validation and never calls handlers directly.
 */
export function createLoopbackRpcChannels(options?: {
	readonly autoDeliver?: boolean;
	readonly maxMessageBytes?: number;
}): readonly [LoopbackRpcChannel, LoopbackRpcChannel] {
	const autoDeliver = options?.autoDeliver ?? true;
	const maxMessageBytes = options?.maxMessageBytes;
	const states: readonly [LoopbackState, LoopbackState] = [createState(), createState()];

	const closeSide = (state: LoopbackState, reason?: unknown): void => {
		if (state.closed) return;
		state.closed = true;
		state.inbound.length = 0;
		for (const listener of [...state.closeListeners]) listener(reason);
	};

	const closeBoth = (reason?: unknown): void => {
		closeSide(states[0], reason);
		closeSide(states[1], reason);
	};

	const deliver = (state: LoopbackState): void => {
		if (state.closed) {
			state.inbound.length = 0;
			return;
		}
		const messages = state.inbound.splice(0);
		for (const message of messages) {
			for (const listener of [...state.messageListeners]) listener(message);
		}
	};

	const channelFor = (index: 0 | 1): LoopbackRpcChannel => {
		const state = states[index];
		return {
			async send(message: JsonValue): Promise<void> {
				if (state.closed) throw new Error("Loopback channel is closed");
				if (state.failNext.armed) {
					const reason = state.failNext.reason;
					state.failNext = { armed: false };
					closeBoth(reason);
					throw reason ?? new Error("Loopback send failed");
				}
				if (!isJsonValue(message)) {
					closeBoth();
					throw new TypeError("Loopback messages must be strict JSON");
				}
				if (maxMessageBytes !== undefined && jsonByteLength(message) > maxMessageBytes) {
					closeBoth();
					throw new Error(`Loopback message exceeds the maximum of ${maxMessageBytes} bytes`);
				}
				const other = states[1 - index];
				other.inbound.push(message);
				if (autoDeliver) queueMicrotask(() => deliver(other));
			},
			onMessage(listener: (message: unknown) => void): () => void {
				state.messageListeners.add(listener);
				return () => {
					state.messageListeners.delete(listener);
				};
			},
			onClose(listener: (reason?: unknown) => void): () => void {
				state.closeListeners.add(listener);
				return () => {
					state.closeListeners.delete(listener);
				};
			},
			close(reason?: unknown): Promise<void> {
				closeBoth(reason);
				return Promise.resolve();
			},
			deliver(): void {
				deliver(state);
			},
			failNextSend(reason?: unknown): void {
				state.failNext = { armed: true, reason };
			},
		};
	};

	return [channelFor(0), channelFor(1)];
}

function createState(): LoopbackState {
	return {
		messageListeners: new Set(),
		closeListeners: new Set(),
		inbound: [],
		failNext: { armed: false },
		closed: false,
	};
}
