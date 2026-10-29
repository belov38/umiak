import { requestHash } from "../canonical.ts";
import { checkQuota } from "../capacity.ts";
import { operationDeadline } from "../deadlines.ts";
import {
	idempotencyKeyReused,
	notFound,
	operationInProgress,
	outOfCapacity,
	type ValidationIssue,
	validation,
} from "../errors.ts";
import { claimIdempotencyKey } from "../idempotency.ts";
import { uuidv7 } from "../ids.ts";
import { nodeUnplaceable } from "../placement.ts";
import { idempotencyPrincipal, type Principal } from "../principal.ts";
import type { Operation, Sandbox } from "../rows.ts";
import {
	applySecretPatch,
	type SecretPatch,
	validateSecretSets,
} from "../secrets.ts";
import { validateSlug } from "../slug.ts";
import { sandboxNext } from "../states.ts";
import {
	activeOperation,
	buildOs,
	findSandboxRow,
	insertOperation,
	insertSandboxEvent,
	loadOperation,
	loadSandbox,
	machineInfo,
	type Queryable,
	type SandboxServiceDeps,
	sendSandboxOp,
} from "./common.ts";
import {
	checkTemplateEnabled,
	resolveDurations,
	resolveTemplate,
} from "./create-input.ts";
import {
	admitOnNode,
	OUT_OF_CAPACITY_RETRY_SECONDS,
} from "./create-placement.ts";
import { insertSandboxRow } from "./sandbox-row.ts";
import {
	checkSecretPatch,
	readSandboxSecrets,
	writeSandboxSecrets,
} from "./secret-patch.ts";
import { withServiceTx } from "./tx.ts";
import {
	checkKnownKeys,
	checkLabels,
	checkName,
	checkSeconds,
	checkString,
	isPlainObject,
} from "./validate.ts";

// Fork (S6 §7.7, R11). One transaction: the idempotency key (first), the
// source row lock, quota (team lock), admission on the source's node (node
// lock), the target sandbox `creating` with its machine `allocating`, the
// target's secrets (source sets + patch, target AAD), the `fork` operation on
// the source with its job, and the target's `create` operation without a job
// (the fork schedules it when the snapshot is ready).

export interface ForkInput extends SecretPatch {
	name?: string | null;
	slug?: string;
	/** Default: the source's labels. */
	labels?: Record<string, string>;
	/** Not inherited: request or `PlatformDefaults`. */
	ttlSeconds?: number | null;
	idleTimeoutSeconds?: number | null;
	/** Default: the source's size. */
	size?: string;
}

export interface ForkResult {
	/** The target. */
	sandbox: Sandbox;
	/** The target's `create` (pending until the fork succeeds). */
	operation: Operation;
	/** The `fork` operation on the source. */
	sourceOperation: Operation;
}

export const FORK_SCOPE = "sandboxes.fork";

const FORK_KEYS = [
	"name",
	"slug",
	"labels",
	"ttlSeconds",
	"idleTimeoutSeconds",
	"size",
	"env",
	"secrets",
	"secretFiles",
];

function validateForkInput(input: ForkInput): void {
	if (!isPlainObject(input as unknown)) {
		throw validation([{ path: "", message: "must be an object" }]);
	}
	const issues: ValidationIssue[] = [];
	checkKnownKeys(input as Record<string, unknown>, FORK_KEYS, issues);
	if (input.name !== undefined) checkName("name", input.name, issues);
	if (input.labels !== undefined) checkLabels("labels", input.labels, issues);
	if (input.size !== undefined) checkString("size", input.size, issues);
	if (input.ttlSeconds !== undefined) {
		checkSeconds("ttlSeconds", input.ttlSeconds, issues, { nullable: true });
	}
	if (input.idleTimeoutSeconds !== undefined) {
		checkSeconds("idleTimeoutSeconds", input.idleTimeoutSeconds, issues, {
			nullable: true,
		});
	}
	checkSecretPatch(input, issues);
	if (issues.length > 0) throw validation(issues);
	if (input.slug !== undefined) validateSlug(input.slug);
}

async function loadForkResult(
	q: Queryable,
	targetId: string,
	createOpId: string,
): Promise<ForkResult> {
	const sandbox = await loadSandbox(q, targetId);
	const operation = await loadOperation(q, createOpId);
	if (sandbox === null) throw notFound("sandbox");
	if (operation === null || operation.parentOperationId === null) {
		throw notFound("operation");
	}
	const sourceOperation = await loadOperation(q, operation.parentOperationId);
	if (sourceOperation === null) throw notFound("operation");
	return { sandbox, operation, sourceOperation };
}

export async function forkSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	input: ForkInput,
	idemKey?: string,
): Promise<ForkResult> {
	validateForkInput(input);
	// The source id is part of the idempotency hash (S7 §20.2 item 11): resolve
	// it before the transaction, whose first write must be the key.
	const sourceId = (await findSandboxRow(deps.pool, p, idOrSlug)).id;
	const targetId = uuidv7();
	const machineId = uuidv7();
	const forkOpId = uuidv7();
	const createOpId = uuidv7();

	return withServiceTx(deps, async (tx) => {
		if (idemKey !== undefined) {
			const claim = await claimIdempotencyKey(tx, {
				principalId: idempotencyPrincipal(p),
				scope: FORK_SCOPE,
				key: idemKey,
				requestHash: requestHash(deps.keys, FORK_SCOPE, {
					sandbox: sourceId,
					input,
				}),
				sandboxId: targetId,
				operationId: createOpId,
			});
			if (claim.kind === "replay") {
				const res = await loadForkResult(
					tx.client,
					claim.sandboxId ?? "",
					claim.operationId ?? "",
				);
				if (res.sandbox.teamId !== p.teamId) throw idempotencyKeyReused();
				return res;
			}
		}

		const src = await findSandboxRow(tx.client, p, sourceId, { lock: true });
		const active = await activeOperation(tx.client, src.id);
		if (active !== null) throw operationInProgress(active);
		sandboxNext(src.state, "fork");
		const srcMachine = await machineInfo(tx.client, src.machine_id);
		if (srcMachine === null) {
			throw notFound("source machine");
		}

		// The target's sets: source + patch, checked before any lock.
		const sets = applySecretPatch(
			await readSandboxSecrets(tx.client, deps.keys, src.id),
			input,
		);
		validateSecretSets(sets);

		const defaults = await deps.config.defaults();
		const { ttlSeconds, idleTimeoutSeconds } = resolveDurations(
			{
				...(input.ttlSeconds !== undefined
					? { ttlSeconds: input.ttlSeconds }
					: {}),
				...(input.idleTimeoutSeconds !== undefined
					? { idleTimeoutSeconds: input.idleTimeoutSeconds }
					: {}),
			},
			defaults,
		);
		// As create: a disabled template takes no new sandboxes.
		let size = {
			slug: src.size_slug as string,
			vcpu: src.vcpu as number,
			memoryMb: src.memory_mb as number,
		};
		if (input.size !== undefined) {
			size = (await resolveTemplate(deps, src.template_slug, input.size)).size;
		} else {
			await checkTemplateEnabled(deps, src.template_slug);
		}

		const quota = await deps.config.teamQuota(p.teamId);
		await checkQuota(tx, p.teamId, quota, {
			addSandboxes: 1,
			addRamMb: size.memoryMb,
		});
		// As create (§8.4): the fork's new disks go to the source's storage,
		// which must be below its thresholds on an active node (a draining
		// node takes no new machines, forks included).
		const unplaceable = await nodeUnplaceable(
			tx,
			src.node_id,
			srcMachine.storageId,
		);
		if (unplaceable !== null) {
			throw outOfCapacity(
				OUT_OF_CAPACITY_RETRY_SECONDS,
				undefined,
				unplaceable,
			);
		}
		await admitOnNode(
			tx,
			deps,
			src.node_id,
			size.memoryMb,
			`${src.template_slug}/${size.slug}`,
		);

		const labels: Record<string, string> = input.labels ?? src.labels ?? {};
		const slug = await insertSandboxRow(tx, deps, input.slug, {
			id: targetId,
			teamId: p.teamId,
			createdBy: p.userId,
			createdByKey: p.apiKeyId ?? null,
			name: input.name ?? null,
			labels,
			templateSlug: src.template_slug,
			sizeSlug: size.slug,
			vcpu: size.vcpu,
			memoryMb: size.memoryMb,
			templateBuildId: src.template_build_id,
			origin: "fork",
			originSnapshotId: null,
			forkedFromSandboxId: src.id,
			providerId: src.provider_id,
			nodeId: src.node_id,
			machineId,
			ttlSeconds,
			idleTimeoutSeconds,
		});
		// The row is the RAM reservation admitted above (S6 §8.2).
		// origin_snapshot_id is set once the fork_source snapshot exists.
		await tx.client.query(
			`INSERT INTO runtime.machines
			   (id, provider_id, node_id, storage_id, template_build_id, origin,
			    size_slug, vcpu, memory_mb, sandbox_id, state)
			 VALUES ($1, $2, $3, $4, $5, 'snapshot', $6, $7, $8, $9, 'allocating')`,
			[
				machineId,
				src.provider_id,
				src.node_id,
				srcMachine.storageId,
				src.template_build_id,
				size.slug,
				size.vcpu,
				size.memoryMb,
				targetId,
			],
		);
		await writeSandboxSecrets(tx, deps.keys, targetId, sets);

		const os = await buildOs(tx.client, src.template_build_id);
		await insertOperation(tx, {
			id: forkOpId,
			sandboxId: src.id,
			kind: "fork",
			request: { targetSandboxId: targetId },
			principal: p,
			deadlineMs: operationDeadline("fork", os),
		});
		await insertOperation(tx, {
			id: createOpId,
			sandboxId: targetId,
			kind: "create",
			// Non-secret parameters only (S6 §13.1).
			request: {
				template: src.template_slug,
				size: size.slug,
				name: input.name ?? null,
				slug,
				labels,
				ttlSeconds,
				idleTimeoutSeconds,
				from: null,
				failFast: false,
				fromPool: false,
				forkOf: src.id,
			},
			principal: p,
			// Set by the fork when the snapshot is ready (S6 §7.7 step 2).
			deadlineMs: null,
			parentOperationId: forkOpId,
		});
		await insertSandboxEvent(tx, {
			sandboxId: targetId,
			type: "state_changed",
			fromState: null,
			toState: "creating",
			reason: "fork",
			data: {
				operationId: createOpId,
				machineId,
				sourceSandboxId: src.id,
				sourceOperationId: forkOpId,
			},
		});
		await sendSandboxOp(tx, deps.jobs, forkOpId, src.id);
		return loadForkResult(tx.client, targetId, createOpId);
	});
}
