import { withTx } from "@umiak/db";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cancelQueuedStart,
	nodeRam,
	tryAdmitQueuedStart,
} from "../src/index.ts";
import { machineRow, seedSandbox, serviceEnv } from "./helpers/service.ts";
import { insertMachine } from "./helpers/topology.ts";

let db: TestDatabase;
beforeAll(async () => {
	db = await createTestDatabase();
});
afterAll(async () => {
	await db?.drop();
});
async function full() {
	const env = await serviceEnv(db.pool, {
		topology: { node: { ramCapMb: 2048 } },
	});
	const blocker = await insertMachine(db.pool, env.topo, {
		state: "running",
		memoryMb: 2048,
	});
	return { env, blocker };
}

describe("durable capacity waits", () => {
	it("queues create idempotently without reserving RAM or persisting raw secrets", async () => {
		const { env } = await full();
		const input = {
			template: env.template,
			capacityWaitSeconds: 6000,
			secrets: { MARKER: "queue-secret-marker" },
		};
		const first = await env.svc.create(env.p, input, "queue-idem");
		const replay = await env.svc.create(env.p, input, "queue-idem");
		expect(replay.sandbox.id).toBe(first.sandbox.id);
		expect(first.operation.progress.phase).toBe("queued");
		expect(
			(await machineRow(db.pool, first.sandbox.machineId as string))?.state,
		).toBe("stopped");
		const ram = await withTx(db.pool, (tx) => nodeRam(tx, env.topo.nodeId));
		expect(ram.reservedMb).toBe(2048);
		const tickets = (
			await db.pool.query(
				"SELECT * FROM runtime.start_queue WHERE team_id=$1",
				[env.p.teamId],
			)
		).rows;
		expect(tickets).toHaveLength(1);
		expect(JSON.stringify(tickets)).not.toContain("queue-secret-marker");
	});
	it("admits FIFO after RAM frees and retains the original deadline across retries", async () => {
		const { env, blocker } = await full();
		const first = await env.svc.create(env.p, {
			template: env.template,
			capacityWaitSeconds: 6000,
		});
		const second = await env.svc.create(env.p, {
			template: env.template,
			capacityWaitSeconds: 6000,
		});
		const deadline = (
			await db.pool.query(
				"SELECT deadline_at FROM runtime.start_queue WHERE operation_id=$1",
				[first.operation.id],
			)
		).rows[0]?.deadline_at;
		expect(
			await tryAdmitQueuedStart({ ...env, pool: db.pool }, second.operation.id),
		).toBe("waiting");
		expect(
			await tryAdmitQueuedStart({ ...env, pool: db.pool }, first.operation.id),
		).toBe("waiting");
		expect(
			(
				await db.pool.query(
					"SELECT deadline_at FROM runtime.start_queue WHERE operation_id=$1",
					[first.operation.id],
				)
			).rows[0]?.deadline_at,
		).toEqual(deadline);
		await db.pool.query(
			"UPDATE runtime.machines SET state='stopped',power_observed='stopped' WHERE id=$1",
			[blocker],
		);
		expect(
			await tryAdmitQueuedStart({ ...env, pool: db.pool }, second.operation.id),
		).toBe("waiting");
		expect(
			await tryAdmitQueuedStart({ ...env, pool: db.pool }, first.operation.id),
		).toBe("admitted");
		expect(
			await tryAdmitQueuedStart({ ...env, pool: db.pool }, second.operation.id),
		).toBe("waiting");
	});
	it("cancels queued resume without starting it, and never admits a stale ticket", async () => {
		const { env } = await full();
		const source = await seedSandbox(db.pool, env, { state: "stopped" });
		const op = await env.svc.resume(env.p, source.sandboxId, {
			capacityWaitSeconds: 6000,
		});
		expect(op.progress.phase).toBe("queued");
		const cancelled = await cancelQueuedStart(
			{ pool: db.pool, config: env.config, keys: env.keys, jobs: env.jobs },
			env.p,
			source.sandboxId,
		);
		expect(cancelled.state).toBe("failed");
		expect(cancelled.errorCode).toBe("cancelled");
		expect(await tryAdmitQueuedStart({ ...env, pool: db.pool }, op.id)).toBe(
			"not_queued",
		);
		expect((await env.svc.get(env.p, source.sandboxId)).state).toBe("stopped");
	});
});

describe("queue ordering and durable termination", () => {
	it("does not overcommit under concurrent admission and does not let a fail-fast request bypass FIFO", async () => {
		const { env, blocker } = await full();
		const first = await env.svc.create(env.p, {
			template: env.template,
			capacityWaitSeconds: 6000,
		});
		const second = await env.svc.create(env.p, {
			template: env.template,
			capacityWaitSeconds: 6000,
		});
		await db.pool.query(
			"UPDATE runtime.machines SET state='stopped',power_observed='stopped' WHERE id=$1",
			[blocker],
		);
		await expect(
			env.svc.create(env.p, { template: env.template }),
		).rejects.toMatchObject({ code: "out_of_capacity" });
		const results = await Promise.all(
			[first, second, first].map((r) =>
				tryAdmitQueuedStart({ ...env, pool: db.pool }, r.operation.id),
			),
		);
		expect(results.filter((r) => r === "admitted")).toHaveLength(1);
		expect(
			await withTx(db.pool, (tx) => nodeRam(tx, env.topo.nodeId)),
		).toMatchObject({ reservedMb: 2048 });
	});
	it("a blocked large head holds its own team while another team makes progress", async () => {
		const { env, blocker } = await full();
		const large = await env.svc.create(env.p, {
			template: env.template,
			size: "4gb",
			capacityWaitSeconds: 6000,
		});
		const small = await env.svc.create(env.p, {
			template: env.template,
			capacityWaitSeconds: 6000,
		});
		await db.pool.query(
			"UPDATE runtime.machines SET state='stopped',power_observed='stopped' WHERE id=$1",
			[blocker],
		);
		expect(
			await tryAdmitQueuedStart({ ...env, pool: db.pool }, large.operation.id),
		).toBe("waiting");
		expect(
			await tryAdmitQueuedStart({ ...env, pool: db.pool }, small.operation.id),
		).toBe("waiting");
		const other = {
			...env.p,
			teamId: crypto.randomUUID(),
			apiKeyId: crypto.randomUUID(),
		};
		const admitted = await env.svc.create(other, {
			template: env.template,
			capacityWaitSeconds: 6000,
		});
		expect(admitted.operation.progress.phase).not.toBe("queued");
	});
	it("expires a queued resume back to stopped with the same timeout code and permits idempotent cancellation", async () => {
		const { env } = await full();
		const source = await seedSandbox(db.pool, env, { state: "stopped" });
		const op = await env.svc.resume(env.p, source.sandboxId, {
			capacityWaitSeconds: 60,
		});
		await db.pool.query(
			"UPDATE runtime.start_queue SET deadline_at=now()-interval '1 second' WHERE operation_id=$1",
			[op.id],
		);
		const { expireQueuedStart } = await import("../src/index.ts");
		await expireQueuedStart({ ...env, pool: db.pool }, op.id);
		expect(await env.svc.getOperation(env.p, op.id)).toMatchObject({
			state: "failed",
			errorCode: "out_of_capacity",
			retryable: true,
		});
		expect(await env.svc.get(env.p, source.sandboxId)).toMatchObject({
			state: "stopped",
			errorCode: "out_of_capacity",
		});
		expect(await tryAdmitQueuedStart({ ...env, pool: db.pool }, op.id)).toBe(
			"not_queued",
		);
		const next = await env.svc.resume(env.p, source.sandboxId, {
			capacityWaitSeconds: 60,
		});
		expect((await env.svc.cancelQueuedStart(env.p, source.sandboxId)).id).toBe(
			next.id,
		);
		expect((await env.svc.cancelQueuedStart(env.p, source.sandboxId)).id).toBe(
			next.id,
		);
	});
});
