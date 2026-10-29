import {
	type AgentEvent,
	type AgentEventKind,
	insertSandboxEvent,
	normalizeAgentEvent,
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
// This task handles `connected` and agent `phase`; Task 11 adds the other
// kinds to the tables below. Events without a handler are marked processed.

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
};

const AGENT: { [K in AgentEventKind]?: AgentHandler<K> } = {
	phase: onPhase,
};

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
		`SELECT seq, boot_id, type, time, payload FROM runtime.agent_events
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
		return;
	}
	const toWarm =
		m.state === "booting" && m.pool_key !== null && m.sandbox_id === null;
	await s.tx.client.query(
		`UPDATE runtime.machines
		 SET ready_boot_id = $2, agent_phase = 'pool_ready',
		     state = CASE WHEN $3 THEN 'warm' ELSE state END,
		     warm_at = CASE WHEN $3 THEN now() ELSE warm_at END,
		     state_changed_at = CASE WHEN $3 THEN now() ELSE state_changed_at END,
		     version = version + 1
		 WHERE id = $1`,
		[m.id, row.boot_id, toWarm],
	);
	m.ready_boot_id = row.boot_id;
	m.agent_phase = "pool_ready";
	if (toWarm) m.state = "warm";
}
