import { BACKGROUND_CONTEXT, createContextKey, withAbortSignal, withContextValue } from "./context/index.ts";
import { isJsonValue, jsonByteLength } from "./json.ts";
import type {
	Context,
	ContextKey,
	JsonValue,
	RpcCancelEnvelope,
	RpcChannel,
	RpcEnvelope,
	RpcError,
	RpcErrorCode,
	RpcHandler,
	RpcNotificationEnvelope,
	RpcNotificationListener,
	RpcPeer,
	RpcPeerOptions,
	RpcRequestEnvelope,
	RpcResponseEnvelope,
} from "./types.ts";

/** Chord RPC protocol version, versioned independently of application envelopes. */
const RPC_PROTOCOL_VERSION = 1;

const RPC_ERROR_CODES: readonly RpcErrorCode[] = [
	"rpc-malformed",
	"rpc-version-mismatch",
	"rpc-cancelled",
	"rpc-peer-disconnected",
	"rpc-handler-missing",
	"rpc-internal",
];

/** Context key carrying one request's opaque strict-JSON metadata on the receiving peer. */
export const RPC_METADATA_CONTEXT_KEY: ContextKey<JsonValue> = createContextKey<JsonValue>("chord.rpc.metadata");

/** Local error for RPC peer operations, protocol violations, and remote error responses. */
export class RpcPeerError extends Error {
	readonly code: RpcErrorCode;

	constructor(code: RpcErrorCode, message: string) {
		super(message);
		this.name = "RpcPeerError";
		this.code = code;
	}
}

/** Validate one decoded RPC message and return it as a typed envelope. */
export function parseRpcEnvelope(value: unknown): RpcEnvelope {
	const envelope = record(value);
	const version = envelope.version;
	if (typeof version === "number") {
		if (version !== RPC_PROTOCOL_VERSION) {
			throw new RpcPeerError("rpc-version-mismatch", `Unsupported RPC protocol version ${version}`);
		}
	} else if (version !== RPC_PROTOCOL_VERSION) {
		throw new RpcPeerError("rpc-malformed", "RPC envelope version must be the number 1");
	}
	switch (envelope.type) {
		case "hello":
			assertKeys(envelope, ["version", "type"], ["metadata"]);
			if (Object.hasOwn(envelope, "metadata")) requireJson(envelope.metadata, "handshake metadata");
			return value as RpcEnvelope;
		case "request":
			assertKeys(envelope, ["version", "type", "id", "method", "args"], ["metadata"]);
			requireId(envelope.id, "request id");
			requireId(envelope.method, "request method");
			if (!Array.isArray(envelope.args))
				throw new RpcPeerError("rpc-malformed", "RPC request args must be an array");
			requireJson(envelope.args, "request args");
			if (Object.hasOwn(envelope, "metadata")) requireJson(envelope.metadata, "request metadata");
			return value as RpcEnvelope;
		case "response": {
			assertKeys(envelope, ["version", "type", "id"], ["result", "error"]);
			requireId(envelope.id, "response id");
			const hasResult = Object.hasOwn(envelope, "result");
			const hasError = Object.hasOwn(envelope, "error");
			if (hasResult && hasError) {
				throw new RpcPeerError("rpc-malformed", "RPC response cannot carry both result and error");
			}
			if (hasResult) requireJson(envelope.result, "response result");
			if (hasError) assertRpcError(envelope.error);
			return value as RpcEnvelope;
		}
		case "cancel":
			assertKeys(envelope, ["version", "type", "id"]);
			requireId(envelope.id, "cancel id");
			return value as RpcEnvelope;
		case "notification":
			assertKeys(envelope, ["version", "type", "method", "payload"]);
			requireId(envelope.method, "notification method");
			requireJson(envelope.payload, "notification payload");
			return value as RpcEnvelope;
		default:
			throw new RpcPeerError("rpc-malformed", "RPC envelope type is invalid");
	}
}

interface PendingCall {
	readonly id: string;
	settled: boolean;
	resolve(value: JsonValue | undefined): void;
	reject(error: unknown): void;
	detach(): void;
}

interface InboundRequest {
	readonly controller: AbortController;
	cancelled: boolean;
}

/** Symmetric RPC peer over one application-supplied duplex channel. */
export class RpcPeerImpl implements RpcPeer {
	readonly #channel: RpcChannel;
	readonly #maxMessageBytes: number | undefined;
	readonly #metadata: JsonValue | undefined;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #handlers = new Map<string, RpcHandler>();
	readonly #listeners = new Map<string, RpcNotificationListener[]>();
	readonly #pending = new Map<string, PendingCall>();
	/** Outbound request IDs cancelled locally; late responses for them are ignored, not protocol errors. */
	readonly #cancelledIds = new Set<string>();
	readonly #inbound = new Map<string, InboundRequest>();
	readonly #seenInboundIds = new Set<string>();
	readonly #notificationQueue: RpcNotificationEnvelope[] = [];
	readonly #removeChannelListeners: () => void;
	#nextId = 0;
	#handshakeReceived = false;
	#closed = false;
	#pumping = false;
	#sendChain: Promise<void> = Promise.resolve();

	constructor(options: RpcPeerOptions) {
		if (options.metadata !== undefined && !isJsonValue(options.metadata)) {
			throw new TypeError("RpcPeerOptions.metadata must be strict JSON");
		}
		this.#channel = options.channel;
		this.#maxMessageBytes = options.maxMessageBytes;
		this.#metadata = options.metadata;
		this.#onError = options.onError;
		const removeMessageListener = this.#channel.onMessage((message) => this.#receive(message));
		const removeCloseListener = this.#channel.onClose((reason) => this.#teardown(reason));
		this.#removeChannelListeners = () => {
			removeMessageListener();
			removeCloseListener();
		};
		this.#enqueueSend(this.#helloEnvelope());
	}

	get closed(): boolean {
		return this.#closed;
	}

	register(method: string, handler: RpcHandler): () => void {
		this.#assertOpen("register a handler");
		if (method.length === 0) throw new TypeError("RPC method name must not be empty");
		if (this.#handlers.has(method)) throw new TypeError(`RPC handler for ${method} is already registered`);
		this.#handlers.set(method, handler);
		return () => {
			if (this.#handlers.get(method) === handler) this.#handlers.delete(method);
		};
	}

	call(method: string, args: readonly JsonValue[], context?: Context): Promise<JsonValue | undefined> {
		if (this.#closed) return Promise.reject(disconnectedError());
		if (method.length === 0) return Promise.reject(new TypeError("RPC method name must not be empty"));
		let argsAreJson = false;
		try {
			argsAreJson = Array.isArray(args) && isJsonValue(args);
		} catch {
			// Revoked proxies and similar pathological inputs throw during inspection; treat as malformed.
			argsAreJson = false;
		}
		if (!argsAreJson) {
			return Promise.reject(new RpcPeerError("rpc-malformed", "RPC arguments are not strict JSON"));
		}
		const signal = context?.abortSignal;
		if (signal?.aborted) {
			return Promise.reject(
				new RpcPeerError("rpc-cancelled", `RPC call ${method} was cancelled before it was sent`),
			);
		}
		const id = `${++this.#nextId}`;
		const pending: PendingCall = {
			id,
			settled: false,
			resolve: () => {},
			reject: () => {},
			detach: () => {},
		};
		const promise = new Promise<JsonValue | undefined>((resolve, reject) => {
			pending.resolve = resolve;
			pending.reject = reject;
		});
		if (signal !== undefined) {
			const onAbort = (): void => {
				if (pending.settled || this.#pending.get(id) !== pending) return;
				pending.settled = true;
				this.#pending.delete(id);
				this.#cancelledIds.add(id);
				pending.reject(new RpcPeerError("rpc-cancelled", `RPC call ${method} was cancelled`));
				void this.#enqueueSend({ version: RPC_PROTOCOL_VERSION, type: "cancel", id }).catch(() => {});
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending.detach = () => signal.removeEventListener("abort", onAbort);
		}
		this.#pending.set(id, pending);
		void this.#enqueueSend(this.#requestEnvelope(id, method, args)).catch(() => {});
		return promise;
	}

	subscribe(method: string, listener: RpcNotificationListener): () => void {
		this.#assertOpen("subscribe");
		if (method.length === 0) throw new TypeError("RPC method name must not be empty");
		const listeners = this.#listeners.get(method) ?? [];
		listeners.push(listener);
		this.#listeners.set(method, listeners);
		return () => {
			const current = this.#listeners.get(method);
			if (current === undefined) return;
			const index = current.indexOf(listener);
			if (index >= 0) current.splice(index, 1);
			if (current.length === 0) this.#listeners.delete(method);
		};
	}

	notify(method: string, payload: JsonValue): Promise<void> {
		if (this.#closed) return Promise.reject(disconnectedError());
		if (method.length === 0) return Promise.reject(new TypeError("RPC method name must not be empty"));
		let payloadIsJson = false;
		try {
			payloadIsJson = isJsonValue(payload);
		} catch {
			// Revoked proxies and similar pathological inputs throw during inspection; treat as malformed.
			payloadIsJson = false;
		}
		if (!payloadIsJson) {
			return Promise.reject(new RpcPeerError("rpc-malformed", "RPC notification payload is not strict JSON"));
		}
		return this.#enqueueSend({ version: RPC_PROTOCOL_VERSION, type: "notification", method, payload });
	}

	async close(reason?: unknown): Promise<void> {
		this.#teardown(reason);
		try {
			await this.#channel.close(reason);
		} catch {
			// Channel close is best effort; peer state is already torn down.
		}
	}

	#helloEnvelope(): RpcEnvelope {
		return this.#metadata === undefined
			? { version: RPC_PROTOCOL_VERSION, type: "hello" }
			: { version: RPC_PROTOCOL_VERSION, type: "hello", metadata: this.#metadata };
	}

	#requestEnvelope(id: string, method: string, args: readonly JsonValue[]): RpcRequestEnvelope {
		return this.#metadata === undefined
			? { version: RPC_PROTOCOL_VERSION, type: "request", id, method, args }
			: { version: RPC_PROTOCOL_VERSION, type: "request", id, method, args, metadata: this.#metadata };
	}

	/** Serialize every outbound frame through one chain, preserving send order and backpressure. */
	#enqueueSend(envelope: RpcEnvelope): Promise<void> {
		const attempt = async (): Promise<void> => {
			if (this.#closed) throw disconnectedError();
			try {
				// Envelopes carry readonly arrays, which serialize identically over the JSON channel contract.
				await this.#channel.send(envelope as JsonValue);
			} catch {
				this.#teardown(new RpcPeerError("rpc-peer-disconnected", "Failed to send RPC message"));
				void this.#channel.close().catch(() => {});
				throw disconnectedError();
			}
		};
		const sent = this.#sendChain.then(attempt, attempt);
		this.#sendChain = sent.then(
			() => {},
			() => {},
		);
		return sent;
	}

	#receive(message: unknown): void {
		if (this.#closed) return;
		if (this.#maxMessageBytes !== undefined) {
			let bytes = 0;
			try {
				bytes = jsonByteLength(message as JsonValue);
			} catch {
				// Non-serializable messages are rejected by envelope validation below.
			}
			if (bytes > this.#maxMessageBytes) {
				this.#protocolError(
					new RpcPeerError("rpc-malformed", `RPC message of ${bytes} bytes exceeds the configured maximum`),
				);
				return;
			}
		}
		let envelope: RpcEnvelope;
		try {
			envelope = parseRpcEnvelope(message);
		} catch (error) {
			this.#protocolError(
				error instanceof RpcPeerError ? error : new RpcPeerError("rpc-malformed", "Malformed RPC message"),
			);
			return;
		}
		if (!this.#handshakeReceived) {
			if (envelope.type !== "hello") {
				this.#protocolError(new RpcPeerError("rpc-malformed", "RPC handshake expected before other messages"));
				return;
			}
			this.#handshakeReceived = true;
			return;
		}
		if (envelope.type === "hello") {
			this.#protocolError(new RpcPeerError("rpc-malformed", "Unexpected repeat RPC handshake"));
			return;
		}
		switch (envelope.type) {
			case "request":
				this.#handleRequest(envelope);
				return;
			case "response":
				this.#handleResponse(envelope);
				return;
			case "cancel":
				this.#handleCancel(envelope);
				return;
			case "notification":
				this.#notificationQueue.push(envelope);
				void this.#pumpNotifications();
				return;
		}
	}

	#handleRequest(envelope: RpcRequestEnvelope): void {
		const { id, method, args, metadata } = envelope;
		if (this.#seenInboundIds.has(id)) {
			this.#protocolError(new RpcPeerError("rpc-malformed", `Duplicate RPC request id ${id}`));
			return;
		}
		this.#seenInboundIds.add(id);
		const handler = this.#handlers.get(method);
		if (handler === undefined) {
			void this.#sendResponse(id, {
				error: { code: "rpc-handler-missing", message: `No RPC handler is registered for ${method}` },
			});
			return;
		}
		const controller = new AbortController();
		const inbound: InboundRequest = { controller, cancelled: false };
		this.#inbound.set(id, inbound);
		let context: Context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
		if (metadata !== undefined) context = withContextValue(RPC_METADATA_CONTEXT_KEY, metadata, context);
		void (async () => {
			let body: { result?: JsonValue; error?: RpcError };
			try {
				const result = await handler(args, context);
				if (result === undefined) body = {};
				else if (isJsonValue(result)) body = { result };
				else body = { error: { code: "rpc-internal", message: "RPC handler result is not strict JSON" } };
			} catch {
				// Arbitrary thrown values never cross the wire; only stable sanitized codes do.
				body = inbound.cancelled
					? { error: { code: "rpc-cancelled", message: "RPC request was cancelled" } }
					: { error: { code: "rpc-internal", message: "RPC handler failed" } };
			}
			if (this.#inbound.get(id) === inbound) this.#inbound.delete(id);
			if (this.#closed) return;
			void this.#sendResponse(id, body);
		})();
	}

	#handleResponse(envelope: RpcResponseEnvelope): void {
		const pending = this.#pending.get(envelope.id);
		if (pending === undefined) {
			if (this.#cancelledIds.has(envelope.id)) return;
			this.#protocolError(new RpcPeerError("rpc-malformed", `RPC response for unknown request id ${envelope.id}`));
			return;
		}
		pending.settled = true;
		pending.detach();
		this.#pending.delete(envelope.id);
		if (envelope.error !== undefined) pending.reject(new RpcPeerError(envelope.error.code, envelope.error.message));
		else pending.resolve(envelope.result);
	}

	#handleCancel(envelope: RpcCancelEnvelope): void {
		const inbound = this.#inbound.get(envelope.id);
		// A cancel racing an already-sent response is not a protocol error.
		if (inbound === undefined) return;
		inbound.cancelled = true;
		this.#inbound.delete(envelope.id);
		inbound.controller.abort(new RpcPeerError("rpc-cancelled", "RPC request was cancelled"));
	}

	#sendResponse(id: string, body: { result?: JsonValue; error?: RpcError }): Promise<void> {
		let envelope: RpcResponseEnvelope;
		if (body.error !== undefined)
			envelope = { version: RPC_PROTOCOL_VERSION, type: "response", id, error: body.error };
		else if (body.result !== undefined) {
			envelope = { version: RPC_PROTOCOL_VERSION, type: "response", id, result: body.result };
		} else envelope = { version: RPC_PROTOCOL_VERSION, type: "response", id };
		return this.#enqueueSend(envelope);
	}

	async #pumpNotifications(): Promise<void> {
		if (this.#pumping) return;
		this.#pumping = true;
		try {
			while (!this.#closed && this.#notificationQueue.length > 0) {
				const notification = this.#notificationQueue.shift()!;
				const listeners = this.#listeners.get(notification.method);
				if (listeners === undefined || listeners.length === 0) continue;
				for (const listener of [...listeners]) {
					try {
						await listener(notification.payload, BACKGROUND_CONTEXT);
					} catch (error) {
						this.#reportError(
							error instanceof Error
								? error
								: new RpcPeerError("rpc-internal", "RPC notification listener failed"),
						);
					}
				}
			}
		} finally {
			this.#pumping = false;
		}
	}

	#protocolError(error: Error): void {
		this.#reportError(error);
		this.#teardown(error);
		void this.#channel.close(error).catch(() => {});
	}

	#reportError(error: Error): void {
		try {
			this.#onError?.(error);
		} catch {
			// Reporting failures must not corrupt peer state.
		}
	}

	#teardown(reason?: unknown): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#removeChannelListeners();
		for (const pending of this.#pending.values()) {
			pending.settled = true;
			pending.detach();
			pending.reject(disconnectedError());
		}
		this.#pending.clear();
		for (const inbound of this.#inbound.values()) {
			inbound.cancelled = true;
			inbound.controller.abort(reason ?? disconnectedError());
		}
		this.#inbound.clear();
		this.#handlers.clear();
		this.#listeners.clear();
		this.#notificationQueue.length = 0;
	}

	#assertOpen(action: string): void {
		if (this.#closed)
			throw new RpcPeerError("rpc-peer-disconnected", `Cannot ${action} while the RPC peer is closed`);
	}
}

function disconnectedError(): RpcPeerError {
	return new RpcPeerError("rpc-peer-disconnected", "RPC peer is closed");
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RpcPeerError("rpc-malformed", "RPC message must be a JSON object");
	}
	return value as Record<string, unknown>;
}

function assertKeys(
	envelope: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	if (
		required.some((key) => !Object.hasOwn(envelope, key)) ||
		Object.keys(envelope).some((key) => !allowed.has(key))
	) {
		throw new RpcPeerError("rpc-malformed", "RPC envelope has missing or unexpected keys");
	}
}

function requireId(value: unknown, description: string): void {
	if (typeof value !== "string" || value.length === 0) {
		throw new RpcPeerError("rpc-malformed", `RPC ${description} must be a non-empty string`);
	}
}

function requireJson(value: unknown, description: string): void {
	if (!isJsonValue(value)) throw new RpcPeerError("rpc-malformed", `RPC ${description} is not strict JSON`);
}

function assertRpcError(value: unknown): asserts value is RpcError {
	const error = record(value);
	assertKeys(error, ["code", "message"], []);
	if (typeof error.code !== "string" || !RPC_ERROR_CODES.includes(error.code as RpcErrorCode)) {
		throw new RpcPeerError("rpc-malformed", "RPC response error code is invalid");
	}
	if (typeof error.message !== "string") {
		throw new RpcPeerError("rpc-malformed", "RPC response error message must be a string");
	}
}
