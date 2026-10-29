import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
		expect((await store.get(1, 500))?.state).toBe("reserved");
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
		await alloc.markActive(500);
		expect((await store.get(1, 500))?.state).toBe("active");
		await alloc.markReleasing(500);
		expect((await alloc.allocate()).vmid).toBe(501);
		await alloc.release(500);
		expect(await store.get(1, 500)).toBeUndefined();
		expect((await alloc.allocate()).vmid).toBe(500);
	});

	it("records the template row without handing it out", async () => {
		const { alloc, store } = make();
		await alloc.ensureTemplate();
		await alloc.ensureTemplate();
		expect(await store.get(1, 599)).toMatchObject({
			purpose: "template",
			state: "active",
			mac: "02:01:00:00:02:57",
		});
		expect(
			(await store.list(1)).filter((l) => l.purpose === "machine"),
		).toHaveLength(0);
	});

	it("returns the same VMID for the same owner while the lease is not releasing", async () => {
		const { alloc, store } = make();
		const a = await alloc.allocate("m1");
		const b = await alloc.allocate("m1");
		expect(b).toEqual(a);
		expect((await store.get(1, a.vmid))?.ownerId).toBe("m1");
		expect((await alloc.allocate("m2")).vmid).toBe(a.vmid + 1);
		await alloc.markActive(a.vmid);
		expect((await alloc.allocate("m1")).vmid).toBe(a.vmid);
		await alloc.markReleasing(a.vmid);
		const c = await alloc.allocate("m1");
		expect(c.vmid).not.toBe(a.vmid);
		expect((await store.get(1, c.vmid))?.ownerId).toBe("m1");
	});

	it("does not record an owner when none is given", async () => {
		const { alloc, store } = make();
		await alloc.allocate();
		expect((await store.get(1, 500))?.ownerId).toBeUndefined();
	});

	it("works with a store whose methods are asynchronous", async () => {
		const rows = new Map<number, VmidLease>();
		const tick = () => Promise.resolve();
		const asyncStore: AllocatorStore = {
			async tryInsert(l) {
				await tick();
				if (rows.has(l.vmid)) return false;
				rows.set(l.vmid, { ...l });
				return true;
			},
			async get(_c, vmid) {
				await tick();
				return rows.get(vmid);
			},
			async list() {
				await tick();
				return [...rows.values()];
			},
			async setState(_c, vmid, state) {
				await tick();
				const r = rows.get(vmid);
				if (r) r.state = state;
			},
			async remove(_c, vmid) {
				await tick();
				rows.delete(vmid);
			},
			async findByOwner(_c, ownerId) {
				await tick();
				return [...rows.values()].find((r) => r.ownerId === ownerId);
			},
		};
		const { alloc } = make({ store: asyncStore });
		await alloc.ensureTemplate();
		const a = await alloc.allocate("o1");
		expect(await alloc.allocate("o1")).toEqual(a);
		await alloc.markActive(a.vmid);
		expect((await alloc.get(a.vmid))?.state).toBe("active");
		expect(await alloc.list()).toHaveLength(2);
		await alloc.markReleasing(a.vmid);
		await alloc.release(a.vmid);
		expect(await alloc.get(a.vmid)).toBeUndefined();
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

	it("stores the owner and finds a lease by owner", () => {
		const s = new SqliteStateStore(":memory:");
		const row = (vmid: number, ownerId?: string): VmidLease => ({
			cluster: 1,
			vmid,
			mac: `M${vmid}`,
			state: "reserved",
			purpose: "machine",
			createdAt: 1,
			updatedAt: 1,
			...(ownerId ? { ownerId } : {}),
		});
		s.tryInsert(row(500, "m1"));
		s.tryInsert(row(501));
		expect(s.get(1, 500)?.ownerId).toBe("m1");
		expect(s.get(1, 501)?.ownerId).toBeUndefined();
		expect(s.findByOwner(1, "m1")?.vmid).toBe(500);
		expect(s.findByOwner(1, "nope")).toBeUndefined();
		expect(s.findByOwner(2, "m1")).toBeUndefined();
	});

	it("adds owner_id to a database created before the column existed", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-sqlite-"));
		try {
			const path = join(dir, "state.db");
			const old = new DatabaseSync(path);
			old.exec(`
				CREATE TABLE vmid_lease (
					cluster INTEGER NOT NULL,
					vmid INTEGER NOT NULL,
					mac TEXT NOT NULL,
					state TEXT NOT NULL CHECK (state IN ('reserved', 'active', 'releasing')),
					purpose TEXT NOT NULL CHECK (purpose IN ('machine', 'template')),
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					PRIMARY KEY (cluster, vmid),
					UNIQUE (cluster, mac)
				);
				INSERT INTO vmid_lease VALUES (1, 500, 'A', 'active', 'machine', 1, 1);
			`);
			old.close();
			const s = new SqliteStateStore(path);
			expect(s.get(1, 500)?.ownerId).toBeUndefined();
			s.tryInsert({
				cluster: 1,
				vmid: 501,
				mac: "B",
				state: "reserved",
				purpose: "machine",
				createdAt: 1,
				updatedAt: 1,
				ownerId: "m9",
			});
			expect(s.findByOwner(1, "m9")?.vmid).toBe(501);
			s.close();
			new SqliteStateStore(path).close(); // reopening must not fail on the existing column
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
		findByOwner: (c, o) => s.findByOwner(c, o),
	};
}
