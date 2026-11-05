import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

let db: TestDatabase;
let w: ApiWorld;
beforeAll(async () => {
	db = await createTestDatabase();
	w = await apiWorld(db.pool, { topology: { node: { ramCapMb: 0 } } });
});
afterAll(async () => {
	await w?.close();
	await db?.drop();
});
it("returns a public queued state and progress, and cancellation is idempotent", async () => {
	const h = w.harness();
	const r = await h.request("POST", "/v1/sandboxes", {
		json: { capacityWaitSeconds: 6000 },
	});
	expect(r.status).toBe(202);
	const data = r.body as {
		sandbox: { id: string; state: string };
		operation: {
			state: string;
			progress: { phase: string; queuedUntil: string };
		};
	};
	expect(data.sandbox.state).toBe("queued");
	expect(data.operation.state).toBe("queued");
	expect(data.operation.progress).toMatchObject({ phase: "queued" });
	expect(Date.parse(data.operation.progress.queuedUntil)).toBeGreaterThan(
		Date.now(),
	);
	const cancelled = await h.request(
		"POST",
		`/v1/sandboxes/${data.sandbox.id}/cancel-start`,
	);
	expect(cancelled.status).toBe(202);
	expect(cancelled.body).toMatchObject({
		sandbox: { state: "error" },
		operation: {
			state: "failed",
			error: { code: "cancelled", retryable: false },
		},
	});
	expect(
		(await h.request("POST", `/v1/sandboxes/${data.sandbox.id}/cancel-start`))
			.status,
	).toBe(202);
});
