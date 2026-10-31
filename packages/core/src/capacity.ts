import type { Quota } from "@sbx/config";
import type { Tx } from "@sbx/db";
import { invalidState, notFound, quotaExceeded } from "./errors.ts";
import type { JobSender } from "./jobs.ts";
import { lockNode, lockTeam } from "./locks.ts";
import { DELETE_RETRY_LIMIT } from "./queues.ts";
import {
	type MachineState,
	POWERED_MACHINE_STATES,
	RESERVED_MACHINE_STATES,
	type SandboxState,
} from "./states.ts";

// RAM accounting, admission, the start gate and quotas (S6 §8.1, §8.2, §8.5).
// Every function runs inside the caller's transaction.

const sqlList = (xs: readonly string[]): string =>
	xs.map((x) => `'${x}'`).join(", ");

/**
 * S6 §8.1 `reserved`: RAM promised on the node. Machines in a reserved state,
 * plus a `stopped` machine that is its sandbox's current machine while the
 * sandbox has a pending/running resume or recover (its start was admitted),
 * or a fork/save_snapshot with `forceStop` (it starts the source again).
 * `failed`/`deleting` machines gave their place back. Alias `m` = machines.
 */
export const RESERVED_SQL = `(m.state IN (${sqlList(RESERVED_MACHINE_STATES)})
  OR (m.state = 'stopped' AND EXISTS (
    SELECT 1 FROM runtime.sandboxes s
    JOIN runtime.operations o ON o.sandbox_id = s.id
    WHERE s.machine_id = m.id
      AND (o.kind IN ('resume', 'recover')
        OR (o.kind IN ('fork', 'save_snapshot') AND o.request->>'forceStop' = 'true'))
      AND o.state IN ('pending', 'running'))))`;

/**
 * S6 §8.1 `powered`: RAM of VMs that may be running right now. Machines in a
 * powered state, plus `failed`/`deleting`/`stopped` ones whose observed power
 * is not `stopped` (`unknown` counts as running). Alias `m` = machines.
 */
export const POWERED_SQL = `(m.state IN (${sqlList(POWERED_MACHINE_STATES)})
  OR (m.state IN ('failed', 'deleting', 'stopped') AND m.power_observed <> 'stopped'))`;

export interface NodeRam {
	capMb: number;
	reservedMb: number;
	poweredMb: number;
}

async function ramOf(
	tx: Tx,
	nodeId: string,
	excludeMachineId: string | null,
): Promise<NodeRam> {
	const r = await tx.client.query<{
		cap_mb: number;
		reserved_mb: number;
		powered_mb: number;
	}>(
		`SELECT n.ram_cap_mb AS cap_mb,
		   COALESCE(SUM(m.memory_mb) FILTER (WHERE ${RESERVED_SQL}), 0)::int AS reserved_mb,
		   COALESCE(SUM(m.memory_mb) FILTER (WHERE ${POWERED_SQL}), 0)::int AS powered_mb
		 FROM runtime.nodes n
		 LEFT JOIN runtime.machines m
		   ON m.node_id = n.id AND m.state <> 'deleted' AND m.id IS DISTINCT FROM $2::uuid
		 WHERE n.id = $1
		 GROUP BY n.ram_cap_mb`,
		[nodeId, excludeMachineId],
	);
	const row = r.rows[0];
	if (!row) throw notFound("node");
	return {
		capMb: row.cap_mb,
		reservedMb: row.reserved_mb,
		poweredMb: row.powered_mb,
	};
}

/**
 * Cap, reserved and powered RAM of a node (S6 §8.1). Consistent with other
 * writers only under `lockNode`.
 */
export function nodeRam(tx: Tx, nodeId: string): Promise<NodeRam> {
	return ramOf(tx, nodeId, null);
}

export interface AdmitInput {
	nodeId: string;
	needMb: number;
	/** `<template_slug>/<size_slug>` of the request; its warm machines are never evicted. */
	pairKey: string | null;
	/** Evict warm machines of other pairs when free RAM is short (not for pool refill). */
	evict: boolean;
	jobs: JobSender;
}

export type AdmitResult = { ok: true; evicted: string[] } | { ok: false };

const ADMIT_SAVEPOINT = "sbx_admit";

/**
 * Admission (S6 §8.2). Takes the node lock (the caller takes the team lock
 * first, if any). On `ok` the caller must record the reservation in the same
 * transaction: a machine row in `allocating` or a resume/recover operation.
 *
 * A refused admission gives its node lock back (it is taken in a savepoint
 * that is rolled back; nothing was written). So a caller that tries several
 * candidates (admitCold) holds at most one node lock at a time and two such
 * callers can never wait on each other's refused nodes (lock order contract:
 * never two node locks out of order). A lock the transaction already held
 * before the call stays held.
 *
 * 1. `reserved + need <= cap` -> admitted.
 * 2. With `evict`: warm machines of other pairs on the node, oldest `warm_at`
 *    first, until the RAM fits. They go to `deleting` and get a `machine-op
 *    delete` job in this transaction (unlimited retries, S6 §15.1). If all
 *    of them are not enough, nothing changes.
 * 3. Otherwise refused; the caller maps it to `out_of_capacity`.
 */
export async function admit(tx: Tx, input: AdmitInput): Promise<AdmitResult> {
	await tx.client.query(`SAVEPOINT ${ADMIT_SAVEPOINT}`);
	const res = await admitLocked(tx, input);
	await tx.client.query(
		res.ok
			? `RELEASE SAVEPOINT ${ADMIT_SAVEPOINT}`
			: `ROLLBACK TO SAVEPOINT ${ADMIT_SAVEPOINT}; RELEASE SAVEPOINT ${ADMIT_SAVEPOINT}`,
	);
	return res;
}

async function admitLocked(tx: Tx, input: AdmitInput): Promise<AdmitResult> {
	const { nodeId, needMb, pairKey, evict, jobs } = input;
	await lockNode(tx, nodeId);
	const ram = await nodeRam(tx, nodeId);
	const deficit = ram.reservedMb + needMb - ram.capMb;
	if (deficit <= 0) return { ok: true, evicted: [] };
	if (!evict) return { ok: false };

	// Row locks keep a concurrent claim (FOR UPDATE SKIP LOCKED, §9.5) off the
	// chosen machines; machines it already holds are skipped here.
	const warm = await tx.client.query<{ id: string; memory_mb: number }>(
		`SELECT id, memory_mb FROM runtime.machines
		 WHERE node_id = $1 AND state = 'warm' AND pool_key IS DISTINCT FROM $2
		 ORDER BY warm_at ASC NULLS FIRST, id
		 FOR UPDATE SKIP LOCKED`,
		[nodeId, pairKey],
	);
	const chosen: string[] = [];
	let freed = 0;
	for (const m of warm.rows) {
		if (freed >= deficit) break;
		chosen.push(m.id);
		freed += m.memory_mb;
	}
	if (freed < deficit) return { ok: false };

	const upd = await tx.client.query<{ id: string }>(
		`UPDATE runtime.machines
		 SET state = 'deleting', state_changed_at = now(), version = version + 1
		 WHERE id = ANY($1::uuid[]) AND state = 'warm'
		 RETURNING id`,
		[chosen],
	);
	// The rows are locked by this transaction, so all of them were updated.
	if (upd.rowCount !== chosen.length) {
		throw new Error("admit: evicted machines changed under a row lock");
	}
	for (const machineId of chosen) {
		await jobs.send(
			tx,
			"machine-op",
			{ machineId, action: "delete" },
			{ singletonKey: machineId, retryLimit: DELETE_RETRY_LIMIT },
		);
	}
	return { ok: true, evicted: chosen };
}

export type PoweredStartState = "booting" | "starting";

const START_FROM: Record<PoweredStartState, readonly MachineState[]> = {
	booting: ["provisioning"],
	starting: ["stopped"],
};

/**
 * Start gate (S6 §8.2): under the node lock, moves the machine to `booting`
 * (from `provisioning`) or `starting` (from `stopped`) if the node's powered
 * RAM stays within the cap; the caller then calls S1 `start`.
 *
 * The check is `powered of all other machines + own memory_mb <= cap`, which is
 * exactly `powered after the transition <= cap`:
 * - a `provisioning` machine is never in powered (not a powered state, and the
 *   power_observed rule covers only failed/deleting/stopped);
 * - a `stopped` machine is already in powered when `power_observed` is not
 *   `stopped` (reconcile has not confirmed the stop yet). Excluding the machine
 *   itself avoids counting it twice.
 *
 * Returns true when the machine is already in `toState` (a repeated step after
 * a crash: it is counted in powered and the gate was passed before). Throws
 * `invalid_state` for any other state and `not_found` for an unknown machine.
 * Returns false when RAM is short: the caller polls (S6 §8.2).
 */
export async function tryPoweredStart(
	tx: Tx,
	input: { machineId: string; toState: PoweredStartState },
): Promise<boolean> {
	const { machineId, toState } = input;
	const from = START_FROM[toState];
	const node = await tx.client.query<{ node_id: string }>(
		"SELECT node_id FROM runtime.machines WHERE id = $1",
		[machineId],
	);
	const nodeId = node.rows[0]?.node_id;
	if (nodeId === undefined) throw notFound("machine");
	await lockNode(tx, nodeId);

	const cur = await tx.client.query<{ state: MachineState; memory_mb: number }>(
		"SELECT state, memory_mb FROM runtime.machines WHERE id = $1",
		[machineId],
	);
	const m = cur.rows[0];
	if (!m) throw notFound("machine");
	if (m.state === toState) return true;
	if (!from.includes(m.state)) {
		throw invalidState(m.state, { machineId, toState });
	}

	const ram = await ramOf(tx, nodeId, machineId);
	if (ram.poweredMb + m.memory_mb > ram.capMb) return false;

	const upd = await tx.client.query<{ state: MachineState }>(
		`UPDATE runtime.machines
		 SET state = $2, state_changed_at = now(), version = version + 1
		 WHERE id = $1 AND state = ANY($3::text[])
		 RETURNING state`,
		[machineId, toState, from],
	);
	if (upd.rowCount === 1) return true;
	// Changed concurrently by a writer that does not take the node lock.
	const again = await tx.client.query<{ state: MachineState }>(
		"SELECT state FROM runtime.machines WHERE id = $1",
		[machineId],
	);
	const state = again.rows[0]?.state ?? null;
	if (state === toState) return true;
	throw invalidState(state, { machineId, toState });
}

/** Sandboxes counted in `maxActiveSandboxes` and `maxRamMb` (S6 §8.5). */
export const QUOTA_ACTIVE_SANDBOX_STATES: readonly SandboxState[] = [
	"creating",
	"ready",
	"starting",
	"stopping",
];

export interface QuotaDelta {
	addSandboxes?: number;
	addRamMb?: number;
	addSavedSnapshots?: number;
	/**
	 * Save that replaces the team's `ready` snapshot of this name (S6 §7.8):
	 * that snapshot is not counted, since it is deleted when the new one is ready.
	 */
	replacingSavedName?: string;
}

/**
 * Quota check (S6 §8.5) for create, fork (target), resume and save. Takes the
 * team lock; call it before `admit`/`lockNode` (lock order team -> node).
 * Only the dimensions being added are checked, so a team above a lowered limit
 * can still stop or delete. Saved snapshots count in `creating` and `ready`.
 * Throws `quota_exceeded` with `details {quota, limit, current}`.
 */
export async function checkQuota(
	tx: Tx,
	teamId: string,
	quota: Quota,
	delta: QuotaDelta,
): Promise<void> {
	await lockTeam(tx, teamId);
	const addSandboxes = delta.addSandboxes ?? 0;
	const addRamMb = delta.addRamMb ?? 0;
	const addSaved = delta.addSavedSnapshots ?? 0;

	if (addSandboxes > 0 || addRamMb > 0) {
		const r = await tx.client.query<{ n: number; ram_mb: number }>(
			`SELECT count(*)::int AS n, COALESCE(SUM(memory_mb), 0)::int AS ram_mb
			 FROM runtime.sandboxes
			 WHERE team_id = $1 AND state = ANY($2::text[])`,
			[teamId, QUOTA_ACTIVE_SANDBOX_STATES],
		);
		const n = r.rows[0]?.n ?? 0;
		const ramMb = r.rows[0]?.ram_mb ?? 0;
		if (addSandboxes > 0 && n + addSandboxes > quota.maxActiveSandboxes) {
			throw quotaExceeded("maxActiveSandboxes", quota.maxActiveSandboxes, n);
		}
		if (addRamMb > 0 && ramMb + addRamMb > quota.maxRamMb) {
			throw quotaExceeded("maxRamMb", quota.maxRamMb, ramMb);
		}
	}

	if (addSaved > 0) {
		const r = await tx.client.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM runtime.snapshots
			 WHERE team_id = $1 AND kind = 'saved' AND state IN ('creating', 'ready')
			   AND NOT (state = 'ready' AND $2::text IS NOT NULL AND name = $2::text)`,
			[teamId, delta.replacingSavedName ?? null],
		);
		const n = r.rows[0]?.n ?? 0;
		if (n + addSaved > quota.maxSavedSnapshots) {
			throw quotaExceeded("maxSavedSnapshots", quota.maxSavedSnapshots, n);
		}
	}
}
