import type { WorkerCtx } from "../context.ts";
import { MachineGone, ownedPowerOp } from "../machine-prep.ts";
import type { Fenced, Step } from "../steps.ts";
import {
	currentMachine,
	markPowered,
	runOp,
	sessionOf,
	startMachine,
	vmidOf,
} from "./common.ts";
import { compensateStart } from "./compensate.ts";
import type { SandboxOpHandler } from "./kind.ts";
import {
	finishStart,
	provisionStep,
	resizeStep,
	waitAgentStep,
} from "./resume.ts";

// Recover (S6 §7.8): resize → reset (hard power cycle) → wait_agent →
// provision → finish, like resume. Machines that never finished a claim
// (allocating … claiming) have no recover path.
//
// `resize` matters after a failed resume that changed the size: the service
// admits recover with the machine row's memory_mb, which already holds the
// new size, while the VM config may still have the old one. A stopped VM is
// configured to the row first, so the RAM it boots with is the RAM counted.

export const RECOVER_STEPS = [
	"resize",
	"reset",
	"wait_agent",
	"provision",
	"finish",
] as const;

/** States of a working machine: `reset` (§6.2) from these, `start` from `stopped`. */
const RESETTABLE = ["running", "stopping", "starting"];

/** The machine is in a state recover cannot work from. Permanent; the machine is left alone. */
export class RecoverUnsupported extends Error {
	readonly retryable = false;
	readonly code = "recover_unsupported";
	constructor(machineId: string, state: string) {
		super(`machine ${machineId} is ${state}: no recover path`);
		this.name = "RecoverUnsupported";
	}
}

function recoverSteps(ctx: WorkerCtx, fenced: Fenced): Step[] {
	const machine = () => currentMachine(ctx, fenced.sandboxId);
	return [
		resizeStep(ctx, fenced),
		{
			name: "reset",
			run: async () => {
				const m = await machine();
				if (!RESETTABLE.includes(m.state) && m.state !== "stopped") {
					throw new RecoverUnsupported(m.id, m.state);
				}
				const vmid = vmidOf(m);
				// The boot before the reset: its session may still look connected.
				const before = (await sessionOf(ctx.pool, m.id))?.boot_id ?? null;
				const infra = await ctx.infra.forNode(m.node_id);
				if (RESETTABLE.includes(m.state)) {
					// running|stopping|starting -> starting; it stays in powered RAM.
					await fenced.tx(async (tx) => {
						await tx.client.query(
							`UPDATE runtime.machines
							 SET state = 'starting', state_changed_at = now(), version = version + 1
							 WHERE id = $1 AND state = ANY($2::text[])`,
							[m.id, RESETTABLE],
						);
					});
					const status = await infra.status(vmid);
					if (status === "missing") {
						throw new MachineGone(m.id, `VM ${vmid} missing`);
					}
					await fenced.check();
					if (status !== "stopped")
						await ownedPowerOp(ctx, m.id, vmid, "stop", () =>
							infra.stop(vmid, {
								expectedOwner: m.id,
								beforeAct: () => fenced.check(),
							}),
						);
					await fenced.check();
					await ownedPowerOp(ctx, m.id, vmid, "start", () =>
						infra.start(vmid, {
							expectedOwner: m.id,
							beforeAct: () => fenced.check(),
						}),
					);
					await markPowered(fenced, m.id);
				} else {
					const status = await infra.status(vmid);
					if (status === "running" || status === "paused") {
						await fenced.check();
						await ownedPowerOp(ctx, m.id, vmid, "stop", () =>
							infra.stop(vmid, {
								expectedOwner: m.id,
								beforeAct: () => fenced.check(),
							}),
						);
					}
					await startMachine(ctx, fenced, m);
				}
				return { resetFromBootId: before };
			},
		},
		waitAgentStep(ctx, fenced, () => {
			const b = fenced.op.progress.resetFromBootId;
			return typeof b === "string" ? b : null;
		}),
		provisionStep(ctx, fenced),
	];
}

export const RECOVER_OP: SandboxOpHandler = {
	run: (ctx, fenced) =>
		runOp(fenced, recoverSteps(ctx, fenced), (tx) =>
			finishStart(tx, fenced.sandboxId, fenced.id, "recover_done"),
		),
	compensate: (ctx, fenced, error) =>
		// §6.1: starting -> error is `resume_failed` for recover too.
		compensateStart(ctx, fenced, error, "resume_failed"),
};
