import type { Operation } from "@sbx/core";
import { DELETE_RETRY_LIMIT } from "@sbx/core";
import type { Tx } from "@sbx/db";
import type { WorkerCtx } from "../context.ts";
import type { MachineRow } from "../db.ts";
import type { Fenced, OperationError } from "../steps.ts";
import { currentMachine, hardStop, sandboxToError } from "./common.ts";

// Compensation of failed operations (S6 §7.1, §7.3, §7.5, §7.6, §15.1). Each
// function undoes infrastructure first (outside a transaction), then ends the
// operation `failed` and moves rows in one fenced transaction, so a repeat
// after a crash does the same again.

/**
 * Records `progress.compensating = <error code>` (and the message) under the
 * fence before any compensation work, so a crash inside compensation makes
 * the next attempt finish it with the original error instead of running the
 * steps again.
 */
export async function markCompensating(
	fenced: Fenced,
	error: OperationError,
): Promise<void> {
	await fenced.tx(async (tx) => {
		await tx.client.query(
			`UPDATE runtime.operations
			 SET progress = progress || $3::jsonb, version = version + 1
			 WHERE id = $1 AND attempt = $2 AND state = 'running'`,
			[
				fenced.id,
				fenced.attempt,
				JSON.stringify({
					compensating: error.code,
					compensatingMessage: error.message,
				}),
			],
		);
	});
	await fenced.check();
}

/** The error of a compensation an earlier attempt started, or null. */
export function pendingCompensation(op: Operation): OperationError | null {
	const code = op.progress.compensating;
	if (typeof code !== "string") return null;
	const message = op.progress.compensatingMessage;
	return {
		code,
		message: typeof message === "string" ? message : code,
		retryable: false,
	};
}

/** `machine_lost` (§6.1) wins over the operation's own sandbox error code. */
export function sandboxErrorCode(
	fallback: string,
	error: OperationError,
): string {
	return error.code === "machine_lost" ? "machine_lost" : fallback;
}

function errorData(
	fenced: Fenced,
	error: OperationError,
): Record<string, unknown> {
	return {
		operationId: fenced.id,
		kind: fenced.op.kind,
		errorCode: error.code,
	};
}

/**
 * Every machine of the sandbox that is not being deleted yet → `deleting`
 * with a `machine-op delete` job (unlimited retries). A tenant touched it, so
 * it never goes back to the pool (§6.4 p. 2).
 */
export async function deleteSandboxMachines(
	ctx: WorkerCtx,
	tx: Tx,
	sandboxId: string,
	code: string,
	detail: string,
): Promise<string[]> {
	const r = await tx.client.query<{ id: string }>(
		`UPDATE runtime.machines
		 SET state = 'deleting', error_code = COALESCE(error_code, $2),
		     error_detail = COALESCE(error_detail, $3), state_changed_at = now(), version = version + 1
		 WHERE sandbox_id = $1 AND state NOT IN ('deleting', 'deleted')
		 RETURNING id`,
		[sandboxId, code, detail],
	);
	for (const { id } of r.rows) await sendMachineDelete(ctx, tx, id);
	return r.rows.map((x) => x.id);
}

export async function sendMachineDelete(
	ctx: WorkerCtx,
	tx: Tx,
	machineId: string,
): Promise<void> {
	await ctx.jobs.send(
		tx,
		"machine-op",
		{ machineId, action: "delete" },
		{ singletonKey: machineId, retryLimit: DELETE_RETRY_LIMIT },
	);
}

/** Create (§7.3): machines → `deleting`, sandbox `creating → error` (`create_failed`). */
export async function compensateCreate(
	ctx: WorkerCtx,
	fenced: Fenced,
	error: OperationError,
): Promise<void> {
	const code = sandboxErrorCode("create_failed", error);
	await fenced.finish("failed", error, async (tx) => {
		await deleteSandboxMachines(
			ctx,
			tx,
			fenced.sandboxId,
			error.code,
			error.message,
		);
		await sandboxToError(
			tx,
			fenced.sandboxId,
			["creating"],
			code,
			error.message,
			errorData(fenced, error),
		);
	});
}

/** A machine whose VM is gone (§6.1 `machine_lost`): `failed`, kept for the error sandbox. */
async function markLost(
	tx: Tx,
	machineId: string,
	detail: string,
): Promise<void> {
	await tx.client.query(
		`UPDATE runtime.machines
		 SET state = 'failed', error_code = 'machine_lost', error_detail = $2,
		     state_changed_at = now(), version = version + 1
		 WHERE id = $1 AND state NOT IN ('failed', 'deleting', 'deleted')`,
		[machineId, detail],
	);
}

async function machineOrNull(
	ctx: WorkerCtx,
	sandboxId: string,
): Promise<MachineRow | null> {
	try {
		return await currentMachine(ctx, sandboxId);
	} catch {
		return null;
	}
}

/** Stop (§7.5, §6.1): sandbox `stopping → error` (`stop_failed`). The machine stays as it is. */
export async function compensateStop(
	ctx: WorkerCtx,
	fenced: Fenced,
	error: OperationError,
): Promise<void> {
	const m = await machineOrNull(ctx, fenced.sandboxId);
	const code = sandboxErrorCode("stop_failed", error);
	await fenced.finish("failed", error, async (tx) => {
		if (m !== null && code === "machine_lost")
			await markLost(tx, m.id, error.message);
		await sandboxToError(
			tx,
			fenced.sandboxId,
			["stopping"],
			code,
			error.message,
			errorData(fenced, error),
		);
	});
}

/**
 * Resume and recover (§7.6): S1 hard stop, machine → `stopped` with
 * `power_observed = stopped`, sandbox `starting → error` with `code`. The
 * disks stay, so resume can be tried again. A lost VM marks the machine
 * `failed` instead; `recover_unsupported` leaves the machine alone.
 */
export async function compensateStart(
	ctx: WorkerCtx,
	fenced: Fenced,
	error: OperationError,
	fallback: "resume_failed",
): Promise<void> {
	const m = await machineOrNull(ctx, fenced.sandboxId);
	const untouched = error.code === "recover_unsupported";
	const code = untouched ? error.code : sandboxErrorCode(fallback, error);
	if (m !== null && !untouched && code !== "machine_lost") {
		await fenced.check();
		await hardStop(ctx, m);
	}
	await fenced.finish("failed", error, async (tx) => {
		if (m !== null && !untouched) {
			if (code === "machine_lost") await markLost(tx, m.id, error.message);
			else {
				await tx.client.query(
					`UPDATE runtime.machines
					 SET state = 'stopped', power_observed = 'stopped', power_observed_at = now(),
					     state_changed_at = CASE WHEN state <> 'stopped' THEN now() ELSE state_changed_at END,
					     version = version + 1
					 WHERE id = $1 AND state IN ('starting', 'stopped', 'running', 'stopping')`,
					[m.id],
				);
			}
		}
		await sandboxToError(
			tx,
			fenced.sandboxId,
			["starting"],
			code,
			error.message,
			errorData(fenced, error),
		);
	});
}

/** Operations that change no sandbox state (reprovision): only `failed`. */
export async function compensateNothing(
	_ctx: WorkerCtx,
	fenced: Fenced,
	error: OperationError,
): Promise<void> {
	await fenced.finish("failed", error);
}
