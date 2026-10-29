import {
	admitCold,
	claimWarm,
	insertSandboxEvent,
	operationDeadline,
	type Placement,
	SbxError,
} from "@sbx/core";
import type { Tx } from "@sbx/db";
import type { WorkerCtx } from "../context.ts";
import { AgentRejected } from "../ports.ts";
import { DeadlineExceeded, type Fenced } from "../steps.ts";
import { loadSandboxRow } from "./common.ts";
import { sendMachineDelete } from "./compensate.ts";

// Pool claim retry (S6 §7.3): a claim the agent rejected, or one that did not
// finish before the deadline, moves the machine to `deleting` (a tenant
// touched it). If that machine came from the pool, the create tries once more:
// another warm machine of the pair, else (unless `failFast`) a cold machine.
// Everything happens in one fenced transaction; the operation restarts from
// its first step with a deadline for the new path.

/** Steps after which the claim is done and nothing is retried. */
const CLAIM_DONE = ["claim", "finish"];

function eligible(fenced: Fenced, err: unknown): boolean {
	if (!(err instanceof AgentRejected) && !(err instanceof DeadlineExceeded)) {
		return false;
	}
	const op = fenced.op;
	if (op.request.fromPool !== true || op.progress.claimRetried === true) {
		return false;
	}
	return op.step === null || !CLAIM_DONE.includes(op.step);
}

async function newPlacement(
	ctx: WorkerCtx,
	tx: Tx,
	s: Awaited<ReturnType<typeof loadSandboxRow>>,
	failFast: boolean,
): Promise<Placement | null> {
	const pairKey = `${s.template_slug}/${s.size_slug}`;
	const warm = await claimWarm(tx, s.id, s.template_slug, pairKey);
	if (warm !== null || failFast) return warm;
	try {
		return await admitCold(
			tx,
			{ pool: ctx.pool, config: ctx.config, keys: ctx.keys, jobs: ctx.jobs },
			s.template_slug,
			pairKey,
			s.memory_mb,
		);
	} catch (e) {
		if (e instanceof SbxError && e.code === "out_of_capacity") return null;
		throw e;
	}
}

/** `SandboxOpHandler.retry` of create. True = the operation restarts on a new machine. */
export async function retryClaim(
	ctx: WorkerCtx,
	fenced: Fenced,
	err: unknown,
): Promise<boolean> {
	if (!eligible(fenced, err)) return false;
	const s = await loadSandboxRow(ctx.pool, fenced.sandboxId);
	const old = s.machine_id;
	if (old === null) return false;
	const code = (err as { code: string }).code;
	const failFast = fenced.op.request.failFast === true;

	const next = await fenced.tx(async (tx) => {
		const cur = await tx.client.query<{ state: string; machine_id: string }>(
			"SELECT state, machine_id FROM runtime.sandboxes WHERE id = $1",
			[s.id],
		);
		const m = await tx.client.query<{ state: string }>(
			"SELECT state FROM runtime.machines WHERE id = $1",
			[old],
		);
		if (
			cur.rows[0]?.state !== "creating" ||
			cur.rows[0]?.machine_id !== old ||
			m.rows[0]?.state !== "claiming"
		) {
			return null;
		}
		const p = await newPlacement(ctx, tx, s, failFast);
		if (p === null) return null;

		await tx.client.query(
			`UPDATE runtime.machines
			 SET state = 'deleting', error_code = $2, error_detail = $3,
			     state_changed_at = now(), version = version + 1
			 WHERE id = $1 AND state NOT IN ('deleting', 'deleted')`,
			[old, code, "claim not completed; retried on another machine"],
		);
		await sendMachineDelete(ctx, tx, old);
		if (!p.fromPool) {
			// The row is the RAM reservation admitted above (S6 §8.2).
			await tx.client.query(
				`INSERT INTO runtime.machines
				   (id, provider_id, node_id, storage_id, template_build_id, origin,
				    size_slug, vcpu, memory_mb, sandbox_id, state)
				 SELECT $1, $2, $3, $4, $5, 'template', size_slug, vcpu, memory_mb, id, 'allocating'
				 FROM runtime.sandboxes WHERE id = $6`,
				[
					p.machineId,
					p.providerId,
					p.nodeId,
					p.storageId,
					p.templateBuildId,
					s.id,
				],
			);
		}
		await tx.client.query(
			`UPDATE runtime.sandboxes
			 SET machine_id = $2, node_id = $3, provider_id = $4, template_build_id = $5,
			     version = version + 1
			 WHERE id = $1`,
			[s.id, p.machineId, p.nodeId, p.providerId, p.templateBuildId],
		);
		const os = await tx.client.query<{ os: "linux" | "windows" }>(
			"SELECT os FROM runtime.template_builds WHERE id = $1",
			[p.templateBuildId],
		);
		const deadlineMs =
			operationDeadline("create", os.rows[0]?.os ?? "linux", {
				fromPool: p.fromPool,
			}) ?? 0;
		await tx.client.query(
			`UPDATE runtime.operations
			 SET step = NULL, progress = progress || $3::jsonb,
			     deadline_at = now() + make_interval(secs => $4::double precision / 1000),
			     version = version + 1
			 WHERE id = $1 AND attempt = $2 AND state = 'running'`,
			[
				fenced.id,
				fenced.attempt,
				JSON.stringify({ claimRetried: true, rejectedMachineId: old }),
				deadlineMs,
			],
		);
		await insertSandboxEvent(tx, {
			sandboxId: s.id,
			type: "claim_retried",
			reason: code,
			data: {
				operationId: fenced.id,
				rejectedMachineId: old,
				machineId: p.machineId,
				fromPool: p.fromPool,
			},
		});
		return p;
	});
	if (next === null) return false;
	await fenced.check();
	ctx.log.warn(
		{
			operationId: fenced.id,
			sandboxId: s.id,
			rejectedMachineId: old,
			machineId: next.machineId,
			fromPool: next.fromPool,
			code,
		},
		"claim not completed; retrying on another machine",
	);
	ctx.metrics.inc("sbx_claim_retried_total", {
		code,
		path: next.fromPool ? "warm" : "cold",
	});
	return true;
}
