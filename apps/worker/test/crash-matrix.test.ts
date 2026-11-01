// Crash matrix (Tasks 10a, 10b): for create (cold and from a snapshot),
// delete, stop, resume, recover, fork (source side), the fork target's create
// and save_snapshot, a crash right after the side-effecting port call
// of every step (the effect happened, the step was not recorded), then the job
// is redelivered. The end state must equal the end state without a crash, and
// the fake must hold no extra VMs, LVs or leases.
//
// Steps without a port call (create boot/finish, stop verify/finish, resume
// wait_agent/finish, delete retire/ports/secrets/finish, the fork hand-off,
// the save's name move) are repeated by the same redelivery: the crash of the
// previous step leaves them unrecorded too.
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSandboxOp } from "../src/handlers/sandbox-op.ts";
import { crashAfter, SimulatedCrash } from "./fakes/crash.ts";
import { createWorld, insertSnapshot, type TestWorld } from "./fakes/world.ts";
import {
	createSandbox,
	forkSandbox,
	infraState,
	machinesOf,
	type OpsEnv,
	opsEnv,
	readySandbox,
	restorePorts,
	row,
	run,
	runSnapshotJobs,
	sessionBoot,
	stoppedSandbox,
} from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

type OpName =
	| "create"
	| "create_from_snapshot"
	| "delete"
	| "stop"
	| "resume"
	| "recover"
	| "fork"
	| "fork_target"
	| "fork_target_gone"
	| "save_snapshot";

interface Started {
	sandboxId: string;
	operationId: string;
}

async function savedSnapshot(w: TestWorld, e: OpsEnv): Promise<void> {
	const { snapshotId } = await insertSnapshot(w);
	await w.pool.query(
		"UPDATE runtime.snapshots SET team_id = $2, name = 'base' WHERE id = $1",
		[snapshotId, e.p.teamId],
	);
}

/** Brings the world to the point where the operation is enqueued. */
const SETUP: Record<OpName, (w: TestWorld, e: OpsEnv) => Promise<Started>> = {
	create: (w, e) => createSandbox(w, e),
	create_from_snapshot: async (w, e) => {
		await savedSnapshot(w, e);
		return createSandbox(w, e, { from: { snapshot: "base" } });
	},
	delete: async (w, e) => {
		const { sandboxId } = await readySandbox(w, e);
		// A fork source this sandbox consumed: the snapshots step deletes it.
		const snap = await insertSnapshot(w, { kind: "fork_source" });
		await w.pool.query(
			"UPDATE runtime.snapshots SET consumer_sandbox_id = $2 WHERE id = $1",
			[snap.snapshotId, sandboxId],
		);
		await e.svc.hostPort(e.p, sandboxId, 8080, "public");
		const op = await e.svc.delete(e.p, sandboxId);
		return { sandboxId, operationId: op.id };
	},
	stop: async (w, e) => {
		const { sandboxId } = await readySandbox(w, e);
		const op = await e.svc.stop(e.p, sandboxId);
		return { sandboxId, operationId: op.id };
	},
	resume: async (w, e) => {
		const { sandboxId } = await stoppedSandbox(w, e);
		const op = await e.svc.resume(e.p, sandboxId, { size: "4gb" });
		return { sandboxId, operationId: op.id };
	},
	recover: async (w, e) => {
		const { sandboxId } = await readySandbox(w, e);
		const op = await e.svc.recover(e.p, sandboxId);
		return { sandboxId, operationId: op.id };
	},
	fork: async (w, e) => {
		const { sandboxId } = await readySandbox(w, e);
		const f = await forkSandbox(e, sandboxId);
		return { sandboxId, operationId: f.forkOpId };
	},
	fork_target: async (w, e) => {
		const { sandboxId } = await readySandbox(w, e);
		const f = await forkSandbox(e, sandboxId, { secrets: { EXTRA: "x" } });
		expect(await run(w, f.forkOpId)).toBe("succeeded");
		return { sandboxId: f.targetId, operationId: f.createOpId };
	},
	// The target was deleted before the hand-off: the fork deletes the snapshot.
	fork_target_gone: async (w, e) => {
		const { sandboxId } = await readySandbox(w, e);
		const f = await forkSandbox(e, sandboxId);
		const del = await e.svc.delete(e.p, f.targetId);
		expect(await run(w, del.id)).toBe("succeeded");
		return { sandboxId, operationId: f.forkOpId };
	},
	save_snapshot: async (w, e) => {
		const { sandboxId } = await readySandbox(w, e);
		const r = await e.svc.saveSnapshot(e.p, sandboxId, "base");
		return { sandboxId, operationId: r.operation.id };
	},
};

type Port = "infra" | "agent" | "gateway";

interface Case {
	op: OpName;
	step: string;
	port: Port;
	method: string;
	/** The crash is swallowed by a best-effort step: the first run already succeeds. */
	swallowed?: boolean;
	/** Extra setup before the crash wrapper (e.g. a shutdown that times out). */
	before?: (w: TestWorld) => void;
}

const CASES: Case[] = [
	{ op: "create", step: "provision", port: "infra", method: "create" },
	{ op: "create", step: "provision", port: "infra", method: "start" },
	{
		op: "create",
		step: "rotate_token",
		port: "gateway",
		method: "rotateToken",
	},
	{ op: "create", step: "claim", port: "agent", method: "claim" },
	{
		op: "create_from_snapshot",
		step: "provision",
		port: "infra",
		method: "fork",
	},
	{
		op: "create_from_snapshot",
		step: "provision",
		port: "infra",
		method: "start",
	},
	{ op: "create_from_snapshot", step: "claim", port: "agent", method: "claim" },
	{ op: "delete", step: "stop", port: "infra", method: "stop" },
	{ op: "delete", step: "destroy", port: "infra", method: "delete" },
	{ op: "delete", step: "snapshots", port: "infra", method: "deleteSnapshot" },
	{
		op: "stop",
		step: "prepare",
		port: "agent",
		method: "prepareStop",
		swallowed: true,
	},
	{ op: "stop", step: "shutdown", port: "infra", method: "shutdown" },
	{
		op: "stop",
		step: "shutdown (timeout → hard stop)",
		port: "infra",
		method: "stop",
		before: (w) => {
			w.infra.shutdown = async () => "timeout";
		},
	},
	{ op: "resume", step: "resize", port: "infra", method: "configure" },
	{ op: "resume", step: "start", port: "infra", method: "start" },
	{ op: "resume", step: "provision", port: "agent", method: "updateEnv" },
	{ op: "resume", step: "provision", port: "agent", method: "updateSecrets" },
	{ op: "recover", step: "reset", port: "infra", method: "stop" },
	{ op: "recover", step: "reset", port: "infra", method: "start" },
	{ op: "recover", step: "provision", port: "agent", method: "updateEnv" },
	{ op: "recover", step: "provision", port: "agent", method: "updateSecrets" },
	{ op: "fork", step: "snapshot", port: "infra", method: "snapshot" },
	{ op: "fork_target", step: "provision", port: "infra", method: "fork" },
	{ op: "fork_target", step: "provision", port: "infra", method: "start" },
	{
		op: "fork_target",
		step: "rotate_token",
		port: "gateway",
		method: "rotateToken",
	},
	{ op: "fork_target", step: "claim", port: "agent", method: "claim" },
	{
		op: "fork_target_gone",
		step: "snapshot",
		port: "infra",
		method: "snapshot",
	},
	{
		op: "fork_target_gone",
		step: "finish (target gone)",
		port: "infra",
		method: "deleteSnapshot",
	},
	{ op: "save_snapshot", step: "snapshot", port: "infra", method: "snapshot" },
];

function wrap(w: TestWorld, port: Port, method: string): void {
	if (port === "infra") {
		w.useInfra(crashAfter(w.infra, method as keyof typeof w.infra));
	} else if (port === "agent") {
		w.ctx.agent = crashAfter(w.agent, method as keyof typeof w.agent);
	} else {
		w.ctx.gateway = crashAfter(w.gateway, method as keyof typeof w.gateway);
	}
}

/** End state without ids: comparable across worlds. */
async function summary(w: TestWorld, started: Started) {
	// Deletions handed to snapshot-op (fork target cleanup_source) run first.
	await runSnapshotJobs(w);
	const s = await row(w, "sandboxes", started.sandboxId);
	const op = await row(w, "operations", started.operationId);
	const machines = (await machinesOf(w, started.sandboxId))
		.map((m) => m.state)
		.sort();
	const infra = await infraState(w);
	const snaps = await w.pool.query<{ d: string }>(
		`SELECT kind || ':' || state || ':' || coalesce(consistency, '-') || ':' ||
		        coalesce(name, '-') AS d
		 FROM runtime.snapshots WHERE provider_id = $1`,
		[w.topo.providerId],
	);
	const current = s.machine_id as string;
	const m = await row(w, "machines", current);
	return {
		sandbox: s.state,
		errorCode: s.error_code,
		operation: op.state,
		machines,
		power: m.power_observed,
		provisionedOnCurrentBoot:
			m.state === "running"
				? m.provisioned_boot_id === (await sessionBoot(w, current))
				: null,
		vms: [...w.infra.vms.values()]
			.map((v) => `${v.status}:${v.vcpu}x${v.memoryMb}`)
			.sort(),
		vmsOfMachine: w.infra.vmsOf(current).length,
		lvs: infra.lvs.length,
		leases: infra.leases,
		snapshots: snaps.rows.map((x) => x.d).sort(),
		/** A fork hands its target over once: the target create has a deadline. */
		childDeadlines: await childDeadlines(w, started.operationId),
	};
}

async function childDeadlines(w: TestWorld, operationId: string) {
	const r = await w.pool.query<{ state: string; has_deadline: boolean }>(
		`SELECT state, deadline_at IS NOT NULL AS has_deadline
		 FROM runtime.operations WHERE parent_operation_id = $1`,
		[operationId],
	);
	return r.rows.map((x) => `${x.state}:${x.has_deadline}`);
}

async function baseline(op: OpName) {
	const w = await createWorld(db);
	const e = opsEnv(w);
	const started = await SETUP[op](w, e);
	expect(await run(w, started.operationId)).toBe("succeeded");
	return summary(w, started);
}

describe("crash matrix", () => {
	const baselines = new Map<OpName, Awaited<ReturnType<typeof baseline>>>();

	beforeAll(async () => {
		for (const op of Object.keys(SETUP) as OpName[]) {
			baselines.set(op, await baseline(op));
		}
	}, 120_000);

	it("baselines are the expected end states", () => {
		expect(baselines.get("create")).toMatchObject({
			sandbox: "ready",
			machines: ["running"],
			provisionedOnCurrentBoot: true,
			vms: ["running:2x2048"],
			lvs: 1,
			leases: 1,
		});
		expect(baselines.get("create_from_snapshot")).toMatchObject({
			sandbox: "ready",
			vms: ["running:2x2048"],
			lvs: 2,
			leases: 1,
		});
		expect(baselines.get("delete")).toMatchObject({
			sandbox: "deleted",
			machines: ["deleted"],
			vms: [],
			lvs: 0,
			leases: 0,
		});
		expect(baselines.get("stop")).toMatchObject({
			sandbox: "stopped",
			machines: ["stopped"],
			power: "stopped",
			vms: ["stopped:2x2048"],
		});
		expect(baselines.get("resume")).toMatchObject({
			sandbox: "ready",
			machines: ["running"],
			provisionedOnCurrentBoot: true,
			vms: ["running:2x4096"],
		});
		expect(baselines.get("recover")).toMatchObject({
			sandbox: "ready",
			provisionedOnCurrentBoot: true,
			vms: ["running:2x2048"],
		});
		expect(baselines.get("fork")).toMatchObject({
			sandbox: "ready",
			operation: "succeeded",
			vms: ["running:2x2048"],
			lvs: 2,
			leases: 1,
			snapshots: ["fork_source:ready:quiesced:-"],
			childDeadlines: ["pending:true"],
		});
		expect(baselines.get("fork_target")).toMatchObject({
			sandbox: "ready",
			operation: "succeeded",
			machines: ["running"],
			provisionedOnCurrentBoot: true,
			vms: ["running:2x2048", "running:2x2048"],
			lvs: 2,
			leases: 2,
			snapshots: ["fork_source:deleted:quiesced:-"],
		});
		expect(baselines.get("fork_target_gone")).toMatchObject({
			sandbox: "ready",
			operation: "succeeded",
			lvs: 1,
			leases: 1,
			snapshots: ["fork_source:deleted:quiesced:-"],
			childDeadlines: ["superseded:false"],
		});
		expect(baselines.get("save_snapshot")).toMatchObject({
			sandbox: "ready",
			operation: "succeeded",
			lvs: 2,
			leases: 1,
			snapshots: ["saved:ready:quiesced:base"],
		});
	});

	it.each(CASES)(
		"$op: crash after $method on $port ($step), redelivered → same end state",
		async (c) => {
			const w = await createWorld(db);
			const e = opsEnv(w);
			const started = await SETUP[c.op](w, e);
			c.before?.(w);
			wrap(w, c.port, c.method);

			if (c.swallowed) {
				expect(await run(w, started.operationId)).toBe("succeeded");
			} else {
				await expect(
					handleSandboxOp(w.ctx, { operationId: started.operationId }),
				).rejects.toBeInstanceOf(SimulatedCrash);
				restorePorts(w);
				await w.agentWorld.settled();
				const mid = await row(w, "operations", started.operationId);
				expect(mid.state).toBe("running");
				expect(await run(w, started.operationId)).toBe("succeeded");
			}

			expect(await summary(w, started)).toEqual(baselines.get(c.op));
		},
	);
});
