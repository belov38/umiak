import { DELETE_RETRY_LIMIT } from "@sbx/core";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSandboxOpDeadLetter } from "../src/handlers/dlq.ts";
import { handleSandboxOp } from "../src/handlers/sandbox-op.ts";
import { blockAfter } from "./fakes/crash.ts";
import {
	createWorld,
	credentials,
	insertSnapshot,
	type TestWorld,
} from "./fakes/world.ts";
import {
	createSandbox,
	infraState,
	machinesOf,
	type OpsEnv,
	opsEnv,
	readySandbox,
	row,
	run,
	stoppedSandbox,
	until,
	warmMachine,
} from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

async function deleteAndRun(
	w: TestWorld,
	e: OpsEnv,
	sandboxId: string,
): Promise<string> {
	const op = await e.svc.delete(e.p, sandboxId);
	expect(await run(w, op.id)).toBe("succeeded");
	return op.id;
}

/** Everything of the sandbox is gone (§6.4 p. 8). */
async function expectAllGone(
	w: TestWorld,
	sandboxId: string,
	opts: { lvs?: string[] } = {},
): Promise<void> {
	const s = await row(w, "sandboxes", sandboxId);
	expect(s.state).toBe("deleted");
	expect(s.deleted_at).not.toBeNull();
	for (const m of await machinesOf(w, sandboxId)) {
		expect(m.state).toBe("deleted");
		expect((await credentials(w, m.id))?.retired_at ?? "none").not.toBeNull();
	}
	expect(await infraState(w)).toEqual({
		vms: 0,
		lvs: opts.lvs ?? [],
		leases: 0,
	});
	const secrets = await w.pool.query(
		"SELECT 1 FROM runtime.sandbox_secrets WHERE sandbox_id = $1",
		[sandboxId],
	);
	expect(secrets.rowCount).toBe(0);
	const ports = await w.pool.query(
		"SELECT 1 FROM runtime.hosted_ports WHERE sandbox_id = $1 AND deleted_at IS NULL",
		[sandboxId],
	);
	expect(ports.rowCount).toBe(0);
}

describe("delete", () => {
	it("a ready sandbox: retire, stop, destroy, ports, secrets, finish", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, machineId } = await readySandbox(w, e);
		await e.svc.hostPort(e.p, sandboxId, 8080, "public");
		const vmid = (await row(w, "machines", machineId)).vmid as number;

		const opId = await deleteAndRun(w, e, sandboxId);

		await expectAllGone(w, sandboxId);
		const op = await row(w, "operations", opId);
		expect(op.state).toBe("succeeded");
		expect(op.step).toBe("secrets");
		const order = w.infra.calls
			.filter((c) => ["stop", "delete"].includes(c.method))
			.map((c) => c.method);
		expect(order).toEqual(["stop", "delete"]);
		expect(w.infra.callsOf("delete")[0]?.args).toEqual([vmid]);
		const m = await row(w, "machines", machineId);
		expect(m.power_observed).toBe("stopped");
		// The superseded-free path sends no extra jobs.
		expect(
			w.jobs.sent.filter(
				(j) => j.queue === "sandbox-op" && j.opts?.retryLimit !== undefined,
			),
		).toEqual([
			{
				queue: "sandbox-op",
				data: { operationId: opId },
				opts: { singletonKey: sandboxId, retryLimit: DELETE_RETRY_LIMIT },
			},
		]);
	});

	it("snapshots: consumed fork sources and creating snapshots of this sandbox go, saved ones stay", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId } = await readySandbox(w, e);
		const consumed = await insertSnapshot(w, { kind: "fork_source" });
		const ownCreating = await insertSnapshot(w, {
			kind: "saved",
			state: "creating",
		});
		const saved = await insertSnapshot(w, { kind: "saved" });
		const parentOwned = await insertSnapshot(w, {
			kind: "fork_source",
			state: "creating",
		});
		await w.pool.query(
			"UPDATE runtime.snapshots SET consumer_sandbox_id = $2 WHERE id = ANY($1::uuid[])",
			[[consumed.snapshotId, parentOwned.snapshotId], sandboxId],
		);
		await w.pool.query(
			"UPDATE runtime.snapshots SET source_sandbox_id = $2 WHERE id = ANY($1::uuid[])",
			[[ownCreating.snapshotId, saved.snapshotId], sandboxId],
		);

		await deleteAndRun(w, e, sandboxId);

		const lv = (x: { lvId: string }) => `sbx-snap-${x.lvId}-scsi0`;
		await expectAllGone(w, sandboxId, {
			lvs: [lv(saved), lv(parentOwned)].sort(),
		});
		expect((await row(w, "snapshots", consumed.snapshotId)).state).toBe(
			"deleted",
		);
		expect((await row(w, "snapshots", ownCreating.snapshotId)).state).toBe(
			"deleted",
		);
		expect((await row(w, "snapshots", saved.snapshotId)).state).toBe("ready");
		expect((await row(w, "snapshots", parentOwned.snapshotId)).state).toBe(
			"creating",
		);
	});

	it("during a cold create stuck in S1 create (provision): everything is removed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, operationId } = await createSandbox(w, e);
		const blocked = blockAfter(w.infra, "create");
		w.useInfra(blocked.port);
		const create = handleSandboxOp(w.ctx, { operationId });
		await blocked.reached;

		await deleteAndRun(w, e, sandboxId);
		blocked.release();

		expect(await create).toBe("fenced_out");
		await w.agentWorld.settled();
		expect((await row(w, "operations", operationId)).state).toBe("superseded");
		await expectAllGone(w, sandboxId);
		expect(w.infra.callsOf("start")).toHaveLength(0);
	});

	it("during a cold create waiting for the agent (boot): everything is removed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, operationId } = await createSandbox(w, e);
		w.agentWorld.holdBoots();
		const create = handleSandboxOp(w.ctx, { operationId });
		await until("provision recorded", async () => {
			return (await row(w, "operations", operationId)).step === "provision";
		});

		// Boots are held: run the delete without waiting for them to settle.
		const del = await e.svc.delete(e.p, sandboxId);
		expect(await handleSandboxOp(w.ctx, { operationId: del.id })).toBe(
			"succeeded",
		);

		expect(await create).toBe("fenced_out");
		w.agentWorld.releaseBoots();
		await w.agentWorld.settled();
		await expectAllGone(w, sandboxId);
		// The VM was deleted before its boot went on: it never connected.
		expect(w.agentWorld.refused).toHaveLength(0);
		expect(w.agent.callsOf("claim")).toHaveLength(0);
	});

	it("during a claim-path create stuck in System/Claim: everything is removed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const warm = await warmMachine(w);
		const { sandboxId, operationId } = await createSandbox(w, e);
		expect((await row(w, "sandboxes", sandboxId)).machine_id).toBe(warm);
		const blocked = blockAfter(w.agent, "claim");
		w.ctx.agent = blocked.port;
		const create = handleSandboxOp(w.ctx, { operationId });
		await blocked.reached;

		await deleteAndRun(w, e, sandboxId);
		blocked.release();

		expect(await create).toBe("fenced_out");
		await expectAllGone(w, sandboxId);
		expect((await row(w, "machines", warm)).provisioned_boot_id).toBeNull();
	});

	it("during a resume stuck in S1 start: everything is removed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId } = await stoppedSandbox(w, e);
		const resume = await e.svc.resume(e.p, sandboxId);
		const blocked = blockAfter(w.infra, "start");
		w.useInfra(blocked.port);
		const pending = handleSandboxOp(w.ctx, { operationId: resume.id });
		await blocked.reached;

		await deleteAndRun(w, e, sandboxId);
		blocked.release();

		expect(await pending).toBe("fenced_out");
		await w.agentWorld.settled();
		await expectAllGone(w, sandboxId);
	});

	it("an error sandbox whose machine is already deleting (compensation) is cleaned up", async () => {
		const w = await createWorld(db, { boot: "connect", bootTimeoutS: 1 });
		const e = opsEnv(w);
		const { sandboxId, operationId } = await createSandbox(w, e);
		expect(await run(w, operationId)).toBe("failed");
		expect((await row(w, "sandboxes", sandboxId)).state).toBe("error");

		await deleteAndRun(w, e, sandboxId);

		await expectAllGone(w, sandboxId);
	});

	it("dead letter: a delete is enqueued again after 60 s with the stuck alarm", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId } = await readySandbox(w, e);
		const op = await e.svc.delete(e.p, sandboxId);
		w.jobs.clear();

		expect(await handleSandboxOpDeadLetter(w.ctx, { operationId: op.id })).toBe(
			"requeued",
		);

		expect(w.jobs.sent).toEqual([
			{
				queue: "sandbox-op",
				data: { operationId: op.id },
				opts: {
					singletonKey: sandboxId,
					startAfter: 60,
					retryLimit: DELETE_RETRY_LIMIT,
				},
			},
		]);
		expect(w.metrics.count("sbx_delete_dead_letter_total")).toBe(1);
		expect((await row(w, "operations", op.id)).state).toBe("pending");
		expect(await run(w, op.id)).toBe("succeeded");
		await expectAllGone(w, sandboxId);
	});

	it("errors of a delete are always thrown (never failed)", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId } = await readySandbox(w, e);
		const op = await e.svc.delete(e.p, sandboxId);
		const orig = w.infra.delete.bind(w.infra);
		let n = 0;
		w.infra.delete = async (vmid: number) => {
			n += 1;
			if (n === 1) throw new Error("permanent-looking S1 error");
			return orig(vmid);
		};
		await expect(
			handleSandboxOp(w.ctx, { operationId: op.id }),
		).rejects.toThrow("permanent-looking");
		expect((await row(w, "operations", op.id)).state).toBe("running");
		expect(await run(w, op.id)).toBe("succeeded");
		await expectAllGone(w, sandboxId);
	});
});
