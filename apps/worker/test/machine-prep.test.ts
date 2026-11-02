import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMachineOp } from "../src/handlers/machine-op.ts";
import {
	CapacityWaitTimeout,
	prepareMachine,
	waitBooted,
} from "../src/machine-prep.ts";
import { Fenced } from "../src/steps.ts";
import {
	crashAfter,
	crashBefore,
	SimulatedCrash,
	spyBefore,
} from "./fakes/crash.ts";
import {
	activeDisks,
	bsHashOfSerial,
	createWorld,
	credentials,
	heldCloneSlots,
	insertMachine,
	insertOperation,
	insertSandbox,
	insertSnapshot,
	leases,
	machine,
	type TestWorld,
} from "./fakes/world.ts";

let db: TestDatabase;

// The budget only bounds a hang (the condition is what is checked); it
// leaves room for a heavily loaded machine.
async function until(
	cond: () => Promise<boolean>,
	timeoutMs = 30_000,
): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!(await cond())) {
		if (Date.now() > end) throw new Error("condition not reached");
		await new Promise((r) => setTimeout(r, 5));
	}
}

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

/** The fake holds exactly one VM for the machine, its LV and one active lease. */
async function expectSingleVm(w: TestWorld, machineId: string): Promise<void> {
	const m = await machine(w, machineId);
	expect(w.infra.vms.size).toBe(1);
	const [vm] = w.infra.vmsOf(machineId);
	expect(vm?.vmid).toBe(m.vmid);
	expect(vm?.status).toBe("running");
	expect([...w.infra.lvs.keys()]).toEqual([`vm-${m.vmid}-disk-0`]);
	expect(await leases(w)).toEqual([
		{ vmid: m.vmid, state: "active", machine_id: machineId },
	]);
	expect(await activeDisks(w, machineId)).toEqual([
		`local-lvm:vm-${m.vmid}-disk-0`,
	]);
	expect(await heldCloneSlots(w)).toBe(0);
	// The secret the VM got is the one the database knows (and the agent connected with it).
	const cred = await credentials(w, machineId);
	expect(cred?.bs_hash.equals(bsHashOfSerial(vm?.serial ?? ""))).toBe(true);
	expect(w.agentWorld.refused).toEqual([]);
}

describe("prepareMachine from the template (pool provision)", () => {
	it("goes allocating -> provisioning -> booting -> warm, one VM and an active lease", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w);
		const startStates: unknown[] = [];
		w.useInfra(
			spyBefore(w.infra, "start", async () => {
				startStates.push((await machine(w, id)).state);
			}),
		);

		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).toBe("done");
		await w.agentWorld.settled();

		const m = await machine(w, id);
		expect(m.state).toBe("warm");
		expect(m.warm_at).not.toBeNull();
		expect(m.agent_phase).toBe("pool_ready");
		expect(m.power_observed).toBe("running");
		expect(m.exec_attempt).toBe(1);
		const s = await w.pool.query(
			"SELECT boot_id FROM tunnel.tunnel_sessions WHERE machine_id = $1",
			[id],
		);
		expect(m.ready_boot_id).toBe(s.rows[0].boot_id);
		// booting is committed before S1 start (§7.4 p. 6).
		expect(startStates).toEqual(["booting"]);
		const [vm] = w.infra.vmsOf(id);
		expect(vm?.serial.startsWith(`umiak1:${id}:`)).toBe(true);
		expect(w.infra.callsOf("create")).toHaveLength(1);
		await expectSingleVm(w, id);
	});

	it("never logs the bootstrap secret or the serial", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w);
		await handleMachineOp(w.ctx, { machineId: id, action: "provision" });
		const [vm] = w.infra.vmsOf(id);
		const secret = vm?.serial.split(":")[2] ?? "";
		expect(secret.length).toBeGreaterThan(20);
		expect(w.logs.join("\n")).not.toContain(secret);
	});
});

describe("crash matrix of the preparation", () => {
	const cases = [
		{
			name: "after S1 create",
			wrap: (w: TestWorld) => crashAfter(w.infra, "create"),
			state: "provisioning",
			sameBs: false,
		},
		{
			name: "after S1 start",
			wrap: (w: TestWorld) => crashAfter(w.infra, "start"),
			state: "booting",
			sameBs: true,
		},
		{
			name: "after booting is recorded",
			wrap: (w: TestWorld) => crashBefore(w.infra, "start"),
			state: "booting",
			sameBs: true,
		},
	];

	for (const c of cases) {
		it(`${c.name}: the retry reaches warm with one VM, no extra LV or lease`, async () => {
			// Boots wait for the gate, so the retry finds the machine as the crash left it.
			const w = await createWorld(db);
			w.agentWorld.holdBoots();
			const id = await insertMachine(w);
			w.useInfra(c.wrap(w));

			await expect(
				handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
			).rejects.toBeInstanceOf(SimulatedCrash);
			expect((await machine(w, id)).state).toBe(c.state);
			const bsBefore = (await credentials(w, id))?.bs_hash;
			expect(bsBefore).toBeDefined();
			expect(await heldCloneSlots(w)).toBe(0);

			// Redelivery of the job; boots go on once the retry holds the fence.
			const retry = handleMachineOp(w.ctx, {
				machineId: id,
				action: "provision",
			});
			await until(async () => (await machine(w, id)).exec_attempt === 2);
			w.agentWorld.releaseBoots();
			expect(await retry).toBe("done");
			await w.agentWorld.settled();
			const m = await machine(w, id);
			expect(m.state).toBe("warm");
			await expectSingleVm(w, id);

			const bsAfter = (await credentials(w, id))?.bs_hash;
			// A retry from provisioning gets a new secret; after booting it never changes.
			expect(bsAfter?.equals(bsBefore as Buffer)).toBe(c.sameBs);
			if (c.state === "provisioning") {
				// The partial VM of the first attempt was deleted through its lease.
				expect(w.infra.callsOf("delete")).toHaveLength(1);
				expect(w.infra.callsOf("create")).toHaveLength(2);
			} else {
				expect(w.infra.callsOf("delete")).toHaveLength(0);
				expect(w.infra.callsOf("create")).toHaveLength(1);
			}
		});
	}

	it("vmid and disks recorded, still provisioning: the retry deletes the VM and marks the old disks deleted", async () => {
		// The first attempt waits at the start gate (powered RAM short) and gives up retryably.
		const w = await createWorld(db, {
			ramCapMb: 4096,
			timing: { ramWaitTimeoutMs: 100 },
		});
		const other = await insertMachine(w, {
			state: "deleting",
			poolKey: null,
			memoryMb: 3072,
			powerObserved: "running",
		});
		const id = await insertMachine(w);
		await expect(
			handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).rejects.toBeInstanceOf(CapacityWaitTimeout);
		const first = await machine(w, id);
		expect(first.state).toBe("provisioning");
		expect(first.vmid).not.toBeNull();
		expect(await activeDisks(w, id)).toHaveLength(1);

		await w.pool.query(
			"UPDATE runtime.machines SET power_observed = 'stopped' WHERE id = $1",
			[other],
		);
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).toBe("done");
		await w.agentWorld.settled();
		expect(w.infra.callsOf("delete").map((c) => c.args[0])).toEqual([
			first.vmid,
		]);
		const d = await w.pool.query<{ state: string }>(
			"SELECT state FROM runtime.disks WHERE machine_id = $1 ORDER BY created_at",
			[id],
		);
		expect(d.rows.map((r) => r.state)).toEqual(["deleted", "active"]);
		expect((await machine(w, id)).state).toBe("warm");
		await expectSingleVm(w, id);
	});

	it("discardPartial deletes only a VMID that is still leased to the machine", async () => {
		const w = await createWorld(db);
		const neighbour = await insertMachine(w);
		expect(
			await handleMachineOp(w.ctx, {
				machineId: neighbour,
				action: "provision",
			}),
		).toBe("done");
		const neighbourVmid = (await machine(w, neighbour)).vmid as number;
		const id = await insertMachine(w);
		w.useInfra(crashAfter(w.infra, "create"));
		await expect(
			handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).rejects.toThrow(SimulatedCrash);
		await w.agentWorld.settled();

		// The first lease read is stale: that VMID was released and now belongs to the neighbour.
		let reads = 0;
		const real = w.infra;
		w.useInfra(
			new Proxy(real, {
				get(t, p) {
					if (p === "leaseOf") {
						return async (machineId: string) => {
							reads += 1;
							if (machineId === id && reads === 1) {
								return { vmid: neighbourVmid, mac: "00:00:00:00:00:00" };
							}
							return t.leaseOf(machineId);
						};
					}
					const v = Reflect.get(t, p, t);
					return typeof v === "function" ? v.bind(t) : v;
				},
			}),
		);
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).toBe("done");
		await w.agentWorld.settled();
		expect(w.infra.callsOf("delete").map((c) => c.args[0])).not.toContain(
			neighbourVmid,
		);
		expect(w.infra.vmsOf(neighbour)).toHaveLength(1);
		expect(w.infra.vmsOf(id)).toHaveLength(1);
		expect((await machine(w, neighbour)).state).toBe("warm");
		expect((await machine(w, id)).state).toBe("warm");
	});

	it("crash between S1 create and recording vmid: the lease has machine_id, the machine has no vmid", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w);
		w.useInfra(crashAfter(w.infra, "create"));
		await expect(
			handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).rejects.toThrow(SimulatedCrash);
		const m = await machine(w, id);
		expect(m.vmid).toBeNull();
		const before = await leases(w);
		expect(before).toHaveLength(1);
		expect(before[0]?.machine_id).toBe(id);
		expect(w.infra.vms.size).toBe(1);

		await handleMachineOp(w.ctx, { machineId: id, action: "provision" });
		await w.agentWorld.settled();
		await expectSingleVm(w, id);
	});
});

describe("prepareMachine under an operation fence (cold create)", () => {
	it("prepares a sandbox machine to booting and starts it; no warm", async () => {
		const w = await createWorld(db);
		const sandboxId = await insertSandbox(w);
		const id = await insertMachine(w, { poolKey: null, sandboxId });
		await w.pool.query(
			"UPDATE runtime.sandboxes SET machine_id = $2 WHERE id = $1",
			[sandboxId, id],
		);
		const opId = await insertOperation(w, { sandboxId });
		const fenced = await Fenced.begin(w.ctx, opId);
		if (!fenced) throw new Error("no fence");

		await prepareMachine(w.ctx, fenced, id, { kind: "template" });
		const bootId = await waitBooted(w.ctx, fenced, id, 30_000);
		await w.agentWorld.settled();

		const m = await machine(w, id);
		expect(m.state).toBe("booting");
		expect(m.ready_boot_id).toBe(bootId);
		await expectSingleVm(w, id);
	});
});

describe("prepareMachine from a snapshot", () => {
	it("forks the snapshot's LVs instead of cloning the template", async () => {
		const w = await createWorld(db);
		const { snapshotId, lvId } = await insertSnapshot(w);
		const id = await insertMachine(w, {
			origin: "snapshot",
			originSnapshotId: snapshotId,
		});

		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).toBe("done");
		await w.agentWorld.settled();

		expect(w.infra.callsOf("create")).toHaveLength(0);
		expect(w.infra.callsOf("fork")).toEqual([
			{
				method: "fork",
				args: [{ machineId: id, lvId, size: { vcpu: 2, memoryMb: 2048 } }],
			},
		]);
		expect((await machine(w, id)).state).toBe("warm");
		expect(w.infra.vmsOf(id)).toHaveLength(1);
	});
});

describe("waits of the preparation", () => {
	it("waits for powered RAM before booting and does not start meanwhile", async () => {
		const w = await createWorld(db, { ramCapMb: 4096 });
		// A deleting machine whose VM still runs holds powered RAM (§8.1).
		const other = await insertMachine(w, {
			state: "deleting",
			poolKey: null,
			memoryMb: 3072,
			powerObserved: "running",
		});
		const id = await insertMachine(w);
		// What the other machine's power looked like when S1 start was called.
		const otherPowerAtStart: unknown[] = [];
		w.useInfra(
			spyBefore(w.infra, "start", async () => {
				otherPowerAtStart.push((await machine(w, other)).power_observed);
			}),
		);
		const run = handleMachineOp(w.ctx, { machineId: id, action: "provision" });

		// The VM and its disks are recorded right before the start gate.
		await until(async () => (await activeDisks(w, id)).length > 0);
		expect((await machine(w, id)).state).toBe("provisioning");
		expect(w.infra.callsOf("start")).toHaveLength(0);

		await w.pool.query(
			"UPDATE runtime.machines SET power_observed = 'stopped' WHERE id = $1",
			[other],
		);
		expect(await run).toBe("done");
		await w.agentWorld.settled();
		expect((await machine(w, id)).state).toBe("warm");
		// The start waited for the RAM, however long the gate took to see it.
		expect(otherPowerAtStart).toEqual(["stopped"]);
	});

	it("waits for a clone slot of the node", async () => {
		const w = await createWorld(db, { cloneConcurrency: 1 });
		await w.pool.query(
			`INSERT INTO runtime.node_clone_slots (node_id, slot, holder, expires_at)
			 VALUES ($1, 0, 'someone', now() + interval '1 minute')`,
			[w.topo.nodeId],
		);
		const id = await insertMachine(w);
		// Who held the slot when S1 create was called.
		const holderAtCreate: (string | null)[] = [];
		w.useInfra(
			spyBefore(w.infra, "create", async () => {
				const r = await w.pool.query<{ holder: string | null }>(
					"SELECT holder FROM runtime.node_clone_slots WHERE node_id = $1 AND slot = 0",
					[w.topo.nodeId],
				);
				holderAtCreate.push(r.rows[0]?.holder ?? null);
			}),
		);
		const run = handleMachineOp(w.ctx, { machineId: id, action: "provision" });

		// The machine is provisioning (lease taken) before the slot wait.
		await until(async () => (await machine(w, id)).state === "provisioning");
		expect(w.infra.callsOf("create")).toHaveLength(0);

		await w.pool.query(
			"UPDATE runtime.node_clone_slots SET holder = NULL, expires_at = NULL WHERE node_id = $1",
			[w.topo.nodeId],
		);
		expect(await run).toBe("done");
		expect(w.infra.callsOf("create")).toHaveLength(1);
		// Our own holder took the freed slot; "someone" never shared it.
		expect(holderAtCreate).toHaveLength(1);
		expect(holderAtCreate[0]).not.toBe("someone");
		expect(await heldCloneSlots(w)).toBe(0);
	});
});
