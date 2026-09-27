import type { CommittedWrite } from "../commit.ts";
import type { InMemoryStorageState } from "../in-memory-storage-state.ts";
import { serializeJsonlTransaction } from "./io.ts";
import type { JsonlCompactionPolicy, JsonlStorageHeader } from "./types.ts";

const utf8Encoder = new TextEncoder();

/** UTF-8 byte length of a serialized JSONL fragment. */
export function jsonlUtf8Bytes(text: string): number {
	return utf8Encoder.encode(text).length;
}

export interface JsonlByteAccounting {
	/** Header plus every complete transaction line, each including its terminating newline. */
	physicalBytes: number;
	/** Bytes of records that still represent current logical state. */
	liveBytes: number;
	/** Bytes of superseded or deleted records plus delete records, which have no survivor. */
	deadBytes: number;
}

/** Current-state snapshot for a rewrite: surviving writes and the sequence high-water mark. */
export interface JsonlSnapshot {
	writes: readonly CommittedWrite[];
	nextSeq: number;
}

function physicalKey(namespace: string, key: string): string {
	return `${namespace}\u0000${key}`;
}

function fragmentBytes(write: CommittedWrite): number {
	return jsonlUtf8Bytes(JSON.stringify(write));
}

/**
 * Dead-byte accounting for one format-4 JSONL file.
 *
 * Liveness follows the storage model: entries and usage rows are immutable and live forever;
 * a scalar `set` supersedes the previous set for the same address; a scalar `delete` kills that
 * value and is itself born dead because it has no surviving record; a list `append` stays live
 * until its list key is deleted, which kills every prior element; immutable terminal `pi.result`
 * values are never reclaimed. Dead bytes are attributed per write by serialized fragment length,
 * so framing shared with live writes of the same line is only reclaimed physically by a rewrite
 * and never counts toward thresholds; thresholds therefore fire conservatively.
 */
export class JsonlDeadByteLedger {
	private physicalBytes: number;
	private deadBytes: number;
	/** Serialized fragment length per live mutable write, keyed by sequence. */
	private readonly fragments = new Map<number, number>();
	private readonly scalarSeqs = new Map<string, number>();
	private readonly listSeqs = new Map<string, Set<number>>();

	constructor(headerBytes: number) {
		this.physicalBytes = headerBytes;
		this.deadBytes = 0;
	}

	/** Account one complete transaction line, including its terminating newline. */
	ingestTransaction(writes: readonly CommittedWrite[], lineBytes: number): void {
		this.physicalBytes += lineBytes;
		for (const write of writes) this.ingestWrite(write);
	}

	getAccounting(): JsonlByteAccounting {
		return {
			physicalBytes: this.physicalBytes,
			liveBytes: this.physicalBytes - this.deadBytes,
			deadBytes: this.deadBytes,
		};
	}

	private ingestWrite(write: CommittedWrite): void {
		switch (write.kind) {
			case "entry":
			case "usage":
				return;
			case "value": {
				if (write.namespace === "pi.result") return;
				const key = physicalKey(write.namespace, write.key);
				this.killScalar(key);
				if (write.op === "delete") {
					this.deadBytes += fragmentBytes(write);
					return;
				}
				this.fragments.set(write.seq, fragmentBytes(write));
				this.scalarSeqs.set(key, write.seq);
				return;
			}
			case "list": {
				const key = physicalKey(write.namespace, write.key);
				const live = this.listSeqs.get(key);
				if (write.op === "delete") {
					if (live !== undefined) {
						for (const seq of live) this.killFragment(seq);
						this.listSeqs.delete(key);
					}
					this.deadBytes += fragmentBytes(write);
					return;
				}
				if (live === undefined) this.listSeqs.set(key, new Set([write.seq]));
				else live.add(write.seq);
				this.fragments.set(write.seq, fragmentBytes(write));
				return;
			}
		}
	}

	private killScalar(key: string): void {
		const seq = this.scalarSeqs.get(key);
		if (seq === undefined) return;
		this.scalarSeqs.delete(key);
		this.killFragment(seq);
	}

	private killFragment(seq: number): void {
		const bytes = this.fragments.get(seq);
		if (bytes === undefined) return;
		this.fragments.delete(seq);
		this.deadBytes += bytes;
	}
}

/** Physical size of a serialized header line, including its terminating newline. */
export function headerLineBytes(header: JsonlStorageHeader): number {
	return jsonlUtf8Bytes(JSON.stringify(header)) + 1;
}

/** Physical size of a serialized transaction line, including its terminating newline. */
export function transactionLineBytes(writes: readonly CommittedWrite[]): number {
	return jsonlUtf8Bytes(serializeJsonlTransaction(writes)) + 1;
}

/** Pure threshold decision: every bound must be met, inclusive. */
export function shouldCompactJsonlFile(accounting: JsonlByteAccounting, policy: JsonlCompactionPolicy): boolean {
	if (!policy.enabled) return false;
	if (accounting.physicalBytes < policy.minBytes) return false;
	if (accounting.deadBytes < policy.minDeadBytes) return false;
	return accounting.deadBytes >= accounting.physicalBytes * policy.deadRatio;
}

/** Assemble the rewrite snapshot from materialized current state; no I/O. */
export function buildJsonlSnapshot(state: InMemoryStorageState): JsonlSnapshot {
	return { writes: state.snapshotCommittedWrites(), nextSeq: state.getNextSeq() };
}

/** Ledger for a freshly published snapshot: every surviving write is live, one write per line. */
export function ledgerFromSnapshot(header: JsonlStorageHeader, writes: readonly CommittedWrite[]): JsonlDeadByteLedger {
	const ledger = new JsonlDeadByteLedger(headerLineBytes(header));
	for (const write of writes) ledger.ingestTransaction([write], transactionLineBytes([write]));
	return ledger;
}
