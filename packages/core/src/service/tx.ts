import { type Tx, withTx } from "@umiak/db";
import { outOfCapacity } from "../errors.ts";
import type { SandboxServiceDeps } from "./common.ts";
import { OUT_OF_CAPACITY_RETRY_SECONDS } from "./create-placement.ts";

// Transactions of the admission paths (create, fork, resume, recover). They
// take team, node and row locks; a deadlock (40P01) or a serialization failure
// (40001) aborts the whole transaction and nothing of it is left, so the
// transaction is simply run again after a short jittered pause. After the
// retries the caller gets a retryable `out_of_capacity` (the database error is
// its `cause`), never a raw database error.

/** Extra runs of a transaction that failed with 40P01/40001. */
export const SERVICE_TX_RETRIES = 3;

const RETRYABLE_TX_CODES: readonly string[] = ["40P01", "40001"];

function txConflictCode(e: unknown): string | null {
	const code = (e as { code?: unknown } | null)?.code;
	return typeof code === "string" && RETRYABLE_TX_CODES.includes(code)
		? code
		: null;
}

export function isTxConflict(e: unknown): boolean {
	return txConflictCode(e) !== null;
}

/** 10-50 ms times the retry number, so colliding transactions drift apart. */
function backoffMs(retry: number): number {
	return (10 + Math.random() * 40) * retry;
}

/** `withTx` with retries on deadlock/serialization failure; `fn` must be re-runnable. */
export async function withServiceTx<T>(
	deps: Pick<SandboxServiceDeps, "pool" | "log">,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	for (let retry = 0; ; retry++) {
		try {
			return await withTx(deps.pool, fn);
		} catch (e) {
			const code = txConflictCode(e);
			if (code === null) throw e;
			if (retry >= SERVICE_TX_RETRIES) {
				// SQLSTATE only: the error text may quote request values.
				deps.log?.warn(
					{ sqlstate: code, attempts: retry + 1 },
					"service transaction conflicts exhausted the retries; out_of_capacity",
				);
				throw outOfCapacity(OUT_OF_CAPACITY_RETRY_SECONDS, e);
			}
			await new Promise((r) => setTimeout(r, backoffMs(retry + 1)));
		}
	}
}
