// Secret leak (global constraints, S6 §13.1): env, secret and secret file
// values reach the agent and nothing else. Create, fork (with a patch),
// stop/resume (with a patch), save_snapshot and a failing resume run with
// marker values through real pg-boss; then the operations (request and
// progress), idempotency responses, sandbox events, pg-boss jobs, the
// recorded job sends and the worker's captured logs must not contain them.
import { randomUUID } from "node:crypto";
import {
	ensureQueues,
	PgBossJobSender,
	SandboxServiceImpl,
	type SecretFile,
} from "@umiak/core";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClaimRequest } from "../src/ports.ts";
import { createWorld, type TestWorld } from "./fakes/world.ts";
import { type OpsEnv, principal, row, run } from "./helpers/ops.ts";

let db: TestDatabase;
let boss: PgBoss;

beforeAll(async () => {
	db = await createTestDatabase();
	boss = new PgBoss({
		connectionString: db.url,
		schema: "pgboss",
		max: 2,
		supervise: false,
		schedule: false,
	});
	boss.on("error", () => {});
	await boss.start();
	await ensureQueues(boss);
});

afterAll(async () => {
	await boss?.stop({ graceful: false });
	await db?.drop();
});

const MARKER = `leak-marker-${randomUUID()}`;
const fileContent = (tag: string) =>
	Buffer.from(`${MARKER}-${tag}-file`).toString("base64");

/** Every form a marker value could take in storage or logs. */
const NEEDLES = [MARKER, Buffer.from(MARKER).toString("base64").slice(0, 24)];

async function dump(w: TestWorld): Promise<Record<string, string>> {
	const q = async (sql: string) =>
		(await w.pool.query<{ j: string }>(sql)).rows.map((r) => r.j).join("\n");
	return {
		operations: await q(
			"SELECT row_to_json(o)::text AS j FROM runtime.operations o",
		),
		operationsRequestProgress: await q(
			"SELECT request::text || ' ' || progress::text AS j FROM runtime.operations",
		),
		idempotencyKeys: await q(
			"SELECT row_to_json(k)::text AS j FROM runtime.idempotency_keys k",
		),
		sandboxEvents: await q(
			"SELECT row_to_json(e)::text AS j FROM runtime.sandbox_events e",
		),
		snapshots: await q(
			"SELECT row_to_json(s)::text AS j FROM runtime.snapshots s",
		),
		pgbossJobs: await q("SELECT row_to_json(j)::text AS j FROM pgboss.job j"),
		recordedSends: JSON.stringify(w.jobs.sent),
		logs: w.logs.join(""),
	};
}

describe("secret leak", () => {
	it("marker values reach the agent only", async () => {
		const w = await createWorld(db);
		const jobs = new PgBossJobSender(boss);
		w.ctx.jobs = jobs;
		const e: OpsEnv = {
			svc: new SandboxServiceImpl({
				pool: w.pool,
				config: w.ctx.config,
				keys: w.ctx.keys,
				jobs,
			}),
			p: principal(),
		};
		const files = (tag: string): SecretFile[] => [
			{ name: `cred-${tag}`, contentBase64: fileContent(tag) },
		];

		// create (cold), with an idempotency key
		const c = await e.svc.create(
			e.p,
			{
				template: w.topo.templateSlug,
				env: { APP_MODE: `${MARKER}-env` },
				secrets: { API_TOKEN: `${MARKER}-secret` },
				secretFiles: files("create"),
			},
			"leak-create",
		);
		expect(await run(w, c.operation.id)).toBe("succeeded");

		// fork with a patch, with an idempotency key
		const f = await e.svc.fork(
			e.p,
			c.sandbox.id,
			{
				secrets: { FORKED: `${MARKER}-fork` },
				secretFiles: { "cred-fork": { contentBase64: fileContent("fork") } },
			},
			"leak-fork",
		);
		expect(await run(w, f.sourceOperation.id)).toBe("succeeded");
		expect(await run(w, f.operation.id)).toBe("succeeded");

		// stop and resume the source with a patch
		const stop = await e.svc.stop(e.p, c.sandbox.id);
		expect(await run(w, stop.id)).toBe("succeeded");
		const resume = await e.svc.resume(e.p, c.sandbox.id, {
			env: { RESUMED_ENV: `${MARKER}-resume-env` },
			secrets: { RESUMED: `${MARKER}-resume` },
		});
		expect(await run(w, resume.id)).toBe("succeeded");

		// save_snapshot of the source
		const save = await e.svc.saveSnapshot(e.p, c.sandbox.id, "leak");
		expect(await run(w, save.operation.id)).toBe("succeeded");

		// a failing resume of the target (logs and error fields)
		const stopT = await e.svc.stop(e.p, f.sandbox.id);
		expect(await run(w, stopT.id)).toBe("succeeded");
		const resumeT = await e.svc.resume(e.p, f.sandbox.id, {
			secrets: { LATE: `${MARKER}-late` },
		});
		w.agent.fail("updateSecrets", { rejected: "bad_secrets" });
		expect(await run(w, resumeT.id)).toBe("failed");
		expect((await row(w, "sandboxes", f.sandbox.id)).error_code).toBe(
			"resume_failed",
		);

		// The values did reach the agent (the test is meaningful).
		const claims = w.agent.callsOf("claim").map((x) => x.args as ClaimRequest);
		expect(claims).toHaveLength(2);
		expect(claims[1]?.secretEnv).toEqual({
			API_TOKEN: `${MARKER}-secret`,
			FORKED: `${MARKER}-fork`,
		});
		expect(claims[1]?.env).toEqual({ APP_MODE: `${MARKER}-env` });
		const delivered = JSON.stringify(w.agent.calls);
		expect(delivered).toContain(`${MARKER}-resume`);
		expect(delivered).toContain(fileContent("fork"));

		const d = await dump(w);
		expect(d.pgbossJobs).toContain("sandbox-op");
		expect(d.idempotencyKeys).toContain("leak-fork");
		expect(d.logs?.length).toBeGreaterThan(0);
		for (const [where, text] of Object.entries(d)) {
			for (const needle of [
				...NEEDLES,
				fileContent("create"),
				fileContent("fork"),
			]) {
				expect(text.includes(needle), `${needle} found in ${where}`).toBe(
					false,
				);
			}
		}
	});
});
