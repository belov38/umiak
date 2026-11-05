import type { WorkerCtx } from "../context.ts";
import type { Fenced, OperationError } from "../steps.ts";

/**
 * One operation kind of the `sandbox-op` dispatcher (S6 §7.1). The dispatcher
 * takes the fence, checks the deadline, calls `run`, and maps errors:
 * `FencedOut` → exit quietly; retryable → rethrow (pg-boss repeats the job);
 * permanent or deadline → `compensate`.
 */
export interface SandboxOpHandler {
	/** Runs the remaining steps and ends the operation `succeeded`. */
	run(ctx: WorkerCtx, fenced: Fenced): Promise<void>;
	/** Idempotently undoes infrastructure and ends the operation with the error. */
	compensate(
		ctx: WorkerCtx,
		fenced: Fenced,
		error: OperationError,
	): Promise<void>;
	/** Never fails or compensates: every error is retried (delete, §15.1). */
	neverFails?: boolean;
}
