import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorDetailSchema } from "@sbx/proto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentClient,
	type AgentClientOptions,
	AgentUnavailableError,
	parseUploadOffset,
	readBodyCapped,
} from "../src/index.js";
import {
	expectNothingStolen,
	type FakeGateway,
	startFakeGateway,
	startTrap,
} from "./helpers/fake-gateway.js";
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
		registry.addInstance(b.url);
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

	for (const headers of [true, false]) {
		it(`returns a 421 whose hint (${headers ? "header" : "body"}) is not a live instance`, async () => {
			const trap = await startTrap();
			try {
				registry.set(route(m, a.url));
				a.script.push({
					answer: { kind: "moved", instanceUrl: trap.url, headers },
					times: Number.POSITIVE_INFINITY,
				});
				const res = await agent({ waitForAgentMs: 300, pollIntervalMs: 50 })
					.fetch(m, "?path=/data/f.bin")
					.catch((e: unknown) => e);
				expectNothingStolen(trap, m);
				expect(res).toBeInstanceOf(Response);
				const r = res as Response;
				expect(r.status).toBe(421);
				expect(await r.json()).toEqual({
					code: "machine_moved",
					instanceUrl: trap.url,
				});
				expect(fileRequests(b)).toHaveLength(0);
			} finally {
				await trap.close();
			}
		});
	}

	for (const method of ["GET", "PUT"]) {
		it(`returns an agent redirect (${method}) without following it`, async () => {
			const trap = await startTrap();
			try {
				registry.set(route(m, a.url));
				const other = randomUUID();
				for (const [status, location] of [
					[307, `/v1/machines/${other}/files?path=/secret`],
					[302, `${trap.url}/steal`],
					[308, `${b.url}/v1/machines/${other}/files?path=/secret`],
				] as const) {
					a.script.push({ answer: { kind: "redirect", status, location } });
					const before = a.requests.length;
					const res = await agent().fetch(m, "/uploads/u9?offset=0", {
						method,
						body: method === "PUT" ? "payload" : null,
						// A caller's "follow" does not apply.
						redirect: "follow",
					});
					expect(res.status).toBe(status);
					expect(res.headers.get("location")).toBe(location);
					await res.body?.cancel();
					expect(a.requests.length - before).toBe(1);
				}
				expectNothingStolen(trap, m);
				expect(b.requests).toHaveLength(0);
				expect(a.requests.some((r) => r.url.includes(other))).toBe(false);
			} finally {
				await trap.close();
			}
		});
	}

	it("retries a 421 whose hint cannot be checked instead of returning it", async () => {
		registry.set(route(m, a.url));
		registry.addInstance(b.url);
		let failures = 1;
		const live = registry.isLiveInstance.bind(registry);
		registry.isLiveInstance = async (u) => {
			if (failures > 0) {
				failures--;
				throw new Error("database hiccup");
			}
			return live(u);
		};
		// undici repeats a 421 once by itself: A keeps answering it.
		a.script.push({
			answer: { kind: "moved", instanceUrl: b.url },
			times: Number.POSITIVE_INFINITY,
			after: () => registry.set(route(m, b.url)),
		});
		const res = await agent({ pollIntervalMs: 50 }).fetch(
			m,
			"?path=/data/f.bin",
		);
		expect(res.status).toBe(200);
		expect((await readAll(res)).length).toBe(file.length);
		expect(failures).toBe(0);
		expect(fileRequests(b)).toHaveLength(1);
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
		registry.addInstance(b.url);
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

	describe("path traversal", () => {
		const other = randomUUID();
		for (const path of [
			"/../rotate-token",
			`/../../${other}/files/x`,
			"/%2e%2e/x",
			"/%2E%2e/x",
			"/%252e%252e/x",
			"/%252E%252E/x",
			"/a%252fb",
			"/a%252Fb",
			"/a%255cb",
			"/a%255Cb",
			"/%25252e%25252e/x",
			"/./x",
			"/a%2fb",
			"/a%2Fb",
			"/a%5cb",
			"/a\\b",
			"/..\\x",
			"/%zz",
			// The URL parser drops tabs: only the final pathname check sees "..".
			"/.\t./x",
		]) {
			it(`rejects ${JSON.stringify(path)} without a request`, async () => {
				registry.set(route(m, a.url));
				await expect(agent().fetch(m, path)).rejects.toThrow(TypeError);
				expect(a.requests).toHaveLength(0);
			});
		}

		for (const path of [
			"/.bashrc",
			"/a..b",
			"/x/...",
			"?path=/x/../y",
			"/50%25off.txt",
			"/a%25b",
			"/100%25",
			"/%25%25",
		]) {
			it(`allows ${JSON.stringify(path)}`, async () => {
				registry.set(route(m, a.url));
				const res = await agent().fetch(m, path);
				await res.body?.cancel();
				expect(fileRequests(a).map((r) => r.url)).toEqual([
					`/v1/machines/${m}/files${path}`,
				]);
			});
		}
	});

	describe("compression", () => {
		it("sends Accept-Encoding: identity by default", async () => {
			registry.set(route(m, a.url));
			const res = await agent().fetch(m, "?path=/data/f.bin");
			await res.body?.cancel();
			expect(fileRequests(a)[0]?.headers["accept-encoding"]).toBe("identity");
		});

		function encoded(encoding: string, body: Uint8Array) {
			a.script.push({
				route: "files",
				answer: {
					kind: "raw",
					status: 200,
					headers: {
						"content-type": "application/octet-stream",
						"content-encoding": encoding,
						"content-length": String(body.length),
					},
					body,
				},
			});
		}

		const zeros = Buffer.alloc(8 * 1024 * 1024);
		for (const [name, encoding, body] of [
			["gzip", "gzip", gzipSync(zeros)],
			["stacked gzip", "gzip, gzip, gzip", gzipSync(gzipSync(gzipSync(zeros)))],
			["br", "br", Buffer.from("x")],
			["unknown", "x-agent", Buffer.from("x")],
		] as const) {
			it(`refuses a ${name} answer to the default Accept-Encoding`, async () => {
				registry.set(route(m, a.url));
				encoded(encoding, body);
				const err = await agent()
					.fetch(m, "?path=/bomb")
					.catch((e: unknown) => e);
				expect(err).toBeInstanceOf(ConnectError);
				expect((err as ConnectError).code).toBe(Code.Internal);
				expect(
					(err as ConnectError).findDetails(ErrorDetailSchema)[0]?.code,
				).toBe("bad_agent_response");
				expect(fileRequests(a)).toHaveLength(1);
			});
		}

		it("passes an identity answer to the default Accept-Encoding", async () => {
			registry.set(route(m, a.url));
			encoded("Identity", Buffer.from("plain"));
			const res = await agent().fetch(m, "?path=/plain");
			expect(Buffer.from(await readBodyCapped(res, 100)).toString()).toBe(
				"plain",
			);
		});

		it("keeps a caller's Accept-Encoding", async () => {
			registry.set(route(m, a.url));
			const res = await agent().fetch(m, "?path=/data/f.bin", {
				headers: { "accept-encoding": "gzip" },
			});
			await res.body?.cancel();
			expect(fileRequests(a)[0]?.headers["accept-encoding"]).toBe("gzip");
		});
	});

	describe("readBodyCapped", () => {
		it("returns a body within the cap", async () => {
			registry.set(route(m, a.url));
			const res = await agent().fetch(m, "?path=/data/f.bin");
			const body = await readBodyCapped(res, file.length);
			expect(Buffer.from(body)).toEqual(Buffer.from(file));
		});

		it("stops past the cap", async () => {
			registry.set(route(m, a.url));
			const res = await agent().fetch(m, "?path=/data/f.bin");
			const err = await readBodyCapped(res, file.length - 1).catch(
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(ConnectError);
			expect((err as ConnectError).code).toBe(Code.ResourceExhausted);
			expect(res.bodyUsed).toBe(true);
		});

		it("counts decoded bytes of a compressed body", async () => {
			registry.set(route(m, a.url));
			const zipped = gzipSync(Buffer.alloc(16 * 1024 * 1024));
			a.script.push({
				route: "files",
				answer: {
					kind: "raw",
					status: 200,
					headers: {
						"content-type": "application/octet-stream",
						"content-encoding": "gzip",
						"content-length": String(zipped.length),
					},
					body: zipped,
				},
			});
			const res = await agent().fetch(m, "?path=/bomb", {
				headers: { "accept-encoding": "gzip" },
			});
			const err = await readBodyCapped(res, 1024 * 1024).catch(
				(e: unknown) => e,
			);
			expect((err as ConnectError).code).toBe(Code.ResourceExhausted);
		});

		it("refuses a cap that is not a non-negative safe integer", async () => {
			for (const v of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
				await expect(
					readBodyCapped(new Response("x"), v),
					String(v),
				).rejects.toThrow(RangeError);
			}
		});

		it("reads an absent body as empty", async () => {
			expect(await readBodyCapped(new Response(null), 0)).toHaveLength(0);
		});
	});
});

describe("parseUploadOffset", () => {
	it("parses decimal digits up to 2^63-1", () => {
		expect(parseUploadOffset("0")).toBe(0n);
		expect(parseUploadOffset("4194304")).toBe(4194304n);
		expect(parseUploadOffset("007")).toBe(7n);
		expect(parseUploadOffset("9223372036854775807")).toBe(9223372036854775807n);
	});

	it("rejects everything else", () => {
		for (const v of [
			null,
			"",
			" 1",
			"1 ",
			"+1",
			"-1",
			"1.0",
			"1e3",
			"0x10",
			"１",
			"9223372036854775808",
			"18446744073709551615",
			"000000000000000000001",
			"1,2",
		]) {
			expect(parseUploadOffset(v), JSON.stringify(v)).toBeUndefined();
		}
	});
});
