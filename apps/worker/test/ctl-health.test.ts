import { randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_RESTART_ARGV, runHealth } from "../src/controllers/health.ts";
import { createWorld, insertSandbox, type TestWorld } from "./fakes/world.ts";
import {
	eventTypes,
	linkedSandbox,
	setGateway,
	setRow,
	setSession,
	synthetic,
} from "./helpers/controllers.ts";
import { opsEnv, readySandbox, row } from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

async function health(w: TestWorld, id: string) {
	const s = await row(w, "sandboxes", id);
	return {
		health: s.health,
		reason: s.health_reason,
		degraded: s.degraded_since !== null,
	};
}

/** A ready sandbox on a fake VM, its agent connected through a live gateway. */
async function live(w: TestWorld) {
	await setGateway(w, "gw-fake", 0);
	const r = await readySandbox(w, opsEnv(w));
	const vmid = (await row(w, "machines", r.machineId)).vmid as number;
	return { ...r, vmid };
}

function restarts(w: TestWorld): unknown[][] {
	return w.infra.callsOf("qgaExec").map((c) => c.args);
}

describe("ctl-health (§11.1)", () => {
	it("disconnected for more than 60 s: degraded, agent_unreachable, one restart after 2 min, then not again within 10 min", async () => {
		const w = await createWorld(db);
		const r = await live(w);
		await setSession(w, r.machineId, { state: "connected" });
		expect((await runHealth(w.ctx)).degraded).not.toContain(r.sandboxId);

		await setSession(w, r.machineId, {
			state: "disconnected",
			disconnectedAgoS: 61,
		});
		const res = await runHealth(w.ctx);
		expect(res.degraded).toContain(r.sandboxId);
		expect(await health(w, r.sandboxId)).toEqual({
			health: "degraded",
			reason: "agent_unreachable",
			degraded: true,
		});
		const s = await row(w, "sandboxes", r.sandboxId);
		expect(s.activity).toBe("unknown");
		expect(s.state).toBe("ready");
		expect(
			(await eventTypes(w, r.sandboxId)).filter((e) => e.type === "degraded"),
		).toHaveLength(1);
		expect(restarts(w)).toEqual([]);

		// A second run does not degrade again.
		expect((await runHealth(w.ctx)).degraded).not.toContain(r.sandboxId);

		// After 2 min degraded: one restart of the agent service.
		await setRow(
			w,
			"sandboxes",
			r.sandboxId,
			"degraded_since = now() - interval '121 seconds'",
		);
		expect((await runHealth(w.ctx)).restarted).toEqual([r.sandboxId]);
		expect(restarts(w)).toEqual([[r.vmid, [...AGENT_RESTART_ARGV]]]);
		expect(AGENT_RESTART_ARGV).toEqual(["systemctl", "restart", "sbx-agent"]);
		await runHealth(w.ctx);
		await runHealth(w.ctx);
		expect(restarts(w)).toHaveLength(1);

		// 10 min after the last restart: one more.
		await w.pool.query(
			`UPDATE runtime.sandbox_events SET created_at = now() - interval '601 seconds'
			 WHERE sandbox_id = $1 AND type = 'agent_restart'`,
			[r.sandboxId],
		);
		await runHealth(w.ctx);
		expect(restarts(w)).toHaveLength(2);
		// Never stopped or rebooted.
		expect(w.infra.callsOf("stop")).toEqual([]);
		expect(w.infra.callsOf("shutdown")).toEqual([]);
		expect((await row(w, "sandboxes", r.sandboxId)).state).toBe("ready");

		// `connected` clears it (machine-events).
		await setSession(w, r.machineId, { state: "connected" });
		await synthetic(w, r.machineId, "connected");
		expect(await health(w, r.sandboxId)).toEqual({
			health: "ok",
			reason: null,
			degraded: false,
		});
		expect((await eventTypes(w, r.sandboxId)).map((e) => e.type)).toContain(
			"recovered",
		);
	});

	it("disconnected for 30 s: still ok", async () => {
		const w = await createWorld(db);
		const r = await live(w);
		await setSession(w, r.machineId, {
			state: "disconnected",
			disconnectedAgoS: 30,
		});
		await runHealth(w.ctx);
		expect((await health(w, r.sandboxId)).health).toBe("ok");
	});

	it("VM stopped: vm_stopped and nothing else", async () => {
		const w = await createWorld(db);
		const r = await live(w);
		const vm = w.infra.vms.get(r.vmid);
		if (vm) vm.status = "stopped";
		await setSession(w, r.machineId, {
			state: "disconnected",
			disconnectedAgoS: 90,
		});
		await runHealth(w.ctx);
		await setRow(
			w,
			"sandboxes",
			r.sandboxId,
			"degraded_since = now() - interval '10 minutes'",
		);
		await runHealth(w.ctx);
		expect(await health(w, r.sandboxId)).toEqual({
			health: "degraded",
			reason: "vm_stopped",
			degraded: true,
		});
		expect(restarts(w)).toEqual([]);
		expect(w.infra.callsOf("start")).toHaveLength(1); // the create's start only
	});

	it("VM running, QGA silent: vm_unresponsive, no restart", async () => {
		const w = await createWorld(db);
		const r = await live(w);
		w.infra.qgaPing = async () => false;
		await setSession(w, r.machineId, {
			state: "disconnected",
			disconnectedAgoS: 90,
		});
		await runHealth(w.ctx);
		await setRow(
			w,
			"sandboxes",
			r.sandboxId,
			"degraded_since = now() - interval '10 minutes'",
		);
		await runHealth(w.ctx);
		expect((await health(w, r.sandboxId)).reason).toBe("vm_unresponsive");
		expect(restarts(w)).toEqual([]);
	});

	it("connected session whose owner gateway heartbeat is stale (> 15 s): degraded", async () => {
		const w = await createWorld(db);
		const fresh = await linkedSandbox(w);
		await setGateway(w, "gw-fresh", 2);
		await setSession(w, fresh.machineId, { instanceId: "gw-fresh" });
		const stale = await linkedSandbox(w);
		await setGateway(w, "gw-stale", 20);
		await setSession(w, stale.machineId, { instanceId: "gw-stale" });
		const res = await runHealth(w.ctx);
		expect(res.degraded).toContain(stale.sandboxId);
		expect(res.degraded).not.toContain(fresh.sandboxId);
	});

	it("no session at all: degraded only 60 s after ready", async () => {
		const w = await createWorld(db);
		const young = await linkedSandbox(w);
		const old = await linkedSandbox(w);
		await setRow(
			w,
			"sandboxes",
			old.sandboxId,
			"ready_at = now() - interval '61 seconds'",
		);
		const res = await runHealth(w.ctx);
		expect(res.degraded).toContain(old.sandboxId);
		expect(res.degraded).not.toContain(young.sandboxId);
		// No VM: the reason says so, no QGA call.
		expect((await health(w, old.sandboxId)).reason).toBe("vm_missing");
	});

	it("only ready sandboxes are degraded", async () => {
		const w = await createWorld(db);
		const l = await linkedSandbox(w, {
			state: "stopped",
			machineState: "stopped",
		});
		await setSession(w, l.machineId, {
			state: "disconnected",
			disconnectedAgoS: 600,
		});
		await runHealth(w.ctx);
		expect((await health(w, l.sandboxId)).health).toBe("ok");
	});

	it("deleteStuckCount: delete operations active for more than 30 min, as a gauge", async () => {
		const w = await createWorld(db);
		const base = (await runHealth(w.ctx)).deleteStuckCount;
		const id = await insertSandbox(w, { state: "deleting" });
		const op = randomUUID();
		await w.pool.query(
			`INSERT INTO runtime.operations (id, sandbox_id, kind, state, created_at)
			 VALUES ($1, $2, 'delete', 'running', now() - interval '31 minutes')`,
			[op, id],
		);
		const fresh = await insertSandbox(w, { state: "deleting" });
		await w.pool.query(
			"INSERT INTO runtime.operations (sandbox_id, kind, state) VALUES ($1, 'delete', 'pending')",
			[fresh],
		);
		const res = await runHealth(w.ctx);
		expect(res.deleteStuckCount).toBe(base + 1);
		expect(
			w.metrics.calls
				.filter((c) => c.name === "sbx_delete_stuck_operations")
				.at(-1),
		).toMatchObject({ kind: "set", value: base + 1 });
	});
});
