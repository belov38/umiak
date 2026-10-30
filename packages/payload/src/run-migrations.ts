// Runner of the payload schema migrations (S8 §12, plan decision 6). Like
// payload.db.migrate(), each migration runs in its own Payload transaction
// and is recorded in payload_migrations with a new batch, but:
// - a failure throws instead of exiting the process;
// - a session advisory lock serializes concurrent runs (the adapter takes none);
// - the migration list is the imported src/migrations/index.ts, not files read
//   from the directory by Payload's loader.
import type { PostgresAdapter } from "@payloadcms/db-postgres";
import {
	commitTransaction,
	createLocalReq,
	initTransaction,
	killTransaction,
	type Payload,
} from "payload";
import { dbPool } from "./db.ts";
import {
	type PayloadMigration,
	migrations as payloadMigrations,
} from "./migrations/index.ts";

export { type PayloadMigration, payloadMigrations };

/** Key of pg_advisory_lock held while Payload migrations run (db/migrations uses 727001). */
export const PAYLOAD_MIGRATION_LOCK_KEY = 727003;

function schemaOf(payload: Payload): string {
	return payload.db.schemaName ?? "public";
}

async function appliedNames(payload: Payload): Promise<Set<string> | null> {
	const pool = dbPool(payload);
	const table = `"${schemaOf(payload)}"."payload_migrations"`;
	const exists = await pool.query<{ t: string | null }>(
		"SELECT to_regclass($1)::text AS t",
		[table],
	);
	if (exists.rows[0]?.t == null) return null;
	const r = await pool.query<{ name: string }>(
		`SELECT name FROM ${table} WHERE name IS NOT NULL`,
	);
	return new Set(r.rows.map((x) => x.name));
}

/** Migrations known to this code and not applied (newer applied ones are ignored). */
export async function pendingPayloadMigrations(
	payload: Payload,
): Promise<string[]> {
	const applied = await appliedNames(payload);
	return payloadMigrations
		.map((m) => m.name)
		.filter((n) => applied === null || !applied.has(n));
}

/** Throws unless every migration known to this code is applied (readiness). */
export async function assertPayloadMigrated(payload: Payload): Promise<void> {
	const pending = await pendingPayloadMigrations(payload);
	if (pending.length > 0) {
		throw new Error(`payload migrations not applied: ${pending.join(", ")}`);
	}
}

/** Applies the pending migrations; returns their names. */
export async function migrateSbxPayload(
	payload: Payload,
	log: (msg: string) => void = (m) => payload.logger.info(m),
): Promise<string[]> {
	const pool = dbPool(payload);
	// One client is held by the adapter for good, one holds the lock and one
	// runs the migration transaction: a smaller pool would wait forever.
	if ((pool.options.max ?? 10) < 3) {
		throw new Error("migrateSbxPayload needs a pool of at least 3 connections");
	}
	const client = await pool.connect();
	let broken: Error | undefined;
	try {
		await client.query("SELECT pg_advisory_lock($1)", [
			PAYLOAD_MIGRATION_LOCK_KEY,
		]);
		try {
			const applied = await appliedNames(payload);
			let batch = 1;
			if (applied !== null) {
				const r = await client.query<{ b: string | null }>(
					`SELECT max(batch)::text AS b FROM "${schemaOf(payload)}"."payload_migrations" WHERE batch > 0`,
				);
				batch = Number(r.rows[0]?.b ?? 0) + 1;
			}
			const done: string[] = [];
			for (const m of payloadMigrations) {
				if (applied?.has(m.name)) continue;
				log(`applying payload migration ${m.name}`);
				await runOne(payload, m, batch);
				done.push(m.name);
			}
			if (done.length === 0) log("payload migrations are up to date");
			return done;
		} finally {
			await client
				.query("SELECT pg_advisory_unlock($1)", [PAYLOAD_MIGRATION_LOCK_KEY])
				.catch((e: unknown) => {
					broken = e instanceof Error ? e : new Error(String(e));
				});
		}
	} finally {
		// A broken connection is destroyed; that also releases the session lock.
		client.release(broken);
	}
}

async function runOne(
	payload: Payload,
	m: PayloadMigration,
	batch: number,
): Promise<void> {
	const req = await createLocalReq({}, payload);
	try {
		await initTransaction(req);
		const adapter = payload.db as unknown as PostgresAdapter;
		const id = await req.transactionID;
		const db =
			(id !== undefined && adapter.sessions[id]?.db) || adapter.drizzle;
		await m.up({ db, payload, req } as Parameters<PayloadMigration["up"]>[0]);
		await payload.create({
			collection: "payload-migrations",
			data: { name: m.name, batch },
			req,
		});
		await commitTransaction(req);
	} catch (err) {
		await killTransaction(req);
		throw new Error(`payload migration ${m.name} failed: ${String(err)}`, {
			cause: err,
		});
	}
}
