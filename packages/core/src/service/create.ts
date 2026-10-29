import type { Tx } from "@sbx/db";
import { requestHash } from "../canonical.ts";
import { checkQuota } from "../capacity.ts";
import { operationDeadline } from "../deadlines.ts";
import { idempotencyKeyReused, notFound, poolExhausted } from "../errors.ts";
import { claimIdempotencyKey } from "../idempotency.ts";
import { uuidv7 } from "../ids.ts";
import { idempotencyPrincipal, type Principal } from "../principal.ts";
import type { Operation, Sandbox } from "../rows.ts";
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
	claimWarm,
	findSavedSnapshot,
	type Placement,
	POOL_EXHAUSTED_RETRY_SECONDS,
} from "./create-placement.ts";
import { insertSandboxRow } from "./sandbox-row.ts";
import { withServiceTx } from "./tx.ts";

// Create (S6 §7.3): one transaction writes the idempotency key (first), the
// sandbox `creating`, its secrets, the machine (claimed `claiming` or new
// `allocating`), the `create` operation, the event and the job. Any error rolls
// all of it back, so a refused create leaves nothing behind.

export type { CreateInput } from "./create-input.ts";
export {
	OUT_OF_CAPACITY_RETRY_SECONDS,
	POOL_EXHAUSTED_RETRY_SECONDS,
} from "./create-placement.ts";

export interface CreateResult {
	sandbox: Sandbox;
	operation: Operation;
}

export const CREATE_SCOPE = "sandboxes.create";

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
): Promise<CreateResult> {
	const sets = validateCreateInput(input);
	const hash = idemKey === undefined ? null : requestHash(CREATE_SCOPE, input);
	const principalId = idemKey === undefined ? null : idempotencyPrincipal(p);
	const sandboxId = uuidv7();
	const operationId = uuidv7();

	return withServiceTx(deps.pool, async (tx) => {
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
		const pairKey = `${template.slug}/${size.slug}`;
		const quota = await deps.config.teamQuota(p.teamId);
		// Team lock before any node lock (S6 §8.5).
		await checkQuota(tx, p.teamId, quota, {
			addSandboxes: 1,
			addRamMb: size.memoryMb,
		});

		let placement: Placement;
		if (snap !== null) {
			placement = await admitOnSnapshotNode(
				tx,
				deps,
				snap,
				pairKey,
				size.memoryMb,
			);
		} else {
			const claimed = await claimWarm(tx, sandboxId, template.slug, pairKey);
			if (claimed !== null) placement = claimed;
			else if (input.failFast === true) {
				throw poolExhausted(POOL_EXHAUSTED_RETRY_SECONDS);
			} else {
				placement = await admitCold(
					tx,
					deps,
					template.slug,
					pairKey,
					size.memoryMb,
				);
			}
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

		if (!placement.fromPool) {
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
		}

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
				failFast: input.failFast === true,
				fromPool: placement.fromPool,
			},
			principal: p,
			deadlineMs: operationDeadline("create", template.os, {
				fromPool: placement.fromPool,
			}),
		});
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
