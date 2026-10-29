import { randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { FakeNode, FakePve } from "@sbx/pve/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PveInfraRegistry } from "../src/adapters/pve-infra.ts";
import { withNodeStartLock } from "../src/adapters/start-lock.ts";
import { createTopology } from "./fakes/world.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("withNodeStartLock", () => {
	it("serializes callers on one node", async () => {
		const node = randomUUID();
		const log: string[] = [];
		const gate = deferred();
		const a = withNodeStartLock(db.pool, node, async () => {
			log.push("a:in");
			await gate.promise;
			log.push("a:out");
		});
		await tick();
		const b = withNodeStartLock(db.pool, node, async () => {
			log.push("b:in");
		});
		await tick(150);
		expect(log).toEqual(["a:in"]);
		gate.resolve();
		await Promise.all([a, b]);
		expect(log).toEqual(["a:in", "a:out", "b:in"]);
	});

	it("callers on different nodes overlap", async () => {
		const gate = deferred();
		const log: string[] = [];
		const a = withNodeStartLock(db.pool, randomUUID(), async () => {
			log.push("a:in");
			await gate.promise;
		});
		await tick();
		await withNodeStartLock(db.pool, randomUUID(), async () => {
			log.push("b:in");
		});
		expect(log).toEqual(["a:in", "b:in"]);
		gate.resolve();
		await a;
	});

	it("unlocks when the function throws", async () => {
		const node = randomUUID();
		await expect(
			withNodeStartLock(db.pool, node, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		const r = await withNodeStartLock(db.pool, node, async () => "ok");
		expect(r).toBe("ok");
		const held = await db.pool.query(
			`SELECT count(*)::int AS n FROM pg_locks
			 WHERE locktype = 'advisory' AND granted
			   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
		);
		expect(held.rows[0]?.n).toBe(0);
	});
});

/** FakePve whose start requests wait for a per-VM gate. */
class GatedPve extends FakePve {
	readonly gates = new Map<number, Deferred>();
	readonly begun: number[] = [];
	readonly finished: number[] = [];

	override async post<T>(path: string, params?: Record<string, unknown>) {
		const m = /\/qemu\/(\d+)\/status\/start$/.exec(path);
		if (!m) return super.post<T>(path, params);
		const vmid = Number(m[1]);
		this.begun.push(vmid);
		await this.gates.get(vmid)?.promise;
		const r = await super.post<T>(path, params);
		this.finished.push(vmid);
		return r;
	}

	addStopped(vmid: number): void {
		this.gates.set(vmid, deferred());
		this.vms.set(vmid, {
			config: { tags: "sbx" },
			status: "stopped",
			firewall: { rules: [], ipsets: {} },
		});
	}
}

async function gatedNode() {
	const topo = await createTopology(db.pool);
	const r = await db.pool.query<{ name: string }>(
		"SELECT name FROM runtime.nodes WHERE id = $1",
		[topo.nodeId],
	);
	const api = new GatedPve([], { node: r.rows[0]?.name ?? "" });
	return { topo, api };
}

describe("PveNodeInfra.start serialization", () => {
	it("a second start on the same node begins only after the first finished; other nodes overlap", async () => {
		const a = await gatedNode();
		const b = await gatedNode();
		const apis = new Map([
			[a.topo.nodeId, a.api],
			[b.topo.nodeId, b.api],
		]);
		const registry = new PveInfraRegistry(db.pool, {
			secretsDir: "/nonexistent",
			clients: (t) => ({
				api: apis.get(t.nodeId) as GatedPve,
				node: new FakeNode(),
			}),
		});
		const infraA = await registry.forNode(a.topo.nodeId);
		const infraB = await registry.forNode(b.topo.nodeId);
		a.api.addStopped(510);
		a.api.addStopped(511);
		b.api.addStopped(520);

		const s1 = infraA.start(510);
		await tick();
		const s2 = infraA.start(511);
		await tick(150);
		expect(a.api.begun).toEqual([510]);

		// Another node is not blocked by node A's held start.
		const s3 = infraB.start(520);
		await tick();
		expect(b.api.begun).toEqual([520]);
		b.api.gates.get(520)?.resolve();
		await s3;

		a.api.gates.get(510)?.resolve();
		await s1;
		await tick(150);
		expect(a.api.begun).toEqual([510, 511]);
		a.api.gates.get(511)?.resolve();
		await s2;
		expect(a.api.finished).toEqual([510, 511]);
		expect(await infraA.status(511)).toBe("running");
	});

	it("clones are not serialized by the start lock", async () => {
		const a = await gatedNode();
		const registry = new PveInfraRegistry(db.pool, {
			secretsDir: "/nonexistent",
			clients: () => ({ api: a.api, node: new FakeNode() }),
		});
		const infra = await registry.forNode(a.topo.nodeId);
		a.api.addStopped(512);
		const held = infra.start(512);
		await tick();
		const m = randomUUID();
		const vm = await infra.create({
			machineId: m,
			templateVmid: 599,
			size: { vcpu: 1, memoryMb: 1024 },
			smbios: { uuid: m, serial: `sbx1:${m}:x` },
		});
		expect(vm.vmid).toBeGreaterThanOrEqual(500);
		a.api.gates.get(512)?.resolve();
		await held;
	});
});
