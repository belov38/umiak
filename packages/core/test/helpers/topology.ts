// Test fixtures: topology (provider, node, storage, template build) and
// runtime rows (machines, sandboxes, operations) inserted with raw SQL.
// Every insert generates unique names, so many topologies share one database.
import { randomUUID } from "node:crypto";
import type pg from "pg";

/** Anything with `query`: a pool, a pooled client or a `Tx.client`. */
export type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

let seq = 0;
function nextSeq(): number {
	seq += 1;
	return seq;
}

// cluster_mac_id is unique per database (0-255); spread files apart by pid.
let macBase = (process.pid * 7) % 200;
function nextMacId(): number {
	macBase = (macBase + 1) % 256;
	return macBase;
}

export interface ProviderOptions {
	state?: "active" | "draining" | "disabled";
}

export async function insertProvider(
	q: Queryable,
	opts: ProviderOptions = {},
): Promise<string> {
	const id = randomUUID();
	const name = `prov-${nextSeq()}-${id.slice(0, 8)}`;
	await q.query(
		`INSERT INTO runtime.providers (id, kind, name, cluster_mac_id, vmid_min, vmid_max, api_url, secret_ref, state)
		 VALUES ($1, 'proxmox', $2, $3, 500, 598, 'https://pve:8006', $2, $4)`,
		[id, name, nextMacId(), opts.state ?? "active"],
	);
	return id;
}

export interface NodeOptions {
	ramCapMb?: number;
	cloneConcurrency?: number;
	state?: "active" | "cordoned" | "down";
}

export async function insertNode(
	q: Queryable,
	providerId: string,
	opts: NodeOptions = {},
): Promise<string> {
	const id = randomUUID();
	await q.query(
		`INSERT INTO runtime.nodes (id, provider_id, name, state, ram_cap_mb, clone_concurrency, node_agent_ref)
		 VALUES ($1, $2, $3, $4, $5, $6, 'sbx-node')`,
		[
			id,
			providerId,
			`node-${nextSeq()}`,
			opts.state ?? "active",
			opts.ramCapMb ?? 8192,
			opts.cloneConcurrency ?? 4,
		],
	);
	return id;
}

export interface StorageOptions {
	usage?: { dataPercent?: number; metadataPercent?: number } | null;
	dataMaxPct?: number;
	metaMaxPct?: number;
}

export async function insertStorage(
	q: Queryable,
	providerId: string,
	nodeId: string,
	opts: StorageOptions = {},
): Promise<string> {
	const id = randomUUID();
	await q.query(
		`INSERT INTO runtime.storages (id, provider_id, node_id, name, driver, data_max_pct, meta_max_pct, usage, usage_at)
		 VALUES ($1, $2, $3, $4, 'lvmthin', $5, $6, $7, CASE WHEN $7::jsonb IS NULL THEN NULL ELSE now() END)`,
		[
			id,
			providerId,
			nodeId,
			`local-lvm-${nextSeq()}`,
			opts.dataMaxPct ?? 80,
			opts.metaMaxPct ?? 70,
			opts.usage === undefined || opts.usage === null
				? null
				: JSON.stringify(opts.usage),
		],
	);
	return id;
}

export interface TemplateBuildOptions {
	templateSlug?: string;
	status?: "building" | "active" | "deprecated" | "retired";
	os?: "linux" | "windows";
	version?: string;
}

export async function insertTemplateBuild(
	q: Queryable,
	ids: { providerId: string; nodeId: string; storageId: string },
	opts: TemplateBuildOptions = {},
): Promise<string> {
	const id = randomUUID();
	await q.query(
		`INSERT INTO runtime.template_builds
		   (id, template_slug, version, os, provider_id, node_id, storage_id, pve_vmid, disk_layout, hw, boot_timeout_s, status)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, 599, '{}', '{}', 300, $8)`,
		[
			id,
			opts.templateSlug ?? "linux",
			opts.version ?? `v${nextSeq()}`,
			opts.os ?? "linux",
			ids.providerId,
			ids.nodeId,
			ids.storageId,
			opts.status ?? "active",
		],
	);
	return id;
}

export interface Topology {
	providerId: string;
	nodeId: string;
	storageId: string;
	templateBuildId: string;
	templateSlug: string;
}

export interface TopologyOptions {
	provider?: ProviderOptions;
	node?: NodeOptions;
	storage?: StorageOptions;
	build?: TemplateBuildOptions;
	/** Reuse an existing provider instead of creating one. */
	providerId?: string;
}

/** One provider (unless given), node, storage and active template build. */
export async function createTopology(
	q: Queryable,
	opts: TopologyOptions = {},
): Promise<Topology> {
	const providerId =
		opts.providerId ?? (await insertProvider(q, opts.provider));
	const nodeId = await insertNode(q, providerId, opts.node);
	const storageId = await insertStorage(q, providerId, nodeId, opts.storage);
	const templateSlug = opts.build?.templateSlug ?? "linux";
	const templateBuildId = await insertTemplateBuild(
		q,
		{ providerId, nodeId, storageId },
		{ ...opts.build, templateSlug },
	);
	return { providerId, nodeId, storageId, templateBuildId, templateSlug };
}

export interface MachineOptions {
	id?: string;
	state: string;
	memoryMb?: number;
	powerObserved?: "running" | "stopped" | "paused" | "unknown";
	poolKey?: string | null;
	sandboxId?: string | null;
	/** Seconds before now; sets warm_at. */
	warmAgoSeconds?: number;
	sizeSlug?: string;
}

export async function insertMachine(
	q: Queryable,
	topo: Topology,
	opts: MachineOptions,
): Promise<string> {
	const id = opts.id ?? randomUUID();
	await q.query(
		`INSERT INTO runtime.machines
		   (id, provider_id, node_id, storage_id, template_build_id, origin, pool_key, size_slug, vcpu, memory_mb,
		    sandbox_id, state, power_observed, warm_at)
		 VALUES ($1, $2, $3, $4, $5, 'template', $6, $7, 2, $8, $9, $10, $11,
		         CASE WHEN $12::int IS NULL THEN NULL ELSE now() - make_interval(secs => $12::int) END)`,
		[
			id,
			topo.providerId,
			topo.nodeId,
			topo.storageId,
			topo.templateBuildId,
			opts.poolKey ?? null,
			opts.sizeSlug ?? "2gb",
			opts.memoryMb ?? 2048,
			opts.sandboxId ?? null,
			opts.state,
			opts.powerObserved ?? "unknown",
			opts.warmAgoSeconds ?? null,
		],
	);
	return id;
}

export interface SandboxOptions {
	id?: string;
	teamId: string;
	state: string;
	memoryMb?: number;
	machineId?: string | null;
}

export async function insertSandbox(
	q: Queryable,
	topo: Topology,
	opts: SandboxOptions,
): Promise<string> {
	const id = opts.id ?? randomUUID();
	await q.query(
		`INSERT INTO runtime.sandboxes
		   (id, slug, team_id, template_slug, size_slug, vcpu, memory_mb, template_build_id, origin,
		    provider_id, node_id, machine_id, state)
		 VALUES ($1, $2, $3, $4, '2gb', 2, $5, $6, 'template', $7, $8, $9, $10)`,
		[
			id,
			`sbx-${id.slice(0, 8)}-${nextSeq()}`,
			opts.teamId,
			topo.templateSlug,
			opts.memoryMb ?? 2048,
			topo.templateBuildId,
			topo.providerId,
			topo.nodeId,
			opts.machineId ?? null,
			opts.state,
		],
	);
	return id;
}

export interface OperationOptions {
	id?: string;
	sandboxId: string;
	kind: string;
	state?: string;
}

export async function insertOperation(
	q: Queryable,
	opts: OperationOptions,
): Promise<string> {
	const id = opts.id ?? randomUUID();
	await q.query(
		`INSERT INTO runtime.operations (id, sandbox_id, kind, state) VALUES ($1, $2, $3, $4)`,
		[id, opts.sandboxId, opts.kind, opts.state ?? "pending"],
	);
	return id;
}

/**
 * A stopped machine that is the current machine of a sandbox, optionally with
 * an operation on that sandbox.
 */
export async function insertStoppedWithOperation(
	q: Queryable,
	topo: Topology,
	opts: {
		teamId?: string;
		memoryMb?: number;
		powerObserved?: MachineOptions["powerObserved"];
		operation?: { kind: string; state: string } | null;
	} = {},
): Promise<{ machineId: string; sandboxId: string }> {
	const sandboxId = randomUUID();
	const machineId = await insertMachine(q, topo, {
		state: "stopped",
		memoryMb: opts.memoryMb ?? 2048,
		powerObserved: opts.powerObserved ?? "stopped",
		sandboxId,
	});
	await insertSandbox(q, topo, {
		id: sandboxId,
		teamId: opts.teamId ?? randomUUID(),
		state: "stopped",
		memoryMb: opts.memoryMb ?? 2048,
		machineId,
	});
	if (opts.operation) {
		await insertOperation(q, { sandboxId, ...opts.operation });
	}
	return { machineId, sandboxId };
}
