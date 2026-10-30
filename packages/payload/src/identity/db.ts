// SQL and transaction helpers of the identity code. Reads that need row
// locks or joins go through SQL in the request transaction; writes that
// must notify go through the Local API with the same req, so hooks send
// NOTIFY in that transaction.
import { type PostgresAdapter, sql } from "@payloadcms/db-postgres";
import {
	commitTransaction,
	createLocalReq,
	initTransaction,
	killTransaction,
	type Payload,
	type PayloadRequest,
	ValidationError,
} from "payload";
import { txQuery } from "../notify.ts";

type SQL = ReturnType<typeof sql>;

export { sql };

/** A table of the Payload schema. */
export function tbl(payload: Payload, name: string): SQL {
	const schema = payload.db.schemaName ?? "public";
	return sql`${sql.identifier(schema)}.${sql.identifier(name)}`;
}

/** Runs SQL in the transaction of `req`, or on the pool without one. */
export async function rows<T extends Record<string, unknown>>(
	payload: Payload,
	query: SQL,
	req?: PayloadRequest,
): Promise<T[]> {
	if (req) return txQuery<T>(req, query);
	const adapter = payload.db as unknown as PostgresAdapter;
	const r = (await adapter.drizzle.execute(query)) as unknown as { rows: T[] };
	return r.rows;
}

/** A timestamp column: drizzle may hand it over as a string. */
export function toDate(v: unknown): Date {
	return v instanceof Date ? v : new Date(String(v));
}

export function toDateOrNull(v: unknown): Date | null {
	return v === null || v === undefined ? null : toDate(v);
}

/**
 * Runs `fn` in a Payload transaction on `outer` (or a fresh local req).
 * When `outer` already has a transaction, it is the caller's: not
 * committed here. A failing Payload operation rolls back the transaction
 * of its req itself; killTransaction is a no-op then.
 */
export async function inTransaction<T>(
	payload: Payload,
	fn: (req: PayloadRequest, own: boolean) => Promise<T>,
	outer?: PayloadRequest,
): Promise<T> {
	const req = outer ?? (await createLocalReq({}, payload));
	const own = await initTransaction(req);
	try {
		const out = await fn(req, own);
		if (own) await commitTransaction(req);
		return out;
	} catch (e) {
		if (own) await killTransaction(req);
		throw e;
	}
}

/** SQLSTATE anywhere in the cause chain. */
export function pgCode(e: unknown): string | undefined {
	for (let c = e, i = 0; c && typeof c === "object" && i < 5; i++) {
		const code = (c as { code?: unknown }).code;
		if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
		c = (c as { cause?: unknown }).cause;
	}
	return undefined;
}

export const UNIQUE_VIOLATION = "23505";
export const FK_VIOLATION = "23503";

/**
 * A unique index refused the write. The adapter turns 23505 into a
 * ValidationError whose errors carry the table name (field validation
 * errors do not); `path` is the field when the adapter can tell it.
 */
export function uniqueViolation(e: unknown): { path: string | null } | null {
	if (pgCode(e) === UNIQUE_VIOLATION) return { path: null };
	if (e instanceof ValidationError) {
		const hit = e.data.errors.find(
			(x) => (x as { tableName?: unknown }).tableName !== undefined,
		);
		if (hit) return { path: hit.path ?? null };
	}
	return null;
}
