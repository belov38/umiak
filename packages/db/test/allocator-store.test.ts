import { randomUUID } from "node:crypto";
import { Allocator, macFor } from "@umiak/pve";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, PgAllocatorStore } from "../src/index.ts";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "../src/testing/index.ts";

const CLUSTER = 1;
const RANGE = { min: 500, max: 598 };
const TEMPLATE_VMID = 599;

describe.skipIf(skipPg())("PgAllocatorStore", () => {
	let t: TestDatabase;
	let pool2: pg.Pool;

	async function newProvider(name: string, mac: number): Promise<string> {
		const id = randomUUID();
		await t.pool.query(
			`INSERT INTO runtime.providers (id, kind, name, cluster_mac_id, vmid_min, vmid_max, api_url, secret_ref)
			 VALUES ($1, 'proxmox', $2, $3, 500, 598, 'https://pve:8006', $2)`,
			[id, name, mac],
		);
		return id;
	}

	function allocatorOf(
		pool: pg.Pool,
		provider: string,
		range = RANGE,
	): Allocator {
		return new Allocator({
			store: new PgAllocatorStore(pool, provider),
			clusterId: CLUSTER,
			range,
			templateVmid: TEMPLATE_VMID,
			occupied: async () => new Set(),
		});
	}

	beforeAll(async () => {
		t = await createTestDatabase({ max: 20 });
		pool2 = createPool(t.url, 20);
	});
	afterAll(async () => {
		await pool2?.end();
		await t?.drop();
	});

	it("gives different VMIDs to two concurrent owners", async () => {
		const p = await newProvider("two-owners", 10);
		const a = allocatorOf(t.pool, p);
		const [x, y] = await Promise.all([
			a.allocate(randomUUID()),
			a.allocate(randomUUID()),
		]);
		expect(x.vmid).not.toBe(y.vmid);
		expect(x.mac).toBe(macFor(CLUSTER, x.vmid));
	});

	it("returns the same VMID for the same owner", async () => {
		const p = await newProvider("same-owner", 11);
		const a = allocatorOf(t.pool, p);
		const owner = randomUUID();
		const first = await a.allocate(owner);
		const second = await a.allocate(owner);
		expect(second).toEqual({ ...first, reused: true });
		expect(await a.list()).toHaveLength(1);
		expect((await a.get(first.vmid))?.ownerId).toBe(owner);
	});

	it("allocates a fresh VMID for an owner whose lease is releasing", async () => {
		const p = await newProvider("releasing-owner", 12);
		const a = allocatorOf(t.pool, p);
		const owner = randomUUID();
		const first = await a.allocate(owner);
		await a.markReleasing(first.vmid);
		const store = new PgAllocatorStore(t.pool, p);
		expect(await store.findByOwner(CLUSTER, owner)).toBeUndefined();
		// The unique owner index ignores releasing rows, so the owner can lease a
		// new VMID while the old one is still being torn down.
		const second = await a.allocate(owner);
		expect(second.vmid).not.toBe(first.vmid);
		expect((await a.get(first.vmid))?.state).toBe("releasing");
		expect(await store.findByOwner(CLUSTER, owner)).toMatchObject({
			vmid: second.vmid,
		});
	});

	it("20 parallel allocations from two connection pools have no duplicates", async () => {
		const p = await newProvider("parallel", 13);
		const a1 = allocatorOf(t.pool, p);
		const a2 = allocatorOf(pool2, p);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				(i % 2 === 0 ? a1 : a2).allocate(randomUUID()),
			),
		);
		const vmids = results.map((r) => r.vmid);
		const macs = results.map((r) => r.mac);
		expect(new Set(vmids).size).toBe(20);
		expect(new Set(macs).size).toBe(20);
		for (const v of vmids) {
			expect(v).toBeGreaterThanOrEqual(RANGE.min);
			expect(v).toBeLessThanOrEqual(RANGE.max);
		}
	});

	it("release removes the row and frees the VMID", async () => {
		const p = await newProvider("release", 14);
		const a = allocatorOf(t.pool, p);
		const { vmid } = await a.allocate(randomUUID());
		await a.markActive(vmid);
		expect((await a.get(vmid))?.state).toBe("active");
		await a.release(vmid);
		expect(await a.get(vmid)).toBeUndefined();
		const rows = await t.pool.query(
			"SELECT 1 FROM runtime.vmid_leases WHERE provider_id = $1",
			[p],
		);
		expect(rows.rowCount).toBe(0);
		expect((await a.allocate(randomUUID())).vmid).toBe(vmid);
	});

	it("releaseOwned removes only the releasing row of the given owner (null: a reservation)", async () => {
		const p = await newProvider("release-owned", 19);
		const a = allocatorOf(t.pool, p);
		const owner = randomUUID();
		const { vmid } = await a.allocate(owner);
		await a.markActive(vmid);
		// Not releasing yet: nothing is freed.
		expect(await a.releaseOwned(vmid, owner)).toBe(false);
		await a.markReleasing(vmid);
		// Another owner, or the ownerless reservation, does not match.
		expect(await a.releaseOwned(vmid, randomUUID())).toBe(false);
		expect(await a.releaseOwned(vmid, null)).toBe(false);
		expect((await a.get(vmid))?.ownerId).toBe(owner);
		expect(await a.releaseOwned(vmid, owner)).toBe(true);
		expect(await a.get(vmid)).toBeUndefined();

		expect(await a.reserveForDelete(vmid)).toBe(true);
		expect(await a.releaseOwned(vmid, owner)).toBe(false);
		expect(await a.releaseOwned(vmid, null)).toBe(true);
		expect(await a.get(vmid)).toBeUndefined();
	});

	it("never hands out the template lease", async () => {
		const p = await newProvider("template", 15);
		const range = { min: 597, max: 599 };
		const a = allocatorOf(t.pool, p, range);
		await a.ensureTemplate();
		await a.ensureTemplate();
		const tpl = await a.get(TEMPLATE_VMID);
		expect(tpl?.purpose).toBe("template");
		expect(tpl?.state).toBe("active");
		const got = [await a.allocate(), await a.allocate()].map((r) => r.vmid);
		expect(got.sort()).toEqual([597, 598]);
		await expect(a.allocate()).rejects.toMatchObject({
			code: "vmid_exhausted",
		});
	});

	it("tryInsert returns false on vmid, mac and machine conflicts", async () => {
		const p = await newProvider("conflicts", 16);
		const store = new PgAllocatorStore(t.pool, p);
		const owner = randomUUID();
		const base = {
			cluster: CLUSTER,
			vmid: 510,
			mac: macFor(CLUSTER, 510),
			state: "reserved" as const,
			purpose: "machine" as const,
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
			ownerId: owner,
		};
		expect(await store.tryInsert(base)).toBe(true);
		// same (provider, vmid)
		expect(await store.tryInsert({ ...base, ownerId: randomUUID() })).toBe(
			false,
		);
		// same mac, other vmid
		expect(
			await store.tryInsert({ ...base, vmid: 511, ownerId: randomUUID() }),
		).toBe(false);
		// same owner, other vmid and mac
		expect(
			await store.tryInsert({
				...base,
				vmid: 512,
				mac: macFor(CLUSTER, 512),
			}),
		).toBe(false);
		expect(await store.list(CLUSTER)).toHaveLength(1);
	});

	it("round-trips timestamps as epoch ms and scopes rows to the provider", async () => {
		const p = await newProvider("roundtrip", 17);
		const other = await newProvider("roundtrip-other", 18);
		const store = new PgAllocatorStore(t.pool, p);
		const otherStore = new PgAllocatorStore(t.pool, other);
		const lease = {
			cluster: CLUSTER,
			vmid: 520,
			mac: macFor(CLUSTER, 520),
			state: "reserved" as const,
			purpose: "machine" as const,
			createdAt: 1_700_000_000_123,
			updatedAt: 1_700_000_000_456,
			ownerId: randomUUID(),
		};
		await store.tryInsert(lease);
		expect(await store.get(CLUSTER, 520)).toEqual(lease);
		expect(await otherStore.get(CLUSTER, 520)).toBeUndefined();
		expect(await otherStore.list(CLUSTER)).toEqual([]);
		await otherStore.remove(CLUSTER, 520);
		expect(await store.get(CLUSTER, 520)).toBeDefined();
		await store.setState(CLUSTER, 520, "active");
		const after = await store.get(CLUSTER, 520);
		expect(after?.state).toBe("active");
		expect(after?.createdAt).toBe(lease.createdAt);
		expect(after?.updatedAt).toBeGreaterThan(lease.updatedAt);
	});
});
