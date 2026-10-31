import type { Step } from "../steps.ts";
import {
	currentMachine,
	deliverProvision,
	runOp,
	sessionOf,
} from "./common.ts";
import { compensateNothing } from "./compensate.ts";
import type { SandboxOpHandler } from "./kind.ts";

// Reprovision (S6 §7.8, internal; the events handler enqueues it): env and
// secrets delivered again after a guest reboot or `secrets: missing`, like the
// provision step of resume. Skipped if the current boot is already
// provisioned (a late event of a boot that resume or recover handled). The
// sandbox state does not change.

export const REPROVISION_STEPS = ["provision", "finish"] as const;

export const REPROVISION_OP: SandboxOpHandler = {
	run: (ctx, fenced) => {
		const steps: Step[] = [
			{
				name: "provision",
				skipIf: async () => {
					const m = await currentMachine(ctx, fenced.sandboxId);
					const s = await sessionOf(ctx.pool, m.id);
					return (
						s?.boot_id != null &&
						s.boot_id === m.provisioned_boot_id &&
						m.secrets_generation === m.provisioned_secrets_generation
					);
				},
				run: async () => {
					const m = await currentMachine(ctx, fenced.sandboxId);
					return deliverProvision(ctx, fenced, m.id);
				},
			},
		];
		return runOp(fenced, steps, async () => {});
	},
	compensate: compensateNothing,
};
