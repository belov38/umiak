// save_snapshot (S6 §7.8): the snapshot step shared with fork, the name
// moving from the replaced snapshot in one transaction, failures that keep
// the old name, and leftovers of a crashed attempt.
import { DELETE_RETRY_LIMIT } from "@umiak/core";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSandboxOp } from "../src/handlers/sandbox-op.ts";
import { handleSnapshotOp } from "../src/handlers/snapshot-op.ts";
import { crashAfter, SimulatedCrash } from "./fakes/crash.ts";
import { createWorld } from "./fakes/world.ts";
import {
	createSandbox,
	disconnectAgent,
	type OpsEnv,
	opsEnv,
	readySandbox,
	restorePorts,
	row,
	run,
	snapshotLvs,
	stoppedSandbox,
} from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

async function save(
	e: OpsEnv,
	sandboxId: string,
	name: string,
): Promise<{ snapshotId: string; operationId: string; lvId: string }> {
	const r = await e.svc.saveSnapshot(e.p, sandboxId, name);
	return {
		snapshotId: r.snapshot.id,
		operationId: r.operation.id,
		lvId: r.snapshot.id.replaceAll("-", ""),
	};
}

describe("save_snapshot", () => {
	it("a new name: snapshot ready with the name, quiesced, and usable by create", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		const s = await save(e, src.sandboxId, "base");

		expect(await run(w, s.operationId)).toBe("succeeded");

		const snap = await row(w, "snapshots", s.snapshotId);
		expect(snap).toMatchObject({
			kind: "saved",
			state: "ready",
			name: "base",
			pending_name: null,
			consistency: "quiesced",
			source_sandbox_id: src.sandboxId,
			source_machine_id: src.machineId,
		});
		expect(snap.ready_at).not.toBeNull();
		expect(snapshotLvs(w, s.lvId)).toHaveLength(1);
		expect(w.agent.callsOf("freeze")).toHaveLength(1);
		expect((await row(w, "sandboxes", src.sandboxId)).state).toBe("ready");
		expect((await e.svc.listSavedSnapshots(e.p)).map((x) => x.name)).toEqual([
			"base",
		]);

		// A create from it boots from the snapshot.
		const c = await createSandbox(w, e, { from: { snapshot: "base" } });
		expect(await run(w, c.operationId)).toBe("succeeded");
		expect(w.infra.callsOf("fork")[0]?.args[0]).toMatchObject({
			lvId: s.lvId,
		});
	});

	it("a stopped source: no freeze, powered_off", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await stoppedSandbox(w, e);
		const s = await save(e, src.sandboxId, "cold");

		expect(await run(w, s.operationId)).toBe("succeeded");

		expect(await row(w, "snapshots", s.snapshotId)).toMatchObject({
			state: "ready",
			name: "cold",
			consistency: "powered_off",
		});
		expect(w.agent.callsOf("freeze")).toHaveLength(0);
		expect((await row(w, "sandboxes", src.sandboxId)).state).toBe("stopped");
	});

	it("replacing a name: the old ready snapshot → deleting (+ snapshot-op job) in the same transaction", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		const a = await save(e, src.sandboxId, "base");
		expect(await run(w, a.operationId)).toBe("succeeded");
		const b = await save(e, src.sandboxId, "base");
		// While B is creating, the name is still A's.
		expect((await row(w, "snapshots", a.snapshotId)).name).toBe("base");

		expect(await run(w, b.operationId)).toBe("succeeded");

		expect(await row(w, "snapshots", b.snapshotId)).toMatchObject({
			state: "ready",
			name: "base",
			pending_name: null,
		});
		// §7.8: the name is taken off the replaced snapshot.
		expect(await row(w, "snapshots", a.snapshotId)).toMatchObject({
			state: "deleting",
			name: null,
		});
		const jobs = w.jobs.sent.filter(
			(j) => j.queue === "snapshot-op" && j.data.snapshotId === a.snapshotId,
		);
		expect(jobs).toEqual([
			{
				queue: "snapshot-op",
				data: { snapshotId: a.snapshotId, action: "delete" },
				opts: { singletonKey: a.snapshotId, retryLimit: DELETE_RETRY_LIMIT },
			},
		]);
		expect(
			(await e.svc.listSavedSnapshots(e.p)).map((x) => [x.id, x.name]),
		).toEqual([[b.snapshotId, "base"]]);

		expect(
			await handleSnapshotOp(w.ctx, {
				snapshotId: a.snapshotId,
				action: "delete",
			}),
		).toBe("done");
		expect((await row(w, "snapshots", a.snapshotId)).state).toBe("deleted");
		expect(snapshotLvs(w, a.lvId)).toEqual([]);
		expect(snapshotLvs(w, b.lvId)).toHaveLength(1);
	});

	it("a failed save keeps the old name; the new snapshot is failed without LVs", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		const a = await save(e, src.sandboxId, "base");
		expect(await run(w, a.operationId)).toBe("succeeded");
		const b = await save(e, src.sandboxId, "base");
		await disconnectAgent(w, src.machineId);
		w.infra.qgaPing = async () => false;

		expect(await run(w, b.operationId)).toBe("failed");

		expect((await row(w, "operations", b.operationId)).error_code).toBe(
			"quiesce_failed",
		);
		expect(await row(w, "snapshots", b.snapshotId)).toMatchObject({
			state: "failed",
			name: null,
		});
		expect(snapshotLvs(w, b.lvId)).toEqual([]);
		expect(await row(w, "snapshots", a.snapshotId)).toMatchObject({
			state: "ready",
			name: "base",
		});
		expect(snapshotLvs(w, a.lvId)).toHaveLength(1);
		expect((await row(w, "sandboxes", src.sandboxId)).state).toBe("ready");
	});

	it("quiesce_broken during a save: failed, LVs removed, the old name intact", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		const a = await save(e, src.sandboxId, "base");
		expect(await run(w, a.operationId)).toBe("succeeded");
		const b = await save(e, src.sandboxId, "base");
		w.agent.onThaw = (machineId) =>
			w.agentWorld.emit(machineId, "quiesce.auto_thawed", { by: "watchdog" });

		expect(await run(w, b.operationId)).toBe("failed");

		expect((await row(w, "operations", b.operationId)).error_code).toBe(
			"quiesce_failed",
		);
		expect(await row(w, "snapshots", b.snapshotId)).toMatchObject({
			state: "failed",
			quiesce_broken: true,
		});
		expect(snapshotLvs(w, b.lvId)).toEqual([]);
		expect((await row(w, "snapshots", a.snapshotId)).name).toBe("base");
	});

	it("leftover LVs of a crashed attempt (S1 done, not recorded) are removed and the snapshot taken again", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		const s = await save(e, src.sandboxId, "base");
		w.useInfra(crashAfter(w.infra, "snapshot"));

		await expect(
			handleSandboxOp(w.ctx, { operationId: s.operationId }),
		).rejects.toBeInstanceOf(SimulatedCrash);
		// S1 made the LVs; the row has no disks yet.
		expect(snapshotLvs(w, s.lvId)).toHaveLength(1);
		const disks = await w.pool.query(
			"SELECT 1 FROM runtime.disks WHERE snapshot_id = $1",
			[s.snapshotId],
		);
		expect(disks.rowCount).toBe(0);

		restorePorts(w);
		expect(await run(w, s.operationId)).toBe("succeeded");

		expect(w.infra.callsOf("snapshot")).toHaveLength(2);
		expect(w.infra.callsOf("deleteSnapshot").map((c) => c.args[0])).toEqual([
			{ lvId: s.lvId },
		]);
		expect(snapshotLvs(w, s.lvId)).toHaveLength(1);
		const after = await w.pool.query(
			"SELECT state FROM runtime.disks WHERE snapshot_id = $1",
			[s.snapshotId],
		);
		expect(after.rows).toEqual([{ state: "active" }]);
		expect((await row(w, "snapshots", s.snapshotId)).state).toBe("ready");
	});

	it("the row left creating while S1 ran (snapshot_lost): the new LVs are removed, the save fails", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		const s = await save(e, src.sandboxId, "base");
		const orig = w.infra.snapshot.bind(w.infra);
		w.infra.snapshot = async (vmid, opts) => {
			const res = await orig(vmid, opts);
			await w.pool.query(
				"UPDATE runtime.snapshots SET state = 'failed' WHERE id = $1",
				[s.snapshotId],
			);
			return res;
		};

		expect(await run(w, s.operationId)).toBe("failed");

		expect((await row(w, "operations", s.operationId)).error_code).toBe(
			"snapshot_lost",
		);
		expect(snapshotLvs(w, s.lvId)).toEqual([]);
	});

	it("delete of the source during a save removes the creating snapshot; the name stays free", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		const s = await save(e, src.sandboxId, "base");
		const del = await e.svc.delete(e.p, src.sandboxId);
		expect(await run(w, s.operationId)).toBe("skipped");
		expect(await run(w, del.id)).toBe("succeeded");

		expect((await row(w, "snapshots", s.snapshotId)).state).toBe("deleted");
		expect(await e.svc.listSavedSnapshots(e.p)).toEqual([]);
	});
});
