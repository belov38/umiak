import { createHash, randomBytes } from "node:crypto";
import {
	acquireCloneSlot,
	type MachineState,
	releaseCloneSlot,
	tryPoweredStart,
} from "@sbx/core";
import { s2SerialPayload } from "@sbx/pve";
import type { WorkerCtx } from "./context.ts";
import {
	insertDisks,
	loadMachine,
	loadSnapshot,
	type MachineRow,
	snapshotRef,
} from "./db.ts";
import type { CreatedVm, InfraSnapshotRef, NodeInfra } from "./ports.ts";
import { FencedOut, type StepFence } from "./steps.ts";
import { waitUntil } from "./wait.ts";

// Machine preparation (S6 §7.4), shared by the pool (machine-op provision),
// cold create, create from snapshot and fork targets. The durable marker is
// the machine state: `allocating`/`provisioning` mean "not done", and the
// move to `booting` is committed before S1 start. Until then the VM has never
// run, so a retry throws the partial result away (S1 delete through the
// machine's lease) and starts over with a new bootstrap secret; after
// `booting` the secret never changes.

export type PrepSource =
	| { kind: "template" }
	| { kind: "snapshot"; snapshotId: string };

/** The machine is gone or broken (failed, deleting, deleted, VM missing). Permanent. */
export class MachineGone extends Error {
	readonly retryable = false;
	readonly code = "machine_lost";
	constructor(machineId: string, detail: string) {
		super(`machine ${machineId}: ${detail}`);
		this.name = "MachineGone";
	}
}

/** Waited too long for powered RAM or a clone slot. Retryable: the job runs again. */
export class CapacityWaitTimeout extends Error {
	readonly retryable = true;
	readonly code = "capacity_wait_timeout";
	constructor(what: string, timeoutMs: number) {
		super(`${what}: still waiting after ${timeoutMs} ms`);
		this.name = "CapacityWaitTimeout";
	}
}

/** The source of a preparation is unusable (snapshot missing or not ready). Permanent. */
export class PrepSourceUnavailable extends Error {
	readonly retryable = false;
	readonly code = "source_unavailable";
	constructor(detail: string) {
		super(detail);
		this.name = "PrepSourceUnavailable";
	}
}

/** States after a finished preparation: nothing to do. */
const PREPARED: readonly MachineState[] = [
	"warm",
	"claiming",
	"running",
	"stopping",
	"stopped",
	"starting",
];

export async function prepareMachine(
	ctx: WorkerCtx,
	fence: StepFence,
	machineId: string,
	source: PrepSource,
): Promise<void> {
	const m = await loadMachine(ctx.pool, machineId);
	if (m === null) throw new MachineGone(machineId, "not found");
	if (PREPARED.includes(m.state)) return;
	const infra = await ctx.infra.forNode(m.node_id);
	if (m.state === "booting") {
		await ensureStarted(ctx, fence, infra, m);
		return;
	}
	if (m.state !== "allocating" && m.state !== "provisioning") {
		throw new MachineGone(machineId, `state ${m.state}`);
	}

	// 1. allocating -> provisioning (a retry stays in provisioning).
	await fence.tx(async (tx) => {
		const r = await tx.client.query(
			`UPDATE runtime.machines
			 SET state = 'provisioning',
			     state_changed_at = CASE WHEN state <> 'provisioning' THEN now() ELSE state_changed_at END,
			     origin_snapshot_id = COALESCE(origin_snapshot_id, $2::uuid),
			     version = version + 1
			 WHERE id = $1 AND state IN ('allocating', 'provisioning')`,
			[machineId, source.kind === "snapshot" ? source.snapshotId : null],
		);
		if (r.rowCount !== 1)
			throw new FencedOut(`machine ${machineId}: left provisioning`);
	});

	// A previous attempt may have created a VM (or a part of it) without
	// recording it: throw it away through the machine's lease.
	await discardPartial(ctx, fence, infra, m);

	// 2. New bootstrap secret; the database keeps only its hash (S2 §5.2).
	const bs = randomBytes(32);
	const bsHash = createHash("sha256").update(bs).digest();
	await fence.tx(async (tx) => {
		await tx.client.query(
			`INSERT INTO tunnel.tunnel_credentials (machine_id, bs_hash)
			 VALUES ($1, $2)
			 ON CONFLICT (machine_id) DO UPDATE
			 SET bs_hash = EXCLUDED.bs_hash, retired_at = NULL,
			     mt_hash = NULL, mt_next_hash = NULL, mt_issued_at = NULL`,
			[machineId, bsHash],
		);
	});
	const smbios = { uuid: machineId, serial: s2SerialPayload(machineId, bs) };
	bs.fill(0);

	const size = { vcpu: m.vcpu, memoryMb: m.memory_mb };
	let snapshot: InfraSnapshotRef | undefined;
	let templateVmid = 0;
	if (source.kind === "snapshot") {
		const s = await loadSnapshot(ctx.pool, source.snapshotId);
		if (s === null || s.state === "deleted" || s.state === "failed") {
			throw new PrepSourceUnavailable(
				`snapshot ${source.snapshotId} is ${s?.state ?? "missing"}`,
			);
		}
		snapshot = await snapshotRef(ctx.pool, s);
	} else {
		templateVmid = await templateVmidOf(ctx, m);
	}

	// 3-5. S1 create/fork under a clone slot of the node.
	const created = await withCloneSlot(ctx, fence, m.node_id, async () => {
		await fence.check();
		const vm: CreatedVm = snapshot
			? await infra.fork({ machineId, snapshot, size, smbios })
			: await infra.create({ machineId, templateVmid, size, smbios });
		return vm;
	});

	// 4. Record VMID, MAC and disks. A stale executor stops here.
	await fence.tx(async (tx) => {
		const r = await tx.client.query(
			`UPDATE runtime.machines SET vmid = $2, mac = $3, version = version + 1
			 WHERE id = $1 AND state = 'provisioning'`,
			[machineId, created.vmid, created.mac],
		);
		if (r.rowCount !== 1)
			throw new FencedOut(`machine ${machineId}: left provisioning`);
		await insertDisks(tx, { machineId }, m.storage_id, created.disks);
	});

	// 6. Start gate: powered RAM check and -> booting in one transaction, then S1 start.
	await waitUntil(
		ctx,
		fence,
		async () =>
			(await fence.tx(
				(tx) => tryPoweredStart(tx, { machineId, toState: "booting" }),
				{ nodeId: m.node_id },
			))
				? true
				: undefined,
		{
			timeoutMs: ctx.timing.ramWaitTimeoutMs,
			pollMs: ctx.timing.ramWaitPollMs,
			timeoutError: () =>
				new CapacityWaitTimeout(
					`machine ${machineId} start gate`,
					ctx.timing.ramWaitTimeoutMs,
				),
		},
	);
	await infra.start(created.vmid);
	await markPowered(fence, machineId);
}

/**
 * Deletes every VM of the machine's leases (S1 delete verifies and frees the
 * lease; a missing VM is fine), then forgets the old VMID and disks.
 */
async function discardPartial(
	ctx: WorkerCtx,
	fence: StepFence,
	infra: NodeInfra,
	m: MachineRow,
): Promise<void> {
	let last: number | undefined;
	for (;;) {
		const lease = await infra.leaseOf(m.id);
		if (lease === undefined) break;
		if (lease.vmid === last) {
			throw new Error(
				`machine ${m.id}: lease of VM ${lease.vmid} survived delete`,
			);
		}
		last = lease.vmid;
		await fence.check();
		ctx.log.info(
			{ machineId: m.id, vmid: lease.vmid },
			"discarding a partial preparation",
		);
		await infra.delete(lease.vmid);
	}
	await fence.tx(async (tx) => {
		await tx.client.query(
			`UPDATE runtime.machines SET vmid = NULL, mac = NULL, version = version + 1
			 WHERE id = $1 AND (vmid IS NOT NULL OR mac IS NOT NULL)`,
			[m.id],
		);
		await tx.client.query(
			`UPDATE runtime.disks SET state = 'deleted', deleted_at = now()
			 WHERE machine_id = $1 AND state <> 'deleted'`,
			[m.id],
		);
	});
}

async function templateVmidOf(ctx: WorkerCtx, m: MachineRow): Promise<number> {
	const r = await ctx.pool.query<{ pve_vmid: number }>(
		"SELECT pve_vmid FROM runtime.template_builds WHERE id = $1",
		[m.template_build_id],
	);
	const vmid = r.rows[0]?.pve_vmid;
	if (vmid === undefined) {
		throw new PrepSourceUnavailable(
			`template build ${m.template_build_id} not found`,
		);
	}
	return vmid;
}

async function withCloneSlot<T>(
	ctx: WorkerCtx,
	fence: StepFence,
	nodeId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const slot = await waitUntil(
		ctx,
		fence,
		async () =>
			(await acquireCloneSlot(ctx.pool, nodeId, fence.holder)) ?? undefined,
		{
			timeoutMs: ctx.timing.cloneSlotTimeoutMs,
			pollMs: ctx.timing.cloneSlotPollMs,
			timeoutError: () =>
				new CapacityWaitTimeout(
					`node ${nodeId} clone slot`,
					ctx.timing.cloneSlotTimeoutMs,
				),
		},
	);
	try {
		return await fn();
	} finally {
		await releaseCloneSlot(ctx.pool, nodeId, slot, fence.holder).catch(
			(e: unknown) => {
				ctx.log.warn(
					{ err: e, nodeId, slot },
					"clone slot release failed; it expires by itself",
				);
			},
		);
	}
}

/** Machine already `booting` (a retry after the start gate): make sure the VM runs. */
async function ensureStarted(
	ctx: WorkerCtx,
	fence: StepFence,
	infra: NodeInfra,
	m: MachineRow,
): Promise<void> {
	if (m.vmid === null) throw new MachineGone(m.id, "booting without a VMID");
	const status = await infra.status(m.vmid);
	if (status === "missing")
		throw new MachineGone(m.id, `VM ${m.vmid} is missing`);
	if (status === "stopped") {
		await fence.check();
		ctx.log.info(
			{ machineId: m.id, vmid: m.vmid },
			"starting a booting machine again",
		);
		await infra.start(m.vmid);
	}
	await markPowered(fence, m.id);
}

async function markPowered(fence: StepFence, machineId: string): Promise<void> {
	await fence.tx(async (tx) => {
		await tx.client.query(
			`UPDATE runtime.machines SET power_observed = 'running', power_observed_at = now()
			 WHERE id = $1`,
			[machineId],
		);
	});
}

/** Agent connected on its current boot and reported `pool_ready` on it (decision 4). */
export class BootTimeout extends Error {
	readonly retryable = false;
	readonly code = "boot_timeout";
	constructor(machineId: string, timeoutMs: number) {
		super(`machine ${machineId}: agent not ready within ${timeoutMs} ms`);
		this.name = "BootTimeout";
	}
}

/**
 * Waits until `machines.ready_boot_id` equals the current
 * `tunnel.tunnel_sessions.boot_id` of the machine and the session is
 * `connected`. Returns that boot id. `notBootId` skips a boot that was ready
 * before (resume, recover: the previous boot's values may still be there).
 */
export async function waitBooted(
	ctx: WorkerCtx,
	fence: StepFence,
	machineId: string,
	timeoutMs: number,
	opts: { notBootId?: string | null } = {},
): Promise<string> {
	return waitUntil(
		ctx,
		fence,
		async () => {
			const r = await ctx.pool.query<{
				ready_boot_id: string | null;
				boot_id: string | null;
				state: string | null;
			}>(
				`SELECT m.ready_boot_id, s.boot_id, s.state
				 FROM runtime.machines m
				 LEFT JOIN tunnel.tunnel_sessions s ON s.machine_id = m.id
				 WHERE m.id = $1`,
				[machineId],
			);
			const row = r.rows[0];
			if (
				row?.ready_boot_id == null ||
				row.ready_boot_id !== row.boot_id ||
				row.state !== "connected" ||
				(opts.notBootId != null && row.boot_id === opts.notBootId)
			) {
				return undefined;
			}
			return row.ready_boot_id;
		},
		{
			timeoutMs,
			pollMs: ctx.timing.pollMs,
			timeoutError: () => new BootTimeout(machineId, timeoutMs),
		},
	);
}
