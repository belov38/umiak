import type { WorkerCtx } from "../../src/context.ts";
import {
	handleMachineOp as deleteMachine,
	type MachineOpData,
	type MachineOpResult,
} from "../../src/handlers/machine-op.ts";
import { prepareMachine, waitBooted } from "../../src/machine-prep.ts";
import { FencedOut, MachineFence } from "../../src/steps.ts";

/** Exercise cold preparation primitives with a machine fence, independently of sandbox orchestration. */
export async function prepareFixture(
	ctx: WorkerCtx,
	data: MachineOpData,
): Promise<MachineOpResult> {
	if (data.action === "delete") {
		// Explicit fixture teardown, equivalent to an operator releasing quarantine.
		await ctx.pool.query(
			"UPDATE runtime.machines SET pool_key=NULL,state='deleting' WHERE id=$1 AND state <> 'deleted'",
			[data.machineId],
		);
		return deleteMachine(ctx, data);
	}
	const fence = await MachineFence.begin(ctx, data.machineId, "provision");
	if (!fence) return "skipped";
	try {
		const m = fence.machine;
		await prepareMachine(
			ctx,
			fence,
			m.id,
			m.origin === "snapshot" && m.origin_snapshot_id !== null
				? { kind: "snapshot", snapshotId: m.origin_snapshot_id }
				: { kind: "template" },
		);
		const r = await ctx.pool.query(
			"SELECT boot_timeout_s FROM runtime.template_builds WHERE id=$1",
			[m.template_build_id],
		);
		await waitBooted(
			ctx,
			fence,
			m.id,
			(r.rows[0]?.boot_timeout_s ?? 300) * 1000,
		);
		await fence.tx(async (tx) => {
			await tx.client.query(
				"UPDATE runtime.machines SET state='warm',warm_at=now(),pool_key=NULL WHERE id=$1",
				[m.id],
			);
		});
		return "done";
	} catch (e) {
		if (e instanceof FencedOut) return "fenced_out";
		try {
			await fence.check();
		} catch (err) {
			if (err instanceof FencedOut) return "fenced_out";
			throw err;
		}
		throw e;
	}
}
