import { randomUUID } from "node:crypto";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	DELETE_RETRY_LIMIT,
	isUmiakError,
	type UmiakError,
} from "../src/index.ts";
import {
	expectCode,
	insertSavedSnapshot,
	seedSandbox,
	serviceEnv,
} from "./helpers/service.ts";

describe.skipIf(skipPg())("SandboxService saved snapshots (S6 §7.8)", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 20 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	async function snap(id: string) {
		const r = await t.pool.query(
			"SELECT * FROM runtime.snapshots WHERE id = $1",
			[id],
		);
		return r.rows[0];
	}

	it("saveSnapshot inserts a creating saved snapshot and a save_snapshot operation with a job", async () => {
		const env = await serviceEnv(t.pool);
		const src = await seedSandbox(t.pool, env, { state: "ready" });

		const { snapshot, operation } = await env.svc.saveSnapshot(
			env.p,
			src.sandboxId,
			"web-stack",
		);

		expect(snapshot).toMatchObject({
			kind: "saved",
			state: "creating",
			name: null,
			pendingName: "web-stack",
			teamId: env.p.teamId,
			sourceSandboxId: src.sandboxId,
			sourceMachineId: src.machineId,
			nodeId: env.topo.nodeId,
			providerId: env.topo.providerId,
			storageId: env.topo.storageId,
			templateBuildId: env.topo.templateBuildId,
			lvId: snapshot.id.replaceAll("-", ""),
		});
		expect(operation).toMatchObject({
			kind: "save_snapshot",
			state: "pending",
			sandboxId: src.sandboxId,
			request: { name: "web-stack", snapshotId: snapshot.id },
		});
		expect(operation.deadlineAt).not.toBeNull();
		expect(env.jobs.sent).toEqual([
			{
				queue: "sandbox-op",
				data: { operationId: operation.id },
				opts: { singletonKey: src.sandboxId },
			},
		]);
		// The source keeps its state (S6 §6.1).
		const s = await env.svc.get(env.p, src.sandboxId);
		expect(s.state).toBe("ready");
		expect(s.activeOperation?.id).toBe(operation.id);
	});

	it("works on a stopped source; stopping is invalid_state; an active operation is operation_in_progress", async () => {
		const env = await serviceEnv(t.pool);
		const stopped = await seedSandbox(t.pool, env, {
			state: "stopped",
			machineState: "stopped",
		});
		await env.svc.saveSnapshot(env.p, stopped.sandboxId, "cold");
		await expectCode(
			env.svc.saveSnapshot(env.p, stopped.sandboxId, "cold-2"),
			"operation_in_progress",
		);
		const stopping = await seedSandbox(t.pool, env, { state: "stopping" });
		await expectCode(
			env.svc.saveSnapshot(env.p, stopping.sandboxId, "x1"),
			"invalid_state",
		);
	});

	it("validates the name", async () => {
		const env = await serviceEnv(t.pool);
		const src = await seedSandbox(t.pool, env, { state: "ready" });
		for (const bad of ["", "-x", "Upper", "a_b", "x".repeat(64)]) {
			await expectCode(
				env.svc.saveSnapshot(env.p, src.sandboxId, bad),
				"validation",
			);
		}
	});

	it("maxSavedSnapshots: counts creating and ready, but not a same-name ready snapshot being replaced", async () => {
		const env = await serviceEnv(t.pool, { quota: { maxSavedSnapshots: 1 } });
		await insertSavedSnapshot(t.pool, env.topo, {
			teamId: env.p.teamId,
			name: "base",
		});
		const src = await seedSandbox(t.pool, env, { state: "ready" });
		const e = await expectCode(
			env.svc.saveSnapshot(env.p, src.sandboxId, "other"),
			"quota_exceeded",
		);
		expect(e.details.quota).toBe("maxSavedSnapshots");
		// Replacing "base" keeps the count at the limit.
		const { snapshot } = await env.svc.saveSnapshot(
			env.p,
			src.sandboxId,
			"base",
		);
		expect(snapshot.pendingName).toBe("base");
	});

	it("is idempotent by key; the hash includes the sandbox", async () => {
		const env = await serviceEnv(t.pool);
		const src = await seedSandbox(t.pool, env, { state: "ready" });
		const a = await env.svc.saveSnapshot(env.p, src.sandboxId, "n1", "key");
		const b = await env.svc.saveSnapshot(env.p, src.slug, "n1", "key");
		expect(b.operation.id).toBe(a.operation.id);
		expect(b.snapshot.id).toBe(a.snapshot.id);
		await expectCode(
			env.svc.saveSnapshot(env.p, src.sandboxId, "n2", "key"),
			"idempotency_key_reused",
		);
	});

	it("deleteSavedSnapshot: deleting, the name is free, a snapshot-op delete job", async () => {
		const env = await serviceEnv(t.pool);
		const id = await insertSavedSnapshot(t.pool, env.topo, {
			teamId: env.p.teamId,
			name: "web",
		});

		await env.svc.deleteSavedSnapshot(env.p, "web");

		expect((await snap(id)).state).toBe("deleting");
		expect(env.jobs.sent).toEqual([
			{
				queue: "snapshot-op",
				data: { snapshotId: id, action: "delete" },
				opts: { singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
			},
		]);
		// No new create can use the deleted snapshot.
		await expectCode(
			env.svc.create(env.p, { from: { snapshot: "web" } }),
			"snapshot_not_found",
		);
		// The name can be used by a new ready snapshot right away.
		await insertSavedSnapshot(t.pool, env.topo, {
			teamId: env.p.teamId,
			name: "web",
		});
	});

	it("deleteSavedSnapshot with an expected id refuses another snapshot of that name", async () => {
		const env = await serviceEnv(t.pool);
		const id = await insertSavedSnapshot(t.pool, env.topo, {
			teamId: env.p.teamId,
			name: "web",
		});
		const err = await env.svc
			.deleteSavedSnapshot(env.p, "web", randomUUID())
			.catch((e: unknown) => e);
		expect(isUmiakError(err, "snapshot_not_found")).toBe(true);
		expect((err as UmiakError).details).toMatchObject({
			reason: "id_mismatch",
		});
		expect((await snap(id)).state).toBe("ready");
		expect(env.jobs.sent).toEqual([]);

		await env.svc.deleteSavedSnapshot(env.p, "web", id);
		expect((await snap(id)).state).toBe("deleting");
	});

	it("deleteSavedSnapshot of an unknown, non-ready or foreign name is snapshot_not_found", async () => {
		const env = await serviceEnv(t.pool);
		await insertSavedSnapshot(t.pool, env.topo, {
			teamId: randomUUID(),
			name: "theirs",
		});
		await insertSavedSnapshot(t.pool, env.topo, {
			teamId: env.p.teamId,
			name: "gone",
			state: "deleting",
		});
		await expectCode(
			env.svc.deleteSavedSnapshot(env.p, "theirs"),
			"snapshot_not_found",
		);
		await expectCode(
			env.svc.deleteSavedSnapshot(env.p, "gone"),
			"snapshot_not_found",
		);
		await expectCode(
			env.svc.deleteSavedSnapshot(env.p, "nope"),
			"snapshot_not_found",
		);
		expect(env.jobs.sent).toEqual([]);
	});

	it("listSavedSnapshots: the team's ready and creating saved snapshots, newest first", async () => {
		const env = await serviceEnv(t.pool);
		const ready = await insertSavedSnapshot(t.pool, env.topo, {
			teamId: env.p.teamId,
			name: "r",
		});
		// `failed` is listed only within a day (S7 §13; s7-additions.test.ts).
		const failed = await insertSavedSnapshot(t.pool, env.topo, {
			teamId: env.p.teamId,
			name: "f",
			state: "failed",
		});
		await t.pool.query(
			"UPDATE runtime.snapshots SET created_at = now() - interval '2 days' WHERE id = $1",
			[failed],
		);
		await insertSavedSnapshot(t.pool, env.topo, {
			teamId: env.p.teamId,
			name: "d",
			state: "deleting",
		});
		await insertSavedSnapshot(t.pool, env.topo, {
			teamId: randomUUID(),
			name: "x",
		});
		const src = await seedSandbox(t.pool, env, { state: "ready" });
		const { snapshot } = await env.svc.saveSnapshot(env.p, src.sandboxId, "c");

		const list = await env.svc.listSavedSnapshots(env.p);
		expect(list.map((s) => s.id)).toEqual([snapshot.id, ready]);
	});
});
