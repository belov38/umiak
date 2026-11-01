// Fixtures of the events handler and the controllers: a `ready` sandbox with
// its current machine, tunnel sessions, gateway instances and direct
// timestamp edits (no sleeping).
import { randomUUID } from "node:crypto";
import { ingestAgentEvents, type SyntheticEventType } from "@umiak/core";
import { handleMachineEvents } from "../../src/handlers/machine-events.ts";
import {
	insertMachine,
	insertSandbox,
	type TestWorld,
} from "../fakes/world.ts";

export interface Linked {
	sandboxId: string;
	machineId: string;
}

/** A sandbox (default `ready`) whose current machine is a `running` machine. */
export async function linkedSandbox(
	w: TestWorld,
	o: {
		state?: string;
		machineState?: string;
		origin?: "template" | "snapshot";
		provisionedBootId?: string | null;
		vmid?: number | null;
	} = {},
): Promise<Linked> {
	const sandboxId = await insertSandbox(w, { state: o.state ?? "ready" });
	const machineId = await insertMachine(w, {
		state: o.machineState ?? "running",
		poolKey: null,
		sandboxId,
		...(o.origin !== undefined ? { origin: o.origin } : {}),
		...(o.vmid !== undefined ? { vmid: o.vmid } : {}),
	});
	await w.pool.query(
		`UPDATE runtime.sandboxes SET machine_id = $2, ready_at = now() WHERE id = $1`,
		[sandboxId, machineId],
	);
	if (o.provisionedBootId !== undefined) {
		await w.pool.query(
			"UPDATE runtime.machines SET provisioned_boot_id = $2 WHERE id = $1",
			[machineId, o.provisionedBootId],
		);
	}
	return { sandboxId, machineId };
}

/** Upserts the machine's tunnel session. */
export async function setSession(
	w: TestWorld,
	machineId: string,
	o: {
		bootId?: string;
		state?: "connected" | "disconnected";
		/** disconnected_at = now() - this. */
		disconnectedAgoS?: number;
		instanceId?: string;
	} = {},
): Promise<string> {
	const bootId = o.bootId ?? randomUUID();
	const state = o.state ?? "connected";
	await w.pool.query(
		`INSERT INTO tunnel.tunnel_sessions
		   (machine_id, instance_id, epoch, conn_id, agent_instance_id, boot_id, vmgenid,
		    agent_version, proto_version, capabilities, state, connected_at, disconnected_at)
		 VALUES ($1, $2, 1, 'c', 'a', $3, 'g', '0', '1', '{}', $4, now(),
		         CASE WHEN $4 = 'disconnected' THEN now() - make_interval(secs => $5) END)
		 ON CONFLICT (machine_id) DO UPDATE
		 SET instance_id = EXCLUDED.instance_id, epoch = tunnel.tunnel_sessions.epoch + 1,
		     boot_id = EXCLUDED.boot_id, state = EXCLUDED.state,
		     disconnected_at = EXCLUDED.disconnected_at`,
		[
			machineId,
			o.instanceId ?? "gw-fake",
			bootId,
			state,
			o.disconnectedAgoS ?? 0,
		],
	);
	return bootId;
}

/** A gateway instance with heartbeat `agoS` seconds ago. */
export async function setGateway(
	w: TestWorld,
	id: string,
	agoS: number,
): Promise<void> {
	await w.pool.query(
		`INSERT INTO tunnel.gateway_instances (id, internal_url, state, started_at, heartbeat_at)
		 VALUES ($1, 'http://gw', 'active', now(), now() - make_interval(secs => $2))
		 ON CONFLICT (id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
		[id, agoS],
	);
}

/** `UPDATE runtime.<table> SET <set> WHERE id = $1` (timestamps in the past). */
export async function setRow(
	w: TestWorld,
	table: string,
	id: string,
	set: string,
): Promise<void> {
	await w.pool.query(`UPDATE runtime.${table} SET ${set} WHERE id = $1`, [id]);
}

let epoch = 1000;

/** Ingests synthetic events and runs the handler. */
export async function synthetic(
	w: TestWorld,
	machineId: string,
	...types: SyntheticEventType[]
): Promise<void> {
	epoch += 1;
	await ingestAgentEvents(w.pool, w.jobs, {
		machineId,
		events: [],
		synthetic: types.map((type) => ({
			epoch,
			type,
			instanceId: "gw-fake",
			time: new Date(),
		})),
	});
	await handleMachineEvents(w.ctx, { machineId });
}

export interface AgentEv {
	seq: number;
	bootId: string;
	type: string;
	time: Date;
	payload: unknown;
}

export function ev(
	seq: number,
	bootId: string,
	type: string,
	payload: unknown,
	time: Date = new Date(),
): AgentEv {
	return { seq, bootId, type, time, payload };
}

/** Ingests agent events and runs the handler. */
export async function agentEvents(
	w: TestWorld,
	machineId: string,
	events: AgentEv[],
): Promise<void> {
	await ingestAgentEvents(w.pool, w.jobs, { machineId, events, synthetic: [] });
	await handleMachineEvents(w.ctx, { machineId });
}

/** A command row of the machine. */
export async function insertCommand(
	w: TestWorld,
	l: Linked,
	o: { bootId?: string | null; status?: string; mode?: string } = {},
): Promise<string> {
	const id = `cmd${randomUUID().replaceAll("-", "").slice(0, 20)}`;
	await w.pool.query(
		`INSERT INTO runtime.commands (id, sandbox_id, machine_id, cmd, mode, status, boot_id)
		 VALUES ($1, $2, $3, 'sleep 1', $4, $5, $6)`,
		[
			id,
			l.sandboxId,
			l.machineId,
			o.mode ?? "detached",
			o.status ?? "running",
			o.bootId ?? null,
		],
	);
	return id;
}

export async function commandStatus(w: TestWorld, id: string): Promise<string> {
	const r = await w.pool.query<{ status: string }>(
		"SELECT status FROM runtime.commands WHERE id = $1",
		[id],
	);
	return r.rows[0]?.status ?? "missing";
}

/** Status, exit reason and output_truncated of a command row. */
export async function commandOutcome(
	w: TestWorld,
	id: string,
): Promise<{
	status: string;
	reason: string | null;
	output_truncated: string | null;
}> {
	const r = await w.pool.query(
		"SELECT status, reason, output_truncated FROM runtime.commands WHERE id = $1",
		[id],
	);
	return r.rows[0];
}

export async function activeOps(
	w: TestWorld,
	sandboxId: string,
): Promise<{ id: string; kind: string; request: unknown }[]> {
	const r = await w.pool.query(
		`SELECT id, kind, request FROM runtime.operations
		 WHERE sandbox_id = $1 AND state IN ('pending', 'running')`,
		[sandboxId],
	);
	return r.rows;
}

export async function eventTypes(
	w: TestWorld,
	sandboxId: string,
): Promise<{ type: string; reason: string | null }[]> {
	const r = await w.pool.query(
		`SELECT type, reason FROM runtime.sandbox_events WHERE sandbox_id = $1
		 ORDER BY created_at, id`,
		[sandboxId],
	);
	return r.rows;
}
