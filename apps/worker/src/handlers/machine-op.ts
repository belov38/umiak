import { DELETE_RETRY_LIMIT } from "@sbx/core";
import type { WorkerCtx } from "../context.ts";
import {
	type PrepSource,
	prepareMachine,
	waitBooted,
} from "../machine-prep.ts";
import { isPermanent, type NodeInfra } from "../ports.ts";
import { FencedOut, type MachineAction, MachineFence } from "../steps.ts";

// machine-op queue (S6 §9.3, §15.1): pool provisioning and machine delete.
// Key machineId; fencing by machines.exec_attempt (MachineFence).

export interface MachineOpData {
	machineId: string;
	action: MachineAction;
}

/**
 * - `done`: the action completed;
 * - `skipped`: nothing to do (unknown machine, already prepared or deleted);
 * - `fenced_out`: another executor or a delete took over;
 * - `failed`: provision failed, the machine is `deleting` with a delete job.
 * As in sandbox-op, errors are transient by default and thrown (pg-boss
 * repeats the job); only `retryable === false` fails the provision.
 */
export type MachineOpResult = "done" | "skipped" | "fenced_out" | "failed";

export async function handleMachineOp(
	ctx: WorkerCtx,
	data: MachineOpData,
): Promise<MachineOpResult> {
	if (data.action === "provision") return provision(ctx, data.machineId);
	if (data.action === "delete") return deleteMachine(ctx, data.machineId);
	throw new Error(`machine-op: unknown action ${String(data.action)}`);
}

function fencedOut(
	ctx: WorkerCtx,
	e: FencedOut,
	action: MachineAction,
): MachineOpResult {
	ctx.log.info({ err: e.message, action }, "machine-op fenced out");
	ctx.metrics.inc("sbx_fenced_out_total", { queue: "machine-op", action });
	return "fenced_out";
}

async function provision(
	ctx: WorkerCtx,
	machineId: string,
): Promise<MachineOpResult> {
	const fence = await MachineFence.begin(ctx, machineId, "provision");
	if (fence === null) return "skipped";
	const m = fence.machine;
	try {
		const source: PrepSource =
			m.origin === "snapshot" && m.origin_snapshot_id !== null
				? { kind: "snapshot", snapshotId: m.origin_snapshot_id }
				: { kind: "template" };
		await prepareMachine(ctx, fence, machineId, source);
		const bootTimeoutS = await bootTimeoutOf(ctx, m.template_build_id);
		await waitBooted(ctx, fence, machineId, bootTimeoutS * 1000);
		// The events handler usually got here first (phase pool_ready).
		await fence.tx(async (tx) => {
			await tx.client.query(
				`UPDATE runtime.machines
				 SET state = 'warm', warm_at = COALESCE(warm_at, now()), state_changed_at = now(),
				     version = version + 1
				 WHERE id = $1 AND state = 'booting' AND pool_key IS NOT NULL AND sandbox_id IS NULL`,
				[machineId],
			);
		});
		return "done";
	} catch (e) {
		if (e instanceof FencedOut) return fencedOut(ctx, e, "provision");
		if (!isPermanent(e)) return rethrowUnlessFenced(ctx, fence, e);
		return failProvision(ctx, fence, e);
	}
}

/**
 * A transient provision error is thrown for a redelivery, unless this
 * executor was fenced out meanwhile: then the error is a side effect of the
 * takeover and a redelivery has nothing to do.
 */
async function rethrowUnlessFenced(
	ctx: WorkerCtx,
	fence: MachineFence,
	err: unknown,
): Promise<MachineOpResult> {
	try {
		await fence.check();
	} catch (e) {
		if (e instanceof FencedOut) return fencedOut(ctx, e, "provision");
		throw e;
	}
	throw err;
}

async function bootTimeoutOf(ctx: WorkerCtx, buildId: string): Promise<number> {
	const r = await ctx.pool.query<{ boot_timeout_s: number }>(
		"SELECT boot_timeout_s FROM runtime.template_builds WHERE id = $1",
		[buildId],
	);
	return r.rows[0]?.boot_timeout_s ?? 300;
}

/** §9.3: `failed -> deleting` and a delete job, in one fenced transaction. */
async function failProvision(
	ctx: WorkerCtx,
	fence: MachineFence,
	err: unknown,
): Promise<MachineOpResult> {
	const machineId = fence.machineId;
	const code =
		typeof (err as { code?: unknown })?.code === "string"
			? (err as { code: string }).code
			: "provision_failed";
	const detail = err instanceof Error ? err.message : String(err);
	try {
		await fence.tx(async (tx) => {
			await tx.client.query(
				`UPDATE runtime.machines
				 SET state = 'failed', error_code = $2, error_detail = $3,
				     state_changed_at = now(), version = version + 1
				 WHERE id = $1`,
				[machineId, code, detail],
			);
			await tx.client.query(
				`UPDATE runtime.machines
				 SET state = 'deleting', state_changed_at = now(), version = version + 1
				 WHERE id = $1 AND state = 'failed'`,
				[machineId],
			);
			await ctx.jobs.send(
				tx,
				"machine-op",
				{ machineId, action: "delete" },
				{ singletonKey: machineId, retryLimit: DELETE_RETRY_LIMIT },
			);
		});
	} catch (e) {
		// Another executor or a delete took over; this error was a side effect of that.
		if (e instanceof FencedOut) return fencedOut(ctx, e, "provision");
		throw e;
	}
	ctx.log.warn({ machineId, code, err: detail }, "pool provision failed");
	ctx.metrics.inc("sbx_machine_provision_failed_total", { code });
	return "failed";
}

/**
 * Machine delete (§6.2, §13.2): `retired_at` first (the gateway closes the
 * tunnel), then S1 stop and at once `power_observed = stopped` (frees powered
 * RAM for waiting starts), S1 delete with verification (frees the lease),
 * disks and the machine `deleted`. A missing VM or lease is fine. Every error
 * is thrown: a delete never gives up (§15.1).
 */
async function deleteMachine(
	ctx: WorkerCtx,
	machineId: string,
): Promise<MachineOpResult> {
	const fence = await MachineFence.begin(ctx, machineId, "delete");
	if (fence === null) return "skipped";
	try {
		await fence.tx(async (tx) => {
			await tx.client.query(
				`UPDATE tunnel.tunnel_credentials SET retired_at = COALESCE(retired_at, now())
				 WHERE machine_id = $1`,
				[machineId],
			);
		});
		const infra = await ctx.infra.forNode(fence.machine.node_id);
		await destroyVms(fence, infra, machineId);
		await fence.tx(async (tx) => {
			await tx.client.query(
				`UPDATE runtime.disks SET state = 'deleted', deleted_at = now()
				 WHERE machine_id = $1 AND state <> 'deleted'`,
				[machineId],
			);
			await tx.client.query(
				`UPDATE runtime.machines
				 SET state = 'deleted', deleted_at = now(), power_observed = 'stopped',
				     power_observed_at = now(), state_changed_at = now(), version = version + 1
				 WHERE id = $1`,
				[machineId],
			);
		});
		return "done";
	} catch (e) {
		if (e instanceof FencedOut) return fencedOut(ctx, e, "delete");
		throw e;
	}
}

/** Stops and deletes every VM leased to the machine. */
export async function destroyVms(
	fence: MachineFence,
	infra: NodeInfra,
	machineId: string,
): Promise<void> {
	let last: number | undefined;
	for (;;) {
		const lease = await infra.leaseOf(machineId);
		if (lease === undefined) break;
		if (lease.vmid === last) {
			throw new Error(
				`machine ${machineId}: lease of VM ${lease.vmid} survived delete`,
			);
		}
		last = lease.vmid;
		await fence.check();
		const status = await infra.status(lease.vmid);
		if (status === "running" || status === "paused")
			await infra.stop(lease.vmid);
		await markStopped(fence, machineId);
		await infra.delete(lease.vmid);
	}
	await markStopped(fence, machineId);
}

async function markStopped(
	fence: MachineFence,
	machineId: string,
): Promise<void> {
	await fence.tx(async (tx) => {
		await tx.client.query(
			`UPDATE runtime.machines SET power_observed = 'stopped', power_observed_at = now()
			 WHERE id = $1`,
			[machineId],
		);
	});
}
