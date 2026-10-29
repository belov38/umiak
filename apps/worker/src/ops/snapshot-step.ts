import type { Tx } from "@sbx/db";
import type { QuiesceHook } from "@sbx/pve";
import type pg from "pg";
import type { WorkerCtx } from "../context.ts";
import { insertDisks, loadSnapshot, snapshotRef } from "../db.ts";
import { MachineGone } from "../machine-prep.ts";
import type { InfraSnapshotRef, NodeInfra } from "../ports.ts";
import { type Fenced, FencedOut } from "../steps.ts";
import { currentMachine, vmidOf } from "./common.ts";

// The snapshot step of fork and save_snapshot (S6 §7.7 step 1, §7.8). The
// `snapshots` row exists in `creating` before S1 is called; its `lv_id` (the
// id without dashes, decision 2) names the LVs, so a repeat can find what an
// earlier attempt left. "Already done?" = the row has disk rows.

/** S3 §14.2: `System/Quiesce` lease. */
export const QUIESCE_LEASE_MS = 30_000;
/** S3 §13: the agent can quiesce (otherwise the S1 QGA fallback, S3 §14.1). */
export const QUIESCE_CAPABILITY = "system.quiesce.v1";

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

/**
 * A running source could not be quiesced: neither the agent nor QGA answers,
 * or the agent's watchdog thawed the guest before the snapshot was done
 * (`quiesce_broken`). Crash-consistent snapshots are not used (§7.7).
 */
export class QuiesceFailed extends Error {
	readonly retryable = false;
	readonly code = "quiesce_failed";
	constructor(message: string) {
		super(message);
		this.name = "QuiesceFailed";
	}
}

/** The snapshot row is no longer `creating` while this operation still holds its fence. */
export class SnapshotLost extends Error {
	readonly retryable = false;
	readonly code = "snapshot_lost";
	constructor(snapshotId: string, state: string) {
		super(`snapshot ${snapshotId} is ${state}`);
		this.name = "SnapshotLost";
	}
}

interface StepSnapshot {
	id: string;
	state: string;
	lv_id: string;
	node_id: string;
	storage_id: string;
	consistency: string | null;
	quiesce_broken: boolean;
	disks: number;
}

async function loadStepSnapshot(
	q: Queryable,
	snapshotId: string,
): Promise<StepSnapshot | null> {
	const r = await q.query<StepSnapshot>(
		`SELECT s.id, s.state, s.lv_id, s.node_id, s.storage_id, s.consistency, s.quiesce_broken,
		        (SELECT count(*)::int FROM runtime.disks d
		         WHERE d.snapshot_id = s.id AND d.state <> 'deleted') AS disks
		 FROM runtime.snapshots s WHERE s.id = $1`,
		[snapshotId],
	);
	return r.rows[0] ?? null;
}

/** An S1 reference by `lv_id` only: S1 deletes a snapshot by its LV tag. */
function bareRef(lvId: string, sourceVmid: number): InfraSnapshotRef {
	return { lvId, sourceVmid, disks: [], hw: {} };
}

/** A connected agent session that offers `system.quiesce.v1`. */
async function agentCanQuiesce(
	ctx: WorkerCtx,
	machineId: string,
): Promise<boolean> {
	const r = await ctx.pool.query<{ state: string; capabilities: string[] }>(
		"SELECT state, capabilities FROM tunnel.tunnel_sessions WHERE machine_id = $1",
		[machineId],
	);
	const s = r.rows[0];
	return (
		s?.state === "connected" &&
		(s.capabilities ?? []).includes(QUIESCE_CAPABILITY)
	);
}

/**
 * A previous attempt may have made LVs without recording them (a crash
 * between S1 snapshot and the disk rows): S1 delete by the `lv_id` tag, then
 * a fresh `quiesce_broken` for the new freeze.
 */
async function discardLeftovers(
	ctx: WorkerCtx,
	fenced: Fenced,
	infra: NodeInfra,
	s: StepSnapshot,
	vmid: number,
): Promise<void> {
	const tag = `sbx-snap-${s.lv_id}`;
	const lvs = await infra.listLvs();
	if (lvs.some((l) => l.tags.includes(tag))) {
		await fenced.check();
		ctx.log.info(
			{ snapshotId: s.id, lvId: s.lv_id },
			"removing the LVs of an unrecorded snapshot attempt",
		);
		await infra.deleteSnapshot(bareRef(s.lv_id, vmid));
	}
	if (s.quiesce_broken) {
		await fenced.tx(async (tx) => {
			await tx.client.query(
				`UPDATE runtime.snapshots SET quiesce_broken = false, version = version + 1
				 WHERE id = $1 AND state = 'creating'`,
				[s.id],
			);
		});
	}
}

/**
 * A stale executor's S1 snapshot finished after it lost its fence. If the
 * row is no longer `creating` (the source's delete removed it), nobody will
 * look for these LVs again: delete them here. If it is still `creating`,
 * the current executor (or the delete that superseded us) owns them.
 */
async function abandonSnapshot(
	ctx: WorkerCtx,
	infra: NodeInfra,
	snapshotId: string,
	lvId: string,
	vmid: number,
): Promise<void> {
	try {
		const cur = await loadSnapshot(ctx.pool, snapshotId);
		if (cur?.state === "creating") return;
		ctx.log.info(
			{ snapshotId, lvId, state: cur?.state ?? "missing" },
			"fenced out after S1 snapshot: deleting LVs nobody will use",
		);
		await infra.deleteSnapshot(bareRef(lvId, vmid));
	} catch (e) {
		ctx.log.warn(
			{ err: e, snapshotId, lvId },
			"could not delete abandoned snapshot LVs; reconcile will find them",
		);
	}
}

export interface SnapshotTaken {
	snapshotId: string;
	consistency: string | null;
}

/**
 * Takes the snapshot of the sandbox's current machine into the `creating`
 * row `snapshotId` (§7.7 step 1):
 * - VM running: the agent's `QuiesceHook` if it is connected with
 *   `system.quiesce.v1`, else no hook (S1 freezes through QGA); neither
 *   answers → `QuiesceFailed`;
 * - VM stopped: no freeze (`powered_off`);
 * - disks, `hw` and `consistency` recorded under the fence;
 * - after the thaw, `quiesce_broken` (set by the `quiesce.watchdog_thawed`
 *   event) → `QuiesceFailed`; the compensation removes the LVs.
 */
export async function takeSnapshot(
	ctx: WorkerCtx,
	fenced: Fenced,
	snapshotId: string,
): Promise<SnapshotTaken> {
	let s = await loadStepSnapshot(ctx.pool, snapshotId);
	if (s === null || s.state !== "creating") {
		await fenced.check();
		throw new SnapshotLost(snapshotId, s?.state ?? "missing");
	}
	if (s.disks === 0) {
		const m = await currentMachine(ctx, fenced.sandboxId);
		const vmid = vmidOf(m);
		const infra = await ctx.infra.forNode(m.node_id);
		await discardLeftovers(ctx, fenced, infra, s, vmid);

		const status = await infra.status(vmid);
		if (status === "missing") throw new MachineGone(m.id, `VM ${vmid} missing`);
		let hook: QuiesceHook | undefined;
		if (status === "running") {
			if (await agentCanQuiesce(ctx, m.id)) {
				hook = ctx.agent.quiesceHook(m.id, QUIESCE_LEASE_MS);
			} else if (!(await infra.qgaPing(vmid))) {
				throw new QuiesceFailed(
					`machine ${m.id}: neither the agent nor QGA can freeze the guest`,
				);
			}
		}
		await fenced.check();
		const lvId = s.lv_id;
		const storageId = s.storage_id;
		const res = await infra.snapshot(vmid, hook ? { lvId, hook } : { lvId });
		try {
			await fenced.tx(async (tx) => {
				const r = await tx.client.query<{ state: string }>(
					"SELECT state FROM runtime.snapshots WHERE id = $1 FOR UPDATE",
					[snapshotId],
				);
				const state = r.rows[0]?.state ?? "missing";
				if (state !== "creating") throw new SnapshotLost(snapshotId, state);
				await insertDisks(tx, { snapshotId }, storageId, res.disks);
				await tx.client.query(
					`UPDATE runtime.snapshots
					 SET hw = $2, consistency = $3, source_machine_id = COALESCE(source_machine_id, $4),
					     version = version + 1
					 WHERE id = $1`,
					[snapshotId, JSON.stringify(res.hw), res.consistency, m.id],
				);
			});
		} catch (e) {
			if (e instanceof FencedOut) {
				await abandonSnapshot(ctx, infra, snapshotId, lvId, vmid);
			}
			throw e;
		}
		s = await loadStepSnapshot(ctx.pool, snapshotId);
		if (s === null) throw new SnapshotLost(snapshotId, "missing");
	}
	if (s.consistency === "quiesced" && s.quiesce_broken) {
		throw new QuiesceFailed(
			`snapshot ${snapshotId}: the quiesce watchdog thawed the guest before the snapshot was done`,
		);
	}
	return { snapshotId, consistency: s.consistency };
}

/**
 * S1 delete of a snapshot's LVs (outside a transaction) while the row is in
 * one of `from`. The caller then marks the row with `markSnapshot` under its
 * fence. Returns false when the row was not in `from`.
 */
export async function deleteSnapshotLvs(
	ctx: WorkerCtx,
	fenced: Fenced,
	snapshotId: string,
	from: readonly string[],
): Promise<boolean> {
	const s = await loadSnapshot(ctx.pool, snapshotId);
	if (s === null || !from.includes(s.state)) return false;
	const infra = await ctx.infra.forNode(s.node_id);
	await fenced.check();
	await infra.deleteSnapshot(await snapshotRef(ctx.pool, s));
	return true;
}

/** Disk rows `deleted`, the snapshot `to` (from one of `from`). */
export async function markSnapshot(
	tx: Tx,
	snapshotId: string,
	to: "failed" | "deleted",
	from: readonly string[],
): Promise<void> {
	const r = await tx.client.query(
		`UPDATE runtime.snapshots
		 SET state = $2, deleted_at = CASE WHEN $2 = 'deleted' THEN now() ELSE deleted_at END,
		     version = version + 1
		 WHERE id = $1 AND state = ANY($3::text[])`,
		[snapshotId, to, from],
	);
	if (r.rowCount === 0) return;
	await tx.client.query(
		`UPDATE runtime.disks SET state = 'deleted', deleted_at = now()
		 WHERE snapshot_id = $1 AND state <> 'deleted'`,
		[snapshotId],
	);
}

/** States in which a fork target owns its fork_source (§7.7: from `ready` on). */
export const CONSUMED_SNAPSHOT_STATES = ["ready", "failed", "deleting"];

/** The fork_source snapshots a fork target owns (handed over, not deleted yet). */
export async function consumedForkSources(
	q: Queryable,
	sandboxId: string,
): Promise<string[]> {
	const r = await q.query<{ id: string }>(
		`SELECT id FROM runtime.snapshots
		 WHERE kind = 'fork_source' AND consumer_sandbox_id = $1 AND state = ANY($2::text[])
		 ORDER BY created_at, id`,
		[sandboxId, CONSUMED_SNAPSHOT_STATES],
	);
	return r.rows.map((x) => x.id);
}

/**
 * Pending children (fork targets' creates) of this sandbox's operations that
 * failed or were superseded get their `sandbox-op` job: nothing else would
 * schedule them, and their handler fails them `fork_failed` (§7.1, §7.7).
 */
export async function enqueueOrphanedChildren(
	ctx: WorkerCtx,
	tx: Tx,
	sandboxId: string,
): Promise<void> {
	const r = await tx.client.query<{ id: string; sandbox_id: string }>(
		`SELECT c.id, c.sandbox_id FROM runtime.operations c
		 JOIN runtime.operations p ON p.id = c.parent_operation_id
		 WHERE p.sandbox_id = $1 AND p.state IN ('failed', 'superseded') AND c.state = 'pending'`,
		[sandboxId],
	);
	for (const c of r.rows) {
		await ctx.jobs.send(
			tx,
			"sandbox-op",
			{ operationId: c.id },
			{ singletonKey: c.sandbox_id },
		);
	}
}
