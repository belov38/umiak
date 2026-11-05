// Sandbox-op fixtures: a SandboxServiceImpl over the test world (the API side
// creates sandbox, machine, secrets and operation rows as in production) and
// readers for the end state.
import { randomUUID } from "node:crypto";
import {
	type CreateInput,
	type ForkInput,
	type Principal,
	SandboxServiceImpl,
	SCOPES,
} from "@umiak/core";
import { expect } from "vitest";
import {
	handleSandboxOp,
	type SandboxOpResult,
} from "../../src/handlers/sandbox-op.ts";
import { handleSnapshotOp } from "../../src/handlers/snapshot-op.ts";
import { insertMachine, type TestWorld } from "../fakes/world.ts";
import { prepareFixture as handleMachineOp } from "./prepare.ts";

export function principal(): Principal {
	return {
		kind: "team_key",
		userId: null,
		teamId: randomUUID(),
		role: null,
		isOperator: false,
		apiKeyId: randomUUID(),
		scopes: [...SCOPES],
	};
}

export interface OpsEnv {
	svc: SandboxServiceImpl;
	p: Principal;
}

export function opsEnv(w: TestWorld): OpsEnv {
	return {
		svc: new SandboxServiceImpl({
			pool: w.pool,
			config: w.ctx.config,
			keys: w.ctx.keys,
			jobs: w.jobs,
		}),
		p: principal(),
	};
}

export const ENV = { APP_MODE: "test" };
export const SECRETS = { API_TOKEN: "s3cr3t-marker-value" };
export const SECRET_FILES = [
	{ name: "id_rsa", contentBase64: Buffer.from("key").toString("base64") },
];

export async function createSandbox(
	w: TestWorld,
	e: OpsEnv,
	input: CreateInput = {},
): Promise<{ sandboxId: string; operationId: string }> {
	const r = await e.svc.create(e.p, {
		template: w.topo.templateSlug,
		env: ENV,
		secrets: SECRETS,
		secretFiles: SECRET_FILES,
		...input,
	});
	return { sandboxId: r.sandbox.id, operationId: r.operation.id };
}

export async function run(
	w: TestWorld,
	operationId: string,
): Promise<SandboxOpResult> {
	const r = await handleSandboxOp(w.ctx, { operationId });
	await w.agentWorld.settled();
	return r;
}

/** A pool machine prepared by machine-op provision (`warm`, agent connected). */
export async function warmMachine(w: TestWorld): Promise<string> {
	const id = await insertMachine(w);
	expect(
		await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
	).toBe("done");
	await w.agentWorld.settled();
	expect((await row(w, "machines", id)).state).toBe("warm");
	return id;
}

/** A `ready` sandbox made by a cold create. */
export async function readySandbox(
	w: TestWorld,
	e: OpsEnv,
	input: CreateInput = {},
): Promise<{ sandboxId: string; machineId: string }> {
	const { sandboxId, operationId } = await createSandbox(w, e, input);
	expect(await run(w, operationId)).toBe("succeeded");
	const s = await row(w, "sandboxes", sandboxId);
	expect(s.state).toBe("ready");
	return { sandboxId, machineId: s.machine_id as string };
}

/** A `stopped` sandbox (cold create, then stop). */
export async function stoppedSandbox(
	w: TestWorld,
	e: OpsEnv,
): Promise<{ sandboxId: string; machineId: string }> {
	const r = await readySandbox(w, e);
	const op = await e.svc.stop(e.p, r.sandboxId);
	expect(await run(w, op.id)).toBe("succeeded");
	expect((await row(w, "sandboxes", r.sandboxId)).state).toBe("stopped");
	return r;
}

export async function row(
	w: TestWorld,
	table: "sandboxes" | "machines" | "operations" | "snapshots",
	id: string,
): Promise<Record<string, unknown>> {
	const r = await w.pool.query(`SELECT * FROM runtime.${table} WHERE id = $1`, [
		id,
	]);
	if (!r.rows[0]) throw new Error(`${table} ${id} not found`);
	return r.rows[0];
}

export async function machinesOf(
	w: TestWorld,
	sandboxId: string,
): Promise<{ id: string; state: string }[]> {
	const r = await w.pool.query<{ id: string; state: string }>(
		"SELECT id, state FROM runtime.machines WHERE sandbox_id = $1 ORDER BY created_at, id",
		[sandboxId],
	);
	return r.rows;
}

export async function sessionBoot(
	w: TestWorld,
	machineId: string,
): Promise<string | null> {
	const r = await w.pool.query<{ boot_id: string }>(
		"SELECT boot_id FROM tunnel.tunnel_sessions WHERE machine_id = $1",
		[machineId],
	);
	return r.rows[0]?.boot_id ?? null;
}

/** Sets the operation deadline to the past. */
export async function expireDeadline(
	w: TestWorld,
	operationId: string,
): Promise<void> {
	await w.pool.query(
		"UPDATE runtime.operations SET deadline_at = now() - interval '1 second' WHERE id = $1",
		[operationId],
	);
}

/**
 * The database clock in ms. Deadlines are `now()` there; the host clock of
 * the test may differ from the clock of a Postgres container.
 */
export async function dbNow(w: TestWorld): Promise<number> {
	const r = await w.pool.query<{ t: Date }>("SELECT clock_timestamp() AS t");
	return (r.rows[0] as { t: Date }).t.getTime();
}

/**
 * Polls the database until `cond` holds (a state reached by a handler
 * running in the background). The budget only bounds a hang; it leaves room
 * for a heavily loaded machine.
 */
export async function until(
	what: string,
	cond: () => Promise<boolean>,
	timeoutMs = 30_000,
): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!(await cond())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** Live infrastructure of the world: VMs, LVs, non-free leases. */
export async function infraState(w: TestWorld): Promise<{
	vms: number;
	lvs: string[];
	leases: number;
}> {
	const r = await w.pool.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM runtime.vmid_leases
		 WHERE provider_id = $1 AND purpose = 'machine'`,
		[w.topo.providerId],
	);
	return {
		vms: w.infra.vms.size,
		lvs: [...w.infra.lvs.keys()].sort(),
		leases: r.rows[0]?.n ?? 0,
	};
}

/** Restores the real ports after a crash wrapper. */
export function restorePorts(w: TestWorld): void {
	w.useInfra(w.infra);
	w.ctx.agent = w.agent;
	w.ctx.gateway = w.gateway;
}

export interface Forked {
	sourceId: string;
	targetId: string;
	/** The `fork` operation on the source. */
	forkOpId: string;
	/** The target's `create` (child of the fork). */
	createOpId: string;
}

export async function forkSandbox(
	e: OpsEnv,
	sourceId: string,
	input: ForkInput = {},
	idemKey?: string,
): Promise<Forked> {
	const r = await e.svc.fork(e.p, sourceId, input, idemKey);
	return {
		sourceId,
		targetId: r.sandbox.id,
		forkOpId: r.sourceOperation.id,
		createOpId: r.operation.id,
	};
}

/** `sandbox-op` jobs sent for an operation. */
export function sandboxOpJobs(w: TestWorld, operationId: string) {
	return w.jobs.sent.filter(
		(j) => j.queue === "sandbox-op" && j.data.operationId === operationId,
	);
}

/** The snapshot rows of a source sandbox or a fork target. */
export async function snapshotsOf(
	w: TestWorld,
	sandboxId: string,
): Promise<Record<string, unknown>[]> {
	const r = await w.pool.query(
		`SELECT * FROM runtime.snapshots
		 WHERE source_sandbox_id = $1 OR consumer_sandbox_id = $1
		 ORDER BY created_at, id`,
		[sandboxId],
	);
	return r.rows;
}

/** LVs of a snapshot in the fake (tag `umiak-snap-<lvId>`). */
export function snapshotLvs(w: TestWorld, lvId: string): string[] {
	return [...w.infra.lvs.values()]
		.filter((l) => l.tags.includes(`umiak-snap-${lvId}`))
		.map((l) => l.name);
}

/** Marks the machine's tunnel session disconnected (the agent is unreachable). */
export async function disconnectAgent(
	w: TestWorld,
	machineId: string,
): Promise<void> {
	await w.pool.query(
		`UPDATE tunnel.tunnel_sessions SET state = 'disconnected', disconnected_at = now()
		 WHERE machine_id = $1`,
		[machineId],
	);
}

/** Runs every `snapshot-op` job sent so far (idempotent: done or skipped). */
export async function runSnapshotJobs(w: TestWorld): Promise<void> {
	for (const j of w.jobs.sent.filter((x) => x.queue === "snapshot-op")) {
		await handleSnapshotOp(w.ctx, {
			snapshotId: j.data.snapshotId as string,
			action: "delete",
		});
	}
}
