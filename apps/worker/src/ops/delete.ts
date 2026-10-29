import type { WorkerCtx } from "../context.ts";
import { loadSnapshot, snapshotRef } from "../db.ts";
import { handleMachineOp } from "../handlers/machine-op.ts";
import { type Fenced, FencedOut, MachineFence } from "../steps.ts";
import { runOp, transitionSandbox } from "./common.ts";
import type { SandboxOpHandler } from "./kind.ts";

// Delete (S6 §7.2): works by the actual state, not by the plan of the
// superseded operation. Every machine with this sandbox_id that is not
// `deleted` (including an `allocating` one whose superseded preparation got a
// lease), the snapshots the sandbox owns, its ports and secrets. Delete never
// fails: every error is retried (§15.1).

export const DELETE_STEPS = [
	"retire",
	"stop",
	"destroy",
	"snapshots",
	"ports",
	"secrets",
	"finish",
] as const;

/** Another machine-op delete took the machine's fence; this job is repeated. */
export class MachineBusy extends Error {
	readonly retryable = true;
	readonly code = "machine_busy";
	constructor(machineId: string) {
		super(`machine ${machineId}: another delete executor took over`);
		this.name = "MachineBusy";
	}
}

async function liveMachines(
	ctx: WorkerCtx,
	sandboxId: string,
): Promise<{ id: string; node_id: string }[]> {
	const r = await ctx.pool.query<{ id: string; node_id: string }>(
		`SELECT id, node_id FROM runtime.machines
		 WHERE sandbox_id = $1 AND state <> 'deleted' ORDER BY created_at, id`,
		[sandboxId],
	);
	return r.rows;
}

/**
 * A machine fence lost to another deleter: if our operation still holds its
 * own fence, the machine was taken by a machine-op job; repeat later.
 */
async function machineFenceLost(
	fenced: Fenced,
	machineId: string,
): Promise<never> {
	await fenced.check();
	throw new MachineBusy(machineId);
}

/** `stop`: S1 stop of every running VM of the machine, `power_observed = stopped` at once. */
async function stopMachine(
	ctx: WorkerCtx,
	fenced: Fenced,
	machineId: string,
	nodeId: string,
): Promise<void> {
	const fence = await MachineFence.begin(ctx, machineId, "delete");
	if (fence === null) return;
	const infra = await ctx.infra.forNode(nodeId);
	try {
		const lease = await infra.leaseOf(machineId);
		if (lease !== undefined) {
			await fence.check();
			await fenced.check();
			const status = await infra.status(lease.vmid);
			if (status === "running" || status === "paused") {
				await infra.stop(lease.vmid);
			}
		}
		await fence.tx(async (tx) => {
			await tx.client.query(
				`UPDATE runtime.machines SET power_observed = 'stopped', power_observed_at = now()
				 WHERE id = $1`,
				[machineId],
			);
		});
	} catch (e) {
		if (e instanceof FencedOut) {
			await machineFenceLost(fenced, machineId);
		}
		throw e;
	}
}

function deleteSteps(ctx: WorkerCtx, fenced: Fenced) {
	const sandboxId = fenced.sandboxId;
	return [
		{
			name: "retire",
			// retired_at first (§13.2): the gateway closes the tunnel. Machines
			// go to `deleting`, which fences out a preparation in flight.
			run: () =>
				fenced.tx(async (tx) => {
					await tx.client.query(
						`UPDATE tunnel.tunnel_credentials SET retired_at = COALESCE(retired_at, now())
						 WHERE machine_id IN (SELECT id FROM runtime.machines
						                      WHERE sandbox_id = $1 AND state <> 'deleted')`,
						[sandboxId],
					);
					await tx.client.query(
						`UPDATE runtime.machines
						 SET state = 'deleting', state_changed_at = now(), version = version + 1
						 WHERE sandbox_id = $1 AND state NOT IN ('deleting', 'deleted')`,
						[sandboxId],
					);
				}),
		},
		{
			name: "stop",
			run: async () => {
				for (const m of await liveMachines(ctx, sandboxId)) {
					await stopMachine(ctx, fenced, m.id, m.node_id);
				}
			},
		},
		{
			name: "destroy",
			// machine-op delete: S1 delete of every lease with verification,
			// then disks and the machine `deleted`.
			run: async () => {
				for (const m of await liveMachines(ctx, sandboxId)) {
					await fenced.check();
					const res = await handleMachineOp(ctx, {
						machineId: m.id,
						action: "delete",
					});
					if (res === "fenced_out") await machineFenceLost(fenced, m.id);
				}
			},
		},
		{
			name: "snapshots",
			run: () => deleteOwnedSnapshots(ctx, fenced),
		},
		{
			name: "ports",
			run: () =>
				fenced.tx(async (tx) => {
					await tx.client.query(
						`UPDATE runtime.hosted_ports
						 SET deleted_at = now(), auth_epoch = auth_epoch + 1
						 WHERE sandbox_id = $1 AND deleted_at IS NULL`,
						[sandboxId],
					);
				}),
		},
		{
			name: "secrets",
			// Crypto-erase of the sandbox (§13.1).
			run: () =>
				fenced.tx(async (tx) => {
					await tx.client.query(
						"DELETE FROM runtime.sandbox_secrets WHERE sandbox_id = $1",
						[sandboxId],
					);
				}),
		},
	];
}

/**
 * `snapshots`: the fork sources this sandbox consumes once their source fork
 * handed them over (not `creating`: while creating, the source's fork owns
 * them, §7.7), and every snapshot still `creating` from this sandbox (its own
 * fork or save was superseded). Saved snapshots that are ready survive.
 */
async function deleteOwnedSnapshots(
	ctx: WorkerCtx,
	fenced: Fenced,
): Promise<void> {
	const r = await ctx.pool.query<{ id: string }>(
		`SELECT id FROM runtime.snapshots
		 WHERE state <> 'deleted'
		   AND ((kind = 'fork_source' AND consumer_sandbox_id = $1 AND state <> 'creating')
		        OR (source_sandbox_id = $1 AND state = 'creating'))
		 ORDER BY created_at, id`,
		[fenced.sandboxId],
	);
	for (const { id } of r.rows) {
		const s = await loadSnapshot(ctx.pool, id);
		if (s === null) continue;
		await fenced.check();
		const infra = await ctx.infra.forNode(s.node_id);
		await infra.deleteSnapshot(await snapshotRef(ctx.pool, s));
		await fenced.tx(async (tx) => {
			await tx.client.query(
				`UPDATE runtime.disks SET state = 'deleted', deleted_at = now()
				 WHERE snapshot_id = $1 AND state <> 'deleted'`,
				[id],
			);
			await tx.client.query(
				`UPDATE runtime.snapshots
				 SET state = 'deleted', deleted_at = now(), version = version + 1
				 WHERE id = $1 AND state <> 'deleted'`,
				[id],
			);
		});
	}
}

export const DELETE_OP: SandboxOpHandler = {
	neverFails: true,
	run: (ctx, fenced) =>
		runOp(fenced, deleteSteps(ctx, fenced), async (tx) => {
			const ok = await transitionSandbox(
				tx,
				fenced.sandboxId,
				["deleting"],
				"deleted",
				{ reason: "delete_done", data: { operationId: fenced.id } },
				{ sql: "deleted_at = now()", params: [] },
			);
			if (!ok) {
				throw new Error(`sandbox ${fenced.sandboxId}: not deleting at finish`);
			}
		}),
	compensate: async () => {
		throw new Error("delete is never compensated");
	},
};
