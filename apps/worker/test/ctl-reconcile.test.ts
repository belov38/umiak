import { DELETE_RETRY_LIMIT } from "@sbx/core";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTROLLERS } from "../src/controllers/index.ts";
import {
	type ReconcileAction,
	runReconcile,
} from "../src/controllers/reconcile.ts";
import {
	createWorld,
	insertMachine,
	insertOperation,
	insertSandbox,
	insertSnapshot,
	type TestWorld,
} from "./fakes/world.ts";
import {
	activeOps,
	eventTypes,
	setRow,
	setSession,
} from "./helpers/controllers.ts";
import {
	opsEnv,
	readySandbox,
	row,
	run,
	stoppedSandbox,
} from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

function reconcile(w: TestWorld, dryRun = false): Promise<ReconcileAction[]> {
	return runReconcile(w.ctx, { dryRun, providerIds: [w.topo.providerId] });
}

/** Everything the controller has seen so far is older than the 10 min grace. */
async function backdateSeen(w: TestWorld): Promise<void> {
	await w.pool.query(
		`UPDATE runtime.reconcile_seen SET first_seen_at = now() - interval '11 minutes'
		 WHERE provider_id = $1`,
		[w.topo.providerId],
	);
}

/** Sees every object once, then makes them all older than the grace. */
async function seenLongAgo(w: TestWorld): Promise<void> {
	await reconcile(w, true);
	await backdateSeen(w);
}

function kinds(actions: ReconcileAction[]): string[][] {
	return actions.map((a) => [a.kind, a.target]).sort();
}

async function insertLease(
	w: TestWorld,
	vmid: number,
	state: string,
	machineId: string | null,
	agoS = 0,
): Promise<void> {
	await w.pool.query(
		`INSERT INTO runtime.vmid_leases (provider_id, vmid, mac, state, purpose, machine_id, updated_at)
		 VALUES ($1, $2, $3, $4, 'machine', $5, now() - make_interval(secs => $6))`,
		[
			w.topo.providerId,
			vmid,
			`02:aa:00:00:${(vmid >> 8).toString(16).padStart(2, "0")}:${(vmid & 255).toString(16).padStart(2, "0")}`,
			state,
			machineId,
			agoS,
		],
	);
}

describe("ctl-reconcile (§11.2, §11.3)", () => {
	it("a consistent world gives no actions", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		await readySandbox(w, e);
		await stoppedSandbox(w, e);
		await seenLongAgo(w);
		expect(await reconcile(w)).toEqual([]);
	});

	it("orphan VM: removed only after the grace", async () => {
		const w = await createWorld(db);
		w.infra.addVm({ vmid: 550 });
		const first = await reconcile(w);
		expect(kinds(first)).toEqual([]);
		expect(w.infra.vms.has(550)).toBe(true);

		await backdateSeen(w);
		const second = await reconcile(w);
		expect(kinds(second)).toEqual([["orphan_vm", "vm:550"]]);
		expect(second[0]?.applied).toBe(true);
		expect(w.infra.vms.has(550)).toBe(false);
		expect(w.infra.lvs.has("vm-550-disk-0")).toBe(false);
		expect(
			w.metrics.calls.some((c) => c.name === "sbx_reconcile_actions_total"),
		).toBe(true);
	});

	it("VMs outside pool sandbox, without the sbx tag, outside the range or the template are never touched; LVs without the sbx tag neither", async () => {
		const w = await createWorld(db);
		w.infra.addVm({ vmid: 551, pool: "other" });
		w.infra.addVm({ vmid: 552, tags: ["foo"] });
		w.infra.addVm({ vmid: 450 });
		w.infra.addVm({ vmid: 599 });
		w.infra.addLv("vm-560-disk-0", []);
		w.infra.addLv("sbx-snap-0123456789abcdef0123456789abcdef-scsi0", ["other"]);
		await seenLongAgo(w);
		expect(await reconcile(w)).toEqual([]);
		for (const vmid of [551, 552, 450, 599])
			expect(w.infra.vms.has(vmid)).toBe(true);
		expect(w.infra.lvs.has("vm-560-disk-0")).toBe(true);
		expect(w.infra.callsOf("delete")).toEqual([]);
		expect(w.infra.callsOf("removeLvs")).toEqual([]);
	});

	it("Task 9 residual: a VM of a stale create without a lease is removed; the machine's own VM stays", async () => {
		const w = await createWorld(db);
		const r = await readySandbox(w, opsEnv(w));
		const vmid = (await row(w, "machines", r.machineId)).vmid as number;
		// The stale S1 POST created a second VM for the same machine after its lease was freed.
		w.infra.addVm({ vmid: 570, machineId: r.machineId, status: "stopped" });
		await seenLongAgo(w);
		expect(kinds(await reconcile(w))).toEqual([["orphan_vm", "vm:570"]]);
		expect(w.infra.vms.has(570)).toBe(false);
		expect(w.infra.vms.has(vmid)).toBe(true);
		expect((await row(w, "sandboxes", r.sandboxId)).state).toBe("ready");
	});

	it("a VM whose lease belongs to a machine in preparation is not an orphan", async () => {
		const w = await createWorld(db);
		const m = await insertMachine(w, { state: "provisioning" });
		await insertLease(w, 571, "reserved", m);
		w.infra.addVm({ vmid: 571, machineId: m, status: "stopped" });
		await seenLongAgo(w);
		expect(await reconcile(w)).toEqual([]);
		expect(w.infra.vms.has(571)).toBe(true);
	});

	it("orphan LVs: vm-N disks without VM, machine or disk row; zombie sbx-snap LVs; a ready snapshot's LVs stay", async () => {
		const w = await createWorld(db);
		w.infra.addLv("vm-580-disk-0", ["sbx", "sbx-vm-580"]);
		const zombie = "0123456789abcdef0123456789abcdef";
		w.infra.addLv(`sbx-snap-${zombie}-scsi0`, ["sbx", `sbx-snap-${zombie}`]);
		const ready = await insertSnapshot(w, { state: "ready" });
		const deleted = await insertSnapshot(w, { state: "deleted" });
		const fresh = "fedcba9876543210fedcba9876543210";

		await seenLongAgo(w);
		w.infra.addLv(`sbx-snap-${fresh}-scsi0`, ["sbx", `sbx-snap-${fresh}`]);
		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual(
			[
				["orphan_lv", "lv:vm-580-disk-0"],
				["orphan_lv", `lv:sbx-snap-${zombie}-scsi0`],
				["orphan_lv", `lv:sbx-snap-${deleted.lvId}-scsi0`],
			].sort(),
		);
		expect(w.infra.lvs.has("vm-580-disk-0")).toBe(false);
		expect(w.infra.lvs.has(`sbx-snap-${zombie}-scsi0`)).toBe(false);
		expect(w.infra.lvs.has(`sbx-snap-${deleted.lvId}-scsi0`)).toBe(false);
		expect(w.infra.lvs.has(`sbx-snap-${ready.lvId}-scsi0`)).toBe(true);
		// Younger than the grace.
		expect(w.infra.lvs.has(`sbx-snap-${fresh}-scsi0`)).toBe(true);
	});

	it("a releasing lease is finished: S1 delete again, the lease is freed", async () => {
		const w = await createWorld(db);
		const m = await insertMachine(w, { state: "deleted" });
		await insertLease(w, 590, "releasing", m, 700);
		w.infra.addVm({ vmid: 590, machineId: m, status: "stopped" });
		await insertLease(w, 591, "releasing", m, 10);
		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([["lease_release", "lease:590"]]);
		expect(w.infra.callsOf("delete").map((c) => c.args[0])).toEqual([590]);
		expect(w.infra.vms.has(590)).toBe(false);
		const l = await w.pool.query(
			"SELECT vmid FROM runtime.vmid_leases WHERE provider_id = $1 ORDER BY vmid",
			[w.topo.providerId],
		);
		expect(l.rows.map((x) => x.vmid)).toEqual([591]);
	});

	it("machine running, VM stopped: first time a system resume, second time within the hour stopped unexpected_shutdown", async () => {
		const w = await createWorld(db);
		const r = await readySandbox(w, opsEnv(w));
		const vmid = (await row(w, "machines", r.machineId)).vmid as number;
		const vm = w.infra.vms.get(vmid);
		if (!vm) throw new Error("no VM");
		vm.status = "stopped";
		w.jobs.clear();

		expect(kinds(await reconcile(w))).toEqual([
			["unexpected_stop", `machine:${r.machineId}`],
		]);
		let m = await row(w, "machines", r.machineId);
		expect(m.state).toBe("stopped");
		expect(m.power_observed).toBe("stopped");
		expect((m.unexpected_stops as string[]).length).toBe(1);
		expect((await row(w, "sandboxes", r.sandboxId)).state).toBe("starting");
		const ops = await activeOps(w, r.sandboxId);
		expect(ops.map((o) => o.kind)).toEqual(["resume"]);
		const op = await row(w, "operations", ops[0]?.id as string);
		expect(op.requested_by).toBeNull();
		expect(w.jobs.sent.map((j) => [j.queue, j.data])).toEqual([
			["sandbox-op", { operationId: op.id }],
		]);

		// The system resume runs; the VM goes down again within the hour.
		expect(await run(w, op.id as string)).toBe("succeeded");
		expect((await row(w, "sandboxes", r.sandboxId)).state).toBe("ready");
		vm.status = "stopped";
		w.jobs.clear();
		expect(kinds(await reconcile(w))).toEqual([
			["unexpected_stop", `machine:${r.machineId}`],
		]);
		const s = await row(w, "sandboxes", r.sandboxId);
		expect(s.state).toBe("stopped");
		expect(s.stop_reason).toBe("unexpected_shutdown");
		m = await row(w, "machines", r.machineId);
		expect(m.state).toBe("stopped");
		expect((m.unexpected_stops as string[]).length).toBe(2);
		expect(await activeOps(w, r.sandboxId)).toEqual([]);
		expect(w.jobs.sent).toEqual([]);
		expect(
			(await eventTypes(w, r.sandboxId)).filter(
				(x) => x.reason === "unexpected_shutdown",
			).length,
		).toBe(2);

		// Once handled, the same stop is not counted again.
		expect(await reconcile(w)).toEqual([]);
	});

	it("machine running, VM stopped, but an operation is active: nothing", async () => {
		const w = await createWorld(db);
		const r = await readySandbox(w, opsEnv(w));
		const vmid = (await row(w, "machines", r.machineId)).vmid as number;
		const vm = w.infra.vms.get(vmid);
		if (vm) vm.status = "stopped";
		await insertOperation(w, {
			sandboxId: r.sandboxId,
			kind: "stop",
			state: "running",
		});
		expect(await reconcile(w)).toEqual([]);
		expect((await row(w, "machines", r.machineId)).state).toBe("running");
	});

	it("machine without VM: machine failed (lost), sandbox error machine_lost", async () => {
		const w = await createWorld(db);
		const r = await readySandbox(w, opsEnv(w));
		const vmid = (await row(w, "machines", r.machineId)).vmid as number;
		w.infra.vms.delete(vmid);
		expect(kinds(await reconcile(w))).toEqual([
			["machine_lost", `machine:${r.machineId}`],
		]);
		const m = await row(w, "machines", r.machineId);
		expect(m.state).toBe("failed");
		expect(m.error_code).toBe("lost");
		const s = await row(w, "sandboxes", r.sandboxId);
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("machine_lost");
		expect(await reconcile(w)).toEqual([]);
	});

	it("machine stopped, VM running: S1 shutdown, metric power_drift", async () => {
		const w = await createWorld(db);
		const r = await stoppedSandbox(w, opsEnv(w));
		const vmid = (await row(w, "machines", r.machineId)).vmid as number;
		const vm = w.infra.vms.get(vmid);
		if (!vm) throw new Error("no VM");
		vm.status = "running";
		const before = w.infra.callsOf("shutdown").length;
		expect(kinds(await reconcile(w))).toEqual([
			["power_drift", `machine:${r.machineId}`],
		]);
		expect(
			w.infra
				.callsOf("shutdown")
				.slice(before)
				.map((c) => c.args[0]),
		).toEqual([vmid]);
		expect(vm.status).toBe("stopped");
		expect(
			w.metrics.calls.find(
				(c) =>
					c.name === "sbx_reconcile_actions_total" &&
					c.labels.kind === "power_drift",
			),
		).toBeDefined();
	});

	it("machine deleted while its tunnel session is connected: retired_at again", async () => {
		const w = await createWorld(db);
		const m = await insertMachine(w, { state: "deleted", poolKey: null });
		await setRow(w, "machines", m, "deleted_at = now() - interval '2 minutes'");
		await w.pool.query(
			`INSERT INTO tunnel.tunnel_credentials (machine_id, bs_hash, retired_at)
			 VALUES ($1, '\\x00', now() - interval '2 minutes')`,
			[m],
		);
		await setSession(w, m, { state: "connected" });
		expect(kinds(await reconcile(w))).toEqual([
			["retire_again", `machine:${m}`],
		]);
		const c = await w.pool.query<{ fresh: boolean }>(
			`SELECT retired_at > now() - interval '10 seconds' AS fresh
			 FROM tunnel.tunnel_credentials WHERE machine_id = $1`,
			[m],
		);
		expect(c.rows[0]?.fresh).toBe(true);
	});

	it("an operation stuck past deadline + 5 min without a job is enqueued again; a pending one after 1 min", async () => {
		const w = await createWorld(db);
		const s1 = await insertSandbox(w, { state: "stopping" });
		const stuck = await insertOperation(w, {
			sandboxId: s1,
			kind: "stop",
			state: "running",
			deadlineInS: -301,
		});
		const s2 = await insertSandbox(w, { state: "creating" });
		const pending = await insertOperation(w, { sandboxId: s2 });
		await setRow(
			w,
			"operations",
			pending,
			"created_at = now() - interval '2 minutes'",
		);
		// Not yet: deadline passed less than 5 min ago; pending for under a minute.
		const s3 = await insertSandbox(w, { state: "stopping" });
		await insertOperation(w, {
			sandboxId: s3,
			kind: "stop",
			state: "running",
			deadlineInS: -200,
		});
		const s4 = await insertSandbox(w, { state: "creating" });
		await insertOperation(w, { sandboxId: s4 });
		// A pending child whose parent is active waits for it.
		const s5 = await insertSandbox(w, { state: "ready" });
		const parent = await insertOperation(w, {
			sandboxId: s5,
			kind: "fork",
			state: "running",
		});
		const s6 = await insertSandbox(w, { state: "creating", origin: "fork" });
		const child = await insertOperation(w, {
			sandboxId: s6,
			parentOperationId: parent,
			deadlineInS: null,
		});
		await setRow(
			w,
			"operations",
			child,
			"created_at = now() - interval '2 minutes'",
		);

		w.jobs.clear();
		expect(kinds(await reconcile(w))).toEqual(
			[
				["requeue_op", `operation:${stuck}`],
				["requeue_op", `operation:${pending}`],
			].sort(),
		);
		expect(
			w.jobs.sent.map((j) => [j.queue, j.data, j.opts?.singletonKey]).sort(),
		).toEqual(
			[
				["sandbox-op", { operationId: stuck }, s1],
				["sandbox-op", { operationId: pending }, s2],
			].sort(),
		);
	});

	it("a machine deleting without a machine-op job gets its delete job again", async () => {
		const w = await createWorld(db);
		const m = await insertMachine(w, { state: "deleting" });
		await setRow(
			w,
			"machines",
			m,
			"state_changed_at = now() - interval '6 minutes'",
		);
		w.jobs.clear();
		expect(kinds(await reconcile(w))).toEqual([["requeue_op", `machine:${m}`]]);
		expect(w.jobs.sent).toEqual([
			{
				queue: "machine-op",
				data: { machineId: m, action: "delete" },
				opts: { singletonKey: m, retryLimit: DELETE_RETRY_LIMIT },
			},
		]);
	});

	it("a snapshot deleting without a snapshot-op job gets its delete job again", async () => {
		const w = await createWorld(db);
		const { snapshotId, lvId } = await insertSnapshot(w, { state: "deleting" });
		// Its LVs are older than the grace, but they belong to snapshot-op.
		await seenLongAgo(w);
		w.jobs.clear();
		expect(kinds(await reconcile(w))).toEqual([
			["requeue_op", `snapshot:${snapshotId}`],
		]);
		expect(w.jobs.sent).toEqual([
			{
				queue: "snapshot-op",
				data: { snapshotId, action: "delete" },
				opts: { singletonKey: snapshotId, retryLimit: DELETE_RETRY_LIMIT },
			},
		]);
		expect(w.infra.lvs.has(`sbx-snap-${lvId}-scsi0`)).toBe(true);
	});

	it("dryRun changes nothing and returns the same actions as a real run", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const lost = await readySandbox(w, e);
		const drift = await stoppedSandbox(w, e);
		const down = await readySandbox(w, e);
		w.infra.vms.delete(
			(await row(w, "machines", lost.machineId)).vmid as number,
		);
		const dvm = w.infra.vms.get(
			(await row(w, "machines", drift.machineId)).vmid as number,
		);
		if (dvm) dvm.status = "running";
		const svm = w.infra.vms.get(
			(await row(w, "machines", down.machineId)).vmid as number,
		);
		if (svm) svm.status = "stopped";
		w.infra.addVm({ vmid: 560 });
		w.infra.addLv("vm-581-disk-0", ["sbx", "sbx-vm-581"]);
		const m = await insertMachine(w, { state: "deleted" });
		await insertLease(w, 592, "releasing", m, 700);
		const s = await insertSandbox(w, { state: "creating" });
		const op = await insertOperation(w, { sandboxId: s });
		await setRow(
			w,
			"operations",
			op,
			"created_at = now() - interval '2 minutes'",
		);
		await seenLongAgo(w);

		const snapshot = async () => ({
			vms: [...w.infra.vms.values()].map((v) => [v.vmid, v.status]).sort(),
			lvs: [...w.infra.lvs.keys()].sort(),
			machines: (
				await w.pool.query(
					"SELECT id, state, power_observed, version FROM runtime.machines WHERE provider_id = $1 ORDER BY id",
					[w.topo.providerId],
				)
			).rows,
			sandboxes: (
				await w.pool.query(
					"SELECT id, state, version FROM runtime.sandboxes WHERE provider_id = $1 ORDER BY id",
					[w.topo.providerId],
				)
			).rows,
			leases: (
				await w.pool.query(
					"SELECT vmid, state FROM runtime.vmid_leases WHERE provider_id = $1 ORDER BY vmid",
					[w.topo.providerId],
				)
			).rows,
		});
		const before = await snapshot();
		w.jobs.clear();
		const calls = w.infra.calls.length;
		const dry = await reconcile(w, true);
		expect(dry.every((a) => !a.applied)).toBe(true);
		expect(await snapshot()).toEqual(before);
		expect(w.jobs.sent).toEqual([]);
		expect(
			w.infra.calls
				.slice(calls)
				.filter((c) => !["status", "leaseOf"].includes(c.method)),
		).toEqual([]);
		expect(new Set(dry.map((a) => a.kind))).toEqual(
			new Set([
				"machine_lost",
				"power_drift",
				"unexpected_stop",
				"orphan_vm",
				"orphan_lv",
				"lease_release",
				"requeue_op",
			]),
		);
		expect(w.logs.some((l) => l.includes("reconcile dry run"))).toBe(true);

		const live = await reconcile(w);
		expect(kinds(live)).toEqual(kinds(dry));
		expect(live.every((a) => a.applied)).toBe(true);
	});

	it("CONTROLLERS has ctl-reconcile every 60 s, dry run unless the context says otherwise", async () => {
		const spec = CONTROLLERS.find((c) => c.queue === "ctl-reconcile");
		expect(spec?.intervalMs).toBe(60_000);
		const w = await createWorld(db);
		w.infra.addVm({ vmid: 561 });
		await seenLongAgo(w);
		// Scope the controller to this world's provider: other worlds share the database.
		await w.pool.query(
			"UPDATE runtime.providers SET state = 'disabled' WHERE id <> $1",
			[w.topo.providerId],
		);
		try {
			await spec?.run(w.ctx);
			expect(w.infra.vms.has(561)).toBe(true);
			await spec?.run({ ...w.ctx, reconcileDryRun: false });
			expect(w.infra.vms.has(561)).toBe(false);
		} finally {
			await w.pool.query(
				"UPDATE runtime.providers SET state = 'active' WHERE state = 'disabled'",
			);
		}
	});
});

describe("ctl-reconcile with real pg-boss jobs", () => {
	let t: TestDatabase;
	let boss: PgBoss;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 10 });
		boss = new PgBoss({
			connectionString: t.url,
			schema: "pgboss",
			max: 2,
			supervise: false,
			schedule: false,
		});
		boss.on("error", () => {});
		await boss.start();
		const { ensureQueues } = await import("@sbx/core");
		await ensureQueues(boss);
	});
	afterAll(async () => {
		await boss?.stop({ graceful: false });
		await t?.drop();
	});

	it("an operation with a live sandbox-op job is not enqueued again; without one it is", async () => {
		const w = await createWorld(t);
		const s1 = await insertSandbox(w, { state: "creating" });
		const withJob = await insertOperation(w, { sandboxId: s1 });
		await setRow(
			w,
			"operations",
			withJob,
			"created_at = now() - interval '2 minutes'",
		);
		await boss.send(
			"sandbox-op",
			{ operationId: withJob },
			{ singletonKey: s1 },
		);
		const s2 = await insertSandbox(w, { state: "creating" });
		const without = await insertOperation(w, { sandboxId: s2 });
		await setRow(
			w,
			"operations",
			without,
			"created_at = now() - interval '2 minutes'",
		);
		// A completed job does not count.
		const done = await boss.send(
			"sandbox-op",
			{ operationId: without },
			{ singletonKey: `${s2}-x` },
		);
		await t.pool.query(
			"UPDATE pgboss.job SET state = 'completed' WHERE id = $1",
			[done],
		);
		const m = await insertMachine(w, { state: "deleting" });
		await setRow(
			w,
			"machines",
			m,
			"state_changed_at = now() - interval '6 minutes'",
		);
		await boss.send(
			"machine-op",
			{ machineId: m, action: "delete" },
			{ singletonKey: m },
		);

		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([["requeue_op", `operation:${without}`]]);
	});
});
