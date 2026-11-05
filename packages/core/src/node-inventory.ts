import type { Tx } from "@umiak/db";
import type pg from "pg";
import { nodeRam } from "./capacity.ts";
import { uuidv7 } from "./ids.ts";
import { lockNode } from "./locks.ts";

export interface SandboxNodeConfig {
	providerId: string;
	name: string;
	sshHost: string;
	storage: string;
	mediaStorage: string;
	ramCapMb: number;
	cloneConcurrency?: number;
}
export interface SandboxNodeInventory {
	nodeId: string;
	providerId: string;
	name: string;
	state: "active" | "cordoned" | "down";
	sshHost: string;
	ramCapMb: number;
	cloneConcurrency: number;
	storageId: string;
	storage: string;
	mediaStorage: string;
	buildJobId: string | null;
	templates: { templateSlug: string; version: string; pveVmid: number }[];
}

/** Operator/installer inventory. Never expose SSH endpoints on member catalog routes. */
export async function sandboxNodeInventory(
	q: Pick<pg.Pool, "query">,
	providerId: string,
): Promise<SandboxNodeInventory[]> {
	const r = await q.query<SandboxNodeInventory>(
		`SELECT n.id AS "nodeId",n.provider_id AS "providerId",n.name,n.state,
 n.node_agent_ref AS "sshHost",n.ram_cap_mb AS "ramCapMb",n.clone_concurrency AS "cloneConcurrency",
 st.id AS "storageId",st.name AS storage,n.media_storage AS "mediaStorage",b.id AS "buildJobId",
 COALESCE((SELECT jsonb_agg(jsonb_build_object('templateSlug',tb.template_slug,'version',tb.version,'pveVmid',tb.pve_vmid) ORDER BY tb.template_slug) FROM runtime.template_builds tb WHERE tb.node_id=n.id AND tb.status='active'),'[]'::jsonb) AS templates
 FROM runtime.nodes n
 JOIN LATERAL (SELECT id,name FROM runtime.storages WHERE node_id=n.id AND provider_id=n.provider_id AND driver='lvmthin' ORDER BY name LIMIT 1) st ON true
 LEFT JOIN LATERAL (SELECT j.id FROM runtime.node_build_jobs j WHERE j.node_id=n.id AND (j.status IN ('running','interrupted') OR (j.status='failed' AND EXISTS (SELECT 1 FROM runtime.volume_transfers v WHERE 'copy-' || v.id=j.id AND v.phase NOT IN ('done','cancelled')))) ORDER BY (j.status IN ('running','interrupted')) DESC,j.created_at DESC LIMIT 1) b ON true
 WHERE n.provider_id=$1 AND n.retired_at IS NULL ORDER BY n.name,n.id`,
		[providerId],
	);
	return r.rows;
}

/** Trusted caller first verifies cluster membership, host pins and prerequisites. One node per transaction. */
export async function registerSandboxNode(
	tx: Tx,
	input: SandboxNodeConfig,
): Promise<{ nodeId: string; storageId: string }> {
	const name = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
	if (
		!name.test(input.name) ||
		!name.test(input.storage) ||
		!name.test(input.mediaStorage) ||
		!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,252}$/.test(input.sshHost)
	)
		throw new Error("Invalid node or storage name or SSH host");
	if (!Number.isSafeInteger(input.ramCapMb) || input.ramCapMb <= 0)
		throw new Error("Invalid node RAM cap");
	const concurrency = input.cloneConcurrency ?? 1;
	if (!Number.isSafeInteger(concurrency) || concurrency < 1)
		throw new Error("Invalid clone concurrency");
	const provider = await tx.client.query(
		"SELECT id FROM runtime.providers WHERE id=$1 AND state='active'",
		[input.providerId],
	);
	if (!provider.rowCount)
		throw new Error("Node registration requires an active provider");
	const inserted = await tx.client.query<{ id: string }>(
		`INSERT INTO runtime.nodes(id,provider_id,name,node_agent_ref,ram_cap_mb,clone_concurrency,media_storage) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider_id,name) DO NOTHING RETURNING id`,
		[
			uuidv7(),
			input.providerId,
			input.name,
			input.sshHost,
			input.ramCapMb,
			concurrency,
			input.mediaStorage,
		],
	);
	const nodeId =
		inserted.rows[0]?.id ??
		(
			await tx.client.query<{ id: string }>(
				"SELECT id FROM runtime.nodes WHERE provider_id=$1 AND name=$2",
				[input.providerId, input.name],
			)
		).rows[0]?.id;
	if (!nodeId) throw new Error("Node registration lost its topology row");
	await lockNode(tx, nodeId);
	const building = await tx.client.query(
		"SELECT id FROM runtime.node_build_jobs WHERE node_id=$1 AND status IN ('running','interrupted')",
		[nodeId],
	);
	if (building.rowCount)
		throw new Error("Node has an unfinished build reservation");
	const ram = await nodeRam(tx, nodeId);
	if (Math.max(ram.reservedMb, ram.poweredMb) > input.ramCapMb)
		throw new Error(
			"Node RAM cap is below existing reservations or powered machines",
		);
	const storages = await tx.client.query<{ id: string; name: string }>(
		"SELECT id,name FROM runtime.storages WHERE node_id=$1 AND driver='lvmthin' ORDER BY name",
		[nodeId],
	);
	if (storages.rows.some((st) => st.name !== input.storage))
		throw new Error(
			"Changing a node's local sandbox storage requires an explicit storage migration",
		);
	await tx.client.query(
		"UPDATE runtime.nodes SET node_agent_ref=$2,ram_cap_mb=$3,clone_concurrency=$4,media_storage=$5,retired_at=NULL,state='active',updated_at=now() WHERE id=$1",
		[nodeId, input.sshHost, input.ramCapMb, concurrency, input.mediaStorage],
	);
	const storage = await tx.client.query<{ id: string }>(
		`INSERT INTO runtime.storages(provider_id,node_id,name,driver) VALUES($1,$2,$3,'lvmthin') ON CONFLICT(provider_id,node_id,name) DO UPDATE SET driver='lvmthin' RETURNING id`,
		[input.providerId, nodeId, input.storage],
	);
	const storageId = storage.rows[0]?.id;
	if (!storageId) throw new Error("Node registration lost its storage row");
	return { nodeId, storageId };
}
