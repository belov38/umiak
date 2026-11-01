import { randomUUID } from "node:crypto";
import { DELETE_RETRY_LIMIT } from "@sbx/core";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTROLLERS } from "../src/controllers/index.ts";
import {
	type ReconcileAction,
	runReconcile,
} from "../src/controllers/reconcile.ts";
import type { NodeInfra } from "../src/ports.ts";
import { FakeInfra } from "./fakes/infra.ts";
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
	commandOutcome,
	eventTypes,
	insertCommand,
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

type Hooks = {
	[K in keyof NodeInfra]?: NodeInfra[K] extends (...a: infer A) => infer R
		? (call: number, next: () => R, ...a: A) => R
		: never;
};

/**
 * Puts a wrapper of the world's FakeInfra in place: a hooked method gets its
 * 1-based call number and the original call (`next`).
 */
function hookInfra(w: TestWorld, hooks: Hooks): void {
	const target = w.infra;
	const counts = new Map<string, number>();
	const proxy = new Proxy(target, {
		get(t, prop, recv) {
			const v = Reflect.get(t, prop, recv);
			if (typeof v !== "function") return v;
			const hook = (hooks as Record<string | symbol, unknown>)[prop];
			if (typeof hook !== "function") return v.bind(t);
			return (...args: unknown[]) => {
				const n = (counts.get(String(prop)) ?? 0) + 1;
				counts.set(String(prop), n);
				return hook(n, () => v.apply(t, args), ...args);
			};
		},
	});
	w.useInfra(proxy as NodeInfra);
}

async function seenRows(w: TestWorld): Promise<string[]> {
	const r = await w.pool.query<{ name: string }>(
		"SELECT kind || ':' || split_part(name, '/', 2) AS name FROM runtime.reconcile_seen WHERE provider_id = $1 ORDER BY 1",
		[w.topo.providerId],
	);
	return r.rows.map((x) => x.name);
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

	it("lease_release never deletes a VM outside pool sandbox, without the sbx tag or a template", async () => {
		const w = await createWorld(db);
		const m = await insertMachine(w, { state: "deleted" });
		w.infra.addVm({ vmid: 593, pool: "other", machineId: m });
		await insertLease(w, 593, "releasing", m, 700);
		w.infra.addVm({ vmid: 594, tags: ["foo"], machineId: m });
		await insertLease(w, 594, "releasing", m, 700);
		// A template build's VMID inside the range.
		await w.pool.query(
			"UPDATE runtime.template_builds SET pve_vmid = 595 WHERE id = $1",
			[w.topo.templateBuildId],
		);
		w.infra.addVm({ vmid: 595, machineId: m });
		await insertLease(w, 595, "releasing", m, 700);
		expect(await reconcile(w)).toEqual([]);
		for (const vmid of [593, 594, 595])
			expect(w.infra.vms.has(vmid)).toBe(true);
		expect(w.infra.callsOf("delete")).toEqual([]);
		const skipped = w.metrics.calls
			.filter((c) => c.name === "sbx_reconcile_skipped_total")
			.map((c) => c.labels.reason)
			.sort();
		expect(skipped).toEqual(["no_sbx_tag", "not_in_pool", "template"]);
	});

	it("lease_release re-checks the VM at apply: a foreign VM that appears after planning is not deleted", async () => {
		const w = await createWorld(db);
		const m = await insertMachine(w, { state: "deleted" });
		await insertLease(w, 596, "releasing", m, 700);
		// Planning sees no VM (list 1: the node part, list 2: lease planning);
		// before the apply's re-list (3) a VM outside the pool shows up.
		hookInfra(w, {
			listVms: (n, next) => {
				if (n === 3) w.infra.addVm({ vmid: 596, pool: "other", machineId: m });
				return next();
			},
		});
		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([["lease_release", "lease:596"]]);
		expect(actions[0]?.applied).toBe(false);
		expect(w.infra.vms.has(596)).toBe(true);
		expect(w.infra.callsOf("delete")).toEqual([]);
	});

	it("grace counts from the first sighting as an orphan: a VMID claimed in between starts over", async () => {
		const w = await createWorld(db);
		w.infra.addVm({ vmid: 553 });
		await seenLongAgo(w);
		expect(await seenRows(w)).toContain("vm:553");
		// The VMID gets claimed (a live machine's lease): no longer a candidate.
		const m = await insertMachine(w, { state: "provisioning" });
		await insertLease(w, 553, "reserved", m);
		expect(await reconcile(w)).toEqual([]);
		expect(await seenRows(w)).not.toContain("vm:553");
		// The machine is gone, the VM with that VMID is a new orphan: fresh grace.
		await w.pool.query(
			"DELETE FROM runtime.vmid_leases WHERE provider_id = $1 AND vmid = 553",
			[w.topo.providerId],
		);
		await setRow(w, "machines", m, "state = 'deleted'");
		expect(await reconcile(w)).toEqual([]);
		expect(w.infra.vms.has(553)).toBe(true);
		await backdateSeen(w);
		expect(kinds(await reconcile(w))).toEqual([["orphan_vm", "vm:553"]]);
	});

	it("grace after an applied orphan delete: a new VM with the same VMID is fresh", async () => {
		const w = await createWorld(db);
		w.infra.addVm({ vmid: 554 });
		w.infra.addLv("vm-555-disk-0", ["sbx", "sbx-vm-555"]);
		await seenLongAgo(w);
		expect(kinds(await reconcile(w))).toEqual([
			["orphan_lv", "lv:vm-555-disk-0"],
			["orphan_vm", "vm:554"],
		]);
		w.infra.addVm({ vmid: 554 });
		w.infra.addLv("vm-555-disk-0", ["sbx", "sbx-vm-555"]);
		expect(await reconcile(w)).toEqual([]);
		expect(w.infra.vms.has(554)).toBe(true);
		expect(w.infra.lvs.has("vm-555-disk-0")).toBe(true);
	});

	it("TOCTOU: a lease that appears between planning and apply saves an orphan VM", async () => {
		const w = await createWorld(db);
		w.infra.addVm({ vmid: 556 });
		await seenLongAgo(w);
		const m = await insertMachine(w, { state: "provisioning" });
		hookInfra(w, {
			status: async (_n, next) => {
				await insertLease(w, 556, "reserved", m);
				return next();
			},
		});
		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([["orphan_vm", "vm:556"]]);
		expect(actions[0]?.applied).toBe(false);
		expect(actions[0]?.error).toMatch(/skipped/);
		expect(w.infra.callsOf("delete")).toEqual([]);
		expect(w.infra.vms.has(556)).toBe(true);
	});

	it("TOCTOU: a lease taken right before S1 delete (after the evidence re-check) saves an orphan VM", async () => {
		const w = await createWorld(db);
		w.infra.addVm({ vmid: 558 });
		await seenLongAgo(w);
		const m = await insertMachine(w, { state: "provisioning" });
		hookInfra(w, {
			delete: async (_n, next) => {
				await insertLease(w, 558, "reserved", m);
				return next();
			},
		});
		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([["orphan_vm", "vm:558"]]);
		expect(actions[0]?.applied).toBe(false);
		expect(w.infra.vms.has(558)).toBe(true);
		expect(w.metrics.count("sbx_owner_mismatch_total")).toBe(1);
	});

	it("an ownerless releasing lease (a failed orphan delete's reservation) is finished by lease_release", async () => {
		const w = await createWorld(db);
		await insertLease(w, 593, "releasing", null, 700);
		w.infra.addVm({ vmid: 593, status: "stopped" });
		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([["lease_release", "lease:593"]]);
		expect(actions[0]?.applied).toBe(true);
		expect(w.infra.vms.has(593)).toBe(false);
		const l = await w.pool.query(
			"SELECT vmid FROM runtime.vmid_leases WHERE provider_id = $1 AND vmid = 593",
			[w.topo.providerId],
		);
		expect(l.rows).toEqual([]);
	});

	it("an ownerless releasing lease goes to the node that lists its VM (two nodes)", async () => {
		const w = await createWorld(db);
		// Node B sorts after the world's node, so "the first node" is the wrong one.
		const nodeB = `ffffffff-ffff-4fff-8fff-${randomUUID().slice(-12)}`;
		await w.pool.query(
			`INSERT INTO runtime.nodes (id, provider_id, name, ram_cap_mb, clone_concurrency, node_agent_ref)
			 VALUES ($1, $2, $3, 8192, 4, 'sbx-node')`,
			[nodeB, w.topo.providerId, `node-b-${nodeB.slice(-6)}`],
		);
		const infraB = new FakeInfra({
			pool: w.pool,
			providerId: w.topo.providerId,
			clusterMacId: w.topo.clusterMacId,
		});
		w.registry.set(nodeB, infraB);
		// An orphan delete on B reserved the VMID and died before the destroy.
		infraB.addVm({ vmid: 560, status: "running" });
		await insertLease(w, 560, "releasing", null, 700);

		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([["lease_release", "lease:560"]]);
		expect(actions[0]?.nodeId).toBe(nodeB);
		expect(actions[0]?.applied).toBe(true);
		expect(w.infra.callsOf("delete")).toEqual([]);
		expect(infraB.vms.has(560)).toBe(false);
		const l = await w.pool.query(
			"SELECT vmid FROM runtime.vmid_leases WHERE provider_id = $1 AND vmid = 560",
			[w.topo.providerId],
		);
		expect(l.rows).toEqual([]);
	});

	it("a node whose listing failed is not asked again for every ownerless lease in the run", async () => {
		const w = await createWorld(db);
		const nodeB = `ffffffff-ffff-4fff-8fff-${randomUUID().slice(-12)}`;
		await w.pool.query(
			`INSERT INTO runtime.nodes (id, provider_id, name, ram_cap_mb, clone_concurrency, node_agent_ref)
			 VALUES ($1, $2, $3, 8192, 4, 'sbx-node')`,
			[nodeB, w.topo.providerId, `node-b-${nodeB.slice(-6)}`],
		);
		const infraB = new FakeInfra({
			pool: w.pool,
			providerId: w.topo.providerId,
			clusterMacId: w.topo.clusterMacId,
		});
		let listings = 0;
		infraB.listVms = async () => {
			listings++;
			throw new Error("node B unreachable");
		};
		w.registry.set(nodeB, infraB);
		for (const vmid of [561, 562, 563]) {
			await insertLease(w, vmid, "releasing", null, 700);
		}

		// Node B is unknown: the leases wait, none goes to the first node.
		expect(await reconcile(w)).toEqual([]);
		expect(w.infra.callsOf("delete")).toEqual([]);
		// One listing for B's node part, one for the leases part.
		expect(listings).toBe(2);
	});

	it("lease_release passes the lease's owner: a VMID whose lease changed owner is not deleted", async () => {
		const w = await createWorld(db);
		const m = await insertMachine(w, { state: "deleted" });
		await insertLease(w, 592, "releasing", m, 700);
		w.infra.addVm({ vmid: 592, machineId: m, status: "stopped" });
		const other = randomUUID();
		hookInfra(w, {
			delete: async (_n, next) => {
				await w.pool.query(
					"UPDATE runtime.vmid_leases SET machine_id = $3 WHERE provider_id = $1 AND vmid = $2",
					[w.topo.providerId, 592, other],
				);
				return next();
			},
		});
		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([["lease_release", "lease:592"]]);
		expect(actions[0]?.applied).toBe(false);
		expect(w.infra.vms.has(592)).toBe(true);
		expect(w.metrics.count("sbx_owner_mismatch_total")).toBe(1);
	});

	it("TOCTOU: a machine row that appears between planning and apply saves an orphan VM", async () => {
		const w = await createWorld(db);
		w.infra.addVm({ vmid: 557 });
		await seenLongAgo(w);
		hookInfra(w, {
			status: async (_n, next) => {
				await insertMachine(w, { state: "booting", vmid: 557 });
				return next();
			},
		});
		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([["orphan_vm", "vm:557"]]);
		expect(actions[0]?.applied).toBe(false);
		expect(w.infra.callsOf("delete")).toEqual([]);
	});

	it("TOCTOU: a snapshot row that appears between planning and apply saves its LVs", async () => {
		const w = await createWorld(db);
		const lvId = "abcdef0123456789abcdef0123456789";
		const lv = w.infra.addSnapshotLvs(lvId);
		await seenLongAgo(w);
		hookInfra(w, {
			listVms: async (n, next) => {
				// The second list is the apply's re-check.
				if (n === 2) {
					await w.pool.query(
						`INSERT INTO runtime.snapshots
						   (id, kind, team_id, provider_id, node_id, storage_id, template_build_id, lv_id, state)
						 VALUES ($1, 'saved', $2, $3, $4, $5, $6, $7, 'creating')`,
						[
							randomUUID(),
							randomUUID(),
							w.topo.providerId,
							w.topo.nodeId,
							w.topo.storageId,
							w.topo.templateBuildId,
							lvId,
						],
					);
				}
				return next();
			},
		});
		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([["orphan_lv", `lv:${lv}`]]);
		expect(actions[0]?.applied).toBe(false);
		expect(w.infra.callsOf("removeLvs")).toEqual([]);
		expect(w.infra.lvs.has(lv)).toBe(true);
	});

	it("TOCTOU: machine_lost with a concurrent version bump is skipped", async () => {
		const w = await createWorld(db);
		const r = await readySandbox(w, opsEnv(w));
		const vmid = (await row(w, "machines", r.machineId)).vmid as number;
		w.infra.vms.delete(vmid);
		hookInfra(w, {
			status: async (_n, next) => {
				await setRow(w, "machines", r.machineId, "version = version + 1");
				return next();
			},
		});
		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([
			["machine_lost", `machine:${r.machineId}`],
		]);
		expect(actions[0]?.applied).toBe(false);
		expect((await row(w, "machines", r.machineId)).state).toBe("running");
		expect((await row(w, "sandboxes", r.sandboxId)).state).toBe("ready");
	});

	it("power_drift: no hard stop after a shutdown timeout when the machine changed meanwhile", async () => {
		const w = await createWorld(db);
		const r = await stoppedSandbox(w, opsEnv(w));
		const vmid = (await row(w, "machines", r.machineId)).vmid as number;
		const vm = w.infra.vms.get(vmid);
		if (!vm) throw new Error("no VM");
		vm.status = "running";
		const stops = w.infra.callsOf("stop").length;
		hookInfra(w, {
			shutdown: async () => {
				// A resume took the machine while the guest ignored the shutdown.
				await setRow(
					w,
					"machines",
					r.machineId,
					"state = 'starting', version = version + 1",
				);
				return "timeout";
			},
		});
		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([["power_drift", `machine:${r.machineId}`]]);
		expect(actions[0]?.applied).toBe(false);
		expect(w.infra.callsOf("stop").length).toBe(stops);
		expect(vm.status).toBe("running");
	});

	it("power_drift: a hard stop after a shutdown timeout clears clean_stop (S6 §7.8)", async () => {
		const w = await createWorld(db);
		const r = await stoppedSandbox(w, opsEnv(w));
		expect((await row(w, "machines", r.machineId)).clean_stop).toBe(true);
		const vmid = (await row(w, "machines", r.machineId)).vmid as number;
		const vm = w.infra.vms.get(vmid);
		if (!vm) throw new Error("no VM");
		vm.status = "running";
		hookInfra(w, { shutdown: async () => "timeout" });
		const actions = await reconcile(w);
		expect(kinds(actions)).toEqual([["power_drift", `machine:${r.machineId}`]]);
		expect(actions[0]?.applied).toBe(true);
		expect(vm.status).toBe("stopped");
		expect(await row(w, "machines", r.machineId)).toMatchObject({
			state: "stopped",
			clean_stop: false,
		});
	});

	it("power_drift: a resume that begins while reconcile waits for the power lock gets no shutdown or stop", async () => {
		const w = await createWorld(db);
		const r = await stoppedSandbox(w, opsEnv(w));
		const vmid = (await row(w, "machines", r.machineId)).vmid as number;
		const vm = w.infra.vms.get(vmid);
		if (!vm) throw new Error("no VM");
		vm.status = "running";
		const shutdowns = w.infra.callsOf("shutdown").length;
		const stops = w.infra.callsOf("stop").length;
		// A delete of another machine holds the node's power lock.
		const release = w.infra.holdPower();
		const pending = reconcile(w);
		await vi.waitFor(() =>
			expect(w.infra.callsOf("shutdown").length).toBe(shutdowns + 1),
		);
		// A resume takes the machine while reconcile waits.
		await setRow(
			w,
			"machines",
			r.machineId,
			"state = 'starting', version = version + 1",
		);
		release();
		const actions = await pending;
		expect(kinds(actions)).toEqual([["power_drift", `machine:${r.machineId}`]]);
		expect(actions[0]?.applied).toBe(false);
		expect(w.infra.callsOf("stop").length).toBe(stops);
		expect(vm.status).toBe("running");
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
		const cmd = await insertCommand(w, r);
		const vmid = (await row(w, "machines", r.machineId)).vmid as number;
		w.infra.vms.delete(vmid);
		expect(kinds(await reconcile(w))).toEqual([
			["machine_lost", `machine:${r.machineId}`],
		]);
		// The VM is gone, not seen rebooting: the reason is unknown (R32).
		expect(await commandOutcome(w, cmd)).toMatchObject({
			status: "lost",
			reason: null,
		});
		const m = await row(w, "machines", r.machineId);
		expect(m.state).toBe("failed");
		expect(m.error_code).toBe("machine_lost");
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
		const disabled = await w.pool.query<{ id: string }>(
			`UPDATE runtime.providers SET state = 'disabled'
			 WHERE id <> $1 AND state <> 'disabled' RETURNING id`,
			[w.topo.providerId],
		);
		try {
			await spec?.run(w.ctx);
			expect(w.infra.vms.has(561)).toBe(true);
			await spec?.run({ ...w.ctx, reconcileDryRun: false });
			expect(w.infra.vms.has(561)).toBe(false);
		} finally {
			await w.pool.query(
				"UPDATE runtime.providers SET state = 'active' WHERE id = ANY($1::uuid[])",
				[disabled.rows.map((x) => x.id)],
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
