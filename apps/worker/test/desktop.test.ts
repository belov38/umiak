import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	configureDesktop,
	issueTurnCredentials,
	refreshDesktopTurn,
} from "../src/desktop.ts";
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
	w.ctx.turn = { secret: "x".repeat(32), urls: ["turn:turn.example:3478"] };
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

it("desktop-turn renews every due desktop in a fixed order even when one guest fails", async () => {
	const w = await desktopWorld();
	const env = opsEnv(w);
	const ids: string[] = [];
	for (let i = 0; i < 3; i++) {
		const { sandboxId, operationId } = await createSandbox(w, env);
		expect(await run(w, operationId)).toBe("succeeded");
		ids.push(sandboxId);
	}
	// Oldest credentials first; the failing guest is the first in the batch.
	await w.pool.query(
		"UPDATE runtime.sandbox_desktops SET turn_issued_at=now()-interval '13 hours'-(interval '1 minute'*array_position($1::uuid[],sandbox_id)) WHERE sandbox_id=ANY($1::uuid[])",
		[[ids[2], ids[0], ids[1]]],
	);
	const machines = new Map<string, string>();
	for (const id of ids)
		machines.set((await row(w, "sandboxes", id)).machine_id as string, id);
	const before = w.agent.callsOf("configureDesktop").length;
	w.agent.fail("configureDesktop", "unavailable");
	expect(await refreshDesktopTurn(w.ctx)).toBe(2);
	const order = w.agent
		.callsOf("configureDesktop")
		.slice(before)
		.map((c) => machines.get(c.machineId));
	expect(order).toEqual([ids[1], ids[0], ids[2]]);
	const fresh = await w.pool.query<{ sandbox_id: string }>(
		"SELECT sandbox_id FROM runtime.sandbox_desktops WHERE sandbox_id=ANY($1::uuid[]) AND turn_issued_at>now()-interval '1 hour' ORDER BY sandbox_id",
		[ids],
	);
	expect(fresh.rows.map((r) => r.sandbox_id).sort()).toEqual(
		[ids[0], ids[2]].sort(),
	);
});

it("desktop-turn moves past unreachable desktops that fill a whole batch", async () => {
	const w = await desktopWorld();
	const env = opsEnv(w);
	const ids: string[] = [];
	for (let i = 0; i < 3; i++) {
		const { sandboxId, operationId } = await createSandbox(w, env);
		expect(await run(w, operationId)).toBe("succeeded");
		ids.push(sandboxId);
	}
	// ids[0] has the oldest credentials and its guest never answers.
	await w.pool.query(
		"UPDATE runtime.sandbox_desktops SET turn_issued_at=now()-interval '20 hours'+(interval '1 minute'*array_position($1::uuid[],sandbox_id)) WHERE sandbox_id=ANY($1::uuid[])",
		[ids],
	);
	const machines = new Map<string, string>();
	for (const id of ids)
		machines.set((await row(w, "sandboxes", id)).machine_id as string, id);
	const unreachable = (await row(w, "sandboxes", ids[0] as string))
		.machine_id as string;
	const configure = w.agent.configureDesktop.bind(w.agent);
	w.agent.configureDesktop = async (machineId, ...rest) => {
		const result = await configure(machineId, ...rest);
		if (machineId === unreachable) throw new Error("unavailable");
		return result;
	};
	const before = w.agent.callsOf("configureDesktop").length;
	const counts: number[] = [];
	for (let i = 0; i < 3; i++) counts.push(await refreshDesktopTurn(w.ctx, 1));
	expect(counts).toEqual([0, 1, 1]);
	expect(
		w.agent
			.callsOf("configureDesktop")
			.slice(before)
			.map((c) => machines.get(c.machineId)),
	).toEqual(ids);
});
