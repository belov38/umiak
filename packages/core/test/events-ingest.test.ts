import { randomUUID } from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type AgentEventBatch,
	ingestAgentEvents,
	normalizeAgentEvent,
	RecordingJobSender,
	SbxError,
	type SyntheticEventType,
} from "../src/index.ts";

const T0 = "2026-10-29T10:00:00.000Z";

function ev(seq: number, type = "activity", payload: object = {}) {
	return { seq, bootId: "b1", type, time: T0, payload };
}

describe.skipIf(skipPg())("ingestAgentEvents (S6 §10.1)", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 10 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	async function rows(machineId: string) {
		const r = await t.pool.query(
			"SELECT seq::int AS seq, boot_id, type, payload FROM runtime.agent_events WHERE machine_id = $1 ORDER BY seq",
			[machineId],
		);
		return r.rows;
	}

	it("stores events, skips duplicate seq, returns the max seq and sends one machine-events job", async () => {
		const machineId = randomUUID();
		const jobs = new RecordingJobSender();

		const a = await ingestAgentEvents(t.pool, jobs, {
			machineId,
			events: [ev(2, "phase", { phase: "pool_ready" }), ev(1), ev(3)],
			synthetic: [],
		});
		expect(a).toEqual({ ackedSeq: 3 });
		expect(jobs.sent).toEqual([
			{
				queue: "machine-events",
				data: { machineId },
				opts: { singletonKey: machineId },
			},
		]);

		jobs.clear();
		const b = await ingestAgentEvents(t.pool, jobs, {
			machineId,
			events: [
				ev(3, "changed", { x: 1 }),
				ev(4, "ports.changed", { listening: [] }),
			],
			synthetic: [],
		});
		expect(b).toEqual({ ackedSeq: 4 });
		expect(jobs.sent).toHaveLength(1);
		const stored = await rows(machineId);
		expect(stored.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
		// The first copy of seq 3 stays.
		expect(stored[2]).toMatchObject({ type: "activity", payload: {} });
		expect(stored[1]).toMatchObject({
			type: "phase",
			payload: { phase: "pool_ready" },
			boot_id: "b1",
		});
	});

	it("deduplicates synthetic events by (machineId, epoch, type)", async () => {
		const machineId = randomUUID();
		const jobs = new RecordingJobSender();
		const syn = (
			epoch: number,
			type: SyntheticEventType,
			instanceId = "gw-1",
		) => ({
			epoch,
			type,
			instanceId,
			time: T0,
		});
		const res = await ingestAgentEvents(t.pool, jobs, {
			machineId,
			events: [],
			synthetic: [syn(1, "connected"), syn(1, "disconnected")],
		});
		expect(res).toEqual({ ackedSeq: null });
		await ingestAgentEvents(t.pool, jobs, {
			machineId,
			events: [],
			synthetic: [syn(1, "connected", "gw-2"), syn(2, "connected")],
		});
		const r = await t.pool.query(
			`SELECT epoch::int AS epoch, type, instance_id FROM runtime.agent_synthetic_events
			 WHERE machine_id = $1 ORDER BY epoch, type`,
			[machineId],
		);
		expect(r.rows).toEqual([
			{ epoch: 1, type: "connected", instance_id: "gw-1" },
			{ epoch: 1, type: "disconnected", instance_id: "gw-1" },
			{ epoch: 2, type: "connected", instance_id: "gw-1" },
		]);
		expect(jobs.sent).toHaveLength(2);
	});

	it("a duplicate seq inside one batch is stored once (first copy)", async () => {
		const machineId = randomUUID();
		const jobs = new RecordingJobSender();
		const res = await ingestAgentEvents(t.pool, jobs, {
			machineId,
			events: [ev(5, "activity", { n: 1 }), ev(5, "activity", { n: 2 }), ev(6)],
			synthetic: [],
		});
		expect(res).toEqual({ ackedSeq: 6 });
		const stored = await rows(machineId);
		expect(stored.map((r) => r.seq)).toEqual([5, 6]);
		expect(stored[0]?.payload).toEqual({ n: 1 });
		expect(jobs.sent).toHaveLength(1);
	});

	it("strips U+0000 from payload strings (jsonb rejects it) instead of failing the batch", async () => {
		const machineId = randomUUID();
		const jobs = new RecordingJobSender();
		const res = await ingestAgentEvents(t.pool, jobs, {
			machineId,
			events: [
				ev(1, "command.exited", {
					commandId: "a\u0000b",
					nested: { list: ["x\u0000", 1, null, { "k\u0000ey": "\u0000v" }] },
				}),
				{ ...ev(2), bootId: "b\u00001" },
			],
			synthetic: [],
		});
		expect(res).toEqual({ ackedSeq: 2 });
		const stored = await rows(machineId);
		expect(stored.map((r) => r.seq)).toEqual([1, 2]);
		expect(stored[1]?.boot_id).toBe("b1");
		expect(stored[0]?.payload).toEqual({
			commandId: "ab",
			nested: { list: ["x", 1, null, { key: "v" }] },
		});
	});

	it("an empty batch writes nothing and sends no job", async () => {
		const jobs = new RecordingJobSender();
		expect(
			await ingestAgentEvents(t.pool, jobs, {
				machineId: randomUUID(),
				events: [],
				synthetic: [],
			}),
		).toEqual({ ackedSeq: null });
		expect(jobs.sent).toEqual([]);
	});

	it("rejects a malformed batch", async () => {
		const jobs = new RecordingJobSender();
		for (const batch of [
			{ machineId: "nope", events: [], synthetic: [] },
			{ machineId: randomUUID(), events: [ev(-1)], synthetic: [] },
			{
				machineId: randomUUID(),
				events: [{ ...ev(1), time: "x" }],
				synthetic: [],
			},
			{
				machineId: randomUUID(),
				events: [],
				synthetic: [{ epoch: 1, type: "bogus", instanceId: "g", time: T0 }],
			},
		] as AgentEventBatch[]) {
			const err = await ingestAgentEvents(t.pool, jobs, batch).catch(
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(SbxError);
			expect((err as SbxError).code).toBe("validation");
		}
		expect(jobs.sent).toEqual([]);
	});
});

describe("normalizeAgentEvent (decision 13)", () => {
	it("maps S6 names", () => {
		expect(
			normalizeAgentEvent({ type: "phase", payload: { phase: "pool_ready" } }),
		).toEqual({ kind: "phase", phase: "pool_ready" });
		expect(
			normalizeAgentEvent({
				type: "command.exited",
				payload: {
					commandId: "01J",
					status: "exited",
					code: 2,
					signal: null,
					stdoutEnd: "10",
					stderrEnd: 0,
				},
			}),
		).toEqual({
			kind: "command_exited",
			commandId: "01J",
			status: "exited",
			exitCode: 2,
			signal: null,
			stdoutBytes: 10,
			stderrBytes: 0,
		});
		expect(
			normalizeAgentEvent({
				type: "pty.closed",
				payload: { commandId: "01P" },
			}),
		).toEqual({ kind: "pty_closed", commandId: "01P" });
		expect(
			normalizeAgentEvent({
				type: "activity",
				payload: { runningCommands: 1, openPtys: 0, tcpStreams: 3 },
			}),
		).toEqual({
			kind: "activity",
			runningCommands: 1,
			openPtys: 0,
			tcpStreams: 3,
		});
		expect(
			normalizeAgentEvent({
				type: "ports.changed",
				payload: { listening: [{ port: 3000 }] },
			}),
		).toEqual({ kind: "ports_changed", listening: [{ port: 3000 }] });
		expect(
			normalizeAgentEvent({ type: "quiesce.watchdog_thawed", payload: {} }),
		).toEqual({ kind: "quiesce_watchdog_thawed" });
	});

	it("maps S3 aliases (snake_case and protojson camelCase)", () => {
		expect(
			normalizeAgentEvent({
				type: "readiness.changed",
				payload: { phase: "secrets", state: "pending" },
			}),
		).toEqual({ kind: "phase", phase: "secrets_missing" });
		expect(
			normalizeAgentEvent({
				type: "readiness.changed",
				payload: { phase: "identity", state: "READY" },
			}),
		).toEqual({ kind: "phase", phase: "pool_ready" });
		expect(
			normalizeAgentEvent({
				type: "readiness.changed",
				payload: { phase: "docker", state: "failed", error: "no socket" },
			}),
		).toEqual({
			kind: "readiness",
			phase: "docker",
			state: "failed",
			error: "no socket",
		});
		expect(
			normalizeAgentEvent({
				type: "quiesce.auto_thawed",
				payload: { lease_id: "l1", by: "watchdog" },
			}),
		).toEqual({ kind: "quiesce_watchdog_thawed" });
		expect(
			normalizeAgentEvent({
				type: "identity.reset",
				payload: { machine_id: "m1" },
			}),
		).toEqual({ kind: "identity_reset", machineId: "m1" });
		expect(
			normalizeAgentEvent({
				type: "claim.applied",
				payload: { sandboxId: "s1" },
			}),
		).toEqual({ kind: "claim_applied", sandboxId: "s1" });
		expect(
			normalizeAgentEvent({
				type: "command.exited",
				payload: {
					command_id: "01K",
					status: "COMMAND_STATUS_TIMED_OUT",
					stdout_end: 5,
				},
			}),
		).toEqual({
			kind: "command_exited",
			commandId: "01K",
			status: "timed_out",
			exitCode: null,
			signal: null,
			stdoutBytes: 5,
			stderrBytes: null,
		});
	});

	it("returns null for unknown types and malformed payloads", () => {
		expect(normalizeAgentEvent({ type: "agent.started", payload: {} })).toBe(
			null,
		);
		expect(
			normalizeAgentEvent({ type: "phase", payload: { phase: "x" } }),
		).toBe(null);
		expect(normalizeAgentEvent({ type: "command.exited", payload: {} })).toBe(
			null,
		);
		expect(
			normalizeAgentEvent({
				type: "activity",
				payload: { runningCommands: -1 },
			}),
		).toBe(null);
		expect(normalizeAgentEvent({ type: "pty.closed", payload: null })).toBe(
			null,
		);
	});
});
