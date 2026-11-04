import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPool, PgAllocatorStore } from "@umiak/db";
import {
	Allocator,
	type Config,
	LvmThinDriver,
	loadConfig,
	Machines,
	PveApi,
	type PveClient,
	pveVcpuControl,
	readSecretFile,
	SqliteStateStore,
	SshNodeOps,
} from "@umiak/pve";

// Configuration and clients of umiak-tpl: the S1 variables (spec S5 section 7)

/** Cap for the memory of running pool VMs (build VM included). */
export const RAM_CAP_MB = 8192;

export function templateRamCapMb(
	env: Record<string, string | undefined> = process.env,
): number {
	const cap = Number(env.UMIAK_TEMPLATE_RAM_CAP_MB ?? RAM_CAP_MB);
	if (!Number.isSafeInteger(cap) || cap < 2048 || cap > RAM_CAP_MB)
		throw new Error("Template build RAM cap must be 2048-8192 MiB");
	return cap;
}

type Env = Record<string, string | undefined>;

export function registryDir(
	env: Env = process.env,
	home: string = homedir(),
): string {
	return (
		env.UMIAK_TEMPLATE_REGISTRY ?? join(home, ".local/state/umiak/templates")
	);
}

export function imageCacheDir(
	env: Env = process.env,
	home: string = homedir(),
): string {
	return env.UMIAK_IMAGE_CACHE ?? join(home, ".cache/umiak/images");
}

export interface Ctx {
	cfg: Config;
	api: PveApi;
	node: SshNodeOps;
	store: SqliteStateStore;
	allocator: Allocator;
	close(): Promise<void>;
}

/** Partial production scope must fail closed instead of silently using local leases. */
export function buildLeaseScope(
	env: Env = process.env,
): { url: string; providerId: string; buildJobId: string } | undefined {
	const providerId = env.UMIAK_TEMPLATE_PROVIDER_ID;
	const buildJobId = env.UMIAK_TEMPLATE_BUILD_JOB_ID;
	if (!providerId && !buildJobId) return undefined;
	if (!providerId || !buildJobId || !env.DATABASE_URL)
		throw new Error(
			"Template build requires DATABASE_URL, provider and build job scope",
		);
	return { url: env.DATABASE_URL, providerId, buildJobId };
}

export async function makeContext(over: { node?: string } = {}): Promise<Ctx> {
	const scope = buildLeaseScope();
	const base = loadConfig();
	const cfg = over.node !== undefined ? { ...base, node: over.node } : base;
	const pool = scope ? createPool(scope.url, 2) : undefined;
	const runner = pool ? await pool.connect() : undefined;
	const disposers: (() => void)[] = [];
	try {
		if (runner && scope) {
			const locked = await runner.query<{ ok: boolean }>(
				"SELECT pg_try_advisory_lock(hashtextextended('template-runner:' || $1::text,0)) AS ok",
				[scope.buildJobId],
			);
			if (!locked.rows[0]?.ok)
				throw new Error("Template build runner is already alive");
			const job = await runner.query(
				"SELECT 1 FROM runtime.node_build_jobs b JOIN runtime.nodes n ON n.id=b.node_id WHERE b.id=$1 AND b.status='running' AND n.provider_id=$2 AND n.name=$3",
				[scope.buildJobId, scope.providerId, cfg.node],
			);
			if (!job.rowCount)
				throw new Error("Template build reservation is no longer running");
			// Losing the session lock must stop this process before cleanup can proceed.
			runner.on("error", () => process.kill(process.pid, "SIGKILL"));
		}
		const api = new PveApi({
			url: cfg.pveUrl,
			tokenId: cfg.tokenId,
			tokenSecret: readSecretFile(cfg.tokenSecretFile),
			ca: readFileSync(cfg.caFile),
			tlsName: cfg.tlsName,
		});
		disposers.push(() => api.close());
		const node = new SshNodeOps({
			host: cfg.nodeSshHost,
			privateKey: readFileSync(cfg.nodeSshKeyFile),
			knownHosts: readFileSync(cfg.nodeSshKnownHosts, "utf8"),
			// lv.scan reads a whole 64 GiB disk.
			callTimeoutMs: 15 * 60_000,
		});
		disposers.push(() => node.close());
		const store = new SqliteStateStore(cfg.stateDb);
		disposers.push(() => store.close());
		let machines: Machines | undefined;
		const allocator = new Allocator({
			store:
				pool && scope
					? new PgAllocatorStore(pool, scope.providerId, {
							buildJobId: scope.buildJobId,
						})
					: store,
			clusterId: cfg.clusterId,
			range: cfg.vmidRange,
			templateRange: cfg.templateVmidRange,
			templateVmid: cfg.templateVmid,
			occupied: () => (machines as Machines).occupiedVmids(),
		});
		if (!scope) await allocator.ensureTemplate();
		// Only for occupiedVmids: umiak-tpl never creates machines through it.
		machines = new Machines({
			api,
			node,
			driver: new LvmThinDriver({
				node,
				vcpu: pveVcpuControl(api, cfg.node),
				storage: cfg.storage,
			}),
			allocator,
			snapshots: store,
			cfg,
		});
		return {
			cfg,
			api,
			node,
			store,
			allocator,
			async close() {
				node.close();
				api.close();
				store.close();
				runner?.release(true);
				await pool?.end();
			},
		};
	} catch (error) {
		for (const close of disposers.reverse()) close();
		runner?.release(true);
		await pool?.end();
		throw error;
	}
}

/**
 * S1 machines cloned from `templateVmid` (a built template, not cfg.templateVmid) with the
 * context's clients: what `verify` creates and deletes.
 */
export function machinesFor(ctx: Ctx, templateVmid: number): Machines {
	const { cfg, api, node } = ctx;
	return new Machines({
		api,
		node,
		driver: new LvmThinDriver({
			node,
			vcpu: pveVcpuControl(api, cfg.node),
			storage: cfg.storage,
		}),
		allocator: ctx.allocator,
		snapshots: ctx.store,
		cfg: { ...cfg, templateVmid },
	});
}

/**
 * Memory of running non-template VMs of the pool plus this process's reservations plus the new
 * VM must stay within the cap. Running state comes from status/current: /cluster/resources lags.
 */
export class RamGuard {
	readonly #o: { api: PveClient; node: string; pool: string; capMb: number };
	readonly #reserved = new Map<number, number>();

	constructor(o: {
		api: PveClient;
		node: string;
		pool: string;
		capMb: number;
	}) {
		this.#o = o;
	}

	/** MB used by running pool VMs other than `except` and the reserved ones. */
	async runningMb(except?: number): Promise<number> {
		const { api, node, pool } = this.#o;
		const vms = await api.get<
			{
				vmid: number;
				node?: string;
				status: string;
				maxmem?: number;
				pool?: string;
				template?: number;
			}[]
		>("/cluster/resources", { type: "vm" });
		const others = vms.filter(
			(v) =>
				(v.node ?? node) === node &&
				v.pool === pool &&
				v.template !== 1 &&
				v.vmid !== except &&
				!this.#reserved.has(v.vmid),
		);
		const mem = await Promise.all(
			others.map(async (v) => {
				const st = await api
					.get<{ status: string; maxmem?: number }>(
						`/nodes/${v.node ?? node}/qemu/${v.vmid}/status/current`,
					)
					// Gone meanwhile or unreadable: the listed state counts.
					.catch(() => ({ status: v.status, maxmem: v.maxmem }));
				return st.status === "running" ? (st.maxmem ?? 0) / 1024 / 1024 : 0;
			}),
		);
		return mem.reduce((a, b) => a + b, 0);
	}

	async reserve(vmid: number, memoryMb: number): Promise<void> {
		const running = await this.runningMb(vmid);
		const reserved = [...this.#reserved.entries()]
			.filter(([id]) => id !== vmid)
			.reduce((a, [, mb]) => a + mb, 0);
		if (running + reserved + memoryMb > this.#o.capMb)
			throw new Error(
				`RAM cap: running ${running} MB + reserved ${reserved} MB + new ${memoryMb} MB > ${this.#o.capMb} MB`,
			);
		this.#reserved.set(vmid, memoryMb);
	}

	release(vmid: number): void {
		this.#reserved.delete(vmid);
	}
}
