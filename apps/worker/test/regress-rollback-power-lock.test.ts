// Regression (S6 acceptance M2): VM start and delete are serialized per node
// (power-lock.ts). S1 create rolls a failed clone back with Machines.delete
// (dhcp.release + DELETE /qemu/<vmid>) inside PveNodeInfra.create; that
// rollback must take the same power lock (MachinesOptions.powerLock).
import { randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { PveApiError } from "@sbx/pve";
import { FakeNode, FakePve } from "@sbx/pve/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PveInfraRegistry } from "../src/adapters/pve-infra.ts";
import { createTopology, leaseVm } from "./fakes/world.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

class HeldStartPve extends FakePve {
	startGate: Promise<void> = Promise.resolve();
	startBegan: () => void = () => {};
	startHeld = false;
	cloneFailed = false;
	/** DELETE /qemu/<vmid> calls seen while a start was in flight. */
	readonly deletesDuringStart: string[] = [];

	override async post<T>(path: string, params?: Record<string, unknown>) {
		if (/\/qemu\/\d+\/status\/start$/.test(path)) {
			this.startHeld = true;
			this.startBegan();
			await this.startGate;
			const r = await super.post<T>(path, params);
			this.startHeld = false;
			return r;
		}
		return super.post<T>(path, params);
	}

	override async put<T>(path: string, params?: Record<string, unknown>) {
		// The disk config PUT of a new clone fails: S1 create rolls back.
		if (/\/qemu\/\d+\/config$/.test(path) && params?.tags === "sbx") {
			this.cloneFailed = true;
			throw new PveApiError(500, "simulated clone failure");
		}
		return super.put<T>(path, params);
	}

	override async delete<T>(path: string, params?: Record<string, unknown>) {
		if (/\/qemu\/\d+$/.test(path) && this.startHeld) {
			this.deletesDuringStart.push(path);
		}
		return super.delete<T>(path, params);
	}
}

describe("regression: power lock covers S1 create rollback", () => {
	it("a rollback delete of a failed create does not run while a start on the node is in flight", async () => {
		const topo = await createTopology(db.pool);
		const r = await db.pool.query<{ name: string }>(
			"SELECT name FROM runtime.nodes WHERE id = $1",
			[topo.nodeId],
		);
		const api = new HeldStartPve([], { node: r.rows[0]?.name ?? "" });
		let release: () => void = () => {};
		api.startGate = new Promise<void>((res) => {
			release = res;
		});
		const began = new Promise<void>((res) => {
			api.startBegan = res;
		});
		api.vms.set(570, {
			config: { tags: "sbx" },
			status: "stopped",
			firewall: { rules: [], ipsets: {} },
		});
		const registry = new PveInfraRegistry(db.pool, {
			secretsDir: "/nonexistent",
			clients: () => ({ api, node: new FakeNode() }),
		});
		const infra = await registry.forNode(topo.nodeId);

		const start = infra.start(
			570,
			await leaseVm(db.pool, topo.providerId, 570),
		);
		await began;
		const m = randomUUID();
		const create = infra
			.create({
				machineId: m,
				templateVmid: 599,
				size: { vcpu: 1, memoryMb: 1024 },
				smbios: { uuid: m, serial: `sbx1:${m}:x` },
			})
			.then(
				() => "created",
				(err: unknown) => err,
			);
		// The clone failed; its rollback now waits for the start's power lock.
		const deadline = Date.now() + 30_000;
		while (!api.cloneFailed) {
			if (Date.now() > deadline) throw new Error("the clone never failed");
			await new Promise((res) => setTimeout(res, 5));
		}
		await new Promise((res) => setTimeout(res, 50));
		expect(api.paths().filter((p) => p.startsWith("DELETE"))).toEqual([]);
		release();
		await start;
		expect(await create).toBeInstanceOf(Error);
		expect(api.deletesDuringStart).toEqual([]);
		// The rollback ran after the start and removed the failed clone.
		expect(api.paths().filter((p) => p.startsWith("DELETE"))).toHaveLength(1);
		expect(api.vms.has(500)).toBe(false);
	});
});
