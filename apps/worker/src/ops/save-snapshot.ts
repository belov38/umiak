import { DELETE_RETRY_LIMIT } from "@sbx/core";
import type { Tx } from "@sbx/db";
import type { WorkerCtx } from "../context.ts";
import type { Fenced, OperationError, Step } from "../steps.ts";
import { runOp } from "./common.ts";
import {
	extendDeadlineForRestart,
	forceStopSteps,
	isForced,
	restartForcedSource,
	restartSteps,
} from "./force-stop.ts";
import type { SandboxOpHandler } from "./kind.ts";
import {
	deleteSnapshotLvs,
	markSnapshot,
	takeSnapshot,
} from "./snapshot-step.ts";

// save_snapshot (S6 §7.8): the API inserted the `saved` row (`creating`,
// `pending_name`) and put its id in `request.snapshotId`. Steps: `snapshot`
// (as fork; forced Windows: stop before, restart after, force-stop.ts), then one fenced transaction: the team's `ready` snapshot of that
// name → `deleting` (+ snapshot-op delete), the new one `ready` with the
// name. On failure the name stays with the old snapshot. No secrets are in
// the snapshot: the agent keeps them in tmpfs only.
//
// Lock order of the finish: source sandbox row, operation row (Fenced.tx),
// then the new and the replaced snapshot rows FOR UPDATE; no team lock
// (lock-order.md).

export const SAVE_SNAPSHOT_STEPS = ["snapshot", "finish"] as const;

function snapshotIdOf(fenced: Fenced): string {
	const id = fenced.op.request.snapshotId;
	if (typeof id !== "string") {
		throw new Error(`save_snapshot ${fenced.id}: request has no snapshotId`);
	}
	return id;
}

async function finishSave(
	ctx: WorkerCtx,
	tx: Tx,
	snapshotId: string,
): Promise<void> {
	const r = await tx.client.query<{
		team_id: string;
		pending_name: string | null;
		state: string;
	}>(
		"SELECT team_id, pending_name, state FROM runtime.snapshots WHERE id = $1 FOR UPDATE",
		[snapshotId],
	);
	const s = r.rows[0];
	if (s?.state !== "creating" || s.pending_name === null) {
		throw new Error(
			`snapshot ${snapshotId}: not a creating saved snapshot at finish`,
		);
	}
	const old = await tx.client.query<{ id: string }>(
		`SELECT id FROM runtime.snapshots
		 WHERE team_id = $1 AND kind = 'saved' AND name = $2 AND state = 'ready' AND id <> $3
		 FOR UPDATE`,
		[s.team_id, s.pending_name, snapshotId],
	);
	for (const { id } of old.rows) {
		// §7.8: the name is taken off the replaced snapshot.
		await tx.client.query(
			`UPDATE runtime.snapshots SET state = 'deleting', name = NULL, version = version + 1
			 WHERE id = $1`,
			[id],
		);
		await ctx.jobs.send(
			tx,
			"snapshot-op",
			{ snapshotId: id, action: "delete" },
			{ singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
		);
	}
	await tx.client.query(
		`UPDATE runtime.snapshots
		 SET state = 'ready', name = pending_name, pending_name = NULL, ready_at = now(),
		     version = version + 1
		 WHERE id = $1`,
		[snapshotId],
	);
}

/** The new snapshot's LVs removed, the row `failed`; the old name is untouched. */
async function compensateSave(
	ctx: WorkerCtx,
	fenced: Fenced,
	error: OperationError,
): Promise<void> {
	const snapshotId = snapshotIdOf(fenced);
	await deleteSnapshotLvs(ctx, fenced, snapshotId, ["creating"]);
	await restartForcedSource(ctx, fenced);
	await fenced.finish("failed", error, (tx) =>
		markSnapshot(tx, snapshotId, "failed", ["creating"]),
	);
}

function saveSteps(ctx: WorkerCtx, fenced: Fenced): Step[] {
	const snapshotId = snapshotIdOf(fenced);
	const snapshot: Step = {
		name: "snapshot",
		run: async () => {
			const taken = await takeSnapshot(ctx, fenced, snapshotId);
			if (isForced(fenced)) await extendDeadlineForRestart(ctx, fenced);
			return taken;
		},
	};
	// S9 §24.8: a forced save stops the source, snapshots it and starts it again.
	if (!isForced(fenced)) return [snapshot];
	return [
		...forceStopSteps(ctx, fenced),
		snapshot,
		...restartSteps(ctx, fenced),
	];
}

export const SAVE_SNAPSHOT_OP: SandboxOpHandler = {
	run: (ctx, fenced) => {
		const snapshotId = snapshotIdOf(fenced);
		return runOp(fenced, saveSteps(ctx, fenced), (tx) =>
			finishSave(ctx, tx, snapshotId),
		);
	},
	compensate: compensateSave,
};
