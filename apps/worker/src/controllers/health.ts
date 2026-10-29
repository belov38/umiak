import { insertSandboxEvent } from "@sbx/core";
import { withTx } from "@sbx/db";
import type { WorkerCtx } from "../context.ts";
import { lockSandboxRow } from "../db.ts";
import type { VmStatus } from "../ports.ts";

// Controller `health` (S6 §11.1, every 10 s). A `ready` sandbox whose agent
// is gone becomes `degraded`; the reason comes from the VM status and a QGA
// ping. A degraded sandbox is never stopped or rebooted here: `agent_unreachable`
// gets at most one agent service restart through QGA per 10 min (after 2 min
// degraded); `vm_unresponsive` waits for the user's recover; `vm_stopped` is
// left to reconcile (§11.3). Recovery to `ok` is the `connected` event
// (machine-events).
//
// The last restart is the newest `sandbox_events` row of type
// `agent_restart` (no extra column); it is written before the QGA call, so a
// crash after the call never repeats it sooner than the interval.
//
// Also cheap here: `deleteStuckCount` (§7.9), delete operations active for
// more than 30 min, exported as the gauge `sbx_delete_stuck_operations`.

/** Agent absence before `degraded` (§11.1). */
export const HEALTH_DISCONNECT_GRACE_S = 60;
/** A gateway instance whose heartbeat is older is gone (S2 §7). */
export const GATEWAY_HEARTBEAT_STALE_S = 15;
/** Degraded this long before the first agent restart. */
export const AGENT_RESTART_AFTER_S = 120;
/** At most one agent restart per sandbox in this window. */
export const AGENT_RESTART_INTERVAL_S = 600;
/** A delete active longer than this is stuck (§7.9). */
export const DELETE_STUCK_AFTER_S = 1800;
export const AGENT_RESTART_ARGV: readonly string[] = [
	"systemctl",
	"restart",
	"sbx-agent",
];

export type HealthReason =
	| "agent_unreachable"
	| "vm_unresponsive"
	| "vm_stopped"
	| "vm_missing";

export interface HealthResult {
	/** Sandboxes that became degraded in this run. */
	degraded: string[];
	/** Sandboxes whose agent service was restarted in this run. */
	restarted: string[];
	deleteStuckCount: number;
}

interface DegradedRow {
	id: string;
	machine_id: string;
	node_id: string;
	vmid: number | null;
	health_reason: string | null;
	degraded_long: boolean;
	restart_due: boolean;
}

export async function runHealth(ctx: WorkerCtx): Promise<HealthResult> {
	const degraded = await markDegraded(ctx);
	const restarted: string[] = [];
	for (const row of await degradedSandboxes(ctx)) {
		try {
			if (await probe(ctx, row)) restarted.push(row.id);
		} catch (err) {
			ctx.log.warn(
				{ sandboxId: row.id, err: errText(err) },
				"health probe failed",
			);
		}
	}
	const deleteStuckCount = await countStuckDeletes(ctx);
	ctx.metrics.set("sbx_delete_stuck_operations", deleteStuckCount);
	if (deleteStuckCount > 0) {
		ctx.log.error({ count: deleteStuckCount }, "delete operations stuck");
	}
	return { degraded, restarted, deleteStuckCount };
}

/**
 * The §11.1 condition for a `ready`, `ok` sandbox (alias `s`, session `ts`,
 * gateway instance `gi`): the session is disconnected for longer than the
 * grace; or it says connected while its owner gateway is stale or gone; or
 * there is no session at all for longer than the grace after ready.
 */
const AGENT_GONE = `(
	(ts.state = 'disconnected'
	  AND ts.disconnected_at < now() - make_interval(secs => ${HEALTH_DISCONNECT_GRACE_S}))
	OR (ts.state = 'connected'
	  AND (gi.id IS NULL
	       OR gi.heartbeat_at < now() - make_interval(secs => ${GATEWAY_HEARTBEAT_STALE_S})))
	OR (ts.machine_id IS NULL
	  AND COALESCE(s.ready_at, s.state_changed_at)
	      < now() - make_interval(secs => ${HEALTH_DISCONNECT_GRACE_S}))
)`;

const CANDIDATES_FROM = `
	FROM runtime.sandboxes s
	LEFT JOIN tunnel.tunnel_sessions ts ON ts.machine_id = s.machine_id
	LEFT JOIN tunnel.gateway_instances gi ON gi.id = ts.instance_id
	WHERE s.state = 'ready' AND s.health = 'ok' AND s.machine_id IS NOT NULL`;

async function markDegraded(ctx: WorkerCtx): Promise<string[]> {
	const r = await ctx.pool.query<{ id: string }>(
		`SELECT s.id ${CANDIDATES_FROM} AND ${AGENT_GONE} ORDER BY s.id LIMIT 500`,
	);
	const out: string[] = [];
	for (const { id } of r.rows) {
		const done = await withTx(ctx.pool, async (tx) => {
			if ((await lockSandboxRow(tx, id)) === null) return false;
			// Re-check under the lock: a `connected` may have just landed.
			const u = await tx.client.query(
				`UPDATE runtime.sandboxes AS s0
				 SET health = 'degraded', degraded_since = now(), health_reason = NULL,
				     activity = 'unknown', activity_zero_since = NULL, version = s0.version + 1
				 WHERE s0.id = $1 AND EXISTS (
				   SELECT 1 ${CANDIDATES_FROM} AND s.id = s0.id AND ${AGENT_GONE})`,
				[id],
			);
			if (u.rowCount !== 1) return false;
			await insertSandboxEvent(tx, { sandboxId: id, type: "degraded" });
			return true;
		});
		if (done) {
			out.push(id);
			ctx.metrics.inc("sbx_sandbox_degraded_total");
			ctx.log.warn({ sandboxId: id }, "sandbox degraded: agent unreachable");
		}
	}
	return out;
}

async function degradedSandboxes(ctx: WorkerCtx): Promise<DegradedRow[]> {
	const r = await ctx.pool.query<DegradedRow>(
		`SELECT s.id, s.machine_id, m.node_id, m.vmid, s.health_reason,
		        s.degraded_since <= now() - make_interval(secs => $1) AS degraded_long,
		        NOT EXISTS (
		          SELECT 1 FROM runtime.sandbox_events e
		          WHERE e.sandbox_id = s.id AND e.type = 'agent_restart'
		            AND e.created_at > now() - make_interval(secs => $2)
		        ) AS restart_due
		 FROM runtime.sandboxes s
		 JOIN runtime.machines m ON m.id = s.machine_id
		 WHERE s.state = 'ready' AND s.health = 'degraded'
		 ORDER BY s.id LIMIT 500`,
		[AGENT_RESTART_AFTER_S, AGENT_RESTART_INTERVAL_S],
	);
	return r.rows;
}

/** Sets `health_reason`; returns true when it restarted the agent service. */
async function probe(ctx: WorkerCtx, row: DegradedRow): Promise<boolean> {
	if (row.vmid === null) {
		await setReason(ctx, row, "vm_missing");
		return false;
	}
	const infra = await ctx.infra.forNode(row.node_id);
	const status: VmStatus = await infra.status(row.vmid);
	let reason: HealthReason;
	if (status === "stopped") reason = "vm_stopped";
	else if (status === "missing") reason = "vm_missing";
	else if (status === "running" && (await infra.qgaPing(row.vmid)))
		reason = "agent_unreachable";
	else reason = "vm_unresponsive";
	if (!(await setReason(ctx, row, reason))) return false;
	if (reason !== "agent_unreachable" || !row.degraded_long || !row.restart_due)
		return false;

	const claimed = await withTx(ctx.pool, async (tx) => {
		if ((await lockSandboxRow(tx, row.id)) === null) return false;
		const ok = await tx.client.query(
			`SELECT 1 FROM runtime.sandboxes WHERE id = $1 AND state = 'ready'
			   AND health = 'degraded' AND machine_id = $2`,
			[row.id, row.machine_id],
		);
		if (ok.rowCount !== 1) return false;
		await insertSandboxEvent(tx, {
			sandboxId: row.id,
			type: "agent_restart",
			reason: "agent_unreachable",
			data: { machineId: row.machine_id },
		});
		return true;
	});
	if (!claimed) return false;
	try {
		const r = await infra.qgaExec(row.vmid, [...AGENT_RESTART_ARGV]);
		ctx.metrics.inc("sbx_agent_restart_total", {
			result: r.exitCode === 0 ? "ok" : "failed",
		});
		ctx.log.warn(
			{ sandboxId: row.id, machineId: row.machine_id, exitCode: r.exitCode },
			"agent service restarted through QGA",
		);
	} catch (err) {
		ctx.metrics.inc("sbx_agent_restart_total", { result: "error" });
		ctx.log.warn(
			{ sandboxId: row.id, err: errText(err) },
			"agent service restart through QGA failed",
		);
	}
	return true;
}

/** Writes the reason under the sandbox lock; false if the sandbox is no longer degraded. */
async function setReason(
	ctx: WorkerCtx,
	row: DegradedRow,
	reason: HealthReason,
): Promise<boolean> {
	return withTx(ctx.pool, async (tx) => {
		if ((await lockSandboxRow(tx, row.id)) === null) return false;
		const u = await tx.client.query(
			`UPDATE runtime.sandboxes
			 SET health_reason = $3,
			     version = CASE WHEN health_reason IS DISTINCT FROM $3 THEN version + 1 ELSE version END
			 WHERE id = $1 AND state = 'ready' AND health = 'degraded' AND machine_id = $2`,
			[row.id, row.machine_id, reason],
		);
		return u.rowCount === 1;
	});
}

async function countStuckDeletes(ctx: WorkerCtx): Promise<number> {
	const r = await ctx.pool.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM runtime.operations
		 WHERE kind = 'delete' AND state IN ('pending', 'running')
		   AND created_at < now() - make_interval(secs => $1)`,
		[DELETE_STUCK_AFTER_S],
	);
	return r.rows[0]?.n ?? 0;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
