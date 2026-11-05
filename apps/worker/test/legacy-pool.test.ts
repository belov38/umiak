import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMachineOp } from "../src/handlers/machine-op.ts";
import { nodeRam } from "../src/node-ram.ts";
import { createWorld, insertMachine, machine } from "./fakes/world.ts";
import { createSandbox, opsEnv, row, run } from "./helpers/ops.ts";

let db: TestDatabase;
beforeAll(async () => {
	db = await createTestDatabase();
});
afterAll(async () => {
	await db?.drop();
});

describe("legacy pool quarantine", () => {
	it("ignores persisted provision and eviction-delete jobs, retaining RAM and reporting the row", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w);
		await w.pool.query("UPDATE runtime.machines SET state='warm' WHERE id=$1", [
			id,
		]);
		const before = await machine(w, id);
		for (const action of ["provision", "delete"] as const) {
			expect(await handleMachineOp(w.ctx, { machineId: id, action })).toBe(
				"skipped",
			);
		}
		expect(await machine(w, id)).toEqual(before);
		expect(w.infra.callsOf("create")).toHaveLength(0);
		expect(w.infra.callsOf("delete")).toHaveLength(0);
		const status = (await nodeRam(w.pool)).find(
			(n) => n.nodeId === w.topo.nodeId,
		);
		expect(status).toMatchObject({
			quarantinedMachines: 1,
			reservedMb: 2048,
			poweredMb: 2048,
		});
	});
	it("does not let an old provision job mutate or destroy an allocated cold VM with pool metadata", async () => {
		const w = await createWorld(db);
		const { sandboxId, operationId } = await createSandbox(w, opsEnv(w));
		expect(await run(w, operationId)).toBe("succeeded");
		const s = await row(w, "sandboxes", sandboxId);
		const id = s.machine_id as string;
		await w.pool.query(
			"UPDATE runtime.machines SET pool_key='linux/2gb' WHERE id=$1",
			[id],
		);
		const before = await machine(w, id);
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).toBe("skipped");
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "delete" }),
		).toBe("skipped");
		expect(await machine(w, id)).toEqual(before);
		expect(w.infra.callsOf("delete")).toHaveLength(0);
		expect(
			(await nodeRam(w.pool)).find((n) => n.nodeId === w.topo.nodeId)
				?.quarantinedMachines,
		).toBe(0);
	});
});
