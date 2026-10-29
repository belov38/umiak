import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PgRegistry, type Registry } from "@sbx/agent-client";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { UnavailableAgentPort } from "../src/adapters/agent-unavailable.ts";
import {
	HttpGatewayPort,
	UnconfiguredGatewayPort,
} from "../src/adapters/gateway-http.ts";
import {
	AgentUnavailable,
	GatewayRejected,
	GatewayUnavailable,
	isPermanent,
	isRetryable,
} from "../src/ports.ts";

const TOKEN = "worker-service-token";

interface Seen {
	method: string;
	url: string;
	auth: string | undefined;
}

interface Reply {
	status: number;
	body?: string;
	headers?: Record<string, string>;
}

/** A tiny stand-in for a gateway instance's internal listener. */
interface FakeGateway {
	url: string;
	requests: Seen[];
	/** Answer of the next requests; may run side effects first. */
	reply: (req: Seen) => Reply | Promise<Reply>;
	close(): Promise<void>;
}

let db: TestDatabase;
let registry: PgRegistry;
let gateways: FakeGateway[] = [];
/** Machine ids passed to registry.invalidate. */
let invalidated: string[] = [];

async function gateway(): Promise<FakeGateway> {
	const g: FakeGateway = {
		url: "",
		requests: [],
		reply: () => ({ status: 200, body: "{}" }),
		close: async () => {},
	};
	const server: Server = createServer((req: IncomingMessage, res) => {
		const seen = {
			method: req.method ?? "",
			url: req.url ?? "",
			auth: req.headers.authorization,
		};
		g.requests.push(seen);
		req.resume();
		req.on("end", async () => {
			const r = await g.reply(seen);
			res.writeHead(r.status, {
				"content-type": "application/json",
				...r.headers,
			});
			res.end(r.body ?? "");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	g.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	g.close = () => new Promise<void>((r) => server.close(() => r()));
	gateways.push(g);
	return g;
}

beforeAll(async () => {
	db = await createTestDatabase();
	registry = await PgRegistry.connect({ connectionString: db.url });
});

afterAll(async () => {
	await registry?.close();
	await db?.drop();
});

beforeEach(() => {
	invalidated = [];
	calls = [];
});

afterEach(async () => {
	await Promise.all(gateways.map((g) => g.close()));
	gateways = [];
});

async function instance(url: string, o: { staleS?: number } = {}) {
	const id = `gw-${randomUUID().slice(0, 8)}`;
	await db.pool.query(
		`INSERT INTO tunnel.gateway_instances (id, internal_url, state, started_at, heartbeat_at)
		 VALUES ($1, $2, 'active', now(), now() - make_interval(secs => $3))`,
		[id, url, o.staleS ?? 0],
	);
	return id;
}

async function session(
	machineId: string,
	instanceId: string,
	state: "connected" | "disconnected" = "connected",
) {
	await db.pool.query(
		`INSERT INTO tunnel.tunnel_sessions
		   (machine_id, instance_id, epoch, conn_id, agent_instance_id, boot_id, vmgenid,
		    agent_version, proto_version, state, connected_at)
		 VALUES ($1, $2, 1, 'c', 'a', 'b', 'v', '1', '1', $3, now())`,
		[machineId, instanceId, state],
	);
}

/** The machine reconnects through another instance (S2 §8.2: epoch + 1). */
async function move(machineId: string, instanceId: string) {
	await db.pool.query(
		`UPDATE tunnel.tunnel_sessions
		 SET instance_id = $2, epoch = epoch + 1, connected_at = now()
		 WHERE machine_id = $1`,
		[machineId, instanceId],
	);
}

/** The real PgRegistry, recording invalidations. */
function spied(): Registry {
	return {
		lookup: (m) => registry.lookup(m),
		isLiveInstance: (u) => registry.isLiveInstance(u),
		invalidate: (m) => {
			invalidated.push(m);
			registry.invalidate(m);
		},
		waitForChange: (m, t, s) => registry.waitForChange(m, t, s),
		close: async () => {},
	};
}

/** URLs of the port's fetch calls (logical attempts). */
let calls: string[] = [];

// Node's fetch (undici) itself repeats a request once on a fresh connection
// after a 421, so a fake gateway may see two HTTP requests per attempt; the
// tests count the port's own attempts through the injected fetch.
function port() {
	return new HttpGatewayPort(spied(), {
		serviceToken: TOKEN,
		fetch: (input, init) => {
			calls.push(String(input));
			return fetch(input, init);
		},
	});
}

function rotatePath(m: string) {
	return `/v1/machines/${m}/rotate-token`;
}

const moved = (url?: string): Reply => ({
	status: 421,
	body: JSON.stringify({ code: "machine_moved", instanceUrl: url }),
	headers: {
		"sbx-error-code": "machine_moved",
		...(url === undefined ? {} : { "sbx-instance-url": url }),
	},
});

describe("HttpGatewayPort.rotateToken", () => {
	it("posts to the owner instance found by the registry with the service token", async () => {
		const a = await gateway();
		const m = randomUUID();
		await session(m, await instance(a.url));
		await port().rotateToken(m);
		expect(a.requests).toEqual([
			{ method: "POST", url: rotatePath(m), auth: `Bearer ${TOKEN}` },
		]);
	});

	it("no connected session is a transient error and sends nothing", async () => {
		const a = await gateway();
		const m = randomUUID();
		await session(m, await instance(a.url), "disconnected");
		const err = await port()
			.rotateToken(m)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GatewayUnavailable);
		expect(isRetryable(err)).toBe(true);
		expect(
			await port()
				.rotateToken(randomUUID())
				.catch((e) => e),
		).toBeInstanceOf(GatewayUnavailable);
		expect(a.requests).toHaveLength(0);
	});

	it("an instance with a stale heartbeat is not an owner", async () => {
		const a = await gateway();
		const m = randomUUID();
		await session(m, await instance(a.url, { staleS: 20 }));
		const err = await port()
			.rotateToken(m)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GatewayUnavailable);
		expect(a.requests).toHaveLength(0);
	});

	it("421: invalidates the route and retries once against the new owner", async () => {
		const a = await gateway();
		const b = await gateway();
		const m = randomUUID();
		const idB = await instance(b.url);
		await session(m, await instance(a.url));
		const p = port();
		// Warm the registry cache with the route to A.
		expect((await registry.lookup(m))?.internalUrl).toBe(a.url);
		a.reply = async () => {
			await move(m, idB);
			return moved(b.url);
		};
		await p.rotateToken(m);
		expect(calls).toEqual([a.url + rotatePath(m), b.url + rotatePath(m)]);
		expect(b.requests).toEqual([
			{ method: "POST", url: rotatePath(m), auth: `Bearer ${TOKEN}` },
		]);
		expect(invalidated).toContain(m);
	});

	it("421 while the registry still names the old owner: follows a live hint", async () => {
		const a = await gateway();
		const b = await gateway();
		const m = randomUUID();
		await instance(b.url);
		await session(m, await instance(a.url));
		a.reply = () => moved(b.url);
		await port().rotateToken(m);
		expect(calls).toEqual([a.url + rotatePath(m), b.url + rotatePath(m)]);
		expect(b.requests).toHaveLength(1);
	});

	it("421 with a hint that is not a live instance is transient and not followed", async () => {
		const a = await gateway();
		const b = await gateway();
		const m = randomUUID();
		await instance(b.url, { staleS: 60 });
		await session(m, await instance(a.url));
		a.reply = () => moved(b.url);
		const err = await port()
			.rotateToken(m)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GatewayUnavailable);
		expect(calls).toEqual([a.url + rotatePath(m)]);
		expect(b.requests).toHaveLength(0);
		// Without a hint the same owner is not asked again either.
		a.reply = () => moved();
		calls = [];
		expect(
			await port()
				.rotateToken(m)
				.catch((e: unknown) => e),
		).toBeInstanceOf(GatewayUnavailable);
		expect(calls).toEqual([a.url + rotatePath(m)]);
	});

	it("repeated 421s are bounded: two attempts, then transient", async () => {
		const a = await gateway();
		const b = await gateway();
		const m = randomUUID();
		const idA = await instance(a.url);
		const idB = await instance(b.url);
		await session(m, idA);
		a.reply = async () => {
			await move(m, idB);
			return moved(b.url);
		};
		b.reply = async () => {
			await move(m, idA);
			return moved(a.url);
		};
		const err = await port()
			.rotateToken(m)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GatewayUnavailable);
		expect(calls).toEqual([a.url + rotatePath(m), b.url + rotatePath(m)]);
	});

	it("404, 410 and 503 agent_unavailable are transient", async () => {
		for (const r of [
			{ status: 404, body: "{}" },
			{ status: 410, body: "{}" },
			{
				status: 503,
				body: '{"code":"agent_unavailable"}',
				headers: { "sbx-error-code": "agent_unavailable" },
			},
		]) {
			const a = await gateway();
			const m = randomUUID();
			await session(m, await instance(a.url));
			a.reply = () => r;
			const err = await port()
				.rotateToken(m)
				.catch((e: unknown) => e);
			expect(err, String(r.status)).toBeInstanceOf(GatewayUnavailable);
			expect(a.requests, String(r.status)).toHaveLength(1);
		}
	});

	it("401 and 403 are a permanent GatewayRejected", async () => {
		for (const status of [401, 403]) {
			const a = await gateway();
			const m = randomUUID();
			await session(m, await instance(a.url));
			a.reply = () => ({ status, body: "unauthenticated" });
			const err = await port()
				.rotateToken(m)
				.catch((e: unknown) => e);
			expect(err, String(status)).toBeInstanceOf(GatewayRejected);
			expect(isPermanent(err)).toBe(true);
		}
	});

	it("5xx is transient, including a failed rotation (502)", async () => {
		for (const status of [500, 502, 503]) {
			const a = await gateway();
			const m = randomUUID();
			await session(m, await instance(a.url));
			a.reply = () => ({ status, body: '{"code":"rotation_failed"}' });
			const err = await port()
				.rotateToken(m)
				.catch((e: unknown) => e);
			expect(err, String(status)).toBeInstanceOf(GatewayUnavailable);
		}
	});

	it("a connection error is transient and drops the cached route", async () => {
		const m = randomUUID();
		await session(m, await instance("http://127.0.0.1:1"));
		const err = await port()
			.rotateToken(m)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GatewayUnavailable);
		expect(invalidated).toContain(m);
	});

	it("a registry failure is transient", async () => {
		const broken: Registry = {
			...spied(),
			lookup: async () => {
				throw new Error("connection terminated");
			},
		};
		const err = await new HttpGatewayPort(broken, { serviceToken: TOKEN })
			.rotateToken(randomUUID())
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GatewayUnavailable);
		expect(isRetryable(err)).toBe(true);
	});

	it("uses the injected fetch and trims the trailing slash of internal_url", async () => {
		const m = randomUUID();
		await session(m, await instance("http://gw.internal:7000/"));
		const seen: string[] = [];
		const p = new HttpGatewayPort(spied(), {
			serviceToken: TOKEN,
			fetch: async (input) => {
				seen.push(String(input));
				return new Response("{}", { status: 200 });
			},
		});
		await p.rotateToken(m);
		expect(seen).toEqual([`http://gw.internal:7000${rotatePath(m)}`]);
	});
});

describe("UnavailableAgentPort", () => {
	it("every call fails with the transient AgentUnavailable", async () => {
		const a = new UnavailableAgentPort();
		const m = randomUUID();
		const calls: Promise<unknown>[] = [
			a.claim(
				m,
				{
					reason: "claim",
					sandboxId: randomUUID(),
					hostname: "h",
					env: {},
					secretEnv: {},
					secretFiles: [],
					authorizedKeys: [],
				},
				"r1",
			),
			a.updateEnv(m, {}, "r2"),
			a.updateSecrets(m, { secretEnv: {}, secretFiles: [] }, "r3"),
			a.prepareStop(m),
			a.activity(m),
			a.quiesceHook(m, 30_000).freeze(),
		];
		for (const c of calls) {
			const err = await c.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(AgentUnavailable);
			expect(isRetryable(err)).toBe(true);
		}
	});
});

describe("UnconfiguredGatewayPort", () => {
	it("every rotation is a transient gateway_unavailable", async () => {
		const err = await new UnconfiguredGatewayPort()
			.rotateToken(randomUUID())
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GatewayUnavailable);
		expect(isRetryable(err)).toBe(true);
		expect(String((err as Error).message)).toMatch(/not configured/);
	});
});
