import { randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { FakeNode, FakePve } from "@sbx/pve/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PveInfraRegistry } from "../src/adapters/pve-infra.ts";
import { withNodeStartLock } from "../src/adapters/start-lock.ts";
import type { NodeInfra } from "../src/ports.ts";
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

/** Polls cond until it holds (condition-based, no fixed ordering sleeps). */
async function waitFor(
	cond: () => Promise<boolean>,
	what: string,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await cond())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** Advisory lock rows of this database: sessions holding or waiting. */
async function advisoryLocks(): Promise<{ granted: number; waiting: number }> {
	const r = await db.pool.query<{ granted: number; waiting: number }>(
		`SELECT count(*) FILTER (WHERE granted)::int AS granted,
		        count(*) FILTER (WHERE NOT granted)::int AS waiting
		 FROM pg_locks
		 WHERE locktype = 'advisory'
		   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
	);
	return r.rows[0] ?? { granted: 0, waiting: 0 };
}

/** Lets queued promise jobs and I/O callbacks run a few times. */
async function settle(turns = 20): Promise<void> {
	for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

describe("withNodeStartLock", () => {
	it("serializes callers on one node", async () => {
		const node = randomUUID();
		const log: string[] = [];
		const aIn = deferred();
		const gate = deferred();
		const a = withNodeStartLock(db.pool, node, async () => {
			log.push("a:in");
			aIn.resolve();
			await gate.promise;
			log.push("a:out");
		});
		await aIn.promise;
		const b = withNodeStartLock(db.pool, node, async () => {
			log.push("b:in");
		});
		await waitFor(
			async () => (await advisoryLocks()).waiting === 1,
			"b waits for the advisory lock",
		);
		expect(log).toEqual(["a:in"]);
		gate.resolve();
		await Promise.all([a, b]);
		expect(log).toEqual(["a:in", "a:out", "b:in"]);
	});

	it("callers on different nodes overlap", async () => {
		const aIn = deferred();
		const gate = deferred();
		const a = withNodeStartLock(db.pool, randomUUID(), async () => {
			aIn.resolve();
			await gate.promise;
		});
		await aIn.promise;
		// Completes while node A's lock is held.
		expect(
			await withNodeStartLock(db.pool, randomUUID(), async () => "b"),
		).toBe("b");
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
		expect(await advisoryLocks()).toEqual({ granted: 0, waiting: 0 });
	});
});

/** FakePve whose start requests wait for a per-VM gate; records begin/end events. */
class GatedPve extends FakePve {
	readonly gates = new Map<number, Deferred>();
	readonly beganAt = new Map<number, Deferred>();
	readonly events: string[] = [];

	override async post<T>(path: string, params?: Record<string, unknown>) {
		const m = /\/qemu\/(\d+)\/status\/start$/.exec(path);
		if (!m) return super.post<T>(path, params);
		const vmid = Number(m[1]);
		this.events.push(`begin:${vmid}`);
		this.beganAt.get(vmid)?.resolve();
		await this.gates.get(vmid)?.promise;
		const r = await super.post<T>(path, params);
		this.events.push(`end:${vmid}`);
		return r;
	}

	addStopped(vmid: number): void {
		this.gates.set(vmid, deferred());
		this.beganAt.set(vmid, deferred());
		this.vms.set(vmid, {
			config: { tags: "sbx" },
			status: "stopped",
			firewall: { rules: [], ipsets: {} },
		});
	}

	began(vmid: number): Promise<void> {
		return this.beganAt.get(vmid)?.promise ?? Promise.resolve();
	}

	release(vmid: number): void {
		this.gates.get(vmid)?.resolve();
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

/** A registry = one worker process; each has its own in-process start gate. */
function registryFor(apis: Map<string, GatedPve>): PveInfraRegistry {
	return new PveInfraRegistry(db.pool, {
		secretsDir: "/nonexistent",
		clients: (t) => ({
			api: apis.get(t.nodeId) as GatedPve,
			node: new FakeNode(),
		}),
	});
}

describe("PveNodeInfra.start serialization", () => {
	it("N starts on one node in one process: one advisory lock session, run in order", async () => {
		const a = await gatedNode();
		const infra = await registryFor(new Map([[a.topo.nodeId, a.api]])).forNode(
			a.topo.nodeId,
		);
		const vmids = [530, 531, 532, 533, 534];
		for (const v of vmids) a.api.addStopped(v);
		const starts = vmids.map((v) => infra.start(v));
		await a.api.began(530);
		await settle();
		// The other four wait in process, not on Postgres.
		expect(await advisoryLocks()).toEqual({ granted: 1, waiting: 0 });
		expect(a.api.events).toEqual(["begin:530"]);
		for (const v of vmids) {
			await a.api.began(v);
			expect(await advisoryLocks()).toEqual({ granted: 1, waiting: 0 });
			a.api.release(v);
		}
		await Promise.all(starts);
		expect(a.api.events).toEqual(
			vmids.flatMap((v) => [`begin:${v}`, `end:${v}`]),
		);
		expect(await advisoryLocks()).toEqual({ granted: 0, waiting: 0 });
	});

	it("two processes on one node: the advisory lock serializes, one waiting client each", async () => {
		const a = await gatedNode();
		const apis = new Map([[a.topo.nodeId, a.api]]);
		const p1: NodeInfra = await registryFor(apis).forNode(a.topo.nodeId);
		const p2: NodeInfra = await registryFor(apis).forNode(a.topo.nodeId);
		for (const v of [540, 541, 542, 543]) a.api.addStopped(v);
		const s = [p1.start(540), p2.start(541), p1.start(542), p2.start(543)];
		// Either process may win the lock first.
		await Promise.race([a.api.began(540), a.api.began(541)]);
		await waitFor(
			async () => (await advisoryLocks()).waiting === 1,
			"the other process waits for the advisory lock",
		);
		await settle();
		expect(await advisoryLocks()).toEqual({ granted: 1, waiting: 1 });
		expect(a.api.events).toHaveLength(1);
		expect(["begin:540", "begin:541"]).toContain(a.api.events[0]);
		for (const v of [540, 541, 542, 543]) a.api.gates.get(v)?.resolve();
		await Promise.all(s);
		// Never two starts in flight at once.
		const ev = a.api.events;
		for (let i = 0; i < ev.length; i += 2) {
			expect(ev[i]?.startsWith("begin:")).toBe(true);
			expect(ev[i + 1]).toBe(`end:${ev[i]?.slice(6)}`);
		}
		expect(ev).toHaveLength(8);
	});

	it("starts on another node overlap a held start", async () => {
		const a = await gatedNode();
		const b = await gatedNode();
		const registry = registryFor(
			new Map([
				[a.topo.nodeId, a.api],
				[b.topo.nodeId, b.api],
			]),
		);
		const infraA = await registry.forNode(a.topo.nodeId);
		const infraB = await registry.forNode(b.topo.nodeId);
		a.api.addStopped(510);
		b.api.addStopped(520);
		const held = infraA.start(510);
		await a.api.began(510);
		b.api.release(520);
		await infraB.start(520);
		expect(b.api.events).toEqual(["begin:520", "end:520"]);
		expect(a.api.events).toEqual(["begin:510"]);
		a.api.release(510);
		await held;
		expect(await infraA.status(510)).toBe("running");
	});

	it("a failed start does not block the next one", async () => {
		const a = await gatedNode();
		const infra = await registryFor(new Map([[a.topo.nodeId, a.api]])).forNode(
			a.topo.nodeId,
		);
		a.api.addStopped(550);
		a.api.release(550);
		await expect(infra.start(999)).rejects.toThrow();
		await infra.start(550);
		expect(await infra.status(550)).toBe("running");
	});

	it("clones are not serialized by the start lock", async () => {
		const a = await gatedNode();
		const infra = await registryFor(new Map([[a.topo.nodeId, a.api]])).forNode(
			a.topo.nodeId,
		);
		a.api.addStopped(512);
		const held = infra.start(512);
		await a.api.began(512);
		const m = randomUUID();
		const vm = await infra.create({
			machineId: m,
			templateVmid: 599,
			size: { vcpu: 1, memoryMb: 1024 },
			smbios: { uuid: m, serial: `sbx1:${m}:x` },
		});
		expect(vm.vmid).toBeGreaterThanOrEqual(500);
		a.api.release(512);
		await held;
	});
});
