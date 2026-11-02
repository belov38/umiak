import type { OperationKind } from "@umiak/core";
import type { WorkerCtx } from "../context.ts";
import { operationErrorOf } from "../ops/common.ts";
import { markCompensating, pendingCompensation } from "../ops/compensate.ts";
import { CREATE_OP } from "../ops/create.ts";
import { DELETE_OP } from "../ops/delete.ts";
import { FORK_OP } from "../ops/fork.ts";
import type { SandboxOpHandler } from "../ops/kind.ts";
import { RECOVER_OP } from "../ops/recover.ts";
import { REPROVISION_OP } from "../ops/reprovision.ts";
import { RESUME_OP } from "../ops/resume.ts";
import { SAVE_SNAPSHOT_OP } from "../ops/save-snapshot.ts";
import { STOP_OP } from "../ops/stop.ts";
import { isPermanent } from "../ports.ts";
import {
	DeadlineExceeded,
	Fenced,
	FencedOut,
	type OperationError,
} from "../steps.ts";
import { ensureMachineProvision } from "./machine-events.ts";

// sandbox-op queue (S6 §7.1, §15.1): data {operationId}, singletonKey
// sandboxId. The job is only a trigger; the operations row is the truth.

export interface SandboxOpData {
	operationId: string;
}

/** Operation kinds and their handlers. */
export const SANDBOX_OPS: Partial<Record<OperationKind, SandboxOpHandler>> = {
	create: CREATE_OP,
	delete: DELETE_OP,
	stop: STOP_OP,
	resume: RESUME_OP,
	recover: RECOVER_OP,
	reprovision: REPROVISION_OP,
	fork: FORK_OP,
	save_snapshot: SAVE_SNAPSHOT_OP,
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
	ctx.metrics.inc("umiak_fenced_out_total", {
		queue: "sandbox-op",
		kind: fenced.op.kind,
	});
	return "fenced_out";
}

/**
 * Runs an operation (S6 §7.1 p. 2–3):
 * - `Fenced.begin` takes it (`attempt + 1`); null → nothing to do;
 * - a compensation an earlier attempt started (`progress.compensating`) is
 *   finished first, with the original error;
 * - deadline passed → no new steps: compensation, `failed deadline_exceeded`;
 * - the kind's steps. Errors are transient by default and thrown (pg-boss
 *   repeats the job; the deadline bounds the repeats). Only an error that
 *   says `retryable === false` (domain errors: agent rejection, lost machine,
 *   boot timeout, invalid state, deadline …) is permanent: the kind's `retry`
 *   (create: pool claim), else compensation and `failed` with its code;
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
		const pending = pendingCompensation(fenced.op);
		if (pending !== null && !h.neverFails) {
			return await compensate(ctx, fenced, h, pending);
		}
		for (;;) {
			try {
				if (fenced.deadlinePassed()) throw new DeadlineExceeded(fenced.id);
				await h.run(ctx, fenced);
				return "succeeded";
			} catch (e) {
				if (e instanceof FencedOut || h.neverFails || !isPermanent(e)) throw e;
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
				// Durable marker: a crash inside compensation resumes it, not the steps.
				await markCompensating(fenced, error);
				return await compensate(ctx, fenced, h, error);
			}
		}
	} catch (e) {
		if (e instanceof FencedOut) return fencedOut(ctx, fenced, e);
		throw e;
	} finally {
		// A pending-secrets event during fork/save cannot start another operation
		// until this one has finished. The generations retain that request.
		try {
			const s = await ctx.pool.query<{ machine_id: string | null }>(
				"SELECT machine_id FROM runtime.sandboxes WHERE id = $1",
				[fenced.sandboxId],
			);
			const machineId = s.rows[0]?.machine_id;
			if (machineId) await ensureMachineProvision(ctx, machineId);
		} catch {
			ctx.log.warn(
				{ sandboxId: fenced.sandboxId },
				"deferred secret delivery check failed; reconcile will retry",
			);
		}
	}
}

async function compensate(
	ctx: WorkerCtx,
	fenced: Fenced,
	h: SandboxOpHandler,
	error: OperationError,
): Promise<SandboxOpResult> {
	await h.compensate(ctx, fenced, error);
	ctx.metrics.inc("umiak_operation_failed_total", {
		kind: fenced.op.kind,
		code: error.code,
	});
	return "failed";
}
