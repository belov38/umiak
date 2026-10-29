import {
	DELETE_RETRY_LIMIT,
	loadOperation,
	TERMINAL_OPERATION_STATES,
} from "@sbx/core";
import { withTx } from "@sbx/db";
import type { WorkerCtx } from "../context.ts";
import { Fenced, FencedOut, type OperationError } from "../steps.ts";
import { SANDBOX_OPS, type SandboxOpData } from "./sandbox-op.ts";

// sandbox-op-dlq (decision 8, S6 §15.1): a job whose retries ran out. Delete
// never gives up: it is enqueued again after 60 s and counted in
// `sbx_delete_dead_letter_total` (the `sbx_delete_stuck` gauge of deletes
// active > 30 min is the health controller's, §7.9). Any other operation is
// compensated and fails with `retries_exhausted`.

export const DELETE_REQUEUE_AFTER_S = 60;

export type DeadLetterResult = "requeued" | "failed" | "skipped";

export async function handleSandboxOpDeadLetter(
	ctx: WorkerCtx,
	data: SandboxOpData,
): Promise<DeadLetterResult> {
	const op = await loadOperation(ctx.pool, data.operationId);
	if (op === null || TERMINAL_OPERATION_STATES.includes(op.state)) {
		return "skipped";
	}
	if (op.kind === "delete") {
		await withTx(ctx.pool, (tx) =>
			ctx.jobs.send(
				tx,
				"sandbox-op",
				{ operationId: op.id },
				{
					singletonKey: op.sandboxId,
					startAfter: DELETE_REQUEUE_AFTER_S,
					retryLimit: DELETE_RETRY_LIMIT,
				},
			),
		);
		ctx.log.error(
			{ operationId: op.id, sandboxId: op.sandboxId, step: op.step },
			"delete exhausted its retries; enqueued again",
		);
		ctx.metrics.inc("sbx_delete_dead_letter_total", {
			step: op.step ?? "none",
		});
		return "requeued";
	}

	const fenced = await Fenced.begin(ctx, op.id);
	if (fenced === null) return "skipped";
	const error: OperationError = {
		code: "retries_exhausted",
		message: `operation ${op.kind} exhausted its retries at step ${fenced.op.step ?? "none"}`,
		retryable: false,
	};
	const h = SANDBOX_OPS[fenced.op.kind];
	try {
		if (h) await h.compensate(ctx, fenced, error);
		else await fenced.finish("failed", error);
	} catch (e) {
		if (e instanceof FencedOut) return "skipped";
		throw e;
	}
	ctx.log.error(
		{ operationId: op.id, kind: op.kind, step: fenced.op.step },
		"operation exhausted its retries; compensated",
	);
	ctx.metrics.inc("sbx_operation_retries_exhausted_total", { kind: op.kind });
	return "failed";
}
