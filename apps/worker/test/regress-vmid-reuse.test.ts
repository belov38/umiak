// Regression (S6 acceptance H1): two deleters of one machine (the
// compensation's machine-op delete job and the sandbox delete's inline
// destroy) both read the lease, pass their fence checks and queue S1
// delete(vmid). The first one frees the VMID; a new create gets the same VMID
// (lowest free); the second S1 delete must not destroy the new sandbox's VM:
// S1 checks under the power lock that the lease is still the machine's.
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMachineOp } from "../src/handlers/machine-op.ts";
import { handleSandboxOp } from "../src/handlers/sandbox-op.ts";
import { blockBefore } from "./fakes/crash.ts";
import { createWorld } from "./fakes/world.ts";
import {
	createSandbox,
	opsEnv,
	readySandbox,
	row,
	run,
} from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

describe("regression: VMID reuse between two deleters of one machine", () => {
	it("the second S1 delete must not destroy the VM of another machine that got the freed VMID", async () => {
		const w = await createWorld(db, { boot: "connect", bootTimeoutS: 1 });
		const e = opsEnv(w);
		// A: cold create fails (boot timeout) -> machine deleting + machine-op delete job.
		const a = await createSandbox(w, e);
		expect(await run(w, a.operationId)).toBe("failed");
		const aMachine = (await row(w, "sandboxes", a.sandboxId))
			.machine_id as string;
		const aVmid = (await row(w, "machines", aMachine)).vmid as number;
		expect(
			w.jobs.sent.some(
				(j) =>
					j.queue === "machine-op" &&
					j.data.machineId === aMachine &&
					j.data.action === "delete",
			),
		).toBe(true);

		// D1: the compensation's machine-op delete job, held right before S1 delete.
		const w1 = blockBefore(w.infra, "delete");
		w.useInfra(w1.port);
		const d1 = handleMachineOp(w.ctx, {
			machineId: aMachine,
			action: "delete",
		});
		await w1.reached;

		// D2: the user deletes the error sandbox; its destroy step also reaches S1 delete.
		const w2 = blockBefore(w.infra, "delete");
		w.useInfra(w2.port);
		const delOp = await e.svc.delete(e.p, a.sandboxId);
		const d2 = handleSandboxOp(w.ctx, { operationId: delOp.id });
		await w2.reached;
		w.useInfra(w.infra);

		// D1 frees the VMID.
		w1.release();
		expect(await d1).toBe("fenced_out");

		// B: a new sandbox gets the freed VMID.
		w.agentWorld.behavior = "ready";
		const b = await readySandbox(w, e);
		const bVmid = (await row(w, "machines", b.machineId)).vmid as number;
		expect(bVmid).toBe(aVmid);
		expect(w.infra.vms.has(bVmid)).toBe(true);

		// D2 goes on with its S1 delete of the same VMID.
		w2.release();
		// D2 sees an owner mismatch: A's VM is gone already, the delete finishes.
		expect(await d2).toBe("succeeded");
		expect((await row(w, "machines", aMachine)).state).toBe("deleted");
		expect((await row(w, "sandboxes", a.sandboxId)).state).toBe("deleted");

		// B's VM and lease must survive.
		expect((await row(w, "sandboxes", b.sandboxId)).state).toBe("ready");
		expect(w.infra.vms.has(bVmid)).toBe(true);
		const lease = await w.pool.query(
			"SELECT machine_id FROM runtime.vmid_leases WHERE provider_id = $1 AND vmid = $2",
			[w.topo.providerId, bVmid],
		);
		expect(lease.rows[0]?.machine_id).toBe(b.machineId);
	});
});
