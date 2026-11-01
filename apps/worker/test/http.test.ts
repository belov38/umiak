import { migrate } from "@umiak/db";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorker, type Worker } from "../src/worker.ts";
import { FakeInfraRegistry } from "./fakes/infra.ts";
import {
	getText,
	testConfig,
	testKeys,
	until,
	workerOptions,
} from "./helpers/worker.ts";

describe("worker HTTP: health, readiness, metrics", () => {
	let db: TestDatabase;
	let worker: Worker | undefined;

	beforeAll(async () => {
		db = await createTestDatabase({ migrated: false });
	});
	afterAll(async () => {
		await worker?.stop();
		await db?.drop();
	});

	it("/readyz is 503 until migrations are applied, then 200; /metrics has umiak_delete_stuck", async () => {
		worker = createWorker(
			workerOptions(db.pool, {
				infra: new FakeInfraRegistry(),
				config: testConfig("linux"),
				keys: testKeys(),
				httpPort: 0,
				httpHost: "127.0.0.1",
				migrateOnStart: false,
				migrationWaitPollMs: 50,
				controllers: [],
			}),
		);
		const w = worker;
		const started = w.start();
		const port = await until(() => w.httpPort, { what: "http listening" });
		const base = `http://127.0.0.1:${port}`;

		const notReady = await getText(`${base}/readyz`);
		expect(notReady.status).toBe(503);
		const reason = JSON.parse(notReady.body) as {
			ready: boolean;
			reasons: string[];
		};
		expect(reason.ready).toBe(false);
		expect(reason.reasons.join(" ")).toMatch(/migrations pending/);
		expect(reason.reasons.join(" ")).toMatch(/pg-boss not started/);

		const live = await getText(`${base}/healthz`);
		expect(live.status).toBe(200);

		await migrate(db.pool);
		await started;

		const ready = await getText(`${base}/readyz`);
		expect(ready.status).toBe(200);
		expect(JSON.parse(ready.body)).toEqual({ ready: true, reasons: [] });

		const metrics = await getText(`${base}/metrics`);
		expect(metrics.status).toBe(200);
		expect(metrics.type).toMatch(/text\/plain/);
		expect(metrics.body).toMatch(/^umiak_delete_stuck 0$/m);
		expect(metrics.body).toMatch(/umiak_queue_depth\{queue="sandbox-op"\} 0/);
		expect(metrics.body).toMatch(/^umiak_degraded_sandboxes 0$/m);
		expect(metrics.body).toMatch(/^umiak_event_lag_seconds 0$/m);

		const missing = await getText(`${base}/nope`);
		expect(missing.status).toBe(404);

		await w.stop();
		worker = undefined;
		await expect(fetch(`${base}/healthz`)).rejects.toThrow();
	});
});
