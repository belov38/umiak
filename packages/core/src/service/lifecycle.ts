import { type Tx, withTx } from "@umiak/db";
import { type RequestHash, requestHash } from "../canonical.ts";
import { checkQuota, QUOTA_ACTIVE_SANDBOX_STATES } from "../capacity.ts";
import { operationDeadline } from "../deadlines.ts";
import {
	invalidState,
	isUmiakError,
	operationInProgress,
	outOfCapacity,
	recoverRateLimited,
	type ValidationIssue,
	validation,
} from "../errors.ts";
import type { JobSender } from "../jobs.ts";
import type { Principal } from "../principal.ts";
import type { Operation } from "../rows.ts";
import {
	applySecretPatch,
	type SecretPatch,
	validateSecretSets,
} from "../secrets.ts";
import {
	RESERVED_MACHINE_STATES,
	type SandboxEvent,
	type SandboxState,
	sandboxNext,
} from "../states.ts";
import {
	checkCapacityWait,
	enqueueCapacityWait,
	teamHasQueuedStarts,
} from "./capacity-wait.ts";
import {
	activeOperation,
	buildOs,
	findSandboxRow,
	insertOperation,
	insertSandboxEvent,
	lockSandboxById,
	type MachineInfo,
	machineInfo,
	mustLoadOperation,
	type SandboxRow,
	type SandboxServiceDeps,
	sendSandboxOp,
} from "./common.ts";
import { resolveTemplate } from "./create-input.ts";
import { admitLocalSource, admitOnNode } from "./create-placement.ts";
import {
	checkSecretPatch,
	pickSecretPatch,
	readSandboxSecrets,
	writeSandboxSecrets,
} from "./secret-patch.ts";
import { withServiceTx } from "./tx.ts";
import {
	checkKnownKeys,
	checkSeconds,
	checkString,
	isPlainObject,
} from "./validate.ts";

// Stop (S6 §7.5), resume (§7.6, R11), recover (§7.8) and the system entry
// points of the worker's controllers: `requestStop` (autostop) and
// `requestSystemResume` (reconcile, §11.3). Each takes the sandbox row lock
// first (lock order contract); a repeat while the same kind is active returns
// the active operation (§7.1, S7 §20.2 item 7).

export type StopRequestReason = "user" | "ttl" | "idle";

export interface ResumeInput extends SecretPatch {
	capacityWaitSeconds?: number;
	/** A size allowed for the sandbox's template; admission uses its RAM. */
	size?: string;
	/** Replaces `ttl_seconds` (null removes the TTL); the worker sets the deadline at ready. */
	ttlSeconds?: number | null;
}

export const RESUME_SCOPE = "sandboxes.resume";

const RESUME_KEYS = [
	"capacityWaitSeconds",
	"size",
	"ttlSeconds",
	"env",
	"secrets",
	"secretFiles",
];

/** Machine states whose RAM is already reserved (no admission for recover). */
function machineReserved(m: MachineInfo): boolean {
	return RESERVED_MACHINE_STATES.includes(m.state);
}

async function setStarting(
	tx: Tx,
	row: SandboxRow,
	to: SandboxState,
	extra: { lastRecover?: boolean } = {},
): Promise<void> {
	await tx.client.query(
		`UPDATE runtime.sandboxes
		 SET state = $2, error_code = NULL, error_message = NULL,
		     last_recover_at = CASE WHEN $3 THEN now() ELSE last_recover_at END,
		     state_changed_at = now(), version = version + 1
		 WHERE id = $1`,
		[row.id, to, extra.lastRecover === true],
	);
}

async function startOperation(
	tx: Tx,
	jobs: JobSender,
	row: SandboxRow,
	op: {
		kind: "stop" | "resume" | "recover";
		request: Record<string, unknown>;
		principal: Principal | null;
		to: SandboxState;
		reason: string;
		data?: Record<string, unknown>;
	},
): Promise<Operation> {
	const os = await buildOs(tx.client, row.template_build_id);
	const operationId = await insertOperation(tx, {
		sandboxId: row.id,
		kind: op.kind,
		request: op.request,
		principal: op.principal,
		deadlineMs: operationDeadline(op.kind, os),
	});
	await insertSandboxEvent(tx, {
		sandboxId: row.id,
		type: "state_changed",
		fromState: row.state,
		toState: op.to,
		reason: op.reason,
		data: { operationId, ...op.data },
	});
	await sendSandboxOp(tx, jobs, operationId, row.id);
	return mustLoadOperation(tx.client, operationId);
}

// ---------------------------------------------------------------------------
// Stop

async function stopLocked(
	tx: Tx,
	jobs: JobSender,
	row: SandboxRow,
	reason: StopRequestReason,
	principal: Principal | null,
): Promise<Operation> {
	const active = await activeOperation(tx.client, row.id);
	if (active !== null) {
		if (active.kind === "stop") return active;
		throw operationInProgress(active);
	}
	const to = sandboxNext(row.state, "stop");
	await tx.client.query(
		`UPDATE runtime.sandboxes
		 SET state = $2, stop_reason = $3, state_changed_at = now(), version = version + 1
		 WHERE id = $1`,
		[row.id, to, reason],
	);
	return startOperation(tx, jobs, row, {
		kind: "stop",
		request: { reason },
		principal,
		to,
		reason: "stop",
		data: { stopReason: reason },
	});
}

/**
 * Stop of a `ready` sandbox inside the caller's transaction (autostop: `ttl`,
 * `idle`; API: `user`). Returns the active stop if there is one;
 * `operation_in_progress` for another active operation, `invalid_state`
 * outside `ready`. Locks the sandbox row: call it before any team/node
 * advisory lock or machine/operation row lock (lock order contract).
 */
export async function requestStop(
	tx: Tx,
	jobs: JobSender,
	sandboxId: string,
	reason: StopRequestReason,
	principal: Principal | null = null,
): Promise<Operation> {
	const row = await lockSandboxById(tx, sandboxId);
	return stopLocked(tx, jobs, row, reason, principal);
}

export async function stopSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
): Promise<Operation> {
	return withTx(deps.pool, async (tx) => {
		const row = await findSandboxRow(tx.client, p, idOrSlug, { lock: true });
		return stopLocked(tx, deps.jobs, row, "user", p);
	});
}

// ---------------------------------------------------------------------------
// Resume

function validateResumeInput(input: ResumeInput): SecretPatch | null {
	if (!isPlainObject(input as unknown)) {
		throw validation([{ path: "", message: "must be an object" }]);
	}
	const issues: ValidationIssue[] = [];
	checkCapacityWait(input.capacityWaitSeconds, issues);
	checkKnownKeys(input as Record<string, unknown>, RESUME_KEYS, issues);
	if (input.size !== undefined) checkString("size", input.size, issues);
	if (input.ttlSeconds !== undefined) {
		checkSeconds("ttlSeconds", input.ttlSeconds, issues, { nullable: true });
	}
	checkSecretPatch(input, issues);
	if (issues.length > 0) throw validation(issues);
	return pickSecretPatch(input);
}

function machineOrInvalid(
	row: SandboxRow,
	m: MachineInfo | null,
	event: SandboxEvent,
): MachineInfo {
	if (m === null) {
		throw invalidState(row.state, { event, machineState: null });
	}
	return m;
}

/** `bodyHash` of an active resume (hex) made from the same body. */
function sameBody(hash: RequestHash, stored: unknown): boolean {
	return (
		typeof stored === "string" &&
		/^[0-9a-f]*$/.test(stored) &&
		hash.matches(Buffer.from(stored, "hex"))
	);
}

export async function resumeSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	input: ResumeInput = {},
): Promise<Operation> {
	const patch = validateResumeInput(input);
	const hash = requestHash(deps.keys, RESUME_SCOPE, input);
	const bodyHash = hash.value.toString("hex");

	return withServiceTx(deps, async (tx) => {
		const row = await findSandboxRow(tx.client, p, idOrSlug, {
			lock: true,
			write: true,
		});
		const active = await activeOperation(tx.client, row.id);
		if (active !== null) {
			// The same body returns the active resume without a new admission.
			if (active.kind === "resume" && sameBody(hash, active.request.bodyHash)) {
				return active;
			}
			throw operationInProgress(active);
		}
		const m = await machineInfo(tx.client, row.machine_id);
		const to = sandboxNext(row.state, "resume", { machineState: m?.state });
		const machine = machineOrInvalid(row, m, "resume");

		// The merged sets are checked before any lock is taken.
		const sets =
			patch === null
				? null
				: applySecretPatch(
						await readSandboxSecrets(tx.client, deps.keys, row.id),
						patch,
					);
		if (sets !== null) validateSecretSets(sets);

		const defaults = await deps.config.defaults();
		if (
			input.ttlSeconds !== undefined &&
			input.ttlSeconds !== null &&
			input.ttlSeconds > defaults.maxTtlSeconds
		) {
			throw validation([
				{
					path: "ttlSeconds",
					message: `must be at most ${defaults.maxTtlSeconds} seconds`,
				},
			]);
		}
		let size = {
			slug: row.size_slug as string,
			vcpu: row.vcpu as number,
			memoryMb: row.memory_mb as number,
		};
		if (input.size !== undefined) {
			size = (await resolveTemplate(deps, row.template_slug, input.size)).size;
		}

		// Team lock, then node lock (S6 §8.5).
		const quota = await deps.config.teamQuota(row.team_id);
		await checkQuota(tx, row.team_id, quota, {
			addSandboxes: 1,
			addRamMb: size.memoryMb,
		});
		let queued = false;
		try {
			if (await teamHasQueuedStarts(tx, p.teamId)) throw outOfCapacity(30);

			await admitLocalSource(
				tx,
				{
					nodeId: row.node_id,
					storageId: machine.storageId,
					providerId: row.provider_id,
					templateBuildId: row.template_build_id,
					templateSlug: row.template_slug,
				},
				size.memoryMb,
			);
		} catch (error) {
			if (
				!isUmiakError(error, "out_of_capacity") ||
				!(input.capacityWaitSeconds && input.capacityWaitSeconds > 0)
			)
				throw error;
			queued = true;
		}

		if (size.slug !== row.size_slug || size.memoryMb !== machine.memoryMb) {
			// The machine row is the reservation (RESERVED_SQL counts its
			// memory_mb) and the target of the worker's resize step.
			await tx.client.query(
				`UPDATE runtime.machines
				 SET size_slug = $2, vcpu = $3, memory_mb = $4, version = version + 1
				 WHERE id = $1`,
				[machine.id, size.slug, size.vcpu, size.memoryMb],
			);
		}
		await tx.client.query(
			`UPDATE runtime.sandboxes
			 SET size_slug = $2, vcpu = $3, memory_mb = $4,
			     ttl_seconds = CASE WHEN $5 THEN $6::int ELSE ttl_seconds END
			 WHERE id = $1`,
			[
				row.id,
				size.slug,
				size.vcpu,
				size.memoryMb,
				input.ttlSeconds !== undefined,
				input.ttlSeconds ?? null,
			],
		);
		await setStarting(tx, row, to);
		// Stays with the sandbox even if the resume fails later (S6 §7.6).
		if (sets !== null) await writeSandboxSecrets(tx, deps.keys, row.id, sets);

		const operation = await startOperation(tx, deps.jobs, row, {
			kind: "resume",
			// Non-secret parameters and the body hash only (S6 §13.1).
			request: {
				size: input.size ?? null,
				ttlSeconds: input.ttlSeconds ?? null,
				bodyHash,
			},
			principal: p,
			to,
			reason: "resume",
		});
		if (queued) {
			await enqueueCapacityWait(
				tx,
				deps.jobs,
				row.team_id,
				operation.id,
				input.capacityWaitSeconds ?? 0,
			);
			return mustLoadOperation(tx.client, operation.id);
		}

		return operation;
	});
}

export type SystemResumeResult =
	| { ok: true; operation: Operation }
	| { ok: false };

/**
 * System resume after the first unexpected shutdown in an hour (S6 §11.3):
 * `ready → starting`, `requested_by = null`, no quota check, admission as
 * usual. The caller (reconcile) has already moved the machine to `stopped` in
 * this transaction and must have taken the sandbox row lock before touching
 * the machine (lock order contract). A refused admission changes nothing and
 * returns `{ok: false}`: the caller then stops the sandbox (`unexpected_shutdown`).
 */
export async function requestSystemResume(
	tx: Tx,
	jobs: JobSender,
	sandboxId: string,
): Promise<SystemResumeResult> {
	const row = await lockSandboxById(tx, sandboxId);
	const active = await activeOperation(tx.client, row.id);
	if (active !== null) throw operationInProgress(active);
	const to = sandboxNext(row.state, "unexpected_stop_first");
	const machine = await machineInfo(tx.client, row.machine_id);
	if (machine === null || machine.state !== "stopped") {
		throw invalidState(row.state, {
			event: "unexpected_stop_first",
			machineState: machine?.state ?? null,
		});
	}
	try {
		await admitLocalSource(
			tx,
			{
				nodeId: row.node_id,
				storageId: machine.storageId,
				providerId: row.provider_id,
				templateBuildId: row.template_build_id,
				templateSlug: row.template_slug,
			},
			machine.memoryMb,
		);
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "out_of_capacity"
		)
			return { ok: false };
		throw error;
	}

	await setStarting(tx, row, to);
	const operation = await startOperation(tx, jobs, row, {
		kind: "resume",
		request: {
			size: null,
			ttlSeconds: null,
			bodyHash: null,
			reason: "unexpected_shutdown",
		},
		principal: null,
		to,
		reason: "unexpected_shutdown",
	});

	return { ok: true, operation };
}

// ---------------------------------------------------------------------------
// Recover

export async function recoverSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
): Promise<Operation> {
	return withServiceTx(deps, async (tx) => {
		const row = await findSandboxRow(tx.client, p, idOrSlug, {
			lock: true,
			write: true,
		});
		const active = await activeOperation(tx.client, row.id);
		if (active !== null) {
			if (active.kind === "recover") return active;
			throw operationInProgress(active);
		}
		const m = await machineInfo(tx.client, row.machine_id);
		const to = sandboxNext(row.state, "recover", { machineState: m?.state });
		const machine = machineOrInvalid(row, m, "recover");

		const defaults = await deps.config.defaults();
		const wait = await tx.client.query<{ wait: number | null }>(
			`SELECT CEIL(EXTRACT(EPOCH FROM
			          last_recover_at + make_interval(secs => $2::int) - now()))::int AS wait
			 FROM runtime.sandboxes WHERE id = $1`,
			[row.id, defaults.recoverMinIntervalSeconds],
		);
		const waitSeconds = wait.rows[0]?.wait ?? null;
		if (waitSeconds !== null && waitSeconds > 0) {
			throw recoverRateLimited(waitSeconds);
		}

		// From `error` the sandbox re-enters the quota; a machine that is not
		// reserved (e.g. `stopped`) needs admission like resume.
		if (!QUOTA_ACTIVE_SANDBOX_STATES.includes(row.state)) {
			const quota = await deps.config.teamQuota(row.team_id);
			await checkQuota(tx, row.team_id, quota, {
				addSandboxes: 1,
				addRamMb: row.memory_mb,
			});
		}
		if (!machineReserved(machine)) {
			await admitOnNode(tx, row.node_id, machine.memoryMb);
		}
		await setStarting(tx, row, to, { lastRecover: true });
		return startOperation(tx, deps.jobs, row, {
			kind: "recover",
			request: {},
			principal: p,
			to,
			reason: "recover",
		});
	});
}
