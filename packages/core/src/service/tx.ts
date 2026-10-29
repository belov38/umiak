import { type Tx, withTx } from "@sbx/db";
import type pg from "pg";
import { outOfCapacity } from "../errors.ts";
import { OUT_OF_CAPACITY_RETRY_SECONDS } from "./create-placement.ts";

// Transactions of the admission paths (create, fork, resume, recover). They
// take team, node and row locks; a deadlock (40P01) or a serialization failure
// (40001) aborts the whole transaction and nothing of it is left, so the
// transaction is simply run again. After the retries the caller gets a
// retryable `out_of_capacity`, never a raw database error.

/** Extra runs of a transaction that failed with 40P01/40001. */
export const SERVICE_TX_RETRIES = 3;

const RETRYABLE_TX_CODES: readonly string[] = ["40P01", "40001"];

export function isTxConflict(e: unknown): boolean {
	const code = (e as { code?: unknown } | null)?.code;
	return typeof code === "string" && RETRYABLE_TX_CODES.includes(code);
}

/** `withTx` with retries on deadlock/serialization failure; `fn` must be re-runnable. */
export async function withServiceTx<T>(
	pool: pg.Pool,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	for (let retry = 0; ; retry++) {
		try {
			return await withTx(pool, fn);
		} catch (e) {
			if (!isTxConflict(e)) throw e;
			if (retry >= SERVICE_TX_RETRIES) {
				throw outOfCapacity(OUT_OF_CAPACITY_RETRY_SECONDS);
			}
		}
	}
}
