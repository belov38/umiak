import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentClient, PgRegistry, RegistryClosedError } from "../src/index.js";
import { createTestDatabase, skipPg, type TestDatabase } from "./helpers/pg.js";

describe.skipIf(skipPg())("PgRegistry", () => {
	let db: TestDatabase;
	let registry: PgRegistry;

	beforeAll(async () => {
		db = await createTestDatabase();
		// A long cache TTL so that only NOTIFY can refresh a cached route.
		registry = await PgRegistry.connect({
			connectionString: db.connectionString,
			cacheTtlMs: 60_000,
			reconnectDelayMs: 50,
		});
	});

	afterAll(async () => {
		await registry?.close();
		await db?.drop();
	});

	async function instance(
		id: string,
		url: string,
		heartbeatAgoSec = 0,
	): Promise<void> {
		await db.pool.query(
			`INSERT INTO tunnel.gateway_instances (id, internal_url, state, started_at, heartbeat_at)
			 VALUES ($1, $2, 'active', now(), now() - make_interval(secs => $3))
			 ON CONFLICT (id) DO UPDATE SET internal_url = $2, heartbeat_at = now() - make_interval(secs => $3)`,
			[id, url, heartbeatAgoSec],
		);
	}

	async function session(
		machineId: string,
		instanceId: string,
		opts: {
			epoch?: bigint;
			state?: "connected" | "disconnected";
			caps?: string[] | null;
		} = {},
	): Promise<void> {
		await db.pool.query(
			`INSERT INTO tunnel.tunnel_sessions (machine_id, instance_id, epoch, conn_id, agent_instance_id,
			   boot_id, vmgenid, agent_version, proto_version, capabilities, state, connected_at)
			 VALUES ($1, $2, $3, 'c', 'a', 'b', 'v', '1.0.0', 'v1', $4, $5, now())
			 ON CONFLICT (machine_id) DO UPDATE SET instance_id = $2, epoch = $3, capabilities = $4, state = $5`,
			[
				machineId,
				instanceId,
				(opts.epoch ?? 1n).toString(),
				opts.caps === undefined ? [] : opts.caps,
				opts.state ?? "connected",
			],
		);
	}

	it("returns the route of a connected session", async () => {
		const m = randomUUID();
		await instance("gw-a", "http://10.0.0.1:8081");
		await session(m, "gw-a", {
			epoch: 9007199254740993n,
			caps: ["process.pty", "files.upload.v1"],
		});
		const route = await registry.lookup(m);
		expect(route).toEqual({
			machineId: m,
			instanceId: "gw-a",
			internalUrl: "http://10.0.0.1:8081",
			epoch: 9007199254740993n,
			capabilities: ["process.pty", "files.upload.v1"],
		});
		// Upper-case ids address the same machine.
		expect((await registry.lookup(m.toUpperCase()))?.instanceId).toBe("gw-a");
	});

	it("does not route to a stale gateway instance", async () => {
		const m = randomUUID();
		await instance("gw-stale", "http://10.0.0.9:8081", 20);
		await session(m, "gw-stale");
		expect(await registry.lookup(m)).toBeUndefined();
	});

	it("does not route to a disconnected session", async () => {
		const m = randomUUID();
		await instance("gw-a", "http://10.0.0.1:8081");
		await session(m, "gw-a", { state: "disconnected" });
		expect(await registry.lookup(m)).toBeUndefined();
	});

	it("serves the cache until a NOTIFY for the machine", async () => {
		const m = randomUUID();
		await instance("gw-c1", "http://10.0.1.1:8081");
		await instance("gw-c2", "http://10.0.1.2:8081");
		// Let the insert's own NOTIFY arrive before the route is cached.
		const notified = registry.waitForChange(m, 2000);
		await session(m, "gw-c1");
		await notified;
		expect((await registry.lookup(m))?.internalUrl).toBe(
			"http://10.0.1.1:8081",
		);
		// No session NOTIFY: the cached route is served without a DB hit.
		await instance("gw-c1", "http://10.0.1.99:8081");
		expect((await registry.lookup(m))?.internalUrl).toBe(
			"http://10.0.1.1:8081",
		);
		// A session change NOTIFYs and the next lookup sees the new instance.
		await session(m, "gw-c2", { epoch: 2n });
		await vi.waitFor(
			async () => {
				expect((await registry.lookup(m))?.instanceId).toBe("gw-c2");
			},
			{ timeout: 1000, interval: 20 },
		);
	});

	it("waitForChange resolves on NOTIFY before the timeout", async () => {
		const m = randomUUID();
		await instance("gw-a", "http://10.0.0.1:8081");
		const start = Date.now();
		const wait = registry.waitForChange(m, 5000);
		await new Promise((r) => setTimeout(r, 50));
		await session(m, "gw-a");
		await wait;
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("waitForChange resolves on timeout without a change", async () => {
		const m = randomUUID();
		const start = Date.now();
		await registry.waitForChange(m, 200);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(190);
		expect(elapsed).toBeLessThan(2000);
	});

	it("waitForChange resolves when the signal aborts", async () => {
		const ac = new AbortController();
		const start = Date.now();
		const wait = registry.waitForChange(randomUUID(), 5000, ac.signal);
		ac.abort();
		await wait;
		expect(Date.now() - start).toBeLessThan(1000);
	});

	it("returns null capabilities while they are unknown", async () => {
		const m = randomUUID();
		await instance("gw-n", "http://10.0.3.1:8081");
		await session(m, "gw-n", { caps: null });
		expect((await registry.lookup(m))?.capabilities).toBeNull();
	});

	it("a closed registry ends routed calls at once without starving timers", async () => {
		const closed = await PgRegistry.connect({
			connectionString: db.connectionString,
		});
		await closed.close();
		await expect(closed.lookup(randomUUID())).rejects.toBeInstanceOf(
			RegistryClosedError,
		);
		const client = new AgentClient({
			registry: closed,
			serviceToken: "t",
			waitForAgentMs: 2000,
		});
		const timerStart = Date.now();
		let firedAfter = -1;
		setTimeout(() => {
			firedAfter = Date.now() - timerStart;
		}, 10);
		const start = Date.now();
		const res = await client
			.fetch(randomUUID(), "?path=x")
			.catch((e: unknown) => e);
		expect(res).toBeInstanceOf(RegistryClosedError);
		expect(Date.now() - start).toBeLessThan(500);
		await new Promise((r) => setTimeout(r, 30));
		expect(firedAfter).toBeGreaterThanOrEqual(0);
		expect(firedAfter).toBeLessThan(100);
		await client.close();
	});

	it("enables TCP keepalive on the LISTEN connection", () => {
		const listener = (
			registry as unknown as {
				listener?: {
					connection: {
						_keepAlive?: boolean;
						_keepAliveInitialDelayMillis?: number;
					};
				};
			}
		).listener;
		expect(listener?.connection._keepAlive).toBe(true);
		expect(listener?.connection._keepAliveInitialDelayMillis).toBe(10_000);
	});

	it("clears the cache and wakes waiters after the LISTEN connection drops", async () => {
		const m = randomUUID();
		await instance("gw-l1", "http://10.0.2.1:8081");
		const notified = registry.waitForChange(m, 2000);
		await session(m, "gw-l1");
		await notified;
		expect((await registry.lookup(m))?.internalUrl).toBe(
			"http://10.0.2.1:8081",
		);
		// Change the instance URL without a session NOTIFY, then kill the listener.
		await instance("gw-l1", "http://10.0.2.2:8081");
		const other = randomUUID();
		const start = Date.now();
		const wait = registry.waitForChange(other, 10_000);
		const killed = await db.pool.query(
			`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
			 WHERE application_name = 'sbx-agent-client-listen' AND datname = current_database()`,
		);
		expect(killed.rowCount).toBe(1);
		await wait;
		expect(Date.now() - start).toBeLessThan(5000);
		expect((await registry.lookup(m))?.internalUrl).toBe(
			"http://10.0.2.2:8081",
		);
		// The new listener receives NOTIFYs again.
		await instance("gw-l2", "http://10.0.2.3:8081");
		await session(m, "gw-l2", { epoch: 2n });
		await vi.waitFor(
			async () => {
				expect((await registry.lookup(m))?.instanceId).toBe("gw-l2");
			},
			{ timeout: 1000, interval: 20 },
		);
	});
});
