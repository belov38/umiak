import type { Tx } from "@umiak/db";
import { admit } from "../capacity.ts";
import { outOfCapacity, snapshotNotFound } from "../errors.ts";
import { uuidv7 } from "../ids.ts";
import { nodeUnplaceable, place } from "../placement.ts";
import type { SandboxServiceDeps } from "./common.ts";

// Admission paths of create (S6 §7.3, §8.2, §9.5): warm claim, cold on a
// placement candidate, cold on the node of a saved snapshot.

export const POOL_EXHAUSTED_RETRY_SECONDS = 60;
export const OUT_OF_CAPACITY_RETRY_SECONDS = 30;

export interface SavedSource {
	id: string;
	nodeId: string;
	providerId: string;
	storageId: string;
	templateBuildId: string;
	templateSlug: string;
}

/** The team's `ready` saved snapshot, share-locked against a concurrent delete. */
export async function findSavedSnapshot(
	tx: Tx,
	teamId: string,
	name: string,
): Promise<SavedSource> {
	const r = await tx.client.query(
		`SELECT s.id, s.node_id, s.provider_id, s.storage_id, s.template_build_id, tb.template_slug
		 FROM runtime.snapshots s
		 JOIN runtime.template_builds tb ON tb.id = s.template_build_id
		 WHERE s.team_id = $1 AND s.kind = 'saved' AND s.name = $2 AND s.state = 'ready'
		 FOR SHARE OF s`,
		[teamId, name],
	);
	const row = r.rows[0];
	if (!row) throw snapshotNotFound(name);
	return {
		id: row.id,
		nodeId: row.node_id,
		providerId: row.provider_id,
		storageId: row.storage_id,
		templateBuildId: row.template_build_id,
		templateSlug: row.template_slug,
	};
}

export interface Placement {
	fromPool: boolean;
	/** The claimed warm machine, or the id of the new `allocating` machine. */
	machineId: string;
	nodeId: string;
	providerId: string;
	storageId: string;
	templateBuildId: string;
	originSnapshotId: string | null;
}

/**
 * Claim (S6 §9.5) of the oldest warm machine of the pair with the active build
 * on a placeable node. A warm machine already holds its RAM, so nodes are
 * taken from `place` with `needMb = 0`.
 */
export async function claimWarm(
	tx: Tx,
	sandboxId: string,
	templateSlug: string,
	pairKey: string,
): Promise<Placement | null> {
	const nodes = await place(tx, { templateSlug, needMb: 0 });
	if (nodes.length === 0) return null;
	const r = await tx.client.query(
		`UPDATE runtime.machines
		 SET state = 'claiming', sandbox_id = $1, pool_key = NULL, claimed_at = now(),
		     state_changed_at = now(), version = version + 1
		 WHERE id = (SELECT id FROM runtime.machines
		             WHERE state = 'warm' AND pool_key = $2
		               AND template_build_id = ANY($3::uuid[]) AND node_id = ANY($4::uuid[])
		             ORDER BY warm_at LIMIT 1 FOR UPDATE SKIP LOCKED)
		 RETURNING id, node_id, provider_id, storage_id, template_build_id`,
		[
			sandboxId,
			pairKey,
			nodes.map((n) => n.templateBuildId),
			nodes.map((n) => n.nodeId),
		],
	);
	const m = r.rows[0];
	if (!m) return null;
	return {
		fromPool: true,
		machineId: m.id,
		nodeId: m.node_id,
		providerId: m.provider_id,
		storageId: m.storage_id,
		templateBuildId: m.template_build_id,
		originSnapshotId: null,
	};
}

/**
 * Cold admission (S6 §8.2) on placement candidates, evicting other pairs' warm
 * machines. Candidates keep the §8.4 order (most free RAM first): `admit`
 * gives back the node lock of a refused candidate, so this loop holds at most
 * one node lock at any time and cannot deadlock with another one.
 */
export async function admitCold(
	tx: Tx,
	deps: SandboxServiceDeps,
	templateSlug: string,
	pairKey: string,
	needMb: number,
): Promise<Placement> {
	const candidates = await place(tx, {
		templateSlug,
		needMb,
		evict: true,
		pairKey,
	});
	for (const c of candidates) {
		const res = await admit(tx, {
			nodeId: c.nodeId,
			storageId: c.storageId,
			templateBuildId: c.templateBuildId,
			needMb,
			pairKey,
			evict: true,
			jobs: deps.jobs,
		});
		if (res.ok) {
			return {
				fromPool: false,
				machineId: uuidv7(),
				nodeId: c.nodeId,
				providerId: c.providerId,
				storageId: c.storageId,
				templateBuildId: c.templateBuildId,
				originSnapshotId: null,
			};
		}
	}
	throw outOfCapacity(OUT_OF_CAPACITY_RETRY_SECONDS);
}

/** Create from a saved snapshot: cold, on the snapshot's node (S6 §7.3). */
export async function admitOnSnapshotNode(
	tx: Tx,
	deps: SandboxServiceDeps,
	snap: SavedSource,
	pairKey: string,
	needMb: number,
): Promise<Placement> {
	const unplaceable = await nodeUnplaceable(tx, snap.nodeId, snap.storageId);
	if (unplaceable !== null)
		throw outOfCapacity(OUT_OF_CAPACITY_RETRY_SECONDS, undefined, unplaceable);
	const res = await admit(tx, {
		nodeId: snap.nodeId,
		storageId: snap.storageId,
		needMb,
		pairKey,
		evict: true,
		jobs: deps.jobs,
	});
	if (!res.ok) throw outOfCapacity(OUT_OF_CAPACITY_RETRY_SECONDS);
	return {
		fromPool: false,
		machineId: uuidv7(),
		nodeId: snap.nodeId,
		providerId: snap.providerId,
		storageId: snap.storageId,
		templateBuildId: snap.templateBuildId,
		originSnapshotId: snap.id,
	};
}

/**
 * Admission on a fixed node (resume, recover, fork: the disks are local to
 * it), evicting warm machines of other pairs; `out_of_capacity` otherwise.
 */
export async function admitOnNode(
	tx: Tx,
	deps: Pick<SandboxServiceDeps, "jobs">,
	nodeId: string,
	needMb: number,
	pairKey: string,
	storageId?: string,
): Promise<void> {
	const res = await admit(tx, {
		nodeId,
		...(storageId !== undefined ? { storageId } : {}),
		needMb,
		pairKey,
		evict: true,
		jobs: deps.jobs,
	});
	if (!res.ok) throw outOfCapacity(OUT_OF_CAPACITY_RETRY_SECONDS);
}
