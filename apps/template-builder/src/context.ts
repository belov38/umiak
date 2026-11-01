import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
	close(): void;
}

export async function makeContext(over: { node?: string } = {}): Promise<Ctx> {
	const base = loadConfig();
	const cfg = over.node !== undefined ? { ...base, node: over.node } : base;
	const api = new PveApi({
		url: cfg.pveUrl,
		tokenId: cfg.tokenId,
		tokenSecret: readSecretFile(cfg.tokenSecretFile),
		ca: readFileSync(cfg.caFile),
		tlsName: cfg.tlsName,
	});
	const node = new SshNodeOps({
		host: cfg.nodeSshHost,
		privateKey: readFileSync(cfg.nodeSshKeyFile),
		knownHosts: readFileSync(cfg.nodeSshKnownHosts, "utf8"),
		// lv.scan reads a whole 64 GiB disk.
		callTimeoutMs: 15 * 60_000,
	});
	const store = new SqliteStateStore(cfg.stateDb);
	let machines: Machines | undefined;
	const allocator = new Allocator({
		store,
		clusterId: cfg.clusterId,
		range: cfg.vmidRange,
		templateRange: cfg.templateVmidRange,
		templateVmid: cfg.templateVmid,
		occupied: () => (machines as Machines).occupiedVmids(),
	});
	await allocator.ensureTemplate();
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
		close() {
			node.close();
			api.close();
			store.close();
		},
	};
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
