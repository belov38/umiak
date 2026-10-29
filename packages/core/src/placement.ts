import type { Tx } from "@sbx/db";
import { RESERVED_SQL } from "./capacity.ts";

/**
 * Storage below its data/metadata thresholds (S6 §8.4, S1: 80% / 70%); no
 * usage sample yet counts as below. Alias `st` = storages.
 */
export const STORAGE_BELOW_THRESHOLDS_SQL = `(COALESCE((st.usage ->> 'dataPercent')::numeric, 0) < st.data_max_pct
  AND COALESCE((st.usage ->> 'metadataPercent')::numeric, 0) < st.meta_max_pct)`;

export interface PlaceInput {
	templateSlug: string;
	needMb: number;
	/** Count other pairs' warm machines as available (admission with eviction). */
	evict?: boolean;
	/** Pair of the request; its warm machines are not evictable. */
	pairKey?: string | null;
}

export interface PlacementCandidate {
	nodeId: string;
	providerId: string;
	storageId: string;
	templateBuildId: string;
	/** `cap - reserved` at the time of the query. */
	freeMb: number;
}

/**
 * Placement candidates (S6 §8.4), most free RAM first: provider and node
 * `active`, an `active` build of the template on the node, its storage below
 * the data/metadata thresholds, and RAM for `needMb` (free, plus evictable warm
 * machines of other pairs when `evict`). Storage without a usage sample yet
 * counts as below the thresholds. RAM is read without node locks: the caller
 * confirms with `admit` on each candidate in order.
 */
/** Why a fixed node takes no new disks (§8.4), carried as `details.reason` of `out_of_capacity`. */
export type UnplaceableReason = "node_not_active" | "storage_over_threshold";

/**
 * The fixed node of an admission that makes new disks there (fork, create
 * from a saved snapshot): provider and node `active` (a draining node takes
 * no new machines) and the storage below its thresholds, as `place` requires
 * of a candidate. Null when the node is placeable.
 */
export async function nodeUnplaceable(
	tx: Tx,
	nodeId: string,
	storageId: string,
): Promise<UnplaceableReason | null> {
	const r = await tx.client.query<{ active: boolean; below: boolean }>(
		`SELECT (n.state = 'active' AND p.state = 'active') AS active,
		   COALESCE((SELECT ${STORAGE_BELOW_THRESHOLDS_SQL} FROM runtime.storages st WHERE st.id = $2), false) AS below
		 FROM runtime.nodes n
		 JOIN runtime.providers p ON p.id = n.provider_id
		 WHERE n.id = $1`,
		[nodeId, storageId],
	);
	const row = r.rows[0];
	if (row === undefined || !row.active) return "node_not_active";
	return row.below ? null : "storage_over_threshold";
}

export async function place(
	tx: Tx,
	input: PlaceInput,
): Promise<PlacementCandidate[]> {
	const r = await tx.client.query<{
		node_id: string;
		provider_id: string;
		storage_id: string;
		template_build_id: string;
		free_mb: number;
	}>(
		`SELECT n.id AS node_id, n.provider_id, tb.storage_id, tb.id AS template_build_id,
		   (n.ram_cap_mb - ram.reserved_mb)::int AS free_mb
		 FROM runtime.nodes n
		 JOIN runtime.providers p ON p.id = n.provider_id AND p.state = 'active'
		 JOIN runtime.template_builds tb
		   ON tb.node_id = n.id AND tb.template_slug = $1 AND tb.status = 'active'
		 JOIN runtime.storages st ON st.id = tb.storage_id
		 CROSS JOIN LATERAL (
		   SELECT
		     COALESCE(SUM(m.memory_mb) FILTER (WHERE ${RESERVED_SQL}), 0) AS reserved_mb,
		     COALESCE(SUM(m.memory_mb) FILTER (
		       WHERE m.state = 'warm' AND m.pool_key IS DISTINCT FROM $4), 0) AS evictable_mb
		   FROM runtime.machines m
		   WHERE m.node_id = n.id AND m.state <> 'deleted'
		 ) ram
		 WHERE n.state = 'active'
		   AND ${STORAGE_BELOW_THRESHOLDS_SQL}
		   AND n.ram_cap_mb - ram.reserved_mb
		       + CASE WHEN $3::boolean THEN ram.evictable_mb ELSE 0 END >= $2
		 ORDER BY free_mb DESC, n.id`,
		[
			input.templateSlug,
			input.needMb,
			input.evict ?? false,
			input.pairKey ?? null,
		],
	);
	return r.rows.map((row) => ({
		nodeId: row.node_id,
		providerId: row.provider_id,
		storageId: row.storage_id,
		templateBuildId: row.template_build_id,
		freeMb: row.free_mb,
	}));
}
