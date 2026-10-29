import { readFileSync } from "node:fs";
import {
	Allocator,
	type Config,
	LvmThinDriver,
	loadConfig,
	Machines,
	PveApi,
	pveVcpuControl,
	readSecretFile,
	SqliteStateStore,
	SshNodeOps,
} from "@sbx/pve";

export interface Ctx {
	cfg: Config;
	api: PveApi;
	node: SshNodeOps;
	store: SqliteStateStore;
	allocator: Allocator;
	driver: LvmThinDriver;
	machines: Machines;
	close(): void;
}

export function makeContext(opts: { cloneConcurrency?: number } = {}): Ctx {
	const cfg = loadConfig();
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
	});
	const store = new SqliteStateStore(cfg.stateDb);
	const driver = new LvmThinDriver({
		node,
		vcpu: pveVcpuControl(api, cfg.node),
		storage: cfg.storage,
	});
	let machines: Machines | undefined;
	const allocator = new Allocator({
		store,
		clusterId: cfg.clusterId,
		range: cfg.vmidRange,
		templateVmid: cfg.templateVmid,
		occupied: () => (machines as Machines).occupiedVmids(),
	});
	allocator.ensureTemplate();
	machines = new Machines({
		api,
		node,
		driver,
		allocator,
		snapshots: store,
		cfg,
		cloneConcurrency: opts.cloneConcurrency ?? 4,
		ipfilter: true,
	});
	return {
		cfg,
		api,
		node,
		store,
		allocator,
		driver,
		machines,
		close() {
			node.close();
			api.close();
			store.close();
		},
	};
}

/**
 * Running memory of sandbox VMs plus in-process reservations must stay under the cap. The running
 * state comes from status/current: /cluster/resources lags by seconds, so a recycled VMID may still
 * show as running there.
 */
export class RamGuard {
	readonly #reserved = new Map<number, number>();
	readonly #ctx: Ctx;
	readonly capMb: number;
	/** Reservations are checked one at a time so concurrent starts cannot overshoot together. */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(ctx: Ctx, capMb: number) {
		this.#ctx = ctx;
		this.capMb = capMb;
	}

	reserve(vmid: number, memoryMb: number): Promise<void> {
		const run = this.#queue.then(() => this.#reserve(vmid, memoryMb));
		this.#queue = run.catch(() => {});
		return run;
	}

	async #reserve(vmid: number, memoryMb: number): Promise<void> {
		const { api, cfg } = this.#ctx;
		const vms = await api.get<
			{
				vmid: number;
				status: string;
				maxmem?: number;
				pool?: string;
				template?: number;
			}[]
		>("/cluster/resources", { type: "vm" });
		const others = vms.filter(
			(v) =>
				v.pool === cfg.pool &&
				!v.template &&
				v.vmid !== vmid &&
				!this.#reserved.has(v.vmid),
		);
		const mem = await Promise.all(
			others.map(async (v) => {
				const st = await api
					.get<{ status: string; maxmem?: number }>(
						`/nodes/${cfg.node}/qemu/${v.vmid}/status/current`,
					)
					// Gone meanwhile or unreadable: fall back to the listed status.
					.catch(() => ({ status: v.status, maxmem: v.maxmem }));
				return st.status === "running" ? (st.maxmem ?? 0) / 1024 / 1024 : 0;
			}),
		);
		const running = mem.reduce((a, b) => a + b, 0);
		const reserved = [...this.#reserved.values()].reduce((a, b) => a + b, 0);
		if (running + reserved + memoryMb > this.capMb) {
			throw new Error(
				`RAM cap: running ${running} MB + reserved ${reserved} MB + new ${memoryMb} MB > ${this.capMb} MB`,
			);
		}
		this.#reserved.set(vmid, memoryMb);
	}

	release(vmid: number): void {
		this.#reserved.delete(vmid);
	}
}
