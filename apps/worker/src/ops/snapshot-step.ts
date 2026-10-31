import { DELETE_RETRY_LIMIT } from "@sbx/core";
import type { Tx } from "@sbx/db";
import { FreezeTimeoutError, type QuiesceHook } from "@sbx/pve";
import type pg from "pg";
import type { WorkerCtx } from "../context.ts";
import { insertDisks, loadSnapshot, snapshotRef } from "../db.ts";
import { errFields } from "../log.ts";
import { MachineGone } from "../machine-prep.ts";
import {
	AgentUnavailable,
	type InfraSnapshotRef,
	type NodeInfra,
} from "../ports.ts";
import { type Fenced, FencedOut } from "../steps.ts";
import { currentMachine, machineOs, vmidOf } from "./common.ts";

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
	constructor(message: string, opts?: { cause?: unknown }) {
		super(message, opts);
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

/**
 * Two hooks as one (Windows: the agent's quiesce, then QGA/VSS). Freeze runs
 * `outer` then `inner`; when `inner` fails, `outer` is thawed and the error
 * rethrown. Thaw runs `inner` then `outer`; both are attempted and the first
 * error is rethrown.
 */
export function composeHooks(
	outer: QuiesceHook,
	inner: QuiesceHook,
): QuiesceHook {
	return {
		freeze: async () => {
			await outer.freeze();
			try {
				await inner.freeze();
			} catch (e) {
				await outer.thaw().catch(() => {});
				throw e;
			}
		},
		thaw: async () => {
			let first: { error: unknown } | undefined;
			for (const h of [inner, outer]) {
				try {
					await h.thaw();
				} catch (error) {
					first ??= { error };
				}
			}
			if (first) throw first.error;
		},
	};
}

interface StepSnapshot {
	id: string;
	state: string;
	kind: string;
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
		`SELECT s.id, s.state, s.kind, s.lv_id, s.node_id, s.storage_id, s.consistency, s.quiesce_broken,
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
	const r = await ctx.pool.query<{
		state: string;
		capabilities: string[] | null;
	}>(
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
 * An executor's S1 snapshot finished, but it cannot record it (fenced out,
 * or the row left `creating`). All attempts share one `lv_id`, so the LVs are
 * deleted only when nobody else owns them:
 * - the row is `deleted`, `failed` or missing: its owner is done with it and
 *   nobody will look for these LVs again;
 * - the row is `creating` while the owning operation is `superseded` or
 *   `failed`: its delete or compensation may have run its S1 delete before
 *   these LVs appeared and only the row mark is left (S1 delete is
 *   idempotent, so deleting twice is fine).
 * Never for `ready`/`deleting` (another attempt finished; snapshot-op owns
 * it) or for `creating` under a live operation (its current attempt owns it).
 * The check runs after the S1 call returned, so LVs that land late are seen.
 * What is left for reconcile: an executor that dies between its S1 call and
 * this check.
 */
async function abandonSnapshot(
	ctx: WorkerCtx,
	fenced: Fenced,
	infra: NodeInfra,
	snapshotId: string,
	lvId: string,
	vmid: number,
): Promise<void> {
	try {
		const r = await ctx.pool.query<{ snap: string | null; op: string | null }>(
			`SELECT (SELECT state FROM runtime.snapshots WHERE id = $1) AS snap,
			        (SELECT state FROM runtime.operations WHERE id = $2) AS op`,
			[snapshotId, fenced.id],
		);
		const snap = r.rows[0]?.snap ?? "missing";
		const op = r.rows[0]?.op ?? "missing";
		const orphaned =
			snap === "deleted" ||
			snap === "failed" ||
			snap === "missing" ||
			(snap === "creating" && (op === "superseded" || op === "failed"));
		if (!orphaned) return;
		ctx.log.info(
			{ snapshotId, lvId, state: snap, operationState: op },
			"S1 snapshot nobody will record: deleting its LVs",
		);
		await infra.deleteSnapshot(bareRef(lvId, vmid));
	} catch (e) {
		ctx.log.warn(
			{ ...errFields(e), snapshotId, lvId },
			"could not delete abandoned snapshot LVs; reconcile will find them",
		);
	}
}

/** Merges `progress` into the operation under the fence (no step recorded). */
async function mergeProgress(
	fenced: Fenced,
	progress: Record<string, unknown>,
): Promise<void> {
	await fenced.tx(async (tx) => {
		await tx.client.query(
			`UPDATE runtime.operations SET progress = progress || $3::jsonb, version = version + 1
			 WHERE id = $1 AND attempt = $2 AND state = 'running'`,
			[fenced.id, fenced.attempt, JSON.stringify(progress)],
		);
	});
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
 *   answers → `QuiesceFailed`. An agent hook that failed `AgentUnavailable`
 *   records `progress.quiesceVia = "qga"`: the retry uses the QGA fallback;
 *   Windows (S9 §12.10): the hook is composite, the agent (`fs: false`, with
 *   `wipeSecretFiles` for a saved snapshot) then QGA/VSS; the fallback is QGA
 *   alone, except for a saved snapshot, which needs the agent
 *   (`AgentUnavailable`, the job is repeated);
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
		let agentUnavailable = false;
		let agentHook = false;
		// The agent's own freeze returned: a later freeze timeout is VSS's (Windows), not the agent's.
		let agentFrozen = false;
		// A saved snapshot of a Windows machine must not carry secret files: only the
		// agent can wipe them, so there is no QGA-only fallback (S9 §12.10).
		let needsAgent = false;
		if (status === "running") {
			const windows = (await machineOs(ctx.pool, m)) === "windows";
			const saved = s.kind === "saved";
			needsAgent = windows && saved;
			const viaQga = fenced.op.progress.quiesceVia === "qga" && !needsAgent;
			if (!viaQga && (await agentCanQuiesce(ctx, m.id))) {
				agentHook = true;
				const agent = ctx.agent.quiesceHook(
					m.id,
					QUIESCE_LEASE_MS,
					windows ? { fs: false, wipeSecretFiles: saved } : undefined,
				);
				const watch = (e: unknown): never => {
					if (e instanceof AgentUnavailable) agentUnavailable = true;
					throw e;
				};
				let thawing = false;
				const watched: QuiesceHook = {
					freeze: async () => {
						await agent.freeze().catch(watch);
						// A freeze that returns after S1 gave up and thawed still counts as late.
						if (!thawing) agentFrozen = true;
					},
					thaw: () => {
						thawing = true;
						return agent.thaw().catch(watch);
					},
				};
				// Windows: the agent prepares, VSS freezes the filesystem through QGA.
				hook = windows
					? composeHooks(watched, infra.qgaFreezeHook(vmid))
					: watched;
			} else if (needsAgent) {
				throw new AgentUnavailable(
					`machine ${m.id}: a saved snapshot of a Windows machine needs the agent to wipe secret files`,
				);
			} else if (!(await infra.qgaPing(vmid))) {
				throw new QuiesceFailed(
					`machine ${m.id}: neither the agent nor QGA can freeze the guest`,
				);
			} else if (windows) {
				hook = infra.qgaFreezeHook(vmid);
			}
		}
		await fenced.check();
		const lvId = s.lv_id;
		const storageId = s.storage_id;
		let res: Awaited<ReturnType<NodeInfra["snapshot"]>>;
		try {
			res = await infra.snapshot(vmid, hook ? { lvId, hook } : { lvId });
		} catch (e) {
			// S1 gave up waiting for the agent's freeze (the infra adapter reports it as
			// QuiesceFailed caused by FreezeTimeoutError): same fallback as an unanswered hook.
			const frozeTooLong =
				agentHook &&
				!agentFrozen &&
				(e instanceof FreezeTimeoutError ||
					(e instanceof QuiesceFailed &&
						e.cause instanceof FreezeTimeoutError));
			if (agentUnavailable || frozeTooLong) {
				// §7.7 fallback: the agent did not answer; the next attempt freezes
				// through QGA. The error stays transient (the job is repeated).
				ctx.log.info(
					{ operationId: fenced.id, machineId: m.id },
					"agent quiesce unavailable; the retry uses QGA",
				);
				if (!needsAgent) await mergeProgress(fenced, { quiesceVia: "qga" });
				// Transient, so the job is repeated through QGA.
				if (frozeTooLong)
					throw new AgentUnavailable(
						"agent quiesce did not finish in time; the retry uses QGA",
						{ cause: e },
					);
			}
			throw e;
		}
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
			if (e instanceof FencedOut || e instanceof SnapshotLost) {
				await abandonSnapshot(ctx, fenced, infra, snapshotId, lvId, vmid);
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
 * `cleanup_source` of a fork target (§7.7), inside its final transaction:
 * the fork_source snapshots it owns → `deleting` with a `snapshot-op delete`
 * job (as deleteSavedSnapshot). Lock order: the target's sandbox and
 * operation rows are held (Fenced.tx), then the snapshot rows.
 */
export async function retireForkSources(
	ctx: WorkerCtx,
	tx: Tx,
	sandboxId: string,
): Promise<string[]> {
	const r = await tx.client.query<{ id: string }>(
		`UPDATE runtime.snapshots SET state = 'deleting', version = version + 1
		 WHERE kind = 'fork_source' AND consumer_sandbox_id = $1 AND state IN ('ready', 'failed')
		 RETURNING id`,
		[sandboxId],
	);
	for (const { id } of r.rows) {
		await ctx.jobs.send(
			tx,
			"snapshot-op",
			{ snapshotId: id, action: "delete" },
			{ singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
		);
	}
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
