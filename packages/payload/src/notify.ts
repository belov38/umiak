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
	| "sbx_identity"
	| "sbx_config"
	| "sbx_routes"
	| "sbx_ssh_revoke";

type SQL = ReturnType<typeof sql>;

/** The drizzle handle of the request transaction, or of the pool without one. */
async function txDb(req: PayloadRequest) {
	const adapter = req.payload.db as unknown as PostgresAdapter;
	const id =
		req.transactionID instanceof Promise
			? await req.transactionID
			: req.transactionID;
	const session =
		id === undefined || id === null ? undefined : adapter.sessions[id];
	return session?.db ?? adapter.drizzle;
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
