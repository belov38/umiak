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

export async function makeContext(
	opts: { cloneConcurrency?: number } = {},
): Promise<Ctx> {
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
	await allocator.ensureTemplate();
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

/** Running memory of sandbox VMs plus in-process reservations must stay under the cap. */
export class RamGuard {
	readonly #reserved = new Map<number, number>();
	readonly #ctx: Ctx;
	readonly capMb: number;

	constructor(ctx: Ctx, capMb: number) {
		this.#ctx = ctx;
		this.capMb = capMb;
	}

	async reserve(vmid: number, memoryMb: number): Promise<void> {
		const vms = await this.#ctx.api.get<
			{ vmid: number; status: string; maxmem?: number; pool?: string }[]
		>("/cluster/resources", { type: "vm" });
		const running = vms
			.filter(
				(v) =>
					v.pool === this.#ctx.cfg.pool &&
					v.status === "running" &&
					!this.#reserved.has(v.vmid),
			)
			.reduce((acc, v) => acc + (v.maxmem ?? 0) / 1024 / 1024, 0);
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
