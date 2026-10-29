import type { Tx } from "@sbx/db";
import { idempotencyKeyReused, validation } from "./errors.ts";

// Idempotency keys (S6 §14.1, S7 §5.7, decision 3). The key row is written
// FIRST in the transaction of the action with pre-generated resource ids:
// - a concurrent duplicate blocks on the primary key until the first commits,
//   then sees its row and replays it (or gets the key if the first rolled back);
// - a request that fails rolls the row back with everything else.
// `response` holds ids only, never request values (S6 §13.1).

export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

/** S7 §5.7: 1-255 printable ASCII characters. */
export function validateIdempotencyKey(key: string): void {
	if (
		typeof key !== "string" ||
		key.length > 255 ||
		!/^[\x20-\x7e]+$/.test(key)
	) {
		throw validation([
			{
				path: "Idempotency-Key",
				message: "must be 1 to 255 printable ASCII characters",
			},
		]);
	}
}

export interface IdempotencyClaimInput {
	/** `idempotencyPrincipal(p)`: the API key, else the user. */
	principalId: string;
	/** `sandboxes.create`, `sandboxes.fork`, `commands.create`, `snapshots.create`. */
	scope: string;
	key: string;
	/** `requestHash(scope, body)` over the full body, secrets included. */
	requestHash: Buffer;
	sandboxId?: string | null;
	operationId?: string | null;
	ttlSeconds?: number;
}

export type IdempotencyClaim =
	| { kind: "new" }
	| { kind: "replay"; sandboxId: string | null; operationId: string | null };

/**
 * Takes the key for this request, or returns the ids stored by the first
 * request with the same body. Throws `idempotency_key_reused` for another body.
 * An expired row counts as absent.
 */
export async function claimIdempotencyKey(
	tx: Tx,
	input: IdempotencyClaimInput,
): Promise<IdempotencyClaim> {
	validateIdempotencyKey(input.key);
	const { principalId, scope, key } = input;
	const sandboxId = input.sandboxId ?? null;
	const operationId = input.operationId ?? null;
	await tx.client.query(
		`DELETE FROM runtime.idempotency_keys
		 WHERE principal_id = $1 AND scope = $2 AND key = $3 AND expires_at < now()`,
		[principalId, scope, key],
	);
	const ins = await tx.client.query(
		`INSERT INTO runtime.idempotency_keys
		   (principal_id, key, scope, request_hash, operation_id, sandbox_id, response, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))
		 ON CONFLICT DO NOTHING
		 RETURNING 1`,
		[
			principalId,
			key,
			scope,
			input.requestHash,
			operationId,
			sandboxId,
			JSON.stringify({ sandboxId, operationId }),
			input.ttlSeconds ?? IDEMPOTENCY_TTL_SECONDS,
		],
	);
	if (ins.rowCount === 1) return { kind: "new" };

	// The conflicting row is committed (the insert waited for it), so a new
	// statement in READ COMMITTED sees it.
	const cur = await tx.client.query<{
		request_hash: Buffer;
		sandbox_id: string | null;
		operation_id: string | null;
	}>(
		`SELECT request_hash, sandbox_id, operation_id FROM runtime.idempotency_keys
		 WHERE principal_id = $1 AND scope = $2 AND key = $3`,
		[principalId, scope, key],
	);
	const row = cur.rows[0];
	if (!row) {
		throw new Error("claimIdempotencyKey: conflicting key row disappeared");
	}
	if (!row.request_hash.equals(input.requestHash)) throw idempotencyKeyReused();
	return {
		kind: "replay",
		sandboxId: row.sandbox_id,
		operationId: row.operation_id,
	};
}
