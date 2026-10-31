// The worker on Payload (S8 plan decision 5): templates, sizes, quotas and
// defaults come from PayloadConfigReader, and /readyz waits for the Payload
// migrations (assertPayloadMigrated) as for the runtime ones.
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { migrateSbxPayload } from "@sbx/payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openWorkerPayload, type WorkerPayload } from "../src/payload.ts";
import { createWorker, type Worker } from "../src/worker.ts";
import { FakeInfraRegistry } from "./fakes/infra.ts";
import {
	getText,
	testKeys,
	testLogger,
	until,
	workerOptions,
} from "./helpers/worker.ts";

describe.skipIf(skipPg())("worker with Payload", () => {
	let db: TestDatabase;
	let wp: WorkerPayload | undefined;
	let worker: Worker | undefined;

	beforeAll(async () => {
		db = await createTestDatabase();
	});
	afterAll(async () => {
		await worker?.stop({ graceful: false });
		await wp?.close();
		await db?.drop();
	});

	it("/readyz says payload_migrations until they are applied; config is the Payload seed", async () => {
		const { log } = testLogger("warn");
		wp = await openWorkerPayload({
			databaseUrl: db.url,
			secret: "worker-payload-secret-0123456789",
			log,
		});
		const p = wp;
		worker = createWorker(
			workerOptions(db.pool, {
				infra: new FakeInfraRegistry(),
				config: p.config,
				keys: testKeys(),
				payloadReady: () => p.ready(),
				httpPort: 0,
				httpHost: "127.0.0.1",
				controllers: [],
			}),
		);
		const w = worker;
		await w.start();
		const port = await until(() => w.httpPort, { what: "http listening" });
		const base = `http://127.0.0.1:${port}`;

		const notReady = await getText(`${base}/readyz`);
		expect(notReady.status).toBe(503);
		const body = JSON.parse(notReady.body) as { reasons: string[] };
		expect(body.reasons).toHaveLength(1);
		expect(body.reasons[0]).toMatch(/^payload_migrations: /);

		await migrateSbxPayload(p.payload, () => {});
		const ready = await getText(`${base}/readyz`);
		expect(ready.status).toBe(200);
		expect(JSON.parse(ready.body)).toEqual({ ready: true, reasons: [] });

		// The initial Payload migration seeds template linux and size 2gb.
		const t = await w.ctx.config.template("linux");
		expect(t).toMatchObject({ slug: "linux", defaultSize: "2gb" });
		expect((await w.ctx.config.sizes()).map((s) => s.slug)).toEqual(["2gb"]);
	});
});
