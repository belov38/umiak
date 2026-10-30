import { randomUUID } from "node:crypto";
import { nodeRam, stepRequestId } from "@sbx/core";
import { withTx } from "@sbx/db";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSandboxOp } from "../src/handlers/sandbox-op.ts";
import {
	blockAfter,
	crashAfter,
	SimulatedCrash,
	spyBefore,
} from "./fakes/crash.ts";
import {
	createWorld,
	insertMachine,
	insertOperation,
	type TestWorld,
} from "./fakes/world.ts";
import {
	dbNow,
	ENV,
	expireDeadline,
	opsEnv,
	readySandbox,
	row,
	run,
	SECRETS,
	sessionBoot,
	stoppedSandbox,
} from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

async function insertCommand(
	w: TestWorld,
	sandboxId: string,
	machineId: string,
	status: string,
): Promise<string> {
	const id = randomUUID();
	await w.pool.query(
		`INSERT INTO runtime.commands (id, sandbox_id, machine_id, cmd, mode, status)
		 VALUES ($1, $2, $3, 'sleep 1000', 'detached', $4)`,
		[id, sandboxId, machineId, status],
	);
	return id;
}

async function commandStatus(w: TestWorld, id: string): Promise<string> {
	const r = await w.pool.query<{ status: string }>(
		"SELECT status FROM runtime.commands WHERE id = $1",
		[id],
	);
	return r.rows[0]?.status ?? "missing";
}

function poweredMb(w: TestWorld): Promise<number> {
	return withTx(
		w.pool,
		async (tx) => (await nodeRam(tx, w.topo.nodeId)).poweredMb,
	);
}

/** A machine whose VM is gone: failed machine_lost, power observed stopped, not in powered RAM. */
async function expectLostFreed(w: TestWorld, machineId: string): Promise<void> {
	const m = await row(w, "machines", machineId);
	expect(m.state).toBe("failed");
	expect(m.error_code).toBe("machine_lost");
	expect(m.power_observed).toBe("stopped");
	expect(m.power_observed_at).not.toBeNull();
	expect(await poweredMb(w)).toBe(0);
}

function vmOf(w: TestWorld, machineId: string) {
	const [vm] = w.infra.vmsOf(machineId);
	if (!vm) throw new Error(`no VM for ${machineId}`);
	return vm;
}

describe("stop", () => {
	it("prepare is best effort: an unavailable agent still stops; running commands → lost", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e);
		const running = await insertCommand(w, sandboxId, machineId, "running");
		const starting = await insertCommand(w, sandboxId, machineId, "starting");
		const exited = await insertCommand(w, sandboxId, machineId, "exited");
		w.agent.fail("prepareStop", "unavailable");

		const op = await e.svc.stop(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("succeeded");

		const s = await row(w, "sandboxes", sandboxId);
		const m = await row(w, "machines", machineId);
		expect(s.state).toBe("stopped");
		expect(s.stopped_at).not.toBeNull();
		expect(s.stop_reason).toBe("user");
		expect(m.state).toBe("stopped");
		expect(m.power_observed).toBe("stopped");
		expect(vmOf(w, machineId).status).toBe("stopped");
		expect(w.agent.callsOf("prepareStop")).toHaveLength(1);
		expect(w.infra.callsOf("shutdown")).toHaveLength(1);
		expect(w.infra.callsOf("stop")).toHaveLength(0);
		expect(await commandStatus(w, running)).toBe("lost");
		expect(await commandStatus(w, starting)).toBe("lost");
		expect(await commandStatus(w, exited)).toBe("exited");
	});

	it("a shutdown that times out is followed by a hard stop", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e);
		w.infra.shutdown = async () => "timeout";

		const op = await e.svc.stop(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("succeeded");

		expect(w.infra.callsOf("stop")).toHaveLength(1);
		expect(vmOf(w, machineId).status).toBe("stopped");
		expect((await row(w, "sandboxes", sandboxId)).state).toBe("stopped");
	});

	it("a machine that left running/stopping before finish: machine_state_conflict, the machine is left alone", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e);
		const blocked = blockAfter(w.infra, "shutdown");
		w.useInfra(blocked.port);
		const op = await e.svc.stop(e.p, sandboxId);
		const pending = handleSandboxOp(w.ctx, { operationId: op.id });
		await blocked.reached;
		await w.pool.query(
			"UPDATE runtime.machines SET state = 'starting' WHERE id = $1",
			[machineId],
		);
		blocked.release();

		expect(await pending).toBe("failed");
		const s = await row(w, "sandboxes", sandboxId);
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("machine_state_conflict");
		expect((await row(w, "operations", op.id)).error_code).toBe(
			"machine_state_conflict",
		);
		const m = await row(w, "machines", machineId);
		expect(m.state).toBe("starting");
		expect(m.error_code).toBeNull();
	});

	it("the VM is missing: machine failed machine_lost and its RAM no longer counts as powered", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e);
		expect(await poweredMb(w)).toBeGreaterThan(0);
		w.infra.vms.delete(vmOf(w, machineId).vmid);

		const op = await e.svc.stop(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("failed");

		const s = await row(w, "sandboxes", sandboxId);
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("machine_lost");
		await expectLostFreed(w, machineId);
	});

	it("past its deadline: sandbox error stop_failed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId } = await readySandbox(w, e);
		const op = await e.svc.stop(e.p, sandboxId);
		await expireDeadline(w, op.id);

		expect(await run(w, op.id)).toBe("failed");

		const s = await row(w, "sandboxes", sandboxId);
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("stop_failed");
		expect((await row(w, "operations", op.id)).error_code).toBe(
			"deadline_exceeded",
		);
	});
});

describe("resume", () => {
	it("delivers env and secrets with UpdateEnv + UpdateSecrets on the new boot", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await stoppedSandbox(w, e);
		const oldBoot = (await row(w, "machines", machineId)).provisioned_boot_id;

		const op = await e.svc.resume(e.p, sandboxId, {
			env: { EXTRA: "1" },
			secrets: { API_TOKEN: null, NEW_SECRET: "n" },
			ttlSeconds: 600,
		});
		expect(await run(w, op.id)).toBe("succeeded");

		const s = await row(w, "sandboxes", sandboxId);
		const m = await row(w, "machines", machineId);
		expect(s.state).toBe("ready");
		expect(s.health).toBe("ok");
		const left = (s.deadline_at as Date).getTime() - (await dbNow(w));
		expect(left).toBeGreaterThan(590_000);
		expect(m.state).toBe("running");
		expect(m.provisioned_boot_id).not.toBe(oldBoot);
		expect(m.provisioned_boot_id).toBe(await sessionBoot(w, machineId));
		expect(w.agent.callsOf("updateEnv")).toEqual([
			{
				method: "updateEnv",
				machineId,
				requestId: stepRequestId(op.id, "provision:env"),
				args: { ...ENV, EXTRA: "1" },
			},
		]);
		expect(w.agent.callsOf("updateSecrets")).toEqual([
			{
				method: "updateSecrets",
				machineId,
				requestId: stepRequestId(op.id, "provision:secrets"),
				args: {
					secretEnv: { NEW_SECRET: "n" },
					secretFiles: [
						{
							name: "id_rsa",
							contentBase64: Buffer.from("key").toString("base64"),
							mode: 0o440,
						},
					],
				},
			},
		]);
		// Claim is once per identity (S3 §8.1).
		expect(w.agent.callsOf("claim")).toHaveLength(1);
		expect(w.infra.callsOf("configure")).toHaveLength(0);
		expect(vmOf(w, machineId).starts).toBe(2);
	});

	it("with a new size: PUT config while the VM is off", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await stoppedSandbox(w, e);
		const vmid = vmOf(w, machineId).vmid;

		const op = await e.svc.resume(e.p, sandboxId, { size: "4gb" });
		expect(await run(w, op.id)).toBe("succeeded");

		expect(w.infra.callsOf("configure")).toEqual([
			{ method: "configure", args: [vmid, { vcpu: 2, memoryMb: 4096 }] },
		]);
		const configured = w.infra.calls.findIndex((c) => c.method === "configure");
		const started = w.infra.calls.findLastIndex((c) => c.method === "start");
		expect(configured).toBeLessThan(started);
		expect(vmOf(w, machineId).memoryMb).toBe(4096);
		expect((await row(w, "sandboxes", sandboxId)).state).toBe("ready");
	});

	it("a failure: hard stop, machine stopped, sandbox error resume_failed; resume works again", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await stoppedSandbox(w, e);
		w.agent.fail("updateEnv", { rejected: "bad_env" });

		const op = await e.svc.resume(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("failed");

		const s = await row(w, "sandboxes", sandboxId);
		const m = await row(w, "machines", machineId);
		expect((await row(w, "operations", op.id)).error_code).toBe("bad_env");
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("resume_failed");
		expect(m.state).toBe("stopped");
		expect(m.power_observed).toBe("stopped");
		expect(vmOf(w, machineId).status).toBe("stopped");

		const again = await e.svc.resume(e.p, sandboxId);
		expect(await run(w, again.id)).toBe("succeeded");
		expect((await row(w, "sandboxes", sandboxId)).state).toBe("ready");
	});

	it("a crash inside compensation (after the hard stop) is finished by the next attempt with the original error", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await stoppedSandbox(w, e);
		w.agent.fail("updateEnv", { rejected: "bad_env" });
		w.useInfra(crashAfter(w.infra, "stop"));
		const op = await e.svc.resume(e.p, sandboxId);

		await expect(
			handleSandboxOp(w.ctx, { operationId: op.id }),
		).rejects.toBeInstanceOf(SimulatedCrash);
		const mid = await row(w, "operations", op.id);
		expect(mid.state).toBe("running");
		expect(mid.progress).toMatchObject({ compensating: "bad_env" });
		expect(vmOf(w, machineId).status).toBe("stopped");
		w.useInfra(w.infra);

		expect(await run(w, op.id)).toBe("failed");

		const done = await row(w, "operations", op.id);
		expect(done.error_code).toBe("bad_env");
		const s = await row(w, "sandboxes", sandboxId);
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("resume_failed");
		expect((await row(w, "machines", machineId)).state).toBe("stopped");
		// The steps did not run again.
		expect(w.agent.callsOf("updateEnv")).toHaveLength(1);
		expect(w.infra.callsOf("start")).toHaveLength(2); // create + this resume
	});

	it("a machine in a state resume cannot start from: machine_state_conflict, no hard stop, the machine is left alone", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await stoppedSandbox(w, e);
		const op = await e.svc.resume(e.p, sandboxId);
		await w.pool.query(
			"UPDATE runtime.machines SET state = 'running' WHERE id = $1",
			[machineId],
		);
		const stopsBefore = w.infra.callsOf("stop").length;

		expect(await run(w, op.id)).toBe("failed");

		const s = await row(w, "sandboxes", sandboxId);
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("machine_state_conflict");
		const m = await row(w, "machines", machineId);
		expect(m.state).toBe("running");
		expect(m.error_code).toBeNull();
		expect(w.infra.callsOf("stop")).toHaveLength(stopsBefore);
	});

	it("a start gate wait ends at the operation deadline, not at the configured timeout", async () => {
		const w = await createWorld(db, {
			ramCapMb: 4096,
			timing: { ramWaitTimeoutMs: 60_000 },
		});
		const e = opsEnv(w);
		const { sandboxId, machineId } = await stoppedSandbox(w, e);
		const op = await e.svc.resume(e.p, sandboxId);
		// A deleting machine whose VM still runs holds powered RAM (§8.1).
		await insertMachine(w, {
			state: "deleting",
			poolKey: null,
			memoryMb: 3072,
			powerObserved: "running",
		});
		await w.pool.query(
			"UPDATE runtime.operations SET deadline_at = now() + interval '300 milliseconds' WHERE id = $1",
			[op.id],
		);
		const startsBefore = w.infra.callsOf("start").length;

		// Far below the configured 60 s, with room for a loaded machine.
		const t0 = Date.now();
		expect(await run(w, op.id)).toBe("failed");
		expect(Date.now() - t0).toBeLessThan(20_000);

		expect((await row(w, "operations", op.id)).error_code).toBe(
			"deadline_exceeded",
		);
		expect((await row(w, "sandboxes", sandboxId)).error_code).toBe(
			"resume_failed",
		);
		expect((await row(w, "machines", machineId)).state).toBe("stopped");
		expect(w.infra.callsOf("start")).toHaveLength(startsBefore);
	});

	it("past its deadline: hard stop and resume_failed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await stoppedSandbox(w, e);
		const op = await e.svc.resume(e.p, sandboxId);
		await expireDeadline(w, op.id);

		expect(await run(w, op.id)).toBe("failed");

		expect((await row(w, "sandboxes", sandboxId)).error_code).toBe(
			"resume_failed",
		);
		expect((await row(w, "machines", machineId)).state).toBe("stopped");
		expect(w.infra.callsOf("start")).toHaveLength(1); // the create only
	});
});

describe("recover", () => {
	it("from running with the VM missing: machine failed machine_lost and its RAM no longer counts as powered", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e);
		w.infra.vms.delete(vmOf(w, machineId).vmid);

		const op = await e.svc.recover(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("failed");

		const s = await row(w, "sandboxes", sandboxId);
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("machine_lost");
		await expectLostFreed(w, machineId);
	});

	it("from error with a stopped machine and the VM missing: machine_lost, not a resize failure", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await stoppedSandbox(w, e);
		w.agent.fail("updateEnv", { rejected: "bad_env" });
		const resume = await e.svc.resume(e.p, sandboxId);
		expect(await run(w, resume.id)).toBe("failed");
		w.infra.vms.delete(vmOf(w, machineId).vmid);

		const op = await e.svc.recover(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("failed");
		expect((await row(w, "sandboxes", sandboxId)).error_code).toBe(
			"machine_lost",
		);
		expect(w.infra.callsOf("configure")).toHaveLength(0);
	});

	it("from ready: hard power cycle, new boot provisioned, ready again", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e);
		const oldBoot = await sessionBoot(w, machineId);

		const op = await e.svc.recover(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("succeeded");

		const m = await row(w, "machines", machineId);
		expect((await row(w, "sandboxes", sandboxId)).state).toBe("ready");
		expect(m.state).toBe("running");
		expect(m.provisioned_boot_id).not.toBe(oldBoot);
		expect(m.provisioned_boot_id).toBe(await sessionBoot(w, machineId));
		expect(w.infra.callsOf("stop")).toHaveLength(1);
		expect(vmOf(w, machineId).starts).toBe(2);
		expect(w.agent.callsOf("updateEnv")).toHaveLength(1);
		expect(w.agent.callsOf("updateSecrets")).toHaveLength(1);
	});

	it("from error with a stopped machine: start gate and start", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await stoppedSandbox(w, e);
		w.agent.fail("updateEnv", { rejected: "bad_env" });
		const resume = await e.svc.resume(e.p, sandboxId);
		expect(await run(w, resume.id)).toBe("failed");
		const stopsBefore = w.infra.callsOf("stop").length;

		const op = await e.svc.recover(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("succeeded");

		expect((await row(w, "sandboxes", sandboxId)).state).toBe("ready");
		expect((await row(w, "machines", machineId)).state).toBe("running");
		expect(w.infra.callsOf("stop")).toHaveLength(stopsBefore);
	});

	it("after a failed resume that shrank the size: the VM is resized before the start (its RAM is the RAM counted)", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e, { size: "4gb" });
		const stop = await e.svc.stop(e.p, sandboxId);
		expect(await run(w, stop.id)).toBe("succeeded");
		expect(vmOf(w, machineId).memoryMb).toBe(4096);

		// The resume to 2gb fails in its resize step: the row (the admitted
		// reservation) says 2048, the VM config still 4096.
		w.useInfra(
			spyBefore(w.infra, "configure", async () => {
				throw Object.assign(new Error("config refused"), {
					code: "bad_config",
					retryable: false,
				});
			}),
		);
		const resume = await e.svc.resume(e.p, sandboxId, { size: "2gb" });
		expect(await run(w, resume.id)).toBe("failed");
		w.useInfra(w.infra);
		expect((await row(w, "sandboxes", sandboxId)).state).toBe("error");
		expect((await row(w, "machines", machineId)).memory_mb).toBe(2048);
		expect(vmOf(w, machineId).memoryMb).toBe(4096);

		const op = await e.svc.recover(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("succeeded");
		expect(vmOf(w, machineId).memoryMb).toBe(2048);
		const configured = w.infra.calls.findLastIndex(
			(c) => c.method === "configure",
		);
		const started = w.infra.calls.findLastIndex((c) => c.method === "start");
		expect(configured).toBeGreaterThan(-1);
		expect(configured).toBeLessThan(started);
		expect(await poweredMb(w)).toBe(2048);
	});

	it("a failure: hard stop, machine stopped, sandbox error resume_failed (§6.1)", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e);
		w.agent.fail("updateSecrets", { rejected: "bad_secrets" });

		const op = await e.svc.recover(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("failed");

		const s = await row(w, "sandboxes", sandboxId);
		expect((await row(w, "operations", op.id)).error_code).toBe("bad_secrets");
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("resume_failed");
		expect((await row(w, "machines", machineId)).state).toBe("stopped");
		expect(vmOf(w, machineId).status).toBe("stopped");
	});

	it("a machine with no recover path: failed recover_unsupported, the machine is left alone", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e);
		await w.pool.query(
			"UPDATE runtime.sandboxes SET state = 'error', error_code = 'x' WHERE id = $1",
			[sandboxId],
		);
		await w.pool.query(
			"UPDATE runtime.machines SET state = 'claiming' WHERE id = $1",
			[machineId],
		);
		const calls = w.infra.calls.length;

		const op = await e.svc.recover(e.p, sandboxId);
		expect(await run(w, op.id)).toBe("failed");

		const s = await row(w, "sandboxes", sandboxId);
		expect((await row(w, "operations", op.id)).error_code).toBe(
			"recover_unsupported",
		);
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("recover_unsupported");
		expect((await row(w, "machines", machineId)).state).toBe("claiming");
		expect(w.infra.calls.slice(calls)).toEqual([]);
	});
});

describe("reprovision", () => {
	it("skipped when the current boot is already provisioned", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId } = await readySandbox(w, e);
		const opId = await insertOperation(w, {
			sandboxId,
			kind: "reprovision",
			deadlineInS: 300,
		});

		expect(await run(w, opId)).toBe("succeeded");

		expect(w.agent.callsOf("updateEnv")).toHaveLength(0);
		expect(w.agent.callsOf("updateSecrets")).toHaveLength(0);
		expect((await row(w, "operations", opId)).step).toBe("provision");
		expect((await row(w, "sandboxes", sandboxId)).state).toBe("ready");
	});

	it("after a guest reboot: env and secrets delivered, provisioned_boot_id = the new boot", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e);
		const newBoot = randomUUID();
		await w.pool.query(
			"UPDATE tunnel.tunnel_sessions SET boot_id = $2 WHERE machine_id = $1",
			[machineId, newBoot],
		);
		const opId = await insertOperation(w, {
			sandboxId,
			kind: "reprovision",
			deadlineInS: 300,
		});

		expect(await run(w, opId)).toBe("succeeded");

		expect(w.agent.callsOf("updateEnv").map((c) => c.args)).toEqual([ENV]);
		expect(w.agent.callsOf("updateSecrets").map((c) => c.args)).toMatchObject([
			{ secretEnv: SECRETS },
		]);
		expect((await row(w, "machines", machineId)).provisioned_boot_id).toBe(
			newBoot,
		);
		expect((await row(w, "sandboxes", sandboxId)).state).toBe("ready");
	});
});
