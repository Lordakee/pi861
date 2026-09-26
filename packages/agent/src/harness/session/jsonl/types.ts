import type { FileSystem } from "../../types.ts";
import type { SessionCreateOptions, SessionMetadata } from "../types.ts";

export const JSONL_FORMAT_VERSION = 4;
export const JSONL_STORAGE_VERSION = 1;

export interface JsonlStorageHeader {
	v: typeof JSONL_FORMAT_VERSION;
	kind: "header";
	id: string;
	storageVersion: number;
	createdAt: number;
	cwd: string;
	parentSessionId?: string;
	legacyParentSessionPath?: string;
	/** Sequence high-water mark written by snapshot rewrites. */
	nextSeq?: number;
}

/**
 * Threshold policy for JSONL snapshot compaction (harness.md §1.7).
 *
 * Byte accounting counts the UTF-8 length of the header line and of every complete transaction
 * line, each including its terminating newline. A write is dead once superseded (scalar set over
 * set) or deleted (scalar delete, whole-list delete); delete writes have no surviving record and
 * are born dead. Entries, usage rows, and immutable terminal `pi.result` values stay live forever.
 * Compaction is considered after open replay (torn-tail repair first) and after any commit that
 * deletes a value or list, only when every threshold is met; between compactions commits stay O(1).
 */
export interface JsonlCompactionOptions {
	/** Enable threshold-driven compaction. Default: true. */
	enabled?: boolean;
	/** Minimum complete-file size in bytes before compaction is considered. Default: 1 MiB. */
	minBytes?: number;
	/** Minimum dead bytes before compaction is considered. Default: 256 KiB. */
	minDeadBytes?: number;
	/** Minimum dead-byte fraction of physical bytes, inclusive. Default: 0.25. */
	deadRatio?: number;
}

export interface JsonlCompactionPolicy {
	enabled: boolean;
	minBytes: number;
	minDeadBytes: number;
	deadRatio: number;
}

/** Conservative defaults: rewrite only files of at least 1 MiB with at least 256 KiB dead at a 25% dead ratio. */
export const DEFAULT_JSONL_COMPACTION_POLICY: JsonlCompactionPolicy = {
	enabled: true,
	minBytes: 2 ** 20,
	minDeadBytes: 2 ** 18,
	deadRatio: 0.25,
};

function requireByteThreshold(value: number | undefined, field: string): number {
	if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Invalid JSONL compaction ${field}: ${String(value)}`);
	}
	return value;
}

/** Validate and complete a compaction policy; throws on non-finite, negative, or fractional input. */
export function resolveJsonlCompactionPolicy(options: JsonlCompactionOptions | undefined): JsonlCompactionPolicy {
	if (options === undefined) return { ...DEFAULT_JSONL_COMPACTION_POLICY };
	const policy = { ...DEFAULT_JSONL_COMPACTION_POLICY };
	if (options.enabled !== undefined) {
		if (typeof options.enabled !== "boolean") {
			throw new Error(`Invalid JSONL compaction enabled: ${String(options.enabled)}`);
		}
		policy.enabled = options.enabled;
	}
	policy.minBytes = requireByteThreshold(options.minBytes ?? policy.minBytes, "minBytes");
	policy.minDeadBytes = requireByteThreshold(options.minDeadBytes ?? policy.minDeadBytes, "minDeadBytes");
	if (options.deadRatio !== undefined) {
		if (!Number.isFinite(options.deadRatio) || options.deadRatio < 0 || options.deadRatio > 1) {
			throw new Error(`Invalid JSONL compaction deadRatio: ${String(options.deadRatio)}`);
		}
		policy.deadRatio = options.deadRatio;
	}
	return policy;
}

export interface JsonlStorageOptions {
	fileSystem: FileSystem;
	path: string;
	now?: () => number;
	compaction?: JsonlCompactionOptions;
}

export interface JsonlSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	/** Filesystem modification time as milliseconds since Unix epoch. */
	modifiedAt: number;
}

export interface JsonlSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
}

export interface JsonlSessionListOptions {
	cwd?: string;
}

export interface JsonlSessionRepoOptions {
	fileSystem: FileSystem;
	sessionsRoot: string;
	now?: () => number;
	/** Compaction policy applied to every storage this repository creates or opens. */
	compaction?: JsonlCompactionOptions;
}
