import {
	type AgentEvent,
	type AgentEventKind,
	completeCommand,
	insertOperation,
	insertSandboxEvent,
	markOutputTruncated,
	normalizeAgentEvent,
	operationDeadline,
	SbxError,
	type SyntheticEventType,
} from "@sbx/core";
import type { Tx } from "@sbx/db";
import type { WorkerCtx } from "../context.ts";
import { type MachineRow, withMachineLocked } from "../db.ts";

// machine-events queue (S6 §10.2): applies the stored agent and synthetic
// events of one machine, idempotently, and marks them processed. Agent events
// go by `seq`, synthetic ones by `time`. Connection state is read from
// tunnel_sessions, not from the event order (S2).
//
// Lock order: withMachineLocked takes the machine's sandbox row first, then the
// machine row; everything here (commands, operations, snapshots) comes after.
//
// State-like agent events (`phase`, `activity`, `ports.changed`) are "latest
// wins": an event is skipped when a processed event of the same type with a
// higher seq exists, so a late batch never rolls state back. Events without a
// handler are marked processed.

export interface MachineEventsData {
	machineId: string;
}

const BATCH = 200;

interface EventScope {
	ctx: WorkerCtx;
	tx: Tx;
	/** The machine row, locked (its sandbox row is locked first, if any). */
	machine: MachineRow;
}

interface SyntheticRow {
	epoch: string;
	type: SyntheticEventType;
	instance_id: string;
	time: Date;
}

interface AgentRow {
	seq: string;
	boot_id: string;
	type: string;
	time: Date;
	received_at: Date;
	payload: unknown;
}

type SyntheticHandler = (s: EventScope, e: SyntheticRow) => Promise<void>;
type AgentHandler<K extends AgentEventKind> = (
	s: EventScope,
	e: Extract<AgentEvent, { kind: K }>,
	row: AgentRow,
) => Promise<void>;

const SYNTHETIC: Partial<Record<SyntheticEventType, SyntheticHandler>> = {
	connected: onConnected,
	// `disconnected`: nothing at once; the health controller owns the rule (§11.1).
	agent_restarted: onAgentRestarted,
	rebooted: onRebooted,
	identity_changed: onIdentityChanged,
};

const AGENT: { [K in AgentEventKind]?: AgentHandler<K> } = {
	phase: onPhase,
	command_exited: onCommandExited,
	pty_closed: onPtyClosed,
	output_truncated: onOutputTruncated,
	activity: onActivity,
	ports_changed: onPortsChanged,
	quiesce_watchdog_thawed: onQuiesceWatchdogThawed,
};

/** Kinds where only the newest event (by seq) counts. */
const LATEST_WINS: ReadonlySet<AgentEventKind> = new Set<AgentEventKind>([
	"phase",
	"activity",
	"ports_changed",
]);

/** Returns the number of events processed. */
export async function handleMachineEvents(
	ctx: WorkerCtx,
	data: MachineEventsData,
): Promise<{ processed: number }> {
	let processed = 0;
	for (;;) {
		const n = await withMachineLocked(ctx.pool, data.machineId, (tx, m) =>
			processBatch(ctx, tx, data.machineId, m),
		);
		processed += n;
		if (n === 0) return { processed };
	}
}

async function processBatch(
	ctx: WorkerCtx,
	tx: Tx,
	machineId: string,
	machine: MachineRow | null,
): Promise<number> {
	const synthetic = await tx.client.query<SyntheticRow>(
		`SELECT epoch, type, instance_id, time FROM runtime.agent_synthetic_events
		 WHERE machine_id = $1 AND processed_at IS NULL
		 ORDER BY time, epoch, type
		 LIMIT ${BATCH}
		 FOR UPDATE`,
		[machineId],
	);
	const agent = await tx.client.query<AgentRow>(
		`SELECT seq, boot_id, type, time, received_at, payload FROM runtime.agent_events
		 WHERE machine_id = $1 AND processed_at IS NULL
		 ORDER BY seq
		 LIMIT ${BATCH}
		 FOR UPDATE`,
		[machineId],
	);
	if (synthetic.rows.length === 0 && agent.rows.length === 0) return 0;

	if (machine !== null) {
		const scope: EventScope = { ctx, tx, machine };
		for (const e of synthetic.rows) {
			await SYNTHETIC[e.type]?.(scope, e);
		}
		for (const row of agent.rows) {
			const ev = normalizeAgentEvent({ type: row.type, payload: row.payload });
			if (ev === null) continue;
			if (LATEST_WINS.has(ev.kind) && (await superseded(tx, machineId, row))) {
				await onSuperseded(scope, ev, row);
				continue;
			}
			const handler = AGENT[ev.kind] as
				| AgentHandler<typeof ev.kind>
				| undefined;
			await handler?.(scope, ev as never, row);
		}
	} else {
		ctx.log.warn({ machineId }, "events of an unknown machine dropped");
	}

	if (synthetic.rows.length > 0) {
		await tx.client.query(
			`UPDATE runtime.agent_synthetic_events SET processed_at = now()
			 WHERE machine_id = $1 AND (epoch, type) IN (
			   SELECT * FROM unnest($2::bigint[], $3::text[]))`,
			[
				machineId,
				synthetic.rows.map((e) => e.epoch),
				synthetic.rows.map((e) => e.type),
			],
		);
	}
	if (agent.rows.length > 0) {
		await tx.client.query(
			`UPDATE runtime.agent_events SET processed_at = now()
			 WHERE machine_id = $1 AND seq = ANY($2::bigint[])`,
			[machineId, agent.rows.map((e) => e.seq)],
		);
	}
	return synthetic.rows.length + agent.rows.length;
}

/** A processed event of the same raw type with a higher seq exists. */
async function superseded(
	tx: Tx,
	machineId: string,
	row: AgentRow,
): Promise<boolean> {
	const r = await tx.client.query(
		`SELECT 1 FROM runtime.agent_events
		 WHERE machine_id = $1 AND type = $2 AND seq > $3 AND processed_at IS NOT NULL
		 LIMIT 1`,
		[machineId, row.type, row.seq],
	);
	return (r.rowCount ?? 0) > 0;
}

/**
 * A state-like event that arrived after a newer one of its type. The state
 * stays as it is, except for facts the newer event does not carry:
 * - `pool_ready` of the current boot still records `ready_boot_id` (and the
 *   pool machine's `warm`): the boot gate waits for it (decision 4);
 * - a non-zero `activity` older than the newest one means the counters were
 *   not zero all along: the zero mark moves to the first later zero event
 *   (§12, order independence).
 */
async function onSuperseded(
	s: EventScope,
	ev: AgentEvent,
	row: AgentRow,
): Promise<void> {
	if (ev.kind === "phase" && ev.phase === "pool_ready") {
		if (
			row.boot_id !== s.machine.ready_boot_id &&
			(await sessionBoot(s)) === row.boot_id
		) {
			await setPoolReady(s, row.boot_id, { phase: false });
		}
		return;
	}
	if (ev.kind === "activity" && !isZero(ev)) await lateBusy(s, row);
}

function isZero(e: Extract<AgentEvent, { kind: "activity" }>): boolean {
	return e.runningCommands === 0 && e.openPtys === 0 && e.tcpStreams === 0;
}

/**
 * Invariant: `activity_zero_since` is the receive time of the first zero
 * event after the last non-zero one among the processed events. A late
 * non-zero event at seq S changes it only when every processed activity
 * event after S is zero; then the mark is the first of those.
 */
async function lateBusy(s: EventScope, row: AgentRow): Promise<void> {
	const sb = await currentSandbox(s);
	if (sb === null) return;
	const later = await s.tx.client.query<AgentRow>(
		`SELECT seq, boot_id, type, time, received_at, payload FROM runtime.agent_events
		 WHERE machine_id = $1 AND type = $2 AND seq > $3 AND processed_at IS NOT NULL
		 ORDER BY seq`,
		[s.machine.id, row.type, row.seq],
	);
	let first: Date | null = null;
	for (const r of later.rows) {
		const e = normalizeAgentEvent({ type: r.type, payload: r.payload });
		if (e?.kind !== "activity") continue;
		// A later non-zero event already reset the mark; this one changes nothing.
		if (!isZero(e)) return;
		first ??= r.received_at;
	}
	if (first === null) return;
	await s.tx.client.query(
		`UPDATE runtime.sandboxes
		 SET activity_zero_since = GREATEST(activity_zero_since, $2::timestamptz)
		 WHERE id = $1 AND activity_zero_since IS NOT NULL`,
		[sb.id, first],
	);
}

/** The machine's sandbox, when this machine is its current machine. */
async function currentSandbox(s: EventScope): Promise<CurrentSandbox | null> {
	const sandboxId = s.machine.sandbox_id;
	if (sandboxId === null) return null;
	const r = await s.tx.client.query<CurrentSandbox>(
		`SELECT id, state, template_build_id FROM runtime.sandboxes
		 WHERE id = $1 AND machine_id = $2`,
		[sandboxId, s.machine.id],
	);
	return r.rows[0] ?? null;
}

interface CurrentSandbox {
	id: string;
	state: string;
	template_build_id: string;
}

async function sessionBoot(s: EventScope): Promise<string | null> {
	const r = await s.tx.client.query<{ boot_id: string }>(
		"SELECT boot_id FROM tunnel.tunnel_sessions WHERE machine_id = $1",
		[s.machine.id],
	);
	return r.rows[0]?.boot_id ?? null;
}

/** §10.2 `connected`: a degraded sandbox is healthy again. */
async function onConnected(s: EventScope): Promise<void> {
	const sandboxId = s.machine.sandbox_id;
	if (sandboxId === null) return;
	const r = await s.tx.client.query(
		`UPDATE runtime.sandboxes
		 SET health = 'ok', health_reason = NULL, degraded_since = NULL, version = version + 1
		 WHERE id = $1 AND machine_id = $2 AND health = 'degraded'`,
		[sandboxId, s.machine.id],
	);
	if (r.rowCount === 1) {
		await insertSandboxEvent(s.tx, {
			sandboxId,
			type: "recovered",
			data: { machineId: s.machine.id },
		});
	}
}

/**
 * §10.2 `phase`: the last phase is kept in `agent_phase`. `pool_ready`
 * records its boot in `ready_boot_id` (decision 4) and moves a pool machine
 * that waits in `booting` to `warm`.
 */
async function onPhase(
	s: EventScope,
	e: Extract<AgentEvent, { kind: "phase" }>,
	row: AgentRow,
): Promise<void> {
	const m = s.machine;
	if (e.phase !== "pool_ready") {
		await s.tx.client.query(
			"UPDATE runtime.machines SET agent_phase = $2 WHERE id = $1",
			[m.id, e.phase],
		);
		m.agent_phase = e.phase;
		if (e.phase === "secrets_missing") {
			// Only for the boot the machine is on now: an event of an older boot
			// says nothing about the current one.
			const sb = await currentSandbox(s);
			if (sb !== null && (await sessionBoot(s)) === row.boot_id) {
				await maybeReprovision(s, sb, row.boot_id, "secrets_missing");
			}
		}
		return;
	}
	await setPoolReady(s, row.boot_id, { phase: true });
}

/**
 * Records the boot of `pool_ready` in `ready_boot_id` (decision 4) and moves
 * a pool machine that waits in `booting` to `warm`; with `phase`, also sets
 * `agent_phase`.
 */
async function setPoolReady(
	s: EventScope,
	bootId: string,
	o: { phase: boolean },
): Promise<void> {
	const m = s.machine;
	const toWarm =
		m.state === "booting" && m.pool_key !== null && m.sandbox_id === null;
	await s.tx.client.query(
		`UPDATE runtime.machines
		 SET ready_boot_id = $2,
		     agent_phase = CASE WHEN $4 THEN 'pool_ready' ELSE agent_phase END,
		     state = CASE WHEN $3 THEN 'warm' ELSE state END,
		     warm_at = CASE WHEN $3 THEN now() ELSE warm_at END,
		     state_changed_at = CASE WHEN $3 THEN now() ELSE state_changed_at END,
		     version = version + 1
		 WHERE id = $1`,
		[m.id, bootId, toWarm, o.phase],
	);
	m.ready_boot_id = bootId;
	if (o.phase) m.agent_phase = "pool_ready";
	if (toWarm) m.state = "warm";
}

/**
 * §10.2 `quiesce.watchdog_thawed`: an alarm metric, and a snapshot of this
 * machine in `creating` is marked `quiesce_broken`. The operation is not
 * touched: its snapshot step checks the flag after the thaw (§7.7).
 */
async function onQuiesceWatchdogThawed(
	s: EventScope,
	_e: Extract<AgentEvent, { kind: "quiesce_watchdog_thawed" }>,
	row: AgentRow,
): Promise<void> {
	const r = await s.tx.client.query<{ id: string }>(
		`UPDATE runtime.snapshots SET quiesce_broken = true, version = version + 1
		 WHERE source_machine_id = $1 AND state = 'creating'
		 RETURNING id`,
		[s.machine.id],
	);
	s.ctx.metrics.inc("sbx_quiesce_watchdog_thawed_total");
	s.ctx.log.warn(
		{
			machineId: s.machine.id,
			bootId: row.boot_id,
			snapshots: r.rows.map((x) => x.id),
		},
		"the agent's quiesce watchdog thawed the guest",
	);
}

/** §10.2 `agent_restarted`: log only; commands survive an agent restart (S2). */
async function onAgentRestarted(s: EventScope, e: SyntheticRow): Promise<void> {
	s.ctx.log.info(
		{ machineId: s.machine.id, epoch: e.epoch, instanceId: e.instance_id },
		"agent restarted",
	);
}

/**
 * §10.2 `rebooted`: `last_reboot_at`; commands of an earlier boot are `lost`;
 * a `ready` sandbox whose new boot (from tunnel_sessions) is not provisioned
 * gets a `reprovision`.
 */
async function onRebooted(s: EventScope, e: SyntheticRow): Promise<void> {
	const m = s.machine;
	const bootId = await sessionBoot(s);
	if (bootId !== null) {
		const lost = await s.tx.client.query(
			// The boot id changed, so the guest rebooted: `reboot`, as the agent
			// reports commands of an earlier boot (S3).
			`UPDATE runtime.commands SET status = 'lost', reason = 'reboot', ended_at = now()
			 WHERE machine_id = $1 AND status IN ('starting', 'running')
			   AND boot_id IS DISTINCT FROM $2`,
			[m.id, bootId],
		);
		if ((lost.rowCount ?? 0) > 0) {
			s.ctx.log.info(
				{ machineId: m.id, commands: lost.rowCount },
				"commands of the previous boot lost",
			);
		}
	}
	const sb = await currentSandbox(s);
	if (sb === null) return;
	await s.tx.client.query(
		`UPDATE runtime.sandboxes
		 SET last_reboot_at = GREATEST(COALESCE(last_reboot_at, $2), $2),
		     last_reboot_reason = 'guest_reboot', version = version + 1
		 WHERE id = $1`,
		[sb.id, e.time],
	);
	if (bootId !== null) await maybeReprovision(s, sb, bootId, "rebooted");
}

/**
 * §10.2 `identity_changed`: expected only on the first boot of a machine made
 * from a snapshot (fork target, create from a saved snapshot), i.e. before it
 * was ever provisioned. Anything else is an alarm.
 */
async function onIdentityChanged(
	s: EventScope,
	e: SyntheticRow,
): Promise<void> {
	const m = s.machine;
	const expected = m.origin === "snapshot" && m.provisioned_boot_id === null;
	if (expected) {
		s.ctx.log.info({ machineId: m.id }, "identity changed (expected)");
		return;
	}
	s.ctx.metrics.inc("sbx_unexpected_identity_change_total");
	s.ctx.log.warn(
		{ machineId: m.id, epoch: e.epoch, origin: m.origin },
		"unexpected identity change",
	);
}

/**
 * Reprovision (§7.8): only for a `ready` sandbox with no active operation
 * (its provision step covers it) and a boot that is not provisioned yet. The
 * sandbox row is already locked (withMachineLocked); the unique index on
 * active operations is the last guard (a conflict is a skip).
 */
async function maybeReprovision(
	s: EventScope,
	sb: CurrentSandbox,
	bootId: string,
	cause: string,
): Promise<void> {
	if (sb.state !== "ready") return;
	if (bootId === s.machine.provisioned_boot_id) return;
	const active = await s.tx.client.query(
		`SELECT 1 FROM runtime.operations
		 WHERE sandbox_id = $1 AND state IN ('pending', 'running')`,
		[sb.id],
	);
	if ((active.rowCount ?? 0) > 0) return;
	const os = await s.tx.client.query<{ os: "linux" | "windows" }>(
		"SELECT os FROM runtime.template_builds WHERE id = $1",
		[sb.template_build_id],
	);
	await s.tx.client.query("SAVEPOINT reprovision");
	let operationId: string;
	try {
		operationId = await insertOperation(s.tx, {
			sandboxId: sb.id,
			kind: "reprovision",
			request: { cause, bootId },
			principal: null,
			deadlineMs: operationDeadline("reprovision", os.rows[0]?.os ?? "linux"),
		});
	} catch (err) {
		if ((err as { code?: string }).code !== "23505") throw err;
		await s.tx.client.query("ROLLBACK TO SAVEPOINT reprovision");
		return;
	}
	await s.tx.client.query("RELEASE SAVEPOINT reprovision");
	await s.ctx.jobs.send(
		s.tx,
		"sandbox-op",
		{ operationId },
		{ singletonKey: sb.id },
	);
	s.ctx.log.info(
		{ sandboxId: sb.id, machineId: s.machine.id, operationId, cause },
		"reprovision enqueued",
	);
}

/**
 * Applies `write` to a command of this machine; a command of another or no
 * machine, or a malformed value (an SbxError), is logged and skipped.
 */
async function writeCommand(
	s: EventScope,
	commandId: string,
	write: () => Promise<void>,
): Promise<void> {
	const r = await s.tx.client.query<{ machine_id: string }>(
		"SELECT machine_id FROM runtime.commands WHERE id = $1",
		[commandId],
	);
	const owner = r.rows[0]?.machine_id;
	if (owner !== s.machine.id) {
		s.ctx.log.warn(
			{ machineId: s.machine.id, commandId, known: owner !== undefined },
			"command event for a command of another or no machine ignored",
		);
		return;
	}
	try {
		await write();
	} catch (err) {
		// A malformed result must not block the machine's event queue.
		if (!(err instanceof SbxError)) throw err;
		s.ctx.log.warn(
			{ machineId: s.machine.id, commandId, code: err.code },
			"command event rejected",
		);
	}
}

/** Terminal status of a command of this machine, unless it is terminal already. */
function finishCommand(
	s: EventScope,
	commandId: string,
	result: Parameters<typeof completeCommand>[2],
): Promise<void> {
	return writeCommand(s, commandId, () =>
		completeCommand(s.tx.client, commandId, result),
	);
}

/** §10.2 `command.exited`. */
async function onCommandExited(
	s: EventScope,
	e: Extract<AgentEvent, { kind: "command_exited" }>,
	row: AgentRow,
): Promise<void> {
	await finishCommand(s, e.commandId, {
		status: e.status,
		exitCode: e.exitCode,
		signal: e.signal,
		reason: e.reason,
		outputTruncated: e.outputTruncated,
		stdoutBytes: e.stdoutBytes,
		stderrBytes: e.stderrBytes,
		endedAt: row.time,
	});
}

/** §10.2 `pty.closed`: a PTY command ends as `exited` (no exit code). */
async function onPtyClosed(
	s: EventScope,
	e: Extract<AgentEvent, { kind: "pty_closed" }>,
	row: AgentRow,
): Promise<void> {
	await finishCommand(s, e.commandId, {
		status: "exited",
		reason: e.reason,
		endedAt: row.time,
	});
}

/** S3 `output.truncated`: on a running or ended command; the first reason stays. */
async function onOutputTruncated(
	s: EventScope,
	e: Extract<AgentEvent, { kind: "output_truncated" }>,
): Promise<void> {
	await writeCommand(s, e.commandId, () =>
		markOutputTruncated(s.tx.client, e.commandId, e.reason),
	);
}

/**
 * §10.2 / §12 `activity`: counters, `busy | idle`, `last_activity_at` and
 * `activity_zero_since` (when the counters became all zero; null while any is
 * non-zero). Freshness uses LEAST(event time, received_at): a guest clock
 * ahead cannot make an old event look fresh. The zero mark uses received_at,
 * never earlier than the event itself, so a guest clock behind cannot bring
 * an idle-stop forward either.
 */
async function onActivity(
	s: EventScope,
	e: Extract<AgentEvent, { kind: "activity" }>,
	row: AgentRow,
): Promise<void> {
	const sb = await currentSandbox(s);
	if (sb === null) return;
	const counters = {
		runningCommands: e.runningCommands,
		openPtys: e.openPtys,
		tcpStreams: e.tcpStreams,
	};
	const idle = isZero(e);
	await s.tx.client.query(
		`UPDATE runtime.sandboxes
		 SET activity_counters = $2, activity = $3,
		     last_activity_at = LEAST($4::timestamptz, $5::timestamptz),
		     activity_zero_since = CASE WHEN $6
		       THEN COALESCE(activity_zero_since, $5::timestamptz) ELSE NULL END
		 WHERE id = $1`,
		[
			sb.id,
			JSON.stringify(counters),
			idle ? "idle" : "busy",
			row.time,
			row.received_at,
			idle,
		],
	);
}

/** §10.2 `ports.changed`: stored for S7 `/ports`. */
async function onPortsChanged(
	s: EventScope,
	e: Extract<AgentEvent, { kind: "ports_changed" }>,
): Promise<void> {
	const sb = await currentSandbox(s);
	if (sb === null) return;
	await s.tx.client.query(
		"UPDATE runtime.sandboxes SET listening_ports = $2 WHERE id = $1",
		[sb.id, JSON.stringify(e.listening)],
	);
}
