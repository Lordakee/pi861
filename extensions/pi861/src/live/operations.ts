import { digest } from "../memory.ts";
import { McpFailure } from "./mcp.ts";
import type { StateStore } from "./store.ts";

export interface OperationIntent {
	requestId: string;
	principal: string;
	resource: string;
	fingerprint: string;
	readOnly: boolean;
}
export interface OperationReceipt extends OperationIntent {
	state: "dispatched" | "committed" | "unknown" | "not_dispatched" | "resolved";
	result?: unknown;
	evidence?: string;
	updatedAt: number;
}
export interface OperationState {
	receipts: Record<string, OperationReceipt>;
}

/** Durable at-most-once dispatch per intent. Unknown side effects require trusted reconciliation, not timed replay. */
export class OperationJournal {
	private readonly store: StateStore<OperationState>;
	constructor(store: StateStore<OperationState>) {
		this.store = store;
	}
	async run(intent: OperationIntent, dispatch: () => Promise<unknown>): Promise<unknown> {
		if (!intent.requestId || !intent.principal || !intent.resource || !intent.fingerprint)
			throw new Error("Operation identity required");
		const key = digest([intent.principal, intent.requestId]);
		const admitted = await this.store.update((state) => {
			const prior = state.receipts[key];
			if (prior) {
				if (
					prior.resource !== intent.resource ||
					prior.fingerprint !== intent.fingerprint ||
					prior.readOnly !== intent.readOnly
				)
					throw new Error("Operation idempotency conflict");
				if (prior.state === "committed") return { cached: true, result: prior.result };
				throw new Error(
					`Operation ${intent.requestId} has ${prior.state} outcome; reconcile or create a reviewed new intent`,
				);
			}
			if (
				!intent.readOnly &&
				Object.values(state.receipts).some(
					(receipt) =>
						receipt.resource === intent.resource &&
						receipt.fingerprint === intent.fingerprint &&
						["unknown", "dispatched"].includes(receipt.state),
				)
			) {
				throw new Error("An equivalent operation has an unresolved outcome; automatic redispatch refused");
			}
			if (Object.keys(state.receipts).length >= 100_000)
				throw new Error("Operation journal capacity reached; operator archival required");
			state.receipts[key] = { ...intent, state: "dispatched", updatedAt: Date.now() };
			return { cached: false, result: undefined };
		});
		if (admitted.cached) return admitted.result;
		try {
			const result = await dispatch();
			if (result === undefined || Buffer.byteLength(JSON.stringify(result)) > 131_072)
				throw new Error("Journal result requires a bounded artifact reference");
			await this.store.update((state) => {
				const receipt = state.receipts[key];
				if (!receipt || receipt.state !== "dispatched") throw new Error("Operation publication state changed");
				receipt.result = result;
				receipt.state = "committed";
				receipt.updatedAt = Date.now();
			});
			return result;
		} catch (error) {
			await this.store
				.update((state) => {
					const receipt = state.receipts[key];
					if (receipt?.state === "dispatched") {
						receipt.state =
							error instanceof McpFailure && error.outcome === "not_dispatched" ? "not_dispatched" : "unknown";
						receipt.updatedAt = Date.now();
					}
				})
				.catch(() => {});
			throw error;
		}
	}
	async list(principal: string): Promise<Omit<OperationReceipt, "result" | "fingerprint">[]> {
		return Object.values((await this.store.read()).receipts)
			.filter((receipt) => receipt.principal === principal)
			.map(({ result: _result, fingerprint: _fingerprint, ...receipt }) => receipt);
	}
	/** Operator-only: evidence describes how the external state was reconciled. Never exposed as a model tool. */
	async resolve(principal: string, requestId: string, evidence: string): Promise<void> {
		if (!evidence.trim() || evidence.length > 4000) throw new Error("Reconciliation evidence required");
		await this.store.update((state) => {
			const receipt = state.receipts[digest([principal, requestId])];
			if (!receipt || !["dispatched", "unknown", "not_dispatched"].includes(receipt.state))
				throw new Error("No unresolved owned operation");
			receipt.state = "resolved";
			receipt.evidence = evidence;
			receipt.updatedAt = Date.now();
		});
	}
}
