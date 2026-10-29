import type { Tx } from "@sbx/db";
import type pg from "pg";

// Shared per-node semaphore for S1 clones (S6 §8.3). Pool provisioning, create
// and fork come from different queues, so the limit lives in the database.
// Slots are numbered 0..clone_concurrency-1. Acquire and release run outside
// the step's transaction (autocommit on the pool): the slot is held across the
// Proxmox call. A lost holder's slot expires by itself.

export const CLONE_SLOT_TTL_MS = 120_000;

type Queryable = Pick<pg.Pool, "query">;

/**
 * Takes a free or expired slot of the node; null when all are busy (the caller
 * retries later). Missing slot rows are created from `nodes.clone_concurrency`,
 * and slots at or above a lowered limit are never handed out.
 */
export async function acquireCloneSlot(
	pool: Queryable,
	nodeId: string,
	holder: string,
	ttlMs: number = CLONE_SLOT_TTL_MS,
): Promise<number | null> {
	await pool.query(
		`INSERT INTO runtime.node_clone_slots (node_id, slot)
		 SELECT n.id, g.slot FROM runtime.nodes n, generate_series(0, n.clone_concurrency - 1) AS g(slot)
		 WHERE n.id = $1
		 ON CONFLICT DO NOTHING`,
		[nodeId],
	);
	const r = await pool.query<{ slot: number }>(
		`UPDATE runtime.node_clone_slots c
		 SET holder = $2, expires_at = now() + make_interval(secs => $3::double precision / 1000)
		 WHERE (c.node_id, c.slot) = (
		   SELECT s.node_id, s.slot FROM runtime.node_clone_slots s
		   JOIN runtime.nodes n ON n.id = s.node_id
		   WHERE s.node_id = $1
		     AND s.slot < n.clone_concurrency
		     AND (s.holder IS NULL OR s.expires_at < now())
		   ORDER BY s.slot
		   LIMIT 1
		   FOR UPDATE OF s SKIP LOCKED)
		 RETURNING c.slot`,
		[nodeId, holder, ttlMs],
	);
	return r.rows[0]?.slot ?? null;
}

/** Frees the slot if `holder` still holds it (an expired and re-taken slot is not touched). */
export async function releaseCloneSlot(
	pool: Queryable,
	nodeId: string,
	slot: number,
	holder: string,
): Promise<void> {
	await pool.query(
		`UPDATE runtime.node_clone_slots SET holder = NULL, expires_at = NULL
		 WHERE node_id = $1 AND slot = $2 AND holder = $3`,
		[nodeId, slot, holder],
	);
}

/**
 * Makes the node have slots 0..n-1 (bootstrap, a changed `clone_concurrency`).
 * Extra slots are removed once free or expired; a held one stays until then
 * but is not handed out again while above the node's limit.
 */
export async function ensureCloneSlots(
	tx: Tx,
	nodeId: string,
	n: number,
): Promise<void> {
	await tx.client.query(
		`INSERT INTO runtime.node_clone_slots (node_id, slot)
		 SELECT $1, g FROM generate_series(0, $2::int - 1) AS g
		 ON CONFLICT DO NOTHING`,
		[nodeId, n],
	);
	await tx.client.query(
		`DELETE FROM runtime.node_clone_slots
		 WHERE node_id = $1 AND slot >= $2 AND (holder IS NULL OR expires_at < now())`,
		[nodeId, n],
	);
}
