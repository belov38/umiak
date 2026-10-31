import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAutostop } from "../src/controllers/autostop.ts";
import { createWorld, type TestWorld } from "./fakes/world.ts";
import {
	activeOps,
	agentEvents,
	ev,
	type Linked,
	linkedSandbox,
	setRow,
	setSession,
} from "./helpers/controllers.ts";
import { row } from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

interface Idle extends Linked {
	bootId: string;
}

let seq = 0;

/**
 * A ready sandbox that has been idle for longer than its timeout (900 s): the
 * agent is connected, an `activity` event with the given counters was just
 * processed, and the zero mark, the API call and the ready time are 1000 s
 * old.
 */
async function idleSandbox(
	w: TestWorld,
	counters = { runningCommands: 0, openPtys: 0, tcpStreams: 0 },
): Promise<Idle> {
	const l = await linkedSandbox(w);
	const bootId = await setSession(w, l.machineId);
	seq += 1;
	await agentEvents(w, l.machineId, [ev(seq, bootId, "activity", counters)]);
	await setRow(
		w,
		"sandboxes",
		l.sandboxId,
		`idle_timeout_seconds = 900,
		 activity_zero_since = CASE WHEN activity_zero_since IS NULL THEN NULL
		                            ELSE now() - interval '1000 seconds' END,
		 last_api_call_at = now() - interval '1000 seconds',
		 state_changed_at = now() - interval '1000 seconds'`,
	);
	return { ...l, bootId };
}

/** Live checks of these machines (the database is shared by the file's tests). */
function liveChecks(w: TestWorld, ...machineIds: string[]): string[] {
	return w.agent
		.callsOf("activity")
		.map((c) => c.machineId)
		.filter((m) => machineIds.includes(m));
}

async function stopsOf(w: TestWorld, id: string): Promise<unknown[]> {
	return (await activeOps(w, id))
		.filter((o) => o.kind === "stop")
		.map((o) => o.request);
}

describe("ctl-autostop (§12)", () => {
	it("desktop stream blocks idle-stop from both journal and live counters", async () => {
		const w = await createWorld(db);
		const s = await idleSandbox(w);
		w.agent.activityOf.set(s.machineId, {
			runningCommands: 0,
			openPtys: 0,
			tcpStreams: 0,
			desktopStreams: 1,
		});
		expect((await runAutostop(w.ctx)).idle).not.toContain(s.sandboxId);
		w.agent.activityOf.delete(s.machineId);
		seq += 1;
		await agentEvents(w, s.machineId, [
			ev(seq, s.bootId, "activity", {
				runningCommands: 0,
				openPtys: 0,
				tcpStreams: 0,
				desktopStreams: 1,
			}),
		]);
		expect((await row(w, "sandboxes", s.sandboxId)).activity).toBe("busy");
		expect((await runAutostop(w.ctx)).idle).not.toContain(s.sandboxId);
	});
	it("idle: all zeros, fresh activity, quiet API and a zero live check → stop (idle)", async () => {
		const w = await createWorld(db);
		const s = await idleSandbox(w);
		const res = await runAutostop(w.ctx);
		expect(res.idle).toContain(s.sandboxId);
		expect(await stopsOf(w, s.sandboxId)).toEqual([{ reason: "idle" }]);
		const sb = await row(w, "sandboxes", s.sandboxId);
		expect(sb.state).toBe("stopping");
		expect(sb.stop_reason).toBe("idle");
		expect(liveChecks(w, s.machineId)).toEqual([s.machineId]);
		// The next run does nothing more.
		expect((await runAutostop(w.ctx)).idle).not.toContain(s.sandboxId);
	});

	for (const [name, counters] of [
		["runningCommands > 0", { runningCommands: 1, openPtys: 0, tcpStreams: 0 }],
		["openPtys > 0", { runningCommands: 0, openPtys: 1, tcpStreams: 0 }],
		["tcpStreams > 0", { runningCommands: 0, openPtys: 0, tcpStreams: 1 }],
	] as const) {
		it(`idle: not with ${name}`, async () => {
			const w = await createWorld(db);
			const s = await idleSandbox(w, counters);
			expect((await runAutostop(w.ctx)).idle).not.toContain(s.sandboxId);
			expect(await stopsOf(w, s.sandboxId)).toEqual([]);
		});
	}

	it("idle: not with a recent API call", async () => {
		const w = await createWorld(db);
		const s = await idleSandbox(w);
		await setRow(
			w,
			"sandboxes",
			s.sandboxId,
			"last_api_call_at = now() - interval '10 seconds'",
		);
		expect((await runAutostop(w.ctx)).idle).not.toContain(s.sandboxId);
	});

	it("idle: not before idle_timeout_seconds of zeros", async () => {
		const w = await createWorld(db);
		const s = await idleSandbox(w);
		await setRow(
			w,
			"sandboxes",
			s.sandboxId,
			"activity_zero_since = now() - interval '100 seconds'",
		);
		expect((await runAutostop(w.ctx)).idle).not.toContain(s.sandboxId);
	});

	it("idle: not with a stale activity event (> 150 s)", async () => {
		const w = await createWorld(db);
		const s = await idleSandbox(w);
		await setRow(
			w,
			"sandboxes",
			s.sandboxId,
			"last_activity_at = now() - interval '151 seconds'",
		);
		expect((await runAutostop(w.ctx)).idle).not.toContain(s.sandboxId);
		expect(liveChecks(w, s.machineId)).toEqual([]);
	});

	it("idle: not while the agent is disconnected or unavailable", async () => {
		const w = await createWorld(db);
		const gone = await idleSandbox(w);
		await setSession(w, gone.machineId, {
			bootId: gone.bootId,
			state: "disconnected",
		});
		const failing = await idleSandbox(w);
		w.agent.fail("activity", "unavailable", Number.POSITIVE_INFINITY);
		const res = await runAutostop(w.ctx);
		expect(res.idle).not.toContain(gone.sandboxId);
		expect(res.idle).not.toContain(failing.sandboxId);
		expect(liveChecks(w, gone.machineId, failing.machineId)).toEqual([
			failing.machineId,
		]);
		expect(await stopsOf(w, failing.sandboxId)).toEqual([]);
	});

	it("idle: not when the live check is not all zeros", async () => {
		const w = await createWorld(db);
		const s = await idleSandbox(w);
		w.agent.activityOf.set(s.machineId, {
			runningCommands: 0,
			openPtys: 0,
			tcpStreams: 3,
		});
		expect((await runAutostop(w.ctx)).idle).not.toContain(s.sandboxId);
		expect(liveChecks(w, s.machineId)).toEqual([s.machineId]);
		expect(await stopsOf(w, s.sandboxId)).toEqual([]);
	});

	it("idle: not without idle_timeout_seconds, not with an active operation", async () => {
		const w = await createWorld(db);
		const off = await idleSandbox(w);
		await setRow(w, "sandboxes", off.sandboxId, "idle_timeout_seconds = NULL");
		const busy = await idleSandbox(w);
		await w.pool.query(
			"INSERT INTO runtime.operations (sandbox_id, kind, state) VALUES ($1, 'reprovision', 'running')",
			[busy.sandboxId],
		);
		const res = await runAutostop(w.ctx);
		expect(res.idle).not.toContain(off.sandboxId);
		expect(res.idle).not.toContain(busy.sandboxId);
	});

	it("TTL: fires for a ready sandbox past its deadline, busy or not, connected or not", async () => {
		const w = await createWorld(db);
		const busy = await idleSandbox(w, {
			runningCommands: 2,
			openPtys: 1,
			tcpStreams: 0,
		});
		await setRow(
			w,
			"sandboxes",
			busy.sandboxId,
			"deadline_at = now() - interval '1 second'",
		);
		const gone = await linkedSandbox(w);
		await setRow(
			w,
			"sandboxes",
			gone.sandboxId,
			"deadline_at = now() - interval '1 second'",
		);
		const later = await linkedSandbox(w);
		await setRow(
			w,
			"sandboxes",
			later.sandboxId,
			"deadline_at = now() + interval '1 minute'",
		);
		const stopped = await linkedSandbox(w, {
			state: "stopped",
			machineState: "stopped",
		});
		await setRow(
			w,
			"sandboxes",
			stopped.sandboxId,
			"deadline_at = now() - interval '1 second'",
		);

		const res = await runAutostop(w.ctx);
		expect(res.ttl).toEqual(
			expect.arrayContaining([busy.sandboxId, gone.sandboxId]),
		);
		expect(res.ttl).not.toContain(later.sandboxId);
		expect(res.ttl).not.toContain(stopped.sandboxId);
		expect(await stopsOf(w, busy.sandboxId)).toEqual([{ reason: "ttl" }]);
		expect((await row(w, "sandboxes", gone.sandboxId)).stop_reason).toBe("ttl");
		expect(
			w.jobs.sent.filter(
				(j) =>
					j.queue === "sandbox-op" && j.opts?.singletonKey === busy.sandboxId,
			),
		).toHaveLength(1);
	});

	it("TTL with another active operation: skipped now, no error", async () => {
		const w = await createWorld(db);
		const l = await linkedSandbox(w);
		await setRow(
			w,
			"sandboxes",
			l.sandboxId,
			"deadline_at = now() - interval '1 second'",
		);
		await w.pool.query(
			"INSERT INTO runtime.operations (sandbox_id, kind, state) VALUES ($1, 'save_snapshot', 'running')",
			[l.sandboxId],
		);
		const res = await runAutostop(w.ctx);
		expect(res.ttl).not.toContain(l.sandboxId);
		expect((await row(w, "sandboxes", l.sandboxId)).state).toBe("ready");
	});
});
