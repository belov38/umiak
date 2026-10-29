import { describe, expect, it } from "vitest";
import {
	Allocator,
	type AllocatorStore,
	macFor,
	type VmidLease,
} from "../src/allocator.ts";
import { SqliteStateStore } from "../src/state-sqlite.ts";

function make(
	opts: {
		occupied?: number[];
		store?: AllocatorStore;
		range?: { min: number; max: number };
	} = {},
) {
	const store = opts.store ?? new SqliteStateStore(":memory:");
	const alloc = new Allocator({
		store,
		clusterId: 1,
		range: opts.range ?? { min: 500, max: 598 },
		templateVmid: 599,
		occupied: async () => new Set(opts.occupied ?? []),
	});
	return { store, alloc };
}

describe("macFor", () => {
	it("encodes 02:<cluster>:<vmid big-endian>", () => {
		expect(macFor(1, 500)).toBe("02:01:00:00:01:F4");
		expect(macFor(255, 0x01020304)).toBe("02:FF:01:02:03:04");
	});
});

describe("Allocator", () => {
	it("hands out the lowest free VMID with its MAC and reserves it", async () => {
		const { alloc, store } = make();
		expect(await alloc.allocate()).toEqual({
			vmid: 500,
			mac: "02:01:00:00:01:F4",
		});
		expect(store.get(1, 500)?.state).toBe("reserved");
		expect((await alloc.allocate()).vmid).toBe(501);
	});

	it("skips VMIDs that exist in Proxmox or still have LVs", async () => {
		const { alloc } = make({ occupied: [500, 501] });
		expect((await alloc.allocate()).vmid).toBe(502);
	});

	it("takes the next VMID when the insert loses a race", async () => {
		const real = new SqliteStateStore(":memory:");
		let first = true;
		const racy: AllocatorStore = {
			...bind(real),
			tryInsert(l: VmidLease) {
				if (first) {
					first = false;
					return false;
				}
				return real.tryInsert(l);
			},
		};
		const { alloc } = make({ store: racy });
		expect((await alloc.allocate()).vmid).toBe(501);
	});

	it("fails when the range is exhausted", async () => {
		const { alloc } = make({ range: { min: 500, max: 501 } });
		await alloc.allocate();
		await alloc.allocate();
		await expect(alloc.allocate()).rejects.toThrow(/vmid_exhausted/);
	});

	it("never hands out the template VMID", async () => {
		const { alloc } = make({ range: { min: 598, max: 599 } });
		expect((await alloc.allocate()).vmid).toBe(598);
		await expect(alloc.allocate()).rejects.toThrow(/vmid_exhausted/);
	});

	it("keeps releasing rows occupied and frees the VMID only on release", async () => {
		const { alloc, store } = make();
		await alloc.allocate();
		alloc.markActive(500);
		expect(store.get(1, 500)?.state).toBe("active");
		alloc.markReleasing(500);
		expect((await alloc.allocate()).vmid).toBe(501);
		alloc.release(500);
		expect(store.get(1, 500)).toBeUndefined();
		expect((await alloc.allocate()).vmid).toBe(500);
	});

	it("records the template row without handing it out", async () => {
		const { alloc, store } = make();
		alloc.ensureTemplate();
		alloc.ensureTemplate();
		expect(store.get(1, 599)).toMatchObject({
			purpose: "template",
			state: "active",
			mac: "02:01:00:00:02:57",
		});
		expect(store.list(1).filter((l) => l.purpose === "machine")).toHaveLength(
			0,
		);
	});
});

describe("SqliteStateStore", () => {
	it("enforces unique VMID and MAC per cluster", () => {
		const s = new SqliteStateStore(":memory:");
		const row = (vmid: number, mac: string): VmidLease => ({
			cluster: 1,
			vmid,
			mac,
			state: "reserved",
			purpose: "machine",
			createdAt: 1,
			updatedAt: 1,
		});
		expect(s.tryInsert(row(500, "A"))).toBe(true);
		expect(s.tryInsert(row(500, "B"))).toBe(false);
		expect(s.tryInsert(row(501, "A"))).toBe(false);
	});

	it("stores snapshots", () => {
		const s = new SqliteStateStore(":memory:");
		const snap = {
			kind: "snapshot" as const,
			id: "abc",
			node: "pve",
			sourceVmid: 500,
			disks: [],
			hardware: { cores: "2" },
			createdAt: 5,
		};
		s.putSnapshot(snap);
		expect(s.getSnapshot("abc")).toEqual(snap);
		expect(s.listSnapshots()).toHaveLength(1);
		s.removeSnapshot("abc");
		expect(s.getSnapshot("abc")).toBeUndefined();
	});
});

function bind(s: SqliteStateStore): AllocatorStore {
	return {
		tryInsert: (l) => s.tryInsert(l),
		get: (c, v) => s.get(c, v),
		list: (c) => s.list(c),
		setState: (c, v, st) => s.setState(c, v, st),
		remove: (c, v) => s.remove(c, v),
	};
}
