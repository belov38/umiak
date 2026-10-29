// sbx-admin (S6 §15.3, decision 14): operator commands over the database.
// Every result is one JSON object per line on `out`; errors go to `err`.
// The exit code is 0 on success and 1 on any error.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import type {
	ConfigReader,
	StaticConfigReader,
	TopologyConfig,
} from "@sbx/config";
import {
	DELETE_RETRY_LIMIT,
	ensureCloneSlots,
	isUuid,
	type JobSender,
	KeyRing,
	loadOperation,
	TERMINAL_OPERATION_STATES,
} from "@sbx/core";
import { dbOf, MIGRATIONS_DIR, migrate, type Tx, withTx } from "@sbx/db";
import type pg from "pg";
import type { Logger } from "pino";
import { DEFAULT_TIMING, NoopMetrics, type WorkerCtx } from "../context.ts";
import { runReconcile } from "../controllers/reconcile.ts";
import { withMachineLocked } from "../db.ts";
import { errText } from "../log.ts";
import { nodeRam, poolCounts } from "../pool-status.ts";
import type { AgentPort, GatewayPort, InfraRegistry } from "../ports.ts";

type Line = Record<string, unknown>;

export interface AdminDeps {
	pool: pg.Pool;
	out(line: Line): void;
	err(line: Line): void;
	/** The YAML config (SBX_CONFIG_FILE); absent when the variable is unset. */
	config?: () => StaticConfigReader;
	/** A started pg-boss sender (op retry, machine delete). */
	jobs?: () => Promise<JobSender>;
	/** Real infrastructure (SBX_SECRETS_DIR); reconcile only. */
	infra?: () => InfraRegistry & { close?(): Promise<void> };
	/** Data key ring (SBX_DATA_KEYS_FILE); optional for reconcile. */
	keys?: () => KeyRing;
	log: Logger;
	migrationsDir?: string;
}

export const USAGE = `usage: sbx-admin <command>
  migrate
  bootstrap                                  topology and template builds from SBX_CONFIG_FILE
  providers add --name N --cluster-mac-id N --vmid-min N --vmid-max N --api-url URL --secret-ref R [--tls-name T]
  nodes add --provider P --name N --ram-cap-mb N --node-agent-ref R [--clone-concurrency 4] [--storage local-lvm]
  nodes cordon|uncordon <node> [--provider P]
  template register --template T --version V --os linux|windows --node N --storage S --pve-vmid N --boot-timeout-s N
                    [--agent-version V] [--disk-layout JSON] [--hw JSON] [--provider P] [--promote]
  template promote <buildId>
  pool status
  reconcile --dry-run [--provider P]
  op retry <operationId>
  machine delete <machineId> [--force]`;

export class UsageError extends Error {
	constructor(message: string) {
		super(`${message}\n${USAGE}`);
		this.name = "UsageError";
	}
}

class AdminError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdminError";
	}
}

type Spec = Record<string, { type: "string" | "boolean" }>;
type Values = Record<string, string | boolean | undefined>;

function parse(
	args: string[],
	options: Spec,
): { values: Values; positionals: string[] } {
	try {
		const r = parseArgs({
			args,
			options,
			strict: true,
			allowPositionals: true,
		});
		return { values: r.values as Values, positionals: r.positionals };
	} catch (e) {
		throw new UsageError(errText(e));
	}
}

function req(v: Values, name: string): string {
	const x = v[name];
	if (typeof x !== "string" || x === "") {
		throw new UsageError(`--${name} is required`);
	}
	return x;
}

function opt(v: Values, name: string): string | undefined {
	const x = v[name];
	return typeof x === "string" ? x : undefined;
}

function int(v: Values, name: string, dflt?: number): number {
	if (v[name] === undefined && dflt !== undefined) return dflt;
	const s = req(v, name);
	if (!/^-?\d+$/.test(s)) throw new UsageError(`--${name} must be an integer`);
	return Number(s);
}

function json(v: Values, name: string): unknown {
	const x = v[name];
	if (x === undefined) return {};
	try {
		return JSON.parse(String(x));
	} catch {
		throw new UsageError(`--${name} must be JSON`);
	}
}

function one(positionals: string[], what: string): string {
	const [x, ...rest] = positionals;
	if (x === undefined || rest.length > 0) {
		throw new UsageError(`expected exactly one ${what}`);
	}
	return x;
}

/** Runs one command; returns the process exit code. */
export async function runAdmin(
	argv: string[],
	deps: AdminDeps,
): Promise<number> {
	try {
		await dispatch(argv, deps);
		return 0;
	} catch (e) {
		deps.err({ error: errText(e) });
		return 1;
	}
}

async function dispatch(argv: string[], d: AdminDeps): Promise<void> {
	const [cmd, sub, ...rest] = argv;
	switch (cmd) {
		case "migrate":
			return cmdMigrate(argv.slice(1), d);
		case "bootstrap":
			return cmdBootstrap(argv.slice(1), d);
		case "reconcile":
			return cmdReconcile(argv.slice(1), d);
	}
	const key = `${cmd ?? ""} ${sub ?? ""}`.trim();
	switch (key) {
		case "providers add":
			return cmdProvidersAdd(rest, d);
		case "nodes add":
			return cmdNodesAdd(rest, d);
		case "nodes cordon":
			return cmdNodeState(rest, d, "cordoned");
		case "nodes uncordon":
			return cmdNodeState(rest, d, "active");
		case "template register":
			return cmdTemplateRegister(rest, d);
		case "template promote":
			return cmdTemplatePromote(rest, d);
		case "pool status":
			return cmdPoolStatus(rest, d);
		case "op retry":
			return cmdOpRetry(rest, d);
		case "machine delete":
			return cmdMachineDelete(rest, d);
	}
	throw new UsageError(key === "" ? "no command" : `unknown command: ${key}`);
}

// ---------------------------------------------------------------------------
// migrate

async function cmdMigrate(args: string[], d: AdminDeps): Promise<void> {
	parse(args, {});
	const r = await migrate(d.pool, {
		dir: d.migrationsDir ?? MIGRATIONS_DIR,
		log: (msg) => d.log.info(msg),
	});
	d.out({ kind: "migrate", applied: r.applied });
}

// ---------------------------------------------------------------------------
// Topology upserts (bootstrap, providers add, nodes add)

/** Serializes topology writes of concurrent sbx-admin runs. */
async function lockTopology(tx: Tx): Promise<void> {
	await tx.client.query(
		"SELECT pg_advisory_xact_lock(hashtextextended('sbx-admin:topology', 0))",
	);
}

interface ProviderInput {
	name: string;
	clusterMacId: number;
	vmidMin: number;
	vmidMax: number;
	apiUrl: string;
	tlsName: string | null;
	secretRef: string;
}

async function upsertProvider(
	tx: Tx,
	p: ProviderInput,
): Promise<{ id: string; created: boolean }> {
	const r = await tx.client.query<{ id: string; created: boolean }>(
		`INSERT INTO runtime.providers
		   (kind, name, cluster_mac_id, vmid_min, vmid_max, api_url, tls_name, secret_ref)
		 VALUES ('proxmox', $1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (name) DO UPDATE
		 SET cluster_mac_id = EXCLUDED.cluster_mac_id, vmid_min = EXCLUDED.vmid_min,
		     vmid_max = EXCLUDED.vmid_max, api_url = EXCLUDED.api_url,
		     tls_name = EXCLUDED.tls_name, secret_ref = EXCLUDED.secret_ref, updated_at = now()
		 RETURNING id, (xmax = 0) AS created`,
		[
			p.name,
			p.clusterMacId,
			p.vmidMin,
			p.vmidMax,
			p.apiUrl,
			p.tlsName,
			p.secretRef,
		],
	);
	const row = r.rows[0];
	if (!row) throw new Error(`provider ${p.name}: upsert returned nothing`);
	return row;
}

interface NodeInput {
	providerId: string;
	name: string;
	ramCapMb: number;
	cloneConcurrency: number;
	nodeAgentRef: string;
}

/** Upsert; the state (cordoned, down) is the operator's and is kept. */
async function upsertNode(
	tx: Tx,
	n: NodeInput,
): Promise<{ id: string; created: boolean; state: string }> {
	const r = await tx.client.query<{
		id: string;
		created: boolean;
		state: string;
	}>(
		`INSERT INTO runtime.nodes (provider_id, name, ram_cap_mb, clone_concurrency, node_agent_ref)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (provider_id, name) DO UPDATE
		 SET ram_cap_mb = EXCLUDED.ram_cap_mb, clone_concurrency = EXCLUDED.clone_concurrency,
		     node_agent_ref = EXCLUDED.node_agent_ref, updated_at = now()
		 RETURNING id, state, (xmax = 0) AS created`,
		[n.providerId, n.name, n.ramCapMb, n.cloneConcurrency, n.nodeAgentRef],
	);
	const row = r.rows[0];
	if (!row) throw new Error(`node ${n.name}: upsert returned nothing`);
	await ensureCloneSlots(tx, row.id, n.cloneConcurrency);
	return row;
}

interface StorageInput {
	providerId: string;
	nodeId: string | null;
	name: string;
	dataMaxPct: number;
	metaMaxPct: number;
}

async function upsertStorage(
	tx: Tx,
	s: StorageInput,
): Promise<{ id: string; created: boolean }> {
	const r = await tx.client.query<{ id: string; created: boolean }>(
		`INSERT INTO runtime.storages (provider_id, node_id, name, driver, data_max_pct, meta_max_pct)
		 VALUES ($1, $2, $3, 'lvmthin', $4, $5)
		 ON CONFLICT (provider_id, node_id, name) DO UPDATE
		 SET data_max_pct = EXCLUDED.data_max_pct, meta_max_pct = EXCLUDED.meta_max_pct
		 RETURNING id, (xmax = 0) AS created`,
		[s.providerId, s.nodeId, s.name, s.dataMaxPct, s.metaMaxPct],
	);
	const row = r.rows[0];
	if (!row) throw new Error(`storage ${s.name}: upsert returned nothing`);
	return row;
}

/** Node-local storage of that name first, else a shared one of the provider. */
async function findStorage(
	tx: Tx,
	providerId: string,
	nodeId: string,
	name: string,
): Promise<string> {
	const r = await tx.client.query<{ id: string }>(
		`SELECT id FROM runtime.storages
		 WHERE provider_id = $1 AND name = $3 AND (node_id = $2 OR node_id IS NULL)
		 ORDER BY node_id NULLS LAST LIMIT 1`,
		[providerId, nodeId, name],
	);
	const id = r.rows[0]?.id;
	if (!id) throw new AdminError(`storage ${name} not found on the node`);
	return id;
}

interface NodeRef {
	id: string;
	name: string;
	provider_id: string;
	provider: string;
}

/** A node by id, or by name (unique, or within `--provider`). */
async function findNode(
	q: Pick<pg.Pool, "query">,
	ref: string,
	provider?: string,
): Promise<NodeRef> {
	const r = await q.query<NodeRef>(
		`SELECT n.id, n.name, n.provider_id, p.name AS provider
		 FROM runtime.nodes n JOIN runtime.providers p ON p.id = n.provider_id
		 WHERE ($1::uuid IS NOT NULL AND n.id = $1::uuid) OR n.name = $2
		 ORDER BY p.name`,
		[isUuid(ref) ? ref : null, ref],
	);
	const rows =
		provider === undefined
			? r.rows
			: r.rows.filter(
					(x) => x.provider === provider || x.provider_id === provider,
				);
	const [first, ...more] = rows;
	if (!first) throw new AdminError(`node ${ref} not found`);
	if (more.length > 0) {
		throw new AdminError(
			`node name ${ref} is ambiguous (providers ${rows.map((x) => x.provider).join(", ")}); pass --provider`,
		);
	}
	return first;
}

async function findProvider(
	q: Pick<pg.Pool, "query">,
	ref: string,
): Promise<{ id: string; name: string }> {
	const r = await q.query<{ id: string; name: string }>(
		`SELECT id, name FROM runtime.providers
		 WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR name = $2`,
		[isUuid(ref) ? ref : null, ref],
	);
	const row = r.rows[0];
	if (!row) throw new AdminError(`provider ${ref} not found`);
	return row;
}

// ---------------------------------------------------------------------------
// Template builds

interface BuildRow {
	id: string;
	template_slug: string;
	version: string;
	node_id: string;
	status: string;
}

/**
 * Makes the build the active one of its template on its node (S6 §9.4): the
 * previous active build becomes `deprecated` (existing sandboxes keep it,
 * new machines do not use it). Returns the ids that were deprecated.
 */
async function promoteBuild(
	tx: Tx,
	id: string,
): Promise<{ build: BuildRow; deprecated: string[] }> {
	const r = await tx.client.query<BuildRow>(
		`SELECT id, template_slug, version, node_id, status FROM runtime.template_builds
		 WHERE id = $1 FOR UPDATE`,
		[id],
	);
	const b = r.rows[0];
	if (!b) throw new AdminError(`template build ${id} not found`);
	if (b.status === "retired") {
		throw new AdminError(`template build ${id} is retired`);
	}
	if (b.status === "active") return { build: b, deprecated: [] };
	const old = await tx.client.query<{ id: string }>(
		`UPDATE runtime.template_builds SET status = 'deprecated'
		 WHERE template_slug = $1 AND node_id = $2 AND status = 'active' AND id <> $3
		 RETURNING id`,
		[b.template_slug, b.node_id, b.id],
	);
	await tx.client.query(
		`UPDATE runtime.template_builds SET status = 'active', promoted_at = now()
		 WHERE id = $1`,
		[b.id],
	);
	return {
		build: { ...b, status: "active" },
		deprecated: old.rows.map((x) => x.id),
	};
}

interface BuildInput {
	templateSlug: string;
	version: string;
	os: string;
	providerId: string;
	nodeId: string;
	storageId: string;
	pveVmid: number;
	bootTimeoutS: number;
	agentVersion: string | null;
	diskLayout: unknown;
	hw: unknown;
}

async function insertBuild(tx: Tx, b: BuildInput): Promise<string> {
	const r = await tx.client.query<{ id: string }>(
		`INSERT INTO runtime.template_builds
		   (template_slug, version, os, provider_id, node_id, storage_id, pve_vmid, disk_layout, hw,
		    agent_version, boot_timeout_s, status)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'building')
		 RETURNING id`,
		[
			b.templateSlug,
			b.version,
			b.os,
			b.providerId,
			b.nodeId,
			b.storageId,
			b.pveVmid,
			JSON.stringify(b.diskLayout),
			JSON.stringify(b.hw),
			b.agentVersion,
			b.bootTimeoutS,
		],
	);
	const id = r.rows[0]?.id;
	if (!id) throw new Error("template build insert returned nothing");
	return id;
}

// ---------------------------------------------------------------------------
// bootstrap

function topologyOf(d: AdminDeps): TopologyConfig {
	if (!d.config) {
		throw new AdminError(
			"bootstrap needs SBX_CONFIG_FILE (the YAML with a topology section)",
		);
	}
	return d.config().topology();
}

/**
 * Decision 14: providers, nodes, storages and template builds from the
 * `topology` section, as idempotent upserts in one transaction. A build is
 * keyed by (template, version, node); a new or `building` one is promoted to
 * `active`. An existing build that was deprecated (a newer one was promoted
 * since) is left alone.
 */
async function cmdBootstrap(args: string[], d: AdminDeps): Promise<void> {
	parse(args, {});
	const topo = topologyOf(d);
	const lines: Line[] = [];
	await withTx(d.pool, async (tx) => {
		await lockTopology(tx);
		const nodes = new Map<string, { id: string; providerId: string }[]>();
		for (const p of topo.providers) {
			const prov = await upsertProvider(tx, p);
			lines.push({
				kind: "provider",
				id: prov.id,
				name: p.name,
				created: prov.created,
			});
			for (const n of p.nodes) {
				const node = await upsertNode(tx, {
					providerId: prov.id,
					name: n.name,
					ramCapMb: n.ramCapMb,
					cloneConcurrency: n.cloneConcurrency,
					nodeAgentRef: n.nodeAgentRef,
				});
				lines.push({
					kind: "node",
					id: node.id,
					name: n.name,
					provider: p.name,
					state: node.state,
					created: node.created,
				});
				const list = nodes.get(n.name) ?? [];
				list.push({ id: node.id, providerId: prov.id });
				nodes.set(n.name, list);
				for (const s of n.storages) {
					const st = await upsertStorage(tx, {
						providerId: prov.id,
						nodeId: node.id,
						name: s.name,
						dataMaxPct: s.dataMaxPct,
						metaMaxPct: s.metaMaxPct,
					});
					lines.push({
						kind: "storage",
						id: st.id,
						name: s.name,
						node: n.name,
						created: st.created,
					});
				}
			}
		}
		for (const b of topo.templateBuilds) {
			const [node, ...more] = nodes.get(b.node) ?? [];
			if (!node || more.length > 0) {
				throw new AdminError(
					`template build ${b.templateSlug}/${b.version}: node ${b.node} is ${node ? "ambiguous" : "not in the topology"}`,
				);
			}
			const storageId = await findStorage(
				tx,
				node.providerId,
				node.id,
				b.storage,
			);
			const existing = await tx.client.query<{ id: string; status: string }>(
				`SELECT id, status FROM runtime.template_builds
				 WHERE template_slug = $1 AND version = $2 AND node_id = $3
				 ORDER BY created_at LIMIT 1`,
				[b.templateSlug, b.version, node.id],
			);
			let id = existing.rows[0]?.id;
			let status = existing.rows[0]?.status ?? "building";
			const created = id === undefined;
			if (id === undefined) {
				id = await insertBuild(tx, {
					templateSlug: b.templateSlug,
					version: b.version,
					os: b.os,
					providerId: node.providerId,
					nodeId: node.id,
					storageId,
					pveVmid: b.pveVmid,
					bootTimeoutS: b.bootTimeoutS,
					agentVersion: b.agentVersion,
					diskLayout: b.diskLayout,
					hw: b.hw,
				});
			} else {
				await tx.client.query(
					`UPDATE runtime.template_builds
					 SET os = $2, storage_id = $3, pve_vmid = $4, disk_layout = $5, hw = $6,
					     agent_version = $7, boot_timeout_s = $8
					 WHERE id = $1`,
					[
						id,
						b.os,
						storageId,
						b.pveVmid,
						JSON.stringify(b.diskLayout),
						JSON.stringify(b.hw),
						b.agentVersion,
						b.bootTimeoutS,
					],
				);
			}
			let deprecated: string[] = [];
			if (status === "building") {
				deprecated = (await promoteBuild(tx, id)).deprecated;
				status = "active";
			}
			lines.push({
				kind: "template_build",
				id,
				template: b.templateSlug,
				version: b.version,
				node: b.node,
				pveVmid: b.pveVmid,
				status,
				created,
				...(deprecated.length > 0 ? { deprecated } : {}),
			});
		}
	});
	for (const l of lines) d.out(l);
}

// ---------------------------------------------------------------------------
// providers / nodes

async function cmdProvidersAdd(args: string[], d: AdminDeps): Promise<void> {
	const { values: v } = parse(args, {
		name: { type: "string" },
		"cluster-mac-id": { type: "string" },
		"vmid-min": { type: "string" },
		"vmid-max": { type: "string" },
		"api-url": { type: "string" },
		"tls-name": { type: "string" },
		"secret-ref": { type: "string" },
	});
	const input: ProviderInput = {
		name: req(v, "name"),
		clusterMacId: int(v, "cluster-mac-id"),
		vmidMin: int(v, "vmid-min"),
		vmidMax: int(v, "vmid-max"),
		apiUrl: req(v, "api-url"),
		tlsName: opt(v, "tls-name") ?? null,
		secretRef: req(v, "secret-ref"),
	};
	const r = await withTx(d.pool, async (tx) => {
		await lockTopology(tx);
		return upsertProvider(tx, input);
	});
	d.out({ kind: "provider", id: r.id, name: input.name, created: r.created });
}

async function cmdNodesAdd(args: string[], d: AdminDeps): Promise<void> {
	const { values: v } = parse(args, {
		provider: { type: "string" },
		name: { type: "string" },
		"ram-cap-mb": { type: "string" },
		"clone-concurrency": { type: "string" },
		"node-agent-ref": { type: "string" },
		storage: { type: "string" },
	});
	const provider = await findProvider(d.pool, req(v, "provider"));
	const name = req(v, "name");
	const ramCapMb = int(v, "ram-cap-mb");
	const cloneConcurrency = int(v, "clone-concurrency", 4);
	const nodeAgentRef = req(v, "node-agent-ref");
	const storage = opt(v, "storage");
	const r = await withTx(d.pool, async (tx) => {
		await lockTopology(tx);
		const node = await upsertNode(tx, {
			providerId: provider.id,
			name,
			ramCapMb,
			cloneConcurrency,
			nodeAgentRef,
		});
		if (storage !== undefined) {
			await upsertStorage(tx, {
				providerId: provider.id,
				nodeId: node.id,
				name: storage,
				dataMaxPct: 80,
				metaMaxPct: 70,
			});
		}
		return node;
	});
	d.out({
		kind: "node",
		id: r.id,
		name,
		provider: provider.name,
		state: r.state,
		created: r.created,
		...(storage !== undefined ? { storages: [storage] } : {}),
	});
}

async function cmdNodeState(
	args: string[],
	d: AdminDeps,
	state: "cordoned" | "active",
): Promise<void> {
	const { values: v, positionals } = parse(args, {
		provider: { type: "string" },
	});
	const node = await findNode(
		d.pool,
		one(positionals, "node"),
		opt(v, "provider"),
	);
	await d.pool.query(
		"UPDATE runtime.nodes SET state = $2, updated_at = now() WHERE id = $1",
		[node.id, state],
	);
	d.out({
		kind: "node",
		id: node.id,
		name: node.name,
		provider: node.provider,
		state,
	});
}

// ---------------------------------------------------------------------------
// template register / promote

async function cmdTemplateRegister(
	args: string[],
	d: AdminDeps,
): Promise<void> {
	const { values: v } = parse(args, {
		template: { type: "string" },
		version: { type: "string" },
		os: { type: "string" },
		node: { type: "string" },
		provider: { type: "string" },
		storage: { type: "string" },
		"pve-vmid": { type: "string" },
		"boot-timeout-s": { type: "string" },
		"agent-version": { type: "string" },
		"disk-layout": { type: "string" },
		hw: { type: "string" },
		promote: { type: "boolean" },
	});
	const os = req(v, "os");
	if (os !== "linux" && os !== "windows") {
		throw new UsageError("--os must be linux or windows");
	}
	const input = {
		templateSlug: req(v, "template"),
		version: req(v, "version"),
		os,
		pveVmid: int(v, "pve-vmid"),
		bootTimeoutS: int(v, "boot-timeout-s"),
		agentVersion: opt(v, "agent-version") ?? null,
		diskLayout: json(v, "disk-layout"),
		hw: json(v, "hw"),
	};
	const storage = req(v, "storage");
	const node = await findNode(d.pool, req(v, "node"), opt(v, "provider"));
	const r = await withTx(d.pool, async (tx) => {
		await lockTopology(tx);
		const storageId = await findStorage(tx, node.provider_id, node.id, storage);
		const id = await insertBuild(tx, {
			...input,
			providerId: node.provider_id,
			nodeId: node.id,
			storageId,
		});
		if (v.promote !== true) return { id, status: "building", deprecated: [] };
		const p = await promoteBuild(tx, id);
		return { id, status: "active", deprecated: p.deprecated };
	});
	d.out({
		kind: "template_build",
		id: r.id,
		template: input.templateSlug,
		version: input.version,
		node: node.name,
		pveVmid: input.pveVmid,
		status: r.status,
		...(r.deprecated.length > 0 ? { deprecated: r.deprecated } : {}),
	});
}

async function cmdTemplatePromote(args: string[], d: AdminDeps): Promise<void> {
	const { positionals } = parse(args, {});
	const id = one(positionals, "template build id");
	if (!isUuid(id)) throw new AdminError(`template build ${id} not found`);
	const r = await withTx(d.pool, async (tx) => {
		await lockTopology(tx);
		return promoteBuild(tx, id);
	});
	d.out({
		kind: "template_build",
		id: r.build.id,
		template: r.build.template_slug,
		version: r.build.version,
		status: r.build.status,
		deprecated: r.deprecated,
	});
}

// ---------------------------------------------------------------------------
// pool status

async function cmdPoolStatus(args: string[], d: AdminDeps): Promise<void> {
	parse(args, {});
	const counts = await poolCounts(d.pool);
	const targets = new Map<string, number>();
	if (d.config) {
		for (const t of await d.config().poolTargets()) {
			const pair = `${t.templateSlug}/${t.sizeSlug}`;
			targets.set(pair, (targets.get(pair) ?? 0) + t.target);
		}
	}
	const pairs = new Map<string, Record<string, number>>();
	for (const c of counts) {
		const s = pairs.get(c.pair) ?? {};
		s[c.state] = c.count;
		pairs.set(c.pair, s);
	}
	for (const pair of targets.keys()) if (!pairs.has(pair)) pairs.set(pair, {});
	const sorted = [...pairs].sort(([a], [b]) => a.localeCompare(b));
	for (const [pair, states] of sorted) {
		const target = targets.get(pair);
		d.out({
			kind: "pair",
			pair,
			states,
			warm: states.warm ?? 0,
			booting: states.booting ?? 0,
			...(target !== undefined ? { target } : {}),
		});
	}
	for (const n of await nodeRam(d.pool)) {
		d.out({
			kind: "node",
			node: n.node,
			nodeId: n.nodeId,
			provider: n.provider,
			state: n.state,
			capMb: n.capMb,
			reservedMb: n.reservedMb,
			poweredMb: n.poweredMb,
		});
	}
}

// ---------------------------------------------------------------------------
// reconcile --dry-run

const NO_JOBS: JobSender = {
	send: async () => {
		throw new Error("reconcile dry run sends no jobs");
	},
};

function unavailable<T extends object>(what: string): T {
	return new Proxy({} as T, {
		get: (_t, p) => () => {
			throw new Error(`${what}.${String(p)} is not available in sbx-admin`);
		},
	});
}

async function cmdReconcile(args: string[], d: AdminDeps): Promise<void> {
	const { values: v } = parse(args, {
		"dry-run": { type: "boolean" },
		provider: { type: "string" },
	});
	if (v["dry-run"] !== true) {
		throw new UsageError(
			"only `reconcile --dry-run` is supported; the controller applies actions when SBX_RECONCILE_DRY_RUN=0",
		);
	}
	if (!d.infra) {
		throw new AdminError(
			"reconcile needs SBX_SECRETS_DIR (PVE and sbx-node secrets)",
		);
	}
	const providerRef = opt(v, "provider");
	const providerIds =
		providerRef === undefined
			? undefined
			: [(await findProvider(d.pool, providerRef)).id];
	const infra = d.infra();
	const ctx: WorkerCtx = {
		pool: d.pool,
		db: dbOf(d.pool),
		jobs: NO_JOBS,
		config: d.config?.() ?? unavailable<ConfigReader>("config"),
		// Reconcile decrypts nothing; a throwaway ring when no key file is set.
		keys:
			d.keys?.() ??
			KeyRing.fromObject({
				current: 1,
				keys: { "1": randomBytes(32).toString("base64") },
			}),
		infra,
		agent: unavailable<AgentPort>("agent"),
		gateway: unavailable<GatewayPort>("gateway"),
		timing: DEFAULT_TIMING,
		log: d.log,
		metrics: new NoopMetrics(),
		reconcileDryRun: true,
	};
	try {
		const actions = await runReconcile(ctx, {
			dryRun: true,
			...(providerIds !== undefined ? { providerIds } : {}),
		});
		for (const a of actions) {
			d.out({ ...a, kind: "reconcile_action", action: a.kind });
		}
		d.out({ kind: "reconcile", dryRun: true, actions: actions.length });
	} finally {
		await infra.close?.();
	}
}

// ---------------------------------------------------------------------------
// op retry / machine delete

async function jobsOf(d: AdminDeps): Promise<JobSender> {
	if (!d.jobs) throw new AdminError("no job sender");
	return d.jobs();
}

async function cmdOpRetry(args: string[], d: AdminDeps): Promise<void> {
	const { positionals } = parse(args, {});
	const id = one(positionals, "operation id");
	const op = isUuid(id) ? await loadOperation(d.pool, id) : null;
	if (op === null) throw new AdminError(`operation ${id} not found`);
	if (TERMINAL_OPERATION_STATES.includes(op.state)) {
		throw new AdminError(
			`operation ${id} is terminal (${op.state}); nothing to retry`,
		);
	}
	const jobs = await jobsOf(d);
	await withTx(d.pool, (tx) =>
		jobs.send(
			tx,
			"sandbox-op",
			{ operationId: op.id },
			op.kind === "delete"
				? { singletonKey: op.sandboxId, retryLimit: DELETE_RETRY_LIMIT }
				: { singletonKey: op.sandboxId },
		),
	);
	d.out({
		kind: "operation",
		id: op.id,
		operationKind: op.kind,
		state: op.state,
		step: op.step,
		queued: true,
	});
}

/**
 * Machine → `deleting` plus a `machine-op delete` job (unlimited retries).
 * The current machine of a live sandbox needs `--force`: deleting the
 * sandbox is the normal way.
 */
async function cmdMachineDelete(args: string[], d: AdminDeps): Promise<void> {
	const { values: v, positionals } = parse(args, {
		force: { type: "boolean" },
	});
	const id = one(positionals, "machine id");
	if (!isUuid(id)) throw new AdminError(`machine ${id} not found`);
	const jobs = await jobsOf(d);
	const from = await withMachineLocked(d.pool, id, async (tx, m) => {
		if (m === null) throw new AdminError(`machine ${id} not found`);
		if (m.state === "deleted") {
			throw new AdminError(`machine ${id} is already deleted`);
		}
		if (m.sandbox_id !== null && v.force !== true) {
			const s = await tx.client.query<{
				state: string;
				machine_id: string | null;
			}>("SELECT state, machine_id FROM runtime.sandboxes WHERE id = $1", [
				m.sandbox_id,
			]);
			const sb = s.rows[0];
			if (
				sb &&
				sb.machine_id === m.id &&
				sb.state !== "error" &&
				sb.state !== "deleted"
			) {
				throw new AdminError(
					`machine ${id} is the current machine of sandbox ${m.sandbox_id} (${sb.state}); delete the sandbox instead, or pass --force`,
				);
			}
		}
		if (m.state !== "deleting") {
			await tx.client.query(
				`UPDATE runtime.machines
				 SET state = 'deleting', error_code = COALESCE(error_code, 'operator'),
				     error_detail = COALESCE(error_detail, 'sbx-admin machine delete'),
				     state_changed_at = now(), version = version + 1
				 WHERE id = $1`,
				[id],
			);
		}
		await jobs.send(
			tx,
			"machine-op",
			{ machineId: id, action: "delete" },
			{ singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
		);
		return m.state;
	});
	d.out({ kind: "machine", id, from, state: "deleting", queued: true });
}
