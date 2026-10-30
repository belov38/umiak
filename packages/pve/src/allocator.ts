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
	/** Opaque id of the entity that owns the lease (S6: machine id). Makes allocate idempotent. */
	ownerId?: string;
}

type MaybePromise<T> = T | Promise<T>;

/** Allocator state. SQLite in the PoC (synchronous), Postgres in S6 (asynchronous). */
export interface AllocatorStore {
	/** Inserts the row; false on a uniqueness conflict. The insert is the lock. */
	tryInsert(l: VmidLease): MaybePromise<boolean>;
	get(cluster: number, vmid: number): MaybePromise<VmidLease | undefined>;
	list(cluster: number): MaybePromise<VmidLease[]>;
	setState(
		cluster: number,
		vmid: number,
		state: LeaseState,
	): MaybePromise<void>;
	remove(cluster: number, vmid: number): MaybePromise<void>;
	/**
	 * Removes the row only while it is `releasing` and owned by `ownerId`
	 * (null: an ownerless reservation); true if a row was removed. Optional:
	 * without it the allocator reads, compares and removes.
	 */
	removeReleasing?(
		cluster: number,
		vmid: number,
		ownerId: string | null,
	): MaybePromise<boolean>;
	/** Lease of the owner that is not in the releasing state, if any. */
	findByOwner?(
		cluster: number,
		ownerId: string,
	): MaybePromise<VmidLease | undefined>;
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

export interface AllocatedVmid {
	vmid: number;
	mac: string;
	/** The owner's existing lease was returned instead of a new one. */
	reused: boolean;
}

export interface AllocatorOptions {
	store: AllocatorStore;
	clusterId: number;
	range: { min: number; max: number };
	templateVmid: number;
	/** Where allocateTemplate looks; defaults to `range`. */
	templateRange?: { min: number; max: number };
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

	async ensureTemplate(): Promise<void> {
		const { store, clusterId, templateVmid } = this.#o;
		if (await store.get(clusterId, templateVmid)) return;
		const t = this.#now();
		await store.tryInsert({
			cluster: clusterId,
			vmid: templateVmid,
			mac: macFor(clusterId, templateVmid),
			state: "active",
			purpose: "template",
			createdAt: t,
			updatedAt: t,
		});
	}

	/**
	 * VMID for a new template (S5): the first free one of `slots` (the recipe's template slots,
	 * each inside the template range), or without slots the template range from range.max down,
	 * so templates stay away from the VMIDs machines take from range.min. The legacy template VMID
	 * is never taken. The lease is a `reserved` purpose=template row; the caller marks it active
	 * once the VM exists, or releases it after a failed build.
	 */
	async allocateTemplate(slots?: readonly number[]): Promise<AllocatedVmid> {
		const { store, clusterId, templateVmid } = this.#o;
		const range = this.#o.templateRange ?? this.#o.range;
		const outside = slots?.filter((v) => v < range.min || v > range.max);
		if (outside?.length)
			throw new AllocatorError(
				"vmid_exhausted",
				`template slots ${outside.join(", ")} are outside ${range.min}-${range.max}`,
			);
		const order = slots ? [...slots] : [];
		if (!slots)
			for (let vmid = range.max; vmid >= range.min; vmid--) order.push(vmid);
		const occupied = await this.#o.occupied();
		const taken = new Set((await store.list(clusterId)).map((l) => l.vmid));
		for (const vmid of order) {
			if (vmid === templateVmid || taken.has(vmid) || occupied.has(vmid))
				continue;
			const t = this.#now();
			const mac = macFor(clusterId, vmid);
			if (
				await store.tryInsert({
					cluster: clusterId,
					vmid,
					mac,
					state: "reserved",
					purpose: "template",
					createdAt: t,
					updatedAt: t,
				})
			)
				return { vmid, mac, reused: false };
		}
		throw new AllocatorError(
			"vmid_exhausted",
			slots
				? `no free template slot among ${slots.join(", ")}`
				: `no free VMID in ${range.min}-${range.max}`,
		);
	}

	/**
	 * Takes an ownerless `releasing` lease of a VMID that has none, so that
	 * allocate skips it while a delete of a lease-less (orphan) VM runs; the
	 * delete's final release removes this row. False if a lease exists
	 * (someone else's: the caller re-reads it).
	 */
	async reserveForDelete(vmid: number): Promise<boolean> {
		const { store, clusterId } = this.#o;
		const t = this.#now();
		return store.tryInsert({
			cluster: clusterId,
			vmid,
			mac: macFor(clusterId, vmid),
			state: "releasing",
			purpose: "machine",
			createdAt: t,
			updatedAt: t,
		});
	}

	/**
	 * With ownerId, repeated calls return the owner's existing lease unless it
	 * is releasing; `reused` tells the caller so. A reused lease may already
	 * have a VM (another executor of the same owner made it), so the caller
	 * must not roll it back on failure.
	 */
	async allocate(ownerId?: string): Promise<AllocatedVmid> {
		const { store, clusterId, range, templateVmid } = this.#o;
		if (ownerId !== undefined) {
			const own = await this.#findOwned(ownerId);
			if (own) return { vmid: own.vmid, mac: own.mac, reused: true };
		}
		const occupied = await this.#o.occupied();
		const taken = new Set((await store.list(clusterId)).map((l) => l.vmid));
		for (let vmid = range.min; vmid <= range.max; vmid++) {
			if (vmid === templateVmid || taken.has(vmid) || occupied.has(vmid))
				continue;
			const t = this.#now();
			const mac = macFor(clusterId, vmid);
			if (
				await store.tryInsert({
					cluster: clusterId,
					vmid,
					mac,
					state: "reserved",
					purpose: "machine",
					createdAt: t,
					updatedAt: t,
					...(ownerId !== undefined ? { ownerId } : {}),
				})
			) {
				return { vmid, mac, reused: false };
			}
			// A concurrent allocate of the same owner may have won the race
			// after our first lookup: the store refuses a second live lease of
			// one owner, so every further insert would fail too.
			if (ownerId !== undefined) {
				const own = await this.#findOwned(ownerId);
				if (own) return { vmid: own.vmid, mac: own.mac, reused: true };
			}
		}
		throw new AllocatorError(
			"vmid_exhausted",
			`no free VMID in ${range.min}-${range.max}`,
		);
	}

	async #findOwned(ownerId: string): Promise<VmidLease | undefined> {
		const { store, clusterId } = this.#o;
		const found = store.findByOwner
			? await store.findByOwner(clusterId, ownerId)
			: (await store.list(clusterId)).find(
					(l) => l.ownerId === ownerId && l.state !== "releasing",
				);
		return found && found.state !== "releasing" ? found : undefined;
	}

	async markActive(vmid: number): Promise<void> {
		await this.#o.store.setState(this.#o.clusterId, vmid, "active");
	}

	async markReleasing(vmid: number): Promise<void> {
		await this.#o.store.setState(this.#o.clusterId, vmid, "releasing");
	}

	/** Frees the VMID and MAC. Call only after delete verified that no traces remain. */
	async release(vmid: number): Promise<void> {
		await this.#o.store.remove(this.#o.clusterId, vmid);
	}

	/**
	 * The final release of a delete: frees the VMID only while its lease is
	 * still the `releasing` one of `ownerId` (null: a delete's ownerless
	 * reservation), so a release never frees a lease that changed hands.
	 * False if no such row was there.
	 */
	async releaseOwned(vmid: number, ownerId: string | null): Promise<boolean> {
		const { store, clusterId } = this.#o;
		if (store.removeReleasing)
			return store.removeReleasing(clusterId, vmid, ownerId);
		const l = await store.get(clusterId, vmid);
		if (l?.state !== "releasing" || (l.ownerId ?? null) !== ownerId)
			return false;
		await store.remove(clusterId, vmid);
		return true;
	}

	async get(vmid: number): Promise<VmidLease | undefined> {
		return this.#o.store.get(this.#o.clusterId, vmid);
	}

	async list(): Promise<VmidLease[]> {
		return this.#o.store.list(this.#o.clusterId);
	}
}
