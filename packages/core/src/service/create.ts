import type { Tx } from "@umiak/db";
import { requestHash } from "../canonical.ts";
import { checkQuota } from "../capacity.ts";
import { operationDeadline } from "../deadlines.ts";
import {
	idempotencyKeyReused,
	isUmiakError,
	notFound,
	outOfCapacity,
} from "../errors.ts";
import { claimIdempotencyKey } from "../idempotency.ts";
import { uuidv7 } from "../ids.ts";
import { idempotencyPrincipal, type Principal } from "../principal.ts";
import type { Operation, Sandbox } from "../rows.ts";
import {
	applySecretPatch,
	type SecretSets,
	validateSecretSets,
} from "../secrets.ts";
import { enqueueCapacityWait, teamHasQueuedStarts } from "./capacity-wait.ts";
import {
	insertOperation,
	insertSandboxEvent,
	loadOperation,
	loadSandbox,
	type SandboxServiceDeps,
} from "./common.ts";
import {
	type CreateInput,
	resolveDurations,
	resolveTemplate,
	validateCreateInput,
} from "./create-input.ts";
import {
	admitCold,
	admitOnSnapshotNode,
	findSavedSnapshot,
	type Placement,
} from "./create-placement.ts";
import { insertSandboxRow } from "./sandbox-row.ts";
import { queuedPlacement } from "./start-queue.ts";
import { withServiceTx } from "./tx.ts";

// Create (S6 §7.3): one transaction writes the idempotency key (first), the
// sandbox `creating`, its secrets, the new `allocating` machine, the `create` operation, the event and the job. Any error rolls
// all of it back, so a refused create leaves nothing behind.

export type { CreateInput } from "./create-input.ts";
export { OUT_OF_CAPACITY_RETRY_SECONDS } from "./create-placement.ts";

export interface CreateResult {
	sandbox: Sandbox;
	operation: Operation;
}

export const CREATE_SCOPE = "sandboxes.create";

/** How the api drives a create (S7 §20.2 item 11, environments of S8 §10.1). */
export interface CreateOptions {
	/** Private operator smoke path only; never copied from public create JSON. */
	placementNodeId?: string;
	/**
	 * Hashed for the Idempotency-Key instead of `input`: the client's own
	 * request body, so server-side additions (an environment) do not change
	 * the hash of a retry.
	 */
	hashBody?: unknown;
	/**
	 * Base sets under the request's own (an environment), read inside the
	 * transaction after the key claim, so a replay never calls it. The
	 * request's env, secrets and secret files are overlaid (same key or file
	 * name: the request wins); limits are checked on the result. Null: none.
	 */
	resolveSets?: (tx: Tx) => Promise<SecretSets | null>;
}

/** `base` with the request's sets on top (files by name). */
function overlaySets(base: SecretSets, req: SecretSets): SecretSets {
	return applySecretPatch(base, {
		env: req.env,
		secrets: req.secrets,
		secretFiles: Object.fromEntries(
			req.secretFiles.map(({ name, ...f }) => [name, f]),
		),
	});
}

async function loadResult(
	tx: Tx,
	sandboxId: string,
	operationId: string,
): Promise<CreateResult> {
	const sandbox = await loadSandbox(tx.client, sandboxId);
	const operation = await loadOperation(tx.client, operationId);
	if (sandbox === null) throw notFound("sandbox");
	if (operation === null) throw notFound("operation");
	return { sandbox, operation };
}

export async function createSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	input: CreateInput,
	idemKey?: string,
	opts: CreateOptions = {},
): Promise<CreateResult> {
	const requestSets = validateCreateInput(input);
	const hashed = "hashBody" in opts ? opts.hashBody : input;
	const hash =
		idemKey === undefined ? null : requestHash(deps.keys, CREATE_SCOPE, hashed);
	const principalId = idemKey === undefined ? null : idempotencyPrincipal(p);
	const sandboxId = uuidv7();
	const operationId = uuidv7();

	return withServiceTx(deps, async (tx) => {
		if (idemKey !== undefined && hash !== null && principalId !== null) {
			const claim = await claimIdempotencyKey(tx, {
				principalId,
				scope: CREATE_SCOPE,
				key: idemKey,
				requestHash: hash,
				sandboxId,
				operationId,
			});
			if (claim.kind === "replay") {
				const res = await loadResult(
					tx,
					claim.sandboxId ?? "",
					claim.operationId ?? "",
				);
				// A user's key is shared by their teams; never replay across teams.
				if (res.sandbox.teamId !== p.teamId) throw idempotencyKeyReused();
				return res;
			}
		}

		// Base sets after the key, like config: a replay depends on neither.
		const base = opts.resolveSets ? await opts.resolveSets(tx) : null;
		const sets = base === null ? requestSets : overlaySets(base, requestSets);
		if (base !== null) validateSecretSets(sets);

		// Config is read after the key: a replay must not depend on config changes.
		const defaults = await deps.config.defaults();
		const { ttlSeconds, idleTimeoutSeconds } = resolveDurations(
			input,
			defaults,
		);
		const snap = input.from
			? await findSavedSnapshot(tx, p.teamId, input.from.snapshot)
			: null;
		const templateSlug =
			snap?.templateSlug ?? input.template ?? defaults.defaultTemplate;
		const { template, size } = await resolveTemplate(
			deps,
			templateSlug,
			input.size,
		);
		const quota = await deps.config.teamQuota(p.teamId);
		// Team lock before any node lock (S6 §8.5).
		await checkQuota(tx, p.teamId, quota, {
			teamExists: deps.config.teamExists?.bind(deps.config),
			addSandboxes: 1,
			addRamMb: size.memoryMb,
		});

		let placement: Placement;
		let queued = false;
		try {
			if (await teamHasQueuedStarts(tx, p.teamId)) throw outOfCapacity(30);
			if (snap !== null) {
				placement = await admitOnSnapshotNode(tx, snap, size.memoryMb);
			} else {
				placement = await admitCold(
					tx,
					template.slug,
					size.memoryMb,
					opts.placementNodeId,
				);
			}
		} catch (error) {
			if (
				!isUmiakError(error, "out_of_capacity") ||
				!(input.capacityWaitSeconds && input.capacityWaitSeconds > 0)
			)
				throw error;
			queued = true;
			placement = snap
				? {
						machineId: uuidv7(),
						nodeId: snap.nodeId,
						providerId: snap.providerId,
						storageId: snap.storageId,
						templateBuildId: snap.templateBuildId,
						originSnapshotId: snap.id,
					}
				: await queuedPlacement(tx, template.slug);
		}

		const slug = await insertSandboxRow(tx, deps, input.slug, {
			id: sandboxId,
			teamId: p.teamId,
			createdBy: p.userId,
			createdByKey: p.apiKeyId ?? null,
			name: input.name ?? null,
			labels: input.labels ?? {},
			templateSlug: template.slug,
			sizeSlug: size.slug,
			vcpu: size.vcpu,
			memoryMb: size.memoryMb,
			templateBuildId: placement.templateBuildId,
			origin: snap ? "snapshot" : "template",
			originSnapshotId: placement.originSnapshotId,
			forkedFromSandboxId: null,
			providerId: placement.providerId,
			nodeId: placement.nodeId,
			machineId: placement.machineId,
			ttlSeconds,
			idleTimeoutSeconds,
		});
		// The row is the RAM reservation admitted above (S6 §8.2).
		await tx.client.query(
			`INSERT INTO runtime.machines
				   (id, provider_id, node_id, storage_id, template_build_id, origin, origin_snapshot_id,
				    size_slug, vcpu, memory_mb, sandbox_id, state)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'allocating')`,
			[
				placement.machineId,
				placement.providerId,
				placement.nodeId,
				placement.storageId,
				placement.templateBuildId,
				snap ? "snapshot" : "template",
				placement.originSnapshotId,
				size.slug,
				size.vcpu,
				size.memoryMb,
				sandboxId,
			],
		);

		if (queued)
			await tx.client.query(
				"UPDATE runtime.machines SET state='stopped',power_observed='stopped' WHERE id=$1",
				[placement.machineId],
			);

		const blob = deps.keys.encrypt(sandboxId, sets);
		await tx.client.query(
			`INSERT INTO runtime.sandbox_secrets (sandbox_id, key_version, nonce, ciphertext)
			 VALUES ($1, $2, $3, $4)`,
			[sandboxId, blob.keyVersion, blob.nonce, blob.ciphertext],
		);

		await insertOperation(tx, {
			id: operationId,
			sandboxId,
			kind: "create",
			// Non-secret parameters only: no env, secrets or files (S6 §13.1).
			request: {
				template: template.slug,
				size: size.slug,
				name: input.name ?? null,
				slug,
				labels: input.labels ?? {},
				ttlSeconds,
				idleTimeoutSeconds,
				from: input.from ? { snapshot: input.from.snapshot } : null,
			},
			principal: p,
			deadlineMs: operationDeadline("create", template.os),
		});
		if (queued)
			await enqueueCapacityWait(
				tx,
				deps.jobs,
				p.teamId,
				operationId,
				input.capacityWaitSeconds ?? 0,
			);

		await insertSandboxEvent(tx, {
			sandboxId,
			type: "state_changed",
			fromState: null,
			toState: "creating",
			reason: "create",
			data: { operationId, machineId: placement.machineId },
		});
		await deps.jobs.send(
			tx,
			"sandbox-op",
			{ operationId },
			{ singletonKey: sandboxId },
		);
		return loadResult(tx, sandboxId, operationId);
	});
}
