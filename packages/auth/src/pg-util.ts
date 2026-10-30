import type pg from "pg";

// Internal Postgres helpers of the identity stand-in (not exported from index).

export const UNIQUE_VIOLATION = "23505";
export const FK_VIOLATION = "23503";

/** SQLSTATE of a pg error, if any. */
export function pgCode(e: unknown): string | undefined {
	return typeof e === "object" && e !== null && "code" in e
		? String((e as { code: unknown }).code)
		: undefined;
}

/** BEGIN/COMMIT on one pooled connection; rolls back on an exception. */
export async function inTx<T>(
	pool: pg.Pool,
	fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
	const c = await pool.connect();
	let broken: Error | undefined;
	try {
		await c.query("BEGIN");
		try {
			const out = await fn(c);
			await c.query("COMMIT");
			return out;
		} catch (e) {
			await c.query("ROLLBACK").catch((err: unknown) => {
				broken = err instanceof Error ? err : new Error(String(err));
			});
			throw e;
		}
	} finally {
		c.release(broken);
	}
}
