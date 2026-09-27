/**
 * Optional composition example. Install pg in a separate, operator-owned
 * extension directory and preserve the relative paths when copying this file.
 * Never use a superuser or BYPASSRLS role for these queries.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { installPi861 } from "../index.ts";
import { OutboxConsumer, PostgresMemory } from "../src/postgres.ts";
import { FileStateStore, ResilientBackend } from "../src/live/store.ts";

export default function postgresPi861(pi) {
	const connectionString = process.env.PI861_DATABASE_URL;
	const tenantId = process.env.PI861_TENANT_ID;
	const principalId = process.env.PI861_AGENT_ID;
	const projectId = process.env.PI861_PROJECT_ID;
	if (!connectionString || !tenantId || !principalId || !projectId) {
		throw new Error("Set PI861_DATABASE_URL, PI861_TENANT_ID, PI861_AGENT_ID and PI861_PROJECT_ID");
	}
	const url = new URL(connectionString);
	const allowLocalPlaintext = process.env.PI861_PG_ALLOW_LOCAL_PLAINTEXT === "1" &&
		["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
	// Do not allow URL SSL parameters to replace the explicitly verified TLS policy.
	for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(name);
	const ca = process.env.PI861_PG_CA_FILE;
	const pool = new pg.Pool({
		connectionString: url.toString(), max: 4, connectionTimeoutMillis: 10_000,
		ssl: allowLocalPlaintext ? false : { rejectUnauthorized: true, ...(ca ? { ca: readFileSync(ca, "utf8") } : {}) },
	});
	pool.on("error", () => console.error("Pi861: PostgreSQL connection unavailable; pending writes stay uncommitted locally"));
	const scope = `project:${projectId}`;
	const identity = {
		tenantId, principalId, readScopes: [scope], writeScopes: [scope],
	};
	// Single authority: per-record PostgreSQL memory. Failed writes become explicitly
	// uncommitted local records (same requestId on replay) instead of being dropped.
	const pending = new FileStateStore(
		join(process.env.PI861_STATE_DIR ?? tmpdir(), "pi861-pending.json"),
		{ pending: [] },
	);
	const backend = new ResilientBackend(new PostgresMemory(pool, identity), pending);
	installPi861(pi, { memory: { backend, scope, autoRecall: true, autoCapture: true } });
	// Drain the queue whenever the database becomes reachable again.
	pi.on("session_start", () => { void backend.flush(); });
	pi.on("session_shutdown", async () => {
		// A queued outbox event is not an updated index: drain it before shutdown.
		const consumer = new OutboxConsumer(pool, identity);
		let processed = 0;
		do {
			const outcome = await consumer.consume(50, async (event) => {
				// Replace with the real derived-index update; must be idempotent.
				console.log(`Pi861 index event: ${event.action} ${event.scope}/${event.memoryId}@${event.revision}`);
			});
			processed = outcome.processed;
		} while (processed > 0);
		await pool.end();
	});
}
