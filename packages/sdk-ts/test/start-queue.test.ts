import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Umiak } from "../src/index.ts";
import { capacityWaitOptions } from "../src/sandbox.ts";
import { startTestApi, type TestApi } from "./helpers/api.ts";

let db: TestDatabase;
let api: TestApi;
let u: Umiak;
beforeAll(async () => {
	db = await createTestDatabase();
	api = await startTestApi(db);
	u = new Umiak({ baseUrl: api.url, apiKey: api.secret, fetch: api.fetch });
	await db.pool.query("UPDATE runtime.nodes SET ram_cap_mb=0 WHERE id=$1", [
		api.env.topo.nodeId,
	]);
});
afterAll(async () => {
	await api?.close();
	await db?.drop();
});
it("exposes queued admission and cancellation via the facade", async () => {
	const sb = await u.sandboxes.create({ capacityWaitSeconds: 6000 });
	expect(sb.data.state).toBe("queued");
	expect(sb.data.activeOperation?.progress).toMatchObject({ phase: "queued" });
	expect((await sb.cancelStart()).error?.code).toBe("cancelled");
	expect(sb.data.state).toBe("error");
});
it("preserves retryable out_of_capacity when a readiness wait reaches queue timeout", async () => {
	const sb = await u.sandboxes.create({ capacityWaitSeconds: 1 });
	const ticket = (
		await db.pool.query(
			"SELECT operation_id FROM runtime.start_queue q JOIN runtime.operations o ON o.id=q.operation_id JOIN runtime.sandboxes s ON s.id=o.sandbox_id WHERE s.slug=$1",
			[sb.slug],
		)
	).rows[0];
	await db.pool.query(
		"UPDATE runtime.start_queue SET deadline_at=now()-interval '1 second' WHERE operation_id=$1",
		[ticket.operation_id],
	);
	const { expireQueuedStart } = await import("@umiak/core");
	await expireQueuedStart(
		{
			pool: db.pool,
			config: api.env.config,
			keys: api.env.keys,
			jobs: api.env.jobs,
		},
		ticket.operation_id,
	);
	await expect(sb.waitUntilReady()).rejects.toMatchObject({
		code: "out_of_capacity",
		retryable: true,
	});
});
it("adds the capacity budget to client readiness waits while respecting explicit limits", () => {
	expect(capacityWaitOptions({ wait: true }, 6000).waitTimeoutMs).toBe(6300000);
	expect(
		capacityWaitOptions({ wait: true, waitTimeoutMs: 42 }, 6000).waitTimeoutMs,
	).toBe(42);
});
