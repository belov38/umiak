// Fork (S6 §7.7): the `fork` operation on the source (snapshot with quiesce,
// hand-off to the target), the target's `create` (provision from the
// fork_source; cleanup_source hands the snapshot to snapshot-op), their
// failures and delete during a fork.
import { DELETE_RETRY_LIMIT } from "@sbx/core";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { FreezeTimeoutError } from "@sbx/pve";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSandboxOpDeadLetter } from "../src/handlers/dlq.ts";
import { handleMachineOp } from "../src/handlers/machine-op.ts";
import { handleSandboxOp } from "../src/handlers/sandbox-op.ts";
import { QuiesceFailed } from "../src/ops/snapshot-step.ts";
import {
	AgentUnavailable,
	type ClaimRequest,
	type InfraSnapshotResult,
} from "../src/ports.ts";
import { blockAfter } from "./fakes/crash.ts";
import { createWorld, type TestWorld } from "./fakes/world.ts";
import {
	disconnectAgent,
	ENV,
	type Forked,
	forkSandbox,
	infraState,
	machinesOf,
	type OpsEnv,
	opsEnv,
	readySandbox,
	row,
	run,
	runSnapshotJobs,
	SECRETS,
	sandboxOpJobs,
	snapshotLvs,
	snapshotsOf,
	stoppedSandbox,
	until,
} from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

async function forkSource(w: TestWorld, f: Forked) {
	const snaps = await snapshotsOf(w, f.targetId);
	expect(snaps).toHaveLength(1);
	return snaps[0] as Record<string, unknown>;
}

/** Runs the machine-op delete jobs sent so far (deleting machines). */
async function runMachineDeletes(w: TestWorld): Promise<void> {
	for (const j of w.jobs.sent.filter((x) => x.queue === "machine-op")) {
		await handleMachineOp(w.ctx, {
			machineId: j.data.machineId as string,
			action: "delete",
		});
	}
}

/** The target was failed by its own handler (§7.1 parent rule): fork_failed. */
async function expectTargetForkFailed(w: TestWorld, f: Forked): Promise<void> {
	expect(sandboxOpJobs(w, f.createOpId)).toHaveLength(1);
	expect(await run(w, f.createOpId)).toBe("skipped");
	const op = await row(w, "operations", f.createOpId);
	expect(op.state).toBe("failed");
	expect(op.error_code).toBe("fork_failed");
	const t = await row(w, "sandboxes", f.targetId);
	expect(t.state).toBe("error");
	expect(t.error_code).toBe("fork_failed");
	expect((await machinesOf(w, f.targetId)).map((m) => m.state)).toEqual([
		"deleting",
	]);
}

async function readyFork(
	w: TestWorld,
	e: OpsEnv,
	input = {},
): Promise<Forked & { sourceMachineId: string }> {
	const src = await readySandbox(w, e);
	const f = await forkSandbox(e, src.sandboxId, input);
	return { ...f, sourceMachineId: src.machineId };
}

describe("fork of a running source", () => {
	it("agent quiesce hook, snapshot handed to the target, target ready, cleanup_source → snapshot-op deletes it", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e, {
			env: { APP_MODE: "fork" },
			secrets: { EXTRA: "extra-value" },
		});
		// Only the fork has a job until the snapshot is ready.
		expect(sandboxOpJobs(w, f.forkOpId)).toHaveLength(1);
		expect(sandboxOpJobs(w, f.createOpId)).toHaveLength(0);

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		const forkOp = await row(w, "operations", f.forkOpId);
		expect(forkOp.state).toBe("succeeded");
		const snap = await forkSource(w, f);
		expect(forkOp.progress).toMatchObject({ snapshotId: snap.id });
		expect(snap).toMatchObject({
			kind: "fork_source",
			state: "ready",
			source_sandbox_id: f.sourceId,
			source_machine_id: f.sourceMachineId,
			consumer_sandbox_id: f.targetId,
			consistency: "quiesced",
			quiesce_broken: false,
			lv_id: (snap.id as string).replaceAll("-", ""),
			hw: { cores: "2", memory: "2048" },
		});
		expect(snap.ready_at).not.toBeNull();
		const disks = await w.pool.query(
			"SELECT state FROM runtime.disks WHERE snapshot_id = $1",
			[snap.id],
		);
		expect(disks.rows).toEqual([{ state: "active" }]);
		// The agent's quiesce (S3 System/Quiesce with a 30 s lease).
		expect(w.agent.callsOf("freeze")).toEqual([
			{
				method: "freeze",
				machineId: f.sourceMachineId,
				args: { leaseMs: 30_000 },
			},
		]);
		expect(w.agent.callsOf("thaw")).toHaveLength(1);
		expect(w.infra.callsOf("snapshot")[0]?.args[1]).toEqual({
			lvId: snap.lv_id,
			hook: true,
		});

		// Hand-off: the target's create got its deadline (cold, 6 min) and a job.
		const createOp = await row(w, "operations", f.createOpId);
		const left = (createOp.deadline_at as Date).getTime() - Date.now();
		expect(left).toBeGreaterThan(350_000);
		expect(left).toBeLessThanOrEqual(360_000);
		const jobs = sandboxOpJobs(w, f.createOpId);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.opts?.singletonKey).toBe(f.targetId);
		const targetMachine = (await machinesOf(w, f.targetId))[0]?.id as string;
		expect((await row(w, "machines", targetMachine)).origin_snapshot_id).toBe(
			snap.id,
		);

		expect(await run(w, f.createOpId)).toBe("succeeded");

		const t = await row(w, "sandboxes", f.targetId);
		expect(t.state).toBe("ready");
		expect(t.origin).toBe("fork");
		const tm = await row(w, "machines", targetMachine);
		expect(tm.state).toBe("running");
		expect(w.infra.callsOf("fork")).toEqual([
			{
				method: "fork",
				args: [
					{
						machineId: targetMachine,
						lvId: snap.lv_id,
						size: { vcpu: 2, memoryMb: 2048 },
					},
				],
			},
		]);
		// cleanup_source, in the final transaction: the snapshot → deleting with
		// a snapshot-op delete job; no S1 call on the target's path.
		expect((await row(w, "operations", f.createOpId)).step).toBe("claim");
		expect((await row(w, "snapshots", snap.id as string)).state).toBe(
			"deleting",
		);
		expect(w.infra.callsOf("deleteSnapshot")).toEqual([]);
		expect(w.jobs.sent.filter((j) => j.queue === "snapshot-op")).toEqual([
			{
				queue: "snapshot-op",
				data: { snapshotId: snap.id, action: "delete" },
				opts: { singletonKey: snap.id, retryLimit: DELETE_RETRY_LIMIT },
			},
		]);
		// The in-use check passes: the target machine is running.
		await runSnapshotJobs(w);
		const after = await row(w, "snapshots", snap.id as string);
		expect(after.state).toBe("deleted");
		expect(after.deleted_at).not.toBeNull();
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);

		// Target secrets = source ⊕ patch (Task 8), delivered with the claim.
		const claim = w.agent
			.callsOf("claim")
			.find((c) => c.machineId === targetMachine);
		const req = claim?.args as ClaimRequest;
		expect(req.sandboxId).toBe(f.targetId);
		expect(req.env).toEqual({ ...ENV, APP_MODE: "fork" });
		expect(req.secretEnv).toEqual({ ...SECRETS, EXTRA: "extra-value" });
		expect(req.secretFiles.map((x) => x.name)).toEqual(["id_rsa"]);

		// The source is untouched.
		const s = await row(w, "sandboxes", f.sourceId);
		expect(s.state).toBe("ready");
		expect((await row(w, "machines", f.sourceMachineId)).state).toBe("running");
		expect(await infraState(w)).toMatchObject({ vms: 2, leases: 2 });
		expect((await infraState(w)).lvs).toHaveLength(2);
	});

	it("agent unreachable: S1 falls back to QGA (no hook)", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		await disconnectAgent(w, f.sourceMachineId);

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		const snap = await forkSource(w, f);
		expect(snap.state).toBe("ready");
		expect(snap.consistency).toBe("quiesced");
		expect(w.agent.callsOf("freeze")).toHaveLength(0);
		expect(w.infra.callsOf("snapshot")[0]?.args[1]).toMatchObject({
			hook: false,
		});
		expect(sandboxOpJobs(w, f.createOpId)).toHaveLength(1);
	});

	it("agent and QGA unavailable: fork failed quiesce_failed, target error fork_failed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		await disconnectAgent(w, f.sourceMachineId);
		w.infra.qgaPing = async () => false;

		expect(await run(w, f.forkOpId)).toBe("failed");

		const op = await row(w, "operations", f.forkOpId);
		expect(op.error_code).toBe("quiesce_failed");
		expect(w.infra.callsOf("snapshot")).toHaveLength(0);
		const snap = await forkSource(w, f);
		expect(snap.state).toBe("deleted");
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);
		// The source keeps its state: a fork never changes it (§6.1).
		expect((await row(w, "sandboxes", f.sourceId)).state).toBe("ready");

		await expectTargetForkFailed(w, f);
		await runMachineDeletes(w);
		expect((await machinesOf(w, f.targetId)).map((m) => m.state)).toEqual([
			"deleted",
		]);
		expect(await infraState(w)).toMatchObject({ vms: 1, leases: 1 });
	});

	it("the watchdog thawed during the snapshot (quiesce_broken): fork failed quiesce_failed, LVs removed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		// S3 quiesce.auto_thawed{by: watchdog} arrives before the hook's thaw returns.
		w.agent.onThaw = (machineId) =>
			w.agentWorld.emit(machineId, "quiesce.auto_thawed", {
				leaseId: "lease-1",
				by: "watchdog",
			});

		expect(await run(w, f.forkOpId)).toBe("failed");

		const op = await row(w, "operations", f.forkOpId);
		expect(op.error_code).toBe("quiesce_failed");
		expect(w.infra.callsOf("snapshot")).toHaveLength(1);
		const snap = await forkSource(w, f);
		expect(snap.quiesce_broken).toBe(true);
		expect(snap.state).toBe("deleted");
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);
		expect(w.metrics.count("sbx_quiesce_watchdog_thawed_total")).toBe(1);

		await expectTargetForkFailed(w, f);
	});

	it("the agent hook fails unavailable: the retry freezes through QGA (progress.quiesceVia)", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		w.agent.fail("freeze", "unavailable");

		await expect(
			handleSandboxOp(w.ctx, { operationId: f.forkOpId }),
		).rejects.toBeInstanceOf(AgentUnavailable);
		const mid = await row(w, "operations", f.forkOpId);
		expect(mid.state).toBe("running");
		expect(mid.progress).toMatchObject({ quiesceVia: "qga" });

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		// One agent freeze (the failed one), then the QGA path: no hook.
		expect(w.agent.callsOf("freeze")).toHaveLength(1);
		expect(w.infra.callsOf("snapshot").map((c) => c.args[1])).toEqual([
			expect.objectContaining({ hook: true }),
			expect.objectContaining({ hook: false }),
		]);
		const snap = await forkSource(w, f);
		expect(snap.state).toBe("ready");
		expect(snap.consistency).toBe("quiesced");
	});

	it("the agent freeze times out in S1: the retry freezes through QGA", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		w.infra.snapshotFailure = new QuiesceFailed("freeze timed out", {
			cause: new FreezeTimeoutError("freeze did not return within 30000 ms"),
		});

		await expect(
			handleSandboxOp(w.ctx, { operationId: f.forkOpId }),
		).rejects.toBeInstanceOf(AgentUnavailable);
		const mid = await row(w, "operations", f.forkOpId);
		expect(mid.state).toBe("running");
		expect(mid.progress).toMatchObject({ quiesceVia: "qga" });

		expect(await run(w, f.forkOpId)).toBe("succeeded");
		expect(w.infra.callsOf("snapshot").map((c) => c.args[1])).toEqual([
			expect.objectContaining({ hook: true }),
			expect.objectContaining({ hook: false }),
		]);
	});

	it("an agent that rejects the freeze fails the fork; nothing is left", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		w.agent.fail("freeze", { rejected: "already_quiesced" });

		expect(await run(w, f.forkOpId)).toBe("failed");

		expect((await row(w, "operations", f.forkOpId)).error_code).toBe(
			"already_quiesced",
		);
		const snap = await forkSource(w, f);
		expect(snap.state).toBe("deleted");
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);
		await expectTargetForkFailed(w, f);
	});
});

describe("fork of a stopped source", () => {
	it("no freeze, consistency powered_off; the target boots from it", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await stoppedSandbox(w, e);
		const f = await forkSandbox(e, src.sandboxId);

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		const snap = await forkSource(w, f);
		expect(snap.state).toBe("ready");
		expect(snap.consistency).toBe("powered_off");
		expect(w.agent.callsOf("freeze")).toHaveLength(0);
		expect(w.infra.callsOf("snapshot")[0]?.args[1]).toMatchObject({
			hook: false,
		});

		expect(await run(w, f.createOpId)).toBe("succeeded");
		expect((await row(w, "sandboxes", f.targetId)).state).toBe("ready");
		expect((await row(w, "sandboxes", src.sandboxId)).state).toBe("stopped");
		expect((await row(w, "snapshots", snap.id as string)).state).toBe(
			"deleting",
		);
		await runSnapshotJobs(w);
		expect((await row(w, "snapshots", snap.id as string)).state).toBe(
			"deleted",
		);
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);
	});
});

describe("fork failures", () => {
	it("the fork's deadline passes after the snapshot: LVs removed, target fork_failed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		// The snapshot is taken, then the deadline passes before the hand-off.
		const orig = w.infra.snapshot.bind(w.infra);
		w.infra.snapshot = async (vmid, opts): Promise<InfraSnapshotResult> => {
			const res = await orig(vmid, opts);
			await w.pool.query(
				"UPDATE runtime.operations SET deadline_at = now() - interval '1 second' WHERE id = $1",
				[f.forkOpId],
			);
			return res;
		};

		expect(await run(w, f.forkOpId)).toBe("failed");

		expect((await row(w, "operations", f.forkOpId)).error_code).toBe(
			"deadline_exceeded",
		);
		const snap = await forkSource(w, f);
		expect(snap.state).toBe("deleted");
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);
		await expectTargetForkFailed(w, f);
	});

	it("dead letter of the fork: compensated retries_exhausted, the target is failed by its handler", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);

		expect(
			await handleSandboxOpDeadLetter(w.ctx, { operationId: f.forkOpId }),
		).toBe("failed");

		expect((await row(w, "operations", f.forkOpId)).error_code).toBe(
			"retries_exhausted",
		);
		await expectTargetForkFailed(w, f);
	});

	it("the target's create fails after the hand-off: its compensation deletes the fork_source", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		expect(await run(w, f.forkOpId)).toBe("succeeded");
		const snap = await forkSource(w, f);
		w.agent.fail("claim", { rejected: "bad_claim" });

		expect(await run(w, f.createOpId)).toBe("failed");

		const t = await row(w, "sandboxes", f.targetId);
		expect(t.state).toBe("error");
		expect(t.error_code).toBe("create_failed");
		expect((await row(w, "snapshots", snap.id as string)).state).toBe(
			"deleted",
		);
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);
		await runMachineDeletes(w);
		expect(await infraState(w)).toMatchObject({ vms: 1, leases: 1 });
	});
});

describe("delete during a fork", () => {
	it("target deleted while it waits for the parent: the fork deletes the snapshot itself", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		const del = await e.svc.delete(e.p, f.targetId);
		expect((await row(w, "operations", f.createOpId)).state).toBe("superseded");
		expect(await run(w, del.id)).toBe("succeeded");
		expect((await row(w, "sandboxes", f.targetId)).state).toBe("deleted");

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		const snap = await forkSource(w, f);
		expect(snap.state).toBe("deleted");
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);
		expect(sandboxOpJobs(w, f.createOpId)).toHaveLength(0);
		expect((await row(w, "operations", f.forkOpId)).progress).toMatchObject({
			targetGone: true,
		});
		expect(await infraState(w)).toMatchObject({ vms: 1, leases: 1 });
		expect((await infraState(w)).lvs).toHaveLength(1);
	});

	it("target deleted while the source snapshots: the fork deletes it at the hand-off", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		const b = blockAfter(w.infra, "snapshot");
		w.useInfra(b.port);
		const forkRun = run(w, f.forkOpId);
		await b.reached;
		const del = await e.svc.delete(e.p, f.targetId);
		b.release();

		expect(await forkRun).toBe("succeeded");
		// Run the target's delete after the fork: nothing of the snapshot left for it.
		w.useInfra(w.infra);
		expect(await run(w, del.id)).toBe("succeeded");

		const snap = await forkSource(w, f);
		expect(snap.state).toBe("deleted");
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);
		expect(sandboxOpJobs(w, f.createOpId)).toHaveLength(0);
		expect(await infraState(w)).toMatchObject({ vms: 1, leases: 1 });
	});

	it("source deleted mid-snapshot: fork superseded, the delete removes the creating snapshot, target fork_failed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		const b = blockAfter(w.infra, "snapshot");
		w.useInfra(b.port);
		const forkRun = handleSandboxOp(w.ctx, { operationId: f.forkOpId });
		await b.reached;
		const del = await e.svc.delete(e.p, f.sourceId);
		expect((await row(w, "operations", f.forkOpId)).state).toBe("superseded");
		b.release();
		expect(await forkRun).toBe("fenced_out");

		w.useInfra(w.infra);
		expect(await run(w, del.id)).toBe("succeeded");

		expect((await row(w, "sandboxes", f.sourceId)).state).toBe("deleted");
		const snap = await forkSource(w, f);
		expect(snap.state).toBe("deleted");
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);
		// The delete enqueued the waiting child; its handler fails it.
		await expectTargetForkFailed(w, f);
		await runMachineDeletes(w);
		expect(await infraState(w)).toEqual({ vms: 0, lvs: [], leases: 0 });
	});

	it("a stale fork executor whose S1 snapshot lands after the source's delete removes the LVs itself", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		// S1 snapshot in flight: the LVs appear only when it is released.
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let reached = false;
		w.infra.snapshot = async (_vmid, opts): Promise<InfraSnapshotResult> => {
			reached = true;
			await gate;
			const name = w.infra.addSnapshotLvs(opts.lvId);
			return {
				disks: [{ slot: "scsi0", volume: `local-lvm:${name}`, options: {} }],
				hw: {},
				consistency: "quiesced",
			};
		};
		const forkRun = handleSandboxOp(w.ctx, { operationId: f.forkOpId });
		await until("S1 snapshot reached", async () => reached);
		const del = await e.svc.delete(e.p, f.sourceId);
		expect(await run(w, del.id)).toBe("succeeded");
		const snap = await forkSource(w, f);
		expect(snap.state).toBe("deleted");

		release();
		expect(await forkRun).toBe("fenced_out");

		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);
		expect(
			w.infra.callsOf("deleteSnapshot").map((c) => c.args[0]),
		).toContainEqual({ lvId: snap.lv_id });
	});

	it("a stale fork executor whose LVs land between the delete's S1 delete and its row mark removes them (op superseded)", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let reached = false;
		w.infra.snapshot = async (_vmid, opts): Promise<InfraSnapshotResult> => {
			reached = true;
			await gate;
			const name = w.infra.addSnapshotLvs(opts.lvId);
			return {
				disks: [{ slot: "scsi0", volume: `local-lvm:${name}`, options: {} }],
				hw: {},
				consistency: "quiesced",
			};
		};
		const zombie = handleSandboxOp(w.ctx, { operationId: f.forkOpId });
		await until("S1 snapshot reached", async () => reached);
		const del = await e.svc.delete(e.p, f.sourceId);
		// The delete's S1 delete of the creating snapshot is done; its mark is not.
		const b = blockAfter(w.infra, "deleteSnapshot");
		w.useInfra(b.port);
		const delRun = run(w, del.id);
		await b.reached;
		const snap = await forkSource(w, f);
		expect(snap.state).toBe("creating");

		release();
		expect(await zombie).toBe("fenced_out");
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);

		b.release();
		expect(await delRun).toBe("succeeded");
		expect((await row(w, "snapshots", snap.id as string)).state).toBe(
			"deleted",
		);
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);
	});

	it("a stale attempt whose S1 snapshot returns after a newer attempt made it ready leaves its LVs alone", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		// Attempt A: S1 made the LVs, the answer is late (the pod looks dead).
		const b = blockAfter(w.infra, "snapshot");
		w.useInfra(b.port);
		const stale = handleSandboxOp(w.ctx, { operationId: f.forkOpId });
		await b.reached;

		// Attempt B: removes A's unrecorded LVs, takes the snapshot again, hands off.
		expect(await run(w, f.forkOpId)).toBe("succeeded");
		const snap = await forkSource(w, f);
		expect(snap.state).toBe("ready");
		expect(snapshotLvs(w, snap.lv_id as string)).toHaveLength(1);
		const deletes = w.infra.callsOf("deleteSnapshot").length;

		b.release();
		expect(await stale).toBe("fenced_out");

		// The ready snapshot's LVs (same lv_id) survive A.
		expect(w.infra.callsOf("deleteSnapshot")).toHaveLength(deletes);
		expect(snapshotLvs(w, snap.lv_id as string)).toHaveLength(1);
		expect((await row(w, "snapshots", snap.id as string)).state).toBe("ready");
	});

	it("target delete after the hand-off removes the ready fork_source (ownership moved)", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const f = await readyFork(w, e);
		expect(await run(w, f.forkOpId)).toBe("succeeded");
		const snap = await forkSource(w, f);
		const del = await e.svc.delete(e.p, f.targetId);
		expect(await run(w, f.createOpId)).toBe("skipped");
		expect(await run(w, del.id)).toBe("succeeded");

		expect((await row(w, "snapshots", snap.id as string)).state).toBe(
			"deleted",
		);
		expect(snapshotLvs(w, snap.lv_id as string)).toEqual([]);
		expect(await infraState(w)).toMatchObject({ vms: 1, leases: 1 });
	});
});
