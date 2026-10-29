import { randomUUID } from "node:crypto";
import { ingestAgentEvents } from "@sbx/core";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMachineEvents } from "../src/handlers/machine-events.ts";
import {
	createWorld,
	insertMachine,
	insertSandbox,
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

function phase(seq: number, bootId: string, p: string) {
	return {
		seq,
		bootId,
		type: "phase",
		time: new Date(),
		payload: { phase: p },
	};
}

async function unprocessed(w: TestWorld, machineId: string): Promise<number> {
	const r = await w.pool.query<{ n: number }>(
		`SELECT (SELECT count(*) FROM runtime.agent_events WHERE machine_id = $1 AND processed_at IS NULL)
		      + (SELECT count(*) FROM runtime.agent_synthetic_events WHERE machine_id = $1 AND processed_at IS NULL)
		      AS n`,
		[machineId],
	);
	return Number(r.rows[0]?.n);
}

describe("machine-events (connected, phase)", () => {
	it("pool_ready moves a booting pool machine to warm and records ready_boot_id", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w, { state: "booting" });
		const bootId = randomUUID();
		await ingestAgentEvents(w.pool, w.jobs, {
			machineId: id,
			events: [
				phase(1, bootId, "pool_ready"),
				{
					seq: 2,
					bootId,
					type: "agent.started",
					time: new Date(),
					payload: {},
				},
			],
			synthetic: [
				{ epoch: 1, type: "connected", instanceId: "gw", time: new Date() },
			],
		});

		expect(await handleMachineEvents(w.ctx, { machineId: id })).toEqual({
			processed: 3,
		});
		const m = await machine(w, id);
		expect(m.state).toBe("warm");
		expect(m.warm_at).not.toBeNull();
		expect(m.ready_boot_id).toBe(bootId);
		expect(m.agent_phase).toBe("pool_ready");
		expect(await unprocessed(w, id)).toBe(0);

		// Redelivery and a duplicate batch change nothing.
		await ingestAgentEvents(w.pool, w.jobs, {
			machineId: id,
			events: [phase(1, bootId, "pool_ready")],
			synthetic: [],
		});
		expect(await handleMachineEvents(w.ctx, { machineId: id })).toEqual({
			processed: 0,
		});
		const again = await machine(w, id);
		expect(again.state).toBe("warm");
		expect(again.version).toBe(m.version);
	});

	it("a sandbox machine in booting only records the boot; later phases update agent_phase", async () => {
		const w = await createWorld(db);
		const sandboxId = await insertSandbox(w);
		const id = await insertMachine(w, {
			state: "booting",
			poolKey: null,
			sandboxId,
		});
		const bootId = randomUUID();
		await ingestAgentEvents(w.pool, w.jobs, {
			machineId: id,
			events: [
				phase(1, bootId, "pool_ready"),
				phase(2, bootId, "secrets_missing"),
			],
			synthetic: [],
		});
		await handleMachineEvents(w.ctx, { machineId: id });
		const m = await machine(w, id);
		expect(m.state).toBe("booting");
		expect(m.ready_boot_id).toBe(bootId);
		expect(m.agent_phase).toBe("secrets_missing");
	});

	it("connected clears degraded health with a recovered event", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w, { state: "running", poolKey: null });
		const sandboxId = await insertSandbox(w, {
			state: "ready",
			machineId: id,
			health: "degraded",
		});
		await w.pool.query(
			"UPDATE runtime.machines SET sandbox_id = $2 WHERE id = $1",
			[id, sandboxId],
		);
		await ingestAgentEvents(w.pool, w.jobs, {
			machineId: id,
			events: [],
			synthetic: [
				{ epoch: 3, type: "connected", instanceId: "gw", time: new Date() },
			],
		});
		await handleMachineEvents(w.ctx, { machineId: id });
		const s = await w.pool.query(
			"SELECT health, degraded_since FROM runtime.sandboxes WHERE id = $1",
			[sandboxId],
		);
		expect(s.rows[0]).toEqual({ health: "ok", degraded_since: null });
		const ev = await w.pool.query(
			"SELECT type FROM runtime.sandbox_events WHERE sandbox_id = $1",
			[sandboxId],
		);
		expect(ev.rows).toEqual([{ type: "recovered" }]);
		expect(await unprocessed(w, id)).toBe(0);
	});

	it("events of an unknown machine are marked processed", async () => {
		const w = await createWorld(db);
		const id = randomUUID();
		await ingestAgentEvents(w.pool, w.jobs, {
			machineId: id,
			events: [phase(1, "b", "pool_ready")],
			synthetic: [],
		});
		expect(await handleMachineEvents(w.ctx, { machineId: id })).toEqual({
			processed: 1,
		});
		expect(await unprocessed(w, id)).toBe(0);
	});
});
