import { stepRequestId } from "@sbx/core";
import type { Tx } from "@sbx/db";
import type { WorkerCtx } from "../context.ts";
import { loadMachine, type MachineRow } from "../db.ts";
import {
	MachineGone,
	type PrepSource,
	prepareMachine,
	waitBooted,
} from "../machine-prep.ts";
import type { ClaimRequest } from "../ports.ts";
import type { Fenced, Step } from "../steps.ts";
import { retryClaim } from "./claim.ts";
import {
	bootTimeoutMs,
	currentMachine,
	deliverableFiles,
	loadSandboxRow,
	loadSecretSets,
	runOp,
	sessionOf,
	transitionSandbox,
} from "./common.ts";
import { compensateCreate, compensateForkTarget } from "./compensate.ts";
import type { SandboxOpHandler } from "./kind.ts";
import {
	CONSUMED_SNAPSHOT_STATES,
	consumedForkSources,
	deleteSnapshotLvs,
	markSnapshot,
} from "./snapshot-step.ts";

// Create (S6 §7.3). Cold path: provision (§7.4) → boot → rotate_token →
// claim → finish. Claim path (the API claimed a warm machine, now
// `claiming`): provision and boot are skipped. The "already done?" checks are
// machine states, so a repeat after a crash, or after the pool claim retry
// switched machines, starts from the right place.

/** Step names of create, in order (the last one is the final transition). */
export const CREATE_STEPS = [
	"provision",
	"boot",
	"rotate_token",
	"claim",
	"finish",
] as const;

/**
 * Step names of a fork target's create (§7.7): the create steps, then
 * `cleanup_source` before the final transition (it is recorded, so a crash
 * after it does not repeat it, and the final transition stays the last
 * fenced write). Also the list snapshot-op uses for "passed provision".
 */
export const FORK_TARGET_STEPS = [
	"provision",
	"boot",
	"rotate_token",
	"claim",
	"cleanup_source",
	"finish",
] as const;

/** A create with a parent is a fork target's (§7.1, §7.7). */
export function isForkTarget(fenced: Fenced): boolean {
	return fenced.op.parentOperationId !== null;
}

/**
 * `cleanup_source`: S1 delete of the fork_source the target was cloned from
 * (thin snapshots are independent), then the row `deleted`.
 */
export function cleanupSourceStep(ctx: WorkerCtx, fenced: Fenced): Step {
	return {
		name: "cleanup_source",
		run: async () => {
			const ids = await consumedForkSources(ctx.pool, fenced.sandboxId);
			for (const id of ids) {
				await deleteSnapshotLvs(ctx, fenced, id, CONSUMED_SNAPSHOT_STATES);
				await fenced.tx((tx) =>
					markSnapshot(tx, id, "deleted", CONSUMED_SNAPSHOT_STATES),
				);
			}
			return { cleanedSnapshots: ids };
		},
	};
}

/** Preparation source of a machine: its origin snapshot (create from snapshot, fork target) or the template. */
export function prepSourceOf(m: MachineRow): PrepSource {
	return m.origin === "snapshot" && m.origin_snapshot_id !== null
		? { kind: "snapshot", snapshotId: m.origin_snapshot_id }
		: { kind: "template" };
}

async function claimingMachine(
	ctx: WorkerCtx,
	sandboxId: string,
): Promise<MachineRow> {
	const m = await currentMachine(ctx, sandboxId);
	if (m.state !== "claiming") throw new MachineGone(m.id, `state ${m.state}`);
	return m;
}

/** The create steps before `finish` (fork targets reuse them, Task 10b). */
export function createSteps(ctx: WorkerCtx, fenced: Fenced): Step[] {
	const machine = () => currentMachine(ctx, fenced.sandboxId);
	return [
		{
			name: "provision",
			skipIf: async () => {
				const m = await machine();
				return m.state !== "allocating" && m.state !== "provisioning";
			},
			run: async () => {
				const m = await machine();
				await prepareMachine(ctx, fenced, m.id, prepSourceOf(m));
				return { machineId: m.id };
			},
		},
		{
			name: "boot",
			skipIf: async () => (await machine()).state !== "booting",
			run: async () => {
				const m = await machine();
				const bootId = await waitBooted(
					ctx,
					fenced,
					m.id,
					await bootTimeoutMs(ctx, m.template_build_id),
				);
				// Cold path: booting -> claiming (sandbox_id is set from the start).
				await fenced.tx(async (tx) => {
					const r = await tx.client.query(
						`UPDATE runtime.machines
						 SET state = 'claiming', claimed_at = COALESCE(claimed_at, now()),
						     state_changed_at = now(), version = version + 1
						 WHERE id = $1 AND state = 'booting'`,
						[m.id],
					);
					if (r.rowCount === 1) return;
					const cur = await loadMachine(tx.client, m.id);
					if (cur?.state !== "claiming") {
						throw new MachineGone(m.id, `state ${cur?.state ?? "missing"}`);
					}
				});
				return { bootId };
			},
		},
		{
			name: "rotate_token",
			run: async () => {
				const m = await claimingMachine(ctx, fenced.sandboxId);
				await fenced.check();
				await ctx.gateway.rotateToken(m.id);
			},
		},
		{
			name: "claim",
			run: async () => {
				const m = await claimingMachine(ctx, fenced.sandboxId);
				const s = await loadSandboxRow(ctx.pool, fenced.sandboxId);
				const sets = await loadSecretSets(ctx, fenced.sandboxId);
				const req: ClaimRequest = {
					reason: "claim",
					sandboxId: s.id,
					hostname: `sbx-${s.slug}`,
					env: sets.env,
					secretEnv: sets.secrets,
					secretFiles: deliverableFiles(sets.secretFiles),
					authorizedKeys: [],
				};
				await fenced.check();
				await ctx.agent.claim(m.id, req, stepRequestId(fenced.id, "claim"));
				const bootId = (await sessionOf(ctx.pool, m.id))?.boot_id ?? null;
				await fenced.tx(async (tx) => {
					await tx.client.query(
						`UPDATE runtime.machines SET provisioned_boot_id = $2, version = version + 1
						 WHERE id = $1`,
						[m.id, bootId],
					);
				});
				return { claimedMachineId: m.id };
			},
		},
	];
}

/**
 * `finish` of create: machine `claiming → running`, sandbox `creating →
 * ready` with `ready_at`, `deadline_at = now + ttl` (if a TTL is set) and
 * health ok. Runs in the fenced transaction that ends the operation.
 */
export async function finishCreate(
	tx: Tx,
	sandboxId: string,
	operationId: string,
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
		 WHERE id = $1 AND state = 'claiming'`,
		[machineId],
	);
	if (m.rowCount !== 1) {
		throw new MachineGone(machineId ?? "-", "not claiming at finish");
	}
	const ok = await transitionSandbox(
		tx,
		sandboxId,
		["creating"],
		"ready",
		{ reason: "create_done", data: { operationId, machineId } },
		{
			sql: `ready_at = now(),
			      deadline_at = CASE WHEN s.ttl_seconds IS NULL THEN NULL
			                         ELSE now() + make_interval(secs => s.ttl_seconds) END,
			      health = 'ok', health_reason = NULL, degraded_since = NULL,
			      error_code = NULL, error_message = NULL`,
			params: [],
		},
	);
	if (!ok) throw new Error(`sandbox ${sandboxId}: not creating at finish`);
}

export const CREATE_OP: SandboxOpHandler = {
	run: (ctx, fenced) =>
		runOp(
			fenced,
			isForkTarget(fenced)
				? [...createSteps(ctx, fenced), cleanupSourceStep(ctx, fenced)]
				: createSteps(ctx, fenced),
			(tx) => finishCreate(tx, fenced.sandboxId, fenced.id),
		),
	retry: retryClaim,
	compensate: (ctx, fenced, error) =>
		isForkTarget(fenced)
			? compensateForkTarget(ctx, fenced, error)
			: compensateCreate(ctx, fenced, error),
};
