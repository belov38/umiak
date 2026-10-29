import type { TemplateOs } from "@sbx/config";
import { operationDeadline, uuidv7 } from "@sbx/core";
import type { Tx } from "@sbx/db";
import type { WorkerCtx } from "../context.ts";
import {
	DeadlineExceeded,
	deadlinePassed,
	type Fenced,
	type OperationError,
	runSteps,
	type Step,
} from "../steps.ts";
import { currentMachine } from "./common.ts";
import type { SandboxOpHandler } from "./kind.ts";
import {
	deleteSnapshotLvs,
	enqueueOrphanedChildren,
	markSnapshot,
	takeSnapshot,
} from "./snapshot-step.ts";

// Fork, the operation on the source (S6 §7.7): `snapshot` (fork_source row,
// S1 snapshot with quiesce), then one fenced transaction: snapshot `ready`,
// fork `succeeded`, the target's create gets `deadline_at` and its job. From
// `ready` on the target owns the snapshot (cleanup_source, its compensation,
// its delete); while `creating` this operation (or the source's delete) does.
//
// Lock order of the hand-off: the source sandbox row and the fork's operation
// row (Fenced.tx), the snapshot row, then the target's create row by a
// conditional UPDATE. The target's sandbox row is not locked: no path that
// holds the target's create row waits for anything held here (the API delete
// of the target locks the target row, then its operations; the target's
// handler never touches the source), and the UPDATE itself is the check —
// 0 rows means the target's delete superseded it.

export const FORK_STEPS = ["snapshot", "finish"] as const;

/** The target's create is no longer pending (its delete superseded it). */
class TargetGone extends Error {
	constructor() {
		super("the fork target is gone");
		this.name = "TargetGone";
	}
}

function targetOf(fenced: Fenced): string {
	const id = fenced.op.request.targetSandboxId;
	if (typeof id !== "string") {
		throw new Error(`fork ${fenced.id}: request has no targetSandboxId`);
	}
	return id;
}

/**
 * The fork_source row (`creating`, consumer = target), inserted once: its id
 * is recorded in `progress.snapshotId` in the same transaction. The target's
 * machine gets `origin_snapshot_id` with it, so snapshot-op's in-use check
 * sees the clone that will need the LVs.
 */
async function ensureForkSource(
	ctx: WorkerCtx,
	fenced: Fenced,
): Promise<string> {
	const known = fenced.op.progress.snapshotId;
	if (typeof known === "string") return known;
	const targetId = targetOf(fenced);
	const m = await currentMachine(ctx, fenced.sandboxId);
	const id = uuidv7();
	await fenced.tx(async (tx) => {
		await tx.client.query(
			`INSERT INTO runtime.snapshots
			   (id, kind, team_id, source_sandbox_id, source_machine_id, consumer_sandbox_id,
			    provider_id, node_id, storage_id, template_build_id, lv_id, state)
			 SELECT $1, 'fork_source', s.team_id, s.id, $3, $4, $5, $6, $7, $8, $9, 'creating'
			 FROM runtime.sandboxes s WHERE s.id = $2`,
			[
				id,
				fenced.sandboxId,
				m.id,
				targetId,
				m.provider_id,
				m.node_id,
				m.storage_id,
				m.template_build_id,
				id.replaceAll("-", ""),
			],
		);
		await tx.client.query(
			`UPDATE runtime.machines SET origin_snapshot_id = $2, version = version + 1
			 WHERE sandbox_id = $1 AND origin = 'snapshot' AND origin_snapshot_id IS NULL`,
			[targetId, id],
		);
		await tx.client.query(
			`UPDATE runtime.operations
			 SET progress = progress || jsonb_build_object('snapshotId', $3::text), version = version + 1
			 WHERE id = $1 AND attempt = $2 AND state = 'running'`,
			[fenced.id, fenced.attempt, id],
		);
	});
	await fenced.check();
	return id;
}

function forkSteps(ctx: WorkerCtx, fenced: Fenced): Step[] {
	return [
		{
			name: "snapshot",
			run: async () =>
				takeSnapshot(ctx, fenced, await ensureForkSource(ctx, fenced)),
		},
	];
}

async function osOf(tx: Tx, snapshotId: string): Promise<TemplateOs> {
	const r = await tx.client.query<{ os: TemplateOs }>(
		`SELECT b.os FROM runtime.snapshots s
		 JOIN runtime.template_builds b ON b.id = s.template_build_id
		 WHERE s.id = $1`,
		[snapshotId],
	);
	return r.rows[0]?.os ?? "linux";
}

/**
 * §7.7 step 2, inside the fenced transaction that ends the fork: the
 * target's pending create gets `deadline_at = now + deadline` (cold create)
 * and its job; the snapshot becomes `ready`. `TargetGone` (rolls back) when
 * the target's create is no longer pending.
 */
async function handOff(
	ctx: WorkerCtx,
	tx: Tx,
	fenced: Fenced,
	snapshotId: string,
): Promise<void> {
	const deadlineMs = operationDeadline("create", await osOf(tx, snapshotId));
	const child = await tx.client.query<{ id: string; sandbox_id: string }>(
		`UPDATE runtime.operations
		 SET deadline_at = now() + make_interval(secs => $2::double precision / 1000),
		     version = version + 1
		 WHERE parent_operation_id = $1 AND kind = 'create' AND state = 'pending'
		 RETURNING id, sandbox_id`,
		[fenced.id, deadlineMs],
	);
	const c = child.rows[0];
	if (c === undefined) throw new TargetGone();
	const s = await tx.client.query(
		`UPDATE runtime.snapshots SET state = 'ready', ready_at = now(), version = version + 1
		 WHERE id = $1 AND state = 'creating'`,
		[snapshotId],
	);
	if (s.rowCount !== 1) {
		throw new Error(`snapshot ${snapshotId}: not creating at the hand-off`);
	}
	await ctx.jobs.send(
		tx,
		"sandbox-op",
		{ operationId: c.id },
		{ singletonKey: c.sandbox_id },
	);
}

function snapshotIdOf(fenced: Fenced): string {
	const id = fenced.op.progress.snapshotId;
	if (typeof id !== "string") {
		throw new Error(`fork ${fenced.id}: no snapshot recorded`);
	}
	return id;
}

async function runFork(ctx: WorkerCtx, fenced: Fenced): Promise<void> {
	await runSteps(fenced, forkSteps(ctx, fenced));
	const op = await fenced.check();
	if (deadlinePassed(op)) throw new DeadlineExceeded(op.id);
	const snapshotId = snapshotIdOf(fenced);
	try {
		await fenced.finish("succeeded", undefined, (tx) =>
			handOff(ctx, tx, fenced, snapshotId),
		);
		return;
	} catch (e) {
		if (!(e instanceof TargetGone)) throw e;
	}
	// The target is deleting or deleted: nobody will consume the snapshot,
	// and the target's delete leaves a `creating` one to us. Delete it here.
	ctx.log.info(
		{ operationId: fenced.id, snapshotId },
		"fork target gone before the hand-off; deleting the snapshot",
	);
	await deleteSnapshotLvs(ctx, fenced, snapshotId, ["creating"]);
	await fenced.finish("succeeded", undefined, async (tx) => {
		await markSnapshot(tx, snapshotId, "deleted", ["creating"]);
		await tx.client.query(
			`UPDATE runtime.operations SET progress = progress || '{"targetGone": true}'::jsonb
			 WHERE id = $1`,
			[fenced.id],
		);
	});
}

/**
 * Fork failed (or exhausted its retries): the partial snapshot's LVs are
 * removed and the row `deleted`; the fork `failed`; the target's pending
 * create gets its job so its handler fails it `fork_failed` (§7.7 errors:
 * every sandbox is changed only by its own operation).
 */
async function compensateFork(
	ctx: WorkerCtx,
	fenced: Fenced,
	error: OperationError,
): Promise<void> {
	const r = await ctx.pool.query<{ id: string }>(
		`SELECT id FROM runtime.snapshots
		 WHERE kind = 'fork_source' AND source_sandbox_id = $1 AND consumer_sandbox_id = $2
		   AND state = 'creating'`,
		[fenced.sandboxId, targetOf(fenced)],
	);
	const ids = r.rows.map((x) => x.id);
	for (const id of ids) await deleteSnapshotLvs(ctx, fenced, id, ["creating"]);
	await fenced.finish("failed", error, async (tx) => {
		for (const id of ids) await markSnapshot(tx, id, "deleted", ["creating"]);
		await enqueueOrphanedChildren(ctx, tx, fenced.sandboxId);
	});
}

export const FORK_OP: SandboxOpHandler = {
	run: runFork,
	compensate: compensateFork,
};
