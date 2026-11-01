// Real NodeInfra: S1 (packages/pve) clients per node, built from the
// providers/nodes/storages rows and the mounted Secret files (S6 §8.4).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PgAllocatorStore } from "@sbx/db";
import {
	Allocator,
	checkLeaseOwner,
	type Disk,
	type DiskSet,
	familyForTunnelUrl,
	LvmThinDriver,
	Machines,
	type NodeOps,
	OwnerMismatchError,
	PveApi,
	PveApiError,
	type PveClient,
	pveVcpuControl,
	QgaTimeoutError,
	type QuiesceHook,
	readSecretFile,
	retryOnVmLock,
	type Smbios,
	type SnapshotRef,
	type SnapshotStore,
	SshNodeOps,
	ThawFailedError,
	VM_LOCK_TIMEOUT_RE,
} from "@sbx/pve";
import type pg from "pg";
import { QuiesceFailed } from "../ops/snapshot-step.ts";
import type {
	CreatedVm,
	InfraDisk,
	InfraLv,
	InfraRegistry,
	InfraSize,
	InfraSmbios,
	InfraSnapshotRef,
	InfraSnapshotResult,
	InfraVm,
	NodeInfra,
	PowerOpts,
	StartOpts,
	VmStatus,
} from "../ports.ts";
import {
	classifyInfraError,
	InfraError,
	type InfraOp,
	infraRejected,
} from "./infra-errors.ts";
import { withNodePowerLock } from "./power-lock.ts";

type Env = Record<string, string | undefined>;

/** What the adapter reads about a node from the topology tables. */
export interface NodeTopology {
	nodeId: string;
	nodeName: string;
	nodeAgentRef: string;
	cloneConcurrency: number;
	providerId: string;
	apiUrl: string;
	tlsName: string | null;
	secretRef: string;
	clusterMacId: number;
	vmidMin: number;
	vmidMax: number;
	storageName: string;
	dataMaxPct: number;
	metaMaxPct: number;
}

export interface NodeClients {
	api: PveClient;
	node: NodeOps;
	/** Closes the clients; defaults to `node.close()`. */
	close?(): void;
}

export type NodeClientsFactory = (
	t: NodeTopology,
) => NodeClients | Promise<NodeClients>;

export async function loadNodeTopology(
	q: Pick<pg.Pool, "query">,
	nodeId: string,
): Promise<NodeTopology> {
	const r = await q.query<{
		node_id: string;
		node_name: string;
		node_agent_ref: string;
		clone_concurrency: number;
		provider_id: string;
		api_url: string;
		tls_name: string | null;
		secret_ref: string;
		cluster_mac_id: number;
		vmid_min: number;
		vmid_max: number;
		storage_name: string | null;
		data_max_pct: number | null;
		meta_max_pct: number | null;
	}>(
		`SELECT n.id AS node_id, n.name AS node_name, n.node_agent_ref, n.clone_concurrency,
		        p.id AS provider_id, p.api_url, p.tls_name, p.secret_ref, p.cluster_mac_id,
		        p.vmid_min, p.vmid_max,
		        st.name AS storage_name, st.data_max_pct, st.meta_max_pct
		 FROM runtime.nodes n
		 JOIN runtime.providers p ON p.id = n.provider_id
		 LEFT JOIN LATERAL (
		   SELECT s.name, s.data_max_pct, s.meta_max_pct FROM runtime.storages s
		   WHERE s.provider_id = p.id AND (s.node_id = n.id OR s.node_id IS NULL)
		     AND s.driver = 'lvmthin'
		   ORDER BY (s.node_id IS NULL), s.name LIMIT 1
		 ) st ON true
		 WHERE n.id = $1`,
		[nodeId],
	);
	const row = r.rows[0];
	if (!row) throw new Error(`unknown node ${nodeId}`);
	if (row.storage_name === null)
		throw new Error(`node ${row.node_name} has no lvmthin storage`);
	return {
		nodeId: row.node_id,
		nodeName: row.node_name,
		nodeAgentRef: row.node_agent_ref,
		cloneConcurrency: row.clone_concurrency,
		providerId: row.provider_id,
		apiUrl: row.api_url,
		tlsName: row.tls_name,
		secretRef: row.secret_ref,
		clusterMacId: row.cluster_mac_id,
		vmidMin: row.vmid_min,
		vmidMax: row.vmid_max,
		storageName: row.storage_name,
		dataMaxPct: row.data_max_pct ?? 80,
		metaMaxPct: row.meta_max_pct ?? 70,
	};
}

/**
 * `<secretsDir>/<secretRef>` when that directory exists, else `secretsDir`
 * itself (the PoC mounts ~/.config/sbx directly).
 */
export function secretDirOf(secretsDir: string, secretRef: string): string {
	if (secretRef === "" || /[/\\]|^\.\.?$/.test(secretRef))
		throw new Error(`invalid secret_ref ${JSON.stringify(secretRef)}`);
	const sub = join(secretsDir, secretRef);
	return existsSync(sub) && statSync(sub).isDirectory() ? sub : secretsDir;
}

/**
 * Builds PveApi and SshNodeOps from the Secret files of the provider:
 * `pve-token` (mode 600), `pve-root-ca.pem`, `sbx-node_ed25519`,
 * `known_hosts`. Env: `SBX_PVE_TOKEN_ID` (default `sbx@pve!poc`),
 * `SBX_NODE_SSH_HOST` (default `nodes.node_agent_ref`).
 */
export function pveClientsFromSecrets(
	secretsDir: string,
	env: Env = process.env,
): NodeClientsFactory {
	return (t) => {
		const dir = secretDirOf(secretsDir, t.secretRef);
		const api = new PveApi({
			url: t.apiUrl,
			tokenId: env.SBX_PVE_TOKEN_ID ?? "sbx@pve!poc",
			tokenSecret: readSecretFile(join(dir, "pve-token")),
			ca: readFileSync(join(dir, "pve-root-ca.pem")),
			tlsName: t.tlsName ?? new URL(t.apiUrl).hostname,
		});
		let node: SshNodeOps;
		try {
			node = new SshNodeOps({
				host: env.SBX_NODE_SSH_HOST ?? t.nodeAgentRef,
				privateKey: readFileSync(join(dir, "sbx-node_ed25519")),
				knownHosts: readFileSync(join(dir, "known_hosts"), "utf8"),
			});
		} catch (err) {
			api.close();
			throw err;
		}
		return {
			api,
			node,
			close() {
				node.close();
				api.close();
			},
		};
	};
}

/**
 * S1 keeps snapshot metadata here only for its own bookkeeping; the worker's
 * source of truth is runtime.snapshots + runtime.disks.
 */
class MemorySnapshotStore implements SnapshotStore {
	readonly #m = new Map<string, SnapshotRef>();
	putSnapshot(s: SnapshotRef): void {
		this.#m.set(s.id, s);
	}
	getSnapshot(id: string): SnapshotRef | undefined {
		return this.#m.get(id);
	}
	listSnapshots(): SnapshotRef[] {
		return [...this.#m.values()];
	}
	removeSnapshot(id: string): void {
		this.#m.delete(id);
	}
}

function toInfraDisks(disks: DiskSet): InfraDisk[] {
	return disks.map((d) => ({
		slot: d.slot,
		volume: d.volid,
		options: { ...d.options },
	}));
}

function toSize(s: InfraSize): { cores: number; memoryMb: number } {
	return { cores: s.vcpu, memoryMb: s.memoryMb };
}

function parseTags(tags: unknown): string[] {
	return typeof tags === "string"
		? tags.split(/[;,\s]+/).filter((t) => t !== "")
		: [];
}

const PAUSED_QMP = new Set(["paused", "suspended"]);

interface Resource {
	vmid: number;
	type?: string;
	node?: string;
	status?: string;
	pool?: string;
	tags?: string;
	template?: number;
}

export interface PveNodeInfraOptions {
	/** Test clock; production waits between VM-lock retries. */
	vmLockSleep?: (ms: number) => Promise<void>;
	vnet: string;
	pool: string;
	/** Machines poll interval (delete verification); S1 default when unset. */
	pollMs?: number;
	/**
	 * smbios1 `family` of every new machine (`sbxt1:<SBX_TUNNEL_URL>`, S5 section 14): the
	 * agent's tunnel URL; templates carry no default. Unset: no family.
	 */
	family?: string;
}

/** NodeInfra over S1 `Machines` for one node. */
export class PveNodeInfra implements NodeInfra {
	readonly vmidRange: { min: number; max: number };
	readonly #db: pg.Pool;
	readonly #t: NodeTopology;
	readonly #c: NodeClients;
	readonly #o: PveNodeInfraOptions;
	readonly #store: PgAllocatorStore;
	readonly #driver: LvmThinDriver;
	readonly #snapshots = new MemorySnapshotStore();
	readonly #allocator: Allocator;
	readonly #machines = new Map<number, Machines>();
	#templates: number[] = [];
	/**
	 * In-process power gate (start, stop, shutdown request, delete, S1
	 * rollback): at most one of them on this node waits for (or holds) the
	 * advisory lock, so a burst holds one pool client.
	 */
	#powerGate: Promise<void> = Promise.resolve();

	constructor(
		db: pg.Pool,
		t: NodeTopology,
		clients: NodeClients,
		o: PveNodeInfraOptions,
	) {
		this.#db = db;
		this.#t = t;
		this.#c = clients;
		this.#o = o;
		this.vmidRange = { min: t.vmidMin, max: t.vmidMax };
		this.#store = new PgAllocatorStore(db, t.providerId);
		this.#driver = new LvmThinDriver({
			node: clients.node,
			vcpu: pveVcpuControl(clients.api, t.nodeName),
			storage: t.storageName,
			maxDataPercent: t.dataMaxPct,
			maxMetadataPercent: t.metaMaxPct,
		});
		this.#allocator = this.#allocatorFor(0);
	}

	#smbios(s: InfraSmbios): Smbios {
		return {
			uuid: s.uuid,
			serial: s.serial,
			...(this.#o.family !== undefined ? { family: this.#o.family } : {}),
		};
	}

	get templateVmids(): number[] {
		return [...this.#templates];
	}

	#allocatorFor(templateVmid: number): Allocator {
		return new Allocator({
			store: this.#store,
			clusterId: this.#t.clusterMacId,
			range: this.vmidRange,
			templateVmid,
			occupied: () => this.#base.occupiedVmids(),
		});
	}

	/** Active template VMIDs of this node; records a template lease for new ones. */
	async setTemplates(vmids: number[]): Promise<void> {
		for (const v of vmids)
			if (!this.#templates.includes(v))
				await this.#allocatorFor(v).ensureTemplate();
		this.#templates = [...vmids].sort((a, b) => a - b);
	}

	/** Machines bound to one template (S1 keeps the template in its config). */
	#machinesFor(templateVmid: number): Machines {
		let m = this.#machines.get(templateVmid);
		if (!m) {
			m = new Machines({
				api: this.#c.api,
				node: this.#c.node,
				driver: this.#driver,
				allocator: this.#allocator,
				snapshots: this.#snapshots,
				cfg: {
					node: this.#t.nodeName,
					storage: this.#t.storageName,
					vnet: this.#o.vnet,
					pool: this.#o.pool,
					templateVmid,
					clusterId: this.#t.clusterMacId,
				},
				cloneConcurrency: this.#t.cloneConcurrency,
				ipfilter: true,
				// The rollback delete of a failed create/fork is a delete like any
				// other: serialized with starts. No deadlock: create/fork never run
				// under the power lock, and power operations never wait for a clone.
				powerLock: (fn) => this.#retryPowerOnVmLock(fn),
				...(this.#o.pollMs !== undefined ? { pollMs: this.#o.pollMs } : {}),
			});
			this.#machines.set(templateVmid, m);
		}
		return m;
	}

	/** Machines for operations that do not depend on a template. */
	get #base(): Machines {
		return this.#machinesFor(this.#templates[0] ?? 0);
	}

	#vmPath(vmid: number, sub = ""): string {
		return `/nodes/${this.#t.nodeName}/qemu/${vmid}${sub}`;
	}

	async #run<T>(op: InfraOp, fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (err) {
			throw classifyInfraError(err, op);
		}
	}

	#snapshotRef(ref: InfraSnapshotRef): SnapshotRef {
		const storage = `${this.#t.storageName}:`;
		const disks: Disk[] = ref.disks.map((d) => ({
			slot: d.slot,
			volid: d.volume,
			lv: d.volume.startsWith(storage)
				? d.volume.slice(storage.length)
				: d.volume.slice(d.volume.indexOf(":") + 1),
			options: { ...d.options },
		}));
		return {
			kind: "snapshot",
			id: ref.lvId,
			node: this.#t.nodeName,
			sourceVmid: ref.sourceVmid,
			disks,
			hardware: { ...ref.hw },
			createdAt: 0,
		};
	}

	create(p: {
		machineId: string;
		templateVmid: number;
		size: InfraSize;
		smbios: InfraSmbios;
	}): Promise<CreatedVm> {
		return this.#run("create", async () => {
			const info = await this.#machinesFor(p.templateVmid).create({
				size: toSize(p.size),
				smbios: this.#smbios(p.smbios),
				ownerId: p.machineId,
			});
			return {
				vmid: info.vmid,
				mac: info.mac,
				disks: toInfraDisks(info.disks),
			};
		});
	}

	fork(p: {
		machineId: string;
		snapshot: InfraSnapshotRef;
		size?: InfraSize;
		smbios: InfraSmbios;
	}): Promise<CreatedVm> {
		return this.#run("fork", async () => {
			const info = await this.#base.fork(this.#snapshotRef(p.snapshot), {
				...(p.size ? { size: toSize(p.size) } : {}),
				smbios: this.#smbios(p.smbios),
				ownerId: p.machineId,
			});
			return {
				vmid: info.vmid,
				mac: info.mac,
				disks: toInfraDisks(info.disks),
			};
		});
	}

	/**
	 * Serialized per node with delete (power-lock.ts): ethers/IPAM writes race.
	 * Under the lock: the caller's `beforeAct` (its fence: an executor fenced
	 * out while it waited never starts the VM), then S1 start with the owner
	 * check. Errors of `beforeAct` pass through unclassified.
	 */
	start(vmid: number, o: StartOpts): Promise<void> {
		return this.#guarded(o.beforeAct, (g) =>
			this.#run("start", () =>
				this.#powerSerialized(async () => {
					await g.before();
					await this.#base.start(vmid, { expectedOwner: o.expectedOwner });
				}),
			),
		);
	}

	/**
	 * Runs `fn` with a `before` that calls the caller's `beforeAct` (if any);
	 * an error of `beforeAct` reaches the caller unchanged, not classified.
	 */
	async #guarded<T>(
		beforeAct: (() => Promise<unknown>) | undefined,
		fn: (g: {
			before: () => Promise<void>;
			failed: () => boolean;
		}) => Promise<T>,
	): Promise<T> {
		let fromCaller: { err: unknown } | undefined;
		const before = async (): Promise<void> => {
			if (beforeAct === undefined) return;
			try {
				await beforeAct();
			} catch (err) {
				fromCaller = { err };
				throw err;
			}
		};
		try {
			return await fn({ before, failed: () => fromCaller !== undefined });
		} catch (err) {
			throw fromCaller ? fromCaller.err : err;
		}
	}

	/**
	 * One queue per node for the power operations: the in-process gate first
	 * (FIFO, settles on success and failure), then the advisory lock.
	 */
	#powerSerialized<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#powerGate.then(() =>
			withNodePowerLock(this.#db, this.#t.nodeId, fn),
		);
		this.#powerGate = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	/** Delete/rollback recheck the lease on every attempt; never sleep under the power lock. */
	#retryPowerOnVmLock<T>(fn: () => Promise<T>): Promise<T> {
		return retryOnVmLock(
			() => this.#powerSerialized(fn),
			this.#o.vmLockSleep ? { sleep: this.#o.vmLockSleep } : {},
		);
	}

	/**
	 * The caller's `beforeAct`, the owner check and the shutdown request run
	 * under the power lock, the wait for the guest (up to timeoutS) outside
	 * it: once Proxmox accepted the task it acts on that VM, and holding the
	 * lock that long would stall every start and delete of the node. Same
	 * rule as S1 (checkLeaseOwner). A task that could not take the VM config
	 * lock (qmeventd after a stop and a quick start) never asked the guest:
	 * it is repeated like a stop, not reported as `timeout` (that would make
	 * the caller hard-stop a guest that was never asked to shut down).
	 */
	shutdown(
		vmid: number,
		timeoutS: number,
		o: PowerOpts,
	): Promise<"stopped" | "timeout"> {
		return retryOnVmLock(() => this.#shutdownOnce(vmid, timeoutS, o), {
			sleep: this.#fencedLockSleep(o.beforeAct),
		});
	}

	#shutdownOnce(
		vmid: number,
		timeoutS: number,
		o: PowerOpts,
	): Promise<"stopped" | "timeout"> {
		return this.#guarded(o.beforeAct, (g) =>
			this.#run("shutdown", async () => {
				try {
					const upid = await this.#powerSerialized(async () => {
						await g.before();
						await checkLeaseOwner({
							op: "shutdown",
							vmid,
							lease: await this.#allocator.get(vmid),
							expectedOwner: o.expectedOwner,
							vmExists: async () => true,
						});
						return this.#c.api.post<string>(
							this.#vmPath(vmid, "/status/shutdown"),
							{ timeout: timeoutS },
						);
					});
					await this.#c.api.waitTask(this.#t.nodeName, upid);
				} catch (err) {
					if (err instanceof OwnerMismatchError || g.failed()) throw err;
					if (err instanceof Error && VM_LOCK_TIMEOUT_RE.test(err.message))
						throw err;
					// The shutdown task fails when the guest ignores ACPI within the timeout.
					const s = await this.#statusOf(vmid).catch(() => undefined);
					if (s === "stopped") return "stopped";
					if (s === "running" || s === "paused") return "timeout";
					throw err;
				}
				return (await this.#statusOf(vmid)) === "stopped"
					? "stopped"
					: "timeout";
			}),
		);
	}

	/**
	 * Under the power lock: the caller's `beforeAct`, the owner check and the
	 * stop are one step for other power operations.
	 */
	stop(vmid: number, o: PowerOpts): Promise<void> {
		return this.#stopOwned(vmid, o);
	}

	#stopOwned(
		vmid: number,
		o: { expectedOwner: string | null; beforeAct?: () => Promise<unknown> },
	): Promise<void> {
		return retryOnVmLock(
			() =>
				this.#guarded(o.beforeAct, (g) =>
					this.#run("stop", () =>
						this.#powerSerialized(async () => {
							await g.before();
							await this.#base.stop(vmid, { expectedOwner: o.expectedOwner });
						}),
					),
				),
			{ sleep: this.#fencedLockSleep(o.beforeAct) },
		);
	}

	/**
	 * The pause between VM-lock retries. The power lock is released between
	 * attempts; the caller's fence is rechecked while waiting and again under
	 * that lock before acting.
	 */
	#fencedLockSleep(
		beforeAct?: () => Promise<unknown>,
	): (ms: number) => Promise<void> {
		return async (ms) => {
			for (let remaining = ms; remaining > 0; remaining -= 2000) {
				await (
					this.#o.vmLockSleep ??
					((delay) => new Promise((resolve) => setTimeout(resolve, delay)))
				)(Math.min(remaining, 2000));
				await beforeAct?.();
			}
		};
	}

	/**
	 * Whether /cluster/resources lists the VM. The list is filtered by the
	 * token's permissions, so an empty answer may mean a lost pool ACL rather
	 * than no VMs: absence counts only when the list also shows an anchor, an
	 * active template of this node or another VM with an active lease.
	 */
	async #listed(vmid: number): Promise<boolean> {
		const rs = await this.#c.api.get<Resource[]>("/cluster/resources", {
			type: "vm",
		});
		if (rs.some((r) => r.vmid === vmid)) return true;
		const listed = new Set(rs.map((r) => r.vmid));
		let anchored = this.#templates.some((t) => listed.has(t));
		if (!anchored && listed.size > 0) {
			const l = await this.#db.query<{ vmid: number }>(
				`SELECT vmid FROM runtime.vmid_leases
				 WHERE provider_id = $1 AND state = 'active' AND vmid <> $2`,
				[this.#t.providerId, vmid],
			);
			anchored = l.rows.some((x) => listed.has(x.vmid));
		}
		if (!anchored)
			throw new InfraError(
				"pve_listing_unverified",
				`VM ${vmid} is not listed, but /cluster/resources shows none of our known VMs either (token permissions?)`,
				{ retryable: true, op: "status" },
			);
		return false;
	}

	/**
	 * status/current, with `missing` only when /cluster/resources (right about
	 * existence, S1) does not list the VM and the listing is anchored. A token
	 * scoped to the pool gets 403, not 404, for a VM that does not exist.
	 */
	async #statusOf(vmid: number): Promise<VmStatus> {
		let st: { status?: string; qmpstatus?: string };
		try {
			st = await this.#c.api.get(this.#vmPath(vmid, "/status/current"));
		} catch (err) {
			if (
				err instanceof PveApiError &&
				!(err instanceof QgaTimeoutError) &&
				!(await this.#listed(vmid))
			)
				return "missing";
			throw err;
		}
		if (st.status === "stopped") return "stopped";
		if (st.qmpstatus !== undefined && PAUSED_QMP.has(st.qmpstatus))
			return "paused";
		return "running";
	}

	status(vmid: number): Promise<VmStatus> {
		return this.#run("status", () => this.#statusOf(vmid));
	}

	configure(vmid: number, size: InfraSize): Promise<void> {
		return this.#run("configure", async () => {
			await this.#c.api.put(this.#vmPath(vmid, "/config"), {
				cores: size.vcpu,
				memory: size.memoryMb,
			});
		});
	}

	vmSize(vmid: number): Promise<InfraSize> {
		return this.#run("vmSize", async () => {
			const cfg = await this.#base.config(vmid);
			// Proxmox defaults when a key is absent.
			return {
				vcpu: Number(cfg.cores ?? 1),
				memoryMb: Number(cfg.memory ?? 512),
			};
		});
	}

	/**
	 * Never a template: neither an active one of this node nor any build of
	 * the provider. Serialized per node with start; S1 checks the owner under
	 * the lock. A failed delete leaves the lease `releasing` and is safe to
	 * repeat (S1 tolerates a missing VM).
	 */
	delete(vmid: number, o: { expectedOwner: string | null }): Promise<void> {
		return this.#run("delete", async () => {
			const r = await this.#db.query<{ vmid: number }>(
				"SELECT DISTINCT pve_vmid AS vmid FROM runtime.template_builds WHERE provider_id = $1",
				[this.#t.providerId],
			);
			if (this.#templates.includes(vmid) || r.rows.some((x) => x.vmid === vmid))
				throw infraRejected(
					"template_protected",
					`refusing to delete the template VM ${vmid}`,
					"delete",
				);
			await this.#retryPowerOnVmLock(() =>
				this.#base.delete(vmid, { expectedOwner: o.expectedOwner }),
			);
		});
	}

	leaseOf(
		machineId: string,
	): Promise<{ vmid: number; mac: string } | undefined> {
		return this.#run("leaseOf", async () => {
			const r = await this.#db.query<{ vmid: number; mac: string }>(
				`SELECT vmid, mac FROM runtime.vmid_leases
				 WHERE provider_id = $1 AND machine_id = $2
				 ORDER BY (state = 'releasing'), vmid LIMIT 1`,
				[this.#t.providerId, machineId],
			);
			return r.rows[0];
		});
	}

	snapshot(
		vmid: number,
		opts: {
			lvId: string;
			hook?: QuiesceHook;
			crashConsistent?: boolean;
			expectedOwner?: string;
			beforeAct?: () => Promise<unknown>;
		},
	): Promise<InfraSnapshotResult> {
		return this.#guarded(opts.beforeAct, (g) =>
			this.#run("snapshot", async () => {
				await g.before();
				const lease = await this.#allocator.get(vmid);
				const expectedOwner = lease?.ownerId ?? null;
				if (
					opts.expectedOwner !== undefined &&
					opts.expectedOwner !== expectedOwner
				) {
					throw infraRejected(
						"owner_mismatch",
						`snapshot of VM ${vmid}: lease owner changed`,
						"snapshot",
					);
				}
				const ref = await this.#base
					.snapshot(vmid, {
						id: opts.lvId,
						...(opts.crashConsistent !== undefined
							? { crashConsistent: opts.crashConsistent }
							: {}),
						...(opts.hook ? { hook: opts.hook } : {}),
					})
					.catch(async (error: unknown) => {
						if (!(error instanceof ThawFailedError)) throw error;
						// A dead QGA cannot thaw the guest. Serialize with power operations
						// and fence the lease so a recycled VMID is never stopped.
						try {
							await this.#stopOwned(vmid, { expectedOwner });
						} catch (stopError) {
							throw new QuiesceFailed(
								`VM ${vmid}: thaw failed; hard stop also failed: ${String(stopError)}`,
								{ cause: error },
							);
						}
						throw new QuiesceFailed(
							`VM ${vmid}: thaw failed; machine hard-stopped to release frozen filesystems; start it again normally`,
							{ cause: error },
						);
					});
				if (ref.autoThawed) {
					// S1's QGA hook tolerates a guest that thawed itself; a stored snapshot
					// must be quiesced, so it is discarded like qgaFreezeHook's outcome.
					await this.#base.deleteSnapshot(ref);
					throw new QuiesceFailed(
						`VM ${vmid}: the guest thawed itself before the snapshot was done`,
					);
				}
				return {
					disks: toInfraDisks(ref.disks),
					hw: { ...ref.hardware },
					// S1 measures the freeze only on the running path (QGA or the hook).
					consistency:
						ref.consistency ??
						(ref.freezeMs !== undefined ? "quiesced" : "powered_off"),
				};
			}),
		);
	}

	deleteSnapshot(ref: InfraSnapshotRef): Promise<void> {
		return this.#run("deleteSnapshot", () =>
			this.#base.deleteSnapshot(this.#snapshotRef(ref)),
		);
	}

	/** VMs of this node from /cluster/resources (the token sees its pool). */
	listVms(): Promise<InfraVm[]> {
		return this.#run("listVms", async () => {
			const rs = await this.#c.api.get<Resource[]>("/cluster/resources", {
				type: "vm",
			});
			return rs
				.filter(
					(r) =>
						r.node === this.#t.nodeName &&
						(r.type === undefined || r.type === "qemu"),
				)
				.map((r) => ({
					vmid: r.vmid,
					status: r.status === "stopped" ? "stopped" : "running",
					...(r.pool !== undefined ? { pool: r.pool } : {}),
					tags: parseTags(r.tags),
					template: r.template === 1,
				}));
		});
	}

	listLvs(): Promise<InfraLv[]> {
		return this.#run("listLvs", async () => {
			const { lvs } = await this.#c.node.call<{
				lvs: { name: string; tags?: string[] | null }[];
			}>("lv.list", {});
			return lvs.map((l) => ({ name: l.name, tags: [...(l.tags ?? [])] }));
		});
	}

	removeLvs(names: string[]): Promise<void> {
		return this.#run("removeLvs", async () => {
			if (names.length === 0) return;
			await this.#c.node.call("lv.remove", { names });
		});
	}

	qgaPing(vmid: number): Promise<boolean> {
		return this.#run("qgaPing", () => this.#base.qga.ping(vmid));
	}

	qgaFreezeHook(vmid: number): QuiesceHook {
		const qga = this.#base.qga;
		// A freeze was started (it may have taken effect even if the call failed).
		let attempted = false;
		let frozen = false;
		// Set once a thaw reached the guest: null = clean.
		let outcome: QuiesceFailed | null | undefined;
		return {
			freeze: async () => {
				attempted = true;
				frozen = false;
				outcome = undefined;
				await qga.fsfreezeFreeze(vmid);
				frozen = true;
			},
			thaw: async () => {
				if (outcome !== undefined) {
					if (outcome !== null) throw outcome;
					return;
				}
				if (!attempted) return;
				if (!frozen) {
					// The freeze failed half-way or is still running (S1 gave up waiting):
					// release whatever it did; the snapshot is cancelled anyway, so a failure
					// here only leaves the guest's own timeout. `attempted` stays set: S1 thaws
					// again when a late freeze returns, and that thaw must reach the guest.
					await qga.fsfreezeThaw(vmid, { selfThaw: true }).catch(() => {});
					return;
				}
				if ((await qga.fsfreezeStatus(vmid)) === "thawed") {
					// VSS released the writers at its own deadline: crash-consistent at best.
					outcome = new QuiesceFailed(
						`VM ${vmid}: the guest was already thawed before the snapshot was done`,
					);
					throw outcome;
				}
				// The thaw call fails when VSS lets go between the status and the thaw.
				if ((await qga.fsfreezeThaw(vmid, { selfThaw: true })).autoThawed) {
					outcome = new QuiesceFailed(
						`VM ${vmid}: the guest thawed itself before the snapshot was done`,
					);
					throw outcome;
				}
				outcome = null;
			},
		};
	}

	qgaExec(vmid: number, argv: string[]): Promise<{ exitCode: number }> {
		return this.#run("qgaExec", async () => {
			const r = await this.#base.qga.exec(vmid, argv);
			return { exitCode: r.exitCode };
		});
	}

	close(): void {
		if (this.#c.close) this.#c.close();
		else this.#c.node.close();
	}
}

export interface PveInfraRegistryOptions {
	vmLockSleep?: (ms: number) => Promise<void>;
	/** Root of the mounted Secret directories (`SBX_SECRETS_DIR`). */
	secretsDir: string;
	/** `SBX_PVE_TOKEN_ID`, `SBX_NODE_SSH_HOST`, `SBX_PVE_VNET`, `SBX_PVE_POOL`. */
	env?: Env;
	/** Client factory; default `pveClientsFromSecrets(secretsDir, env)`. Tests pass fakes. */
	clients?: NodeClientsFactory;
	/** S1 poll interval in delete verification. */
	pollMs?: number;
	/** How often forNode re-reads the active template VMIDs (default 10 s). */
	templateRefreshMs?: number;
}

/** One S1 client set per node, built on first use and cached (S6 §8.4). */
export class PveInfraRegistry implements InfraRegistry {
	readonly #db: pg.Pool;
	readonly #o: PveInfraRegistryOptions;
	readonly #env: Env;
	readonly #clients: NodeClientsFactory;
	readonly #family: string | undefined;
	readonly #cache = new Map<
		string,
		Promise<{ infra: PveNodeInfra; refreshedAt: number }>
	>();

	constructor(pool: pg.Pool, o: PveInfraRegistryOptions) {
		this.#db = pool;
		this.#o = o;
		this.#env = o.env ?? process.env;
		const url = this.#env.SBX_TUNNEL_URL;
		if (url !== undefined && url !== "") {
			try {
				this.#family = familyForTunnelUrl(url);
			} catch (err) {
				throw new Error(
					`SBX_TUNNEL_URL: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		this.#clients = o.clients ?? pveClientsFromSecrets(o.secretsDir, this.#env);
	}

	async #templatesOf(nodeId: string): Promise<number[]> {
		const r = await this.#db.query<{ vmid: number }>(
			`SELECT DISTINCT pve_vmid AS vmid FROM runtime.template_builds
			 WHERE node_id = $1 AND status = 'active' ORDER BY 1`,
			[nodeId],
		);
		return r.rows.map((x) => x.vmid);
	}

	async #build(
		nodeId: string,
	): Promise<{ infra: PveNodeInfra; refreshedAt: number }> {
		const t = await loadNodeTopology(this.#db, nodeId);
		const clients = await this.#clients(t);
		const infra = new PveNodeInfra(this.#db, t, clients, {
			...(this.#o.vmLockSleep ? { vmLockSleep: this.#o.vmLockSleep } : {}),
			vnet: this.#env.SBX_PVE_VNET ?? "sbx0",
			pool: this.#env.SBX_PVE_POOL ?? "sandbox",
			...(this.#o.pollMs !== undefined ? { pollMs: this.#o.pollMs } : {}),
			...(this.#family !== undefined ? { family: this.#family } : {}),
		});
		try {
			await infra.setTemplates(await this.#templatesOf(nodeId));
		} catch (err) {
			infra.close();
			throw err;
		}
		return { infra, refreshedAt: Date.now() };
	}

	async forNode(nodeId: string): Promise<NodeInfra> {
		let p = this.#cache.get(nodeId);
		if (!p) {
			const built = this.#build(nodeId);
			p = built;
			this.#cache.set(nodeId, built);
			built.catch(() => {
				if (this.#cache.get(nodeId) === built) this.#cache.delete(nodeId);
			});
		}
		const entry = await p;
		if (
			Date.now() - entry.refreshedAt >=
			(this.#o.templateRefreshMs ?? 10_000)
		) {
			entry.refreshedAt = Date.now();
			await entry.infra.setTemplates(await this.#templatesOf(nodeId));
		}
		return entry.infra;
	}

	/** Closes all node clients (worker shutdown). */
	async close(): Promise<void> {
		const entries = [...this.#cache.values()];
		this.#cache.clear();
		for (const p of entries) {
			const e = await p.catch(() => undefined);
			e?.infra.close();
		}
	}
}
