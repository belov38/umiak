// NOTIFY from Payload hooks (S8 §8, plan decision 3). Statements run in the
// transaction of the Payload request (the adapter session of
// req.transactionID), so Postgres delivers notifications only after commit
// and a listener reads the new data. Payload operations open a transaction
// themselves unless the caller passed one, so hooks normally have it; without
// one the statement is its own short transaction. Errors are thrown: the hook
// fails, Payload rolls the write back.
import { type PostgresAdapter, sql } from "@payloadcms/db-postgres";
import type { PayloadRequest } from "payload";

export type NotifyChannel =
	| "umiak_identity"
	| "umiak_config"
	| "umiak_routes"
	| "umiak_ssh_revoke";

type SQL = ReturnType<typeof sql>;

/**
 * The drizzle handle of the request transaction, or of the pool without one.
 * A transaction id without a session (already committed or rolled back)
 * throws: running outside it would notify for a write that may not exist.
 */
async function txDb(req: PayloadRequest) {
	const adapter = req.payload.db as unknown as PostgresAdapter;
	const id =
		req.transactionID instanceof Promise
			? await req.transactionID
			: req.transactionID;
	if (id === undefined || id === null || id === "") return adapter.drizzle;
	const session = adapter.sessions[id];
	if (!session) {
		throw new Error(`notify: transaction ${id} of the request is not open`);
	}
	return session.db;
}

/** Runs SQL in the transaction of the request; returns the rows. */
export async function txQuery<T extends Record<string, unknown>>(
	req: PayloadRequest,
	query: SQL,
): Promise<T[]> {
	const db = await txDb(req);
	const r = (await db.execute(query)) as unknown as { rows: T[] };
	return r.rows;
}

export async function notify(
	req: PayloadRequest,
	channel: NotifyChannel,
	payload: string,
): Promise<void> {
	await txQuery(req, sql`SELECT pg_notify(${channel}, ${payload})`);
}
