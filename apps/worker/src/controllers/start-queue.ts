import { expireQueuedStart } from "@umiak/core";
import { withTx } from "@umiak/db";
import type { WorkerCtx } from "../context.ts";

/** One-second periodic sweep plus the controller's durable pg-boss cron safety net. */
export async function runStartQueue(ctx: WorkerCtx): Promise<void> {
	const expired = (
		await ctx.pool.query<{ operation_id: string }>(
			"SELECT operation_id FROM runtime.start_queue WHERE deadline_at<=now() ORDER BY seq LIMIT 128",
		)
	).rows;
	for (const ticket of expired)
		await expireQueuedStart(ctx, ticket.operation_id);
	await withTx(ctx.pool, async (tx) => {
		await tx.client.query(
			"DELETE FROM runtime.start_queue q USING runtime.operations o WHERE q.operation_id=o.id AND o.state NOT IN ('pending','running')",
		);
		const heads = (
			await tx.client.query<{ operation_id: string; sandbox_id: string }>(
				`SELECT q.operation_id,o.sandbox_id FROM runtime.start_queue q JOIN runtime.operations o ON o.id=q.operation_id WHERE q.seq IN (SELECT MIN(seq) FROM runtime.start_queue GROUP BY team_id) ORDER BY q.seq LIMIT 128`,
			)
		).rows;
		for (const ticket of heads)
			await ctx.jobs.send(
				tx,
				"sandbox-op",
				{ operationId: ticket.operation_id },
				{ singletonKey: ticket.sandbox_id },
			);
	});
}
