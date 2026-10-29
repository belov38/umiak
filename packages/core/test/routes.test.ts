import { createHash, randomUUID } from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRoutes, lookupRoute, sshTarget } from "../src/index.ts";
import { seedSandbox, serviceEnv } from "./helpers/service.ts";

describe.skipIf(skipPg())("routes for the gateway (S6 §14.2, S4 §4.2)", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 10 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	it("lookup('my-box-5173') returns the hosted port with the token hash in hex", async () => {
		const env = await serviceEnv(t.pool);
		const s = await seedSandbox(t.pool, env, {
			state: "ready",
			slug: "my-box",
		});
		const { token } = await env.svc.hostPort(env.p, s.sandboxId, 5173, "token");

		const routes = createRoutes(t.pool);
		const r = await routes.lookup("my-box-5173");

		expect(r).toEqual({
			sandboxId: s.sandboxId,
			slug: "my-box",
			machineId: s.machineId,
			port: 5173,
			mode: "token",
			tokenHash: createHash("sha256")
				.update(token ?? "")
				.digest("hex"),
			authEpoch: 0,
			state: "ready",
			teamId: env.p.teamId,
			hostRewrite: "preserve",
			appProtocol: "http1",
			blocked: false,
			blockReason: null,
		});
	});

	it("returns the state of a stopped sandbox and a null hash for public ports", async () => {
		const env = await serviceEnv(t.pool);
		const s = await seedSandbox(t.pool, env, {
			state: "stopped",
			machineState: "stopped",
		});
		await env.svc.hostPort(env.p, s.sandboxId, 80, "public");
		expect(await lookupRoute(t.pool, `${s.slug}-80`)).toMatchObject({
			state: "stopped",
			mode: "public",
			tokenHash: null,
		});
	});

	it("null for a label outside the grammar, an unhosted port, an unknown slug or a deleted sandbox", async () => {
		const env = await serviceEnv(t.pool);
		const s = await seedSandbox(t.pool, env, { state: "ready" });
		await env.svc.hostPort(env.p, s.sandboxId, 3000, "public");
		for (const label of [
			"",
			"nolabel",
			`${s.slug}-03000`,
			`${s.slug}-70000`,
			`${s.slug.toUpperCase()}-3000`,
			`${s.slug}-3001`,
			"unknown-box-3000",
		]) {
			expect(await lookupRoute(t.pool, label)).toBeNull();
		}
		await env.svc.unhostPort(env.p, s.sandboxId, 3000);
		expect(await lookupRoute(t.pool, `${s.slug}-3000`)).toBeNull();

		const d = await seedSandbox(t.pool, env, { state: "ready" });
		await env.svc.hostPort(env.p, d.sandboxId, 3000, "public");
		await t.pool.query(
			"UPDATE runtime.sandboxes SET state = 'deleted' WHERE id = $1",
			[d.sandboxId],
		);
		expect(await lookupRoute(t.pool, `${d.slug}-3000`)).toBeNull();
	});

	it("sshTarget resolves by id or slug and skips deleted sandboxes", async () => {
		const env = await serviceEnv(t.pool);
		const s = await seedSandbox(t.pool, env, { state: "ready" });
		const want = {
			sandboxId: s.sandboxId,
			machineId: s.machineId,
			state: "ready",
			teamId: env.p.teamId,
			slug: s.slug,
			templateSlug: env.template,
		};
		expect(await sshTarget(t.pool, s.sandboxId)).toEqual(want);
		expect(await createRoutes(t.pool).sshTarget(s.slug)).toEqual(want);
		expect(await sshTarget(t.pool, randomUUID())).toBeNull();
		expect(await sshTarget(t.pool, "")).toBeNull();
		await t.pool.query(
			"UPDATE runtime.sandboxes SET state = 'deleted' WHERE id = $1",
			[s.sandboxId],
		);
		expect(await sshTarget(t.pool, s.slug)).toBeNull();
	});
});
