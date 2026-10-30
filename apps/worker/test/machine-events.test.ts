import { randomUUID } from "node:crypto";
import { ingestAgentEvents } from "@sbx/core";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMachineEvents } from "../src/handlers/machine-events.ts";
import {
	createWorld,
	insertMachine,
	insertSandbox,
	insertSnapshot,
	machine,
	type TestWorld,
} from "./fakes/world.ts";
import {
	activeOps,
	agentEvents,
	commandOutcome,
	commandStatus,
	ev,
	insertCommand,
	type Linked,
	linkedSandbox,
	setSession,
	synthetic,
} from "./helpers/controllers.ts";
import { opsEnv, readySandbox, row, run } from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

function phase(seq: number, bootId: string, p: string) {
	return {
		seq,
		bootId,
		type: "phase",
		time: new Date(),
		payload: { phase: p },
	};
}

async function unprocessed(w: TestWorld, machineId: string): Promise<number> {
	const r = await w.pool.query<{ n: number }>(
		`SELECT (SELECT count(*) FROM runtime.agent_events WHERE machine_id = $1 AND processed_at IS NULL)
		      + (SELECT count(*) FROM runtime.agent_synthetic_events WHERE machine_id = $1 AND processed_at IS NULL)
		      AS n`,
		[machineId],
	);
	return Number(r.rows[0]?.n);
}

describe("machine-events (connected, phase)", () => {
	it("pool_ready moves a booting pool machine to warm and records ready_boot_id", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w, { state: "booting" });
		const bootId = randomUUID();
		await ingestAgentEvents(w.pool, w.jobs, {
			machineId: id,
			events: [
				phase(1, bootId, "pool_ready"),
				{
					seq: 2,
					bootId,
					type: "agent.started",
					time: new Date(),
					payload: {},
				},
			],
			synthetic: [
				{ epoch: 1, type: "connected", instanceId: "gw", time: new Date() },
			],
		});

		expect(await handleMachineEvents(w.ctx, { machineId: id })).toEqual({
			processed: 3,
		});
		const m = await machine(w, id);
		expect(m.state).toBe("warm");
		expect(m.warm_at).not.toBeNull();
		expect(m.ready_boot_id).toBe(bootId);
		expect(m.agent_phase).toBe("pool_ready");
		expect(await unprocessed(w, id)).toBe(0);

		// Redelivery and a duplicate batch change nothing.
		await ingestAgentEvents(w.pool, w.jobs, {
			machineId: id,
			events: [phase(1, bootId, "pool_ready")],
			synthetic: [],
		});
		expect(await handleMachineEvents(w.ctx, { machineId: id })).toEqual({
			processed: 0,
		});
		const again = await machine(w, id);
		expect(again.state).toBe("warm");
		expect(again.version).toBe(m.version);
	});

	it("a sandbox machine in booting only records the boot; later phases update agent_phase", async () => {
		const w = await createWorld(db);
		const sandboxId = await insertSandbox(w);
		const id = await insertMachine(w, {
			state: "booting",
			poolKey: null,
			sandboxId,
		});
		const bootId = randomUUID();
		await ingestAgentEvents(w.pool, w.jobs, {
			machineId: id,
			events: [
				phase(1, bootId, "pool_ready"),
				phase(2, bootId, "secrets_missing"),
			],
			synthetic: [],
		});
		await handleMachineEvents(w.ctx, { machineId: id });
		const m = await machine(w, id);
		expect(m.state).toBe("booting");
		expect(m.ready_boot_id).toBe(bootId);
		expect(m.agent_phase).toBe("secrets_missing");
	});

	it("connected clears degraded health with a recovered event", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w, { state: "running", poolKey: null });
		const sandboxId = await insertSandbox(w, {
			state: "ready",
			machineId: id,
			health: "degraded",
		});
		await w.pool.query(
			"UPDATE runtime.machines SET sandbox_id = $2 WHERE id = $1",
			[id, sandboxId],
		);
		await ingestAgentEvents(w.pool, w.jobs, {
			machineId: id,
			events: [],
			synthetic: [
				{ epoch: 3, type: "connected", instanceId: "gw", time: new Date() },
			],
		});
		await handleMachineEvents(w.ctx, { machineId: id });
		const s = await w.pool.query(
			"SELECT health, degraded_since FROM runtime.sandboxes WHERE id = $1",
			[sandboxId],
		);
		expect(s.rows[0]).toEqual({ health: "ok", degraded_since: null });
		const ev = await w.pool.query(
			"SELECT type FROM runtime.sandbox_events WHERE sandbox_id = $1",
			[sandboxId],
		);
		expect(ev.rows).toEqual([{ type: "recovered" }]);
		expect(await unprocessed(w, id)).toBe(0);
	});

	it("events of an unknown machine are marked processed", async () => {
		const w = await createWorld(db);
		const id = randomUUID();
		await ingestAgentEvents(w.pool, w.jobs, {
			machineId: id,
			events: [phase(1, "b", "pool_ready")],
			synthetic: [],
		});
		expect(await handleMachineEvents(w.ctx, { machineId: id })).toEqual({
			processed: 1,
		});
		expect(await unprocessed(w, id)).toBe(0);
	});
});

async function sandbox(
	w: TestWorld,
	id: string,
): Promise<Record<string, unknown>> {
	const r = await w.pool.query(
		"SELECT * FROM runtime.sandboxes WHERE id = $1",
		[id],
	);
	return r.rows[0];
}

describe("machine-events (§10.2)", () => {
	it("duplicates and reordered batches give the same result", async () => {
		const w = await createWorld(db);
		const t0 = Date.now() - 30_000;
		const at = (s: number) => new Date(t0 + s * 1000);
		const zero = { runningCommands: 0, openPtys: 0, tcpStreams: 0 };
		// zero, busy, zero: the sandbox is idle only since the second zero.
		const script = (bootId: string, cmd: string) => [
			ev(1, bootId, "activity", zero, at(1)),
			ev(
				2,
				bootId,
				"activity",
				{ runningCommands: 1, openPtys: 0, tcpStreams: 2 },
				at(2),
			),
			ev(
				3,
				bootId,
				"command.exited",
				{ commandId: cmd, status: "exited", code: 3, stdoutEnd: "10" },
				at(3),
			),
			ev(4, bootId, "activity", zero, at(4)),
			ev(5, bootId, "ports.changed", { listening: [{ port: 3000 }] }, at(5)),
			ev(6, bootId, "phase", { phase: "ready" }, at(6)),
		];
		const state = async (l: Linked, cmd: string) => {
			const s = await sandbox(w, l.sandboxId);
			const m = await machine(w, l.machineId);
			const c = await w.pool.query(
				"SELECT status, exit_code, stdout_bytes FROM runtime.commands WHERE id = $1",
				[cmd],
			);
			// The zero mark is the receive time of seq 4 (never earlier than the event).
			const r4 = await w.pool.query(
				"SELECT received_at FROM runtime.agent_events WHERE machine_id = $1 AND seq = 4",
				[l.machineId],
			);
			return {
				activity: s.activity,
				counters: s.activity_counters,
				lastActivityAt: (s.last_activity_at as Date).toISOString(),
				zeroSinceIsSeq4:
					(s.activity_zero_since as Date | null)?.toISOString() ===
					(r4.rows[0].received_at as Date).toISOString(),
				ports: s.listening_ports,
				phase: m.agent_phase,
				command: c.rows[0],
			};
		};
		const replay = async (orders: number[][]) => {
			const l = await linkedSandbox(w);
			const boot = await setSession(w, l.machineId);
			const cmd = await insertCommand(w, l, { bootId: boot });
			const all = script(boot, cmd);
			for (const seqs of orders) {
				await agentEvents(
					w,
					l.machineId,
					all.filter((e) => seqs.includes(e.seq)),
				);
				// Distinct receive times per batch.
				await new Promise((r) => setTimeout(r, 5));
			}
			return state(l, cmd);
		};

		const inOrder = await replay([[1, 2, 3, 4, 5, 6]]);
		expect(inOrder).toEqual({
			activity: "idle",
			counters: zero,
			lastActivityAt: at(4).toISOString(),
			zeroSinceIsSeq4: true,
			ports: [{ port: 3000 }],
			phase: "ready",
			command: { status: "exited", exit_code: 3, stdout_bytes: "10" },
		});
		// The busy event arrives after both zeros.
		expect(await replay([[1], [4, 5, 6], [2, 3], [1, 2, 3, 4, 5, 6]])).toEqual(
			inOrder,
		);
		// Newest first, then the older ones, then everything again.
		expect(await replay([[4, 5, 6], [2, 3], [1], [1, 2, 3, 4, 5, 6]])).toEqual(
			inOrder,
		);
		expect(await replay([[2], [1], [4], [3, 5, 6]])).toEqual(inOrder);
	});

	it("pool_ready of the current boot counts even after a later phase was processed", async () => {
		const w = await createWorld(db);
		const id = await insertMachine(w, { state: "booting" });
		const bootId = await setSession(w, id);
		await agentEvents(w, id, [phase(2, bootId, "ready")]);
		await agentEvents(w, id, [phase(1, bootId, "pool_ready")]);
		const m = await machine(w, id);
		expect(m.ready_boot_id).toBe(bootId);
		expect(m.state).toBe("warm");
		expect(m.agent_phase).toBe("ready");
		// A late pool_ready of an older boot does not move ready_boot_id.
		await agentEvents(w, id, [phase(0, randomUUID(), "pool_ready")]);
		expect((await machine(w, id)).ready_boot_id).toBe(bootId);
	});

	it("activity: non-zero counters make the sandbox busy and clear the zero mark", async () => {
		const w = await createWorld(db);
		const l = await linkedSandbox(w);
		const boot = await setSession(w, l.machineId);
		await agentEvents(w, l.machineId, [
			ev(1, boot, "activity", {
				runningCommands: 0,
				openPtys: 0,
				tcpStreams: 0,
			}),
		]);
		const zero = (await sandbox(w, l.sandboxId)).activity_zero_since as Date;
		expect(zero).not.toBeNull();
		// A later heartbeat with zeros keeps the first zero time.
		await agentEvents(w, l.machineId, [
			ev(2, boot, "activity", {
				runningCommands: 0,
				openPtys: 0,
				tcpStreams: 0,
			}),
		]);
		expect((await sandbox(w, l.sandboxId)).activity_zero_since).toEqual(zero);
		await agentEvents(w, l.machineId, [
			ev(3, boot, "activity", {
				runningCommands: 0,
				openPtys: 1,
				tcpStreams: 0,
			}),
		]);
		const s = await sandbox(w, l.sandboxId);
		expect(s.activity).toBe("busy");
		expect(s.activity_zero_since).toBeNull();
	});

	it("rebooted: commands of the previous boot are lost, reprovision is enqueued once", async () => {
		const w = await createWorld(db);
		const old = randomUUID();
		const l = await linkedSandbox(w, { provisionedBootId: old });
		const oldCmd = await insertCommand(w, l, { bootId: old });
		const doneCmd = await insertCommand(w, l, {
			bootId: old,
			status: "exited",
		});
		const fresh = await setSession(w, l.machineId);
		const newCmd = await insertCommand(w, l, { bootId: fresh });
		w.jobs.clear();

		await synthetic(w, l.machineId, "disconnected", "rebooted", "connected");

		// The guest rebooted: the reason the agent gives such commands (S3).
		expect(await commandOutcome(w, oldCmd)).toMatchObject({
			status: "lost",
			reason: "reboot",
		});
		expect(await commandOutcome(w, doneCmd)).toMatchObject({
			status: "exited",
			reason: null,
		});
		expect(await commandStatus(w, newCmd)).toBe("running");
		const s = await sandbox(w, l.sandboxId);
		expect(s.last_reboot_at).not.toBeNull();
		expect(s.last_reboot_reason).toBe("guest_reboot");
		const ops = await activeOps(w, l.sandboxId);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.kind).toBe("reprovision");
		expect(ops[0]?.request).toEqual({ cause: "rebooted", bootId: fresh });
		const op = await row(w, "operations", ops[0]?.id as string);
		expect(op.deadline_at).not.toBeNull();
		expect(op.requested_by).toBeNull();
		expect(w.jobs.sent.filter((j) => j.queue === "sandbox-op")).toEqual([
			{
				queue: "sandbox-op",
				data: { operationId: ops[0]?.id },
				opts: { singletonKey: l.sandboxId },
			},
		]);

		// A second reboot event while the reprovision is active: nothing more.
		await synthetic(w, l.machineId, "rebooted");
		expect(await activeOps(w, l.sandboxId)).toHaveLength(1);
	});

	it("rebooted: no reprovision for a provisioned boot, another active operation or a non-ready sandbox", async () => {
		const w = await createWorld(db);
		const boot = randomUUID();
		const provisioned = await linkedSandbox(w, { provisionedBootId: boot });
		await setSession(w, provisioned.machineId, { bootId: boot });
		await synthetic(w, provisioned.machineId, "rebooted");
		expect(await activeOps(w, provisioned.sandboxId)).toEqual([]);

		const busy = await linkedSandbox(w, { provisionedBootId: randomUUID() });
		await setSession(w, busy.machineId);
		await w.pool.query(
			"INSERT INTO runtime.operations (sandbox_id, kind, state) VALUES ($1, 'stop', 'running')",
			[busy.sandboxId],
		);
		await synthetic(w, busy.machineId, "rebooted");
		expect((await activeOps(w, busy.sandboxId)).map((o) => o.kind)).toEqual([
			"stop",
		]);

		const stopping = await linkedSandbox(w, {
			state: "stopping",
			provisionedBootId: randomUUID(),
		});
		await setSession(w, stopping.machineId);
		await synthetic(w, stopping.machineId, "rebooted");
		expect(await activeOps(w, stopping.sandboxId)).toEqual([]);
	});

	it("phase secrets_missing on the current, unprovisioned boot enqueues reprovision", async () => {
		const w = await createWorld(db);
		const boot = randomUUID();
		const done = await linkedSandbox(w, { provisionedBootId: boot });
		await setSession(w, done.machineId, { bootId: boot });
		await agentEvents(w, done.machineId, [
			ev(1, boot, "phase", { phase: "secrets_missing" }),
		]);
		expect(await activeOps(w, done.sandboxId)).toEqual([]);

		const l = await linkedSandbox(w, { provisionedBootId: randomUUID() });
		const cur = await setSession(w, l.machineId);
		// An event of an older boot says nothing about the current one.
		await agentEvents(w, l.machineId, [
			ev(1, randomUUID(), "phase", { phase: "secrets_missing" }),
		]);
		expect(await activeOps(w, l.sandboxId)).toEqual([]);
		await agentEvents(w, l.machineId, [
			ev(2, cur, "phase", { phase: "secrets_missing" }),
		]);
		const ops = await activeOps(w, l.sandboxId);
		expect(ops.map((o) => o.request)).toEqual([
			{ cause: "secrets_missing", bootId: cur },
		]);
		expect((await machine(w, l.machineId)).agent_phase).toBe("secrets_missing");
	});

	it("reboot of a real sandbox: the reprovision delivers again and records the new boot", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const r = await readySandbox(w, e);
		const before = await machine(w, r.machineId);
		const fresh = await setSession(w, r.machineId);
		await synthetic(w, r.machineId, "rebooted");
		const ops = await activeOps(w, r.sandboxId);
		expect(ops).toHaveLength(1);
		const updates = w.agent.callsOf("updateSecrets").length;
		expect(await run(w, ops[0]?.id as string)).toBe("succeeded");
		const after = await machine(w, r.machineId);
		expect(before.provisioned_boot_id).not.toBe(fresh);
		expect(after.provisioned_boot_id).toBe(fresh);
		expect(w.agent.callsOf("updateSecrets").length).toBe(updates + 1);
		expect((await sandbox(w, r.sandboxId)).state).toBe("ready");
	});

	it("command.exited and pty.closed never overwrite a terminal status or another machine's command", async () => {
		const w = await createWorld(db);
		const l = await linkedSandbox(w);
		const other = await linkedSandbox(w);
		const boot = await setSession(w, l.machineId);
		const pty = await insertCommand(w, l, { bootId: boot, mode: "pty" });
		const killed = await insertCommand(w, l, {
			bootId: boot,
			status: "killed",
		});
		const foreign = await insertCommand(w, other, { bootId: boot });
		await agentEvents(w, l.machineId, [
			ev(1, boot, "pty.closed", { commandId: pty }),
			ev(2, boot, "command.exited", {
				commandId: killed,
				status: "exited",
				code: 0,
			}),
			ev(3, boot, "command.exited", {
				commandId: foreign,
				status: "exited",
				code: 0,
			}),
			ev(4, boot, "command.exited", {
				commandId: "nope",
				status: "exited",
				code: 0,
			}),
		]);
		expect(await commandStatus(w, pty)).toBe("exited");
		expect(await commandStatus(w, killed)).toBe("killed");
		expect(await commandStatus(w, foreign)).toBe("running");
		expect(await unprocessed(w, l.machineId)).toBe(0);
	});

	it("command.exited stores the exit reason and output_truncated; output.truncated marks a running or ended command", async () => {
		const w = await createWorld(db);
		const l = await linkedSandbox(w);
		const other = await linkedSandbox(w);
		const boot = await setSession(w, l.machineId);
		const oom = await insertCommand(w, l, { bootId: boot });
		const running = await insertCommand(w, l, { bootId: boot });
		const pty = await insertCommand(w, l, { bootId: boot, mode: "pty" });
		const foreign = await insertCommand(w, other, { bootId: boot });
		await agentEvents(w, l.machineId, [
			ev(1, boot, "command.exited", {
				commandId: oom,
				status: "EXIT_STATUS_KILLED",
				code: 137,
				signal: "SIGKILL",
				reason: "EXIT_REASON_OOM",
				outputTruncated: "disk_full",
			}),
			ev(2, boot, "output.truncated", {
				commandId: running,
				stream: "STREAM_STDOUT",
				reason: "disk_full",
			}),
			ev(3, boot, "pty.closed", {
				commandId: pty,
				reason: "EXIT_REASON_PTY_IDLE",
			}),
			// After the end: the reason is kept, output_truncated is added.
			ev(4, boot, "output.truncated", { commandId: pty, reason: "disk_full" }),
			ev(5, boot, "output.truncated", {
				commandId: foreign,
				reason: "disk_full",
			}),
			ev(6, boot, "output.truncated", { commandId: "nope", reason: "x" }),
		]);
		expect(await commandOutcome(w, oom)).toEqual({
			status: "killed",
			reason: "oom",
			output_truncated: "disk_full",
		});
		expect(await commandOutcome(w, running)).toEqual({
			status: "running",
			reason: null,
			output_truncated: "disk_full",
		});
		expect(await commandOutcome(w, pty)).toEqual({
			status: "exited",
			reason: "pty_idle",
			output_truncated: "disk_full",
		});
		expect(await commandOutcome(w, foreign)).toEqual({
			status: "running",
			reason: null,
			output_truncated: null,
		});
		expect(await unprocessed(w, l.machineId)).toBe(0);
	});

	it("identity_changed is expected only on the first boot of a machine from a snapshot", async () => {
		const w = await createWorld(db);
		const fork = await linkedSandbox(w, {
			origin: "snapshot",
			machineState: "booting",
		});
		await synthetic(w, fork.machineId, "identity_changed");
		expect(w.metrics.count("sbx_unexpected_identity_change_total")).toBe(0);

		const provisionedFork = await linkedSandbox(w, {
			origin: "snapshot",
			provisionedBootId: randomUUID(),
		});
		await synthetic(w, provisionedFork.machineId, "identity_changed");
		const plain = await linkedSandbox(w);
		await synthetic(w, plain.machineId, "identity_changed");
		expect(w.metrics.count("sbx_unexpected_identity_change_total")).toBe(2);
	});

	it("agent_restarted is only logged; disconnected changes nothing", async () => {
		const w = await createWorld(db);
		const l = await linkedSandbox(w);
		const boot = await setSession(w, l.machineId);
		const cmd = await insertCommand(w, l, { bootId: boot });
		const before = await sandbox(w, l.sandboxId);
		await synthetic(w, l.machineId, "agent_restarted", "disconnected");
		expect(await commandStatus(w, cmd)).toBe("running");
		const after = await sandbox(w, l.sandboxId);
		expect(after.version).toBe(before.version);
		expect(after.health).toBe("ok");
		expect(w.logs.some((x) => x.includes("agent restarted"))).toBe(true);
	});

	it("quiesce.watchdog_thawed marks the machine's creating snapshot quiesce_broken", async () => {
		const w = await createWorld(db);
		const l = await linkedSandbox(w);
		const boot = await setSession(w, l.machineId);
		const { snapshotId } = await insertSnapshot(w, {
			state: "creating",
			kind: "saved",
		});
		const { snapshotId: ready } = await insertSnapshot(w, {
			state: "ready",
			kind: "saved",
		});
		await w.pool.query(
			"UPDATE runtime.snapshots SET source_machine_id = $2 WHERE id = ANY($1::uuid[])",
			[[snapshotId, ready], l.machineId],
		);
		await agentEvents(w, l.machineId, [
			ev(1, boot, "quiesce.auto_thawed", { by: "watchdog" }),
		]);
		expect((await row(w, "snapshots", snapshotId)).quiesce_broken).toBe(true);
		expect((await row(w, "snapshots", ready)).quiesce_broken).toBe(false);
		expect(w.metrics.count("sbx_quiesce_watchdog_thawed_total")).toBe(1);
	});
});
