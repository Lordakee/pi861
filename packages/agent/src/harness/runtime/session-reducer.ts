import type { CurrentOperationInfo, HarnessEvent, LaneInfo, SessionSnapshot } from "../agent-harness.ts";

function cloneSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
	return {
		faulted: snapshot.faulted,
		lanes: snapshot.lanes.map((lane) => ({
			name: lane.name,
			tipId: lane.tipId,
			operation: lane.operation === null ? null : { ...lane.operation },
		})),
	};
}

function laneByName(lanes: LaneInfo[], name: string): LaneInfo | undefined {
	return lanes.find((lane) => lane.name === name);
}

function operationOf(lane: LaneInfo, operationId: string): CurrentOperationInfo | undefined {
	return lane.operation?.id === operationId ? lane.operation : undefined;
}

/**
 * Normative session snapshot fold: applying one committed harness event to a session snapshot returns the next
 * snapshot. The fold covers exactly the fields represented by `SessionSnapshot` — lane inventory, each lane's tip
 * and current operation projection, and harness fault state; it clones its input rather than mutating caller state
 * and never requires a rebase because the session projection carries no transcript payload. `lane_created` inserts
 * the new lane at its creation tip with no current operation; later lane-scoped events update only the affected
 * lane; `fault` sets `faulted`. Events without a session projection (handler errors, transcript frames, queues,
 * configuration, usage) leave the inventory unchanged. Folded operation projections carry no `capturedModel`; only
 * `AgentHarness.lanes()` reports it.
 */
export function reduceSessionSnapshot(snapshot: SessionSnapshot, event: HarnessEvent): SessionSnapshot {
	const next = cloneSnapshot(snapshot);
	const lane = "lane" in event && typeof event.lane === "string" ? laneByName(next.lanes, event.lane) : undefined;
	switch (event.type) {
		case "lane_created":
			if (laneByName(next.lanes, event.lane) === undefined) {
				next.lanes.push({ name: event.lane, tipId: event.at, operation: null });
				next.lanes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			}
			return next;
		case "run_start":
			if (lane !== undefined) {
				lane.operation = { id: event.runId, kind: "run", startedAt: event.startedAt, status: "open" };
			}
			return next;
		case "compaction_start":
			// In-run compaction brackets stay inside the open run; only a standalone start opens an operation.
			if (lane !== undefined && lane.operation === null) {
				lane.operation = { id: event.runId, kind: "compaction", startedAt: event.startedAt, status: "open" };
			}
			return next;
		case "navigation_start":
			if (lane !== undefined) {
				lane.operation = { id: event.runId, kind: "navigation", startedAt: event.startedAt, status: "open" };
			}
			return next;
		case "operation_abort":
			if (lane !== undefined) {
				const operation = operationOf(lane, event.operationId);
				if (operation !== undefined) operation.status = "aborting";
			}
			return next;
		case "run_end":
			if (lane !== undefined && operationOf(lane, event.runId)?.kind === "run") {
				lane.operation = null;
				lane.tipId = event.tipId;
			}
			return next;
		case "compaction_end":
			if (lane !== undefined && operationOf(lane, event.runId)?.kind === "compaction") lane.operation = null;
			return next;
		case "navigation_end":
			if (lane !== undefined && operationOf(lane, event.runId)?.kind === "navigation") {
				lane.operation = null;
				lane.tipId = event.tipId;
			}
			return next;
		case "entry_added":
			if (lane !== undefined) lane.tipId = event.entry.id;
			return next;
		case "fault":
			next.faulted = true;
			return next;
		case "run_resume":
		case "run_suspend":
		case "retry_scheduled":
		case "retry_start":
		case "retry_end":
		case "turn_start":
		case "turn_end":
		case "message_start":
		case "message_update":
		case "message_end":
		case "tool_start":
		case "tool_update":
		case "tool_end":
		case "queue_update":
		case "value_update":
		case "config_update":
		case "usage":
		case "handler_error":
			return next;
	}
}
