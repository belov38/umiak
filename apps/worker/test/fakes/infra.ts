// In-memory S1 for one node. VMIDs and MACs come from the real Allocator over
// PgAllocatorStore, so leases are real rows of runtime.vmid_leases and
// `leaseOf` reads them. `start` hands the VM to the FakeAgentWorld, which
// "boots" it (tunnel session + agent events).
import { PgAllocatorStore } from "@sbx/db";
import { Allocator, type QuiesceHook } from "@sbx/pve";
import type pg from "pg";
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
	VmStatus,
} from "../../src/ports.ts";

export interface FakeVm {
	vmid: number;
	mac: string;
	/** SMBIOS uuid = machine id. */
	machineId: string;
	/** SMBIOS serial (S2 payload with the bootstrap secret). */
	serial: string;
	status: Exclude<VmStatus, "missing">;
	vcpu: number;
	memoryMb: number;
	disks: InfraDisk[];
	tags: string[];
	pool: string;
	starts: number;
}

export interface FakeLv {
	name: string;
	tags: string[];
}

export interface InfraCall {
	method: string;
	args: unknown[];
}

/** What FakeInfra needs from the world: boot on start, disconnect on power-off. */
export interface VmLifecycle {
	boot(infra: FakeInfra, vm: FakeVm): void;
	powerOff(machineId: string): Promise<void>;
}

export interface FakeInfraOptions {
	pool: pg.Pool;
	providerId: string;
	clusterMacId: number;
	vmidRange?: { min: number; max: number };
	templateVmids?: number[];
	storage?: string;
	lifecycle?: VmLifecycle;
}

const DISK_BYTES = 8 * 1024 ** 3;

export class FakeInfra implements NodeInfra {
	readonly vmidRange: { min: number; max: number };
	readonly templateVmids: number[];
	readonly vms = new Map<number, FakeVm>();
	readonly lvs = new Map<string, FakeLv>();
	readonly calls: InfraCall[] = [];
	readonly allocator: Allocator;
	lifecycle: VmLifecycle | undefined;
	readonly #pool: pg.Pool;
	readonly #providerId: string;
	readonly #storage: string;

	constructor(o: FakeInfraOptions) {
		this.#pool = o.pool;
		this.#providerId = o.providerId;
		this.#storage = o.storage ?? "local-lvm";
		this.vmidRange = o.vmidRange ?? { min: 500, max: 598 };
		this.templateVmids = o.templateVmids ?? [599];
		this.lifecycle = o.lifecycle;
		this.allocator = new Allocator({
			store: new PgAllocatorStore(o.pool, o.providerId),
			clusterId: o.clusterMacId,
			range: this.vmidRange,
			templateVmid: this.templateVmids[0] ?? 599,
			occupied: async () => this.#occupied(),
		});
	}

	#call(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
	}

	callsOf(method: string): InfraCall[] {
		return this.calls.filter((c) => c.method === method);
	}

	#occupied(): Set<number> {
		const ids = new Set(this.vms.keys());
		for (const name of this.lvs.keys()) {
			const m = /^vm-(\d+)-/.exec(name);
			if (m) ids.add(Number(m[1]));
		}
		return ids;
	}

	#vm(vmid: number): FakeVm {
		const vm = this.vms.get(vmid);
		if (!vm) throw new Error(`VM ${vmid} does not exist`);
		return vm;
	}

	async create(p: {
		machineId: string;
		templateVmid: number;
		size: InfraSize;
		smbios: InfraSmbios;
	}): Promise<CreatedVm> {
		this.#call("create", {
			machineId: p.machineId,
			templateVmid: p.templateVmid,
			size: p.size,
		});
		if (!this.templateVmids.includes(p.templateVmid)) {
			throw new Error(`template ${p.templateVmid} does not exist`);
		}
		return this.#build(p.machineId, p.size, p.smbios, undefined);
	}

	async fork(p: {
		machineId: string;
		snapshot: InfraSnapshotRef;
		size?: InfraSize;
		smbios: InfraSmbios;
	}): Promise<CreatedVm> {
		this.#call("fork", {
			machineId: p.machineId,
			lvId: p.snapshot.lvId,
			size: p.size,
		});
		const snapLvs = [...this.lvs.values()].filter((l) =>
			l.tags.includes(`sbx-snap-${p.snapshot.lvId}`),
		);
		if (snapLvs.length === 0) {
			throw new Error(`snapshot ${p.snapshot.lvId} has no LVs`);
		}
		const size = p.size ?? {
			vcpu: Number(p.snapshot.hw.cores ?? 2),
			memoryMb: Number(p.snapshot.hw.memory ?? 2048),
		};
		return this.#build(p.machineId, size, p.smbios, p.snapshot);
	}

	async #build(
		machineId: string,
		size: InfraSize,
		smbios: InfraSmbios,
		_snap: InfraSnapshotRef | undefined,
	): Promise<CreatedVm> {
		// As S1 (packages/pve Machines): a reused lease belongs to the owner's
		// other attempt; if its VM exists the create fails and nothing is
		// rolled back. Only a newly allocated VMID would be rolled back.
		const { vmid, mac, reused } = await this.allocator.allocate(machineId);
		if (this.vms.has(vmid)) {
			if (!reused) await this.allocator.release(vmid);
			throw new Error(
				`unable to create VM ${vmid} - config file already exists`,
			);
		}
		const lv = `vm-${vmid}-disk-0`;
		this.lvs.set(lv, { name: lv, tags: ["sbx"] });
		const disks: InfraDisk[] = [
			{
				slot: "scsi0",
				volume: `${this.#storage}:${lv}`,
				sizeBytes: DISK_BYTES,
				options: { discard: "on", iothread: "1" },
			},
		];
		this.vms.set(vmid, {
			vmid,
			mac,
			machineId: smbios.uuid,
			serial: smbios.serial,
			status: "stopped",
			vcpu: size.vcpu,
			memoryMb: size.memoryMb,
			disks,
			tags: ["sbx"],
			pool: "sandbox",
			starts: 0,
		});
		await this.allocator.markActive(vmid);
		return { vmid, mac, disks: structuredClone(disks) };
	}

	async start(vmid: number): Promise<void> {
		this.#call("start", vmid);
		const vm = this.#vm(vmid);
		if (vm.status === "running") return;
		vm.status = "running";
		vm.starts += 1;
		this.lifecycle?.boot(this, vm);
	}

	async shutdown(
		vmid: number,
		_timeoutS: number,
	): Promise<"stopped" | "timeout"> {
		this.#call("shutdown", vmid);
		await this.#powerOff(this.#vm(vmid));
		return "stopped";
	}

	async stop(vmid: number): Promise<void> {
		this.#call("stop", vmid);
		await this.#powerOff(this.#vm(vmid));
	}

	async #powerOff(vm: FakeVm): Promise<void> {
		if (vm.status === "stopped") return;
		vm.status = "stopped";
		await this.lifecycle?.powerOff(vm.machineId);
	}

	async status(vmid: number): Promise<VmStatus> {
		this.#call("status", vmid);
		return this.vms.get(vmid)?.status ?? "missing";
	}

	async configure(vmid: number, size: InfraSize): Promise<void> {
		this.#call("configure", vmid, size);
		const vm = this.#vm(vmid);
		vm.vcpu = size.vcpu;
		vm.memoryMb = size.memoryMb;
	}

	async vmSize(vmid: number): Promise<InfraSize> {
		const vm = this.#vm(vmid);
		return { vcpu: vm.vcpu, memoryMb: vm.memoryMb };
	}

	/** S1 delete: lease to releasing, VM and its LVs gone, then the lease is freed. */
	async delete(vmid: number): Promise<void> {
		this.#call("delete", vmid);
		if (this.templateVmids.includes(vmid)) {
			throw new Error(`refusing to delete the template VM ${vmid}`);
		}
		const lease = await this.allocator.get(vmid);
		if (lease) await this.allocator.markReleasing(vmid);
		const vm = this.vms.get(vmid);
		if (vm) {
			await this.#powerOff(vm);
			this.vms.delete(vmid);
		}
		for (const name of [...this.lvs.keys()]) {
			if (name.startsWith(`vm-${vmid}-`)) this.lvs.delete(name);
		}
		await this.allocator.release(vmid);
	}

	async leaseOf(
		machineId: string,
	): Promise<{ vmid: number; mac: string } | undefined> {
		this.#call("leaseOf", machineId);
		const r = await this.#pool.query<{ vmid: number; mac: string }>(
			`SELECT vmid, mac FROM runtime.vmid_leases
			 WHERE provider_id = $1 AND machine_id = $2
			 ORDER BY (state = 'releasing'), vmid LIMIT 1`,
			[this.#providerId, machineId],
		);
		return r.rows[0];
	}

	async snapshot(
		vmid: number,
		opts: { lvId: string; hook?: QuiesceHook },
	): Promise<InfraSnapshotResult> {
		this.#call("snapshot", vmid, { lvId: opts.lvId, hook: !!opts.hook });
		const vm = this.#vm(vmid);
		// As sbx-node lv.snapshot: an LV of that name must not exist yet.
		if (
			[...this.lvs.values()].some((l) =>
				l.tags.includes(`sbx-snap-${opts.lvId}`),
			)
		) {
			throw new Error(`snapshot ${opts.lvId}: LV already exists`);
		}
		const running = vm.status === "running";
		if (running && opts.hook) await opts.hook.freeze();
		try {
			const name = `sbx-snap-${opts.lvId}-scsi0`;
			this.lvs.set(name, { name, tags: ["sbx", `sbx-snap-${opts.lvId}`] });
			return {
				disks: [
					{
						slot: "scsi0",
						volume: `${this.#storage}:${name}`,
						sizeBytes: DISK_BYTES,
						options: { discard: "on" },
					},
				],
				hw: { cores: String(vm.vcpu), memory: String(vm.memoryMb) },
				consistency: running ? "quiesced" : "powered_off",
			};
		} finally {
			if (running && opts.hook) await opts.hook.thaw();
		}
	}

	async deleteSnapshot(ref: InfraSnapshotRef): Promise<void> {
		this.#call("deleteSnapshot", { lvId: ref.lvId });
		for (const [name, lv] of [...this.lvs]) {
			if (lv.tags.includes(`sbx-snap-${ref.lvId}`)) this.lvs.delete(name);
		}
	}

	/** Test setup: LVs of a snapshot that exists outside this fake's history. */
	addSnapshotLvs(lvId: string): string {
		const name = `sbx-snap-${lvId}-scsi0`;
		this.lvs.set(name, { name, tags: ["sbx", `sbx-snap-${lvId}`] });
		return name;
	}

	async listVms(): Promise<InfraVm[]> {
		return [...this.vms.values()].map((v) => ({
			vmid: v.vmid,
			status: v.status,
			pool: v.pool,
			tags: [...v.tags],
		}));
	}

	async listLvs(): Promise<InfraLv[]> {
		return [...this.lvs.values()].map((l) => ({
			name: l.name,
			tags: [...l.tags],
		}));
	}

	async removeLvs(names: string[]): Promise<void> {
		this.#call("removeLvs", names);
		for (const n of names) this.lvs.delete(n);
	}

	async qgaPing(vmid: number): Promise<boolean> {
		return this.vms.get(vmid)?.status === "running";
	}

	async qgaExec(vmid: number, argv: string[]): Promise<{ exitCode: number }> {
		this.#call("qgaExec", vmid, argv);
		this.#vm(vmid);
		return { exitCode: 0 };
	}

	/** VMs whose SMBIOS uuid is the machine. */
	vmsOf(machineId: string): FakeVm[] {
		return [...this.vms.values()].filter((v) => v.machineId === machineId);
	}
}

export class FakeInfraRegistry implements InfraRegistry {
	readonly #nodes = new Map<string, NodeInfra>();

	set(nodeId: string, infra: NodeInfra): void {
		this.#nodes.set(nodeId, infra);
	}

	async forNode(nodeId: string): Promise<NodeInfra> {
		const infra = this.#nodes.get(nodeId);
		if (!infra) throw new Error(`no infrastructure for node ${nodeId}`);
		return infra;
	}
}
