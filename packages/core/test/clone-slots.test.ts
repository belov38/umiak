import { setTimeout as sleep } from "node:timers/promises";
import { withTx } from "@sbx/db";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	acquireCloneSlot,
	ensureCloneSlots,
	releaseCloneSlot,
} from "../src/index.ts";
import { createTopology } from "./helpers/topology.ts";

describe.skipIf(skipPg())("clone slots (S6 §8.3)", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 20 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	async function slots(
		nodeId: string,
	): Promise<{ slot: number; holder: string | null }[]> {
		const r = await t.pool.query<{ slot: number; holder: string | null }>(
			"SELECT slot, holder FROM runtime.node_clone_slots WHERE node_id = $1 ORDER BY slot",
			[nodeId],
		);
		return r.rows;
	}

	it("5 concurrent acquisitions with clone_concurrency 4 get 4 distinct slots and one null", async () => {
		const topo = await createTopology(t.pool, {
			node: { cloneConcurrency: 4 },
		});
		const got = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				acquireCloneSlot(t.pool, topo.nodeId, `holder-${i}`),
			),
		);
		const taken = got.filter((s): s is number => s !== null);
		expect(taken).toHaveLength(4);
		expect(new Set(taken).size).toBe(4);
		expect(got.filter((s) => s === null)).toHaveLength(1);
		expect((await slots(topo.nodeId)).every((s) => s.holder !== null)).toBe(
			true,
		);
	});

	it("a released slot can be acquired again; a wrong holder cannot release it", async () => {
		const topo = await createTopology(t.pool, {
			node: { cloneConcurrency: 1 },
		});
		const s = await acquireCloneSlot(t.pool, topo.nodeId, "a");
		expect(s).not.toBeNull();
		expect(await acquireCloneSlot(t.pool, topo.nodeId, "b")).toBeNull();
		await releaseCloneSlot(t.pool, topo.nodeId, s as number, "b");
		expect(await acquireCloneSlot(t.pool, topo.nodeId, "b")).toBeNull();
		await releaseCloneSlot(t.pool, topo.nodeId, s as number, "a");
		expect(await acquireCloneSlot(t.pool, topo.nodeId, "b")).toBe(s);
	});

	it("an expired slot is acquired again", async () => {
		const topo = await createTopology(t.pool, {
			node: { cloneConcurrency: 1 },
		});
		const s = await acquireCloneSlot(t.pool, topo.nodeId, "lost", 1);
		expect(s).not.toBeNull();
		await sleep(50);
		expect(await acquireCloneSlot(t.pool, topo.nodeId, "next")).toBe(s);
		expect(await slots(topo.nodeId)).toEqual([{ slot: s, holder: "next" }]);
	});

	it("ensureCloneSlots resizes the semaphore and acquisition respects a lowered limit", async () => {
		const topo = await createTopology(t.pool, {
			node: { cloneConcurrency: 4 },
		});
		await withTx(t.pool, (tx) => ensureCloneSlots(tx, topo.nodeId, 4));
		expect((await slots(topo.nodeId)).map((s) => s.slot)).toEqual([0, 1, 2, 3]);
		const held = await acquireCloneSlot(t.pool, topo.nodeId, "keeper");
		expect(held).toBe(0);

		await t.pool.query(
			"UPDATE runtime.nodes SET clone_concurrency = 2 WHERE id = $1",
			[topo.nodeId],
		);
		await withTx(t.pool, (tx) => ensureCloneSlots(tx, topo.nodeId, 2));
		expect((await slots(topo.nodeId)).map((s) => s.slot)).toEqual([0, 1]);
		expect(await acquireCloneSlot(t.pool, topo.nodeId, "x")).toBe(1);
		expect(await acquireCloneSlot(t.pool, topo.nodeId, "y")).toBeNull();
	});
});
