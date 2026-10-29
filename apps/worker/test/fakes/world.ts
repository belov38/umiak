// A test world: topology rows, a WorkerCtx over fakes, and FakeAgentWorld,
// which plays the guest agent and the gateway when a fake VM starts.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { StaticConfigReader } from "@sbx/config";
import {
	ingestAgentEvents,
	type JobSender,
	KeyRing,
	RecordingJobSender,
} from "@sbx/core";
import type { TestDatabase } from "@sbx/db/testing";
import type pg from "pg";
import {
	createLogger,
	RecordingMetrics,
	type Timing,
	type WorkerCtx,
} from "../../src/context.ts";
import { handleMachineEvents } from "../../src/handlers/machine-events.ts";
import type { NodeInfra } from "../../src/ports.ts";
import { FakeAgent } from "./agent.ts";
import { FakeGateway } from "./gateway.ts";
import {
	FakeInfra,
	FakeInfraRegistry,
	type FakeVm,
	type VmLifecycle,
} from "./infra.ts";

/**
 * - `ready`: the agent connects and reports `phase pool_ready`;
 * - `connect`: it connects but never gets ready;
 * - `never`: the VM runs, the agent never connects.
 */
export type BootBehavior = "ready" | "connect" | "never";

export interface FakeAgentWorldOptions {
	pool: pg.Pool;
	jobs: JobSender;
	behavior?: BootBehavior;
	/** Run handleMachineEvents right after ingest (no pg-boss). Default true. */
	processEvents?: boolean;
}

/**
 * On VM start: checks the bootstrap secret from the SMBIOS serial against
 * tunnel_credentials (S2 §5.2, a retired or wrong secret does not connect),
 * upserts tunnel_sessions (connected, new boot_id, epoch + 1) and ingests a
 * synthetic `connected` and an agent `phase {pool_ready}` through core.
 */
export class FakeAgentWorld implements VmLifecycle {
	behavior: BootBehavior;
	processEvents: boolean;
	ctx: WorkerCtx | undefined;
	/** Machines whose bootstrap secret was refused. */
	readonly refused: string[] = [];
	readonly errors: unknown[] = [];
	readonly #pool: pg.Pool;
	readonly #jobs: JobSender;
	readonly #pending = new Set<Promise<void>>();
	readonly #seq = new Map<string, number>();
	#gate: { promise: Promise<void>; release: () => void } | undefined;

	constructor(o: FakeAgentWorldOptions) {
		this.#pool = o.pool;
		this.#jobs = o.jobs;
		this.behavior = o.behavior ?? "ready";
		this.processEvents = o.processEvents ?? true;
	}

	boot(infra: FakeInfra, vm: FakeVm): void {
		const p: Promise<void> = this.#boot(infra, vm)
			.catch((e: unknown) => {
				this.errors.push(e);
			})
			.finally(() => {
				this.#pending.delete(p);
			});
		this.#pending.add(p);
	}

	/** Boots started from now on wait until `releaseBoots()` (deterministic ordering in tests). */
	holdBoots(): void {
		if (this.#gate) return;
		let release: () => void = () => {};
		const promise = new Promise<void>((r) => {
			release = r;
		});
		this.#gate = { promise, release };
	}

	releaseBoots(): void {
		const g = this.#gate;
		this.#gate = undefined;
		g?.release();
	}

	async #boot(infra: FakeInfra, vm: FakeVm): Promise<void> {
		if (this.#gate) await this.#gate.promise;
		if (this.behavior === "never") return;
		if (infra.vms.get(vm.vmid) !== vm || vm.status !== "running") return;
		const machineId = vm.machineId;
		if (!(await this.#bsAccepted(vm))) {
			this.refused.push(machineId);
			return;
		}
		const bootId = randomUUID();
		const s = await this.#pool.query<{ epoch: string }>(
			`INSERT INTO tunnel.tunnel_sessions
			   (machine_id, instance_id, epoch, conn_id, agent_instance_id, boot_id, vmgenid,
			    agent_version, proto_version, capabilities, state, connected_at)
			 VALUES ($1, 'gw-fake', 1, $2, $3, $4, $5, '0.0.0-fake', '1', $6, 'connected', now())
			 ON CONFLICT (machine_id) DO UPDATE
			 SET epoch = tunnel.tunnel_sessions.epoch + 1, conn_id = EXCLUDED.conn_id,
			     agent_instance_id = EXCLUDED.agent_instance_id, boot_id = EXCLUDED.boot_id,
			     state = 'connected', connected_at = now(), disconnected_at = NULL
			 RETURNING epoch`,
			[
				machineId,
				randomUUID(),
				randomUUID(),
				bootId,
				randomUUID(),
				["process.v1", "system.claim.v1", "system.quiesce.v1"],
			],
		);
		const epoch = Number(s.rows[0]?.epoch ?? 1);
		const time = new Date();
		const events =
			this.behavior === "ready"
				? [
						{
							seq: this.#nextSeq(machineId),
							bootId,
							type: "phase",
							time,
							payload: { phase: "pool_ready" },
						},
					]
				: [];
		await ingestAgentEvents(this.#pool, this.#jobs, {
			machineId,
			events,
			synthetic: [{ epoch, type: "connected", instanceId: "gw-fake", time }],
		});
		if (this.processEvents && this.ctx) {
			await handleMachineEvents(this.ctx, { machineId });
		}
	}

	async #bsAccepted(vm: FakeVm): Promise<boolean> {
		const parts = vm.serial.split(":");
		if (
			parts.length !== 3 ||
			parts[0] !== "sbx1" ||
			parts[1] !== vm.machineId
		) {
			return false;
		}
		const bs = Buffer.from(parts[2] ?? "", "base64url");
		const r = await this.#pool.query<{
			bs_hash: Buffer;
			retired_at: Date | null;
		}>(
			"SELECT bs_hash, retired_at FROM tunnel.tunnel_credentials WHERE machine_id = $1",
			[vm.machineId],
		);
		const row = r.rows[0];
		return (
			row !== undefined &&
			row.retired_at === null &&
			bs.length === 32 &&
			createHash("sha256").update(bs).digest().equals(row.bs_hash)
		);
	}

	#nextSeq(machineId: string): number {
		const n = (this.#seq.get(machineId) ?? 0) + 1;
		this.#seq.set(machineId, n);
		return n;
	}

	/**
	 * An agent event on the machine's current boot (next seq), ingested
	 * through core and processed like a boot's events.
	 */
	async emit(machineId: string, type: string, payload: unknown): Promise<void> {
		const r = await this.#pool.query<{ boot_id: string }>(
			"SELECT boot_id FROM tunnel.tunnel_sessions WHERE machine_id = $1",
			[machineId],
		);
		const bootId = r.rows[0]?.boot_id;
		if (bootId === undefined)
			throw new Error(`machine ${machineId}: no session`);
		await ingestAgentEvents(this.#pool, this.#jobs, {
			machineId,
			events: [
				{
					seq: this.#nextSeq(machineId),
					bootId,
					type,
					time: new Date(),
					payload,
				},
			],
			synthetic: [],
		});
		if (this.processEvents && this.ctx) {
			await handleMachineEvents(this.ctx, { machineId });
		}
	}

	async powerOff(machineId: string): Promise<void> {
		await this.#pool.query(
			`UPDATE tunnel.tunnel_sessions SET state = 'disconnected', disconnected_at = now()
			 WHERE machine_id = $1 AND state = 'connected'`,
			[machineId],
		);
	}

	/** Waits for every boot in flight. */
	async settled(): Promise<void> {
		while (this.#pending.size > 0) {
			await Promise.all([...this.#pending]);
		}
	}
}

// ---------------------------------------------------------------------------
// Topology

let macId = 0;
let seq = 0;

export interface Topology {
	providerId: string;
	nodeId: string;
	storageId: string;
	templateBuildId: string;
	templateSlug: string;
	clusterMacId: number;
}

/**
 * Test setup: an active machine lease of `vmid` owned by `machineId` (a VM
 * made outside S1); returns the owner, as NodeInfra power operations expect.
 */
export async function leaseVm(
	q: Pick<pg.Pool, "query">,
	providerId: string,
	vmid: number,
	machineId: string = randomUUID(),
): Promise<{ expectedOwner: string; beforeAct: () => Promise<void> }> {
	await q.query(
		`INSERT INTO runtime.vmid_leases (provider_id, vmid, mac, state, purpose, machine_id)
		 VALUES ($1, $2, $3, 'active', 'machine', $4)`,
		[
			providerId,
			vmid,
			`02:ee:00:00:${(vmid >> 8).toString(16).padStart(2, "0")}:${(vmid & 255).toString(16).padStart(2, "0")}`,
			machineId,
		],
	);
	return { expectedOwner: machineId, beforeAct: async () => {} };
}

export interface TopologyOptions {
	ramCapMb?: number;
	cloneConcurrency?: number;
	bootTimeoutS?: number;
}

export async function createTopology(
	q: Pick<pg.Pool, "query">,
	o: TopologyOptions = {},
): Promise<Topology> {
	seq += 1;
	macId = (macId + 1) % 256;
	const providerId = randomUUID();
	const nodeId = randomUUID();
	const storageId = randomUUID();
	const templateBuildId = randomUUID();
	const templateSlug = `tpl${seq}`;
	await q.query(
		`INSERT INTO runtime.providers (id, kind, name, cluster_mac_id, vmid_min, vmid_max, api_url, secret_ref)
		 VALUES ($1, 'proxmox', $2, $3, 500, 598, 'https://pve:8006', 'pve')`,
		[providerId, `prov-${seq}-${providerId.slice(0, 8)}`, macId],
	);
	await q.query(
		`INSERT INTO runtime.nodes (id, provider_id, name, ram_cap_mb, clone_concurrency, node_agent_ref)
		 VALUES ($1, $2, $3, $4, $5, 'sbx-node')`,
		[
			nodeId,
			providerId,
			`node-${seq}`,
			o.ramCapMb ?? 8192,
			o.cloneConcurrency ?? 4,
		],
	);
	await q.query(
		`INSERT INTO runtime.storages (id, provider_id, node_id, name, driver)
		 VALUES ($1, $2, $3, 'local-lvm', 'lvmthin')`,
		[storageId, providerId, nodeId],
	);
	await q.query(
		`INSERT INTO runtime.template_builds
		   (id, template_slug, version, os, provider_id, node_id, storage_id, pve_vmid, disk_layout, hw,
		    boot_timeout_s, status)
		 VALUES ($1, $2, 'v1', 'linux', $3, $4, $5, 599, '{}', '{}', $6, 'active')`,
		[
			templateBuildId,
			templateSlug,
			providerId,
			nodeId,
			storageId,
			o.bootTimeoutS ?? 300,
		],
	);
	return {
		providerId,
		nodeId,
		storageId,
		templateBuildId,
		templateSlug,
		clusterMacId: macId,
	};
}

// ---------------------------------------------------------------------------
// World

export const TEST_TIMING: Timing = {
	pollMs: 10,
	supersedeCheckMs: 20,
	ramWaitPollMs: 10,
	ramWaitTimeoutMs: 3000,
	cloneSlotPollMs: 10,
	cloneSlotTimeoutMs: 3000,
};

export interface TestWorld {
	pool: pg.Pool;
	ctx: WorkerCtx;
	topo: Topology;
	infra: FakeInfra;
	registry: FakeInfraRegistry;
	agent: FakeAgent;
	gateway: FakeGateway;
	agentWorld: FakeAgentWorld;
	jobs: RecordingJobSender;
	metrics: RecordingMetrics;
	/** Captured log lines (JSON). */
	logs: string[];
	/** Puts a wrapped port (crashAfter, blockAfter, …) in place of the node's infra. */
	useInfra(port: NodeInfra): void;
}

export interface WorldOptions extends TopologyOptions {
	boot?: BootBehavior;
	processEvents?: boolean;
	timing?: Partial<Timing>;
}

export async function createWorld(
	db: TestDatabase,
	o: WorldOptions = {},
): Promise<TestWorld> {
	const pool = db.pool;
	const topo = await createTopology(pool, o);
	const jobs = new RecordingJobSender();
	const agentWorld = new FakeAgentWorld({
		pool,
		jobs,
		...(o.boot !== undefined ? { behavior: o.boot } : {}),
		...(o.processEvents !== undefined
			? { processEvents: o.processEvents }
			: {}),
	});
	const infra = new FakeInfra({
		pool,
		providerId: topo.providerId,
		clusterMacId: topo.clusterMacId,
		lifecycle: agentWorld,
	});
	const registry = new FakeInfraRegistry();
	registry.set(topo.nodeId, infra);
	const logs: string[] = [];
	const sink = new Writable({
		write(chunk, _enc, cb) {
			logs.push(String(chunk));
			cb();
		},
	});
	const metrics = new RecordingMetrics();
	const agent = new FakeAgent();
	const gateway = new FakeGateway();
	const ctx: WorkerCtx = {
		pool,
		db: db.db,
		jobs,
		config: StaticConfigReader.fromObject({
			templates: [
				{
					slug: topo.templateSlug,
					os: "linux",
					enabled: true,
					defaultSize: "2gb",
					allowedSizes: ["2gb", "4gb"],
				},
			],
			sizes: [
				{ slug: "2gb", vcpu: 2, memoryMb: 2048 },
				{ slug: "4gb", vcpu: 2, memoryMb: 4096 },
			],
			defaults: { defaultTemplate: topo.templateSlug },
		}),
		keys: KeyRing.fromObject({
			current: 1,
			keys: { "1": randomBytes(32).toString("base64") },
		}),
		infra: registry,
		agent,
		gateway,
		timing: { ...TEST_TIMING, ...o.timing },
		log: createLogger({ level: "debug" }, sink),
		metrics,
	};
	agentWorld.ctx = ctx;
	return {
		pool,
		ctx,
		topo,
		infra,
		registry,
		agent,
		gateway,
		agentWorld,
		jobs,
		metrics,
		logs,
		useInfra: (port) => registry.set(topo.nodeId, port),
	};
}

// ---------------------------------------------------------------------------
// Rows

export interface MachineInsert {
	state?: string;
	poolKey?: string | null;
	sandboxId?: string | null;
	memoryMb?: number;
	origin?: "template" | "snapshot";
	originSnapshotId?: string | null;
	powerObserved?: string;
	vmid?: number | null;
}

/** A machine row; by default a pool machine in `allocating` (as the pool controller makes it). */
export async function insertMachine(
	w: TestWorld,
	o: MachineInsert = {},
): Promise<string> {
	const id = randomUUID();
	await w.pool.query(
		`INSERT INTO runtime.machines
		   (id, provider_id, node_id, storage_id, template_build_id, origin, origin_snapshot_id, pool_key,
		    size_slug, vcpu, memory_mb, sandbox_id, state, power_observed, vmid)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2gb', 2, $9, $10, $11, $12, $13)`,
		[
			id,
			w.topo.providerId,
			w.topo.nodeId,
			w.topo.storageId,
			w.topo.templateBuildId,
			o.origin ?? "template",
			o.originSnapshotId ?? null,
			o.poolKey === undefined ? `${w.topo.templateSlug}/2gb` : o.poolKey,
			o.memoryMb ?? 2048,
			o.sandboxId ?? null,
			o.state ?? "allocating",
			o.powerObserved ?? "unknown",
			o.vmid ?? null,
		],
	);
	return id;
}

export interface SandboxInsert {
	state?: string;
	machineId?: string | null;
	origin?: "template" | "snapshot" | "fork";
	originSnapshotId?: string | null;
	health?: "ok" | "degraded";
}

export async function insertSandbox(
	w: TestWorld,
	o: SandboxInsert = {},
): Promise<string> {
	const id = randomUUID();
	await w.pool.query(
		`INSERT INTO runtime.sandboxes
		   (id, slug, team_id, template_slug, size_slug, vcpu, memory_mb, template_build_id, origin,
		    origin_snapshot_id, provider_id, node_id, machine_id, state, health, degraded_since)
		 VALUES ($1, $2, $3, $4, '2gb', 2, 2048, $5, $6, $7, $8, $9, $10, $11, $12,
		         CASE WHEN $12 = 'degraded' THEN now() ELSE NULL END)`,
		[
			id,
			`sbx-${id.slice(0, 8)}`,
			randomUUID(),
			w.topo.templateSlug,
			w.topo.templateBuildId,
			o.origin ?? "template",
			o.originSnapshotId ?? null,
			w.topo.providerId,
			w.topo.nodeId,
			o.machineId ?? null,
			o.state ?? "creating",
			o.health ?? "ok",
		],
	);
	return id;
}

export interface OperationInsert {
	sandboxId: string;
	kind?: string;
	state?: string;
	step?: string | null;
	parentOperationId?: string | null;
	/** Seconds from now; negative = passed; null = no deadline. */
	deadlineInS?: number | null;
}

export async function insertOperation(
	w: TestWorld,
	o: OperationInsert,
): Promise<string> {
	const id = randomUUID();
	await w.pool.query(
		`INSERT INTO runtime.operations (id, sandbox_id, kind, state, step, parent_operation_id, deadline_at)
		 VALUES ($1, $2, $3, $4, $5, $6,
		         CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(secs => $7::int) END)`,
		[
			id,
			o.sandboxId,
			o.kind ?? "create",
			o.state ?? "pending",
			o.step ?? null,
			o.parentOperationId ?? null,
			o.deadlineInS === undefined ? 360 : o.deadlineInS,
		],
	);
	return id;
}

/** A snapshot row with one disk and its LVs in the fake. */
export async function insertSnapshot(
	w: TestWorld,
	o: { state?: string; kind?: "saved" | "fork_source" } = {},
): Promise<{ snapshotId: string; lvId: string }> {
	const snapshotId = randomUUID();
	const lvId = snapshotId.replaceAll("-", "");
	await w.pool.query(
		`INSERT INTO runtime.snapshots
		   (id, kind, team_id, provider_id, node_id, storage_id, template_build_id, lv_id, hw, consistency, state)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{"cores":"2","memory":"2048"}', 'powered_off', $9)`,
		[
			snapshotId,
			o.kind ?? "saved",
			randomUUID(),
			w.topo.providerId,
			w.topo.nodeId,
			w.topo.storageId,
			w.topo.templateBuildId,
			lvId,
			o.state ?? "ready",
		],
	);
	const lv = w.infra.addSnapshotLvs(lvId);
	await w.pool.query(
		`INSERT INTO runtime.disks (snapshot_id, storage_id, slot, volume, size_bytes)
		 VALUES ($1, $2, 'scsi0', $3, 8589934592)`,
		[snapshotId, w.topo.storageId, `local-lvm:${lv}`],
	);
	return { snapshotId, lvId };
}

// ---------------------------------------------------------------------------
// Reads

export async function machine(
	w: TestWorld,
	id: string,
): Promise<Record<string, unknown>> {
	const r = await w.pool.query("SELECT * FROM runtime.machines WHERE id = $1", [
		id,
	]);
	if (!r.rows[0]) throw new Error(`machine ${id} not found`);
	return r.rows[0];
}

export async function leases(
	w: TestWorld,
): Promise<{ vmid: number; state: string; machine_id: string | null }[]> {
	const r = await w.pool.query(
		`SELECT vmid, state, machine_id FROM runtime.vmid_leases
		 WHERE provider_id = $1 AND purpose = 'machine' ORDER BY vmid`,
		[w.topo.providerId],
	);
	return r.rows;
}

export async function credentials(
	w: TestWorld,
	machineId: string,
): Promise<{ bs_hash: Buffer; retired_at: Date | null } | undefined> {
	const r = await w.pool.query(
		"SELECT bs_hash, retired_at FROM tunnel.tunnel_credentials WHERE machine_id = $1",
		[machineId],
	);
	return r.rows[0];
}

export async function activeDisks(
	w: TestWorld,
	machineId: string,
): Promise<string[]> {
	const r = await w.pool.query<{ volume: string }>(
		"SELECT volume FROM runtime.disks WHERE machine_id = $1 AND state = 'active' ORDER BY volume",
		[machineId],
	);
	return r.rows.map((x) => x.volume);
}

export async function heldCloneSlots(w: TestWorld): Promise<number> {
	const r = await w.pool.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM runtime.node_clone_slots
		 WHERE node_id = $1 AND holder IS NOT NULL AND expires_at > now()`,
		[w.topo.nodeId],
	);
	return r.rows[0]?.n ?? 0;
}

/** sha256 of the bootstrap secret carried in a fake VM's SMBIOS serial. */
export function bsHashOfSerial(serial: string): Buffer {
	const b64 = serial.split(":")[2] ?? "";
	return createHash("sha256").update(Buffer.from(b64, "base64url")).digest();
}
