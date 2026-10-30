import type { TemplateOs } from "@sbx/config";
import {
	insertSandboxEvent,
	SECRET_FILE_DEFAULT_MODE,
	type SecretFile,
	type SecretSets,
	stepRequestId,
	tryPoweredStart,
} from "@sbx/core";
import type { Tx } from "@sbx/db";
import type pg from "pg";
import type { WorkerCtx } from "../context.ts";
import { loadMachine, type MachineRow } from "../db.ts";
import {
	capacityWait,
	MachineGone,
	MachineStateConflict,
	ownedPowerOp,
	ownedTeardown,
} from "../machine-prep.ts";
import { AgentUnavailable } from "../ports.ts";
import {
	DeadlineExceeded,
	deadlinePassed,
	type Fenced,
	type OperationError,
	runSteps,
	type Step,
	type StepFence,
} from "../steps.ts";
import { waitUntil } from "../wait.ts";

// Helpers shared by the sandbox operations (S6 §7): row reads, secrets in
// memory only, agent delivery, the start gate, the hard stop and the final
// fenced transition.

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export interface SandboxOpRow {
	id: string;
	slug: string;
	team_id: string;
	state: string;
	machine_id: string | null;
	node_id: string | null;
	template_slug: string;
	size_slug: string;
	memory_mb: number;
	template_build_id: string;
	origin: "template" | "snapshot" | "fork";
	origin_snapshot_id: string | null;
	ttl_seconds: number | null;
}

export async function loadSandboxRow(
	q: Queryable,
	sandboxId: string,
): Promise<SandboxOpRow> {
	const r = await q.query<SandboxOpRow>(
		`SELECT id, slug, team_id, state, machine_id, node_id, template_slug, size_slug, memory_mb,
		        template_build_id, origin, origin_snapshot_id, ttl_seconds
		 FROM runtime.sandboxes WHERE id = $1`,
		[sandboxId],
	);
	const row = r.rows[0];
	if (!row) throw new Error(`sandbox ${sandboxId} not found`);
	return row;
}

/** The sandbox's current machine (`sandboxes.machine_id`). */
export async function currentMachine(
	ctx: WorkerCtx,
	sandboxId: string,
): Promise<MachineRow> {
	const s = await loadSandboxRow(ctx.pool, sandboxId);
	if (s.machine_id === null) {
		throw new MachineStateConflict("-", `sandbox ${sandboxId} has no machine`);
	}
	const m = await loadMachine(ctx.pool, s.machine_id);
	if (m === null) throw new MachineStateConflict(s.machine_id, "not found");
	return m;
}

/** OS of the machine's template build (`template_builds.os`). */
export async function machineOs(
	q: Pick<pg.Pool, "query">,
	m: Pick<MachineRow, "template_build_id">,
): Promise<TemplateOs> {
	const r = await q.query<{ os: TemplateOs }>(
		"SELECT os FROM runtime.template_builds WHERE id = $1",
		[m.template_build_id],
	);
	return r.rows[0]?.os ?? "linux";
}

/** VMID of a machine that has a VM; `MachineStateConflict` otherwise. */
export function vmidOf(m: MachineRow): number {
	if (m.vmid === null) throw new MachineStateConflict(m.id, "no VMID recorded");
	return m.vmid;
}

/** Decrypted env and secrets of the sandbox. Kept in memory only, never logged. */
export async function loadSecretSets(
	ctx: WorkerCtx,
	sandboxId: string,
): Promise<SecretSets> {
	const r = await ctx.pool.query<{
		key_version: number;
		nonce: Buffer;
		ciphertext: Buffer;
	}>(
		"SELECT key_version, nonce, ciphertext FROM runtime.sandbox_secrets WHERE sandbox_id = $1",
		[sandboxId],
	);
	const row = r.rows[0];
	if (!row) return { env: {}, secrets: {}, secretFiles: [] };
	return ctx.keys.decrypt(sandboxId, {
		keyVersion: row.key_version,
		nonce: row.nonce,
		ciphertext: row.ciphertext,
	});
}

/** Secret files as delivered: the default mode 0o440 where none is set (S7 §8.3). */
export function deliverableFiles(files: SecretFile[]): SecretFile[] {
	return files.map((f) => ({ ...f, mode: f.mode ?? SECRET_FILE_DEFAULT_MODE }));
}

export interface SessionRow {
	boot_id: string | null;
	state: string | null;
}

export async function sessionOf(
	q: Queryable,
	machineId: string,
): Promise<SessionRow | null> {
	const r = await q.query<SessionRow>(
		"SELECT boot_id, state FROM tunnel.tunnel_sessions WHERE machine_id = $1",
		[machineId],
	);
	return r.rows[0] ?? null;
}

/** `template_builds.boot_timeout_s` in ms (S6 §7.9). */
export async function bootTimeoutMs(
	ctx: WorkerCtx,
	buildId: string,
): Promise<number> {
	const r = await ctx.pool.query<{ boot_timeout_s: number }>(
		"SELECT boot_timeout_s FROM runtime.template_builds WHERE id = $1",
		[buildId],
	);
	return (r.rows[0]?.boot_timeout_s ?? 300) * 1000;
}

/** The agent did not connect on a new boot in time. Permanent. */
export class AgentTimeout extends Error {
	readonly retryable = false;
	readonly code = "agent_timeout";
	constructor(machineId: string, timeoutMs: number) {
		super(`machine ${machineId}: agent did not connect within ${timeoutMs} ms`);
		this.name = "AgentTimeout";
	}
}

/**
 * Waits for a connected tunnel session whose `boot_id` is none of
 * `notBootIds` (S6 §7.6 `wait_agent`: a boot other than the provisioned one).
 * Returns that boot id.
 */
export async function waitAgentSession(
	ctx: WorkerCtx,
	fence: StepFence,
	machineId: string,
	timeoutMs: number,
	notBootIds: readonly (string | null | undefined)[],
): Promise<string> {
	const skip = new Set(notBootIds.filter((b): b is string => !!b));
	return waitUntil(
		ctx,
		fence,
		async () => {
			const s = await sessionOf(ctx.pool, machineId);
			if (s?.state !== "connected" || !s.boot_id || skip.has(s.boot_id)) {
				return undefined;
			}
			return s.boot_id;
		},
		{
			timeoutMs,
			pollMs: ctx.timing.pollMs,
			timeoutError: () => new AgentTimeout(machineId, timeoutMs),
		},
	);
}

/**
 * Delivery of env and secrets on the current boot (S6 §7.6 `provision`, S3
 * §8.1): `System/UpdateEnv` and `System/UpdateSecrets` with deterministic
 * request ids, then `provisioned_boot_id` = the boot they were delivered to.
 * Both sets are sent whole: the guest keeps no secrets across a boot.
 */
export async function deliverProvision(
	ctx: WorkerCtx,
	fenced: Fenced,
	machineId: string,
	step = "provision",
): Promise<{ bootId: string }> {
	const s = await sessionOf(ctx.pool, machineId);
	if (s?.state !== "connected" || !s.boot_id) {
		throw new AgentUnavailable(`machine ${machineId}: agent not connected`);
	}
	const bootId = s.boot_id;
	const sets = await loadSecretSets(ctx, fenced.sandboxId);
	await fenced.check();
	await ctx.agent.updateEnv(
		machineId,
		sets.env,
		stepRequestId(fenced.id, `${step}:env`),
	);
	await ctx.agent.updateSecrets(
		machineId,
		{
			secretEnv: sets.secrets,
			secretFiles: deliverableFiles(sets.secretFiles),
		},
		stepRequestId(fenced.id, `${step}:secrets`),
	);
	await fenced.tx(async (tx) => {
		await tx.client.query(
			`UPDATE runtime.machines SET provisioned_boot_id = $2, version = version + 1
			 WHERE id = $1`,
			[machineId, bootId],
		);
	});
	return { bootId };
}

/** `power_observed = running` after an S1 start. */
export async function markPowered(
	fence: StepFence,
	machineId: string,
): Promise<void> {
	await fence.tx(async (tx) => {
		await tx.client.query(
			`UPDATE runtime.machines SET power_observed = 'running', power_observed_at = now()
			 WHERE id = $1`,
			[machineId],
		);
	});
}

/**
 * Start gate and S1 start of a `stopped` machine (S6 §8.2, resume and recover):
 * `tryPoweredStart(starting)` polled every `ramWaitPollMs` (the machine is
 * then counted in powered RAM), then S1 start unless the VM already runs.
 * A repeat after a crash finds the machine `starting` and only makes sure the
 * VM runs.
 */
export async function startMachine(
	ctx: WorkerCtx,
	fenced: Fenced,
	m: MachineRow,
): Promise<void> {
	const vmid = vmidOf(m);
	await capacityWait(
		ctx,
		fenced,
		`machine ${m.id} start gate`,
		async () =>
			(await fenced.tx(
				(tx) => tryPoweredStart(tx, { machineId: m.id, toState: "starting" }),
				{ nodeId: m.node_id },
			))
				? true
				: undefined,
		{
			timeoutMs: ctx.timing.ramWaitTimeoutMs,
			pollMs: ctx.timing.ramWaitPollMs,
		},
	);
	const infra = await ctx.infra.forNode(m.node_id);
	const status = await infra.status(vmid);
	if (status === "missing") throw new MachineGone(m.id, `VM ${vmid} missing`);
	if (status !== "running") {
		await fenced.check();
		await ownedPowerOp(ctx, m.id, vmid, "start", () =>
			infra.start(vmid, {
				expectedOwner: m.id,
				beforeAct: () => fenced.check(),
			}),
		);
	}
	await markPowered(fenced, m.id);
}

/**
 * S1 hard stop if the VM runs; a missing VM is fine. Returns the VM status
 * before; `missing` also when the VMID is no longer the machine's (owner
 * mismatch: nothing stopped).
 */
export async function hardStop(
	ctx: WorkerCtx,
	m: MachineRow,
): Promise<"running" | "stopped" | "paused" | "missing" | "none"> {
	const vmid = m.vmid;
	if (vmid === null) return "none";
	const infra = await ctx.infra.forNode(m.node_id);
	const status = await infra.status(vmid);
	if (status === "running" || status === "paused") {
		const own = await ownedTeardown(ctx, m.id, vmid, "stop", () =>
			infra.stop(vmid, { expectedOwner: m.id }),
		);
		if (!own) return "missing";
	}
	return status;
}

/**
 * Runs the remaining steps, then the final transition with the operation's
 * `succeeded` in one fenced transaction. The deadline is checked before every
 * step and before the final transition (S6 §7.1 p. 3).
 */
export async function runOp(
	fenced: Fenced,
	steps: Step[],
	finish: (tx: Tx) => Promise<void>,
): Promise<void> {
	await runSteps(fenced, steps);
	const op = await fenced.check();
	if (deadlinePassed(op)) throw new DeadlineExceeded(op.id);
	await fenced.finish("succeeded", undefined, finish);
}

/** A permanent error as stored on the operation (`error_code`, `error_message`). */
export function operationErrorOf(e: unknown): OperationError {
	const code =
		typeof (e as { code?: unknown })?.code === "string"
			? (e as { code: string }).code
			: "internal";
	const message = e instanceof Error ? e.message : String(e);
	return { code, message, retryable: false };
}

/**
 * Moves the sandbox from one of `from` to `to` with a `state_changed` event.
 * `set` adds columns (SQL fragment over `$3…` params). Returns false if the
 * sandbox was not in `from`.
 */
export async function transitionSandbox(
	tx: Tx,
	sandboxId: string,
	from: readonly string[],
	to: string,
	ev: { reason: string; data?: Record<string, unknown> },
	set: { sql: string; params: unknown[] } = { sql: "", params: [] },
): Promise<boolean> {
	const r = await tx.client.query<{ prev: string }>(
		`UPDATE runtime.sandboxes s
		 SET state = $2, state_changed_at = now(), version = s.version + 1${set.sql ? `, ${set.sql}` : ""}
		 FROM (SELECT id, state AS prev FROM runtime.sandboxes WHERE id = $1) p
		 WHERE s.id = p.id AND s.state = ANY($${3 + set.params.length}::text[])
		 RETURNING p.prev`,
		[sandboxId, to, ...set.params, from],
	);
	const prev = r.rows[0]?.prev;
	if (prev === undefined) return false;
	await insertSandboxEvent(tx, {
		sandboxId,
		type: "state_changed",
		fromState: prev,
		toState: to,
		reason: ev.reason,
		...(ev.data ? { data: ev.data } : {}),
	});
	return true;
}

/**
 * The machine-lost transition (§6.1): the VM is gone, so the machine is
 * `failed` (`machine_lost`) with `power_observed = stopped`. The observed
 * power matters: §8.1 counts a `failed` machine whose power is not `stopped`
 * in powered RAM, and nothing corrects it later (reconcile skips failed
 * machines), so without it the RAM would block the start gate until the
 * sandbox is deleted. `expected` makes it conditional on a snapshot (state
 * and version); without it, any state but failed/deleting/deleted. Returns
 * true if the row changed.
 */
export async function markMachineLost(
	tx: Tx,
	machineId: string,
	detail: string,
	expected?: { state: string; version: number },
): Promise<boolean> {
	const guard = expected
		? "state = $3 AND version = $4"
		: "state NOT IN ('failed', 'deleting', 'deleted')";
	const r = await tx.client.query(
		`UPDATE runtime.machines
		 SET state = 'failed', error_code = 'machine_lost', error_detail = $2,
		     power_observed = 'stopped', power_observed_at = now(),
		     state_changed_at = now(), version = version + 1
		 WHERE id = $1 AND ${guard}`,
		expected
			? [machineId, detail, expected.state, expected.version]
			: [machineId, detail],
	);
	return r.rowCount === 1;
}

/** Puts the sandbox in `error` with a code and message (any of `from`). */
export async function sandboxToError(
	tx: Tx,
	sandboxId: string,
	from: readonly string[],
	code: string,
	message: string,
	data: Record<string, unknown>,
): Promise<boolean> {
	return transitionSandbox(
		tx,
		sandboxId,
		from,
		"error",
		{ reason: code, data },
		{ sql: "error_code = $3, error_message = $4", params: [code, message] },
	);
}
