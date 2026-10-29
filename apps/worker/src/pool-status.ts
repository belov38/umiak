// Read-only status queries shared by `sbx-admin pool status` and the
// scrape-time gauges of /metrics.
import { POWERED_SQL, RESERVED_SQL } from "@sbx/core";
import type pg from "pg";

type Queryable = Pick<pg.Pool, "query">;

export interface PoolCount {
	pair: string;
	state: string;
	count: number;
}

/** Machines of the warm pool (not claimed yet) per pair and state. */
export async function poolCounts(q: Queryable): Promise<PoolCount[]> {
	const r = await q.query<{ pair: string; state: string; n: number }>(
		`SELECT pool_key AS pair, state, count(*)::int AS n
		 FROM runtime.machines
		 WHERE pool_key IS NOT NULL AND state <> 'deleted'
		 GROUP BY pool_key, state
		 ORDER BY pool_key, state`,
	);
	return r.rows.map((x) => ({ pair: x.pair, state: x.state, count: x.n }));
}

export interface NodeRamStatus {
	nodeId: string;
	node: string;
	provider: string;
	state: string;
	capMb: number;
	reservedMb: number;
	poweredMb: number;
}

/** Cap, reserved and powered RAM of every node (S6 §8.1). */
export async function nodeRam(q: Queryable): Promise<NodeRamStatus[]> {
	const r = await q.query<{
		node_id: string;
		node: string;
		provider: string;
		state: string;
		cap_mb: number;
		reserved_mb: number;
		powered_mb: number;
	}>(
		`SELECT n.id AS node_id, n.name AS node, p.name AS provider, n.state,
		   n.ram_cap_mb AS cap_mb,
		   COALESCE(SUM(m.memory_mb) FILTER (WHERE ${RESERVED_SQL}), 0)::int AS reserved_mb,
		   COALESCE(SUM(m.memory_mb) FILTER (WHERE ${POWERED_SQL}), 0)::int AS powered_mb
		 FROM runtime.nodes n
		 JOIN runtime.providers p ON p.id = n.provider_id
		 LEFT JOIN runtime.machines m ON m.node_id = n.id AND m.state <> 'deleted'
		 GROUP BY n.id, p.name
		 ORDER BY p.name, n.name`,
	);
	return r.rows.map((x) => ({
		nodeId: x.node_id,
		node: x.node,
		provider: x.provider,
		state: x.state,
		capMb: x.cap_mb,
		reservedMb: x.reserved_mb,
		poweredMb: x.powered_mb,
	}));
}
