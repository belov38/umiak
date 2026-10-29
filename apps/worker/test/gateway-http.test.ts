import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UnavailableAgentPort } from "../src/adapters/agent-unavailable.ts";
import { HttpGatewayPort } from "../src/adapters/gateway-http.ts";
import {
	AgentUnavailable,
	GatewayRejected,
	GatewayUnavailable,
	isPermanent,
	isRetryable,
} from "../src/ports.ts";

const TOKEN = "worker-service-token";

let db: TestDatabase;
let server: Server;
let baseUrl: string;
let reply: { status: number; body: string } = { status: 200, body: "{}" };
let requests: { method: string; url: string; auth: string | undefined }[] = [];

beforeAll(async () => {
	db = await createTestDatabase();
	server = createServer((req: IncomingMessage, res) => {
		requests.push({
			method: req.method ?? "",
			url: req.url ?? "",
			auth: req.headers.authorization,
		});
		req.resume();
		req.on("end", () => {
			res.writeHead(reply.status, { "content-type": "application/json" });
			res.end(reply.body);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((r) => server.close(() => r()));
	await db?.drop();
});

beforeEach(() => {
	reply = { status: 200, body: "{}" };
	requests = [];
});

async function instance(o: { url?: string; staleS?: number } = {}) {
	const id = `gw-${randomUUID().slice(0, 8)}`;
	await db.pool.query(
		`INSERT INTO tunnel.gateway_instances (id, internal_url, state, started_at, heartbeat_at)
		 VALUES ($1, $2, 'active', now(), now() - make_interval(secs => $3))`,
		[id, o.url ?? baseUrl, o.staleS ?? 0],
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

function port() {
	return new HttpGatewayPort(db.pool, { serviceToken: TOKEN });
}

describe("HttpGatewayPort.rotateToken", () => {
	it("posts to the owner instance with the service token", async () => {
		const m = randomUUID();
		await session(m, await instance());
		await port().rotateToken(m);
		expect(requests).toEqual([
			{
				method: "POST",
				url: `/v1/machines/${m}/rotate-token`,
				auth: `Bearer ${TOKEN}`,
			},
		]);
	});

	it("no connected session is a transient error and sends nothing", async () => {
		const m = randomUUID();
		await session(m, await instance(), "disconnected");
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
		expect(requests).toHaveLength(0);
	});

	it("an instance with a stale heartbeat is not an owner", async () => {
		const m = randomUUID();
		await session(m, await instance({ staleS: 20 }));
		const err = await port()
			.rotateToken(m)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GatewayUnavailable);
		expect(requests).toHaveLength(0);
	});

	it("404, 410 and 421 mean the route moved: transient", async () => {
		for (const status of [404, 410, 421]) {
			const m = randomUUID();
			await session(m, await instance());
			reply = { status, body: '{"code":"machine_moved"}' };
			const err = await port()
				.rotateToken(m)
				.catch((e: unknown) => e);
			expect(err, String(status)).toBeInstanceOf(GatewayUnavailable);
		}
	});

	it("401 and 403 are a permanent GatewayRejected", async () => {
		for (const status of [401, 403]) {
			const m = randomUUID();
			await session(m, await instance());
			reply = { status, body: "unauthenticated" };
			const err = await port()
				.rotateToken(m)
				.catch((e: unknown) => e);
			expect(err, String(status)).toBeInstanceOf(GatewayRejected);
			expect(isPermanent(err)).toBe(true);
		}
	});

	it("5xx is transient, including a failed rotation (502)", async () => {
		for (const status of [500, 502, 503]) {
			const m = randomUUID();
			await session(m, await instance());
			reply = { status, body: '{"code":"rotation_failed"}' };
			const err = await port()
				.rotateToken(m)
				.catch((e: unknown) => e);
			expect(err, String(status)).toBeInstanceOf(GatewayUnavailable);
		}
	});

	it("a connection error is transient", async () => {
		const m = randomUUID();
		await session(m, await instance({ url: "http://127.0.0.1:1" }));
		const err = await port()
			.rotateToken(m)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GatewayUnavailable);
	});

	it("uses the injected fetch", async () => {
		const m = randomUUID();
		await session(m, await instance({ url: "http://gw.internal:7000/" }));
		const seen: string[] = [];
		const p = new HttpGatewayPort(db.pool, {
			serviceToken: TOKEN,
			fetch: async (input) => {
				seen.push(String(input));
				return new Response("{}", { status: 200 });
			},
		});
		await p.rotateToken(m);
		expect(seen).toEqual([
			`http://gw.internal:7000/v1/machines/${m}/rotate-token`,
		]);
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
