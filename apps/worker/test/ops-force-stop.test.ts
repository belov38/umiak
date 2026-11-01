// S9 §24.8: Windows disks are snapshotted only from a stopped VM. A running
// Windows source is refused (`snapshot_requires_stop`) unless the request has
// `forceStop`; then the operation stops the source, snapshots it, starts it
// again and only then hands the fork over. Linux ignores the flag.
import { isUmiakError, type UmiakError } from "@umiak/core";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorld, type TestWorld } from "./fakes/world.ts";
import {
	forkSandbox,
	type OpsEnv,
	opsEnv,
	readySandbox,
	row,
	run,
	sandboxOpJobs,
	snapshotsOf,
	stoppedSandbox,
} from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

async function makeWindows(w: TestWorld): Promise<void> {
	await w.pool.query(
		"UPDATE runtime.template_builds SET os = 'windows' WHERE id = $1",
		[w.topo.templateBuildId],
	);
}

async function windowsSource(
	w: TestWorld,
	e: OpsEnv,
): Promise<{ sandboxId: string; machineId: string }> {
	const s = await readySandbox(w, e);
	await makeWindows(w);
	return s;
}

/** Power calls on the infra fake, in order. */
function powerCalls(w: TestWorld): string[] {
	return w.infra.calls
		.map((c) => c.method)
		.filter((m) => ["shutdown", "stop", "start", "snapshot"].includes(m));
}

async function thrown(p: Promise<unknown>): Promise<UmiakError> {
	try {
		await p;
	} catch (e) {
		if (isUmiakError(e)) return e;
		throw e;
	}
	throw new Error("expected an UmiakError");
}

/** The guest ignores the shutdown: S1 reports a timeout, the VM keeps running. */
function shutdownTimesOut(w: TestWorld): void {
	w.infra.shutdown = (vmid, timeoutS) => {
		w.infra.calls.push({ method: "shutdown", args: [vmid, timeoutS] });
		return Promise.resolve("timeout" as const);
	};
}

async function setDeadline(
	w: TestWorld,
	opId: string,
	secondsFromNow: number,
): Promise<void> {
	await w.pool.query(
		`UPDATE runtime.operations
		 SET deadline_at = now() + make_interval(secs => $2::double precision)
		 WHERE id = $1`,
		[opId, secondsFromNow],
	);
}

async function opCount(w: TestWorld, sandboxId: string): Promise<number> {
	const r = await w.pool.query<{ n: number }>(
		"SELECT count(*)::int AS n FROM runtime.operations WHERE sandbox_id = $1",
		[sandboxId],
	);
	return r.rows[0]?.n ?? 0;
}

describe("running Windows without forceStop", () => {
	it("fork is snapshot_requires_stop with a hint to retry with forceStop", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		const before = await opCount(w, s.sandboxId);

		const err = await thrown(e.svc.fork(e.p, s.sandboxId, {}));

		expect(err.code).toBe("snapshot_requires_stop");
		expect(err.retryable).toBe(false);
		expect(err.message).toMatch(/forked from a stopped VM/);
		expect(err.message).toMatch(/forceStop: true \(CLI --force-stop\)/);
		expect(err.details).toEqual({
			reason: "windows_running",
			retryWith: { forceStop: true },
			cli: "--force-stop",
		});
		expect(await opCount(w, s.sandboxId)).toBe(before);
		expect(w.infra.callsOf("snapshot")).toHaveLength(0);
	});

	it("saved snapshot is snapshot_requires_stop with the save wording", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);

		const err = await thrown(e.svc.saveSnapshot(e.p, s.sandboxId, "win"));

		expect(err.code).toBe("snapshot_requires_stop");
		expect(err.message).toMatch(/saved from a stopped VM/);
		expect(err.details.retryWith).toEqual({ forceStop: true });
		expect(await snapshotsOf(w, s.sandboxId)).toEqual([]);
	});

	it("the worker refuses a live Windows snapshot on its own", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		// Linux at the API, Windows by the time the worker runs.
		const f = await forkSandbox(e, s.sandboxId);
		await makeWindows(w);

		expect(await run(w, f.forkOpId)).toBe("failed");

		const op = await row(w, "operations", f.forkOpId);
		expect(op.error_code).toBe("snapshot_requires_stop");
		expect(op.error_message).toMatch(/forceStop: true/);
		expect(w.infra.callsOf("snapshot")).toHaveLength(0);
	});
});

describe("forced fork of a running Windows sandbox", () => {
	it("stops, snapshots powered_off, starts again, then hands the fork over", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		expect((await row(w, "operations", f.forkOpId)).request).toMatchObject({
			forceStop: true,
		});
		await w.pool.query(
			`INSERT INTO runtime.commands (id, sandbox_id, machine_id, cmd, mode, status)
			 VALUES ('cmd-force-stop', $1, $2, 'sleep 100', 'detached', 'running')`,
			[s.sandboxId, s.machineId],
		);
		const order: string[] = [];
		const start = w.infra.start.bind(w.infra);
		w.infra.start = (vmid, o) => {
			order.push(`start, target jobs ${sandboxOpJobs(w, f.createOpId).length}`);
			return start(vmid, o);
		};
		const bootBefore = (await row(w, "machines", s.machineId))
			.provisioned_boot_id;
		const secretsBefore = w.agent.callsOf("updateSecrets").length;
		w.infra.calls.length = 0;

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		expect(powerCalls(w)).toEqual(["shutdown", "snapshot", "start"]);
		// The target's create is scheduled only after the source was started.
		expect(order).toEqual(["start, target jobs 0"]);
		expect(sandboxOpJobs(w, f.createOpId)).toHaveLength(1);
		expect(w.agent.callsOf("prepareStop")).toHaveLength(1);
		const [snap] = await snapshotsOf(w, f.targetId);
		expect(snap).toMatchObject({ state: "ready", consistency: "powered_off" });

		const op = await row(w, "operations", f.forkOpId);
		expect(op.progress).toMatchObject({
			forceStopped: true,
			sourceRestarted: true,
		});
		expect(op.step).toBe("restart_provision");
		const m = await row(w, "machines", s.machineId);
		expect(m).toMatchObject({ state: "running", power_observed: "running" });
		expect(m.provisioned_boot_id).not.toBe(bootBefore);
		expect(w.agent.callsOf("updateSecrets").length).toBe(secretsBefore + 1);
		expect((await row(w, "sandboxes", s.sandboxId)).state).toBe("ready");
		const cmds = await w.pool.query(
			"SELECT status FROM runtime.commands WHERE machine_id = $1",
			[s.machineId],
		);
		expect(cmds.rows.map((r) => r.status)).toEqual(["lost"]);

		expect(await run(w, f.createOpId)).toBe("succeeded");
		expect((await row(w, "sandboxes", f.targetId)).state).toBe("ready");
	});

	it("the deadline covers the stop, and the restart gets its own budget", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		const op = await row(w, "operations", f.forkOpId);
		const ms =
			(op.deadline_at as Date).getTime() - (op.created_at as Date).getTime();
		// fork windows 3 min + stop windows 7 min.
		expect(ms).toBe(10 * 60_000);

		expect(await run(w, f.forkOpId)).toBe("succeeded");
		const after = await row(w, "operations", f.forkOpId);
		// Moved to at least now + the resume deadline (15 min) after the snapshot.
		expect(
			(after.deadline_at as Date).getTime() -
				(after.created_at as Date).getTime(),
		).toBeGreaterThanOrEqual(15 * 60_000);
	});

	it("retries the start on the qmeventd VM lock", async () => {
		const w = await createWorld(db);
		w.ctx.timing.vmLockSleep = async () => {};
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		const start = w.infra.start.bind(w.infra);
		let failures = 1;
		w.infra.start = (vmid, o) => {
			if (failures-- > 0) {
				return Promise.reject(
					new Error(
						`can't lock file '/var/lock/qemu-server/lock-${vmid}.conf' - got timeout`,
					),
				);
			}
			return start(vmid, o);
		};

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		expect((await row(w, "operations", f.forkOpId)).progress).toMatchObject({
			sourceRestarted: true,
		});
		expect((await row(w, "machines", s.machineId)).state).toBe("running");
	});

	it("a failed restart keeps the fork: the source shows resume_failed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		w.infra.start = () =>
			Promise.reject(
				Object.assign(new Error("start failed: no such bridge"), {
					retryable: false,
				}),
			);

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		const op = await row(w, "operations", f.forkOpId);
		expect(op.progress).toMatchObject({
			forceStopped: true,
			sourceRestarted: false,
			restartError: { message: expect.stringMatching(/no such bridge/) },
		});
		const [snap] = await snapshotsOf(w, f.targetId);
		expect(snap).toMatchObject({ state: "ready", consistency: "powered_off" });
		expect(sandboxOpJobs(w, f.createOpId)).toHaveLength(1);
		const src = await row(w, "sandboxes", s.sandboxId);
		expect(src).toMatchObject({ state: "error", error_code: "resume_failed" });
		expect(src.error_message).toMatch(/restart after the forced snapshot/);
		expect(await row(w, "machines", s.machineId)).toMatchObject({
			state: "stopped",
			power_observed: "stopped",
		});

		// The fork still boots; the source resumes normally.
		delete (w.infra as { start?: unknown }).start;
		expect(await run(w, f.createOpId)).toBe("succeeded");
		const resume = await e.svc.resume(e.p, s.sandboxId);
		expect(await run(w, resume.id)).toBe("succeeded");
		expect((await row(w, "sandboxes", s.sandboxId)).state).toBe("ready");
	});

	it("an agent that does not come back after the restart is a failed restart, not a failed fork", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		await w.pool.query(
			"UPDATE runtime.template_builds SET boot_timeout_s = 1 WHERE id = $1",
			[w.topo.templateBuildId],
		);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		w.agentWorld.behavior = "never";

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		expect((await row(w, "operations", f.forkOpId)).progress).toMatchObject({
			sourceRestarted: false,
			restartError: { code: "agent_timeout" },
		});
		expect((await row(w, "sandboxes", s.sandboxId)).error_code).toBe(
			"resume_failed",
		);
		expect((await row(w, "machines", s.machineId)).state).toBe("stopped");
	});
});

describe("forced saved snapshot of a running Windows sandbox", () => {
	it("PrepareStop wipes the secret files, the snapshot is powered_off, the source runs again", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		w.agent.secretFilesWiped = true;
		const r = await e.svc.saveSnapshot(e.p, s.sandboxId, "win", undefined, {
			forceStop: true,
		});
		w.infra.calls.length = 0;

		expect(await run(w, r.operation.id)).toBe("succeeded");

		expect(powerCalls(w)).toEqual(["shutdown", "snapshot", "start"]);
		expect(w.agent.callsOf("freeze")).toHaveLength(0);
		expect(await row(w, "snapshots", r.snapshot.id)).toMatchObject({
			state: "ready",
			name: "win",
			consistency: "powered_off",
		});
		expect((await row(w, "machines", s.machineId)).state).toBe("running");
		expect((await row(w, "operations", r.operation.id)).progress).toMatchObject(
			{ forceStopped: true, sourceRestarted: true },
		);
	});

	it("an unconfirmed secret wipe fails the save, and the source is started again", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		await w.pool.query(
			"UPDATE runtime.machines SET secret_files_on_disk = true WHERE id = $1",
			[s.machineId],
		);
		w.agent.fail("prepareStop", "unavailable");
		const r = await e.svc.saveSnapshot(e.p, s.sandboxId, "dirty", undefined, {
			forceStop: true,
		});
		w.infra.calls.length = 0;

		expect(await run(w, r.operation.id)).toBe("failed");

		const op = await row(w, "operations", r.operation.id);
		expect(op.error_code).toBe("snapshot_requires_clean_stop");
		expect(op.progress).toMatchObject({
			forceStopped: true,
			sourceRestarted: true,
		});
		expect(powerCalls(w)).toEqual(["shutdown", "start"]);
		expect((await row(w, "snapshots", r.snapshot.id)).state).toBe("failed");
		expect((await row(w, "machines", s.machineId)).state).toBe("running");
		expect((await row(w, "sandboxes", s.sandboxId)).state).toBe("ready");
	});
});

describe("unchanged paths", () => {
	it("stopped Windows: fork and save need no flag and take powered_off snapshots", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await stoppedSandbox(w, e);
		await makeWindows(w);
		await w.pool.query(
			"UPDATE runtime.machines SET secret_files_on_disk = false WHERE id = $1",
			[s.machineId],
		);
		const f = await forkSandbox(e, s.sandboxId);
		expect((await row(w, "operations", f.forkOpId)).request).not.toHaveProperty(
			"forceStop",
		);
		w.infra.calls.length = 0;
		expect(await run(w, f.forkOpId)).toBe("succeeded");
		expect(powerCalls(w)).toEqual(["snapshot"]);
		const [snap] = await snapshotsOf(w, f.targetId);
		expect(snap?.consistency).toBe("powered_off");

		// forceStop on a stopped source is accepted and changes nothing.
		const saved = await e.svc.saveSnapshot(e.p, s.sandboxId, "off", undefined, {
			forceStop: true,
		});
		expect(
			(await row(w, "operations", saved.operation.id)).request,
		).not.toHaveProperty("forceStop");
		expect(await run(w, saved.operation.id)).toBe("succeeded");
		expect((await row(w, "sandboxes", s.sandboxId)).state).toBe("stopped");
	});

	it("Linux ignores forceStop: a live quiesced snapshot, no stop or start", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		expect((await row(w, "operations", f.forkOpId)).request).not.toHaveProperty(
			"forceStop",
		);
		w.infra.calls.length = 0;

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		expect(powerCalls(w)).toEqual(["snapshot"]);
		expect(w.agent.callsOf("freeze")).toHaveLength(1);
		const [snap] = await snapshotsOf(w, f.targetId);
		expect(snap?.consistency).toBe("quiesced");
		expect((await row(w, "machines", s.machineId)).state).toBe("running");
	});

	it("forceStop must be a boolean", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		const err = await thrown(
			e.svc.fork(e.p, s.sandboxId, { forceStop: "yes" as unknown as boolean }),
		);
		expect(err.code).toBe("validation");
	});
});

describe("shutdown timeout of a forced operation (no crash-consistent snapshot)", () => {
	it("Windows gets the longer forced shutdown budget", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		expect(await run(w, f.forkOpId)).toBe("succeeded");
		expect(w.infra.callsOf("shutdown").at(-1)?.args[1]).toBe(300);
	});

	it("fork: shutdown_timeout (retryable), nothing snapshotted, the source hard-stopped and started again", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		shutdownTimesOut(w);
		w.infra.calls.length = 0;

		expect(await run(w, f.forkOpId)).toBe("failed");

		const op = await row(w, "operations", f.forkOpId);
		expect(op).toMatchObject({
			error_code: "shutdown_timeout",
			retryable: true,
		});
		expect(op.error_message).toMatch(
			/did not shut down cleanly.*nothing was snapshotted/,
		);
		expect(op.progress).toMatchObject({ sourceRestarted: true });
		expect(op.progress).not.toHaveProperty("forceStopped");
		expect(powerCalls(w)).toEqual(["shutdown", "stop", "start"]);
		expect(w.infra.callsOf("snapshot")).toHaveLength(0);
		// The stop failed before the fork_source row was made.
		expect(await snapshotsOf(w, f.targetId)).toEqual([]);
		expect(await row(w, "machines", s.machineId)).toMatchObject({
			state: "running",
			clean_stop: false,
		});
		expect((await row(w, "sandboxes", s.sandboxId)).state).toBe("ready");
		await run(w, f.createOpId);
		expect(await row(w, "sandboxes", f.targetId)).toMatchObject({
			state: "error",
			error_code: "fork_failed",
		});
	});

	it("save: shutdown_timeout, the snapshot row failed, the source runs again", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		w.agent.secretFilesWiped = true;
		const r = await e.svc.saveSnapshot(e.p, s.sandboxId, "win", undefined, {
			forceStop: true,
		});
		shutdownTimesOut(w);
		w.infra.calls.length = 0;

		expect(await run(w, r.operation.id)).toBe("failed");

		expect(await row(w, "operations", r.operation.id)).toMatchObject({
			error_code: "shutdown_timeout",
			retryable: true,
		});
		expect(w.infra.callsOf("snapshot")).toHaveLength(0);
		expect((await row(w, "snapshots", r.snapshot.id)).state).toBe("failed");
		expect((await row(w, "machines", s.machineId)).state).toBe("running");
		expect((await row(w, "sandboxes", s.sandboxId)).state).toBe("ready");
	});
});

describe("a snapshot after a stop that was not clean is never powered_off", () => {
	async function hardStopped(
		w: TestWorld,
		e: OpsEnv,
	): Promise<{ sandboxId: string; machineId: string }> {
		const s = await readySandbox(w, e);
		shutdownTimesOut(w);
		const op = await e.svc.stop(e.p, s.sandboxId);
		expect(await run(w, op.id)).toBe("succeeded");
		expect((await row(w, "operations", op.id)).progress).toMatchObject({
			shutdown: "hard",
		});
		expect(await row(w, "machines", s.machineId)).toMatchObject({
			state: "stopped",
			clean_stop: false,
		});
		return s;
	}

	it("a clean stop records clean_stop; a resume clears it", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await stoppedSandbox(w, e);
		expect((await row(w, "machines", s.machineId)).clean_stop).toBe(true);
		const resume = await e.svc.resume(e.p, s.sandboxId);
		expect(await run(w, resume.id)).toBe("succeeded");
		expect(await row(w, "machines", s.machineId)).toMatchObject({
			state: "running",
			clean_stop: false,
		});
	});

	it("Windows after a hard stop: fork and save are snapshot_requires_clean_stop, nothing snapshotted", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await hardStopped(w, e);
		await makeWindows(w);
		await w.pool.query(
			"UPDATE runtime.machines SET secret_files_on_disk = false WHERE id = $1",
			[s.machineId],
		);
		w.infra.calls.length = 0;

		const f = await forkSandbox(e, s.sandboxId);
		expect(await run(w, f.forkOpId)).toBe("failed");
		const op = await row(w, "operations", f.forkOpId);
		expect(op.error_code).toBe("snapshot_requires_clean_stop");
		expect(op.error_message).toMatch(/not shut down cleanly/);
		expect(op.error_message).toMatch(/forceStop: true/);

		const saved = await e.svc.saveSnapshot(e.p, s.sandboxId, "hard");
		expect(await run(w, saved.operation.id)).toBe("failed");
		expect((await row(w, "operations", saved.operation.id)).error_code).toBe(
			"snapshot_requires_clean_stop",
		);
		expect(w.infra.callsOf("snapshot")).toHaveLength(0);
		expect((await row(w, "sandboxes", s.sandboxId)).state).toBe("stopped");
	});

	it("Linux after a hard stop: the fork's snapshot is labelled crash", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await hardStopped(w, e);
		const f = await forkSandbox(e, s.sandboxId);
		expect(await run(w, f.forkOpId)).toBe("succeeded");
		const [snap] = await snapshotsOf(w, f.targetId);
		expect(snap).toMatchObject({ state: "ready", consistency: "crash" });
	});
});

describe("the restart after the forced snapshot never fails the operation", () => {
	it("the restart budget covers the template's boot timeout plus a margin", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		await w.pool.query(
			"UPDATE runtime.template_builds SET boot_timeout_s = 1200 WHERE id = $1",
			[w.topo.templateBuildId],
		);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		let atStart = 0;
		const start = w.infra.start.bind(w.infra);
		w.infra.start = async (vmid, o) => {
			const op = await row(w, "operations", f.forkOpId);
			atStart = (op.deadline_at as Date).getTime() - Date.now();
			return start(vmid, o);
		};

		expect(await run(w, f.forkOpId)).toBe("succeeded");
		// 1200 s boot timeout + 5 min > the 15 min resume deadline.
		expect(atStart).toBeGreaterThan(24 * 60_000);
	});

	it("deadline passed during the restart: the fork succeeds and the source runs", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		const start = w.infra.start.bind(w.infra);
		w.infra.start = async (vmid, o) => {
			await setDeadline(w, f.forkOpId, -1);
			return start(vmid, o);
		};

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		expect((await row(w, "operations", f.forkOpId)).progress).toMatchObject({
			snapshotTaken: true,
			sourceRestarted: true,
		});
		const [snap] = await snapshotsOf(w, f.targetId);
		expect(snap).toMatchObject({ state: "ready", consistency: "powered_off" });
		expect((await row(w, "machines", s.machineId)).state).toBe("running");
		expect(sandboxOpJobs(w, f.createOpId)).toHaveLength(1);
	});

	it("deadline passed and the agent never comes back: the fork succeeds, the source shows resume_failed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		await w.pool.query(
			"UPDATE runtime.template_builds SET boot_timeout_s = 2 WHERE id = $1",
			[w.topo.templateBuildId],
		);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		const start = w.infra.start.bind(w.infra);
		w.infra.start = async (vmid, o) => {
			await setDeadline(w, f.forkOpId, 1);
			w.agentWorld.behavior = "never";
			return start(vmid, o);
		};

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		expect((await row(w, "operations", f.forkOpId)).progress).toMatchObject({
			sourceRestarted: false,
			restartError: { code: "agent_timeout" },
		});
		const [snap] = await snapshotsOf(w, f.targetId);
		expect(snap?.state).toBe("ready");
		expect(await row(w, "sandboxes", s.sandboxId)).toMatchObject({
			state: "error",
			error_code: "resume_failed",
		});
		expect(sandboxOpJobs(w, f.createOpId)).toHaveLength(1);
	});

	it("a transient start error is retried: the source runs again", async () => {
		const w = await createWorld(db);
		w.ctx.timing.restartRetryMs = 1;
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		const start = w.infra.start.bind(w.infra);
		let failures = 1;
		w.infra.start = (vmid, o) => {
			if (failures-- > 0) {
				return Promise.reject(
					Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
				);
			}
			return start(vmid, o);
		};

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		expect((await row(w, "operations", f.forkOpId)).progress).toMatchObject({
			sourceRestarted: true,
		});
		expect((await row(w, "machines", s.machineId)).state).toBe("running");
		expect((await row(w, "sandboxes", s.sandboxId)).state).toBe("ready");
	});

	it("a transient error that outlasts the restart budget is a failed restart, not a failed fork", async () => {
		const w = await createWorld(db);
		w.ctx.timing.restartRetryMs = 1;
		const e = opsEnv(w);
		const s = await windowsSource(w, e);
		const f = await forkSandbox(e, s.sandboxId, { forceStop: true });
		let attempts = 0;
		w.infra.start = async () => {
			attempts += 1;
			if (attempts === 3) await setDeadline(w, f.forkOpId, -1);
			throw Object.assign(new Error("read ECONNRESET"), {
				code: "ECONNRESET",
			});
		};

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		expect(attempts).toBe(3);
		expect((await row(w, "operations", f.forkOpId)).progress).toMatchObject({
			sourceRestarted: false,
			restartError: { code: "ECONNRESET" },
		});
		const [snap] = await snapshotsOf(w, f.targetId);
		expect(snap?.state).toBe("ready");
		expect((await row(w, "sandboxes", s.sandboxId)).error_code).toBe(
			"resume_failed",
		);
	});
});
