import type { Tx } from "@umiak/db";
import { POWERED_SQL, RESERVED_SQL } from "./capacity.ts";
import { notFound } from "./errors.ts";
import { lockNode } from "./locks.ts";

/** Alias n is runtime.nodes; interrupted jobs deliberately keep the reservation. */
export const NODE_NOT_BUILDING_SQL = `NOT EXISTS (SELECT 1 FROM runtime.node_build_jobs nb
 WHERE nb.node_id = n.id AND nb.status IN ('running', 'interrupted'))`;

/** Called under lockNode by every admission/start path, including resume. */
export async function nodeAcceptsStarts(
	tx: Tx,
	nodeId: string,
): Promise<boolean> {
	const r = await tx.client.query<{ ok: boolean }>(
		`SELECT (n.retired_at IS NULL AND ${NODE_NOT_BUILDING_SQL}) AS ok FROM runtime.nodes n WHERE n.id=$1`,
		[nodeId],
	);
	return r.rows[0]?.ok ?? false;
}

/** Reserve before checking live PVE inventory, and before any host action. */
export async function beginNodeBuild(
	tx: Tx,
	input: { nodeId: string; jobId: string; templateSlug: string },
): Promise<void> {
	await lockNode(tx, input.nodeId);
	const n = await tx.client.query<{ eligible: boolean }>(
		`SELECT (n.state='active' AND n.retired_at IS NULL AND p.state='active') AS eligible FROM runtime.nodes n JOIN runtime.providers p ON p.id=n.provider_id WHERE n.id=$1`,
		[input.nodeId],
	);
	if (!n.rows[0]?.eligible)
		throw new Error("Template build requires an active node and provider");
	if (!(await nodeAcceptsStarts(tx, input.nodeId)))
		throw new Error("Node already has an unfinished template build");
	const busy = await tx.client.query(
		`SELECT 1 FROM runtime.machines m WHERE m.node_id=$1 AND m.state <> 'deleted' AND (${RESERVED_SQL} OR ${POWERED_SQL}) LIMIT 1`,
		[input.nodeId],
	);
	if (busy.rowCount)
		throw new Error(
			"Template build requires an idle node; stop machines and finish pending starts first",
		);
	await tx.client.query(
		"INSERT INTO runtime.node_build_jobs(id,node_id,template_slug) VALUES($1,$2,$3)",
		[input.jobId, input.nodeId, input.templateSlug],
	);
}

export async function interruptNodeBuild(
	tx: Tx,
	nodeId: string,
	jobId: string,
): Promise<void> {
	await lockNode(tx, nodeId);
	const r = await tx.client.query(
		"UPDATE runtime.node_build_jobs SET status='interrupted' WHERE id=$1 AND node_id=$2 AND status IN ('running','interrupted')",
		[jobId, nodeId],
	);
	if (!r.rowCount) throw new Error("No matching unfinished build reservation");
}

/** Trusted caller must verify all build/verification VMs stopped or removed first. */
export async function finishNodeBuild(
	tx: Tx,
	input: { nodeId: string; jobId: string; status: "succeeded" | "failed" },
): Promise<void> {
	await lockNode(tx, input.nodeId);
	const r = await tx.client.query(
		"UPDATE runtime.node_build_jobs SET status=$3,finished_at=now() WHERE id=$1 AND node_id=$2 AND status IN ('running','interrupted')",
		[input.jobId, input.nodeId, input.status],
	);
	if (!r.rowCount) throw new Error("No matching unfinished build reservation");
}

export interface NodeRemovalBlocker {
	kind: "machine" | "sandbox" | "snapshot" | "template" | "build" | "disk";
	id: string;
}

/** Caller holds lockNode so create/build/promotion cannot enter during inspection. */
export async function nodeRemovalBlockers(
	tx: Tx,
	nodeId: string,
): Promise<NodeRemovalBlocker[]> {
	const r = await tx.client.query<NodeRemovalBlocker>(
		`
 SELECT 'machine' AS kind,id::text FROM runtime.machines WHERE node_id=$1 AND state <> 'deleted'
 UNION ALL SELECT 'sandbox',id::text FROM runtime.sandboxes WHERE node_id=$1 AND state <> 'deleted'
 UNION ALL SELECT 'snapshot',id::text FROM runtime.snapshots WHERE node_id=$1 AND state <> 'deleted'
 UNION ALL SELECT 'template',id::text FROM runtime.template_builds WHERE node_id=$1 AND status <> 'retired'
 UNION ALL SELECT 'build',id FROM runtime.node_build_jobs WHERE node_id=$1 AND status IN ('running','interrupted')
 UNION ALL SELECT 'disk',d.id::text FROM runtime.disks d
 LEFT JOIN runtime.machines m ON m.id=d.machine_id
 LEFT JOIN runtime.snapshots s ON s.id=d.snapshot_id
 WHERE (m.node_id=$1 OR s.node_id=$1) AND d.state <> 'deleted'
 ORDER BY kind,id`,
		[nodeId],
	);
	return r.rows;
}

export async function retireNode(
	tx: Tx,
	nodeId: string,
): Promise<{ ok: true } | { ok: false; blockers: NodeRemovalBlocker[] }> {
	await lockNode(tx, nodeId);
	const n = await tx.client.query("SELECT id FROM runtime.nodes WHERE id=$1", [
		nodeId,
	]);
	if (!n.rowCount) throw notFound("node");
	const blockers = await nodeRemovalBlockers(tx, nodeId);
	if (blockers.length) return { ok: false, blockers };
	await tx.client.query(
		"UPDATE runtime.nodes SET state='cordoned',retired_at=COALESCE(retired_at,now()),updated_at=now() WHERE id=$1",
		[nodeId],
	);
	return { ok: true };
}

/** Host preparation and pin verification must succeed before reactivation. */
export async function reactivateNode(tx: Tx, nodeId: string): Promise<void> {
	await lockNode(tx, nodeId);
	const r = await tx.client.query(
		"UPDATE runtime.nodes n SET retired_at=NULL,state='active',updated_at=now() WHERE n.id=$1 AND NOT EXISTS (SELECT 1 FROM runtime.node_build_jobs b WHERE b.node_id=n.id AND b.status IN ('running','interrupted')) RETURNING id",
		[nodeId],
	);
	if (!r.rowCount)
		throw new Error("Unknown node or unfinished build reservation");
}

/** Verified registration only; serialize promotion against removal and placement. */
export async function promoteNodeTemplate(
	tx: Tx,
	input: { nodeId: string; buildId: string; jobId?: string },
): Promise<void> {
	await lockNode(tx, input.nodeId);
	const n = await tx.client.query<{ eligible: boolean }>(
		"SELECT (n.state='active' AND n.retired_at IS NULL AND p.state='active') AS eligible FROM runtime.nodes n JOIN runtime.providers p ON p.id=n.provider_id WHERE n.id=$1",
		[input.nodeId],
	);
	if (!n.rows[0]?.eligible)
		throw new Error("Template promotion requires an active node");
	const reservation = await tx.client.query<{
		id: string;
		template_slug: string;
	}>(
		"SELECT id,template_slug FROM runtime.node_build_jobs WHERE node_id=$1 AND status IN ('running','interrupted')",
		[input.nodeId],
	);
	if (reservation.rows[0] && reservation.rows[0].id !== input.jobId)
		throw new Error("Template build reservation belongs to another job");
	if (input.jobId && reservation.rows[0]?.id !== input.jobId)
		throw new Error("No matching template build reservation");
	const build = await tx.client.query<{ template_slug: string }>(
		"SELECT tb.template_slug FROM runtime.template_builds tb JOIN runtime.storages st ON st.id=tb.storage_id AND st.node_id=tb.node_id AND st.provider_id=tb.provider_id WHERE tb.id=$1 AND tb.node_id=$2 AND tb.status IN ('building','active','deprecated')",
		[input.buildId, input.nodeId],
	);
	if (!build.rows[0]) throw new Error("Unknown or retired template build");
	if (
		reservation.rows[0] &&
		reservation.rows[0].template_slug !== build.rows[0].template_slug
	)
		throw new Error("Build reservation is for a different template");
	await tx.client.query(
		"UPDATE runtime.template_builds SET status='deprecated' WHERE node_id=$1 AND template_slug=$2 AND status='active' AND id<>$3",
		[input.nodeId, build.rows[0].template_slug, input.buildId],
	);
	await tx.client.query(
		"UPDATE runtime.template_builds SET status='active',promoted_at=now() WHERE id=$1",
		[input.buildId],
	);
}
