import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	handleSnapshotOp,
	SnapshotInUse,
} from "../src/handlers/snapshot-op.ts";
import {
	createWorld,
	insertMachine,
	insertOperation,
	insertSandbox,
	insertSnapshot,
	type TestWorld,
} from "./fakes/world.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

async function snapshotState(
	w: TestWorld,
	id: string,
): Promise<{ state: string; deleted_at: Date | null }> {
	const r = await w.pool.query(
		"SELECT state, deleted_at FROM runtime.snapshots WHERE id = $1",
		[id],
	);
	return r.rows[0];
}

async function diskStates(w: TestWorld, id: string): Promise<string[]> {
	const r = await w.pool.query<{ state: string }>(
		"SELECT state FROM runtime.disks WHERE snapshot_id = $1",
		[id],
	);
	return r.rows.map((x) => x.state);
}

describe("snapshot-op delete", () => {
	it("deletes the LVs, disks and the snapshot", async () => {
		const w = await createWorld(db);
		const { snapshotId, lvId } = await insertSnapshot(w, { state: "deleting" });
		expect(
			await handleSnapshotOp(w.ctx, { snapshotId, action: "delete" }),
		).toBe("done");
		expect([...w.infra.lvs.keys()].some((n) => n.includes(lvId))).toBe(false);
		expect(w.infra.callsOf("deleteSnapshot")).toEqual([
			{ method: "deleteSnapshot", args: [{ lvId }] },
		]);
		const s = await snapshotState(w, snapshotId);
		expect(s.state).toBe("deleted");
		expect(s.deleted_at).not.toBeNull();
		expect(await diskStates(w, snapshotId)).toEqual(["deleted"]);
		// Redelivery.
		expect(
			await handleSnapshotOp(w.ctx, { snapshotId, action: "delete" }),
		).toBe("skipped");
	});

	it("waits for a create from the snapshot until it passes the provision step", async () => {
		const w = await createWorld(db);
		const { snapshotId, lvId } = await insertSnapshot(w, { state: "deleting" });
		const sandboxId = await insertSandbox(w, {
			origin: "snapshot",
			originSnapshotId: snapshotId,
		});
		const machineId = await insertMachine(w, {
			poolKey: null,
			sandboxId,
			origin: "snapshot",
			originSnapshotId: snapshotId,
		});
		const opId = await insertOperation(w, { sandboxId, state: "running" });

		const err = await handleSnapshotOp(w.ctx, {
			snapshotId,
			action: "delete",
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SnapshotInUse);
		expect((err as SnapshotInUse).retryAfterSeconds).toBe(30);
		expect((err as SnapshotInUse).retryable).toBe(true);
		expect((await snapshotState(w, snapshotId)).state).toBe("deleting");
		expect([...w.infra.lvs.keys()].some((n) => n.includes(lvId))).toBe(true);
		expect(w.infra.callsOf("deleteSnapshot")).toHaveLength(0);

		// The clone is done: machine booting, provision recorded.
		await w.pool.query(
			"UPDATE runtime.machines SET state = 'booting' WHERE id = $1",
			[machineId],
		);
		await w.pool.query(
			"UPDATE runtime.operations SET step = 'provision' WHERE id = $1",
			[opId],
		);
		expect(
			await handleSnapshotOp(w.ctx, { snapshotId, action: "delete" }),
		).toBe("done");
		expect((await snapshotState(w, snapshotId)).state).toBe("deleted");
		expect([...w.infra.lvs.keys()].some((n) => n.includes(lvId))).toBe(false);
	});

	it("a create still waiting for RAM (no step yet) keeps the snapshot", async () => {
		const w = await createWorld(db);
		const { snapshotId } = await insertSnapshot(w, { state: "deleting" });
		const sandboxId = await insertSandbox(w, {
			origin: "snapshot",
			originSnapshotId: snapshotId,
		});
		await insertOperation(w, { sandboxId });
		await expect(
			handleSnapshotOp(w.ctx, { snapshotId, action: "delete" }),
		).rejects.toBeInstanceOf(SnapshotInUse);
	});

	it("a machine cloning from the snapshot (fork target) keeps it", async () => {
		const w = await createWorld(db);
		const { snapshotId } = await insertSnapshot(w, {
			state: "deleting",
			kind: "fork_source",
		});
		await insertMachine(w, {
			poolKey: null,
			state: "provisioning",
			origin: "snapshot",
			originSnapshotId: snapshotId,
		});
		await expect(
			handleSnapshotOp(w.ctx, { snapshotId, action: "delete" }),
		).rejects.toBeInstanceOf(SnapshotInUse);
	});

	it("leaves a ready snapshot alone and deletes a failed one", async () => {
		const w = await createWorld(db);
		const ready = await insertSnapshot(w, { state: "ready" });
		expect(
			await handleSnapshotOp(w.ctx, {
				snapshotId: ready.snapshotId,
				action: "delete",
			}),
		).toBe("skipped");
		expect((await snapshotState(w, ready.snapshotId)).state).toBe("ready");
		expect([...w.infra.lvs.keys()].some((n) => n.includes(ready.lvId))).toBe(
			true,
		);

		const failed = await insertSnapshot(w, { state: "failed" });
		expect(
			await handleSnapshotOp(w.ctx, {
				snapshotId: failed.snapshotId,
				action: "delete",
			}),
		).toBe("done");
		expect((await snapshotState(w, failed.snapshotId)).state).toBe("deleted");
	});
});
