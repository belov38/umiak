import { forceStopRestartMs } from "@sbx/core";
import { retryOnVmLock } from "@sbx/pve";
import type { WorkerCtx } from "../context.ts";
import { errFields } from "../log.ts";
import { MachineStateConflict } from "../machine-prep.ts";
import { type Fenced, FencedOut, type Step } from "../steps.ts";
import {
	bootTimeoutMs,
	currentMachine,
	deliverProvision,
	hardStop,
	machineOs,
	markMachineLost,
	operationErrorOf,
	sandboxToError,
	startMachine,
	waitAgentSession,
} from "./common.ts";
import { sandboxErrorCode } from "./compensate.ts";
import { fencedVmLockSleep, mergeProgress } from "./snapshot-step.ts";
import { stopSteps } from "./stop.ts";

// Forced fork and save_snapshot of a running Windows sandbox (S9 §24.8).
// Windows disks are snapshotted only from a stopped VM, so with
// `request.forceStop` (the API sets it only for a `ready` Windows source)
// the operation runs:
//
//   stop_prepare → stop_shutdown → stop_verify → stopped   (the stop path, §7.5)
//   snapshot                                               (powered_off)
//   restart → restart_agent → restart_provision            (the resume path, §7.6)
//
// and then its own finish (fork: the hand-off to the target). The sandbox
// stays `ready` with this operation active; its machine goes
// running → stopping → stopped → starting → running. A failed restart does
// not fail the operation once the snapshot is done: the VM is hard-stopped,
// the machine `stopped`, the sandbox `ready → error` (`resume_failed`; the
// user resumes it), and progress records `sourceRestarted: false` with
// `restartError`. A failure before the snapshot is done compensates as
// usual, and the compensation starts the source again (`restartForcedSource`).
//
// Progress keys (the API's Operation.forceStop): `forceStopped`,
// `sourceRestarted`, `restartError {code, message}`.

/** The operation stops and restarts its source (`request.forceStop`). */
export function isForced(fenced: Fenced): boolean {
	return fenced.op.request.forceStop === true;
}

/** stop_prepare, stop_shutdown, stop_verify, then the machine `stopped`. */
export function forceStopSteps(ctx: WorkerCtx, fenced: Fenced): Step[] {
	return [
		...stopSteps(ctx, fenced, "stop_"),
		{
			name: "stopped",
			run: async () => {
				const m = await currentMachine(ctx, fenced.sandboxId);
				await fenced.tx(async (tx) => {
					const r = await tx.client.query(
						`UPDATE runtime.machines
						 SET state = 'stopped', power_observed = 'stopped', power_observed_at = now(),
						     state_changed_at = now(), version = version + 1
						 WHERE id = $1 AND state IN ('running', 'stopping')`,
						[m.id],
					);
					if (r.rowCount !== 1 && m.state !== "stopped") {
						throw new MachineStateConflict(m.id, `state ${m.state}`);
					}
					// As stop: nothing that ran on the guest survives.
					await tx.client.query(
						`UPDATE runtime.commands SET status = 'lost', ended_at = now()
						 WHERE machine_id = $1 AND status IN ('starting', 'running')`,
						[m.id],
					);
				});
				return { forceStopped: true };
			},
		},
	];
}

/**
 * After the snapshot: the deadline becomes at least now + the resume
 * deadline, so the restart is not cut short (and cannot fail the operation
 * through `deadline_exceeded`).
 */
export async function extendDeadlineForRestart(
	ctx: WorkerCtx,
	fenced: Fenced,
): Promise<void> {
	const m = await currentMachine(ctx, fenced.sandboxId);
	const ms = forceStopRestartMs(await machineOs(ctx.pool, m));
	await fenced.tx(async (tx) => {
		await tx.client.query(
			`UPDATE runtime.operations
			 SET deadline_at = GREATEST(deadline_at, now() + make_interval(secs => $3::double precision / 1000)),
			     version = version + 1
			 WHERE id = $1 AND attempt = $2 AND state = 'running'`,
			[fenced.id, fenced.attempt, ms],
		);
	});
	await fenced.check();
}

/** The restart failed earlier (later restart steps are skipped). */
function restartFailedBefore(fenced: Fenced): boolean {
	return fenced.op.progress.sourceRestarted === false;
}

/**
 * The source could not be started again: hard stop (best effort), machine
 * `stopped` (or `failed` when the VM is gone), sandbox `ready → error`, and
 * the outcome in progress. The snapshot is not touched.
 */
async function restartFailed(
	ctx: WorkerCtx,
	fenced: Fenced,
	e: unknown,
): Promise<void> {
	const error = operationErrorOf(e);
	const code = sandboxErrorCode("resume_failed", error);
	ctx.log.warn(
		{ ...errFields(e), operationId: fenced.id, sandboxId: fenced.sandboxId },
		"restart after the forced snapshot failed",
	);
	const m = await currentMachine(ctx, fenced.sandboxId).catch(() => null);
	let stopped = false;
	if (m !== null && code !== "machine_lost") {
		try {
			await hardStop(ctx, m, fenced);
			stopped = true;
		} catch (stopErr) {
			if (stopErr instanceof FencedOut) throw stopErr;
			ctx.log.warn(
				{ ...errFields(stopErr), machineId: m.id },
				"hard stop after the failed restart failed; reconcile corrects the power state",
			);
		}
	}
	const message = `the restart after the forced snapshot failed: ${error.message}`;
	await fenced.tx(async (tx) => {
		if (m !== null) {
			if (code === "machine_lost") {
				await markMachineLost(tx, m.id, error.message);
			} else {
				await tx.client.query(
					`UPDATE runtime.machines
					 SET state = 'stopped', power_observed = $2, power_observed_at = now(),
					     state_changed_at = CASE WHEN state <> 'stopped' THEN now() ELSE state_changed_at END,
					     version = version + 1
					 WHERE id = $1 AND state IN ('starting', 'stopped', 'running', 'stopping')`,
					[m.id, stopped ? "stopped" : "unknown"],
				);
			}
		}
		await sandboxToError(tx, fenced.sandboxId, ["ready"], code, message, {
			operationId: fenced.id,
			kind: fenced.op.kind,
			errorCode: error.code,
			reason: "force_stop_restart",
		});
		await tx.client.query(
			`UPDATE runtime.operations SET progress = progress || $3::jsonb, version = version + 1
			 WHERE id = $1 AND attempt = $2 AND state = 'running'`,
			[
				fenced.id,
				fenced.attempt,
				JSON.stringify({
					sourceRestarted: false,
					restartError: { code: error.code, message: error.message },
				}),
			],
		);
	});
	await fenced.check();
}

/** A restart step: skipped after a failed restart; its errors end the restart, not the operation. */
function restartStep(
	ctx: WorkerCtx,
	fenced: Fenced,
	name: string,
	run: () => Promise<Record<string, unknown> | undefined>,
): Step {
	return {
		name,
		skipIf: async () => restartFailedBefore(fenced),
		run: async () => {
			try {
				return await run();
			} catch (e) {
				if (e instanceof FencedOut) throw e;
				await restartFailed(ctx, fenced, e);
				return undefined;
			}
		},
	};
}

/** S1 start through the start gate; the qmeventd VM lock after the stop is retried. */
async function startSource(ctx: WorkerCtx, fenced: Fenced): Promise<void> {
	const m = await currentMachine(ctx, fenced.sandboxId);
	if (m.state !== "stopped" && m.state !== "starting") {
		throw new MachineStateConflict(m.id, `state ${m.state}`);
	}
	await retryOnVmLock(() => startMachine(ctx, fenced, m), {
		sleep: fencedVmLockSleep(ctx, fenced),
	});
}

/** The agent on a new boot (not the provisioned one). */
async function waitSourceAgent(
	ctx: WorkerCtx,
	fenced: Fenced,
): Promise<string> {
	const m = await currentMachine(ctx, fenced.sandboxId);
	return waitAgentSession(
		ctx,
		fenced,
		m.id,
		await bootTimeoutMs(ctx, m.template_build_id),
		[m.provisioned_boot_id],
	);
}

/** Env and secrets on the new boot, then the machine `starting → running`. */
async function provisionSource(ctx: WorkerCtx, fenced: Fenced): Promise<void> {
	const m = await currentMachine(ctx, fenced.sandboxId);
	await deliverProvision(ctx, fenced, m.id, "restart_provision");
	await fenced.tx(async (tx) => {
		const r = await tx.client.query(
			`UPDATE runtime.machines
			 SET state = 'running', power_observed = 'running', power_observed_at = now(),
			     state_changed_at = now(), version = version + 1
			 WHERE id = $1 AND state = 'starting'`,
			[m.id],
		);
		if (r.rowCount !== 1) {
			throw new MachineStateConflict(m.id, "not starting after the restart");
		}
	});
}

/** restart → restart_agent → restart_provision (after the snapshot). */
export function restartSteps(ctx: WorkerCtx, fenced: Fenced): Step[] {
	return [
		restartStep(ctx, fenced, "restart", async () => {
			await startSource(ctx, fenced);
			return undefined;
		}),
		restartStep(ctx, fenced, "restart_agent", async () => ({
			restartBootId: await waitSourceAgent(ctx, fenced),
		})),
		restartStep(ctx, fenced, "restart_provision", async () => {
			await provisionSource(ctx, fenced);
			return { sourceRestarted: true };
		}),
	];
}

/**
 * Compensation of a forced operation that failed before its restart: the
 * source is started again (a machine left `stopping` is hard-stopped first);
 * a failure is recorded as in the steps. No-op when the restart already ran
 * or the machine was never stopped.
 */
export async function restartForcedSource(
	ctx: WorkerCtx,
	fenced: Fenced,
): Promise<void> {
	if (!isForced(fenced)) return;
	await fenced.check();
	if (typeof fenced.op.progress.sourceRestarted === "boolean") return;
	try {
		const m = await currentMachine(ctx, fenced.sandboxId);
		if (m.state === "running") return;
		await extendDeadlineForRestart(ctx, fenced);
		if (m.state === "stopping") {
			await hardStop(ctx, m, fenced);
			await fenced.tx(async (tx) => {
				await tx.client.query(
					`UPDATE runtime.machines
					 SET state = 'stopped', power_observed = 'stopped', power_observed_at = now(),
					     state_changed_at = now(), version = version + 1
					 WHERE id = $1 AND state = 'stopping'`,
					[m.id],
				);
			});
		}
		await startSource(ctx, fenced);
		await waitSourceAgent(ctx, fenced);
		await provisionSource(ctx, fenced);
		await mergeProgress(fenced, { sourceRestarted: true });
	} catch (e) {
		if (e instanceof FencedOut) throw e;
		await restartFailed(ctx, fenced, e);
	}
}
