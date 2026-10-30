// End to end through real pg-boss: two worker instances on one database with
// fake infrastructure and agent. The API side is core's SandboxServiceImpl
// with PgBossJobSender, as in production.
import { randomUUID } from "node:crypto";
import {
	DELETE_RETRY_LIMIT,
	type JobSender,
	PgBossJobSender,
	type Principal,
	SandboxServiceImpl,
	SCOPES,
} from "@sbx/core";
import { createPool } from "@sbx/db";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import type pg from "pg";
import type { Db as BossDb } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ControllerSpec } from "../src/controllers/index.ts";
import { startWorker, type Worker } from "../src/worker.ts";
import { blockAfter } from "./fakes/crash.ts";
import { FakeInfra, FakeInfraRegistry } from "./fakes/infra.ts";
import {
	createTopology,
	FakeAgentWorld,
	type Topology,
} from "./fakes/world.ts";
import {
	testConfig,
	testKeys,
	testLogger,
	until,
	workerOptions,
} from "./helpers/worker.ts";

let db: TestDatabase;
let topo: Topology;
let infra: FakeInfra;
let registry: FakeInfraRegistry;
let agentWorld: FakeAgentWorld;
let apiJobs: JobSender | undefined;
const config = testConfig("e2e");
const keys = testKeys();
const pools: pg.Pool[] = [];
const workers: Worker[] = [];

// Jobs of the fake agent world (machine-events) go through the same pg-boss.
const lazyJobs: JobSender = {
	send: (tx, queue, data, opts) => {
		if (!apiJobs) throw new Error("no worker started yet");
		return apiJobs.send(tx, queue, data, opts);
	},
};

function principal(): Principal {
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

/** A worker "pod": its own pg.Pool, shared fakes. */
async function pod(
	o: Partial<Parameters<typeof workerOptions>[1]> = {},
): Promise<Worker> {
	const pool = createPool(db.url, 20);
	pools.push(pool);
	const w = await startWorker(
		workerOptions(pool, {
			infra: registry,
			config,
			keys,
			controllers: [],
			...o,
		}),
	);
	workers.push(w);
	apiJobs ??= new PgBossJobSender(w.boss);
	return w;
}

async function stopAll(): Promise<void> {
	for (const w of workers.splice(0)) await w.stop({ graceful: false });
	apiJobs = undefined;
}

function service(): SandboxServiceImpl {
	if (!apiJobs) throw new Error("no worker started yet");
	return new SandboxServiceImpl({
		pool: db.pool,
		config,
		keys,
		jobs: apiJobs,
	});
}

async function states(ids: string[]): Promise<string[]> {
	const r = await db.pool.query<{ state: string }>(
		"SELECT state FROM runtime.sandboxes WHERE id = ANY($1::uuid[]) ORDER BY id",
		[ids],
	);
	return r.rows.map((x) => x.state);
}

async function allIn(ids: string[], state: string): Promise<boolean> {
	const s = await states(ids);
	return s.length === ids.length && s.every((x) => x === state);
}

async function opRow(id: string): Promise<Record<string, unknown>> {
	const r = await db.pool.query(
		"SELECT * FROM runtime.operations WHERE id = $1",
		[id],
	);
	return r.rows[0];
}

async function machineLeases(): Promise<number> {
	const r = await db.pool.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM runtime.vmid_leases
		 WHERE provider_id = $1 AND purpose = 'machine'`,
		[topo.providerId],
	);
	return r.rows[0]?.n ?? 0;
}

async function jobsOf(
	queue: string,
	field: string,
	value: string,
): Promise<
	{ id: string; state: string; start_after: Date; retry_limit: number }[]
> {
	const r = await db.pool.query(
		`SELECT id, state, start_after, retry_limit FROM pgboss.job
		 WHERE name = $1 AND data->>$2 = $3 ORDER BY created_on`,
		[queue, field, value],
	);
	return r.rows;
}

beforeAll(async () => {
	db = await createTestDatabase({ max: 20 });
	topo = await createTopology(db.pool, {
		ramCapMb: 64 * 1024,
		cloneConcurrency: 4,
		bootTimeoutS: 60,
	});
	await db.pool.query(
		"UPDATE runtime.template_builds SET template_slug = 'e2e' WHERE id = $1",
		[topo.templateBuildId],
	);
	agentWorld = new FakeAgentWorld({
		pool: db.pool,
		jobs: lazyJobs,
		processEvents: false,
	});
	infra = new FakeInfra({
		pool: db.pool,
		providerId: topo.providerId,
		clusterMacId: topo.clusterMacId,
		lifecycle: agentWorld,
	});
	registry = new FakeInfraRegistry();
	registry.set(topo.nodeId, infra);
});

afterEach(async () => {
	await stopAll();
	registry.set(topo.nodeId, infra);
});

afterAll(async () => {
	await stopAll();
	await agentWorld?.settled();
	for (const p of pools.splice(0)) await p.end();
	await db?.drop();
});

describe("worker over pg-boss", () => {
	it("two instances: 10 cold creates reach ready, 10 deletes reach deleted, nothing left over; a duplicate job is harmless", async () => {
		await pod();
		await pod();
		const svc = service();
		const p = principal();
		const created: { sandboxId: string; operationId: string }[] = [];
		for (let i = 0; i < 10; i++) {
			const r = await svc.create(p, { template: "e2e" });
			created.push({ sandboxId: r.sandbox.id, operationId: r.operation.id });
		}
		// Duplicate delivery of a create in flight: the singleton key keeps it
		// from running beside the first; when it runs the operation is done.
		const dup = created[0];
		if (!dup) throw new Error("no sandbox");
		await workers[0]?.boss.send(
			"sandbox-op",
			{ operationId: dup.operationId },
			{ singletonKey: dup.sandboxId },
		);
		const ids = created.map((c) => c.sandboxId);
		await until(() => allIn(ids, "ready"), {
			timeoutMs: 60_000,
			what: "10 sandboxes ready",
		});
		for (const c of created) {
			expect(await opRow(c.operationId)).toMatchObject({
				state: "succeeded",
			});
		}
		// Every job of the duplicated operation finished; one VM for its machine.
		await until(
			async () =>
				(await jobsOf("sandbox-op", "operationId", dup.operationId)).every(
					(j) => j.state === "completed",
				),
			{ what: "duplicate job completed" },
		);
		expect(
			(await jobsOf("sandbox-op", "operationId", dup.operationId)).length,
		).toBe(2);
		const dupMachine = await db.pool.query(
			"SELECT machine_id FROM runtime.sandboxes WHERE id = $1",
			[dup.sandboxId],
		);
		expect(infra.vmsOf(dupMachine.rows[0].machine_id)).toHaveLength(1);
		expect(infra.vms.size).toBe(10);
		expect(infra.callsOf("create")).toHaveLength(10);

		const deletes: string[] = [];
		for (const id of ids) deletes.push((await svc.delete(p, id)).id);
		await until(() => allIn(ids, "deleted"), {
			timeoutMs: 60_000,
			what: "10 sandboxes deleted",
		});
		for (const id of deletes) {
			expect(await opRow(id)).toMatchObject({ state: "succeeded" });
		}
		await agentWorld.settled();
		expect(infra.vms.size).toBe(0);
		expect(await machineLeases()).toBe(0);
		const live = await db.pool.query(
			`SELECT count(*)::int AS n FROM runtime.machines
			 WHERE provider_id = $1 AND state <> 'deleted'`,
			[topo.providerId],
		);
		expect(live.rows[0].n).toBe(0);
	}, 120_000);

	it("an instance dies mid-operation: the other finishes it after the heartbeat expires", async () => {
		// pg-boss requires heartbeatSeconds >= 10; the queue default (30) is
		// lowered for this test only. The job copies it at send time.
		let dead = false;
		const victimLog = testLogger("info");
		const victimPool = createPool(db.url, 20);
		pools.push(victimPool);
		// The victim's pg-boss loses the database (as a dead pod would): no
		// more heartbeats, no completion, no failWip. Its handler keeps the
		// pool (a zombie executor that can still write is what fencing is for).
		const severable: BossDb = {
			executeSql: (text, values) =>
				dead
					? Promise.reject(new Error("connection lost (simulated pod death)"))
					: victimPool.query(text, values as unknown[]),
		};
		const victim = await pod({
			pool: victimPool,
			bossDb: severable,
			log: victimLog.log,
		});
		await victim.boss.updateQueue("sandbox-op", { heartbeatSeconds: 10 });

		const blocked = blockAfter(infra, "create");
		registry.set(topo.nodeId, blocked.port);
		const svc = service();
		const { sandbox, operation } = await svc.create(principal(), {
			template: "e2e",
		});
		await blocked.reached;
		dead = true;

		const survivor = await pod();
		// The API side and the fake agent world send through the survivor now.
		apiJobs = new PgBossJobSender(survivor.boss);
		await until(() => allIn([sandbox.id], "ready"), {
			timeoutMs: 60_000,
			what: "sandbox ready after takeover",
		});
		const op = await opRow(operation.id);
		expect(op.state).toBe("succeeded");
		expect(op.attempt).toBeGreaterThanOrEqual(2);
		const jobs = await jobsOf("sandbox-op", "operationId", operation.id);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.state).toBe("completed");

		// The zombie wakes up: its next write is fenced out, nothing changes.
		blocked.release();
		await until(() => victimLog.captured.text().includes("fenced out"), {
			what: "zombie fenced out",
		});
		const s = await db.pool.query(
			"SELECT state, machine_id FROM runtime.sandboxes WHERE id = $1",
			[sandbox.id],
		);
		expect(s.rows[0].state).toBe("ready");
		const vms = infra.vmsOf(s.rows[0].machine_id);
		expect(vms).toHaveLength(1);
		expect(vms[0]?.status).toBe("running");

		await service()
			.delete(principal(), sandbox.id)
			.catch(() => undefined);
	}, 90_000);

	it("snapshot-op: a snapshot in use is re-sent 30 s later and the current job completes", async () => {
		await pod();
		const snapshotId = randomUUID();
		const lvId = snapshotId.replaceAll("-", "");
		await db.pool.query(
			`INSERT INTO runtime.snapshots
			   (id, kind, team_id, provider_id, node_id, storage_id, template_build_id, lv_id, hw,
			    consistency, state)
			 VALUES ($1, 'fork_source', $2, $3, $4, $5, $6, $7, '{}', 'powered_off', 'deleting')`,
			[
				snapshotId,
				randomUUID(),
				topo.providerId,
				topo.nodeId,
				topo.storageId,
				topo.templateBuildId,
				lvId,
			],
		);
		const lv = infra.addSnapshotLvs(lvId);
		await db.pool.query(
			`INSERT INTO runtime.disks (snapshot_id, storage_id, slot, volume, size_bytes)
			 VALUES ($1, $2, 'scsi0', $3, 8589934592)`,
			[snapshotId, topo.storageId, `local-lvm:${lv}`],
		);
		// A machine still cloning from it: the snapshot is in use (§7.8).
		const machineId = randomUUID();
		await db.pool.query(
			`INSERT INTO runtime.machines
			   (id, provider_id, node_id, storage_id, template_build_id, origin, origin_snapshot_id,
			    size_slug, vcpu, memory_mb, state)
			 VALUES ($1, $2, $3, $4, $5, 'snapshot', $6, '2gb', 2, 2048, 'allocating')`,
			[
				machineId,
				topo.providerId,
				topo.nodeId,
				topo.storageId,
				topo.templateBuildId,
				snapshotId,
			],
		);
		await workers[0]?.boss.send(
			"snapshot-op",
			{ snapshotId, action: "delete" },
			{ singletonKey: snapshotId, retryLimit: DELETE_RETRY_LIMIT },
		);
		const [first, again] = await until(
			async () => {
				const j = await jobsOf("snapshot-op", "snapshotId", snapshotId);
				return j.length === 2 && j[0]?.state === "completed" ? j : undefined;
			},
			{ what: "snapshot-op re-sent" },
		);
		expect(first?.state).toBe("completed");
		expect(again?.state).toBe("created");
		expect(again?.retry_limit).toBe(DELETE_RETRY_LIMIT);
		// pg-boss sets start_after on the database clock.
		const { rows } = await db.pool.query<{ t: Date }>(
			"SELECT clock_timestamp() AS t",
		);
		const now = (rows[0] as { t: Date }).t.getTime();
		const delayS = ((again?.start_after.getTime() ?? 0) - now) / 1000;
		expect(delayS).toBeGreaterThan(20);
		expect(delayS).toBeLessThanOrEqual(31);
		expect(infra.lvs.has(lv)).toBe(true);

		// Once the clone is gone the re-sent job deletes the snapshot.
		await db.pool.query(
			"UPDATE runtime.machines SET state = 'deleted' WHERE id = $1",
			[machineId],
		);
		await db.pool.query(
			"UPDATE pgboss.job SET start_after = now() WHERE id = $1",
			[again?.id],
		);
		await until(
			async () => {
				const r = await db.pool.query(
					"SELECT state FROM runtime.snapshots WHERE id = $1",
					[snapshotId],
				);
				return r.rows[0]?.state === "deleted";
			},
			{ what: "snapshot deleted" },
		);
		expect(infra.lvs.has(lv)).toBe(false);
	}, 60_000);

	it("a controller never runs on two instances at once; it reschedules itself and has a cron safety net", async () => {
		let active = 0;
		let maxActive = 0;
		let runs = 0;
		const ranOn = new Set<string>();
		const spec = (name: string): ControllerSpec => ({
			queue: "ctl-health",
			intervalMs: 50,
			run: async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				ranOn.add(name);
				await new Promise((r) => setTimeout(r, 150));
				runs += 1;
				active -= 1;
			},
		});
		const a = await pod({ controllers: [spec("a")] });
		await pod({ controllers: [spec("b")] });
		// Extra kicks are dropped by the exclusive policy.
		await a.boss.send("ctl-health", {});
		await a.boss.send("ctl-health", {});
		await until(() => runs >= 8, { timeoutMs: 30_000, what: "8 runs" });
		expect(maxActive).toBe(1);
		const live = await db.pool.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM pgboss.job
			 WHERE name = 'ctl-health' AND state IN ('created', 'retry', 'active')`,
		);
		expect(live.rows[0]?.n).toBeLessThanOrEqual(1);
		const schedules = await a.boss.getSchedules("ctl-health");
		expect(schedules.map((s) => s.cron)).toEqual(["* * * * *"]);
		expect(ranOn.size).toBeGreaterThanOrEqual(1);
	}, 60_000);
});
