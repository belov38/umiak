import { ingestAgentEvents } from "@sbx/core";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMachineEvents } from "../src/handlers/machine-events.ts";
import { QuiesceFailed } from "../src/ops/snapshot-step.ts";
import { blockAfter } from "./fakes/crash.ts";
import { createWorld } from "./fakes/world.ts";
import { activeOps, synthetic } from "./helpers/controllers.ts";
import {
	forkSandbox,
	opsEnv,
	readySandbox,
	row,
	run,
	sessionBoot,
} from "./helpers/ops.ts";

let db: TestDatabase;
beforeAll(async () => {
	db = await createTestDatabase();
});
afterAll(async () => {
	await db?.drop();
});

describe("S9 worker contracts", () => {
	it("allows a forced fork from dirty Windows disks", async () => {
		const w = await createWorld(db);
		await w.pool.query(
			"UPDATE runtime.template_builds SET os = 'windows' WHERE id = $1",
			[w.topo.templateBuildId],
		);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		expect((await row(w, "machines", s.machineId)).secret_files_on_disk).toBe(
			true,
		);
		// PrepareStop does not confirm the wipe: a fork is still allowed.
		const fork = await forkSandbox(e, s.sandboxId, { forceStop: true });
		expect(await run(w, fork.forkOpId)).toBe("succeeded");
	});

	it("retains a newer pending generation received while UpdateSecrets is returning", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		await synthetic(w, s.machineId, "agent_restarted");
		const op = (await activeOps(w, s.sandboxId))[0];
		const blocked = blockAfter(w.agent, "updateSecrets");
		w.ctx.agent = blocked.port;
		const running = run(w, op?.id as string);
		await blocked.reached;
		await synthetic(w, s.machineId, "agent_restarted");
		blocked.release();
		expect(await running).toBe("succeeded");
		const next = await activeOps(w, s.sandboxId);
		expect(next).toHaveLength(1);
		expect(next[0]?.id).not.toBe(op?.id);
		expect(await run(w, next[0]?.id as string)).toBe("succeeded");
		expect(await activeOps(w, s.sandboxId)).toEqual([]);
	});
	it("tracks Windows claim, rejects dirty running save, and allows a confirmed clean stop", async () => {
		const w = await createWorld(db);
		await w.pool.query(
			"UPDATE runtime.template_builds SET os = 'windows' WHERE id = $1",
			[w.topo.templateBuildId],
		);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		expect((await row(w, "machines", s.machineId)).secret_files_on_disk).toBe(
			true,
		);
		await expect(
			e.svc.saveSnapshot(e.p, s.sandboxId, "dirty"),
		).rejects.toMatchObject({ code: "snapshot_requires_stop" });
		expect(w.infra.callsOf("snapshot")).toHaveLength(0);
		w.agent.secretFilesWiped = true;
		const stop = await e.svc.stop(e.p, s.sandboxId);
		expect(await run(w, stop.id)).toBe("succeeded");
		expect((await row(w, "machines", s.machineId)).secret_files_on_disk).toBe(
			false,
		);
		const clean = await e.svc.saveSnapshot(e.p, s.sandboxId, "clean");
		expect(await run(w, clean.operation.id)).toBe("succeeded");
	});

	it("retains dirty state after unconfirmed stop and blocks stopped saved snapshots", async () => {
		const w = await createWorld(db);
		await w.pool.query(
			"UPDATE runtime.template_builds SET os = 'windows' WHERE id = $1",
			[w.topo.templateBuildId],
		);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		w.agent.fail("prepareStop", "unavailable");
		const stop = await e.svc.stop(e.p, s.sandboxId);
		expect(await run(w, stop.id)).toBe("succeeded");
		expect((await row(w, "machines", s.machineId)).secret_files_on_disk).toBe(
			true,
		);
		const snap = await e.svc.saveSnapshot(e.p, s.sandboxId, "dirty-stop");
		expect(await run(w, snap.operation.id)).toBe("failed");
		expect((await row(w, "operations", snap.operation.id)).error_code).toBe(
			"snapshot_requires_clean_stop",
		);
	});

	it.each(["pending", "connected", "agent_restarted"] as const)(
		"redelivers secrets on the same boot after %s",
		async (cause) => {
			const w = await createWorld(db);
			const e = opsEnv(w);
			const s = await readySandbox(w, e);
			const boot = await sessionBoot(w, s.machineId);
			if (cause === "pending") {
				await ingestAgentEvents(w.pool, w.jobs, {
					machineId: s.machineId,
					synthetic: [],
					events: [
						{
							seq: 1000,
							bootId: boot as string,
							type: "readiness.changed",
							time: new Date(),
							payload: { phase: "secrets", state: "pending" },
						},
					],
				});
				await handleMachineEvents(w.ctx, { machineId: s.machineId });
			} else {
				await synthetic(w, s.machineId, cause);
			}
			const ops = await activeOps(w, s.sandboxId);
			expect(ops).toHaveLength(1);
			const before = w.agent.callsOf("updateSecrets").length;
			expect(await run(w, ops[0]?.id as string)).toBe("succeeded");
			expect(w.agent.callsOf("updateSecrets")).toHaveLength(before + 1);
			expect((await row(w, "machines", s.machineId)).provisioned_boot_id).toBe(
				boot,
			);
		},
	);
	it("clears the disk flag after successful empty secret-file replacement on resume", async () => {
		const w = await createWorld(db);
		await w.pool.query(
			"UPDATE runtime.template_builds SET os = 'windows' WHERE id = $1",
			[w.topo.templateBuildId],
		);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		const stop = await e.svc.stop(e.p, s.sandboxId);
		expect(await run(w, stop.id)).toBe("succeeded");
		const resume = await e.svc.resume(e.p, s.sandboxId, {
			secretFiles: { id_rsa: null },
		});
		expect(await run(w, resume.id)).toBe("succeeded");
		expect((await row(w, "machines", s.machineId)).secret_files_on_disk).toBe(
			false,
		);
	});

	it("retains a pending event during snapshot and delivers it after the active operation", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		const snap = await e.svc.saveSnapshot(e.p, s.sandboxId, "busy");
		const bootId = (await sessionBoot(w, s.machineId)) as string;
		await ingestAgentEvents(w.pool, w.jobs, {
			machineId: s.machineId,
			synthetic: [],
			events: [
				{
					seq: 1000,
					bootId,
					type: "readiness.changed",
					time: new Date(),
					payload: { phase: "secrets", state: "pending" },
				},
			],
		});
		await handleMachineEvents(w.ctx, { machineId: s.machineId });
		expect((await activeOps(w, s.sandboxId)).map((o) => o.kind)).toEqual([
			"save_snapshot",
		]);
		expect(await run(w, snap.operation.id)).toBe("succeeded");
		const ops = await activeOps(w, s.sandboxId);
		expect(ops.map((o) => o.kind)).toEqual(["reprovision"]);
		expect(await run(w, ops[0]?.id as string)).toBe("succeeded");
		expect(await activeOps(w, s.sandboxId)).toEqual([]);
	});

	it("retries a snapshot freeze-budget lock failure with fresh agent hooks", async () => {
		const w = await createWorld(db);
		w.ctx.timing.vmLockSleep = async () => {};
		const e = opsEnv(w);
		const s = await readySandbox(w, e, { secretFiles: [] });
		const snap = await e.svc.saveSnapshot(e.p, s.sandboxId, "retry");
		w.infra.snapshotFailureAfterFreeze = new QuiesceFailed(
			"freeze took 12000 ms (budget 1000 ms); snapshot discarded",
		);
		expect(await run(w, snap.operation.id)).toBe("succeeded");
		expect(w.agent.callsOf("freeze")).toHaveLength(2);
		expect(w.agent.callsOf("thaw")).toHaveLength(2);
	});

	it("abandons snapshot lock retries when another executor takes over", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		const snap = await e.svc.saveSnapshot(e.p, s.sandboxId, "fenced");
		w.ctx.timing.vmLockSleep = async () => {
			await w.pool.query(
				"UPDATE runtime.operations SET attempt = attempt + 1 WHERE id = $1",
				[snap.operation.id],
			);
		};
		w.infra.snapshotFailure = new Error("can't lock file 'vm' - got timeout");
		expect(await run(w, snap.operation.id)).toBe("fenced_out");
		expect(w.infra.callsOf("snapshot")).toHaveLength(1);
	});
});
