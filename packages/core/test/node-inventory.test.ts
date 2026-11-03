import { withTx } from "@umiak/db";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	registerSandboxNode,
	sandboxNodeInventory,
} from "../src/node-inventory.ts";
import { retireNode } from "../src/node-maintenance.ts";
import {
	createTopology,
	insertMachine,
	insertProvider,
} from "./helpers/topology.ts";

let db: TestDatabase;
beforeAll(async () => {
	db = await createTestDatabase();
});
afterAll(async () => {
	await db?.drop();
});
it("registers distinct node-local storage and endpoints, and reruns preserve other nodes", async () => {
	const providerId = await insertProvider(db.pool);
	const cfg = {
		providerId,
		name: "pve",
		sshHost: "192.0.2.1",
		storage: "local-lvm",
		mediaStorage: "local",
		ramCapMb: 4096,
	};
	const a = await withTx(db.pool, (tx) => registerSandboxNode(tx, cfg));
	const b = await withTx(db.pool, (tx) =>
		registerSandboxNode(tx, {
			...cfg,
			name: "pve2",
			sshHost: "192.0.2.2",
			mediaStorage: "media",
		}),
	);
	expect(await withTx(db.pool, (tx) => registerSandboxNode(tx, cfg))).toEqual(
		a,
	);
	const nodes = await sandboxNodeInventory(db.pool, providerId);
	expect(nodes).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				nodeId: a.nodeId,
				sshHost: "192.0.2.1",
				storageId: a.storageId,
				mediaStorage: "local",
			}),
			expect.objectContaining({
				nodeId: b.nodeId,
				sshHost: "192.0.2.2",
				storageId: b.storageId,
				mediaStorage: "media",
			}),
		]),
	);
	expect(a.storageId).not.toBe(b.storageId);
	await withTx(db.pool, (tx) => retireNode(tx, b.nodeId));
	expect(
		(await sandboxNodeInventory(db.pool, providerId)).map((n) => n.nodeId),
	).toEqual([a.nodeId]);
	expect(
		await withTx(db.pool, (tx) =>
			registerSandboxNode(tx, { ...cfg, name: "pve2", sshHost: "192.0.2.2" }),
		),
	).toEqual(b);
});
it("refuses lowering RAM below reservations or changing storage under existing local disks", async () => {
	const a = await createTopology(db.pool);
	await insertMachine(db.pool, a, { state: "running", memoryMb: 4096 });
	const n = (await sandboxNodeInventory(db.pool, a.providerId))[0];
	if (!n) throw new Error("missing node");
	const cfg = {
		providerId: a.providerId,
		name: n.name,
		sshHost: n.sshHost,
		storage: n.storage,
		mediaStorage: n.mediaStorage,
		ramCapMb: 2048,
	};
	await expect(
		withTx(db.pool, (tx) => registerSandboxNode(tx, cfg)),
	).rejects.toThrow(/RAM/);
	await expect(
		withTx(db.pool, (tx) =>
			registerSandboxNode(tx, { ...cfg, ramCapMb: 8192, storage: "another" }),
		),
	).rejects.toThrow(/storage/);
});
