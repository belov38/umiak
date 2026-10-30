import { QUOTA_ACTIVE_SANDBOX_STATES } from "./capacity.ts";
import { isUuid, type Queryable } from "./service/common.ts";

// Team usage for `GET /v1/limits` (S7 §13, §20.2 item 5), counted by the
// quota rules of `checkQuota` (S6 §8.5): sandboxes and their RAM in
// QUOTA_ACTIVE_SANDBOX_STATES, saved snapshots in `creating` and `ready`.

export interface TeamUsage {
	activeSandboxes: number;
	ramMb: number;
	savedSnapshots: number;
}

export async function teamUsage(
	q: Queryable,
	teamId: string,
): Promise<TeamUsage> {
	if (!isUuid(teamId))
		return { activeSandboxes: 0, ramMb: 0, savedSnapshots: 0 };
	const r = await q.query<{ n: number; ram_mb: number; saved: number }>(
		`SELECT
		   (SELECT count(*)::int FROM runtime.sandboxes
		    WHERE team_id = $1 AND state = ANY($2::text[])) AS n,
		   (SELECT COALESCE(SUM(memory_mb), 0)::int FROM runtime.sandboxes
		    WHERE team_id = $1 AND state = ANY($2::text[])) AS ram_mb,
		   (SELECT count(*)::int FROM runtime.snapshots
		    WHERE team_id = $1 AND kind = 'saved' AND state IN ('creating', 'ready')) AS saved`,
		[teamId, QUOTA_ACTIVE_SANDBOX_STATES],
	);
	const row = r.rows[0];
	return {
		activeSandboxes: row?.n ?? 0,
		ramMb: row?.ram_mb ?? 0,
		savedSnapshots: row?.saved ?? 0,
	};
}
