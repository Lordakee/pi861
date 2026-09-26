import { describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../src/context/index.ts";
import type { JsonValue, LoopbackRpcChannel, RpcPeer } from "../src/index.ts";
import {
	createLoopbackRpcChannels,
	createRpcPeer,
	parseRpcEnvelope,
	RPC_METADATA_CONTEXT_KEY,
	RpcPeerError,
} from "../src/index.ts";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface TestPair {
	readonly left: LoopbackRpcChannel;
	readonly right: LoopbackRpcChannel;
	readonly peerA: RpcPeer;
	readonly peerB: RpcPeer;
	readonly errorsA: Error[];
	readonly errorsB: Error[];
}

async function createPair(): Promise<TestPair> {
	const [left, right] = createLoopbackRpcChannels();
	const errorsA: Error[] = [];
	const errorsB: Error[] = [];
	const peerA = createRpcPeer({ channel: left, onError: (error) => errorsA.push(error) });
	const peerB = createRpcPeer({ channel: right, onError: (error) => errorsB.push(error) });
	await settle();
	return { left, right, peerA, peerB, errorsA, errorsB };
}

function errorCode(error: Error | undefined): string {
	expect(error).toBeInstanceOf(RpcPeerError);
	return (error as RpcPeerError).code;
}

function envelopeError(value: unknown): RpcPeerError {
	try {
		parseRpcEnvelope(value);
	} catch (error) {
		expect(error).toBeInstanceOf(RpcPeerError);
		return error as RpcPeerError;
	}
	throw new Error("expected parseRpcEnvelope to throw");
}

describe("RpcPeer requests", () => {
	test("resolves calls initiated from both peers", async () => {
		const { peerA, peerB } = await createPair();
		peerA.register("a.echo", (args) => `A:${String(args[0])}`);
		peerB.register("b.echo", (args) => `B:${String(args[0])}`);
		await expect(peerA.call("b.echo", [1])).resolves.toBe("B:1");
		await expect(peerB.call("a.echo", [2])).resolves.toBe("A:2");
	});

	test("crossed concurrent calls stay correlated", async () => {
		const { peerA, peerB } = await createPair();
		peerA.register("a.echo", (args) => `A:${String(args[0])}`);
		peerB.register("b.echo", (args) => `B:${String(args[0])}`);
		const results = await Promise.all([
			peerA.call("b.echo", ["1"]),
			peerB.call("a.echo", ["2"]),
			peerA.call("b.echo", ["3"]),
			peerB.call("a.echo", ["4"]),
		]);
		expect(results).toEqual(["B:1", "A:2", "B:3", "A:4"]);
	});

	test("handlers receive args, a fresh cancellable context, and request metadata", async () => {
		const [left, right] = createLoopbackRpcChannels();
		const rightMessages: unknown[] = [];
		right.onMessage((message) => rightMessages.push(message));
		const peerA = createRpcPeer({ channel: left, metadata: { trace: "t-1" } });
		const peerB = createRpcPeer({ channel: right });
		await settle();
		expect(rightMessages[0]).toEqual({ version: 1, type: "hello", metadata: { trace: "t-1" } });
		let seenMetadata: unknown;
		let signalSeen: unknown;
		peerB.register("probe", (args, context) => {
			seenMetadata = context.value(RPC_METADATA_CONTEXT_KEY);
			signalSeen = context.abortSignal;
			return args.length;
		});
		await expect(peerA.call("probe", [1, 2, 3])).resolves.toBe(3);
		expect(seenMetadata).toEqual({ trace: "t-1" });
		expect(signalSeen).toBeInstanceOf(AbortSignal);
	});

	test("void handlers resolve undefined and omit the result field", async () => {
		const { left, peerA, peerB } = await createPair();
		const leftMessages: unknown[] = [];
		left.onMessage((message) => leftMessages.push(message));
		peerB.register("noop", () => {});
		await expect(peerA.call("noop", [])).resolves.toBeUndefined();
		expect(leftMessages.at(-1)).toEqual({ version: 1, type: "response", id: "1" });
	});

	test("missing handlers reject with rpc-handler-missing without closing the peer", async () => {
		const { peerA, peerB } = await createPair();
		peerB.register("present", () => "ok");
		const error = await peerA.call("absent", []).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(RpcPeerError);
		expect((error as RpcPeerError).code).toBe("rpc-handler-missing");
		expect(peerA.closed).toBe(false);
		await expect(peerA.call("present", [])).resolves.toBe("ok");
	});

	test("duplicate registration is rejected until unregistered", () => {
		const peerA = createRpcPeer({ channel: createLoopbackRpcChannels()[0] });
		const handler = (): number => 1;
		peerA.register("m", handler);
		expect(() => peerA.register("m", handler)).toThrow(/already registered/);
		const unregister = peerA.register("other", handler);
		unregister();
		unregister();
		expect(() => peerA.register("other", handler)).not.toThrow();
	});
});

describe("RpcPeer envelope validation", () => {
	test("accepts a minimal valid request", () => {
		expect(parseRpcEnvelope({ version: 1, type: "request", id: "1", method: "m", args: [] })).toEqual({
			version: 1,
			type: "request",
			id: "1",
			method: "m",
			args: [],
		});
	});

	test("rejects unsupported versions as version mismatches", () => {
		expect(envelopeError({ version: 2, type: "hello" }).code).toBe("rpc-version-mismatch");
		expect(envelopeError({ version: 0, type: "request", id: "1", method: "m", args: [] }).code).toBe(
			"rpc-version-mismatch",
		);
	});

	test("rejects non-objects, missing versions, and invalid discriminants", () => {
		expect(envelopeError(undefined).code).toBe("rpc-malformed");
		expect(envelopeError(null).code).toBe("rpc-malformed");
		expect(envelopeError([]).code).toBe("rpc-malformed");
		expect(envelopeError({ type: "hello" }).code).toBe("rpc-malformed");
		expect(envelopeError({ version: "1", type: "hello" }).code).toBe("rpc-malformed");
		expect(envelopeError({ version: 1, type: "wat", id: "1" }).code).toBe("rpc-malformed");
	});

	test("rejects extra keys, empty ids and methods, and non-JSON payloads", () => {
		expect(envelopeError({ version: 1, type: "hello", extra: 1 }).code).toBe("rpc-malformed");
		expect(envelopeError({ version: 1, type: "request", id: "", method: "m", args: [] }).code).toBe("rpc-malformed");
		expect(envelopeError({ version: 1, type: "request", id: "1", method: "", args: [] }).code).toBe("rpc-malformed");
		expect(envelopeError({ version: 1, type: "request", id: "1", method: "m", args: [Number.NaN] }).code).toBe(
			"rpc-malformed",
		);
		expect(
			envelopeError({ version: 1, type: "request", id: "1", method: "m", args: [Number.POSITIVE_INFINITY] }).code,
		).toBe("rpc-malformed");
		expect(
			envelopeError({ version: 1, type: "request", id: "1", method: "m", args: [], metadata: undefined }).code,
		).toBe("rpc-malformed");
		expect(envelopeError({ version: 1, type: "notification", method: "m", payload: undefined }).code).toBe(
			"rpc-malformed",
		);
		expect(envelopeError({ version: 1, type: "cancel", id: "1", extra: 1 }).code).toBe("rpc-malformed");
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(envelopeError({ version: 1, type: "notification", method: "m", payload: cyclic }).code).toBe(
			"rpc-malformed",
		);
	});

	test("rejects invalid response shapes", () => {
		expect(
			envelopeError({
				version: 1,
				type: "response",
				id: "1",
				result: 1,
				error: { code: "rpc-internal", message: "x" },
			}).code,
		).toBe("rpc-malformed");
		expect(
			envelopeError({ version: 1, type: "response", id: "1", error: { code: "made-up", message: "x" } }).code,
		).toBe("rpc-malformed");
		expect(
			envelopeError({
				version: 1,
				type: "response",
				id: "1",
				error: { code: "rpc-internal", message: "x", stack: "s" },
			}).code,
		).toBe("rpc-malformed");
		expect(envelopeError({ version: 1, type: "response", id: "1", error: { code: "rpc-internal" } }).code).toBe(
			"rpc-malformed",
		);
		expect(envelopeError({ version: 1, type: "response", id: "1", result: undefined }).code).toBe("rpc-malformed");
	});
});

describe("RpcPeer handshake and correlation policy", () => {
	test("requires the handshake as the first inbound message", async () => {
		const [left, right] = createLoopbackRpcChannels();
		const errors: Error[] = [];
		const peerA = createRpcPeer({ channel: left, onError: (error) => errors.push(error) });
		await right.send({ version: 1, type: "request", id: "1", method: "m", args: [] });
		await settle();
		expect(peerA.closed).toBe(true);
		expect(errorCode(errors[0])).toBe("rpc-malformed");
	});

	test("rejects a repeated handshake", async () => {
		const { right, peerA, errorsA } = await createPair();
		await right.send({ version: 1, type: "hello" });
		await settle();
		expect(peerA.closed).toBe(true);
		expect(errorCode(errorsA[0])).toBe("rpc-malformed");
	});

	test("rejects unsupported protocol versions from the remote peer", async () => {
		const [left, right] = createLoopbackRpcChannels();
		const errors: Error[] = [];
		const peerA = createRpcPeer({ channel: left, onError: (error) => errors.push(error) });
		await right.send({ version: 2, type: "hello" });
		await settle();
		expect(peerA.closed).toBe(true);
		expect(errorCode(errors[0])).toBe("rpc-version-mismatch");
	});

	test("rejects unknown response ids", async () => {
		const { right, peerA, errorsA } = await createPair();
		await right.send({ version: 1, type: "response", id: "404" });
		await settle();
		expect(peerA.closed).toBe(true);
		expect(errorCode(errorsA[0])).toBe("rpc-malformed");
	});

	test("rejects duplicate response ids", async () => {
		const { right, peerA, peerB, errorsA } = await createPair();
		peerB.register("hang", () => new Promise(() => {}));
		const call = peerA.call("hang", []);
		await settle();
		await right.send({ version: 1, type: "response", id: "1", result: "forged" });
		await expect(call).resolves.toBe("forged");
		await right.send({ version: 1, type: "response", id: "1", result: "again" });
		await settle();
		expect(peerA.closed).toBe(true);
		expect(errorCode(errorsA[0])).toBe("rpc-malformed");
	});

	test("rejects duplicate inbound request ids", async () => {
		const [left, right] = createLoopbackRpcChannels();
		const errors: Error[] = [];
		const peerA = createRpcPeer({ channel: left, onError: (error) => errors.push(error) });
		await right.send({ version: 1, type: "hello" });
		await settle();
		peerA.register("m", () => 1);
		await right.send({ version: 1, type: "request", id: "77", method: "m", args: [] });
		await settle();
		expect(peerA.closed).toBe(false);
		await right.send({ version: 1, type: "request", id: "77", method: "m", args: [] });
		await settle();
		expect(peerA.closed).toBe(true);
		expect(errorCode(errors[0])).toBe("rpc-malformed");
	});

	test("ignores cancels for unknown or settled ids", async () => {
		const [left, right] = createLoopbackRpcChannels();
		const peerA = createRpcPeer({ channel: left });
		const peerB = createRpcPeer({ channel: right });
		await settle();
		let aborted = false;
		peerB.register("quick", (_args, context) => {
			context.abortSignal?.addEventListener("abort", () => {
				aborted = true;
			});
			return "done";
		});
		await expect(peerA.call("quick", [])).resolves.toBe("done");
		// The cancel is injected from A's side so it reaches B after the response was sent.
		await left.send({ version: 1, type: "cancel", id: "1" });
		await settle();
		expect(peerB.closed).toBe(false);
		expect(aborted).toBe(false);
		await expect(peerA.call("quick", [])).resolves.toBe("done");
	});
});

describe("RpcPeer cancellation", () => {
	test("pre-aborted calls reject locally without sending a request", async () => {
		const [left, right] = createLoopbackRpcChannels();
		const rightMessages: unknown[] = [];
		right.onMessage((message) => rightMessages.push(message));
		const peerA = createRpcPeer({ channel: left });
		await settle();
		const controller = new AbortController();
		controller.abort();
		const error = await peerA.call("m", [], withAbortSignal(controller.signal, BACKGROUND_CONTEXT)).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(RpcPeerError);
		expect((error as RpcPeerError).code).toBe("rpc-cancelled");
		await settle();
		expect(rightMessages).toEqual([{ version: 1, type: "hello" }]);
	});

	test("aborting an admitted call aborts only that handler and sends one cancel", async () => {
		const { peerA, peerB } = await createPair();
		let blockAborted = false;
		peerB.register("block", (_args, context) => {
			return new Promise((_resolve, reject) => {
				context.abortSignal?.addEventListener("abort", () => {
					blockAborted = true;
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		});
		peerB.register("fast", () => "fine");
		const controller = new AbortController();
		const blocked = peerA.call("block", [], withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
		blocked.catch(() => {});
		await settle();
		controller.abort();
		await expect(blocked).rejects.toMatchObject({ code: "rpc-cancelled" });
		await settle();
		expect(blockAborted).toBe(true);
		expect(peerA.closed).toBe(false);
		expect(peerB.closed).toBe(false);
		await expect(peerA.call("fast", [])).resolves.toBe("fine");
	});

	test("late responses after local cancellation are ignored, not protocol errors", async () => {
		const { peerA, peerB } = await createPair();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		peerB.register("slow", () => gate.then(() => "late"));
		const controller = new AbortController();
		const cancelled = peerA.call("slow", [], withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
		await settle();
		controller.abort();
		await expect(cancelled).rejects.toMatchObject({ code: "rpc-cancelled" });
		release();
		await settle();
		expect(peerA.closed).toBe(false);
		await expect(peerA.call("slow", [])).resolves.toBe("late");
	});
});

describe("RpcPeer errors", () => {
	test("handler exceptions become sanitized rpc-internal responses", async () => {
		const { left, peerA, peerB } = await createPair();
		const leftMessages: unknown[] = [];
		left.onMessage((message) => leftMessages.push(message));
		peerB.register("boom", () => {
			throw Object.assign(new Error("secret stack"), { secret: "leak" });
		});
		const error = await peerA.call("boom", []).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(RpcPeerError);
		expect((error as RpcPeerError).code).toBe("rpc-internal");
		expect((error as RpcPeerError).message).toBe("RPC handler failed");
		expect(leftMessages.at(-1)).toEqual({
			version: 1,
			type: "response",
			id: "1",
			error: { code: "rpc-internal", message: "RPC handler failed" },
		});
		expect(peerA.closed).toBe(false);
	});

	test("non-Error thrown values are sanitized identically", async () => {
		const { peerA, peerB } = await createPair();
		peerB.register("throw-string", () => {
			throw "a raw string";
		});
		await expect(peerA.call("throw-string", [])).rejects.toMatchObject({
			code: "rpc-internal",
			message: "RPC handler failed",
		});
	});

	test("non-JSON handler results are rejected as rpc-internal", async () => {
		const { peerA, peerB } = await createPair();
		peerB.register("bad-result", () => new Date(0) as unknown as JsonValue);
		await expect(peerA.call("bad-result", [])).rejects.toMatchObject({ code: "rpc-internal" });
		await expect(peerA.call("bad-result", [])).rejects.toMatchObject({
			message: "RPC handler result is not strict JSON",
		});
	});

	test("non-JSON call arguments are rejected locally", async () => {
		const { peerA } = await createPair();
		await expect(peerA.call("m", [undefined as unknown as JsonValue])).rejects.toMatchObject({
			code: "rpc-malformed",
		});
		expect(peerA.closed).toBe(false);
	});
});

describe("RpcPeer notifications", () => {
	test("notifications arrive in exact send order including concurrent notify calls", async () => {
		const { peerA, peerB } = await createPair();
		const events: number[] = [];
		peerB.subscribe("evt", (payload) => {
			events.push(payload as number);
		});
		await settle();
		await Promise.all([1, 2, 3, 4, 5].map((index) => peerA.notify("evt", index)));
		await settle();
		expect(events).toEqual([1, 2, 3, 4, 5]);
	});

	test("subscribers run in registration order and can unsubscribe", async () => {
		const { peerA, peerB } = await createPair();
		const order: string[] = [];
		const unsubscribeFirst = peerB.subscribe("evt", () => {
			order.push("first");
		});
		peerB.subscribe("evt", () => {
			order.push("second");
		});
		await peerA.notify("evt", null);
		await settle();
		expect(order).toEqual(["first", "second"]);
		unsubscribeFirst();
		await peerA.notify("evt", null);
		await settle();
		expect(order).toEqual(["first", "second", "second"]);
	});

	test("a slow subscriber delays later notifications without reordering", async () => {
		const { peerA, peerB } = await createPair();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const received: number[] = [];
		peerB.subscribe("evt", async (payload) => {
			received.push(payload as number);
			await gate;
		});
		const first = peerA.notify("evt", 1);
		const second = peerA.notify("evt", 2);
		await settle();
		expect(received).toEqual([1]);
		release();
		await Promise.all([first, second]);
		await settle();
		expect(received).toEqual([1, 2]);
	});

	test("closing drops queued notifications and rejects later sends", async () => {
		const { peerA, peerB } = await createPair();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const received: number[] = [];
		peerB.subscribe("evt", async (payload) => {
			received.push(payload as number);
			await gate;
		});
		await peerA.notify("evt", 1);
		await peerA.notify("evt", 2);
		await settle();
		expect(received).toEqual([1]);
		await peerA.close();
		await expect(peerA.notify("evt", 3)).rejects.toMatchObject({ code: "rpc-peer-disconnected" });
		release();
		await settle();
		expect(received).toEqual([1]);
	});

	test("listener failures are isolated and reported without corrupting later messages", async () => {
		const { peerA, peerB, errorsB } = await createPair();
		const seen: number[] = [];
		peerB.subscribe("evt", () => {
			throw new Error("listener broke");
		});
		peerB.subscribe("evt", (payload) => {
			seen.push(payload as number);
		});
		await peerA.notify("evt", 1);
		await peerA.notify("evt", 2);
		await settle();
		expect(seen).toEqual([1, 2]);
		expect(errorsB).toHaveLength(2);
		expect(peerB.closed).toBe(false);
	});
});

describe("RpcPeer disconnect and close", () => {
	test("channel close rejects outbound calls and aborts inbound contexts", async () => {
		const { left, peerA, peerB } = await createPair();
		let inboundAborted = false;
		peerB.register("hang", (_args, context) => {
			return new Promise((_resolve, reject) => {
				context.abortSignal?.addEventListener("abort", () => {
					inboundAborted = true;
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		});
		const pending = peerA.call("hang", []);
		await settle();
		await left.close("test disconnect");
		await expect(pending).rejects.toMatchObject({ code: "rpc-peer-disconnected" });
		expect(peerA.closed).toBe(true);
		expect(peerB.closed).toBe(true);
		await settle();
		expect(inboundAborted).toBe(true);
	});

	test("send failure transitions the peer to closed and rejects the call", async () => {
		const { left, peerA, peerB } = await createPair();
		peerB.register("ok", () => "fine");
		left.failNextSend(new Error("wire broke"));
		await expect(peerA.call("ok", [])).rejects.toMatchObject({ code: "rpc-peer-disconnected" });
		expect(peerA.closed).toBe(true);
		expect(peerB.closed).toBe(true);
	});

	test("close is idempotent and removes handlers, subscriptions, and queued work", async () => {
		const { peerA, peerB } = await createPair();
		const spy = vi.fn();
		peerB.subscribe("evt", spy);
		await peerA.notify("evt", 1);
		await settle();
		expect(spy).toHaveBeenCalledTimes(1);
		await peerA.close();
		await peerA.close();
		expect(peerA.closed).toBe(true);
		expect(peerB.closed).toBe(true);
		expect(() => peerA.register("x", () => {})).toThrow(RpcPeerError);
		await expect(peerA.call("x", [])).rejects.toMatchObject({ code: "rpc-peer-disconnected" });
		await expect(peerA.notify("x", null)).rejects.toMatchObject({ code: "rpc-peer-disconnected" });
		await expect(() => peerA.subscribe("y", spy)).toThrow(RpcPeerError);
		await settle();
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe("loopback channels", () => {
	test("manual delivery controls message admission deterministically", async () => {
		const [left, right] = createLoopbackRpcChannels({ autoDeliver: false });
		const peerA = createRpcPeer({ channel: left });
		const peerB = createRpcPeer({ channel: right });
		peerB.register("echo", (args) => args[0]);
		let resolved = false;
		const call = peerA.call("echo", ["x"]).then((value) => {
			resolved = value === "x";
		});
		await settle();
		expect(resolved).toBe(false);
		right.deliver();
		await settle();
		expect(resolved).toBe(false);
		left.deliver();
		await call;
		expect(resolved).toBe(true);
	});

	test("oversized inbound messages close the peer as protocol errors", async () => {
		const [left, right] = createLoopbackRpcChannels();
		const errors: Error[] = [];
		const peerA = createRpcPeer({ channel: left, maxMessageBytes: 64, onError: (error) => errors.push(error) });
		await settle();
		await right.send({ version: 1, type: "notification", method: "evt", payload: "x".repeat(200) });
		await settle();
		expect(peerA.closed).toBe(true);
		expect(errorCode(errors[0])).toBe("rpc-malformed");
	});

	test("loopback-level size limits reject sends and close the pair", async () => {
		const [left, right] = createLoopbackRpcChannels({ maxMessageBytes: 8 });
		const closed: unknown[] = [];
		right.onClose((reason) => closed.push(reason));
		await expect(left.send({ data: "x".repeat(100) })).rejects.toThrow(/maximum/);
		expect(closed).toHaveLength(1);
		await expect(left.send({ data: 1 })).rejects.toThrow(/closed/);
	});

	test("non-strict-JSON sends are rejected and close the pair", async () => {
		const [left, right] = createLoopbackRpcChannels();
		const closed: unknown[] = [];
		right.onClose((reason) => closed.push(reason));
		await expect(left.send({ bad: undefined } as unknown as JsonValue)).rejects.toThrow(TypeError);
		expect(closed).toHaveLength(1);
	});
});
