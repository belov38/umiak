import { requestStop, type StopRequestReason, UmiakError } from "@umiak/core";
import { withTx } from "@umiak/db";
import type { WorkerCtx } from "../context.ts";

// Controller `autostop` (S6 §12, every 15 s).
//
// TTL: every `ready` sandbox with `deadline_at <= now()` gets a stop with
// reason `ttl`, whatever its activity.
//
// Idle: a `ready`, healthy sandbox with `idle_timeout_seconds` is a candidate
// when all hold:
// - its machine's tunnel session is connected;
// - the last `activity` event is fresh (<= 150 s) and all counters are zero;
// - the counters are zero since at least `idle_timeout_seconds`
//   (`activity_zero_since`, machine-events);
// - no API call for `idle_timeout_seconds`, and the sandbox has been `ready`
//   that long (`state_changed_at`: a fresh resume is not idle yet);
// - no active operation.
// Then the controller asks the agent live (`AgentPort.activity`) and needs all
// zeros right now. Agent unavailable, a stale event or a failing / non-zero
// live check: no idle-stop. The SQL condition is checked again under the
// sandbox row lock right before `requestStop`.
//
// Lock order: requestStop locks the sandbox row itself; the transaction holds
// no other lock when it is called (the re-check takes the same row lock first).

/** An `activity` event older than this is stale (one missed 60 s heartbeat, §12). */
export const ACTIVITY_FRESH_S = 150;
const BATCH = 200;

export interface AutostopResult {
	ttl: string[];
	idle: string[];
}

const TTL_DUE = `s.state = 'ready' AND s.deadline_at IS NOT NULL AND s.deadline_at <= now()`;

const IDLE_DUE = `s.state = 'ready' AND s.health = 'ok'
	AND s.idle_timeout_seconds IS NOT NULL
	AND s.machine_id IS NOT NULL
	AND s.activity = 'idle'
	AND (s.activity_counters->>'runningCommands')::bigint = 0
	AND (s.activity_counters->>'openPtys')::bigint = 0
	AND (s.activity_counters->>'tcpStreams')::bigint = 0
	AND COALESCE((s.activity_counters->>'desktopStreams')::bigint,0) = 0
	AND s.last_activity_at >= now() - make_interval(secs => ${ACTIVITY_FRESH_S})
	AND s.activity_zero_since <= now() - make_interval(secs => s.idle_timeout_seconds)
	AND (s.last_api_call_at IS NULL
	     OR s.last_api_call_at <= now() - make_interval(secs => s.idle_timeout_seconds))
	AND s.state_changed_at <= now() - make_interval(secs => s.idle_timeout_seconds)
	AND EXISTS (SELECT 1 FROM tunnel.tunnel_sessions ts
	            WHERE ts.machine_id = s.machine_id AND ts.state = 'connected')
	AND NOT EXISTS (SELECT 1 FROM runtime.operations o
	                WHERE o.sandbox_id = s.id AND o.state IN ('pending', 'running'))`;

export async function runAutostop(ctx: WorkerCtx): Promise<AutostopResult> {
	const ttl: string[] = [];
	const due = await ctx.pool.query<{ id: string }>(
		`SELECT s.id FROM runtime.sandboxes s WHERE ${TTL_DUE} ORDER BY s.deadline_at LIMIT ${BATCH}`,
	);
	for (const { id } of due.rows) {
		if (await stop(ctx, id, "ttl", TTL_DUE)) ttl.push(id);
	}

	const idle: string[] = [];
	const cand = await ctx.pool.query<{ id: string; machine_id: string }>(
		`SELECT s.id, s.machine_id FROM runtime.sandboxes s WHERE ${IDLE_DUE}
		 ORDER BY s.activity_zero_since LIMIT ${BATCH}`,
	);
	for (const { id, machine_id } of cand.rows) {
		if (!(await liveIdle(ctx, id, machine_id))) continue;
		if (await stop(ctx, id, "idle", IDLE_DUE)) idle.push(id);
	}
	return { ttl, idle };
}

/** `System/Activity` right now: all zeros, or no idle-stop. */
async function liveIdle(
	ctx: WorkerCtx,
	sandboxId: string,
	machineId: string,
): Promise<boolean> {
	try {
		const a = await ctx.agent.activity(machineId);
		const zero =
			a.runningCommands === 0 &&
			a.openPtys === 0 &&
			a.tcpStreams === 0 &&
			(a.desktopStreams ?? 0) === 0;
		if (!zero) {
			ctx.log.debug(
				{ sandboxId, activity: a },
				"idle-stop skipped: the live check is not idle",
			);
		}
		return zero;
	} catch (err) {
		ctx.log.debug(
			{ sandboxId, err: err instanceof Error ? err.message : String(err) },
			"idle-stop skipped: the live check failed",
		);
		return false;
	}
}

/** Re-checks `cond` under the sandbox row lock, then requestStop. */
async function stop(
	ctx: WorkerCtx,
	sandboxId: string,
	reason: StopRequestReason,
	cond: string,
): Promise<boolean> {
	try {
		const op = await withTx(ctx.pool, async (tx) => {
			const r = await tx.client.query(
				`SELECT 1 FROM runtime.sandboxes s WHERE s.id = $1 AND ${cond} FOR UPDATE OF s`,
				[sandboxId],
			);
			if (r.rowCount !== 1) return null;
			return requestStop(tx, ctx.jobs, sandboxId, reason);
		});
		if (op === null) return false;
		ctx.metrics.inc("umiak_autostop_total", { reason });
		ctx.log.info(
			{ sandboxId, operationId: op.id, reason },
			"autostop requested",
		);
		return true;
	} catch (err) {
		// Another operation became active or the state moved on: next run.
		if (err instanceof UmiakError) {
			ctx.log.debug({ sandboxId, reason, code: err.code }, "autostop skipped");
			return false;
		}
		throw err;
	}
}
