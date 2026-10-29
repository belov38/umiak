import { lockNode, type MachineState, uuidv7 } from "@sbx/core";
import { type Tx, withTx } from "@sbx/db";
import type { DiskSlot } from "@sbx/pve";
import type pg from "pg";
import type { InfraDisk, InfraSnapshotRef } from "./ports.ts";

// Row access shared by the handlers. Lock order (lock-order.md): sandbox row,
// then node advisory lock, then machine rows, then operation rows.

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export interface MachineRow {
	id: string;
	provider_id: string;
	node_id: string;
	storage_id: string;
	vmid: number | null;
	mac: string | null;
	template_build_id: string;
	origin: "template" | "snapshot";
	origin_snapshot_id: string | null;
	pool_key: string | null;
	size_slug: string;
	vcpu: number;
	memory_mb: number;
	sandbox_id: string | null;
	state: MachineState;
	power_observed: string;
	ready_boot_id: string | null;
	provisioned_boot_id: string | null;
	agent_phase: string | null;
	exec_attempt: number;
}

export async function loadMachine(
	q: Queryable,
	machineId: string,
	opts: { lock?: boolean } = {},
): Promise<MachineRow | null> {
	const r = await q.query<MachineRow>(
		`SELECT * FROM runtime.machines WHERE id = $1${opts.lock ? " FOR UPDATE" : ""}`,
		[machineId],
	);
	return r.rows[0] ?? null;
}

/** `SELECT … FOR UPDATE` of a sandbox row (lock-order step 1). */
export async function lockSandboxRow(
	tx: Tx,
	sandboxId: string,
): Promise<{ id: string; state: string } | null> {
	const r = await tx.client.query<{ id: string; state: string }>(
		"SELECT id, state FROM runtime.sandboxes WHERE id = $1 FOR UPDATE",
		[sandboxId],
	);
	return r.rows[0] ?? null;
}

const RETRY = Symbol("retry");

/**
 * Runs `fn` in a transaction holding the machine row lock, taken in lock
 * order: the machine's sandbox row first (if it has one), then the node lock
 * (if `nodeId` is given), then the machine row. `sandbox_id` changes at most
 * once (null -> id, a claim); if that happens between the unlocked read and
 * the row lock, the transaction is abandoned and taken again. `fn` gets null
 * for an unknown machine.
 */
export async function withMachineLocked<T>(
	pool: pg.Pool,
	machineId: string,
	fn: (tx: Tx, m: MachineRow | null) => Promise<T>,
	opts: { nodeId?: string } = {},
): Promise<T> {
	for (let i = 0; i < 3; i++) {
		const pre = await pool.query<{ sandbox_id: string | null }>(
			"SELECT sandbox_id FROM runtime.machines WHERE id = $1",
			[machineId],
		);
		const sandboxId = pre.rows[0]?.sandbox_id ?? null;
		const res = await withTx(pool, async (tx) => {
			if (sandboxId !== null) await lockSandboxRow(tx, sandboxId);
			if (opts.nodeId !== undefined) await lockNode(tx, opts.nodeId);
			const m = await loadMachine(tx.client, machineId, { lock: true });
			if (m !== null && m.sandbox_id !== sandboxId) return RETRY;
			return { value: await fn(tx, m) };
		});
		if (res !== RETRY) return res.value;
	}
	throw new Error(`machine ${machineId}: sandbox_id changed while locking`);
}

interface DiskRow {
	slot: DiskSlot;
	volume: string;
	size_bytes: string | number | null;
	options: Record<string, string> | null;
}

function diskFromRow(r: DiskRow): InfraDisk {
	const d: InfraDisk = {
		slot: r.slot,
		volume: r.volume,
		options: r.options ?? {},
	};
	if (r.size_bytes !== null) d.sizeBytes = Number(r.size_bytes);
	return d;
}

export interface SnapshotRow {
	id: string;
	kind: string;
	state: string;
	node_id: string;
	storage_id: string;
	lv_id: string;
	hw: Record<string, string> | null;
	source_machine_id: string | null;
	source_vmid: number | null;
}

export async function loadSnapshot(
	q: Queryable,
	snapshotId: string,
): Promise<SnapshotRow | null> {
	const r = await q.query<SnapshotRow>(
		`SELECT s.id, s.kind, s.state, s.node_id, s.storage_id, s.lv_id, s.hw, s.source_machine_id,
		        m.vmid AS source_vmid
		 FROM runtime.snapshots s
		 LEFT JOIN runtime.machines m ON m.id = s.source_machine_id
		 WHERE s.id = $1`,
		[snapshotId],
	);
	return r.rows[0] ?? null;
}

/** S1 view of a snapshot: its `lv_id`, live disks and hardware. */
export async function snapshotRef(
	q: Queryable,
	s: SnapshotRow,
): Promise<InfraSnapshotRef> {
	const d = await q.query<DiskRow>(
		`SELECT slot, volume, size_bytes, options FROM runtime.disks
		 WHERE snapshot_id = $1 AND state <> 'deleted' ORDER BY slot`,
		[s.id],
	);
	return {
		lvId: s.lv_id,
		sourceVmid: s.source_vmid ?? 0,
		disks: d.rows.map(diskFromRow),
		hw: s.hw ?? {},
	};
}

/** Inserts `disks` rows (state active) for a machine or a snapshot. */
export async function insertDisks(
	tx: Tx,
	owner: { machineId: string } | { snapshotId: string },
	storageId: string,
	disks: InfraDisk[],
): Promise<void> {
	for (const d of disks) {
		await tx.client.query(
			`INSERT INTO runtime.disks (id, machine_id, snapshot_id, storage_id, slot, volume, size_bytes, options)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[
				uuidv7(),
				"machineId" in owner ? owner.machineId : null,
				"snapshotId" in owner ? owner.snapshotId : null,
				storageId,
				d.slot,
				d.volume,
				d.sizeBytes ?? null,
				JSON.stringify(d.options),
			],
		);
	}
}
