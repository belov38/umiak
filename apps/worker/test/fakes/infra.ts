// In-memory S1 for one node. VMIDs and MACs come from the real Allocator over
// PgAllocatorStore, so leases are real rows of runtime.vmid_leases and
// `leaseOf` reads them. `start` hands the VM to the FakeAgentWorld, which
// "boots" it (tunnel session + agent events). start, stop, shutdown and delete
// go through an in-process power gate (as the adapter's per-node power lock)
// and S1's owner check (checkLeaseOwner) on the real lease rows.
import { randomUUID } from "node:crypto";
import { PgAllocatorStore } from "@umiak/db";
import {
	Allocator,
	checkLeaseOwner,
	type PowerOp,
	type QuiesceHook,
} from "@umiak/pve";
import type pg from "pg";
import { QuiesceFailed } from "../../src/ops/snapshot-step.ts";
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
	#powerGate: Promise<void> = Promise.resolve();

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

	/** Test control: order of hook calls and snapshots, when a test shares one list with the agent fake. */
	trace: string[] | undefined;
	/** Test control: the next QGA freeze (qgaFreezeHook) fails with this error. */
	qgaFreezeFailure: Error | undefined;
	/** Test control: the next QGA thaw reports the guest already thawed (QuiesceFailed). */
	qgaAlreadyThawed = false;
	/** Test control: the next snapshot with a hook fails with this error (as classified by the adapter). */
	snapshotFailure: Error | undefined;
	/** Test control: as snapshotFailure, but after the hook's freeze returned (and its thaw). */
	snapshotFailureAfterFreeze: Error | undefined;

	#call(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
	}

	/** FIFO like the adapter's power gate; settles on success and failure. */
	#powerSerialized<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#powerGate.then(fn);
		this.#powerGate = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	/**
	 * Test control: takes the power lock until the returned function is
	 * called (another power operation of the node in flight).
	 */
	holdPower(): () => void {
		let release: () => void = () => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		void this.#powerSerialized(() => held);
		return release;
	}

	/** S1's owner check against the lease row; false: a delete with nothing to do. */
	async #ownerCheck(
		op: PowerOp,
		vmid: number,
		expectedOwner: string | null,
	): Promise<boolean> {
		return checkLeaseOwner({
			op,
			vmid,
			lease: await this.allocator.get(vmid),
			expectedOwner,
			vmExists: async () => this.vms.has(vmid),
		});
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
			l.tags.includes(`umiak-snap-${p.snapshot.lvId}`),
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
		this.lvs.set(lv, { name: lv, tags: ["umiak"] });
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
			tags: ["umiak"],
			pool: "umiak",
			starts: 0,
		});
		await this.allocator.markActive(vmid);
		return { vmid, mac, disks: structuredClone(disks) };
	}

	start(vmid: number, o: StartOpts): Promise<void> {
		this.#call("start", vmid);
		return this.#powerSerialized(async () => {
			await o.beforeAct();
			await this.#ownerCheck("start", vmid, o.expectedOwner);
			const vm = this.#vm(vmid);
			if (vm.status === "running") return;
			vm.status = "running";
			vm.starts += 1;
			this.lifecycle?.boot(this, vm);
		});
	}

	shutdown(
		vmid: number,
		timeoutS: number,
		o: PowerOpts,
	): Promise<"stopped" | "timeout"> {
		this.#call("shutdown", vmid, timeoutS);
		return this.#powerSerialized(async () => {
			await o.beforeAct?.();
			await this.#ownerCheck("shutdown", vmid, o.expectedOwner);
			await this.#powerOff(this.#vm(vmid));
			return "stopped" as const;
		});
	}

	stop(vmid: number, o: PowerOpts): Promise<void> {
		this.#call("stop", vmid);
		return this.#powerSerialized(async () => {
			await o.beforeAct?.();
			await this.#ownerCheck("stop", vmid, o.expectedOwner);
			await this.#powerOff(this.#vm(vmid));
		});
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

	/** S1 delete: owner check, lease to releasing, VM and its LVs gone, then the lease is freed. */
	delete(vmid: number, o: { expectedOwner: string | null }): Promise<void> {
		this.#call("delete", vmid);
		if (this.templateVmids.includes(vmid)) {
			return Promise.reject(
				new Error(`refusing to delete the template VM ${vmid}`),
			);
		}
		return this.#powerSerialized(async () => {
			// As S1: a VMID without a lease is reserved before anything is deleted.
			let lease = await this.allocator.get(vmid);
			for (let attempt = 0; ; attempt++) {
				const go = await checkLeaseOwner({
					op: "delete",
					vmid,
					lease,
					expectedOwner: o.expectedOwner,
					vmExists: async () => this.vms.has(vmid),
				});
				if (!go) return;
				if (lease) break;
				if (await this.allocator.reserveForDelete(vmid)) break;
				if (attempt >= 2) throw new Error(`VM ${vmid}: lease keeps changing`);
				lease = await this.allocator.get(vmid);
			}
			await this.#destroy(vmid);
		});
	}

	async #destroy(vmid: number): Promise<void> {
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
		// As S1: only this delete's releasing row (owner, or null for the reservation).
		await this.allocator.releaseOwned(vmid, lease?.ownerId ?? null);
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
		opts: {
			lvId: string;
			hook?: QuiesceHook;
			crashConsistent?: boolean;
			expectedOwner?: string;
			beforeAct?: () => Promise<unknown>;
		},
	): Promise<InfraSnapshotResult> {
		await opts.beforeAct?.();
		if (opts.expectedOwner !== undefined) {
			const lease = await this.allocator.get(vmid);
			if (lease?.ownerId !== opts.expectedOwner)
				throw Object.assign(new Error("snapshot lease owner changed"), {
					code: "owner_mismatch",
					retryable: false,
				});
		}
		this.#call("snapshot", vmid, { lvId: opts.lvId, hook: !!opts.hook });
		const injected = this.snapshotFailure;
		if (injected && opts.hook) {
			this.snapshotFailure = undefined;
			throw injected;
		}
		const late = this.snapshotFailureAfterFreeze;
		if (late && opts.hook) {
			this.snapshotFailureAfterFreeze = undefined;
			await opts.hook.freeze();
			await opts.hook.thaw().catch(() => {});
			throw late;
		}
		const vm = this.#vm(vmid);
		// As umiak-node lv.snapshot: an LV of that name must not exist yet.
		if (
			[...this.lvs.values()].some((l) =>
				l.tags.includes(`umiak-snap-${opts.lvId}`),
			)
		) {
			throw new Error(`snapshot ${opts.lvId}: LV already exists`);
		}
		const running = vm.status === "running";
		if (running && opts.hook) {
			try {
				await opts.hook.freeze();
			} catch (e) {
				await opts.hook.thaw().catch(() => {});
				throw e;
			}
		}
		try {
			this.trace?.push("snapshot");
			const name = `umiak-snap-${opts.lvId}-scsi0`;
			this.lvs.set(name, { name, tags: ["umiak", `umiak-snap-${opts.lvId}`] });
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
				consistency: running
					? opts.crashConsistent
						? "crash"
						: "quiesced"
					: "powered_off",
			};
		} finally {
			if (running && opts.hook) await opts.hook.thaw();
		}
	}

	async deleteSnapshot(ref: InfraSnapshotRef): Promise<void> {
		this.#call("deleteSnapshot", { lvId: ref.lvId });
		for (const [name, lv] of [...this.lvs]) {
			if (lv.tags.includes(`umiak-snap-${ref.lvId}`)) this.lvs.delete(name);
		}
	}

	/** Test setup: LVs of a snapshot that exists outside this fake's history. */
	addSnapshotLvs(lvId: string): string {
		const name = `umiak-snap-${lvId}-scsi0`;
		this.lvs.set(name, { name, tags: ["umiak", `umiak-snap-${lvId}`] });
		return name;
	}

	/** Test setup: a VM that exists in Proxmox outside this fake's history (no lease). */
	addVm(o: {
		vmid: number;
		status?: Exclude<VmStatus, "missing">;
		pool?: string;
		tags?: string[];
		machineId?: string;
		withDisk?: boolean;
	}): FakeVm {
		const vm: FakeVm = {
			vmid: o.vmid,
			mac: "02:00:00:00:00:00",
			machineId: o.machineId ?? randomUUID(),
			serial: "",
			status: o.status ?? "running",
			vcpu: 2,
			memoryMb: 2048,
			disks: [],
			tags: o.tags ?? ["umiak"],
			pool: o.pool ?? "umiak",
			starts: 0,
		};
		this.vms.set(o.vmid, vm);
		if (o.withDisk !== false) {
			const lv = `vm-${o.vmid}-disk-0`;
			this.lvs.set(lv, { name: lv, tags: ["umiak", `umiak-vm-${o.vmid}`] });
		}
		return vm;
	}

	/** Test setup: an LV with the given tags. */
	addLv(name: string, tags: string[]): void {
		this.lvs.set(name, { name, tags: [...tags] });
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

	qgaFreezeHook(vmid: number): QuiesceHook {
		this.#call("qgaFreezeHook", vmid);
		let frozen = false;
		return {
			freeze: async () => {
				const failure = this.qgaFreezeFailure;
				if (failure) {
					this.qgaFreezeFailure = undefined;
					this.trace?.push("qga.freeze(failed)");
					throw failure;
				}
				frozen = true;
				this.trace?.push("qga.freeze");
			},
			thaw: async () => {
				if (!frozen) return;
				frozen = false;
				this.trace?.push("qga.thaw");
				if (this.qgaAlreadyThawed) {
					this.qgaAlreadyThawed = false;
					throw new QuiesceFailed(`VM ${vmid}: the guest was already thawed`);
				}
			},
		};
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
