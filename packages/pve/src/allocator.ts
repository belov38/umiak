import type { SnapshotRef } from "./storage/types.ts";

export type LeaseState = "reserved" | "active" | "releasing";
export type LeasePurpose = "machine" | "template";

export interface VmidLease {
	cluster: number;
	vmid: number;
	mac: string;
	state: LeaseState;
	purpose: LeasePurpose;
	createdAt: number;
	updatedAt: number;
}

/** Allocator state. SQLite in the PoC, Postgres in S6. */
export interface AllocatorStore {
	/** Inserts the row; false on a uniqueness conflict. The insert is the lock. */
	tryInsert(l: VmidLease): boolean;
	get(cluster: number, vmid: number): VmidLease | undefined;
	list(cluster: number): VmidLease[];
	setState(cluster: number, vmid: number, state: LeaseState): void;
	remove(cluster: number, vmid: number): void;
}

export interface SnapshotStore {
	putSnapshot(s: SnapshotRef): void;
	getSnapshot(id: string): SnapshotRef | undefined;
	listSnapshots(): SnapshotRef[];
	removeSnapshot(id: string): void;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

/** Locally administered unicast MAC: 02:<cluster>:<vmid as 4 bytes big-endian>. */
export function macFor(clusterId: number, vmid: number): string {
	return [
		"02",
		hex2(clusterId),
		hex2((vmid >>> 24) & 0xff),
		hex2((vmid >>> 16) & 0xff),
		hex2((vmid >>> 8) & 0xff),
		hex2(vmid & 0xff),
	].join(":");
}

export class AllocatorError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "AllocatorError";
		this.code = code;
	}
}

export interface AllocatorOptions {
	store: AllocatorStore;
	clusterId: number;
	range: { min: number; max: number };
	templateVmid: number;
	/** VMIDs taken outside our table: VMs in /cluster/resources and LVs vm-<id>-*. */
	occupied: () => Promise<Set<number>>;
	now?: () => number;
}

export class Allocator {
	readonly #o: AllocatorOptions;

	constructor(opts: AllocatorOptions) {
		this.#o = opts;
	}

	#now(): number {
		return (this.#o.now ?? Date.now)();
	}

	ensureTemplate(): void {
		const { store, clusterId, templateVmid } = this.#o;
		if (store.get(clusterId, templateVmid)) return;
		const t = this.#now();
		store.tryInsert({
			cluster: clusterId,
			vmid: templateVmid,
			mac: macFor(clusterId, templateVmid),
			state: "active",
			purpose: "template",
			createdAt: t,
			updatedAt: t,
		});
	}

	async allocate(): Promise<{ vmid: number; mac: string }> {
		const { store, clusterId, range, templateVmid } = this.#o;
		const occupied = await this.#o.occupied();
		const taken = new Set(store.list(clusterId).map((l) => l.vmid));
		for (let vmid = range.min; vmid <= range.max; vmid++) {
			if (vmid === templateVmid || taken.has(vmid) || occupied.has(vmid))
				continue;
			const t = this.#now();
			const mac = macFor(clusterId, vmid);
			if (
				store.tryInsert({
					cluster: clusterId,
					vmid,
					mac,
					state: "reserved",
					purpose: "machine",
					createdAt: t,
					updatedAt: t,
				})
			) {
				return { vmid, mac };
			}
		}
		throw new AllocatorError(
			"vmid_exhausted",
			`no free VMID in ${range.min}-${range.max}`,
		);
	}

	markActive(vmid: number): void {
		this.#o.store.setState(this.#o.clusterId, vmid, "active");
	}

	markReleasing(vmid: number): void {
		this.#o.store.setState(this.#o.clusterId, vmid, "releasing");
	}

	/** Frees the VMID and MAC. Call only after delete verified that no traces remain. */
	release(vmid: number): void {
		this.#o.store.remove(this.#o.clusterId, vmid);
	}

	get(vmid: number): VmidLease | undefined {
		return this.#o.store.get(this.#o.clusterId, vmid);
	}

	list(): VmidLease[] {
		return this.#o.store.list(this.#o.clusterId);
	}
}
