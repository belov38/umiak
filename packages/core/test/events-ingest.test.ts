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

	it("replaces lone UTF-16 surrogates with U+FFFD (jsonb rejects them) instead of failing the batch", async () => {
		const machineId = randomUUID();
		const jobs = new RecordingJobSender();
		const res = await ingestAgentEvents(t.pool, jobs, {
			machineId,
			events: [
				ev(1, "command.output", {
					hi: "a\uD800b",
					lo: "\uDC00",
					pair: "\uD83D\uDE00",
					nested: [{ "k\uDBFFey": ["x\uDFFF", 2] }],
				}),
				{ ...ev(2, "t\uD800"), bootId: "b\uDC001" },
			],
			synthetic: [
				{ epoch: 1, type: "connected", instanceId: "gw\uD800", time: T0 },
			],
		});
		expect(res).toEqual({ ackedSeq: 2 });
		const stored = await rows(machineId);
		expect(stored.map((r) => r.seq)).toEqual([1, 2]);
		expect(stored[0]?.payload).toEqual({
			hi: "a\uFFFDb",
			lo: "\uFFFD",
			pair: "\uD83D\uDE00",
			nested: [{ "k\uFFFDey": ["x\uFFFD", 2] }],
		});
		expect(stored[1]).toMatchObject({ type: "t\uFFFD", boot_id: "b\uFFFD1" });
		const syn = await t.pool.query(
			"SELECT instance_id FROM runtime.agent_synthetic_events WHERE machine_id = $1",
			[machineId],
		);
		expect(syn.rows).toEqual([{ instance_id: "gw\uFFFD" }]);
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
			reason: null,
			outputTruncated: null,
			stdoutBytes: 10,
			stderrBytes: 0,
		});
		expect(
			normalizeAgentEvent({
				type: "pty.closed",
				payload: { commandId: "01P" },
			}),
		).toEqual({ kind: "pty_closed", commandId: "01P", reason: null });
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

	it("maps the S3 CommandExited reason like attach: TIMEOUT → timed_out, START_FAILED → failed_to_start; a PTY end is the stdout bytes", () => {
		const exited = (payload: object) =>
			normalizeAgentEvent({ type: "command.exited", payload });
		// protojson of sbx.agent.v1.CommandExited with implicit fields emitted.
		const base = {
			commandId: "01T",
			code: 0,
			signal: "",
			stdoutEnd: "4",
			stderrEnd: "0",
			ptyEnd: "0",
			outputTruncated: "",
		};
		expect(
			exited({
				...base,
				status: "EXIT_STATUS_KILLED",
				code: 137,
				signal: "SIGKILL",
				reason: "EXIT_REASON_TIMEOUT",
			}),
		).toMatchObject({ status: "timed_out", exitCode: 137, signal: "SIGKILL" });
		expect(
			exited({
				...base,
				status: "EXIT_STATUS_EXITED",
				code: 127,
				reason: "EXIT_REASON_START_FAILED",
			}),
		).toMatchObject({ status: "failed_to_start", exitCode: 127 });
		expect(
			exited({
				...base,
				status: "EXIT_STATUS_EXITED",
				reason: "EXIT_REASON_NONE",
			}),
		).toEqual({
			kind: "command_exited",
			commandId: "01T",
			status: "exited",
			exitCode: 0,
			signal: null,
			reason: "none",
			outputTruncated: null,
			stdoutBytes: 4,
			stderrBytes: 0,
		});
		expect(
			exited({
				...base,
				status: "EXIT_STATUS_EXITED",
				reason: "EXIT_REASON_NONE",
				stdoutEnd: "0",
				ptyEnd: "9",
			}),
		).toMatchObject({ stdoutBytes: 9, stderrBytes: 0 });
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
			reason: null,
			outputTruncated: null,
			stdoutBytes: 5,
			stderrBytes: null,
		});
	});

	it("keeps the S3 exit reason in lower case and output_truncated of command.exited", () => {
		const exited = (payload: object) =>
			normalizeAgentEvent({ type: "command.exited", payload });
		const base = { commandId: "01R", code: 0, stdoutEnd: "1", stderrEnd: "0" };
		const reasons = [
			["EXIT_REASON_NONE", "EXIT_STATUS_EXITED", "none", "exited"],
			["EXIT_REASON_SIGNAL", "EXIT_STATUS_KILLED", "signal", "killed"],
			["EXIT_REASON_TIMEOUT", "EXIT_STATUS_KILLED", "timeout", "timed_out"],
			["EXIT_REASON_OOM", "EXIT_STATUS_KILLED", "oom", "killed"],
			["EXIT_REASON_PTY_IDLE", "EXIT_STATUS_KILLED", "pty_idle", "killed"],
			["EXIT_REASON_REBOOT", "EXIT_STATUS_LOST", "reboot", "lost"],
			["EXIT_REASON_SHIM_LOST", "EXIT_STATUS_LOST", "shim_lost", "lost"],
			[
				"EXIT_REASON_START_FAILED",
				"EXIT_STATUS_EXITED",
				"start_failed",
				"failed_to_start",
			],
		] as const;
		for (const [proto, protoStatus, reason, status] of reasons) {
			expect(
				exited({ ...base, status: protoStatus, reason: proto }),
				proto,
			).toMatchObject({ reason, status });
		}
		// snake_case, an unknown reason and the unspecified zero value give null.
		expect(exited({ ...base, status: "exited", reason: "oom" })).toMatchObject({
			reason: "oom",
		});
		expect(
			exited({ ...base, status: "exited", reason: "EXIT_REASON_UNSPECIFIED" }),
		).toMatchObject({ reason: null, status: "exited" });
		expect(
			exited({ ...base, status: "exited", reason: "cosmic_ray" }),
		).toMatchObject({ reason: null, status: "exited" });
		expect(
			exited({ ...base, status: "exited", output_truncated: "disk_full" }),
		).toMatchObject({ outputTruncated: "disk_full" });
		expect(
			exited({ ...base, status: "exited", outputTruncated: "" }),
		).toMatchObject({ outputTruncated: null });
		// A value that cannot be stored is dropped; the exit still counts.
		expect(
			exited({ ...base, status: "exited", outputTruncated: "x".repeat(65) }),
		).toMatchObject({ status: "exited", outputTruncated: null });
	});

	it("maps output.truncated and the reason of pty.closed", () => {
		expect(
			normalizeAgentEvent({
				type: "output.truncated",
				payload: {
					commandId: "01O",
					stream: "STREAM_STDOUT",
					reason: "disk_full",
				},
			}),
		).toEqual({
			kind: "output_truncated",
			commandId: "01O",
			reason: "disk_full",
		});
		expect(
			normalizeAgentEvent({
				type: "output.truncated",
				payload: { command_id: "01O", reason: "" },
			}),
		).toBe(null);
		expect(
			normalizeAgentEvent({
				type: "output.truncated",
				payload: { reason: "disk_full" },
			}),
		).toBe(null);
		expect(
			normalizeAgentEvent({
				type: "output.truncated",
				payload: { commandId: "01O", reason: "disk\nfull" },
			}),
		).toBe(null);
		expect(
			normalizeAgentEvent({
				type: "pty.closed",
				payload: { commandId: "01P", reason: "EXIT_REASON_PTY_IDLE" },
			}),
		).toEqual({ kind: "pty_closed", commandId: "01P", reason: "pty_idle" });
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
