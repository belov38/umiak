import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { schema } from "./schema/index.ts";

export type Db = NodePgDatabase<typeof schema>;

/** A transaction: Drizzle and the raw client share the same connection. */
export interface Tx {
	db: Db;
	client: pg.PoolClient;
}

export interface CreatePoolOptions {
	/** Called for errors of idle clients (a dropped connection); default: ignored. */
	onError?: (err: Error) => void;
}

export function createPool(
	url: string,
	max = 20,
	opts: CreatePoolOptions = {},
): pg.Pool {
	const pool = new pg.Pool({ connectionString: url, max });
	// An idle client that loses its connection emits 'error' on the pool; without
	// a listener that crashes the process. The pool drops the client itself and
	// the next query gets a fresh connection or fails visibly.
	const onError = opts.onError;
	pool.on("error", (err) => onError?.(err));
	return pool;
}

/** Drizzle over the pool, for statements outside a transaction. */
export function dbOf(pool: pg.Pool): Db {
	return drizzle(pool, { schema });
}

/** Runs fn inside BEGIN/COMMIT on one pooled connection; rolls back on an exception. */
export async function withTx<T>(
	pool: pg.Pool,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	let broken: Error | undefined;
	try {
		await client.query("BEGIN");
		try {
			const result = await fn({ db: drizzle(client, { schema }), client });
			await client.query("COMMIT");
			return result;
		} catch (err) {
			await client.query("ROLLBACK").catch((e: unknown) => {
				broken = e instanceof Error ? e : new Error(String(e));
			});
			throw err;
		}
	} finally {
		client.release(broken);
	}
}
