import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { configureDesktop } from "../src/desktop.ts";
import { createWorld } from "./fakes/world.ts";
import { createSandbox, opsEnv, row, run } from "./helpers/ops.ts";

let db: TestDatabase;
beforeAll(async () => {
	db = await createTestDatabase();
});
afterAll(async () => {
	await db?.drop();
});
async function desktopWorld() {
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
	return w;
}
it("configures a desktop after cold claim, keeps headless claims unchanged", async () => {
	const w = await desktopWorld();
	w.agent.desktopReadyStates = [false, false, true];
	const env = opsEnv(w);
	const { sandboxId, operationId } = await createSandbox(w, env);
	expect(await run(w, operationId)).toBe("succeeded");
	const s = await row(w, "sandboxes", sandboxId);
	expect(w.agent.callsOf("desktopReady")).toHaveLength(3);
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
	w.agent.desktopReadyStates = [false, true];
	const resume = await e.svc.resume(e.p, sandboxId);
	expect(await run(w, resume.id)).toBe("succeeded");
	expect(w.agent.callsOf("configureDesktop")).toHaveLength(3);
	expect(w.agent.callsOf("desktopReady")).toHaveLength(5);
});

it("configures a desktop with no ICE servers when TURN is not configured", async () => {
	const w = await desktopWorld();
	w.agent.desktopReadyStates = [true];
	const env = opsEnv(w);
	const { sandboxId, operationId } = await createSandbox(w, env);
	expect(await run(w, operationId)).toBe("succeeded");
	const calls = w.agent.callsOf("configureDesktop");
	expect(calls).toHaveLength(1);
	expect(calls[0]?.args).toMatchObject({ iceServers: [] });
	expect(w.agent.callsOf("configureDesktop")).toHaveLength(1);
	expect(sandboxId).toBeTruthy();
});
it("does not finish desktop readiness on another boot", async () => {
	const w = await desktopWorld();
	const env = opsEnv(w);
	const { operationId } = await createSandbox(w, env);
	w.agent.desktopReady = async (machineId) => {
		await w.pool.query(
			"UPDATE tunnel.tunnel_sessions SET boot_id='changed-boot' WHERE machine_id=$1",
			[machineId],
		);
		return true;
	};
	await expect(run(w, operationId)).rejects.toThrow("desktop boot changed");
});
