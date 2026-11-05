import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runStartQueue } from "../src/controllers/start-queue.ts";
import { createWorld } from "./fakes/world.ts";
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
describe("capacity queue execution", () => {
	it("waits without starting and admits after stop frees RAM, even after a controller restart", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const source = await stoppedSandbox(w, e);
		const blocker = await readySandbox(w, e);
		await w.pool.query("UPDATE runtime.nodes SET ram_cap_mb=2048 WHERE id=$1", [
			w.topo.nodeId,
		]);
		const op = await e.svc.resume(e.p, source.sandboxId, {
			capacityWaitSeconds: 6000,
		});
		expect(await run(w, op.id)).toBe("queued");
		expect((await row(w, "machines", source.machineId)).power_observed).toBe(
			"stopped",
		);
		const stop = await e.svc.stop(e.p, blocker.sandboxId);
		expect(await run(w, stop.id)).toBe("succeeded");
		await runStartQueue({ ...w.ctx });
		expect(await run(w, op.id)).toBe("succeeded");
		expect((await row(w, "sandboxes", source.sandboxId)).state).toBe("ready");
	});
	it("expires an unadmitted create with retryable out_of_capacity and never creates a VM", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		await w.pool.query("UPDATE runtime.nodes SET ram_cap_mb=0 WHERE id=$1", [
			w.topo.nodeId,
		]);
		const created = await e.svc.create(e.p, {
			template: w.topo.templateSlug,
			capacityWaitSeconds: 60,
		});
		expect(await run(w, created.operation.id)).toBe("queued");
		await w.pool.query(
			"UPDATE runtime.start_queue SET deadline_at=now()-interval '1 second' WHERE operation_id=$1",
			[created.operation.id],
		);
		await runStartQueue(w.ctx);
		expect(await row(w, "operations", created.operation.id)).toMatchObject({
			state: "failed",
			error_code: "out_of_capacity",
			retryable: true,
		});
		expect(
			await row(w, "machines", created.sandbox.machineId as string),
		).toMatchObject({ state: "failed", vmid: null });
		expect(await run(w, created.operation.id)).not.toBe("succeeded");
	});
});

it("a queued fork retains its timeout after hand-off and cancellation before hand-off does not disturb its source", async () => {
	const w = await createWorld(db);
	const e = opsEnv(w);
	const source = await stoppedSandbox(w, e);
	await w.pool.query("UPDATE runtime.nodes SET ram_cap_mb=0 WHERE id=$1", [
		w.topo.nodeId,
	]);
	const f = await e.svc.fork(e.p, source.sandboxId, {
		capacityWaitSeconds: 6000,
	});
	expect(await run(w, f.operation.id)).toBe("skipped");
	const deadline = (await row(w, "operations", f.operation.id)).deadline_at;
	expect(await run(w, f.sourceOperation.id)).toBe("succeeded");
	expect((await row(w, "operations", f.operation.id)).deadline_at).toEqual(
		deadline,
	);
	expect(await run(w, f.operation.id)).toBe("queued");
	await e.svc.cancelQueuedStart(e.p, f.sandbox.id);
	const second = await e.svc.fork(e.p, source.sandboxId, {
		capacityWaitSeconds: 6000,
	});
	await e.svc.cancelQueuedStart(e.p, second.sandbox.id);
	expect(await run(w, second.sourceOperation.id)).toBe("succeeded");
	expect((await row(w, "sandboxes", source.sandboxId)).state).toBe("stopped");
	expect((await row(w, "operations", second.operation.id)).error_code).toBe(
		"cancelled",
	);
	expect(
		(
			await w.pool.query(
				"SELECT state FROM runtime.snapshots WHERE consumer_sandbox_id=$1",
				[second.sandbox.id],
			)
		).rows,
	).toEqual([{ state: "deleted" }]);
});
