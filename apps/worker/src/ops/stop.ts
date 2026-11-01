import type { WorkerCtx } from "../context.ts";
import {
	MachineGone,
	MachineStateConflict,
	ownedPowerOp,
} from "../machine-prep.ts";
import type { Fenced, Step } from "../steps.ts";
import {
	currentMachine,
	machineOs,
	runOp,
	transitionSandbox,
	vmidOf,
} from "./common.ts";
import { compensateStop } from "./compensate.ts";
import type { SandboxOpHandler } from "./kind.ts";

// Stop (S6 §7.5): prepare (best effort) → shutdown → verify → finish.

export const STOP_STEPS = ["prepare", "shutdown", "verify", "finish"] as const;

const PREPARE_STOP_TIMEOUT_MS = 10_000;
/**
 * Graceful shutdown budget before a stop gives up on the guest. Windows
 * clears the pagefile at shutdown (S9 §8.1), and the first shutdown of a
 * fresh Windows clone took 118 s live: 300 s (S9 §24.9). A plain stop
 * hard-stops after it (no clean stop); the stop of a forced fork/save (S9
 * §24.8) fails `ShutdownTimeout` instead, so its snapshot is never
 * crash-consistent.
 */
export const SHUTDOWN_TIMEOUT_S = { linux: 60, windows: 300 } as const;

/** The VM still runs after shutdown and a hard stop; repeated until the deadline. */
export class StopNotConfirmed extends Error {
	readonly retryable = true;
	readonly code = "stop_not_confirmed";
	constructor(vmid: number, status: string) {
		super(`VM ${vmid} is ${status} after stop`);
		this.name = "StopNotConfirmed";
	}
}

/**
 * The guest of a forced fork/save did not shut down in time (S9 §24.8). Nothing
 * was snapshotted; the compensation hard-stops the VM and starts it again.
 * Permanent for the step engine; the client may repeat the request.
 */
export class ShutdownTimeout extends Error {
	readonly retryable = false;
	readonly operationRetryable = true;
	readonly code = "shutdown_timeout";
	constructor(vmid: number, timeoutS: number) {
		super(
			`VM ${vmid}: the guest did not shut down cleanly within ${timeoutS} s; nothing was snapshotted, the sandbox is started again`,
		);
		this.name = "ShutdownTimeout";
	}
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			p,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`no answer within ${ms} ms`)),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * prepare → shutdown → verify of the sandbox's current machine. `prefix`
 * names the steps inside another operation (forced fork/save_snapshot, S9
 * §24.8: `stop_prepare`, ...); there a shutdown timeout is `ShutdownTimeout`
 * instead of a hard stop. Progress `shutdown`: `clean`, `hard` or `already`;
 * only `clean` confirms a clean stop (`machines.clean_stop`).
 */
export function stopSteps(ctx: WorkerCtx, fenced: Fenced, prefix = ""): Step[] {
	const forced = prefix !== "";
	const machine = () => currentMachine(ctx, fenced.sandboxId);
	return [
		{
			name: `${prefix}prepare`,
			// System/PrepareStop: the agent flushes buffers and wipes secrets
			// (tmpfs; secret files on Windows). Best effort: an unavailable agent
			// does not block a stop. `secretFilesWiped` is the agent's confirmation.
			run: async () => {
				const m = await machine();
				let secretFilesWiped: boolean;
				try {
					const r = await withTimeout(
						ctx.agent.prepareStop(m.id),
						ctx.timing.prepareStopTimeoutMs ?? PREPARE_STOP_TIMEOUT_MS,
					);
					secretFilesWiped = r.secretFilesWiped;
				} catch (e) {
					ctx.log.info(
						{
							err: e instanceof Error ? e.message : String(e),
							machineId: m.id,
						},
						"prepare-stop skipped",
					);
					return { prepared: false, secretFilesWiped: false };
				}
				if (secretFilesWiped) {
					await fenced.tx(async (tx) => {
						await tx.client.query(
							"UPDATE runtime.machines SET secret_files_on_disk = false, version = version + 1 WHERE id = $1",
							[m.id],
						);
					});
				}
				return { prepared: true, secretFilesWiped };
			},
		},
		{
			name: `${prefix}shutdown`,
			run: async () => {
				const m = await machine();
				const vmid = vmidOf(m);
				await fenced.tx(async (tx) => {
					await tx.client.query(
						`UPDATE runtime.machines
						 SET state = 'stopping', state_changed_at = now(), version = version + 1
						 WHERE id = $1 AND state = 'running'`,
						[m.id],
					);
				});
				const infra = await ctx.infra.forNode(m.node_id);
				const status = await infra.status(vmid);
				if (status === "missing") {
					throw new MachineGone(m.id, `VM ${vmid} missing`);
				}
				if (status === "stopped") return { shutdown: "already" };
				const os = await machineOs(ctx.pool, m);
				const timeoutS =
					(forced ? ctx.timing.forceStopShutdownTimeoutS : undefined) ??
					ctx.timing.shutdownTimeoutS ??
					SHUTDOWN_TIMEOUT_S[os];
				await fenced.check();
				const res = await ownedPowerOp(ctx, m.id, vmid, "shutdown", () =>
					infra.shutdown(vmid, timeoutS, {
						expectedOwner: m.id,
						beforeAct: () => fenced.check(),
					}),
				);
				if (res === "timeout" && forced) {
					// No hard stop here: the compensation does it, then starts the VM again.
					throw new ShutdownTimeout(vmid, timeoutS);
				}
				if (res === "timeout") {
					await fenced.check();
					await ownedPowerOp(ctx, m.id, vmid, "stop", () =>
						infra.stop(vmid, {
							expectedOwner: m.id,
							beforeAct: () => fenced.check(),
						}),
					);
					return { shutdown: "hard" };
				}
				return { shutdown: "clean" };
			},
		},
		{
			name: `${prefix}verify`,
			run: async () => {
				const m = await machine();
				const vmid = vmidOf(m);
				const infra = await ctx.infra.forNode(m.node_id);
				let status = await infra.status(vmid);
				if (status === "missing") {
					throw new MachineGone(m.id, `VM ${vmid} missing`);
				}
				if (status !== "stopped") {
					await fenced.check();
					await ownedPowerOp(ctx, m.id, vmid, "stop", () =>
						infra.stop(vmid, {
							expectedOwner: m.id,
							beforeAct: () => fenced.check(),
						}),
					);
					status = await infra.status(vmid);
					if (status !== "stopped") throw new StopNotConfirmed(vmid, status);
					// Not a clean stop after all.
					return { shutdown: "hard" };
				}
				return undefined;
			},
		},
	];
}

/** The stop steps saw a clean guest shutdown (S6 §7.8: `powered_off` snapshots). */
export function cleanStop(fenced: Fenced): boolean {
	return fenced.op.progress.shutdown === "clean";
}

export const STOP_OP: SandboxOpHandler = {
	run: (ctx, fenced) =>
		runOp(fenced, stopSteps(ctx, fenced), async (tx) => {
			const s = await tx.client.query<{ machine_id: string }>(
				"SELECT machine_id FROM runtime.sandboxes WHERE id = $1",
				[fenced.sandboxId],
			);
			const machineId = s.rows[0]?.machine_id ?? null;
			const m = await tx.client.query(
				`UPDATE runtime.machines
				 SET state = 'stopped', power_observed = 'stopped', power_observed_at = now(),
				     clean_stop = $2, state_changed_at = now(), version = version + 1
				 WHERE id = $1 AND state IN ('running', 'stopping')`,
				[machineId, cleanStop(fenced)],
			);
			if (m.rowCount !== 1) {
				throw new MachineStateConflict(
					machineId ?? "-",
					"not stopping at finish",
				);
			}
			// The guest is off: nothing that ran on it survives. The reason
			// stays null (unknown): no reboot was seen (R32).
			await tx.client.query(
				`UPDATE runtime.commands SET status = 'lost', ended_at = now()
				 WHERE machine_id = $1 AND status IN ('starting', 'running')`,
				[machineId],
			);
			const ok = await transitionSandbox(
				tx,
				fenced.sandboxId,
				["stopping"],
				"stopped",
				{ reason: "stop_done", data: { operationId: fenced.id, machineId } },
				{ sql: "stopped_at = now()", params: [] },
			);
			if (!ok) {
				throw new Error(`sandbox ${fenced.sandboxId}: not stopping at finish`);
			}
		}),
	compensate: compensateStop,
};
