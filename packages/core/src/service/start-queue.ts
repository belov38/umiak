import type { Tx } from "@umiak/db";
import { checkQuota } from "../capacity.ts";
import { operationDeadline } from "../deadlines.ts";
import {
	invalidState,
	isUmiakError,
	outOfCapacity,
	snapshotNotFound,
} from "../errors.ts";
import { lockTeam } from "../locks.ts";
import type { Principal } from "../principal.ts";
import { DELETE_RETRY_LIMIT } from "../queues.ts";
import type { Operation } from "../rows.ts";
import {
	findSandboxRow,
	insertSandboxEvent,
	lockSandboxById,
	mustLoadOperation,
	type SandboxServiceDeps,
} from "./common.ts";
import { resolveTemplate } from "./create-input.ts";
import {
	admitCold,
	admitLocalSource,
	admitOnSnapshotNode,
	claimWarm,
	type Placement,
} from "./create-placement.ts";
import { withServiceTx } from "./tx.ts";

/** A placeholder has no VM, lease or node RAM reservation. */
export async function queuedPlacement(
	tx: Tx,
	templateSlug: string,
): Promise<Placement> {
	const r = (
		await tx.client.query<{
			node_id: string;
			provider_id: string;
			storage_id: string;
			id: string;
		}>(
			`SELECT tb.id,tb.node_id,tb.provider_id,tb.storage_id FROM runtime.template_builds tb JOIN runtime.nodes n ON n.id=tb.node_id JOIN runtime.providers p ON p.id=tb.provider_id WHERE tb.template_slug=$1 AND tb.status='active' AND n.retired_at IS NULL AND p.state='active' ORDER BY (n.state='active') DESC,tb.promoted_at DESC NULLS LAST,tb.id LIMIT 1`,
			[templateSlug],
		)
	).rows[0];
	if (!r) throw outOfCapacity(30);
	const { uuidv7 } = await import("../ids.ts");
	return {
		fromPool: false,
		machineId: uuidv7(),
		nodeId: r.node_id,
		providerId: r.provider_id,
		storageId: r.storage_id,
		templateBuildId: r.id,
		originSnapshotId: null,
	};
}

export type QueueAdmission = "not_queued" | "waiting" | "admitted" | "expired";
/** Lock order: sandbox row, team, then node. Admission and ticket deletion commit together. */
export async function tryAdmitQueuedStart(
	deps: SandboxServiceDeps,
	operationId: string,
): Promise<QueueAdmission> {
	const initial = (
		await deps.pool.query<{ sandbox_id: string }>(
			"SELECT sandbox_id FROM runtime.operations WHERE id=$1",
			[operationId],
		)
	).rows[0];
	if (!initial) return "not_queued";
	return withServiceTx(deps, async (tx) => {
		const s = await lockSandboxById(tx, initial.sandbox_id);
		await lockTeam(tx, s.team_id);
		const ticket = (
			await tx.client.query<{ expired: boolean; seq: string }>(
				"SELECT deadline_at<=now() AS expired,seq FROM runtime.start_queue WHERE operation_id=$1",
				[operationId],
			)
		).rows[0];
		if (!ticket) return "not_queued";
		const op = await mustLoadOperation(tx.client, operationId);
		if (!["pending", "running"].includes(op.state)) {
			await tx.client.query(
				"DELETE FROM runtime.start_queue WHERE operation_id=$1",
				[operationId],
			);
			return "not_queued";
		}
		if (ticket.expired) {
			await finishQueue(tx, deps, s.id, operationId, "out_of_capacity", true);
			return "expired";
		}
		const head = (
			await tx.client.query<{ operation_id: string }>(
				"SELECT q.operation_id FROM runtime.start_queue q JOIN runtime.operations o ON o.id=q.operation_id WHERE q.team_id=$1 AND o.state IN ('pending','running') ORDER BY q.seq LIMIT 1",
				[s.team_id],
			)
		).rows[0];
		if (head?.operation_id !== operationId) return "waiting";
		if (s.blocked) throw invalidState(s.state, { reason: "sandbox_blocked" });
		const m = (
			await tx.client.query<{
				id: string;
				state: string;
				storage_id: string;
				origin_snapshot_id: string | null;
			}>(
				"SELECT id,state,storage_id,origin_snapshot_id FROM runtime.machines WHERE id=$1",
				[s.machine_id],
			)
		).rows[0];
		if (!m) throw invalidState(s.state);
		try {
			const quota = await deps.config.teamQuota(s.team_id);
			await checkQuota(tx, s.team_id, quota, {
				addSandboxes: 1,
				addRamMb: s.memory_mb,
			});
			if (op.kind === "create") {
				await resolveTemplate(deps, s.template_slug, s.size_slug);
				let placement: Placement;
				if (m.origin_snapshot_id) {
					const snap = (
						await tx.client.query<{
							id: string;
							node_id: string;
							provider_id: string;
							storage_id: string;
							template_build_id: string;
							template_slug: string;
						}>(
							`SELECT sn.id,sn.node_id,sn.provider_id,sn.storage_id,sn.template_build_id,tb.template_slug FROM runtime.snapshots sn JOIN runtime.template_builds tb ON tb.id=sn.template_build_id WHERE sn.id=$1 AND sn.team_id=$2 AND sn.state='ready' FOR SHARE OF sn`,
							[m.origin_snapshot_id, s.team_id],
						)
					).rows[0];
					if (!snap) throw snapshotNotFound(m.origin_snapshot_id);
					placement = await admitOnSnapshotNode(
						tx,
						deps,
						{
							id: snap.id,
							nodeId: snap.node_id,
							providerId: snap.provider_id,
							storageId: snap.storage_id,
							templateBuildId: snap.template_build_id,
							templateSlug: snap.template_slug,
						},
						`${s.template_slug}/${s.size_slug}`,
						s.memory_mb,
					);
				} else
					placement =
						(await claimWarm(
							tx,
							s.id,
							s.template_slug,
							`${s.template_slug}/${s.size_slug}`,
						)) ??
						(await admitCold(
							tx,
							deps,
							s.template_slug,
							`${s.template_slug}/${s.size_slug}`,
							s.memory_mb,
						));
				if (placement.fromPool) {
					await tx.client.query(
						"UPDATE runtime.machines SET state='deleted',deleted_at=now(),version=version+1 WHERE id=$1",
						[m.id],
					);
					await tx.client.query(
						"UPDATE runtime.sandboxes SET machine_id=$2 WHERE id=$1",
						[s.id, placement.machineId],
					);
				} else
					await tx.client.query(
						"UPDATE runtime.machines SET node_id=$2,provider_id=$3,storage_id=$4,template_build_id=$5,state='allocating',version=version+1 WHERE id=$1",
						[
							m.id,
							placement.nodeId,
							placement.providerId,
							placement.storageId,
							placement.templateBuildId,
						],
					);
				await tx.client.query(
					"UPDATE runtime.sandboxes SET node_id=$2,provider_id=$3,template_build_id=$4,version=version+1 WHERE id=$1",
					[
						s.id,
						placement.nodeId,
						placement.providerId,
						placement.templateBuildId,
					],
				);
				await tx.client.query(
					"UPDATE runtime.operations SET request=request || $2::jsonb WHERE id=$1",
					[operationId, JSON.stringify({ fromPool: placement.fromPool })],
				);
			} else if (op.kind === "resume") {
				await admitLocalSource(
					tx,
					deps,
					{
						nodeId: s.node_id,
						storageId: m.storage_id,
						providerId: s.provider_id,
						templateBuildId: s.template_build_id,
						templateSlug: s.template_slug,
					},
					`${s.template_slug}/${s.size_slug}`,
					s.memory_mb,
				);
			} else
				throw invalidState(s.state, {
					reason: "operation cannot wait for capacity",
				});
		} catch (error) {
			if (
				isUmiakError(error, "out_of_capacity") ||
				isUmiakError(error, "quota_exceeded")
			)
				return "waiting";
			throw error;
		}
		const os =
			(
				await tx.client.query<{ os: "linux" | "windows" }>(
					"SELECT os FROM runtime.template_builds WHERE id=$1",
					[s.template_build_id],
				)
			).rows[0]?.os ?? "linux";
		await tx.client.query(
			"UPDATE runtime.operations SET progress=(progress - 'queuedUntil') || $2::jsonb,deadline_at=now()+($3::int*interval '1 millisecond'),version=version+1 WHERE id=$1",
			[
				operationId,
				JSON.stringify({ phase: "starting" }),
				operationDeadline(op.kind, os) ?? 1200000,
			],
		);
		await tx.client.query(
			"DELETE FROM runtime.start_queue WHERE operation_id=$1",
			[operationId],
		);
		return "admitted";
	});
}

async function finishQueue(
	tx: Tx,
	deps: SandboxServiceDeps,
	sandboxId: string,
	operationId: string,
	code: string,
	retryable: boolean,
) {
	const s = await lockSandboxById(tx, sandboxId);
	const op = await mustLoadOperation(tx.client, operationId);
	await tx.client.query(
		"DELETE FROM runtime.start_queue WHERE operation_id=$1",
		[operationId],
	);
	await tx.client.query(
		"UPDATE runtime.operations SET state='failed',error_code=$2,error_message=$3,retryable=$4,finished_at=now(),version=version+1 WHERE id=$1 AND state IN ('pending','running')",
		[
			operationId,
			code,
			code === "out_of_capacity"
				? "Capacity wait expired"
				: "Queued start cancelled",
			retryable,
		],
	);
	const state = op.kind === "resume" ? "stopped" : "error";
	await tx.client.query(
		"UPDATE runtime.sandboxes SET state=$2,error_code=$3,error_message=$4,state_changed_at=now(),version=version+1 WHERE id=$1",
		[
			sandboxId,
			state,
			code,
			code === "out_of_capacity"
				? "Capacity wait expired"
				: "Queued start cancelled",
		],
	);
	if (op.kind === "create")
		await tx.client.query(
			"UPDATE runtime.machines SET state='failed',power_observed='stopped',version=version+1 WHERE id=$1 AND vmid IS NULL",
			[s.machine_id],
		);
	const snapshots = (
		await tx.client.query<{ id: string }>(
			"UPDATE runtime.snapshots SET state='deleting',version=version+1 WHERE consumer_sandbox_id=$1 AND kind='fork_source' AND state IN ('ready','failed') RETURNING id",
			[sandboxId],
		)
	).rows;
	for (const snap of snapshots)
		await deps.jobs.send(
			tx,
			"snapshot-op",
			{ snapshotId: snap.id, action: "delete" },
			{ singletonKey: snap.id, retryLimit: DELETE_RETRY_LIMIT },
		);
	await insertSandboxEvent(tx, {
		sandboxId,
		type: "state_changed",
		fromState: s.state,
		toState: state,
		reason: code,
		data: { operationId },
	});
}
export async function expireQueuedStart(
	deps: SandboxServiceDeps,
	operationId: string,
): Promise<void> {
	const initial = (
		await deps.pool.query<{ sandbox_id: string }>(
			"SELECT sandbox_id FROM runtime.operations WHERE id=$1",
			[operationId],
		)
	).rows[0];
	if (!initial) return;
	await withServiceTx(deps, async (tx) => {
		const s = await lockSandboxById(tx, initial.sandbox_id);
		await lockTeam(tx, s.team_id);
		const due = (
			await tx.client.query(
				"SELECT 1 FROM runtime.start_queue WHERE operation_id=$1 AND deadline_at<=now()",
				[operationId],
			)
		).rowCount;
		if (due)
			await finishQueue(tx, deps, s.id, operationId, "out_of_capacity", true);
	});
}
export async function cancelQueuedStart(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
): Promise<Operation> {
	return withServiceTx(deps, async (tx) => {
		const s = await findSandboxRow(tx.client, p, idOrSlug, { lock: true });
		await lockTeam(tx, s.team_id);
		const ticket = (
			await tx.client.query<{ operation_id: string }>(
				"SELECT q.operation_id FROM runtime.start_queue q JOIN runtime.operations o ON o.id=q.operation_id WHERE o.sandbox_id=$1",
				[s.id],
			)
		).rows[0];
		if (!ticket) {
			const prior = (
				await tx.client.query<{ id: string; error_code: string | null }>(
					"SELECT id,error_code FROM runtime.operations WHERE sandbox_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
					[s.id],
				)
			).rows[0];
			if (prior?.error_code === "cancelled")
				return mustLoadOperation(tx.client, prior.id);
			throw invalidState(s.state, { reason: "start is not queued" });
		}
		await finishQueue(tx, deps, s.id, ticket.operation_id, "cancelled", false);
		return mustLoadOperation(tx.client, ticket.operation_id);
	});
}
