import { DELETE_RETRY_LIMIT } from "@sbx/core";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMachineOp } from "../src/handlers/machine-op.ts";
import { blockAfter, spyBefore } from "./fakes/crash.ts";
import {
	activeDisks,
	createWorld,
	credentials,
	insertMachine,
	insertSandbox,
	leases,
	machine,
	type TestWorld,
} from "./fakes/world.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

async function warmMachine(w: TestWorld): Promise<string> {
	const id = await insertMachine(w);
	expect(
		await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
	).toBe("done");
	await w.agentWorld.settled();
	return id;
}

async function expectGone(w: TestWorld, id: string): Promise<void> {
	const m = await machine(w, id);
	expect(m.state).toBe("deleted");
	expect(m.deleted_at).not.toBeNull();
	expect(m.power_observed).toBe("stopped");
	expect(w.infra.vms.size).toBe(0);
	expect(w.infra.lvs.size).toBe(0);
	expect(await leases(w)).toEqual([]);
	expect(await activeDisks(w, id)).toEqual([]);
	expect((await credentials(w, id))?.retired_at ?? null).not.toBeNull();
}

describe("machine-op provision failures", () => {
	it("boot timeout: failed -> deleting with a delete job; the delete removes VM and lease", async () => {
		const w = await createWorld(db, { boot: "connect", bootTimeoutS: 1 });
		const id = await insertMachine(w);

		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).toBe("failed");
		const m = await machine(w, id);
		expect(m.state).toBe("deleting");
		expect(m.error_code).toBe("boot_timeout");
		expect(w.jobs.sent).toContainEqual({
			queue: "machine-op",
			data: { machineId: id, action: "delete" },
			opts: { singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
		});
		expect(w.infra.vms.size).toBe(1);

		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "delete" }),
		).toBe("done");
		await expectGone(w, id);
	});

	it("a permanent infrastructure error fails the machine; a retryable one is thrown", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w);
		w.useInfra(
			spyBefore(w.infra, "create", async () => {
				throw Object.assign(new Error("proxmox says no"), { retryable: true });
			}),
		);
		await expect(
			handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).rejects.toThrow("proxmox says no");
		expect((await machine(w, id)).state).toBe("provisioning");

		w.useInfra(
			spyBefore(w.infra, "create", async () => {
				throw new Error("template is broken");
			}),
		);
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).toBe("failed");
		const m = await machine(w, id);
		expect(m.state).toBe("deleting");
		expect(m.error_code).toBe("provision_failed");
		expect(m.error_detail).toContain("template is broken");
	});

	it("a redelivered provision of a warm machine does nothing", async () => {
		const w = await createWorld(db);
		const id = await warmMachine(w);
		const before = await machine(w, id);
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).toBe("skipped");
		const after = await machine(w, id);
		expect(after.exec_attempt).toBe(before.exec_attempt);
		expect(w.infra.callsOf("create")).toHaveLength(1);
	});
});

describe("machine-op delete", () => {
	it("sets retired_at before S1 stop, then power_observed stopped, deletes VM, disks and lease", async () => {
		const w = await createWorld(db);
		const id = await warmMachine(w);
		await w.pool.query(
			"UPDATE runtime.machines SET state = 'deleting' WHERE id = $1",
			[id],
		);
		const retiredAtStop: (Date | null)[] = [];
		w.useInfra(
			spyBefore(w.infra, "stop", async () => {
				retiredAtStop.push((await credentials(w, id))?.retired_at ?? null);
			}),
		);

		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "delete" }),
		).toBe("done");
		expect(retiredAtStop).toHaveLength(1);
		expect(retiredAtStop[0]).not.toBeNull();
		await expectGone(w, id);
		const s = await w.pool.query(
			"SELECT state FROM tunnel.tunnel_sessions WHERE machine_id = $1",
			[id],
		);
		expect(s.rows[0].state).toBe("disconnected");

		// Redelivery.
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "delete" }),
		).toBe("skipped");
	});

	it("tolerates a machine without VM, lease or credentials", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w, { state: "deleting", vmid: 512 });
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "delete" }),
		).toBe("done");
		const m = await machine(w, id);
		expect(m.state).toBe("deleted");
		expect(w.infra.callsOf("delete")).toHaveLength(0);
	});

	it("a delete of a live machine moves it to deleting first", async () => {
		const w = await createWorld(db);
		const id = await warmMachine(w);
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "delete" }),
		).toBe("done");
		await expectGone(w, id);
	});

	it("locks a sandbox machine's sandbox row first and deletes it", async () => {
		const w = await createWorld(db);
		const sandboxId = await insertSandbox(w, { state: "error" });
		const id = await insertMachine(w, {
			poolKey: null,
			sandboxId,
			state: "failed",
		});
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "delete" }),
		).toBe("done");
		expect((await machine(w, id)).state).toBe("deleted");
	});

	it("delete wins over a provision stuck inside S1 create", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w);
		const blocked = blockAfter(w.infra, "create");
		w.useInfra(blocked.port);
		const provision = handleMachineOp(w.ctx, {
			machineId: id,
			action: "provision",
		});
		await blocked.reached;

		// The pool controller (or admit eviction) decides to delete it.
		await w.pool.query(
			"UPDATE runtime.machines SET state = 'deleting' WHERE id = $1",
			[id],
		);
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "delete" }),
		).toBe("done");

		blocked.release();
		expect(await provision).toBe("fenced_out");
		await w.agentWorld.settled();
		await expectGone(w, id);
		expect(w.infra.callsOf("start")).toHaveLength(0);
		// A late provision job cannot start again either.
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).toBe("skipped");
		expect((await machine(w, id)).state).toBe("deleted");
	});
});
