import type { OperationKind } from "@sbx/core";
import type { WorkerCtx } from "../context.ts";
import { operationErrorOf } from "../ops/common.ts";
import { CREATE_OP } from "../ops/create.ts";
import { DELETE_OP } from "../ops/delete.ts";
import type { SandboxOpHandler } from "../ops/kind.ts";
import { RECOVER_OP } from "../ops/recover.ts";
import { REPROVISION_OP } from "../ops/reprovision.ts";
import { RESUME_OP } from "../ops/resume.ts";
import { STOP_OP } from "../ops/stop.ts";
import { isRetryable } from "../ports.ts";
import { DeadlineExceeded, Fenced, FencedOut } from "../steps.ts";

// sandbox-op queue (S6 §7.1, §15.1): data {operationId}, singletonKey
// sandboxId. The job is only a trigger; the operations row is the truth.

export interface SandboxOpData {
	operationId: string;
}

/** Operation kinds and their handlers. Task 10b adds fork and save_snapshot. */
export const SANDBOX_OPS: Partial<Record<OperationKind, SandboxOpHandler>> = {
	create: CREATE_OP,
	delete: DELETE_OP,
	stop: STOP_OP,
	resume: RESUME_OP,
	recover: RECOVER_OP,
	reprovision: REPROVISION_OP,
};

/** `skipped`: unknown, terminal, or a child waiting for its parent. */
export type SandboxOpResult = "skipped" | "succeeded" | "failed" | "fenced_out";

function handlerOf(kind: OperationKind): SandboxOpHandler {
	const h = SANDBOX_OPS[kind];
	if (h === undefined) {
		throw new Error(`sandbox-op: no handler for operation kind ${kind}`);
	}
	return h;
}

function fencedOut(
	ctx: WorkerCtx,
	fenced: Fenced,
	e: FencedOut,
): SandboxOpResult {
	ctx.log.info(
		{ operationId: fenced.id, kind: fenced.op.kind, err: e.message },
		"sandbox-op fenced out",
	);
	ctx.metrics.inc("sbx_fenced_out_total", {
		queue: "sandbox-op",
		kind: fenced.op.kind,
	});
	return "fenced_out";
}

/**
 * Runs an operation (S6 §7.1 p. 2–3):
 * - `Fenced.begin` takes it (`attempt + 1`); null → nothing to do;
 * - deadline passed → no new steps: compensation, `failed deadline_exceeded`;
 * - the kind's steps; a retryable error is thrown (pg-boss repeats the job);
 * - a permanent error → the kind's `retry` (create: pool claim), else
 *   compensation and `failed` with the error code; the job ends normally;
 * - `FencedOut` (another attempt or a delete took over) → exit quietly.
 * Delete never fails: every error of it is thrown.
 */
export async function handleSandboxOp(
	ctx: WorkerCtx,
	data: SandboxOpData,
): Promise<SandboxOpResult> {
	const fenced = await Fenced.begin(ctx, data.operationId);
	if (fenced === null) return "skipped";
	const h = handlerOf(fenced.op.kind);
	try {
		for (;;) {
			try {
				if (fenced.deadlinePassed()) throw new DeadlineExceeded(fenced.id);
				await h.run(ctx, fenced);
				return "succeeded";
			} catch (e) {
				if (e instanceof FencedOut || isRetryable(e) || h.neverFails) throw e;
				if (h.retry && (await h.retry(ctx, fenced, e))) continue;
				const error = operationErrorOf(e);
				ctx.log.warn(
					{
						operationId: fenced.id,
						kind: fenced.op.kind,
						step: fenced.op.step,
						code: error.code,
						err: error.message,
					},
					"sandbox operation failed; compensating",
				);
				await h.compensate(ctx, fenced, error);
				ctx.metrics.inc("sbx_operation_failed_total", {
					kind: fenced.op.kind,
					code: error.code,
				});
				return "failed";
			}
		}
	} catch (e) {
		if (e instanceof FencedOut) return fencedOut(ctx, fenced, e);
		throw e;
	}
}
