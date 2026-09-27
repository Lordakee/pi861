import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentHarness,
	HarnessClosed,
	type HarnessEvent,
	HarnessFault,
	type SessionSnapshot,
} from "../../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT, type Context } from "../../../src/harness/context.ts";
import { Harness } from "../../../src/harness/runtime/harness.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { reduceSessionSnapshot } from "../../../src/harness/runtime/session-reducer.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type { Session, SessionMutationCallback } from "../../../src/harness/session/types.ts";
import { deferred, FailingMemoryStorage } from "./test-utils.ts";

const sessions: Session[] = [];

/** Rejects `mutate` for one marked context so a resnapshot capture fails deterministically. */
class ResnapshotFailingSession extends StorageBackedSession {
	failContext: Context | undefined;

	override mutate<T>(mutation: SessionMutationCallback<T>, context: Context): Promise<T> {
		return context === this.failContext
			? Promise.reject(new Error("capture failed"))
			: super.mutate(mutation, context);
	}
}

async function createFixture(
	session: Session = new StorageBackedSession(
		{ id: `session-watch-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	),
): Promise<{ harness: Harness<object | undefined>; session: Session; faux: ReturnType<typeof fauxProvider> }> {
	sessions.push(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() }, BACKGROUND_CONTEXT);
	if (!(harness instanceof Harness)) throw new Error("Expected runtime Harness");
	return { harness, session, faux };
}

async function settleEvents(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function fold(snapshot: SessionSnapshot, events: readonly HarnessEvent[]): SessionSnapshot {
	return events.reduce(reduceSessionSnapshot, snapshot);
}

function byName(a: { name: string }, b: { name: string }): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("session snapshot reducer", () => {
	it("clones its input and inserts lane_created in name order", () => {
		const input: SessionSnapshot = {
			lanes: [
				{ name: "alpha", tipId: "a", operation: null },
				{ name: "gamma", tipId: "g", operation: null },
			],
			faulted: false,
		};
		const reduced = reduceSessionSnapshot(input, { type: "lane_created", lane: "beta", at: "b" });
		expect(reduced.lanes.map(({ name }) => name)).toEqual(["alpha", "beta", "gamma"]);
		expect(reduced.lanes[1]).toEqual({ name: "beta", tipId: "b", operation: null });
		expect(input.lanes.map(({ name }) => name)).toEqual(["alpha", "gamma"]);

		const running: SessionSnapshot = {
			lanes: [{ name: "main", tipId: null, operation: { id: "run", kind: "run", startedAt: 1, status: "open" } }],
			faulted: false,
		};
		const aborted = reduceSessionSnapshot(running, {
			type: "operation_abort",
			operationId: "run",
			steer: [],
			followUp: [],
			lane: "main",
		});
		expect(aborted.lanes[0]?.operation).toMatchObject({ status: "aborting" });
		expect(running.lanes[0]?.operation).toMatchObject({ status: "open" });
	});

	it("folds operation lifecycle and tip projections", () => {
		let snapshot: SessionSnapshot = { lanes: [], faulted: false };
		snapshot = reduceSessionSnapshot(snapshot, { type: "lane_created", lane: "main", at: null });
		snapshot = reduceSessionSnapshot(snapshot, { type: "run_start", runId: "run", startedAt: 5, lane: "main" });
		expect(snapshot.lanes[0]?.operation).toEqual({ id: "run", kind: "run", startedAt: 5, status: "open" });
		snapshot = reduceSessionSnapshot(snapshot, {
			type: "entry_added",
			lane: "main",
			entry: { id: "e1", parentId: null, seq: 1, timestamp: 1, type: "custom", customType: "note" },
		});
		expect(snapshot.lanes[0]?.tipId).toBe("e1");
		snapshot = reduceSessionSnapshot(snapshot, {
			type: "operation_abort",
			operationId: "run",
			steer: [],
			followUp: [],
			lane: "main",
		});
		expect(snapshot.lanes[0]?.operation).toMatchObject({ status: "aborting" });
		snapshot = reduceSessionSnapshot(snapshot, {
			type: "run_end",
			runId: "run",
			status: "failed",
			error: { code: "provider", message: "boom" },
			fromTipId: "e1",
			tipId: "e2",
			endedAt: 6,
			lane: "main",
		});
		expect(snapshot.lanes[0]).toMatchObject({ tipId: "e2", operation: null });
		snapshot = reduceSessionSnapshot(snapshot, {
			type: "navigation_start",
			runId: "nav",
			targetId: "e1",
			startedAt: 7,
			lane: "main",
		});
		expect(snapshot.lanes[0]?.operation).toMatchObject({ id: "nav", kind: "navigation" });
		snapshot = reduceSessionSnapshot(snapshot, {
			type: "navigation_end",
			runId: "nav",
			status: "completed",
			fromTipId: "e2",
			tipId: "e1",
			endedAt: 8,
			lane: "main",
		});
		expect(snapshot.lanes[0]).toMatchObject({ tipId: "e1", operation: null });
		expect(snapshot.faulted).toBe(false);
		snapshot = reduceSessionSnapshot(snapshot, { type: "fault", code: "harness_fault", message: "faulted" });
		expect(snapshot.faulted).toBe(true);
	});

	it("keeps in-run compaction segments inside the open run", () => {
		let snapshot: SessionSnapshot = {
			lanes: [{ name: "main", tipId: "e1", operation: { id: "run", kind: "run", startedAt: 1, status: "open" } }],
			faulted: false,
		};
		snapshot = reduceSessionSnapshot(snapshot, {
			type: "compaction_start",
			runId: "run",
			reason: "threshold",
			startedAt: 2,
			lane: "main",
		});
		expect(snapshot.lanes[0]?.operation).toMatchObject({ id: "run", kind: "run" });
		snapshot = reduceSessionSnapshot(snapshot, {
			type: "compaction_end",
			runId: "run",
			reason: "threshold",
			status: "declined",
			endedAt: 3,
			lane: "main",
		});
		expect(snapshot.lanes[0]?.operation).toMatchObject({ id: "run", kind: "run" });

		snapshot = reduceSessionSnapshot(snapshot, {
			type: "run_end",
			runId: "run",
			status: "completed",
			fromTipId: "e1",
			tipId: "e2",
			endedAt: 4,
			lane: "main",
		});
		snapshot = reduceSessionSnapshot(snapshot, {
			type: "compaction_start",
			runId: "compact",
			reason: "manual",
			startedAt: 5,
			lane: "main",
		});
		expect(snapshot.lanes[0]?.operation).toEqual({
			id: "compact",
			kind: "compaction",
			startedAt: 5,
			status: "open",
		});
		snapshot = reduceSessionSnapshot(snapshot, {
			type: "compaction_end",
			runId: "compact",
			reason: "manual",
			status: "completed",
			entryId: "summary",
			endedAt: 6,
			lane: "main",
		});
		expect(snapshot.lanes[0]?.operation).toBeNull();
	});

	it("ignores unrelated lane payloads and unknown lanes", () => {
		const snapshot: SessionSnapshot = {
			lanes: [{ name: "main", tipId: "t", operation: null }],
			faulted: false,
		};
		const unrelated: HarnessEvent[] = [
			{ type: "turn_start", runId: "run", turnId: "turn", lane: "main" },
			{
				type: "message_start",
				message: { role: "user", content: "queued", timestamp: 1 },
				runId: "run",
				lane: "main",
			},
			{
				type: "queue_update",
				queues: [
					{
						entryId: "queued",
						kind: "steer",
						type: "message",
						message: { role: "user", content: "steer", timestamp: 1 },
					},
				],
				lane: "main",
			},
			{
				type: "config_update",
				property: "model",
				value: { provider: "p", modelId: "m" },
				previous: { provider: "q", modelId: "n" },
				lane: "main",
			},
			{ type: "value_update", value: "session_name", name: "named" },
			{ type: "handler_error", kind: "event", event: "run_start", error: "boom", lane: "main" },
			{ type: "run_start", runId: "ghost", startedAt: 1, lane: "ghost" },
		];
		for (const event of unrelated) {
			expect(reduceSessionSnapshot(snapshot, event)).toEqual(snapshot);
		}
	});
});

describe("runtime session watch", () => {
	it("captures pre-registered lanes with name order, tips, and open operations", async () => {
		const { harness } = await createFixture();
		const main = await harness.lane("main", BACKGROUND_CONTEXT);
		await harness.lane("aux", BACKGROUND_CONTEXT);
		const review = await harness.lane("review", BACKGROUND_CONTEXT);
		const appended = await main.appendCustomEntry("note", undefined, BACKGROUND_CONTEXT);
		const admission = await review.accept({ kind: "prompt", prompt: "run" }, BACKGROUND_CONTEXT);
		if (!admission.ok) throw admission.error;

		const watch = await harness.watchSession(BACKGROUND_CONTEXT);
		expect(watch.snapshot.faulted).toBe(false);
		expect(watch.snapshot.lanes.map(({ name }) => name)).toEqual(["aux", "main", "review"]);
		expect(watch.snapshot.lanes.find(({ name }) => name === "main")).toMatchObject({
			name: "main",
			tipId: appended,
			operation: null,
		});
		expect(watch.snapshot.lanes.find(({ name }) => name === "review")?.operation).toMatchObject({
			id: admission.value.operationId,
			kind: "run",
			startedAt: admission.value.startedAt,
			status: "open",
		});
		expect(watch.snapshot.lanes).toEqual([...(await harness.lanes(BACKGROUND_CONTEXT))].sort(byName));

		watch.snapshot.lanes.length = 0;
		expect((await harness.watchSession(BACKGROUND_CONTEXT)).snapshot.lanes).toHaveLength(3);
		watch.unsubscribe();
	});

	it("delivers lane_created exactly once and folds to the authoritative resnapshot", async () => {
		const { harness, faux } = await createFixture();
		const watch = await harness.watchSession(BACKGROUND_CONTEXT);
		expect(watch.snapshot).toEqual({ lanes: [], faulted: false });
		const events: HarnessEvent[] = [];
		watch.start((event) => {
			events.push(event);
		});

		const main = await harness.lane("main", BACKGROUND_CONTEXT);
		await harness.lane("review", BACKGROUND_CONTEXT);
		await main.appendCustomEntry("note", undefined, BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage("answer")]);
		expect(await main.prompt("question", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "run", status: "completed" },
		});
		await settleEvents();

		expect(events.filter(({ type }) => type === "lane_created")).toHaveLength(2);
		const replica = fold(watch.snapshot, events);
		expect(replica.lanes.map(({ name }) => name)).toEqual(["main", "review"]);
		expect(replica.faulted).toBe(false);
		expect(replica.lanes.find(({ name }) => name === "main")?.tipId).toBe(await main.getTipId(BACKGROUND_CONTEXT));
		expect(replica.lanes.find(({ name }) => name === "main")?.operation).toBeNull();
		expect(replica).toEqual(await watch.resnapshot(BACKGROUND_CONTEXT));
		watch.unsubscribe();
	});

	it("represents registration-concurrent lane creation exactly once", async () => {
		const publicationFirst = await createFixture();
		await publicationFirst.harness.lane("late", BACKGROUND_CONTEXT);
		const seenPublication: string[] = [];
		const watchPublication = await publicationFirst.harness.watchSession(BACKGROUND_CONTEXT);
		watchPublication.start((event) => {
			seenPublication.push(event.type);
		});
		await settleEvents();
		expect(watchPublication.snapshot.lanes.map(({ name }) => name)).toEqual(["late"]);
		expect(seenPublication).toEqual([]);
		watchPublication.unsubscribe();

		const registrationFirst = await createFixture();
		const watchRegistration = await registrationFirst.harness.watchSession(BACKGROUND_CONTEXT);
		await registrationFirst.harness.lane("late", BACKGROUND_CONTEXT);
		expect(watchRegistration.snapshot.lanes).toEqual([]);
		const seenRegistration: HarnessEvent[] = [];
		watchRegistration.start((event) => {
			seenRegistration.push(event);
		});
		await settleEvents();
		expect(seenRegistration.filter(({ type }) => type === "lane_created")).toHaveLength(1);
		watchRegistration.unsubscribe();
	});

	it("installs the watcher on the Session mutation line before queued publications", async () => {
		const { harness } = await createFixture();
		const main = await harness.lane("main", BACKGROUND_CONTEXT);
		if (!(main instanceof Lane)) throw new Error("Expected runtime Lane");
		const started = deferred();
		const gate = deferred();
		const holding = main.command(async () => {
			started.resolve();
			await gate.promise;
			return { kind: "return", result: undefined };
		}, BACKGROUND_CONTEXT);
		await started.promise;
		const watchPromise = harness.watchSession(BACKGROUND_CONTEXT);
		const latePromise = harness.lane("late", BACKGROUND_CONTEXT);
		gate.resolve();
		const [watch] = await Promise.all([watchPromise, latePromise]);

		expect(watch.snapshot.lanes.map(({ name }) => name)).toEqual(["main"]);
		const events: HarnessEvent[] = [];
		watch.start((event) => {
			events.push(event);
		});
		await settleEvents();
		expect(events.filter(({ type }) => type === "lane_created")).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "lane_created", lane: "late" });
		watch.unsubscribe();
		await holding;
	});

	it("resnapshots from inside a listener without deadlock, holding only post-boundary events", async () => {
		const { harness } = await createFixture();
		const main = await harness.lane("main", BACKGROUND_CONTEXT);
		const watch = await harness.watchSession(BACKGROUND_CONTEXT);
		const listenerBlocked = deferred();
		const releaseListener = deferred();
		const resnapshotDone = deferred();
		const received: string[] = [];
		const postBoundary: HarnessEvent[] = [];
		let boundarySnapshot: SessionSnapshot | undefined;
		let afterBoundary = false;
		watch.start(async (event, context) => {
			received.push(event.type);
			const content =
				(event.type === "message_start" || event.type === "message_end") && event.message.role === "user"
					? event.message.content
					: undefined;
			if (event.type === "message_start" && content === "first") {
				listenerBlocked.resolve();
				await releaseListener.promise;
				return;
			}
			if (event.type === "message_start" && content === "second") {
				boundarySnapshot = await watch.resnapshot(context);
				afterBoundary = true;
				resnapshotDone.resolve();
				return;
			}
			if (afterBoundary) postBoundary.push(event);
		});
		const first = main.appendMessage({ role: "user", content: "first", timestamp: 1 }, BACKGROUND_CONTEXT);
		await listenerBlocked.promise;
		const second = main.appendMessage({ role: "user", content: "second", timestamp: 2 }, BACKGROUND_CONTEXT);
		releaseListener.resolve();
		await Promise.all([first, second, resnapshotDone.promise]);
		await settleEvents();

		expect(boundarySnapshot).toBeDefined();
		expect(boundarySnapshot?.lanes[0]?.tipId).toBe(await main.getTipId(BACKGROUND_CONTEXT));
		const third = await main.appendMessage({ role: "user", content: "third", timestamp: 3 }, BACKGROUND_CONTEXT);
		await settleEvents();
		expect(received).toHaveLength(7);
		const replica = fold(boundarySnapshot!, postBoundary);
		expect(replica).toEqual((await harness.watchSession(BACKGROUND_CONTEXT)).snapshot);
		expect(replica.lanes[0]?.tipId).toBe(third);
		watch.unsubscribe();
	});

	it("keeps the watch usable when a resnapshot capture fails", async () => {
		const session = new ResnapshotFailingSession(
			{ id: "session-watch-failing", createdAt: 1, storageVersion: 1 },
			new MemoryStorage(),
		);
		const { harness } = await createFixture(session);
		const main = await harness.lane("main", BACKGROUND_CONTEXT);
		const watch = await harness.watchSession(BACKGROUND_CONTEXT);
		const seen: HarnessEvent[] = [];
		watch.start((event) => {
			seen.push(event);
		});

		session.failContext = BACKGROUND_CONTEXT;
		await expect(watch.resnapshot(BACKGROUND_CONTEXT)).rejects.toThrow("capture failed");
		session.failContext = undefined;
		const appended = await main.appendCustomEntry("note", undefined, BACKGROUND_CONTEXT);
		await settleEvents();
		expect(seen.map(({ type }) => type)).toContain("entry_added");
		const replica = fold(watch.snapshot, seen);
		expect(replica.lanes[0]?.tipId).toBe(appended);
		expect(replica).toEqual(await watch.resnapshot(BACKGROUND_CONTEXT));
		watch.unsubscribe();
	});

	it("stops listener delivery after unsubscribe", async () => {
		const { harness } = await createFixture();
		const main = await harness.lane("main", BACKGROUND_CONTEXT);
		const watch = await harness.watchSession(BACKGROUND_CONTEXT);
		const seen: HarnessEvent[] = [];
		watch.start((event) => {
			seen.push(event);
		});
		watch.unsubscribe();

		await main.appendCustomEntry("note", undefined, BACKGROUND_CONTEXT);
		await settleEvents();
		expect(seen).toEqual([]);
	});

	it("ends the watch on clean close without faulting and rejects later requests", async () => {
		const { harness } = await createFixture();
		await harness.lane("main", BACKGROUND_CONTEXT);
		const watch = await harness.watchSession(BACKGROUND_CONTEXT);
		const seen: HarnessEvent[] = [];
		watch.start((event) => {
			seen.push(event);
		});

		await harness.close(BACKGROUND_CONTEXT);
		await settleEvents();
		expect(watch.snapshot.faulted).toBe(false);
		expect(seen).toEqual([]);
		await expect(harness.watchSession(BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessClosed);
		watch.unsubscribe();
	});

	it("delivers the fault event, folds faulted, seals delivery, and rejects later requests", async () => {
		const storage = new FailingMemoryStorage();
		const { harness } = await createFixture(
			new StorageBackedSession({ id: "session-watch-fault", createdAt: 1, storageVersion: 1 }, storage),
		);
		const main = await harness.lane("main", BACKGROUND_CONTEXT);
		const watch = await harness.watchSession(BACKGROUND_CONTEXT);
		const events: HarnessEvent[] = [];
		watch.start((event) => {
			events.push(event);
		});

		storage.failure = new Error("storage boom");
		await expect(main.appendCustomEntry("note", undefined, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessFault);
		await settleEvents();
		expect(events.filter(({ type }) => type === "fault")).toHaveLength(1);
		expect(fold(watch.snapshot, events).faulted).toBe(true);
		await expect(harness.watchSession(BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessFault);
		await expect(watch.resnapshot(BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessFault);
		await settleEvents();
		expect(events).toHaveLength(1);
		watch.unsubscribe();
	});
});
