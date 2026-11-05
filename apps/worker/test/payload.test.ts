// The worker on Payload (S8 plan decision 5): templates, sizes, quotas and
// defaults come from PayloadConfigReader, and /readyz waits for the Payload
// migrations (assertPayloadMigrated) as for the runtime ones.

import type { PgConfigReader } from "@umiak/config";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openWorkerConfig } from "../src/config.ts";
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
	let wp: PgConfigReader | undefined;
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
		wp = await openWorkerConfig(db.pool, db.url, log);
		await db.pool.query(
			"DELETE FROM public.umiak_schema_migrations WHERE version=803",
		);
		const p = wp;
		worker = createWorker(
			workerOptions(db.pool, {
				infra: new FakeInfraRegistry(),
				config: p,
				keys: testKeys(),
				httpPort: 0,
				httpHost: "127.0.0.1",
				controllers: [],
				migrateOnStart: false,
			}),
		);
		const w = worker;
		const started = w.start();
		const port = await until(() => w.httpPort, { what: "http listening" });
		const base = `http://127.0.0.1:${port}`;

		const notReady = await getText(`${base}/readyz`);
		expect(notReady.status).toBe(503);
		const body = JSON.parse(notReady.body) as { reasons: string[] };
		expect(
			body.reasons.some((reason) => reason.startsWith("migrations pending:")),
		).toBe(true);

		await db.pool.query(
			"INSERT INTO public.umiak_schema_migrations(version,name,sha256) VALUES(803,'0803_configuration_notifications.sql','test')",
		);
		await started;
		const ready = await getText(`${base}/readyz`);
		expect(ready.status).toBe(200);
		expect(JSON.parse(ready.body)).toEqual({ ready: true, reasons: [] });

		// Payload migrations seed both OS templates and their default sizes.
		const t = await w.ctx.config.template("linux");
		expect(t).toMatchObject({ slug: "linux", defaultSize: "2gb" });
		expect(await w.ctx.config.template("windows")).toMatchObject({
			slug: "windows",
			defaultSize: "4gb",
		});
		expect((await w.ctx.config.sizes()).map((s) => s.slug)).toEqual([
			"2gb",
			"4gb",
			"8gb",
		]);
	});
});
