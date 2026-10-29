import { randomUUID } from "node:crypto";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { ErrorDetailSchema } from "@sbx/proto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentClient,
	type AgentClientOptions,
	AgentOutdatedError,
	AgentUnavailableError,
	classify,
} from "../src/index.js";
import { Process } from "./gen/sbx/testing/v1/process_pb.js";
import { type FakeGateway, startFakeGateway } from "./helpers/fake-gateway.js";
import { MemoryRegistry, route } from "./helpers/memory-registry.js";

const token = "svc-token";

describe("AgentClient transport", () => {
	let a: FakeGateway;
	let b: FakeGateway;
	let registry: MemoryRegistry;
	let clients: AgentClient[];
	const m = randomUUID();

	beforeEach(async () => {
		a = await startFakeGateway({ token });
		b = await startFakeGateway({ token });
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

	function rpcRequests(gw: FakeGateway) {
		return gw.requests.filter((r) => r.url.includes("/rpc/"));
	}

	it("routes a unary call to the owning instance with the service token", async () => {
		registry.set(route(m, a.url));
		const process = createClient(Process, agent().transport(m));
		const res = await process.setLabel({ commandId: "c1", label: "x" });
		expect(res.calls).toBe(1n);
		const reqs = rpcRequests(a);
		expect(reqs).toHaveLength(1);
		expect(reqs[0]?.protocol).toBe("h2");
		expect(reqs[0]?.url).toBe(
			`/v1/machines/${m}/rpc/sbx.testing.v1.Process/SetLabel`,
		);
	});

	it("follows 421 to Sbx-Instance-Url with the same Sbx-Request-Id", async () => {
		registry.set(route(m, a.url));
		a.script.push({ answer: { kind: "moved", instanceUrl: b.url } });
		const process = createClient(Process, agent().transport(m));
		const res = await process.setLabel(
			{ commandId: "c1", label: "x" },
			{ headers: { "Sbx-Request-Id": "req-1" } },
		);
		expect(res.calls).toBe(1n);
		expect(rpcRequests(a)).toHaveLength(1);
		expect(rpcRequests(b)).toHaveLength(1);
		expect(rpcRequests(a)[0]?.headers["sbx-request-id"]).toBe("req-1");
		expect(rpcRequests(b)[0]?.headers["sbx-request-id"]).toBe("req-1");
		expect(registry.invalidations).toContain(m);
	});

	it("waits for a registry change after 503 agent_unavailable", async () => {
		registry.set(route(m, a.url));
		a.script.push({
			answer: { kind: "unavailable" },
			after: () => setTimeout(() => registry.set(route(m, b.url)), 50),
		});
		// A long poll interval: only the registry change can wake the client in time.
		const process = createClient(
			Process,
			agent({ pollIntervalMs: 10_000, waitForAgentMs: 20_000 }).transport(m),
		);
		const start = Date.now();
		const res = await process.setLabel({ commandId: "c1", label: "x" });
		expect(res.calls).toBe(1n);
		expect(Date.now() - start).toBeLessThan(2000);
		expect(rpcRequests(b)).toHaveLength(1);
	});

	it("fails with a retryable AgentUnavailableError when the machine never connects", async () => {
		const process = createClient(
			Process,
			agent({ waitForAgentMs: 300, pollIntervalMs: 50 }).transport(m),
		);
		const start = Date.now();
		const err = await process
			.setLabel({ commandId: "c1", label: "x" })
			.catch((e: unknown) => e);
		const elapsed = Date.now() - start;
		expect(err).toBeInstanceOf(AgentUnavailableError);
		const e = err as AgentUnavailableError;
		expect(e.retryable).toBe(true);
		expect(e.code).toBe(Code.Unavailable);
		expect(e.findDetails(ErrorDetailSchema)[0]?.code).toBe("agent_unavailable");
		expect(elapsed).toBeGreaterThanOrEqual(290);
		expect(elapsed).toBeLessThan(3000);
	});

	it("does not retry InvalidArgument", async () => {
		registry.set(route(m, a.url));
		const process = createClient(Process, agent().transport(m));
		const err = await process
			.setLabel({ commandId: "c1", label: "bad" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConnectError);
		expect((err as ConnectError).code).toBe(Code.InvalidArgument);
		expect(rpcRequests(a)).toHaveLength(1);
	});

	it("retries a server stream that got 421 before the response headers", async () => {
		registry.set(route(m, a.url));
		a.script.push({ answer: { kind: "moved", instanceUrl: b.url } });
		const process = createClient(Process, agent().transport(m));
		const chunks: string[] = [];
		let exit = false;
		for await (const ev of process.attach({
			commandId: "c1",
			stdoutOffset: 0n,
		})) {
			if (ev.event.case === "data") {
				chunks.push(new TextDecoder().decode(ev.event.value.data));
			}
			if (ev.event.case === "exit") {
				exit = true;
			}
		}
		expect(chunks.join("")).toBe("0123456789abcdefghij");
		expect(exit).toBe(true);
		expect(rpcRequests(a)).toHaveLength(1);
		expect(rpcRequests(b)).toHaveLength(1);
	});

	it("retries a server stream after 503 and a registry change", async () => {
		registry.set(route(m, a.url));
		a.script.push({
			answer: { kind: "unavailable" },
			after: () => setTimeout(() => registry.set(route(m, b.url)), 20),
		});
		const process = createClient(Process, agent().transport(m));
		let n = 0;
		for await (const _ of process.attach({
			commandId: "c1",
			stdoutOffset: 16n,
		})) {
			n++;
		}
		expect(n).toBe(2); // one data event (bytes 16-19) and exit
		expect(rpcRequests(b)).toHaveLength(1);
	});

	it("caps attempts with maxAttempts", async () => {
		registry.set(route(m, a.url));
		for (let i = 0; i < 5; i++) {
			a.script.push({ answer: { kind: "moved", instanceUrl: a.url } });
		}
		const process = createClient(
			Process,
			agent({ maxAttempts: 3 }).transport(m),
		);
		const err = await process
			.setLabel({ commandId: "c1", label: "x" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AgentUnavailableError);
		expect(rpcRequests(a)).toHaveLength(3);
	});

	it("retries after a connection error to a dead instance", async () => {
		const dead = await startFakeGateway({ token });
		await dead.close();
		registry.set(route(m, dead.url));
		setTimeout(() => registry.set(route(m, a.url)), 100);
		const process = createClient(Process, agent().transport(m));
		const res = await process.setLabel({ commandId: "c1", label: "x" });
		expect(res.calls).toBe(1n);
	});

	it("does not retry when the caller aborts", async () => {
		const ac = new AbortController();
		const process = createClient(
			Process,
			agent({ waitForAgentMs: 5000 }).transport(m),
		);
		setTimeout(() => ac.abort(), 50);
		const start = Date.now();
		const err = await process
			.setLabel({ commandId: "c1", label: "x" }, { signal: ac.signal })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConnectError);
		expect((err as ConnectError).code).toBe(Code.Canceled);
		expect(Date.now() - start).toBeLessThan(1000);
	});

	it("honours the Connect deadline across retries", async () => {
		const process = createClient(
			Process,
			agent({ waitForAgentMs: 5000 }).transport(m),
		);
		const start = Date.now();
		const err = await process
			.setLabel({ commandId: "c1", label: "x" }, { timeoutMs: 200 })
			.catch((e: unknown) => e);
		expect((err as ConnectError).code).toBe(Code.DeadlineExceeded);
		expect(Date.now() - start).toBeLessThan(1000);
	});

	it("classifies a stream reset inside an envelope as retryable", async () => {
		registry.set(route(m, a.url));
		a.script.push({ answer: { kind: "reset-mid-envelope" } });
		const process = createClient(Process, agent().transport(m));
		const err = await (async () => {
			for await (const _ of process.attach({ commandId: "c1" })) {
				// No complete message can arrive.
			}
		})().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConnectError);
		expect(classify(err)).not.toBe("fatal");
		// The truncated stream invalidates the cached route.
		expect(registry.invalidations).toContain(m);
	});

	it("requireCapability throws AgentOutdatedError when the capability is missing", async () => {
		registry.set(route(m, a.url, { capabilities: ["process.pty"] }));
		const c = agent();
		await expect(
			c.requireCapability(m, "process.pty"),
		).resolves.toBeUndefined();
		const err = await c
			.requireCapability(m, "files.upload.v1")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AgentOutdatedError);
		const e = err as AgentOutdatedError;
		expect(e.code).toBe(Code.FailedPrecondition);
		expect(e.capability).toBe("files.upload.v1");
		expect(e.findDetails(ErrorDetailSchema)[0]?.code).toBe("agent_outdated");
	});
});

describe("classify", () => {
	it("maps gateway metadata, details and codes", () => {
		const moved = new ConnectError("HTTP 421", Code.Unknown, {
			"sbx-error-code": "machine_moved",
			"sbx-instance-url": "http://x",
		});
		expect(classify(moved)).toBe("moved");
		const unavailable = new ConnectError("HTTP 503", Code.Unavailable, {
			"sbx-error-code": "agent_unavailable",
		});
		expect(classify(unavailable)).toBe("unavailable");
		expect(classify(new ConnectError("x", Code.Unavailable))).toBe(
			"unavailable",
		);
		expect(
			classify(
				new ConnectError("x", Code.Internal, undefined, undefined, {
					code: "ERR_HTTP2_STREAM_ERROR",
				}),
			),
		).toBe("retry");
		expect(classify(new ConnectError("x", Code.Canceled))).toBe("retry");
		const ac = new AbortController();
		ac.abort();
		expect(classify(new ConnectError("x", Code.Canceled), ac.signal)).toBe(
			"fatal",
		);
		for (const code of [
			Code.InvalidArgument,
			Code.NotFound,
			Code.PermissionDenied,
			Code.FailedPrecondition,
			Code.DeadlineExceeded,
			Code.Unknown,
		]) {
			expect(classify(new ConnectError("x", code))).toBe("fatal");
		}
	});
});
