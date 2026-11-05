import { POWERED_SQL, RESERVED_SQL } from "@umiak/core";
import type pg from "pg";

type Queryable = Pick<pg.Pool, "query">;

export interface NodeRamStatus {
	nodeId: string;
	node: string;
	provider: string;
	state: string;
	/** Legacy unallocated rows: retained for operator inspection, never reclaimed automatically. */
	quarantinedMachines: number;
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
		quarantined: number;
		cap_mb: number;
		reserved_mb: number;
		powered_mb: number;
	}>(
		`SELECT n.id AS node_id, n.name AS node, p.name AS provider, n.state,
		   n.ram_cap_mb AS cap_mb,
           COUNT(m.id) FILTER (WHERE m.sandbox_id IS NULL AND (m.pool_key IS NOT NULL OR m.state = 'warm') AND NOT EXISTS (SELECT 1 FROM runtime.sandboxes s WHERE s.machine_id = m.id))::int AS quarantined,
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
		quarantinedMachines: x.quarantined,
		reservedMb: x.reserved_mb,
		poweredMb: x.powered_mb,
	}));
}
