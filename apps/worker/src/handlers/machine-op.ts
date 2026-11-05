import type { WorkerCtx } from "../context.ts";
import { ownedTeardown } from "../machine-prep.ts";
import type { NodeInfra } from "../ports.ts";
import { FencedOut, type MachineAction, MachineFence } from "../steps.ts";

// machine-op queue (S6 §9.3, §15.1): machine delete (legacy provision jobs are quarantined).
// Key machineId; fencing by machines.exec_attempt (MachineFence).

export interface MachineOpData {
	machineId: string;
	action: MachineAction;
}

/**
 * - `done`: the action completed;
 * - `skipped`: nothing to do (unknown machine, already prepared or deleted);
 * - `fenced_out`: another executor or a delete took over;
 * Delete errors are thrown for pg-boss to retry; legacy provision jobs skip.
 */
export type MachineOpResult = "done" | "skipped" | "fenced_out";

export async function handleMachineOp(
	ctx: WorkerCtx,
	data: MachineOpData,
): Promise<MachineOpResult> {
	if (data.action === "provision") {
		// Old queued pool jobs must never produce a VM or delete an allocated one.
		ctx.log.warn(
			{ machineId: data.machineId },
			"legacy pool provision quarantined; inspect node ram",
		);
		return "skipped";
	}
	if (data.action === "delete") {
		const legacy = await ctx.pool.query(
			`SELECT 1 FROM runtime.machines m
          WHERE m.id=$1 AND (m.pool_key IS NOT NULL OR m.state='warm')`,
			[data.machineId],
		);
		if (legacy.rowCount) {
			ctx.log.warn(
				{ machineId: data.machineId },
				"legacy pool delete quarantined; inspect node ram",
			);
			return "skipped";
		}
		return deleteMachine(ctx, data.machineId);
	}
	throw new Error(`machine-op: unknown action ${String(data.action)}`);
}

function fencedOut(
	ctx: WorkerCtx,
	e: FencedOut,
	action: MachineAction,
): MachineOpResult {
	ctx.log.info({ err: e.message, action }, "machine-op fenced out");
	ctx.metrics.inc("umiak_fenced_out_total", { queue: "machine-op", action });
	return "fenced_out";
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
		await destroyVms(ctx, fence, infra, machineId);
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

/**
 * Stops and deletes every VM leased to the machine. S1 checks under the
 * power lock that the VMID is still leased to this machine: a second deleter
 * whose lease read went stale (the first one freed the VMID and a new machine
 * may have it) gets an owner mismatch and treats the machine's VM as gone.
 */
export async function destroyVms(
	ctx: WorkerCtx,
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
		const vmid = lease.vmid;
		const status = await infra.status(vmid);
		if (status === "running" || status === "paused") {
			const own = await ownedTeardown(ctx, machineId, vmid, "stop", () =>
				infra.stop(vmid, {
					expectedOwner: machineId,
					beforeAct: () => fence.check(),
				}),
			);
			if (!own) continue;
		}
		await markStopped(fence, machineId);
		await ownedTeardown(ctx, machineId, vmid, "delete", () =>
			infra.delete(vmid, { expectedOwner: machineId }),
		);
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
