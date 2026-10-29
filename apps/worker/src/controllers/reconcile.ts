import {
	DELETE_RETRY_LIMIT,
	lockNode,
	lockTeam,
	requestSystemResume,
} from "@sbx/core";
import { type Tx, withTx } from "@sbx/db";
import type pg from "pg";
import type { WorkerCtx } from "../context.ts";
import { lockSandboxRow } from "../db.ts";
import { snapshotInUse } from "../handlers/snapshot-op.ts";
import { sandboxToError, transitionSandbox } from "../ops/common.ts";
import type { InfraLv, InfraVm, NodeInfra } from "../ports.ts";

// Controller `reconcile` (S6 §11.2, §11.3; every 60 s). Compares Proxmox
// (VMs of pool `sandbox`, LVs tagged `sbx`) with the database and repairs the
// drift. Each run is planned per provider and node, then applied action by
// action; every action re-checks its condition right before it acts.
//
// Anti-goal (§2): nothing outside pool `sandbox`, without the `sbx` tag,
// outside the VMID range (provider row and the node's S1 range, both), or a
// template VMID is ever deleted. LVs are only ever touched with the `sbx` tag.
//
// Grace: S1 lists carry no creation time, so `runtime.reconcile_seen` keeps
// the first sighting of every VM and LV as an orphan CANDIDATE (guarded and
// unclaimed by the database at that moment). Rows of claimed or vanished
// objects are deleted, and so is the row of an applied delete, so a reused
// VMID or LV name starts its grace again. An orphan VM or LV is removed only
// when it has been a candidate for more than 10 min AND the database still
// says it is ours to remove.
// The tracking is updated in dry run too: it is an observation, not a repair,
// so switching dry run off acts on objects already seen for 10 min.
//
// Ordering against races: the machine rows are read before the lists (a VM
// created after the read cannot look missing); orphan evidence is read after
// the lists (a row inserted after the list protects its VM). Machine actions
// confirm the VM status with a fresh `status()` call and update the machine
// conditionally on the version they saw.
//
// Dry run (`SBX_RECONCILE_DRY_RUN=1`, `WorkerCtx.reconcileDryRun`, default
// true): the same plan, nothing applied, every action logged and returned
// with `applied: false`.
//
// Metrics: `sbx_reconcile_actions_total{kind, mode}` with mode
// applied | skipped | failed | dry_run (kinds include the §11.2 names
// orphan_vm, orphan_lv, power_drift); `sbx_reconcile_failed_total{part}`;
// `sbx_reconcile_skipped_total{reason}` when a guard refused a VM
// (not_in_pool | no_sbx_tag | template).

/** Age before an orphan VM or LV may be removed, and a releasing lease retried (§11.2). */
export const RECONCILE_GRACE_S = 600;
/** An active operation this long past its deadline without a job is enqueued again. */
export const OP_STUCK_AFTER_DEADLINE_S = 300;
/** A pending operation this old without a job (and no active parent) is enqueued again. */
export const PENDING_OP_STALE_S = 60;
/** A delete (no deadline) or a `deleting` machine this long without a job is enqueued again. */
export const RECONCILE_DELETE_STALE_S = 300;
/** A deleted machine whose session is still connected this long after delete is retired again. */
export const RETIRE_AGAIN_AFTER_S = 60;
/** §11.3: a second unexpected stop within this window stops the sandbox. */
export const UNEXPECTED_STOP_WINDOW_S = 3600;
export const SANDBOX_POOL = "sandbox";
export const SBX_TAG = "sbx";
const SHUTDOWN_TIMEOUT_S = 60;

export const RECONCILE_ACTION_KINDS = [
	"orphan_vm",
	"orphan_lv",
	"machine_lost",
	"unexpected_stop",
	"power_drift",
	"lease_release",
	"retire_again",
	"requeue_op",
] as const;
export type ReconcileActionKind = (typeof RECONCILE_ACTION_KINDS)[number];

export interface ReconcileAction {
	kind: ReconcileActionKind;
	/** `vm:<vmid>`, `lv:<name>`, `lease:<vmid>`, `machine:<id>`, `operation:<id>`, `snapshot:<id>`. */
	target: string;
	applied: boolean;
	providerId: string | null;
	nodeId?: string;
	/** What was (or would be) done, e.g. `resume` / `stopped` for an unexpected stop. */
	detail?: string;
	/** Set when applying failed or the condition no longer held (`skipped`). */
	error?: string;
}

/** Live pg-boss jobs (created, retry, active) of a queue, keyed by one field of the job data. */
export interface LiveJobs {
	keys(
		queue: "sandbox-op" | "machine-op" | "snapshot-op",
		field: string,
	): Promise<Set<string>>;
}

type Queryable = Pick<pg.Pool, "query">;

/**
 * Reads `pgboss.job`. Without the pg-boss schema (a database where pg-boss
 * never started) there are no jobs at all.
 */
export function pgBossLiveJobs(q: Queryable, schema = "pgboss"): LiveJobs {
	if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
		throw new Error(`invalid pg-boss schema name ${schema}`);
	}
	return {
		async keys(queue, field) {
			const t = await q.query<{ ok: boolean }>(
				"SELECT to_regclass($1) IS NOT NULL AS ok",
				[`${schema}.job`],
			);
			if (t.rows[0]?.ok !== true) return new Set();
			const r = await q.query<{ k: string | null }>(
				`SELECT DISTINCT data->>$2 AS k FROM ${schema}.job
				 WHERE name = $1 AND state IN ('created', 'retry', 'active')`,
				[queue, field],
			);
			return new Set(
				r.rows.map((x) => x.k).filter((k): k is string => k !== null),
			);
		},
	};
}

export interface ReconcileOptions {
	dryRun: boolean;
	/** Only these providers (default: every provider that is not disabled). */
	providerIds?: string[];
	jobs?: LiveJobs;
}

interface Plan {
	action: ReconcileAction;
	/** True when applied; false when the condition no longer holds. */
	apply(): Promise<boolean>;
}

interface ProviderRow {
	id: string;
	vmid_min: number;
	vmid_max: number;
}

export async function runReconcile(
	ctx: WorkerCtx,
	o: ReconcileOptions,
): Promise<ReconcileAction[]> {
	const jobs = o.jobs ?? pgBossLiveJobs(ctx.pool);
	const p = await ctx.pool.query<ProviderRow>(
		`SELECT id, vmid_min, vmid_max FROM runtime.providers
		 WHERE state <> 'disabled' AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
		 ORDER BY id`,
		[o.providerIds ?? null],
	);
	const out: ReconcileAction[] = [];
	const parts: [string, () => Promise<Plan[]>][] = [];
	for (const provider of p.rows) {
		const nodes = await ctx.pool.query<{ id: string }>(
			`SELECT id FROM runtime.nodes WHERE provider_id = $1 AND state <> 'down' ORDER BY id`,
			[provider.id],
		);
		for (const { id } of nodes.rows) {
			parts.push(["node", () => planNode(ctx, provider, id)]);
		}
		parts.push(["leases", () => planLeases(ctx, provider)]);
		parts.push(["queues", () => planQueues(ctx, provider.id, jobs)]);
		parts.push(["retire", () => planRetire(ctx, provider.id)]);
	}
	// Operations of sandboxes that were never placed have no provider.
	if (o.providerIds === undefined) {
		parts.push(["queues", () => planQueues(ctx, null, jobs)]);
	}
	for (const [part, plan] of parts) {
		let plans: Plan[];
		try {
			plans = await plan();
		} catch (err) {
			ctx.metrics.inc("sbx_reconcile_failed_total", { part });
			ctx.log.error({ part, err: errText(err) }, "reconcile part failed");
			continue;
		}
		for (const pl of plans) out.push(await execute(ctx, pl, o.dryRun));
	}
	return out;
}

async function execute(
	ctx: WorkerCtx,
	plan: Plan,
	dryRun: boolean,
): Promise<ReconcileAction> {
	const a = plan.action;
	if (dryRun) {
		ctx.metrics.inc("sbx_reconcile_actions_total", {
			kind: a.kind,
			mode: "dry_run",
		});
		ctx.log.info({ ...a }, "reconcile dry run: would act");
		return a;
	}
	try {
		if (await plan.apply()) {
			a.applied = true;
			ctx.metrics.inc("sbx_reconcile_actions_total", {
				kind: a.kind,
				mode: "applied",
			});
			ctx.log.warn({ ...a }, "reconcile action applied");
		} else {
			a.error = "skipped: condition no longer holds";
			ctx.metrics.inc("sbx_reconcile_actions_total", {
				kind: a.kind,
				mode: "skipped",
			});
			ctx.log.info({ ...a }, "reconcile action skipped");
		}
	} catch (err) {
		a.error = errText(err);
		ctx.metrics.inc("sbx_reconcile_actions_total", {
			kind: a.kind,
			mode: "failed",
		});
		ctx.log.error({ ...a }, "reconcile action failed");
	}
	return a;
}

// ---------------------------------------------------------------------------
// Per node: machines vs VMs, orphan VMs and LVs

/** Machine states whose VM must exist (not before the VMID is assigned, not on the way out). */
const VM_EXPECTED_STATES = [
	"booting",
	"warm",
	"claiming",
	"running",
	"stopping",
	"stopped",
	"starting",
];

const SANDBOX_LOST_FROM = [
	"creating",
	"ready",
	"stopped",
	"starting",
	"stopping",
];

interface MachineSnap {
	id: string;
	node_id: string;
	state: string;
	version: number;
	vmid: number | null;
	sandbox_id: string | null;
	sandbox_state: string | null;
	current: boolean;
	busy: boolean;
}

const ACTIVE_OP_OF_MACHINE = `EXISTS (
	SELECT 1 FROM runtime.operations o
	WHERE o.sandbox_id = m.sandbox_id AND o.state IN ('pending', 'running'))`;

interface Evidence {
	machineVmids: Set<number>;
	/** VMID → lease state and whether its owner machine is alive (not deleted). */
	leases: Map<number, { state: string; ownerAlive: boolean }>;
	templates: Set<number>;
	diskLvs: Set<string>;
	snapshots: Map<string, { id: string; state: string }>;
}

async function loadEvidence(
	q: Queryable,
	providerId: string,
	infra: NodeInfra,
): Promise<Evidence> {
	const m = await q.query<{ vmid: number }>(
		`SELECT vmid FROM runtime.machines
		 WHERE provider_id = $1 AND vmid IS NOT NULL AND state <> 'deleted'`,
		[providerId],
	);
	const l = await q.query<{
		vmid: number;
		state: string;
		purpose: string;
		owner_alive: boolean;
	}>(
		`SELECT l.vmid, l.state, l.purpose,
		        COALESCE(m.state <> 'deleted', false) AS owner_alive
		 FROM runtime.vmid_leases l
		 LEFT JOIN runtime.machines m ON m.id = l.machine_id
		 WHERE l.provider_id = $1`,
		[providerId],
	);
	const t = await q.query<{ vmid: number }>(
		"SELECT DISTINCT pve_vmid AS vmid FROM runtime.template_builds WHERE provider_id = $1",
		[providerId],
	);
	const d = await q.query<{ volume: string }>(
		`SELECT d.volume FROM runtime.disks d
		 JOIN runtime.storages st ON st.id = d.storage_id
		 WHERE st.provider_id = $1 AND d.state <> 'deleted'`,
		[providerId],
	);
	const s = await q.query<{ id: string; lv_id: string; state: string }>(
		"SELECT id, lv_id, state FROM runtime.snapshots WHERE provider_id = $1",
		[providerId],
	);
	const templates = new Set<number>([
		...infra.templateVmids,
		...t.rows.map((x) => x.vmid),
	]);
	const leases = new Map<number, { state: string; ownerAlive: boolean }>();
	for (const x of l.rows) {
		if (x.purpose === "template") templates.add(x.vmid);
		leases.set(x.vmid, { state: x.state, ownerAlive: x.owner_alive });
	}
	return {
		machineVmids: new Set(m.rows.map((x) => x.vmid)),
		leases,
		templates,
		diskLvs: new Set(d.rows.map((x) => lvOfVolume(x.volume))),
		snapshots: new Map(
			s.rows.map((x) => [x.lv_id, { id: x.id, state: x.state }]),
		),
	};
}

function lvOfVolume(volume: string): string {
	const i = volume.lastIndexOf(":");
	return i < 0 ? volume : volume.slice(i + 1);
}

/** The VMID range this controller may act on: the provider row and S1's range, both. */
function rangeOf(provider: ProviderRow, infra: NodeInfra) {
	return {
		min: Math.max(provider.vmid_min, infra.vmidRange.min),
		max: Math.min(provider.vmid_max, infra.vmidRange.max),
	};
}

/** §2 anti-goal guards for a VM, before any database evidence. */
function vmEligible(
	vm: InfraVm,
	range: { min: number; max: number },
	templates: Set<number>,
): boolean {
	return (
		vm.pool === SANDBOX_POOL &&
		vm.tags.includes(SBX_TAG) &&
		vm.vmid >= range.min &&
		vm.vmid <= range.max &&
		!templates.has(vm.vmid)
	);
}

/** A VMID the database still claims: a live machine has it, or a lease protects it. */
function vmidClaimed(ev: Evidence, vmid: number): boolean {
	if (ev.machineVmids.has(vmid)) return true;
	const lease = ev.leases.get(vmid);
	if (lease === undefined) return false;
	// `releasing` is finished by the lease_release action; reserved/active of a
	// live owner is a preparation (or a machine) in flight.
	return lease.state === "releasing" || lease.ownerAlive;
}

type LvClass =
	| { kind: "vm"; vmid: number }
	| { kind: "snap"; lvId: string }
	| null;

function classifyLv(lv: InfraLv): LvClass {
	const vm = /^vm-(\d+)-/.exec(lv.name);
	if (vm) return { kind: "vm", vmid: Number(vm[1]) };
	const snap = /^sbx-snap-([0-9a-f]{1,32})-/.exec(lv.name);
	if (snap?.[1]) return { kind: "snap", lvId: snap[1] };
	for (const t of lv.tags) {
		const tv = /^sbx-vm-(\d+)$/.exec(t);
		if (tv) return { kind: "vm", vmid: Number(tv[1]) };
		const ts = /^sbx-snap-([0-9a-f]{1,32})$/.exec(t);
		if (ts?.[1]) return { kind: "snap", lvId: ts[1] };
	}
	return null;
}

/**
 * Why an LV is an orphan, or null. `deleting` snapshots belong to snapshot-op
 * (requeued below when their job is gone); a `failed` one is removed only
 * while no clone still reads it.
 */
async function lvOrphanReason(
	q: Queryable,
	lv: InfraLv,
	ev: Evidence,
	vmids: Set<number>,
	range: { min: number; max: number },
): Promise<string | null> {
	if (!lv.tags.includes(SBX_TAG)) return null;
	const c = classifyLv(lv);
	if (c === null) return null;
	if (c.kind === "vm") {
		if (c.vmid < range.min || c.vmid > range.max) return null;
		if (ev.templates.has(c.vmid) || vmids.has(c.vmid)) return null;
		if (ev.machineVmids.has(c.vmid) || ev.leases.has(c.vmid)) return null;
		if (ev.diskLvs.has(lv.name)) return null;
		return `no VM ${c.vmid}, machine, lease or disk row`;
	}
	const s = ev.snapshots.get(c.lvId);
	if (s === undefined) return "no snapshot row";
	if (s.state === "deleted") return "snapshot deleted";
	if (s.state === "failed" && !(await snapshotInUse(q, s.id))) {
		return "snapshot failed";
	}
	return null;
}

/**
 * Grace bookkeeping of orphan candidates: upserts the names that are orphan
 * candidates now, drops every other row of this node (claimed or vanished
 * objects), returns the candidates first seen longer than the grace ago. A
 * VMID or LV name that was claimed in between, or reused after an applied
 * delete (see `forgetSeen`), starts its grace again.
 */
async function trackSeen(
	pool: pg.Pool,
	providerId: string,
	kind: "vm" | "lv",
	prefix: string,
	names: string[],
): Promise<Set<string>> {
	const r = await withTx(pool, async (tx) => {
		await tx.client.query(
			`INSERT INTO runtime.reconcile_seen (provider_id, kind, name)
			 SELECT $1, $2, unnest($3::text[])
			 ON CONFLICT DO NOTHING`,
			[providerId, kind, names],
		);
		await tx.client.query(
			`DELETE FROM runtime.reconcile_seen
			 WHERE provider_id = $1 AND kind = $2 AND starts_with(name, $4)
			   AND NOT (name = ANY($3::text[]))`,
			[providerId, kind, names, prefix],
		);
		return tx.client.query<{ name: string }>(
			`SELECT name FROM runtime.reconcile_seen
			 WHERE provider_id = $1 AND kind = $2 AND starts_with(name, $3)
			   AND first_seen_at < now() - make_interval(secs => $4)`,
			[providerId, kind, prefix, RECONCILE_GRACE_S],
		);
	});
	return new Set(r.rows.map((x) => x.name));
}

async function forgetSeen(
	q: Queryable,
	providerId: string,
	kind: "vm" | "lv",
	name: string,
): Promise<void> {
	await q.query(
		"DELETE FROM runtime.reconcile_seen WHERE provider_id = $1 AND kind = $2 AND name = $3",
		[providerId, kind, name],
	);
}

async function planNode(
	ctx: WorkerCtx,
	provider: ProviderRow,
	nodeId: string,
): Promise<Plan[]> {
	const infra = await ctx.infra.forNode(nodeId);
	// Machine rows first, then the lists (see the header).
	const ms = await ctx.pool.query<MachineSnap>(
		`SELECT m.id, m.node_id, m.state, m.version, m.vmid, m.sandbox_id,
		        s.state AS sandbox_state, COALESCE(s.machine_id = m.id, false) AS current,
		        ${ACTIVE_OP_OF_MACHINE} AS busy
		 FROM runtime.machines m
		 LEFT JOIN runtime.sandboxes s ON s.id = m.sandbox_id
		 WHERE m.node_id = $1 AND m.state = ANY($2::text[])
		 ORDER BY m.id`,
		[nodeId, VM_EXPECTED_STATES],
	);
	const vms = await infra.listVms();
	const lvs = await infra.listLvs();
	const ev = await loadEvidence(ctx.pool, provider.id, infra);
	const range = rangeOf(provider, infra);
	const byVmid = new Map(vms.map((v) => [v.vmid, v]));
	const plans: Plan[] = [];
	const base = { applied: false, providerId: provider.id, nodeId };

	for (const m of ms.rows) {
		if (m.busy) continue;
		const vm = m.vmid === null ? undefined : byVmid.get(m.vmid);
		if (vm === undefined) {
			// Confirm with a fresh status call: the list may be a moment old.
			if (m.vmid !== null && (await infra.status(m.vmid)) !== "missing")
				continue;
			plans.push({
				action: {
					...base,
					kind: "machine_lost",
					target: `machine:${m.id}`,
					detail: `VM ${m.vmid ?? "-"} missing`,
				},
				apply: () => applyLost(ctx, m),
			});
			continue;
		}
		const vmid = vm.vmid;
		if (
			m.state === "running" &&
			vm.status === "stopped" &&
			m.current &&
			m.sandbox_state === "ready"
		) {
			if ((await infra.status(vmid)) !== "stopped") continue;
			const action: ReconcileAction = {
				...base,
				kind: "unexpected_stop",
				target: `machine:${m.id}`,
			};
			plans.push({
				action,
				apply: () => applyUnexpectedStop(ctx, m, action),
			});
			continue;
		}
		if (m.state === "stopped" && vm.status === "running") {
			if ((await infra.status(vmid)) !== "running") continue;
			plans.push({
				action: { ...base, kind: "power_drift", target: `machine:${m.id}` },
				apply: () => applyPowerDrift(ctx, infra, m, vmid),
			});
		}
	}

	// Orphan VMs: guarded, unclaimed now, and an unclaimed candidate for the grace.
	const prefix = `${nodeId}/`;
	const vmCandidates = vms.filter(
		(v) => vmEligible(v, range, ev.templates) && !vmidClaimed(ev, v.vmid),
	);
	const oldVms = await trackSeen(
		ctx.pool,
		provider.id,
		"vm",
		prefix,
		vmCandidates.map((v) => `${prefix}${v.vmid}`),
	);
	for (const vm of vmCandidates) {
		const name = `${prefix}${vm.vmid}`;
		if (!oldVms.has(name)) continue;
		plans.push({
			action: { ...base, kind: "orphan_vm", target: `vm:${vm.vmid}` },
			apply: async () => {
				// Infra first, evidence last: a row written meanwhile is seen.
				if ((await infra.status(vm.vmid)) === "missing") return false;
				const fresh = await loadEvidence(ctx.pool, provider.id, infra);
				if (vmidClaimed(fresh, vm.vmid)) return false;
				await infra.delete(vm.vmid);
				await forgetSeen(ctx.pool, provider.id, "vm", name);
				return true;
			},
		});
	}

	// Orphan LVs: `sbx` tag, an orphan reason now, and the grace as a candidate.
	const vmids = new Set(vms.map((v) => v.vmid));
	const lvCandidates: { lv: InfraLv; reason: string }[] = [];
	for (const lv of lvs) {
		const reason = await lvOrphanReason(ctx.pool, lv, ev, vmids, range);
		if (reason !== null) lvCandidates.push({ lv, reason });
	}
	const oldLvs = await trackSeen(
		ctx.pool,
		provider.id,
		"lv",
		prefix,
		lvCandidates.map((c) => `${prefix}${c.lv.name}`),
	);
	for (const { lv, reason } of lvCandidates) {
		const name = `${prefix}${lv.name}`;
		if (!oldLvs.has(name)) continue;
		plans.push({
			action: {
				...base,
				kind: "orphan_lv",
				target: `lv:${lv.name}`,
				detail: reason,
			},
			apply: async () => {
				// Infra first, evidence last: a row written meanwhile is seen.
				const nowVmids = new Set((await infra.listVms()).map((v) => v.vmid));
				const fresh = await loadEvidence(ctx.pool, provider.id, infra);
				if (
					(await lvOrphanReason(ctx.pool, lv, fresh, nowVmids, range)) === null
				)
					return false;
				await infra.removeLvs([lv.name]);
				await forgetSeen(ctx.pool, provider.id, "lv", name);
				return true;
			},
		});
	}
	return plans;
}

/** The machine is still as the plan saw it, and its sandbox has no active operation. */
async function machineUnchanged(
	q: Queryable,
	m: MachineSnap,
): Promise<boolean> {
	const r = await q.query(
		`SELECT 1 FROM runtime.machines m
		 WHERE m.id = $1 AND m.state = $2 AND m.version = $3 AND NOT ${ACTIVE_OP_OF_MACHINE}`,
		[m.id, m.state, m.version],
	);
	return r.rowCount === 1;
}

async function hasActiveOp(tx: Tx, sandboxId: string): Promise<boolean> {
	const r = await tx.client.query(
		`SELECT 1 FROM runtime.operations
		 WHERE sandbox_id = $1 AND state IN ('pending', 'running')`,
		[sandboxId],
	);
	return (r.rowCount ?? 0) > 0;
}

async function commandsLost(tx: Tx, machineId: string): Promise<void> {
	await tx.client.query(
		`UPDATE runtime.commands SET status = 'lost', ended_at = now()
		 WHERE machine_id = $1 AND status IN ('starting', 'running')`,
		[machineId],
	);
}

/**
 * §6.1 `machine_lost`: machine `failed` (`machine_lost`, as a step that
 * finds the VM gone), the sandbox whose current
 * machine it is → `error machine_lost` (kept for diagnostics; only delete is
 * allowed). A pool machine goes on to `deleting` with a delete job (§6.2).
 * Lock order: sandbox row, then the machine row (the conditional UPDATE).
 */
async function applyLost(ctx: WorkerCtx, m: MachineSnap): Promise<boolean> {
	const detail = `VM ${m.vmid ?? "-"} missing in Proxmox (reconcile)`;
	return withTx(ctx.pool, async (tx) => {
		if (m.sandbox_id !== null) {
			await lockSandboxRow(tx, m.sandbox_id);
			if (await hasActiveOp(tx, m.sandbox_id)) return false;
		}
		const u = await tx.client.query(
			`UPDATE runtime.machines
			 SET state = 'failed', error_code = 'machine_lost', error_detail = $4,
			     power_observed = 'stopped', power_observed_at = now(),
			     state_changed_at = now(), version = version + 1
			 WHERE id = $1 AND state = $2 AND version = $3`,
			[m.id, m.state, m.version, detail],
		);
		if (u.rowCount !== 1) return false;
		await commandsLost(tx, m.id);
		if (m.sandbox_id === null) {
			await tx.client.query(
				`UPDATE runtime.machines
				 SET state = 'deleting', state_changed_at = now(), version = version + 1
				 WHERE id = $1 AND state = 'failed'`,
				[m.id],
			);
			await ctx.jobs.send(
				tx,
				"machine-op",
				{ machineId: m.id, action: "delete" },
				{ singletonKey: m.id, retryLimit: DELETE_RETRY_LIMIT },
			);
			return true;
		}
		const s = await tx.client.query<{ machine_id: string | null }>(
			"SELECT machine_id FROM runtime.sandboxes WHERE id = $1",
			[m.sandbox_id],
		);
		if (s.rows[0]?.machine_id === m.id) {
			await sandboxToError(
				tx,
				m.sandbox_id,
				SANDBOX_LOST_FROM,
				"machine_lost",
				detail,
				{ machineId: m.id, by: "reconcile" },
			);
		}
		return true;
	});
}

/**
 * §11.3 in one transaction: sandbox row, team lock, node lock; machine
 * `running → stopped` conditionally (one stop is handled once),
 * `power_observed = stopped`, the time appended to `unexpected_stops` (entries
 * older than the window dropped). The first stop within the hour gets a
 * system resume (`requestSystemResume`: no quota, admission as usual; it
 * re-locks the same sandbox row, a no-op). A second one, or a refused
 * admission, leaves the sandbox `stopped` with `unexpected_shutdown`.
 */
async function applyUnexpectedStop(
	ctx: WorkerCtx,
	m: MachineSnap,
	action: ReconcileAction,
): Promise<boolean> {
	const sandboxId = m.sandbox_id;
	if (sandboxId === null) return false;
	return withTx(ctx.pool, async (tx) => {
		const s = await tx.client.query<{
			state: string;
			machine_id: string | null;
			team_id: string;
		}>(
			"SELECT state, machine_id, team_id FROM runtime.sandboxes WHERE id = $1 FOR UPDATE",
			[sandboxId],
		);
		const sb = s.rows[0];
		if (sb === undefined || sb.state !== "ready" || sb.machine_id !== m.id)
			return false;
		if (await hasActiveOp(tx, sandboxId)) return false;
		await lockTeam(tx, sb.team_id);
		await lockNode(tx, m.node_id);
		const u = await tx.client.query<{ n: number }>(
			`UPDATE runtime.machines
			 SET state = 'stopped', power_observed = 'stopped', power_observed_at = now(),
			     unexpected_stops = COALESCE((
			       SELECT jsonb_agg(x) FROM jsonb_array_elements(unexpected_stops) x
			       WHERE (x #>> '{}')::timestamptz > now() - make_interval(secs => $3)
			     ), '[]'::jsonb) || jsonb_build_array(now()),
			     state_changed_at = now(), version = version + 1
			 WHERE id = $1 AND state = 'running' AND version = $2
			 RETURNING jsonb_array_length(unexpected_stops) AS n`,
			[m.id, m.version, UNEXPECTED_STOP_WINDOW_S],
		);
		const n = u.rows[0]?.n;
		if (n === undefined) return false;
		await commandsLost(tx, m.id);
		let refused = false;
		if (n === 1) {
			const res = await requestSystemResume(tx, ctx.jobs, sandboxId);
			if (res.ok) {
				action.detail = "resume";
				return true;
			}
			refused = true;
		}
		const ok = await transitionSandbox(
			tx,
			sandboxId,
			["ready"],
			"stopped",
			{
				reason: "unexpected_shutdown",
				data: { machineId: m.id, recentStops: n, admissionRefused: refused },
			},
			{
				sql: "stop_reason = $3, stopped_at = now()",
				params: ["unexpected_shutdown"],
			},
		);
		if (!ok) throw new Error(`sandbox ${sandboxId}: not ready`);
		action.detail = refused ? "stopped_no_capacity" : "stopped";
		return true;
	});
}

/** §11.2: the VM of a `stopped` machine runs (started by hand): S1 shutdown, hard stop on timeout. */
async function applyPowerDrift(
	ctx: WorkerCtx,
	infra: NodeInfra,
	m: MachineSnap,
	vmid: number,
): Promise<boolean> {
	if (!(await machineUnchanged(ctx.pool, m))) return false;
	const res = await infra.shutdown(
		vmid,
		ctx.timing.shutdownTimeoutS ?? SHUTDOWN_TIMEOUT_S,
	);
	if (res === "timeout") {
		// The guest ignored the shutdown; hard stop only if nothing took the machine meanwhile.
		if (!(await machineUnchanged(ctx.pool, m))) return false;
		await infra.stop(vmid);
	}
	await ctx.pool.query(
		`UPDATE runtime.machines SET power_observed = 'stopped', power_observed_at = now()
		 WHERE id = $1 AND state = 'stopped'`,
		[m.id],
	);
	return true;
}

// ---------------------------------------------------------------------------
// Per provider: leases, jobs, retired credentials

/**
 * Why a VM must not be touched by a lease retry, or null. No VM is fine (the
 * S1 delete then only frees the lease and removes the LVs tagged
 * `sbx-vm-N`); a present VM must pass the §2 guards like an orphan.
 */
function leaseVmUnsafe(
	vms: InfraVm[],
	vmid: number,
	templates: Set<number>,
): string | null {
	if (templates.has(vmid)) return "template";
	const vm = vms.find((v) => v.vmid === vmid);
	if (vm === undefined) return null;
	if (vm.pool !== SANDBOX_POOL) return "not_in_pool";
	if (!vm.tags.includes(SBX_TAG)) return "no_sbx_tag";
	return null;
}

function countSkip(
	ctx: WorkerCtx,
	reason: string,
	fields: Record<string, unknown>,
): void {
	ctx.metrics.inc("sbx_reconcile_skipped_total", { reason });
	ctx.log.warn({ ...fields, reason }, "reconcile: refusing to touch a VM");
}

/**
 * §6.4 p. 5: a `releasing` lease older than the grace (its delete died
 * midway). S1 delete again; the verified delete frees the lease. The VM of a
 * lease lives on its owner's node (else the provider's first node). S1
 * delete stops and purges whatever VM has the VMID, so the VM (if any) must
 * be in pool `sandbox`, tagged `sbx` and not a template, at planning and
 * again right before the delete.
 */
async function planLeases(
	ctx: WorkerCtx,
	provider: ProviderRow,
): Promise<Plan[]> {
	const r = await ctx.pool.query<{ vmid: number; node_id: string | null }>(
		`SELECT l.vmid,
		        COALESCE(m.node_id, (SELECT n.id FROM runtime.nodes n
		                             WHERE n.provider_id = l.provider_id ORDER BY n.id LIMIT 1)) AS node_id
		 FROM runtime.vmid_leases l
		 LEFT JOIN runtime.machines m ON m.id = l.machine_id
		 WHERE l.provider_id = $1 AND l.state = 'releasing' AND l.purpose = 'machine'
		   AND l.updated_at < now() - make_interval(secs => $2)
		 ORDER BY l.vmid`,
		[provider.id, RECONCILE_GRACE_S],
	);
	const plans: Plan[] = [];
	const nodes = new Map<
		string,
		{ infra: NodeInfra; vms: InfraVm[]; templates: Set<number> }
	>();
	for (const { vmid, node_id } of r.rows) {
		if (node_id === null) continue;
		let n = nodes.get(node_id);
		if (n === undefined) {
			const infra = await ctx.infra.forNode(node_id);
			const vms = await infra.listVms();
			const ev = await loadEvidence(ctx.pool, provider.id, infra);
			n = { infra, vms, templates: ev.templates };
			nodes.set(node_id, n);
		}
		const { infra } = n;
		const range = rangeOf(provider, infra);
		if (vmid < range.min || vmid > range.max) continue;
		const unsafe = leaseVmUnsafe(n.vms, vmid, n.templates);
		if (unsafe !== null) {
			countSkip(ctx, unsafe, { kind: "lease_release", vmid, nodeId: node_id });
			continue;
		}
		plans.push({
			action: {
				kind: "lease_release",
				target: `lease:${vmid}`,
				applied: false,
				providerId: provider.id,
				nodeId: node_id,
			},
			apply: async () => {
				const vms = await infra.listVms();
				const ev = await loadEvidence(ctx.pool, provider.id, infra);
				const why = leaseVmUnsafe(vms, vmid, ev.templates);
				if (why !== null) {
					countSkip(ctx, why, { kind: "lease_release", vmid, nodeId: node_id });
					return false;
				}
				const still = await ctx.pool.query(
					`SELECT 1 FROM runtime.vmid_leases
					 WHERE provider_id = $1 AND vmid = $2 AND state = 'releasing'`,
					[provider.id, vmid],
				);
				if (still.rowCount !== 1) return false;
				await infra.delete(vmid);
				return true;
			},
		});
	}
	return plans;
}

/**
 * Jobs that went missing (§11.2, last two rows; Task 6 note):
 * - an active operation past deadline + 5 min, a delete (no deadline)
 *   running for 5 min, or a pending one older than 1 min without an active
 *   parent, with no live `sandbox-op` job → the job again (the handler
 *   compensates by deadline itself; a delete keeps unlimited retries);
 * - a `deleting` machine (5 min) whose sandbox has no active operation (a
 *   sandbox delete owns its machines) and no live `machine-op` job;
 * - a `deleting` snapshot without a live `snapshot-op` job.
 * `providerId` null: operations of sandboxes without a provider.
 */
async function planQueues(
	ctx: WorkerCtx,
	providerId: string | null,
	jobs: LiveJobs,
): Promise<Plan[]> {
	const plans: Plan[] = [];
	const base = { applied: false, providerId };
	const liveOps = await jobs.keys("sandbox-op", "operationId");
	const ops = await ctx.pool.query<{
		id: string;
		sandbox_id: string;
		kind: string;
	}>(
		`SELECT o.id, o.sandbox_id, o.kind
		 FROM runtime.operations o
		 JOIN runtime.sandboxes s ON s.id = o.sandbox_id
		 WHERE s.provider_id IS NOT DISTINCT FROM $1::uuid
		   AND o.state IN ('pending', 'running')
		   AND (
		     (o.deadline_at IS NOT NULL
		      AND o.deadline_at < now() - make_interval(secs => $2))
		     OR (o.deadline_at IS NULL AND o.kind = 'delete'
		      AND COALESCE(o.started_at, o.created_at) < now() - make_interval(secs => $4))
		     OR (o.state = 'pending' AND o.created_at < now() - make_interval(secs => $3)
		      AND NOT EXISTS (
		        SELECT 1 FROM runtime.operations p
		        WHERE p.id = o.parent_operation_id AND p.state IN ('pending', 'running')))
		   )
		 ORDER BY o.created_at, o.id`,
		[
			providerId,
			OP_STUCK_AFTER_DEADLINE_S,
			PENDING_OP_STALE_S,
			RECONCILE_DELETE_STALE_S,
		],
	);
	for (const op of ops.rows) {
		if (liveOps.has(op.id)) continue;
		plans.push({
			action: {
				...base,
				kind: "requeue_op",
				target: `operation:${op.id}`,
				detail: `sandbox-op ${op.kind}`,
			},
			apply: () =>
				withTx(ctx.pool, async (tx) => {
					const r = await tx.client.query(
						`SELECT 1 FROM runtime.operations WHERE id = $1 AND state IN ('pending', 'running')`,
						[op.id],
					);
					if (r.rowCount !== 1) return false;
					await ctx.jobs.send(
						tx,
						"sandbox-op",
						{ operationId: op.id },
						op.kind === "delete"
							? { singletonKey: op.sandbox_id, retryLimit: DELETE_RETRY_LIMIT }
							: { singletonKey: op.sandbox_id },
					);
					return true;
				}),
		});
	}
	if (providerId === null) return plans;

	const liveMachines = await jobs.keys("machine-op", "machineId");
	const ms = await ctx.pool.query<{ id: string }>(
		`SELECT m.id FROM runtime.machines m
		 WHERE m.provider_id = $1 AND m.state = 'deleting'
		   AND m.state_changed_at < now() - make_interval(secs => $2)
		   AND NOT ${ACTIVE_OP_OF_MACHINE}
		 ORDER BY m.id`,
		[providerId, RECONCILE_DELETE_STALE_S],
	);
	for (const { id } of ms.rows) {
		if (liveMachines.has(id)) continue;
		plans.push({
			action: {
				...base,
				kind: "requeue_op",
				target: `machine:${id}`,
				detail: "machine-op delete",
			},
			apply: () =>
				withTx(ctx.pool, async (tx) => {
					const r = await tx.client.query(
						"SELECT 1 FROM runtime.machines WHERE id = $1 AND state = 'deleting'",
						[id],
					);
					if (r.rowCount !== 1) return false;
					await ctx.jobs.send(
						tx,
						"machine-op",
						{ machineId: id, action: "delete" },
						{ singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
					);
					return true;
				}),
		});
	}

	const liveSnaps = await jobs.keys("snapshot-op", "snapshotId");
	const ss = await ctx.pool.query<{ id: string }>(
		`SELECT id FROM runtime.snapshots
		 WHERE provider_id = $1 AND state = 'deleting' ORDER BY id`,
		[providerId],
	);
	for (const { id } of ss.rows) {
		if (liveSnaps.has(id)) continue;
		plans.push({
			action: {
				...base,
				kind: "requeue_op",
				target: `snapshot:${id}`,
				detail: "snapshot-op delete",
			},
			apply: () =>
				withTx(ctx.pool, async (tx) => {
					const r = await tx.client.query(
						"SELECT 1 FROM runtime.snapshots WHERE id = $1 AND state = 'deleting'",
						[id],
					);
					if (r.rowCount !== 1) return false;
					await ctx.jobs.send(
						tx,
						"snapshot-op",
						{ snapshotId: id, action: "delete" },
						{ singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
					);
					return true;
				}),
		});
	}
	return plans;
}

/**
 * A `deleted` machine whose tunnel session still says connected a minute
 * after the delete: `retired_at` is written again, which fires the S2
 * NOTIFY so the gateway closes the tunnel.
 */
async function planRetire(ctx: WorkerCtx, providerId: string): Promise<Plan[]> {
	const r = await ctx.pool.query<{ id: string }>(
		`SELECT m.id FROM runtime.machines m
		 JOIN tunnel.tunnel_sessions ts ON ts.machine_id = m.id
		 WHERE m.provider_id = $1 AND m.state = 'deleted' AND ts.state = 'connected'
		   AND COALESCE(m.deleted_at, m.state_changed_at) < now() - make_interval(secs => $2)
		 ORDER BY m.id`,
		[providerId, RETIRE_AGAIN_AFTER_S],
	);
	return r.rows.map(({ id }) => ({
		action: {
			kind: "retire_again" as const,
			target: `machine:${id}`,
			applied: false,
			providerId,
		},
		apply: async () => {
			await ctx.pool.query(
				"UPDATE tunnel.tunnel_credentials SET retired_at = now() WHERE machine_id = $1",
				[id],
			);
			return true;
		},
	}));
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
