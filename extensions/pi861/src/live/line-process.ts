import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { record } from "../search.ts";

export interface ProcessSpec { command: string; args: string[]; cwd: string; env?: Record<string, string>; }
interface Waiter { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; }

/** Strict LF framing, bounded records, and correlated responses. Never shell-interpolates arguments. */
export class LineProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, Waiter>();
	private readonly listeners = new Set<(event: Record<string, unknown>) => void>();
	private buffer = "";
	private closed = false;
	private failure: Error | undefined;
	private readonly decoder = new StringDecoder("utf8");
	private readonly exited: Promise<void>;
	constructor(spec: ProcessSpec, maxRecordBytes = 4_194_304) {
		if (!spec.command || !spec.cwd) throw new Error("Executable and working directory required");
		this.child = spawn(spec.command, spec.args, {
			cwd: spec.cwd, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...spec.env },
			stdio: ["pipe", "pipe", "pipe"], shell: false, detached: process.platform !== "win32",
		});
		// Resolved when the child is fully gone; close() hands this to callers so they do not
		// race process teardown (for example deleting the child's working directory on Windows).
		this.exited = new Promise((resolve) => { this.child.once("close", () => resolve()); });
		this.child.stderr.resume(); // Do not put arbitrary stderr/credentials in the model context.
		this.child.stdin.on("error", () => this.fail(new Error("Child input pipe failed")));
		this.child.on("error", () => this.fail(new Error("Child process could not start")));
		this.child.on("close", () => this.fail(new Error("Child process closed")));
		this.child.stdout.on("data", (chunk: Buffer) => {
			if (this.closed) return;
			this.buffer += this.decoder.write(chunk);
			while (this.buffer.includes("\n")) {
				const boundary = this.buffer.indexOf("\n");
				const line = this.buffer.slice(0, boundary).replace(/\r$/, "");
				this.buffer = this.buffer.slice(boundary + 1);
				if (!line.trim()) continue;
				if (Buffer.byteLength(line) > maxRecordBytes) { this.fail(new Error("Child record too large")); return; }
				try {
					const event = record(JSON.parse(line));
					if (!event) throw new Error("Expected JSON object");
					const id = typeof event.id === "string" ? event.id : undefined;
					if (id && this.pending.has(id) && (event.type === "response" || "result" in event || "error" in event)) {
						const waiter = this.pending.get(id); this.pending.delete(id); waiter?.resolve(event);
					} else for (const listener of this.listeners) listener(event);
				} catch { this.fail(new Error("Invalid child protocol frame")); return; }
			}
			if (Buffer.byteLength(this.buffer) > maxRecordBytes) this.fail(new Error("Child record too large"));
		});
	}
	onEvent(listener: (event: Record<string, unknown>) => void): () => void {
		this.listeners.add(listener); return () => this.listeners.delete(listener);
	}
	send(value: Record<string, unknown>): void {
		if (this.closed) throw this.failure ?? new Error("Process closed");
		this.child.stdin.write(`${JSON.stringify(value)}\n`);
	}
	async request(value: Record<string, unknown>, signal: AbortSignal, timeoutMs = 30_000): Promise<Record<string, unknown>> {
		signal.throwIfAborted();
		const id = randomUUID();
		const effective = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
		let listener: (() => void) | undefined;
		try {
			return await new Promise<Record<string, unknown>>((resolve, reject) => {
				listener = () => { this.pending.delete(id); reject(effective.reason); };
				effective.addEventListener("abort", listener, { once: true });
				this.pending.set(id, { resolve, reject });
				try { this.send({ ...value, id }); } catch (error) { this.pending.delete(id); reject(error); }
			});
		} finally { if (listener) effective.removeEventListener("abort", listener); }
	}
	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true; this.failure = error;
		for (const waiter of this.pending.values()) waiter.reject(error);
		this.pending.clear();
		for (const listener of this.listeners) {
			try { listener({ type: "process_error", message: error.message }); } catch { /* best effort terminal notification */ }
		}
		if (process.platform !== "win32" && this.child.pid) {
			try { process.kill(-this.child.pid, "SIGTERM"); } catch { this.child.kill(); }
		} else this.child.kill();
	}
	close(): Promise<void> {
		this.listeners.clear(); this.fail(new Error("Process closed by owner"));
		return this.exited;
	}
}
