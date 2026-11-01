import { withTx } from "@umiak/db";
import type pg from "pg";
import type { WorkerCtx } from "../context.ts";
import { loadSnapshot, snapshotRef } from "../db.ts";
import { CREATE_STEPS } from "../ops/create.ts";

// snapshot-op queue (S6 §7.8, §15.1): delete of a snapshot in `deleting`
// (or `failed`). Key snapshotId; unlimited retries.

export interface SnapshotOpData {
	snapshotId: string;
	action: "delete";
}

/**
 * A create from this snapshot has not passed its `provision` step yet; its
 * clone still needs the LVs. Retryable: the job wrapper repeats the job with
 * `startAfter = retryAfterSeconds`.
 */
export class SnapshotInUse extends Error {
	readonly retryable = true;
	readonly code = "snapshot_in_use";
	readonly retryAfterSeconds = 30;
	constructor(snapshotId: string) {
		super(`snapshot ${snapshotId} is still needed by a create`);
		this.name = "SnapshotInUse";
	}
}

export type SnapshotOpResult = "done" | "skipped";

export async function handleSnapshotOp(
	ctx: WorkerCtx,
	data: SnapshotOpData,
): Promise<SnapshotOpResult> {
	if (data.action !== "delete") {
		throw new Error(`snapshot-op: unknown action ${String(data.action)}`);
	}
	const { snapshotId } = data;
	const s = await loadSnapshot(ctx.pool, snapshotId);
	if (s === null || s.state === "deleted") return "skipped";
	if (s.state !== "deleting" && s.state !== "failed") {
		// Only snapshots someone already decided to delete; a live one stays.
		ctx.log.warn(
			{ snapshotId, state: s.state },
			"snapshot-op delete: snapshot is not deleting",
		);
		return "skipped";
	}
	if (await snapshotInUse(ctx.pool, snapshotId))
		throw new SnapshotInUse(snapshotId);

	const infra = await ctx.infra.forNode(s.node_id);
	await infra.deleteSnapshot(await snapshotRef(ctx.pool, s));
	await withTx(ctx.pool, async (tx) => {
		const r = await tx.client.query(
			`SELECT state FROM runtime.snapshots WHERE id = $1 FOR UPDATE`,
			[snapshotId],
		);
		if (r.rows[0]?.state === "deleted") return;
		await tx.client.query(
			`UPDATE runtime.disks SET state = 'deleted', deleted_at = now()
			 WHERE snapshot_id = $1 AND state <> 'deleted'`,
			[snapshotId],
		);
		await tx.client.query(
			`UPDATE runtime.snapshots
			 SET state = 'deleted', deleted_at = now(), version = version + 1
			 WHERE id = $1`,
			[snapshotId],
		);
	});
	return "done";
}

/**
 * §7.8: a sandbox in `creating` from this snapshot whose create has not
 * recorded `provision` yet, or any machine cloned from it that is still in
 * `allocating`/`provisioning` (the same condition seen from the machine;
 * it also covers fork targets).
 */
export async function snapshotInUse(
	q: Pick<pg.Pool, "query">,
	snapshotId: string,
): Promise<boolean> {
	const r = await q.query<{ busy: boolean }>(
		`SELECT EXISTS (
		   SELECT 1 FROM runtime.sandboxes s
		   JOIN runtime.operations o
		     ON o.sandbox_id = s.id AND o.kind = 'create' AND o.state IN ('pending', 'running')
		   WHERE s.state = 'creating' AND s.origin_snapshot_id = $1
		     AND (o.step IS NULL OR o.step <> ALL($2::text[]))
		 ) OR EXISTS (
		   SELECT 1 FROM runtime.machines m
		   WHERE m.origin_snapshot_id = $1 AND m.state IN ('allocating', 'provisioning')
		 ) AS busy`,
		// A create whose recorded step is one of its steps (provision or later)
		// has passed provision; none recorded yet means it has not.
		[snapshotId, CREATE_STEPS],
	);
	return r.rows[0]?.busy === true;
}
