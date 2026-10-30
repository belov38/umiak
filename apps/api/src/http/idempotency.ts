// Idempotency-Key of the create-like routes (S7 §5.7): the header is checked
// here and passed to core, which stores and replays the result. A replay is
// recognised by its operation: one created before this request started
// (database clock on both sides, so host clock skew does not matter).
import { validateIdempotencyKey } from "@sbx/core";
import type { Context } from "hono";
import type pg from "pg";
import type { ApiEnv } from "../deps.ts";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_REPLAYED_HEADER = "Idempotency-Replayed";

/** The header value (400 validation if malformed), undefined without one. */
export function idempotencyKeyHeader(c: Context<ApiEnv>): string | undefined {
	const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
	if (key === undefined) return undefined;
	validateIdempotencyKey(key);
	return key;
}

/**
 * The start of a keyed request on the database clock; null without a key
 * (or a database), when no replay check is needed.
 */
export async function idempotencyStart(
	pool: pg.Pool | null,
	key: string | undefined,
): Promise<Date | null> {
	if (key === undefined || pool === null) return null;
	const r = await pool.query<{ t: Date }>("SELECT clock_timestamp() AS t");
	return r.rows[0]?.t ?? null;
}

/** `Idempotency-Replayed: true` when the operation predates the request. */
export function replayHeaders(
	start: Date | null,
	operation: { createdAt: Date },
): Record<string, string> {
	return start !== null && operation.createdAt.getTime() < start.getTime()
		? { [IDEMPOTENCY_REPLAYED_HEADER]: "true" }
		: {};
}
