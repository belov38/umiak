import type { Tx } from "@sbx/db";
import type { WorkerCtx } from "../context.ts";
import { MachineStateConflict } from "../machine-prep.ts";
import type { Fenced, Step } from "../steps.ts";
import {
	bootTimeoutMs,
	currentMachine,
	deliverProvision,
	runOp,
	startMachine,
	transitionSandbox,
	vmidOf,
	waitAgentSession,
} from "./common.ts";
import { compensateStart } from "./compensate.ts";
import type { SandboxOpHandler } from "./kind.ts";

// Resume (S6 §7.6): resize → start → wait_agent → provision → finish.

export const RESUME_STEPS = [
	"resize",
	"start",
	"wait_agent",
	"provision",
	"finish",
] as const;

/**
 * `wait_agent` (resume and recover): a connected session on a boot other
 * than the provisioned one and other than `alsoNot` (the boot seen before a
 * reset). Returns progress `{bootId}`.
 */
export function waitAgentStep(
	ctx: WorkerCtx,
	fenced: Fenced,
	alsoNot: () => string | null = () => null,
): Step {
	return {
		name: "wait_agent",
		run: async () => {
			const m = await currentMachine(ctx, fenced.sandboxId);
			const bootId = await waitAgentSession(
				ctx,
				fenced,
				m.id,
				await bootTimeoutMs(ctx, m.template_build_id),
				[m.provisioned_boot_id, alsoNot()],
			);
			return { bootId };
		},
	};
}

/** `provision`: env and secrets delivered again on the new boot (S3 §8.1). */
export function provisionStep(ctx: WorkerCtx, fenced: Fenced): Step {
	return {
		name: "provision",
		run: async () => {
			const m = await currentMachine(ctx, fenced.sandboxId);
			return deliverProvision(ctx, fenced, m.id);
		},
	};
}

/**
 * `finish` of resume and recover: machine `starting → running`, sandbox
 * `starting → ready`, `deadline_at = now + ttl` (the service already stored a
 * TTL passed with the request), health ok.
 */
export async function finishStart(
	tx: Tx,
	sandboxId: string,
	operationId: string,
	reason: string,
): Promise<void> {
	const s = await tx.client.query<{ machine_id: string | null }>(
		"SELECT machine_id FROM runtime.sandboxes WHERE id = $1",
		[sandboxId],
	);
	const machineId = s.rows[0]?.machine_id ?? null;
	const m = await tx.client.query(
		`UPDATE runtime.machines
		 SET state = 'running', power_observed = 'running', power_observed_at = now(),
		     state_changed_at = now(), version = version + 1
		 WHERE id = $1 AND state = 'starting'`,
		[machineId],
	);
	if (m.rowCount !== 1) {
		throw new MachineStateConflict(machineId ?? "-", "not starting at finish");
	}
	const ok = await transitionSandbox(
		tx,
		sandboxId,
		["starting"],
		"ready",
		{ reason, data: { operationId, machineId } },
		{
			sql: `deadline_at = CASE WHEN s.ttl_seconds IS NULL THEN NULL
			                         ELSE now() + make_interval(secs => s.ttl_seconds) END,
			      health = 'ok', health_reason = NULL, degraded_since = NULL,
			      stop_reason = NULL, error_code = NULL, error_message = NULL`,
			params: [],
		},
	);
	if (!ok) throw new Error(`sandbox ${sandboxId}: not starting at finish`);
}

function resumeSteps(ctx: WorkerCtx, fenced: Fenced): Step[] {
	const machine = () => currentMachine(ctx, fenced.sandboxId);
	return [
		{
			name: "resize",
			// The service wrote a new size to the machine row; the VM config
			// may still have the old one (also after a failed earlier resume).
			// PUT config only while the VM is off.
			skipIf: async () => {
				const m = await machine();
				if (m.state !== "stopped") return true;
				const infra = await ctx.infra.forNode(m.node_id);
				const cur = await infra.vmSize(vmidOf(m));
				return cur.vcpu === m.vcpu && cur.memoryMb === m.memory_mb;
			},
			run: async () => {
				const m = await machine();
				const infra = await ctx.infra.forNode(m.node_id);
				await fenced.check();
				await infra.configure(vmidOf(m), {
					vcpu: m.vcpu,
					memoryMb: m.memory_mb,
				});
				return { resized: { vcpu: m.vcpu, memoryMb: m.memory_mb } };
			},
		},
		{
			name: "start",
			run: async () => {
				const m = await machine();
				if (m.state !== "stopped" && m.state !== "starting") {
					throw new MachineStateConflict(m.id, `state ${m.state}`);
				}
				await startMachine(ctx, fenced, m);
			},
		},
		waitAgentStep(ctx, fenced),
		provisionStep(ctx, fenced),
	];
}

export const RESUME_OP: SandboxOpHandler = {
	run: (ctx, fenced) =>
		runOp(fenced, resumeSteps(ctx, fenced), (tx) =>
			finishStart(tx, fenced.sandboxId, fenced.id, "resume_done"),
		),
	compensate: (ctx, fenced, error) =>
		compensateStart(ctx, fenced, error, "resume_failed"),
};
