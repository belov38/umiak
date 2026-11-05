import { randomUUID } from "node:crypto";
import { withTx } from "@umiak/db";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { place } from "../src/index.ts";
import {
	createTopology,
	insertMachine,
	insertProvider,
} from "./helpers/topology.ts";

describe.skipIf(skipPg())("place (S6 §8.4)", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase();
	});
	afterAll(async () => {
		await t?.drop();
	});

	// Each test uses its own template slug: place() looks at every node.
	const slug = () => `tpl-${randomUUID().slice(0, 8)}`;

	it("returns eligible nodes ordered by free RAM, with build and storage", async () => {
		const templateSlug = slug();
		const providerId = await insertProvider(t.pool);
		const busy = await createTopology(t.pool, {
			providerId,
			node: { ramCapMb: 8192 },
			build: { templateSlug },
			storage: { usage: { dataPercent: 50, metadataPercent: 20 } },
		});
		await insertMachine(t.pool, busy, { state: "running", memoryMb: 4096 });
		const idle = await createTopology(t.pool, {
			providerId,
			node: { ramCapMb: 8192 },
			build: { templateSlug },
		});
		const res = await withTx(t.pool, (tx) =>
			place(tx, { templateSlug, needMb: 2048 }),
		);
		expect(res).toEqual([
			{
				nodeId: idle.nodeId,
				providerId,
				storageId: idle.storageId,
				templateBuildId: idle.templateBuildId,
				freeMb: 8192,
			},
			{
				nodeId: busy.nodeId,
				providerId,
				storageId: busy.storageId,
				templateBuildId: busy.templateBuildId,
				freeMb: 4096,
			},
		]);
	});

	it("skips inactive providers and nodes, missing or inactive builds, full storage and nodes without RAM", async () => {
		const templateSlug = slug();
		const ok = await createTopology(t.pool, { build: { templateSlug } });
		await createTopology(t.pool, {
			provider: { state: "draining" },
			build: { templateSlug },
		});
		await createTopology(t.pool, {
			provider: { state: "disabled" },
			build: { templateSlug },
		});
		await createTopology(t.pool, {
			node: { state: "cordoned" },
			build: { templateSlug },
		});
		await createTopology(t.pool, {
			node: { state: "down" },
			build: { templateSlug },
		});
		await createTopology(t.pool, {
			build: { templateSlug, status: "deprecated" },
		});
		await createTopology(t.pool, {
			build: { templateSlug, status: "building" },
		});
		await createTopology(t.pool, { build: { templateSlug: slug() } });
		await createTopology(t.pool, {
			build: { templateSlug },
			storage: { usage: { dataPercent: 80, metadataPercent: 10 } },
		});
		await createTopology(t.pool, {
			build: { templateSlug },
			storage: { usage: { dataPercent: 10, metadataPercent: 70 } },
		});
		const tight = await createTopology(t.pool, {
			node: { ramCapMb: 4096 },
			build: { templateSlug },
		});
		await insertMachine(t.pool, tight, { state: "running", memoryMb: 3072 });

		const res = await withTx(t.pool, (tx) =>
			place(tx, { templateSlug, needMb: 2048 }),
		);
		expect(res.map((c) => c.nodeId)).toEqual([ok.nodeId]);
	});

	it("does not reclaim quarantined warm machine RAM", async () => {
		const templateSlug = slug();
		const topo = await createTopology(t.pool, {
			node: { ramCapMb: 4096 },
			build: { templateSlug },
		});
		await insertMachine(t.pool, topo, { state: "running", memoryMb: 2048 });
		await insertMachine(t.pool, topo, {
			state: "warm",
			poolKey: `${templateSlug}/2gb`,
			warmAgoSeconds: 10,
		});
		const need = { templateSlug, needMb: 2048 };
		expect(await withTx(t.pool, (tx) => place(tx, need))).toEqual([]);
	});

	it("returns an empty list for an unknown template", async () => {
		expect(
			await withTx(t.pool, (tx) =>
				place(tx, { templateSlug: slug(), needMb: 1 }),
			),
		).toEqual([]);
	});
});
