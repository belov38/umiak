import type { Tx } from "@umiak/db";
import { admit } from "../capacity.ts";
import { outOfCapacity, snapshotNotFound } from "../errors.ts";
import { uuidv7 } from "../ids.ts";
import { nodeUnplaceable, place } from "../placement.ts";

// Cold admission on a placement candidate or the node of a saved snapshot.

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
	/** The id of the new `allocating` machine. */
	machineId: string;
	nodeId: string;
	providerId: string;
	storageId: string;
	templateBuildId: string;
	originSnapshotId: string | null;
}

/**
 * Cold admission (S6 §8.2) on placement candidates, using available RAM. Candidates keep the §8.4 order (most free RAM first): `admit`
 * gives back the node lock of a refused candidate, so this loop holds at most
 * one node lock at any time and cannot deadlock with another one.
 */
export async function admitCold(
	tx: Tx,
	templateSlug: string,
	needMb: number,
	selectedNodeId?: string,
): Promise<Placement> {
	const candidates = await place(tx, {
		templateSlug,
		needMb,
	});
	for (const c of candidates) {
		if (selectedNodeId && c.nodeId !== selectedNodeId) continue;
		const res = await admit(tx, {
			nodeId: c.nodeId,
			storageId: c.storageId,
			templateBuildId: c.templateBuildId,
			needMb,
		});
		if (res.ok) {
			return {
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
	snap: SavedSource,
	needMb: number,
): Promise<Placement> {
	const destination = await admitLocalSource(tx, snap, needMb);
	return {
		machineId: uuidv7(),
		nodeId: destination.nodeId,
		providerId: snap.providerId,
		storageId: destination.storageId,
		templateBuildId: snap.templateBuildId,
		originSnapshotId: snap.id,
	};
}

/**
 * Admission on a fixed node (resume, recover, fork: the disks are local to
 * it); `out_of_capacity` otherwise.
 */
export async function admitOnNode(
	tx: Tx,
	nodeId: string,
	needMb: number,
	storageId?: string,
): Promise<void> {
	const res = await admit(tx, {
		nodeId,
		...(storageId !== undefined ? { storageId } : {}),
		needMb,
	});
	if (!res.ok) throw outOfCapacity(OUT_OF_CAPACITY_RETRY_SECONDS);
}

/** Admission stays on the node holding the immutable source disks. */
export async function admitLocalSource(
	tx: Tx,
	source: {
		nodeId: string;
		storageId: string;
		providerId: string;
		templateBuildId: string;
		templateSlug: string;
	},
	needMb: number,
): Promise<{
	nodeId: string;
	storageId: string;
	templateBuildId: string;
	providerId: string;
}> {
	const homeReason = await nodeUnplaceable(tx, source.nodeId, source.storageId);
	if (homeReason === null) {
		const home = await admit(tx, {
			nodeId: source.nodeId,
			storageId: source.storageId,
			needMb,
		});
		if (home.ok) return source;
	}
	throw outOfCapacity(
		OUT_OF_CAPACITY_RETRY_SECONDS,
		undefined,
		homeReason ?? undefined,
	);
}
