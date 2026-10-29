import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentClient,
	type AgentClientOptions,
	AgentUnavailableError,
} from "../src/index.js";
import { type FakeGateway, startFakeGateway } from "./helpers/fake-gateway.js";
import { MemoryRegistry, route } from "./helpers/memory-registry.js";

const token = "svc-token";

describe("AgentClient.fetch", () => {
	let a: FakeGateway;
	let b: FakeGateway;
	let registry: MemoryRegistry;
	let clients: AgentClient[];
	const m = randomUUID();
	const file = new Uint8Array(100_000).map((_, i) => i % 251);

	beforeEach(async () => {
		a = await startFakeGateway({ token });
		b = await startFakeGateway({ token });
		a.files.set("/data/f.bin", file);
		b.files.set("/data/f.bin", file);
		registry = new MemoryRegistry();
		clients = [];
	});

	afterEach(async () => {
		for (const c of clients) {
			await c.close();
		}
		await a.close();
		await b.close();
	});

	function agent(opts: Partial<AgentClientOptions> = {}): AgentClient {
		const c = new AgentClient({
			registry,
			serviceToken: token,
			waitForAgentMs: 5000,
			pollIntervalMs: 1000,
			...opts,
		});
		clients.push(c);
		return c;
	}

	function fileRequests(gw: FakeGateway) {
		return gw.requests.filter((r) => r.url.includes("/files"));
	}

	async function readAll(res: Response): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		const reader = res.body?.getReader();
		if (reader === undefined) {
			return new Uint8Array();
		}
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			parts.push(value);
		}
		return Buffer.concat(parts);
	}

	it("GET with Range returns 206 with the streamed tail", async () => {
		registry.set(route(m, a.url));
		const res = await agent().fetch(m, "?path=/data/f.bin", {
			headers: { Range: "bytes=10-" },
		});
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe(
			`bytes 10-${file.length - 1}/${file.length}`,
		);
		expect(Buffer.from(await readAll(res))).toEqual(
			Buffer.from(file.subarray(10)),
		);
		const reqs = fileRequests(a);
		expect(reqs).toHaveLength(1);
		expect(reqs[0]?.protocol).toBe("h1");
		expect(reqs[0]?.url).toBe(`/v1/machines/${m}/files?path=/data/f.bin`);
	});

	it("follows 421 to Sbx-Instance-Url keeping Range and Authorization", async () => {
		registry.set(route(m, a.url));
		// The machine stays moved on A. undici's fetch itself repeats a 421 once
		// on a new connection (Fetch spec), so A sees two requests.
		a.script.push({
			answer: { kind: "moved", instanceUrl: b.url },
			times: Number.POSITIVE_INFINITY,
		});
		const res = await agent().fetch(m, "?path=/data/f.bin", {
			headers: { Range: "bytes=99990-", "Sbx-Request-Id": "r-7" },
		});
		expect(res.status).toBe(206);
		expect(Buffer.from(await readAll(res))).toEqual(
			Buffer.from(file.subarray(99990)),
		);
		expect(fileRequests(a)).toHaveLength(2);
		expect(fileRequests(b)).toHaveLength(1);
		const [rb] = fileRequests(b);
		expect(rb?.headers.range).toBe("bytes=99990-");
		expect(rb?.headers.authorization).toBe(`Bearer ${token}`);
		expect(rb?.headers["sbx-request-id"]).toBe("r-7");
		expect(registry.invalidations).toContain(m);
	});

	it("waits for a registry change after 503 agent_unavailable", async () => {
		registry.set(route(m, a.url));
		a.script.push({
			answer: { kind: "unavailable" },
			after: () => setTimeout(() => registry.set(route(m, b.url)), 50),
		});
		const start = Date.now();
		const res = await agent({
			pollIntervalMs: 10_000,
			waitForAgentMs: 20_000,
		}).fetch(m, "?path=/data/f.bin");
		expect(res.status).toBe(200);
		expect((await readAll(res)).length).toBe(file.length);
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("resends a Uint8Array upload body after 421", async () => {
		registry.set(route(m, a.url));
		a.script.push({
			answer: { kind: "moved", instanceUrl: b.url },
			times: Number.POSITIVE_INFINITY,
		});
		const chunk = new Uint8Array(4 << 20).map((_, i) => (i * 7) % 256);
		const res = await agent().fetch(m, "/uploads/u1?offset=0", {
			method: "PUT",
			body: chunk,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ size: chunk.length });
		expect(fileRequests(a)[0]?.body?.length).toBe(chunk.length);
		expect(b.uploads.get("u1")?.equals(Buffer.from(chunk))).toBe(true);
		expect(fileRequests(b)[0]?.url).toBe(
			`/v1/machines/${m}/files/uploads/u1?offset=0`,
		);
	});

	it("resends a body from a factory after 503", async () => {
		registry.set(route(m, a.url));
		a.script.push({
			answer: { kind: "unavailable" },
			after: () => registry.set(route(m, b.url)),
		});
		let calls = 0;
		const res = await agent().fetch(m, "/uploads/u2?offset=0", {
			method: "PUT",
			body: () => {
				calls++;
				return new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode("streamed"));
						c.close();
					},
				});
			},
		});
		expect(res.status).toBe(200);
		expect(calls).toBe(2);
		expect(b.uploads.get("u2")?.toString()).toBe("streamed");
	});

	it("does not resend a one-shot ReadableStream body and returns the 421", async () => {
		registry.set(route(m, a.url));
		a.script.push({ answer: { kind: "moved", instanceUrl: b.url } });
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode("once"));
				c.close();
			},
		});
		const res = await agent().fetch(m, "/uploads/u3?offset=0", {
			method: "PUT",
			body,
		});
		expect(res.status).toBe(421);
		expect(res.headers.get("sbx-error-code")).toBe("machine_moved");
		expect(res.headers.get("sbx-instance-url")).toBe(b.url);
		expect(await res.json()).toEqual({
			code: "machine_moved",
			instanceUrl: b.url,
		});
		expect(fileRequests(a)).toHaveLength(1);
		expect(fileRequests(b)).toHaveLength(0);
	});

	it("returns an agent 404 as the Response after one request", async () => {
		registry.set(route(m, a.url));
		const res = await agent().fetch(m, "?path=/nope");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found" });
		expect(fileRequests(a)).toHaveLength(1);
	});

	it("returns a 503 without Sbx-Error-Code as the Response", async () => {
		registry.set(route(m, a.url));
		a.script.push({ answer: { kind: "plain", status: 503 } });
		const res = await agent().fetch(m, "?path=/data/f.bin");
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("agent says no");
		expect(fileRequests(a)).toHaveLength(1);
	});

	it("fails with AgentUnavailableError when the machine never connects", async () => {
		const start = Date.now();
		const err = await agent({ waitForAgentMs: 300, pollIntervalMs: 50 })
			.fetch(m, "?path=/data/f.bin")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AgentUnavailableError);
		expect((err as AgentUnavailableError).retryable).toBe(true);
		expect(Date.now() - start).toBeGreaterThanOrEqual(290);
	});

	it("retries after a connection error to a dead instance", async () => {
		const dead = await startFakeGateway({ token });
		await dead.close();
		registry.set(route(m, dead.url));
		setTimeout(() => registry.set(route(m, a.url)), 100);
		const res = await agent({ pollIntervalMs: 50 }).fetch(
			m,
			"?path=/data/f.bin",
		);
		expect(res.status).toBe(200);
		await res.body?.cancel();
	});

	it("does not retry a TypeError that is not a connection error", async () => {
		registry.set(route(m, a.url));
		const start = Date.now();
		// fetch refuses a GET with a body before sending anything.
		const err = await agent()
			.fetch(m, "?path=/data/f.bin", { method: "GET", body: "x" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TypeError);
		expect(err).not.toBeInstanceOf(AgentUnavailableError);
		expect(Date.now() - start).toBeLessThan(500);
		expect(fileRequests(a)).toHaveLength(0);
	});

	it("rejects a path that does not start with /", async () => {
		registry.set(route(m, a.url));
		await expect(agent().fetch(m, "uploads/x")).rejects.toThrow(TypeError);
	});
});
