import type { Tx } from "@umiak/db";

// Transaction-scoped advisory locks (S6 §8.1, §8.5). Lock order is always
// team, then node; taking them in the other order risks a deadlock.
// Re-taking a lock the transaction already holds is a no-op.

export async function lockTeam(tx: Tx, teamId: string): Promise<void> {
	await tx.client.query(
		"SELECT pg_advisory_xact_lock(hashtextextended('team:' || $1::text, 0))",
		[teamId],
	);
}

export async function lockNode(tx: Tx, nodeId: string): Promise<void> {
	await tx.client.query(
		"SELECT pg_advisory_xact_lock(hashtextextended('node:' || $1::text, 0))",
		[nodeId],
	);
}

/** Build admission excludes destructive reconcile work without holding node locks
 * while waiting for the worker power lock. Build callers hold node first; cleanup
 * takes this shared barrier only and never acquires a node lock inside it. */
export async function lockNodeBuildCleanup(
	tx: Tx,
	nodeId: string,
	mode: "build" | "cleanup",
): Promise<void> {
	const fn =
		mode === "build" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared";
	await tx.client.query(
		`SELECT ${fn}(hashtextextended('node-build-cleanup:' || $1::text,0))`,
		[nodeId],
	);
}
