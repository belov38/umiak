import { DELETE_RETRY_LIMIT, stepRequestId } from "@sbx/core";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSandboxOpDeadLetter } from "../src/handlers/dlq.ts";
import { handleMachineOp } from "../src/handlers/machine-op.ts";
import { handleSandboxOp } from "../src/handlers/sandbox-op.ts";
import type { ClaimRequest } from "../src/ports.ts";
import { spyBefore } from "./fakes/crash.ts";
import { createWorld, insertSnapshot, type TestWorld } from "./fakes/world.ts";
import {
	createSandbox,
	ENV,
	expireDeadline,
	infraState,
	machinesOf,
	opsEnv,
	row,
	run,
	SECRETS,
	sessionBoot,
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

function claimsOf(w: TestWorld) {
	return w.agent.callsOf("claim");
}

async function events(w: TestWorld, sandboxId: string) {
	const r = await w.pool.query<{
		type: string;
		from_state: string | null;
		to_state: string | null;
		reason: string | null;
	}>(
		`SELECT type, from_state, to_state, reason FROM runtime.sandbox_events
		 WHERE sandbox_id = $1 ORDER BY created_at, id`,
		[sandboxId],
	);
	return r.rows;
}

const byId = (xs: { id: string; state: string }[]) =>
	[...xs].sort((x, y) => (x.id < y.id ? -1 : 1));

describe("create, cold path", () => {
	it("provision → boot → rotate_token → claim → finish: sandbox ready, machine running", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, operationId } = await createSandbox(w, e, {
			ttlSeconds: 3600,
		});

		expect(await run(w, operationId)).toBe("succeeded");

		const s = await row(w, "sandboxes", sandboxId);
		const m = await row(w, "machines", s.machine_id as string);
		const op = await row(w, "operations", operationId);
		expect(s.state).toBe("ready");
		expect(s.ready_at).not.toBeNull();
		expect(s.health).toBe("ok");
		const ttlMs = (s.deadline_at as Date).getTime() - Date.now();
		expect(ttlMs).toBeGreaterThan(3590_000);
		expect(ttlMs).toBeLessThanOrEqual(3600_000);
		expect(m.state).toBe("running");
		expect(m.power_observed).toBe("running");
		expect(m.provisioned_boot_id).toBe(await sessionBoot(w, m.id as string));
		expect(op.state).toBe("succeeded");
		expect(op.step).toBe("claim");

		expect(w.infra.callsOf("create")).toHaveLength(1);
		expect(w.gateway.rotated).toEqual([m.id]);
		const claims = claimsOf(w);
		expect(claims).toHaveLength(1);
		expect(claims[0]?.machineId).toBe(m.id);
		expect(claims[0]?.requestId).toBe(stepRequestId(operationId, "claim"));
		const req = claims[0]?.args as ClaimRequest;
		expect(req).toEqual({
			reason: "claim",
			sandboxId,
			hostname: `sbx-${s.slug}`,
			env: ENV,
			secretEnv: SECRETS,
			secretFiles: [
				{
					name: "id_rsa",
					contentBase64: Buffer.from("key").toString("base64"),
					mode: 0o440,
				},
			],
			authorizedKeys: [],
		});
		expect(await events(w, sandboxId)).toContainEqual({
			type: "state_changed",
			from_state: "creating",
			to_state: "ready",
			reason: "create_done",
		});
		expect(await infraState(w)).toMatchObject({ vms: 1, leases: 1 });
	});

	it("without a TTL the sandbox has no deadline", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, operationId } = await createSandbox(w, e);
		expect(await run(w, operationId)).toBe("succeeded");
		expect((await row(w, "sandboxes", sandboxId)).deadline_at).toBeNull();
	});

	it("from a saved snapshot: S1 fork of the snapshot, origin kept", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { snapshotId, lvId } = await insertSnapshot(w);
		await w.pool.query(
			"UPDATE runtime.snapshots SET team_id = $2, name = 'base' WHERE id = $1",
			[snapshotId, e.p.teamId],
		);
		const { sandboxId, operationId } = await createSandbox(w, e, {
			from: { snapshot: "base" },
		});

		expect(await run(w, operationId)).toBe("succeeded");

		const s = await row(w, "sandboxes", sandboxId);
		const m = await row(w, "machines", s.machine_id as string);
		expect(s.state).toBe("ready");
		expect(s.origin).toBe("snapshot");
		expect(m.origin).toBe("snapshot");
		expect(m.origin_snapshot_id).toBe(snapshotId);
		expect(m.state).toBe("running");
		expect(w.infra.callsOf("create")).toHaveLength(0);
		expect(w.infra.callsOf("fork")).toEqual([
			{
				method: "fork",
				args: [{ machineId: m.id, lvId, size: { vcpu: 2, memoryMb: 2048 } }],
			},
		]);
		// The saved snapshot survives the create.
		expect((await row(w, "snapshots", snapshotId)).state).toBe("ready");
		expect(w.infra.lvs.has(`sbx-snap-${lvId}-scsi0`)).toBe(true);
	});

	it("a failed cold preparation: machine failed → deleting, sandbox error create_failed", async () => {
		const w = await createWorld(db, { boot: "connect", bootTimeoutS: 1 });
		const e = opsEnv(w);
		const { sandboxId, operationId } = await createSandbox(w, e);

		expect(await run(w, operationId)).toBe("failed");

		const s = await row(w, "sandboxes", sandboxId);
		const op = await row(w, "operations", operationId);
		const m = await row(w, "machines", s.machine_id as string);
		expect(op.state).toBe("failed");
		expect(op.error_code).toBe("boot_timeout");
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("create_failed");
		expect(m.state).toBe("deleting");
		expect(m.error_code).toBe("boot_timeout");
		expect(w.jobs.sent).toContainEqual({
			queue: "machine-op",
			data: { machineId: m.id, action: "delete" },
			opts: { singletonKey: m.id, retryLimit: DELETE_RETRY_LIMIT },
		});
		expect(
			await handleMachineOp(w.ctx, {
				machineId: m.id as string,
				action: "delete",
			}),
		).toBe("done");
		expect(await infraState(w)).toEqual({ vms: 0, lvs: [], leases: 0 });
	});

	it("an unavailable agent is retryable: the job is thrown and the next attempt finishes", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, operationId } = await createSandbox(w, e);
		w.agent.fail("claim", "unavailable");

		await expect(handleSandboxOp(w.ctx, { operationId })).rejects.toMatchObject(
			{ code: "agent_unavailable" },
		);
		expect((await row(w, "operations", operationId)).step).toBe("rotate_token");
		expect(await run(w, operationId)).toBe("succeeded");
		expect((await row(w, "sandboxes", sandboxId)).state).toBe("ready");
		expect(claimsOf(w).map((c) => c.requestId)).toEqual([
			stepRequestId(operationId, "claim"),
			stepRequestId(operationId, "claim"),
		]);
		expect(w.infra.callsOf("create")).toHaveLength(1);
	});

	it("deadline passed: no new steps, compensation, failed deadline_exceeded", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, operationId } = await createSandbox(w, e);
		await expireDeadline(w, operationId);

		expect(await run(w, operationId)).toBe("failed");

		const op = await row(w, "operations", operationId);
		const s = await row(w, "sandboxes", sandboxId);
		expect(op.error_code).toBe("deadline_exceeded");
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("create_failed");
		expect(await machinesOf(w, sandboxId)).toEqual([
			{ id: s.machine_id, state: "deleting" },
		]);
		expect(w.infra.calls).toEqual([]);
	});

	it("a database error (40P01) is transient: thrown, no compensation, the op stays running", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, operationId } = await createSandbox(w, e);
		w.useInfra(
			spyBefore(w.infra, "create", async () => {
				throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
			}),
		);

		await expect(handleSandboxOp(w.ctx, { operationId })).rejects.toThrow(
			"deadlock detected",
		);

		const op = await row(w, "operations", operationId);
		const s = await row(w, "sandboxes", sandboxId);
		expect(op.state).toBe("running");
		expect(op.error_code).toBeNull();
		expect(op.progress).not.toHaveProperty("compensating");
		expect(s.state).toBe("creating");
		expect(await machinesOf(w, sandboxId)).toEqual([
			{ id: s.machine_id, state: "provisioning" },
		]);
		expect(w.jobs.sent.filter((j) => j.queue === "machine-op")).toEqual([]);

		// Once the deadline has passed, the next attempt compensates.
		await expireDeadline(w, operationId);
		expect(await run(w, operationId)).toBe("failed");
		expect((await row(w, "operations", operationId)).error_code).toBe(
			"deadline_exceeded",
		);
		const after = await row(w, "sandboxes", sandboxId);
		expect(after.state).toBe("error");
		expect(after.error_code).toBe("create_failed");
		expect(await machinesOf(w, sandboxId)).toEqual([
			{ id: s.machine_id, state: "deleting" },
		]);
	});

	it("dead letter: failed retries_exhausted, the machine is deleted", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const { sandboxId, operationId } = await createSandbox(w, e);
		w.useInfra(
			spyBefore(w.infra, "create", async () => {
				throw Object.assign(new Error("proxmox 503"), { retryable: true });
			}),
		);
		await expect(handleSandboxOp(w.ctx, { operationId })).rejects.toThrow(
			"proxmox 503",
		);
		w.useInfra(w.infra);

		expect(await handleSandboxOpDeadLetter(w.ctx, { operationId })).toBe(
			"failed",
		);

		const op = await row(w, "operations", operationId);
		const s = await row(w, "sandboxes", sandboxId);
		expect(op.state).toBe("failed");
		expect(op.error_code).toBe("retries_exhausted");
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("create_failed");
		const machineId = s.machine_id as string;
		expect((await row(w, "machines", machineId)).state).toBe("deleting");
		expect(await handleMachineOp(w.ctx, { machineId, action: "delete" })).toBe(
			"done",
		);
		expect((await row(w, "machines", machineId)).state).toBe("deleted");
		expect(await infraState(w)).toEqual({ vms: 0, lvs: [], leases: 0 });
		expect(w.metrics.count("sbx_operation_retries_exhausted_total")).toBe(1);
		// A late redelivery of the original job does nothing.
		expect(await handleSandboxOp(w.ctx, { operationId })).toBe("skipped");
	});
});

describe("create, pool claim path", () => {
	it("claims a warm machine: rotate_token → claim → finish, no preparation", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const warm = await warmMachine(w);
		const createsBefore = w.infra.callsOf("create").length;
		const { sandboxId, operationId } = await createSandbox(w, e);
		expect((await row(w, "operations", operationId)).request).toMatchObject({
			fromPool: true,
		});

		expect(await run(w, operationId)).toBe("succeeded");

		const s = await row(w, "sandboxes", sandboxId);
		const m = await row(w, "machines", warm);
		expect(s.machine_id).toBe(warm);
		expect(s.state).toBe("ready");
		expect(m.state).toBe("running");
		expect(m.pool_key).toBeNull();
		expect(m.provisioned_boot_id).toBe(await sessionBoot(w, warm));
		expect(w.infra.callsOf("create")).toHaveLength(createsBefore);
		expect(w.infra.callsOf("start")).toHaveLength(1);
		expect(w.gateway.rotated).toEqual([warm]);
		expect(claimsOf(w).map((c) => c.machineId)).toEqual([warm]);
		expect((await row(w, "operations", operationId)).step).toBe("claim");
	});

	it("claim rejected → retry with another warm machine → rejected again → error create_failed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const a = await warmMachine(w);
		const b = await warmMachine(w);
		w.agent.fail("claim", { rejected: "already_claimed" }, 2);
		const { sandboxId, operationId } = await createSandbox(w, e);

		expect(await run(w, operationId)).toBe("failed");

		const s = await row(w, "sandboxes", sandboxId);
		const op = await row(w, "operations", operationId);
		expect(claimsOf(w).map((c) => c.machineId)).toEqual([a, b]);
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("create_failed");
		expect(s.machine_id).toBe(b);
		expect(op.state).toBe("failed");
		expect(op.error_code).toBe("already_claimed");
		expect(op.progress).toMatchObject({
			claimRetried: true,
			rejectedMachineId: a,
		});
		expect(byId(await machinesOf(w, sandboxId))).toEqual(
			byId([
				{ id: a, state: "deleting" },
				{ id: b, state: "deleting" },
			]),
		);
		for (const id of [a, b]) {
			expect(w.jobs.sent).toContainEqual({
				queue: "machine-op",
				data: { machineId: id, action: "delete" },
				opts: { singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
			});
		}
		expect(w.metrics.count("sbx_claim_retried_total")).toBe(1);
	});

	it("claim rejected with no other warm machine → retried cold and ready", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const warm = await warmMachine(w);
		w.agent.fail("claim", { rejected: "bad_state" }, 1);
		const { sandboxId, operationId } = await createSandbox(w, e);

		expect(await run(w, operationId)).toBe("succeeded");

		const s = await row(w, "sandboxes", sandboxId);
		expect(s.state).toBe("ready");
		expect(s.machine_id).not.toBe(warm);
		expect((await row(w, "machines", warm)).state).toBe("deleting");
		const m = await row(w, "machines", s.machine_id as string);
		expect(m.state).toBe("running");
		expect(m.pool_key).toBeNull();
		expect(m.sandbox_id).toBe(sandboxId);
		// The new path gets the cold deadline (6 min on Linux).
		const op = await row(w, "operations", operationId);
		const left = (op.deadline_at as Date).getTime() - Date.now();
		expect(left).toBeGreaterThan(5 * 60_000);
		expect(claimsOf(w).map((c) => c.machineId)).toEqual([warm, m.id]);
	});

	it("cold retry on a node that fits exactly one machine: the rejected machine's RAM is freed first", async () => {
		const w = await createWorld(db, { ramCapMb: 2048 });
		const e = opsEnv(w);
		const warm = await warmMachine(w);
		w.agent.fail("claim", { rejected: "bad_state" }, 1);
		const { sandboxId, operationId } = await createSandbox(w, e);

		const create = handleSandboxOp(w.ctx, { operationId });
		// The new machine waits at the start gate until the rejected one is
		// powered off by its machine-op delete.
		await until("rejected machine deleting", async () => {
			return (await row(w, "machines", warm)).state === "deleting";
		});
		expect(
			await handleMachineOp(w.ctx, { machineId: warm, action: "delete" }),
		).toBe("done");
		expect(await create).toBe("succeeded");
		await w.agentWorld.settled();

		const s = await row(w, "sandboxes", sandboxId);
		expect(s.state).toBe("ready");
		expect(s.machine_id).not.toBe(warm);
		expect((await row(w, "machines", warm)).state).toBe("deleted");
		expect((await row(w, "machines", s.machine_id as string)).state).toBe(
			"running",
		);
		expect(await infraState(w)).toMatchObject({ vms: 1, leases: 1 });
	});

	it("failFast: a rejected claim is retried only from the pool; none left → create_failed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const warm = await warmMachine(w);
		w.agent.fail("claim", { rejected: "already_claimed" }, 1);
		const { sandboxId, operationId } = await createSandbox(w, e, {
			failFast: true,
		});

		expect(await run(w, operationId)).toBe("failed");

		const s = await row(w, "sandboxes", sandboxId);
		expect(s.state).toBe("error");
		expect(s.error_code).toBe("create_failed");
		expect(await machinesOf(w, sandboxId)).toEqual([
			{ id: warm, state: "deleting" },
		]);
		expect(w.infra.callsOf("create")).toHaveLength(1); // the pool machine only
	});

	it("claim not done before the deadline → one retry on a cold machine with a new deadline", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const warm = await warmMachine(w);
		const { sandboxId, operationId } = await createSandbox(w, e);
		await expireDeadline(w, operationId);

		expect(await run(w, operationId)).toBe("succeeded");

		const s = await row(w, "sandboxes", sandboxId);
		expect(s.state).toBe("ready");
		expect(s.machine_id).not.toBe(warm);
		const old = await row(w, "machines", warm);
		expect(old.state).toBe("deleting");
		expect(old.error_code).toBe("deadline_exceeded");
	});
});
