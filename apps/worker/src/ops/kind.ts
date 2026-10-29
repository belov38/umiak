import type { WorkerCtx } from "../context.ts";
import type { Fenced, OperationError } from "../steps.ts";

/**
 * One operation kind of the `sandbox-op` dispatcher (S6 §7.1). The dispatcher
 * takes the fence, checks the deadline, calls `run`, and maps errors:
 * `FencedOut` → exit quietly; retryable → rethrow (pg-boss repeats the job);
 * permanent or deadline → `retry` (if any) then `compensate`.
 */
export interface SandboxOpHandler {
	/** Runs the remaining steps and ends the operation `succeeded`. */
	run(ctx: WorkerCtx, fenced: Fenced): Promise<void>;
	/**
	 * A permanent error or the deadline: a last chance to go on (create: one
	 * pool claim retry, §7.3). True = the operation was reset under the fence
	 * and `run` starts again.
	 */
	retry?(ctx: WorkerCtx, fenced: Fenced, err: unknown): Promise<boolean>;
	/**
	 * Undoes what the operation left behind (infrastructure first), then ends
	 * it `failed` with `error` in one fenced transaction. Also called by the
	 * dead-letter handler with `retries_exhausted`. Must be idempotent.
	 */
	compensate(
		ctx: WorkerCtx,
		fenced: Fenced,
		error: OperationError,
	): Promise<void>;
	/** Never fails or compensates: every error is retried (delete, §15.1). */
	neverFails?: boolean;
}
