import { DELETE_RETRY_LIMIT } from "@sbx/core";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMachineOp } from "../src/handlers/machine-op.ts";
import {
	DeadlineExceeded,
	deadlinePassed,
	Fenced,
	FencedOut,
	runSteps,
} from "../src/steps.ts";
import { waitUntil } from "../src/wait.ts";
import { blockAfter, blockBefore } from "./fakes/crash.ts";
import {
	createWorld,
	insertMachine,
	insertOperation,
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

async function op(w: TestWorld, id: string): Promise<Record<string, unknown>> {
	const r = await w.pool.query(
		"SELECT * FROM runtime.operations WHERE id = $1",
		[id],
	);
	return r.rows[0];
}

describe("machine-op fencing", () => {
	it("a stale executor stuck in S1 create is fenced out on its next write and never starts the VM", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w);
		const blocked = blockAfter(w.infra, "create");
		w.useInfra(blocked.port);

		const a = handleMachineOp(w.ctx, { machineId: id, action: "provision" });
		await blocked.reached;
		const vmOfA = w.infra.vmsOf(id)[0]?.vmid;
		expect(vmOfA).toBeDefined();

		// The job came back (heartbeat lost): executor B takes over (exec_attempt + 1).
		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).toBe("done");
		await w.agentWorld.settled();
		const afterB = await machine(w, id);
		expect(afterB.exec_attempt).toBe(2);
		expect(afterB.state).toBe("warm");

		blocked.release();
		expect(await a).toBe("fenced_out");
		expect(w.metrics.count("sbx_fenced_out_total")).toBe(1);

		// Only B started a VM; A's VM was thrown away by B through the lease.
		expect(w.infra.callsOf("start").map((c) => c.args[0])).toEqual([
			afterB.vmid,
		]);
		expect(w.infra.vms.size).toBe(1);
		expect(w.infra.vmsOf(id)[0]?.vmid).toBe(afterB.vmid);
		expect(await leases(w)).toEqual([
			{ vmid: afterB.vmid, state: "active", machine_id: id },
		]);
		const m = await machine(w, id);
		expect(m.state).toBe("warm");
		expect(m.vmid).toBe(afterB.vmid);
	});
});

describe("machine-op fencing before S1 create allocates", () => {
	it("a stale executor that passed its fence check gets the new executor's lease, fails and is fenced out", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w);
		const blocked = blockBefore(w.infra, "create");
		w.useInfra(blocked.port);

		const a = handleMachineOp(w.ctx, { machineId: id, action: "provision" });
		await blocked.reached;
		expect(w.infra.vms.size).toBe(0);

		expect(
			await handleMachineOp(w.ctx, { machineId: id, action: "provision" }),
		).toBe("done");
		await w.agentWorld.settled();
		const afterB = await machine(w, id);
		expect(afterB.state).toBe("warm");

		// A's allocate returns B's lease (same owner); its VM exists, so S1
		// create fails without rolling back, and A's failure handling is fenced.
		blocked.release();
		expect(await a).toBe("fenced_out");
		expect(w.infra.callsOf("create")).toHaveLength(2);
		expect(w.infra.callsOf("delete")).toHaveLength(0);
		expect(w.infra.callsOf("start").map((c) => c.args[0])).toEqual([
			afterB.vmid,
		]);
		expect(w.infra.vms.size).toBe(1);
		expect(w.infra.vmsOf(id)[0]?.status).toBe("running");
		expect(await leases(w)).toEqual([
			{ vmid: afterB.vmid, state: "active", machine_id: id },
		]);
		const m = await machine(w, id);
		expect(m.state).toBe("warm");
		expect(m.error_code).toBeNull();
		expect(w.metrics.count("sbx_machine_provision_failed_total")).toBe(0);
	});
});

describe("Fenced (operations.attempt)", () => {
	async function sandboxWithOp(
		w: TestWorld,
		o: Partial<Parameters<typeof insertOperation>[1]> = {},
	): Promise<{ sandboxId: string; opId: string }> {
		const sandboxId = await insertSandbox(w);
		const opId = await insertOperation(w, { sandboxId, ...o });
		return { sandboxId, opId };
	}

	it("begin: pending -> running and attempt + 1; a second begin fences the first out", async () => {
		const w = await createWorld(db);
		const { opId } = await sandboxWithOp(w);

		const a = await Fenced.begin(w.ctx, opId);
		expect(a?.attempt).toBe(1);
		expect((await op(w, opId)).state).toBe("running");
		expect((await op(w, opId)).started_at).not.toBeNull();
		await a?.recordStep("provision", { vmid: 500 });

		const b = await Fenced.begin(w.ctx, opId);
		expect(b?.attempt).toBe(2);
		expect(b?.op.step).toBe("provision");

		await expect(a?.recordStep("boot")).rejects.toBeInstanceOf(FencedOut);
		await expect(a?.check()).rejects.toBeInstanceOf(FencedOut);
		await expect(a?.finish("succeeded")).rejects.toBeInstanceOf(FencedOut);

		await b?.recordStep("boot", { bootId: "x" });
		const row = await op(w, opId);
		expect(row.step).toBe("boot");
		expect(row.progress).toEqual({ vmid: 500, bootId: "x" });
		await b?.finish("failed", { code: "create_failed", message: "no" });
		const done = await op(w, opId);
		expect(done.state).toBe("failed");
		expect(done.error_code).toBe("create_failed");
		expect(done.retryable).toBe(false);
		expect(done.finished_at).not.toBeNull();

		expect(await Fenced.begin(w.ctx, opId)).toBeNull();
	});

	it("superseded by a delete: check and waits leave with FencedOut", async () => {
		const w = await createWorld(db);
		const { opId } = await sandboxWithOp(w);
		const f = await Fenced.begin(w.ctx, opId);
		if (!f) throw new Error("no fence");
		const wait = waitUntil(w.ctx, f, async () => undefined, {
			timeoutMs: 5000,
			pollMs: 5,
		});
		await w.pool.query(
			"UPDATE runtime.operations SET state = 'superseded' WHERE id = $1",
			[opId],
		);
		await expect(wait).rejects.toBeInstanceOf(FencedOut);
		await expect(f.recordStep("x")).rejects.toBeInstanceOf(FencedOut);
	});

	it("a child waits for its parent and fails with fork_failed when the parent fails", async () => {
		const w = await createWorld(db);
		const source = await insertSandbox(w, { state: "ready" });
		const forkOp = await insertOperation(w, {
			sandboxId: source,
			kind: "fork",
			state: "running",
		});
		const target = await insertSandbox(w, { origin: "fork" });
		const machineId = await insertMachine(w, {
			poolKey: null,
			sandboxId: target,
		});
		const child = await insertOperation(w, {
			sandboxId: target,
			parentOperationId: forkOp,
			deadlineInS: null,
		});

		expect(await Fenced.begin(w.ctx, child)).toBeNull();
		expect((await op(w, child)).state).toBe("pending");
		expect((await op(w, child)).attempt).toBe(0);

		await w.pool.query(
			"UPDATE runtime.operations SET state = 'failed' WHERE id = $1",
			[forkOp],
		);
		expect(await Fenced.begin(w.ctx, child)).toBeNull();
		const c = await op(w, child);
		expect(c.state).toBe("failed");
		expect(c.error_code).toBe("fork_failed");
		const s = await w.pool.query(
			"SELECT state, error_code FROM runtime.sandboxes WHERE id = $1",
			[target],
		);
		expect(s.rows[0]).toEqual({ state: "error", error_code: "fork_failed" });
		const ev = await w.pool.query(
			"SELECT reason, to_state FROM runtime.sandbox_events WHERE sandbox_id = $1",
			[target],
		);
		expect(ev.rows).toEqual([{ reason: "fork_failed", to_state: "error" }]);
		expect((await machine(w, machineId)).state).toBe("deleting");
		expect(w.jobs.sent).toContainEqual({
			queue: "machine-op",
			data: { machineId, action: "delete" },
			opts: { singletonKey: machineId, retryLimit: DELETE_RETRY_LIMIT },
		});
	});

	it("a child whose parent succeeded begins; a NULL deadline is not passed", async () => {
		const w = await createWorld(db);
		const source = await insertSandbox(w, { state: "ready" });
		const forkOp = await insertOperation(w, {
			sandboxId: source,
			kind: "fork",
			state: "succeeded",
		});
		const target = await insertSandbox(w, { origin: "fork" });
		const child = await insertOperation(w, {
			sandboxId: target,
			parentOperationId: forkOp,
			deadlineInS: null,
		});
		const f = await Fenced.begin(w.ctx, child);
		expect(f?.attempt).toBe(1);
		expect(f?.deadlinePassed()).toBe(false);
	});

	it("deadlinePassed", () => {
		const now = new Date("2026-10-29T12:00:00Z");
		expect(deadlinePassed({ deadlineAt: null }, now)).toBe(false);
		expect(
			deadlinePassed({ deadlineAt: new Date("2026-10-29T11:59:59Z") }, now),
		).toBe(true);
		expect(
			deadlinePassed({ deadlineAt: new Date("2026-10-29T12:00:01Z") }, now),
		).toBe(false);
	});

	it("runSteps resumes after the recorded step, records skipped steps and stops at the deadline", async () => {
		const w = await createWorld(db);
		const { opId } = await sandboxWithOp(w, { step: "a" });
		const f = await Fenced.begin(w.ctx, opId);
		if (!f) throw new Error("no fence");
		const ran: string[] = [];
		await runSteps(f, [
			{ name: "a", run: async () => void ran.push("a") },
			{
				name: "b",
				skipIf: async () => true,
				run: async () => void ran.push("b"),
			},
			{ name: "c", run: async () => ({ c: 1 }) },
		]);
		expect(ran).toEqual([]);
		const row = await op(w, opId);
		expect(row.step).toBe("c");
		expect(row.progress).toEqual({ c: 1 });

		const late = await sandboxWithOp(w, { deadlineInS: -5 });
		const g = await Fenced.begin(w.ctx, late.opId);
		if (!g) throw new Error("no fence");
		await expect(
			runSteps(g, [{ name: "a", run: async () => void ran.push("late") }]),
		).rejects.toBeInstanceOf(DeadlineExceeded);
		expect(ran).toEqual([]);
	});

	it("runSteps stops before the next step once fenced out", async () => {
		const w = await createWorld(db);
		const { opId } = await sandboxWithOp(w);
		const f = await Fenced.begin(w.ctx, opId);
		if (!f) throw new Error("no fence");
		const ran: string[] = [];
		await expect(
			runSteps(f, [
				{
					name: "a",
					run: async () => {
						ran.push("a");
						await Fenced.begin(w.ctx, opId);
					},
				},
				{ name: "b", run: async () => void ran.push("b") },
			]),
		).rejects.toBeInstanceOf(FencedOut);
		expect(ran).toEqual(["a"]);
	});
});
