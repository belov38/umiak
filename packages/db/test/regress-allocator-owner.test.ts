// Regression (S6 acceptance): allocate(owner) is idempotent by owner (S6
// §5.3), but two concurrent calls of the same owner both missed findByOwner;
// the loser's tryInsert then conflicted on vmid_leases_machine_uq for every
// VMID and it reported vmid_exhausted. Now the loser returns the winner's
// lease with `reused: true`.
import { randomUUID } from "node:crypto";
import { Allocator } from "@umiak/pve";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgAllocatorStore } from "../src/index.ts";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "../src/testing/index.ts";

describe.skipIf(skipPg())("allocator same-owner race", () => {
	let t: TestDatabase;
	beforeAll(async () => {
		t = await createTestDatabase({ max: 20 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	it("two concurrent allocate() of one owner return the same lease", async () => {
		const p = randomUUID();
		await t.pool.query(
			`INSERT INTO runtime.providers (id, kind, name, cluster_mac_id, vmid_min, vmid_max, api_url, secret_ref)
			 VALUES ($1, 'proxmox', $2, 77, 500, 598, 'https://pve:8006', $2)`,
			[p, `acc-${p.slice(0, 8)}`],
		);
		let arrived = 0;
		let open!: () => void;
		const barrier = new Promise<void>((r) => {
			open = r;
		});
		const a = new Allocator({
			store: new PgAllocatorStore(t.pool, p),
			clusterId: 1,
			range: { min: 500, max: 510 },
			templateVmid: 599,
			// Both callers pass findByOwner before either inserts (two worker
			// executors of one machine, e.g. a stale one before fencing).
			occupied: async () => {
				arrived += 1;
				if (arrived === 2) open();
				await barrier;
				return new Set<number>();
			},
		});
		const owner = randomUUID();
		const res = await Promise.allSettled([
			a.allocate(owner),
			a.allocate(owner),
		]);
		const errs = res
			.filter((r) => r.status === "rejected")
			.map((r) => String((r as PromiseRejectedResult).reason));
		expect(errs).toEqual([]);
		const ok = res.map(
			(r) =>
				(r as PromiseFulfilledResult<{ vmid: number; reused: boolean }>).value,
		);
		expect(ok[0]?.vmid).toBe(ok[1]?.vmid);
		expect(ok.map((x) => x.reused).sort()).toEqual([false, true]);
	});
});
