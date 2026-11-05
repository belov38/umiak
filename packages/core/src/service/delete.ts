import { type Tx, withTx } from "@umiak/db";
import { invalidState, notFound } from "../errors.ts";
import { uuidv7 } from "../ids.ts";
import type { JobSender } from "../jobs.ts";
import type { Principal } from "../principal.ts";
import { DELETE_RETRY_LIMIT } from "../queues.ts";
import { type Operation, operationFromRow } from "../rows.ts";
import { sandboxNext } from "../states.ts";
import {
	findSandboxRow,
	insertOperation,
	insertSandboxEvent,
	loadOperation,
	lockSandboxById,
	type SandboxRow,
	type SandboxServiceDeps,
} from "./common.ts";

// Delete supersedes (S6 §7.2). Lock order: the sandbox row first, then its
// operations; worker steps that touch both must take them in the same order.

async function deleteLocked(
	tx: Tx,
	jobs: JobSender,
	row: SandboxRow,
	principal: Principal | null,
	reason: string,
): Promise<Operation> {
	if (row.state === "deleting" || row.state === "deleted") {
		// The current delete: active while deleting, finished once deleted.
		const r = await tx.client.query(
			`SELECT * FROM runtime.operations WHERE sandbox_id = $1 AND kind = 'delete'
			 ORDER BY (state IN ('pending', 'running')) DESC, created_at DESC, id DESC
			 LIMIT 1`,
			[row.id],
		);
		if (!r.rows[0]) throw invalidState(row.state);
		return operationFromRow(r.rows[0]);
	}

	const to = sandboxNext(row.state, "delete");
	const operationId = uuidv7();
	const superseded = await tx.client.query<{ id: string; kind: string }>(
		`UPDATE runtime.operations
		 SET state = 'superseded', superseded_by = $2, finished_at = now(), version = version + 1
		 WHERE sandbox_id = $1 AND state IN ('pending', 'running')
		 RETURNING id, kind`,
		[row.id, operationId],
	);
	await tx.client.query(
		`UPDATE runtime.sandboxes
		 SET state = $2, state_changed_at = now(), version = version + 1
		 WHERE id = $1`,
		[row.id, to],
	);
	await insertOperation(tx, {
		id: operationId,
		sandboxId: row.id,
		kind: "delete",
		request: reason === "delete" ? {} : { reason },
		principal,
		deadlineMs: null,
	});
	await tx.client.query(
		"DELETE FROM runtime.start_queue q USING runtime.operations o WHERE q.operation_id=o.id AND o.sandbox_id=$1",
		[row.id],
	);
	const prev = superseded.rows[0];
	await insertSandboxEvent(tx, {
		sandboxId: row.id,
		type: "state_changed",
		fromState: row.state,
		toState: to,
		reason,
		data: {
			operationId,
			supersededOperationId: prev?.id ?? null,
			supersededKind: prev?.kind ?? null,
		},
	});
	// A delete never dead-letters (S6 §15.1).
	await jobs.send(
		tx,
		"sandbox-op",
		{ operationId },
		{ singletonKey: row.id, retryLimit: DELETE_RETRY_LIMIT },
	);
	const op = await loadOperation(tx.client, operationId);
	if (op === null) throw notFound("operation");
	return op;
}

export async function deleteSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
): Promise<Operation> {
	return withTx(deps.pool, async (tx) => {
		const row = await findSandboxRow(tx.client, p, idOrSlug, { lock: true });
		return deleteLocked(tx, deps.jobs, row, p, "delete");
	});
}

/**
 * Delete without a principal inside the caller's transaction (cleanup
 * retention, S6 §15.4). Same path as the API delete: the active operation is
 * superseded and a `delete` operation with its job is inserted. `reason` is
 * the `state_changed` event reason and goes to `operations.request` (e.g.
 * `retention`). Locks the sandbox row: call it before any team/node advisory
 * lock or machine/operation row lock (lock order contract).
 */
export async function requestSystemDelete(
	tx: Tx,
	jobs: JobSender,
	sandboxId: string,
	reason = "delete",
): Promise<Operation> {
	const row = await lockSandboxById(tx, sandboxId);
	return deleteLocked(tx, jobs, row, null, reason);
}
