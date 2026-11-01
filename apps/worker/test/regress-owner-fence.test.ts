// Regressions of the S6 acceptance (H1, M3): power operations act only on a
// VMID still leased to the machine, and a start never runs for an executor
// that was fenced out while it waited for the node's power lock.
import { randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMachineOp } from "../src/handlers/machine-op.ts";
import { handleSandboxOp } from "../src/handlers/sandbox-op.ts";
import { blockBefore } from "./fakes/crash.ts";
import { createWorld, insertMachine, type TestWorld } from "./fakes/world.ts";
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

async function until(cond: () => boolean, what: string): Promise<void> {
	// Only bounds a hang; room for a heavily loaded machine.
	const deadline = Date.now() + 30_000;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** Hands the machine's lease to another (new) machine, as after a VMID reuse. */
async function giveLeaseAway(w: TestWorld, machineId: string): Promise<string> {
	const other = randomUUID();
	const r = await w.pool.query(
		`UPDATE runtime.vmid_leases SET machine_id = $3
		 WHERE provider_id = $1 AND machine_id = $2`,
		[w.topo.providerId, machineId, other],
	);
	expect(r.rowCount).toBe(1);
	return other;
}

function vmOf(w: TestWorld, machineId: string) {
	const [vm] = w.infra.vmsOf(machineId);
	if (!vm) throw new Error(`no VM for ${machineId}`);
	return vm;
}

describe("M3: fence re-checked after the power lock", () => {
	it("a provision executor fenced out while it waits for the power lock never starts the VM", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w);
		const release = w.infra.holdPower();
		const a = handleMachineOp(w.ctx, { machineId: id, action: "provision" });
		await until(
			() => w.infra.callsOf("start").length === 1,
			"A queued its start behind the held power lock",
		);
		// Another executor takes the machine over (exec_attempt + 1).
		await w.pool.query(
			"UPDATE runtime.machines SET exec_attempt = exec_attempt + 1 WHERE id = $1",
			[id],
		);
		release();
		expect(await a).toBe("fenced_out");
		expect(vmOf(w, id).starts).toBe(0);
		expect(vmOf(w, id).status).toBe("stopped");
	});

	it("a resume executor fenced out while it waits for the power lock never starts the VM", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await stoppedSandbox(w, e);
		const startsBefore = vmOf(w, machineId).starts;
		const op = await e.svc.resume(e.p, sandboxId);
		const release = w.infra.holdPower();
		const calls = w.infra.callsOf("start").length;
		const a = handleSandboxOp(w.ctx, { operationId: op.id });
		await until(
			() => w.infra.callsOf("start").length === calls + 1,
			"A queued its start behind the held power lock",
		);
		await w.pool.query(
			"UPDATE runtime.operations SET attempt = attempt + 1 WHERE id = $1",
			[op.id],
		);
		release();
		await a;
		expect(vmOf(w, machineId).starts).toBe(startsBefore);
		expect(vmOf(w, machineId).status).toBe("stopped");
		expect(w.metrics.count("umiak_fenced_out_total")).toBeGreaterThanOrEqual(1);
	});
});

describe("H1: owner-checked power operations", () => {
	it("resume of a machine whose VMID is leased to another machine: machine_state_conflict, nothing started", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await stoppedSandbox(w, e);
		const vm = vmOf(w, machineId);
		const startsBefore = vm.starts;
		await giveLeaseAway(w, machineId);

		const op = await e.svc.resume(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("failed");
		expect((await row(w, "operations", op.id)).error_code).toBe(
			"machine_state_conflict",
		);
		const s = await row(w, "sandboxes", sandboxId);
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("machine_state_conflict");
		expect(vm.starts).toBe(startsBefore);
		expect(vm.status).toBe("stopped");
		expect(w.metrics.count("umiak_owner_mismatch_total")).toBe(1);
	});

	it("stop of a machine whose VMID is leased to another machine: machine_state_conflict, the VM keeps running", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e);
		const vm = vmOf(w, machineId);
		await giveLeaseAway(w, machineId);

		const op = await e.svc.stop(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("failed");
		expect((await row(w, "operations", op.id)).error_code).toBe(
			"machine_state_conflict",
		);
		expect(vm.status).toBe("running");
		expect(
			w.metrics.count("umiak_owner_mismatch_total"),
		).toBeGreaterThanOrEqual(1);
	});

	it("a sandbox delete whose lease read went stale before S1 stop and delete leaves the new owner's VM alone", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e);
		const vm = vmOf(w, machineId);

		// The delete read the lease and passed its fence; then the VMID changed hands.
		const held = blockBefore(w.infra, "stop");
		w.useInfra(held.port);
		const op = await e.svc.delete(e.p, sandboxId);
		const d = handleSandboxOp(w.ctx, { operationId: op.id });
		await held.reached;
		const other = await giveLeaseAway(w, machineId);
		held.release();
		expect(await d).toBe("succeeded");
		w.useInfra(w.infra);

		expect((await row(w, "sandboxes", sandboxId)).state).toBe("deleted");
		expect((await row(w, "machines", machineId)).state).toBe("deleted");
		expect(w.infra.vms.get(vm.vmid)?.status).toBe("running");
		const lease = await w.pool.query(
			"SELECT machine_id, state FROM runtime.vmid_leases WHERE provider_id = $1 AND vmid = $2",
			[w.topo.providerId, vm.vmid],
		);
		expect(lease.rows).toEqual([{ machine_id: other, state: "active" }]);
		expect(w.metrics.count("umiak_owner_mismatch_total")).toBe(1);
	});

	it("a machine-op delete whose lease read went stale before S1 delete deletes nothing", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { machineId } = await stoppedSandbox(w, e);
		const vm = vmOf(w, machineId);
		await w.pool.query(
			"UPDATE runtime.machines SET state = 'deleting' WHERE id = $1",
			[machineId],
		);
		const held = blockBefore(w.infra, "delete");
		w.useInfra(held.port);
		const d = handleMachineOp(w.ctx, { machineId, action: "delete" });
		await held.reached;
		await giveLeaseAway(w, machineId);
		held.release();
		expect(await d).toBe("done");
		w.useInfra(w.infra);
		expect((await row(w, "machines", machineId)).state).toBe("deleted");
		expect(w.infra.vms.has(vm.vmid)).toBe(true);
		expect(w.metrics.count("umiak_owner_mismatch_total")).toBe(1);
	});
});
