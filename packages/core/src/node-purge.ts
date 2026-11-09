import { withTx } from "@umiak/db";
import type pg from "pg";
import type { JobSender } from "./jobs.ts";
import { lockNode } from "./locks.ts";
import { DELETE_RETRY_LIMIT } from "./queues.ts";
import { requestSystemDelete } from "./service/delete.ts";
import { TERMINAL_OPERATION_STATES } from "./states.ts";

// Node removal with purge (S19 "Safe removal", 2026-11-09 decision): every
// Umiak object on the node is deleted through its normal lifecycle path (the
// worker's sandbox-op / snapshot-op / machine-op delete); templates are then
// retired one by one by the console's verified template retirement.

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export interface PurgeSandbox {
	id: string;
	slug: string;
	name: string | null;
	state: string;
	vmids: number[];
}

export interface PurgeMachine {
	id: string;
	vmid: number | null;
	state: string;
}

export interface PurgeSnapshot {
	id: string;
	name: string | null;
	kind: string;
	state: string;
}

export interface PurgeTemplate {
	buildId: string;
	slug: string;
	version: string;
	vmid: number;
	status: string;
}

/** Something the purge cannot clear by itself; `message` is plain language. */
export interface PurgeBlocker {
	kind: "build" | "transfer" | "lease" | "disk";
	id: string;
	message: string;
}

export interface NodeRemovalPlan {
	node: string;
	sandboxes: PurgeSandbox[];
	/** Live machines on the node without a live sandbox (warm, failed, leftovers). */
	machines: PurgeMachine[];
	snapshots: PurgeSnapshot[];
	templates: PurgeTemplate[];
	blockers: PurgeBlocker[];
}

/** Sandboxes whose live machine is on the node, or without live machines but placed there. */
const SANDBOXES_SQL = `
 SELECT s.id::text, s.slug, s.name, s.state,
  COALESCE(array_agg(m.vmid ORDER BY m.vmid) FILTER (WHERE m.vmid IS NOT NULL), '{}') AS vmids
 FROM runtime.sandboxes s
 LEFT JOIN runtime.machines m ON m.sandbox_id = s.id AND m.node_id = $1 AND m.state <> 'deleted'
 WHERE s.state <> 'deleted' AND (
  EXISTS (SELECT 1 FROM runtime.machines x WHERE x.sandbox_id = s.id AND x.node_id = $1 AND x.state <> 'deleted')
  OR (s.node_id = $1 AND NOT EXISTS (SELECT 1 FROM runtime.machines x WHERE x.sandbox_id = s.id AND x.state <> 'deleted')))
 GROUP BY s.id ORDER BY s.created_at, s.id`;

const MACHINES_SQL = `
 SELECT m.id::text, m.vmid, m.state FROM runtime.machines m
 WHERE m.node_id = $1 AND m.state <> 'deleted'
  AND NOT EXISTS (SELECT 1 FROM runtime.sandboxes s WHERE s.id = m.sandbox_id AND s.state <> 'deleted')
 ORDER BY m.created_at, m.id`;

const SNAPSHOTS_SQL = `
 SELECT id::text, COALESCE(name, pending_name) AS name, kind, state FROM runtime.snapshots
 WHERE node_id = $1 AND state <> 'deleted' ORDER BY created_at, id`;

/** An open retirement intent first: retireNodeTemplate refuses others while it is open. */
const TEMPLATES_SQL = `
 SELECT tb.id::text AS "buildId", tb.template_slug AS slug, tb.version, tb.pve_vmid AS vmid, tb.status
 FROM runtime.template_builds tb WHERE tb.node_id = $1 AND tb.status <> 'retired'
 ORDER BY EXISTS (SELECT 1 FROM runtime.node_build_jobs j WHERE j.retiring_build_id = tb.id
  AND j.status IN ('running', 'interrupted')) DESC, tb.template_slug, tb.created_at, tb.id`;

async function blockers(
	q: Queryable,
	nodeId: string,
	node: string,
): Promise<PurgeBlocker[]> {
	const out: PurgeBlocker[] = [];
	// A template retirement intent is resumed by retiring that template again.
	const jobs = await q.query<{
		id: string;
		template_slug: string;
		status: string;
	}>(
		`SELECT id, template_slug, status FROM runtime.node_build_jobs
		 WHERE node_id = $1 AND status IN ('running', 'interrupted') AND retiring_build_id IS NULL
		 ORDER BY created_at, id`,
		[nodeId],
	);
	for (const j of jobs.rows) {
		let message: string;
		if (j.template_slug === "node-prepare")
			message = `Adding node ${node} did not finish (job ${j.id}); rerun Add for ${node} with the same settings, then remove it`;
		else if (j.status === "running")
			message = `A template build ${j.template_slug} is running on ${node} (job ${j.id}); wait until it finishes, then retry`;
		else
			message = `An interrupted template build ${j.template_slug} (job ${j.id}) still holds ${node}; remove its build VMs and run cleanup-build (docs/operations-multi-node.md), then retry`;
		out.push({ kind: "build", id: j.id, message });
	}
	const transfers = await q.query<{
		id: string;
		kind: string;
		source: string;
		target: string;
		phase: string;
	}>(
		`SELECT v.id, v.kind, sn.name AS source, tn.name AS target, v.phase
		 FROM runtime.volume_transfers v
		 JOIN runtime.nodes sn ON sn.id = v.source_node_id
		 JOIN runtime.nodes tn ON tn.id = v.target_node_id
		 WHERE (v.source_node_id = $1 OR v.target_node_id = $1) AND v.phase NOT IN ('done', 'cancelled')
		 ORDER BY v.created_at, v.id`,
		[nodeId],
	);
	for (const v of transfers.rows)
		out.push({
			kind: "transfer",
			id: v.id,
			message: `A ${v.kind} copy from ${v.source} to ${v.target} is unfinished (${v.phase}); wait until it finishes or cancel it in Setup, then retry`,
		});
	// Template leases are freed by retiring their template; others need inspection.
	const leases = await q.query<{ vmid: number; job: string }>(
		`SELECT l.vmid, b.id AS job FROM runtime.vmid_leases l
		 JOIN runtime.node_build_jobs b ON b.id = l.build_job_id
		 WHERE b.node_id = $1 AND b.status NOT IN ('running', 'interrupted')
		  AND NOT (l.purpose = 'template' AND l.machine_id IS NULL AND l.vmid IN
		   (SELECT pve_vmid FROM runtime.template_builds WHERE node_id = $1 AND status <> 'retired'))
		 ORDER BY l.vmid`,
		[nodeId],
	);
	for (const l of leases.rows)
		out.push({
			kind: "lease",
			id: String(l.vmid),
			message: `VMID ${l.vmid} is still reserved by finished build job ${l.job} on ${node}; check in Proxmox that VM ${l.vmid} and its disks are gone (docs/operations-multi-node.md), then retry`,
		});
	const disks = await q.query<{ id: string; volume: string }>(
		`SELECT d.id::text, d.volume FROM runtime.disks d
		 LEFT JOIN runtime.machines m ON m.id = d.machine_id
		 LEFT JOIN runtime.snapshots s ON s.id = d.snapshot_id
		 WHERE (m.node_id = $1 OR s.node_id = $1) AND d.state <> 'deleted'
		  AND COALESCE(m.state, s.state) = 'deleted'
		 ORDER BY d.id`,
		[nodeId],
	);
	for (const d of disks.rows)
		out.push({
			kind: "disk",
			id: d.id,
			message: `Disk ${d.volume} of an already deleted sandbox is still recorded on ${node}; check that the volume is gone, then retry`,
		});
	return out;
}

/** Read-only: what removing this node deletes, and what would stop it. */
export async function nodeRemovalPlan(
	q: Queryable,
	nodeId: string,
): Promise<NodeRemovalPlan> {
	const n = await q.query<{ name: string }>(
		"SELECT name FROM runtime.nodes WHERE id=$1",
		[nodeId],
	);
	const node = n.rows[0]?.name;
	if (node === undefined) throw new Error("Unknown sandbox node");
	// Sequential: q may be a single transaction client, which must not run queries concurrently.
	const sandboxes = await q.query<PurgeSandbox>(SANDBOXES_SQL, [nodeId]);
	const machines = await q.query<PurgeMachine>(MACHINES_SQL, [nodeId]);
	const snapshots = await q.query<PurgeSnapshot>(SNAPSHOTS_SQL, [nodeId]);
	const templates = await q.query<PurgeTemplate>(TEMPLATES_SQL, [nodeId]);
	return {
		node,
		sandboxes: sandboxes.rows,
		machines: machines.rows,
		snapshots: snapshots.rows,
		templates: templates.rows,
		blockers: await blockers(q, nodeId, node),
	};
}

async function deleteSnapshot(
	pool: pg.Pool,
	jobs: JobSender,
	id: string,
): Promise<void> {
	await withTx(pool, async (tx) => {
		const r = await tx.client.query<{
			state: string;
			kind: string;
			consumer: string | null;
		}>(
			`SELECT s.state, s.kind, c.state AS consumer FROM runtime.snapshots s
			 LEFT JOIN runtime.sandboxes c ON c.id = s.consumer_sandbox_id
			 WHERE s.id = $1 FOR UPDATE OF s`,
			[id],
		);
		const s = r.rows[0];
		if (s === undefined || s.state === "deleted") return;
		// A creating snapshot belongs to its source's operation, a consumed fork
		// source to its consumer: both go with the sandbox delete.
		if (s.state === "creating") return;
		if (s.kind === "fork_source" && s.consumer && s.consumer !== "deleted")
			return;
		if (s.state !== "deleting")
			await tx.client.query(
				"UPDATE runtime.snapshots SET state = 'deleting', version = version + 1 WHERE id = $1",
				[id],
			);
		await jobs.send(
			tx,
			"snapshot-op",
			{ snapshotId: id, action: "delete" },
			{ singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
		);
	});
}

async function deleteMachine(
	pool: pg.Pool,
	jobs: JobSender,
	id: string,
): Promise<void> {
	await withTx(pool, async (tx) => {
		const pre = await tx.client.query<{ sandbox_id: string | null }>(
			"SELECT sandbox_id FROM runtime.machines WHERE id = $1",
			[id],
		);
		const sandboxId = pre.rows[0]?.sandbox_id;
		// Lock order: the sandbox row before its machine.
		if (sandboxId) {
			const s = await tx.client.query<{ state: string }>(
				"SELECT state FROM runtime.sandboxes WHERE id = $1 FOR UPDATE",
				[sandboxId],
			);
			if (s.rows[0] && s.rows[0].state !== "deleted") return;
		}
		const m = await tx.client.query<{ state: string }>(
			"SELECT state FROM runtime.machines WHERE id = $1 FOR UPDATE",
			[id],
		);
		const state = m.rows[0]?.state;
		if (state === undefined || state === "deleted") return;
		// machine-op delete skips legacy pool rows: release them even when already deleting.
		await tx.client.query(
			"UPDATE runtime.machines SET pool_key = NULL WHERE id = $1",
			[id],
		);
		if (state !== "deleting")
			await tx.client.query(
				`UPDATE runtime.machines
				 SET state = 'deleting', error_code = COALESCE(error_code, 'operator'),
				     error_detail = COALESCE(error_detail, 'node removal'),
				     state_changed_at = now(), version = version + 1
				 WHERE id = $1`,
				[id],
			);
		await jobs.send(
			tx,
			"machine-op",
			{ machineId: id, action: "delete" },
			{ singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
		);
	});
}

/** Live items (not being deleted already) the operator did not confirm. */
export function unconfirmedItems(
	plan: NodeRemovalPlan,
	confirmed: readonly string[],
): string[] {
	const ok = new Set(confirmed);
	const fresh = <T extends { id: string; state: string }>(rows: T[]) =>
		rows.filter((r) => r.state !== "deleting" && !ok.has(r.id));
	return [
		...fresh(plan.sandboxes).map((s) => `sandbox ${s.slug}`),
		...fresh(plan.machines).map((m) => `machine VMID ${m.vmid ?? "-"}`),
		...fresh(plan.snapshots).map((s) => `snapshot ${s.name ?? s.id}`),
	];
}

/**
 * Cordons the node and requests the delete of every sandbox, snapshot and
 * orphan machine on it. `confirmed` are the IDs the operator was shown: a
 * live item outside it refuses the purge. Idempotent: a rerun only nudges
 * unfinished deletes. Refuses (nothing changed) while a blocker exists.
 * Returns the plan after the requests; the caller waits for the worker and
 * then retires templates.
 */
export async function requestNodePurge(
	pool: pg.Pool,
	jobs: JobSender,
	nodeId: string,
	confirmed: readonly string[],
): Promise<NodeRemovalPlan> {
	const plan = await withTx(pool, async (tx) => {
		await lockNode(tx, nodeId);
		// Under the node lock, so no build can start between check and cordon.
		const p = await nodeRemovalPlan(tx.client, nodeId);
		if (p.blockers.length)
			throw new Error(p.blockers.map((b) => b.message).join("; "));
		const unconfirmed = unconfirmedItems(p, confirmed);
		if (unconfirmed.length)
			throw new Error(
				`New items appeared on node ${p.node} since the list was shown: ${unconfirmed.join(", ")}; rerun the removal to review them`,
			);
		await tx.client.query(
			"UPDATE runtime.nodes SET state = 'cordoned', updated_at = now() WHERE id = $1 AND state = 'active'",
			[nodeId],
		);
		return p;
	});
	for (const s of plan.sandboxes)
		await withTx(pool, async (tx) => {
			const op = await requestSystemDelete(tx, jobs, s.id, "node_removal");
			// An existing delete only returns its operation: send its job again.
			if (
				s.state === "deleting" &&
				!TERMINAL_OPERATION_STATES.includes(op.state)
			)
				await jobs.send(
					tx,
					"sandbox-op",
					{ operationId: op.id },
					{ singletonKey: s.id, retryLimit: DELETE_RETRY_LIMIT },
				);
		});
	for (const s of plan.snapshots) await deleteSnapshot(pool, jobs, s.id);
	for (const m of plan.machines) await deleteMachine(pool, jobs, m.id);
	return nodeRemovalPlan(pool, nodeId);
}
