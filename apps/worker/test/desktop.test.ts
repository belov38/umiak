import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { configureDesktop, issueTurnCredentials } from "../src/desktop.ts";
import { createWorld } from "./fakes/world.ts";
import { createSandbox, opsEnv, row, run } from "./helpers/ops.ts";

let db: TestDatabase;
beforeAll(async () => {
	db = await createTestDatabase();
});
afterAll(async () => {
	await db?.drop();
});
it("issues 24h TURN REST credentials without disclosing the shared secret", () => {
	const secret = "x".repeat(32);
	const result = issueTurnCredentials(
		{ secret, urls: ["turn:turn.example:3478?transport=udp"] },
		"sandbox",
		new Date("2026-10-31T00:00:00Z"),
	);
	expect(result.username).toBe("1793491200:sandbox");
	// Independently calculated HMAC-SHA1 fixture, compatible with coturn REST auth.
	expect(result.credential).toBe("yUyU9P6EteZXHjgq7N199Y7aUBw=");
	expect(JSON.stringify(result)).not.toContain(secret);
});
it("configures a desktop after cold claim, keeps headless claims unchanged", async () => {
	const w = await createWorld(db);
	const base = w.ctx.config;
	w.ctx.config = {
		...base,
		template: async (slug) => {
			const t = await base.template(slug);
			return t ? { ...t, capabilities: [...t.capabilities, "desktop"] } : null;
		},
		size: base.size.bind(base),
		templates: base.templates.bind(base),
		sizes: base.sizes.bind(base),
		defaults: base.defaults.bind(base),
		poolTargets: base.poolTargets.bind(base),
		teamQuota: base.teamQuota.bind(base),
	};
	w.ctx.turn = { secret: "x".repeat(32), urls: ["turn:turn.example:3478"] };
	const env = opsEnv(w);
	const { sandboxId, operationId } = await createSandbox(w, env);
	expect(await run(w, operationId)).toBe("succeeded");
	const s = await row(w, "sandboxes", sandboxId);
	const calls = w.agent.callsOf("configureDesktop");
	expect(calls).toHaveLength(1);
	expect(w.agent.calls.findIndex((c) => c.method === "claim")).toBeLessThan(
		w.agent.calls.findIndex((c) => c.method === "configureDesktop"),
	);
	await configureDesktop(
		w.ctx,
		sandboxId,
		s.machine_id as string,
		"test-reprovision",
	);
	expect(w.agent.callsOf("configureDesktop")).toHaveLength(2);
	const e = env;
	const stop = await e.svc.stop(e.p, sandboxId);
	expect(await run(w, stop.id)).toBe("succeeded");
	const policy = await w.pool.query(
		"SELECT auth_epoch FROM runtime.sandbox_desktops WHERE sandbox_id=$1",
		[sandboxId],
	);
	expect(policy.rows[0].auth_epoch).toBe(2);
	const resume = await e.svc.resume(e.p, sandboxId);
	expect(await run(w, resume.id)).toBe("succeeded");
	expect(w.agent.callsOf("configureDesktop")).toHaveLength(3);
});
