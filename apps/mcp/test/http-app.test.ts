// The remote MCP endpoint (S11 6.2, 6.3 item 3, 8.8, 10.1, 10.2, 11.5,
// 13.3): both protocol eras, Host/Origin, methods and body size, the HTTP
// filters, the 401 of the api during a call, the per-principal limit, HTTP
// cancellation, health and metrics.
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpsApp } from "../src/http/app.ts";
import {
	allowedHostsOf,
	allowedOriginsOf,
	hostAllowed,
	MAX_BODY_BYTES,
	MAX_CALLS_PER_PRINCIPAL,
	originAllowed,
} from "../src/http/limits.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";
import { FAKE_TEAM, FAKE_TOKENS } from "./fake-api/index.ts";
import { answerOf } from "./helpers/harness.ts";
import { type HttpHarness, startHttp } from "./helpers/http.ts";

let h: HttpHarness | undefined;

afterEach(async () => {
	vi.useRealTimers();
	await h?.close();
	h = undefined;
});

const names = (tools: { name: string }[]) => tools.map((t) => t.name);

const json = { "content-type": "application/json" };

const LIST = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "tools/list",
	params: {},
});

async function readySandbox(
	c: Awaited<ReturnType<HttpHarness["connect"]>>,
): Promise<string> {
	const r = answerOf(
		(await c.client.callTool({
			name: "sandbox_create",
			arguments: {},
		})) as never,
	);
	expect(r.isError, r.texts[0]).toBe(false);
	return r.json.id as string;
}

describe("both protocol eras", () => {
	for (const era of ["modern", "legacy"] as const) {
		it(`lists all tools and calls one (${era})`, async () => {
			h = await startHttp();
			const c = await h.connect(FAKE_TOKENS.owner, { era });
			const { tools } = await c.client.listTools();
			expect(names(tools)).toEqual(ALL_TOOLS.map((t) => t.name));
			const r = await c.client.callTool({ name: "limits_get", arguments: {} });
			expect(r.isError).toBeFalsy();
		});
	}

	it("forwards traceparent from _meta and names the client in User-Agent", async () => {
		h = await startHttp();
		const c = await h.connect(FAKE_TOKENS.full);
		const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
		await c.client.callTool({
			name: "limits_get",
			arguments: {},
			_meta: { traceparent: tp },
		});
		const call = h.apiCalls.find((a) => a.path === "/v1/limits");
		expect(call?.headers.get("traceparent")).toBe(tp);
		expect(call?.headers.get("user-agent")).toMatch(
			/^umiak-mcp\/\S+ \(test-client\/9\.9\.9; http\)$/,
		);
		// No traceparent: no header.
		await c.client.callTool({ name: "limits_get", arguments: {} });
		const second = h.apiCalls.filter((a) => a.path === "/v1/limits")[1];
		expect(second?.headers.get("traceparent")).toBeNull();
	});
});

describe("guards", () => {
	it("refuses a foreign Origin with 403 and a foreign Host with 421", async () => {
		h = await startHttp();
		const auth = { authorization: `Bearer ${FAKE_TOKENS.full}` };
		const evil = await h.raw("POST", "/mcp", {
			headers: { ...json, ...auth, origin: "https://evil.example" },
			body: LIST,
		});
		expect(evil.status).toBe(403);
		const host = await h.raw("POST", "/mcp", {
			headers: { ...json, ...auth, host: "evil.example" },
			body: LIST,
		});
		expect(host.status).toBe(421);
		const prm = await h.raw(
			"GET",
			"/.well-known/oauth-protected-resource/mcp",
			{
				headers: { host: "evil.example" },
			},
		);
		expect(prm.status).toBe(404);
		// Health has no checks at all.
		const health = await h.raw("GET", "/healthz", {
			headers: { host: "evil.example" },
		});
		expect(health.status).toBe(200);
		expect(h.journal(/\/v1\//)).toEqual([]);
	});

	it("accepts a listed Origin and an extra Host", async () => {
		h = await startHttp({
			http: {
				allowedOrigins: ["https://app.example.com"],
				allowedHosts: ["mcp.internal:8080"],
			},
		});
		const auth = { authorization: `Bearer ${FAKE_TOKENS.full}` };
		const ok = await h.raw("POST", "/mcp", {
			headers: {
				...json,
				...auth,
				accept: "application/json, text/event-stream",
				origin: "https://app.example.com",
				host: "mcp.internal:8080",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "raw", version: "1" },
				},
			}),
		});
		expect(ok.status).toBe(200);
		expect(ok.headers["access-control-allow-origin"]).toBeUndefined();
	});

	it("matches Host by the public URL and the extra hosts (decision 8)", () => {
		const allowed = allowedHostsOf("https://api.example.com/mcp", [
			"mcp.internal:8080",
			"[::1]",
		]);
		expect(hostAllowed("api.example.com", allowed)).toBe(true);
		expect(hostAllowed("API.example.com:443", allowed)).toBe(true);
		expect(hostAllowed("mcp.internal:8080", allowed)).toBe(true);
		expect(hostAllowed("[::1]:8090", allowed)).toBe(true);
		for (const bad of [
			"mcp.internal:8081",
			"mcp.internal",
			"api.example.com.evil.example",
			"evil.example",
			"",
			null,
		]) {
			expect(hostAllowed(bad, allowed), String(bad)).toBe(false);
		}
		const origins = allowedOriginsOf(["https://app.example.com"]);
		expect(originAllowed(null, origins)).toBe(true);
		expect(originAllowed("https://app.example.com", origins)).toBe(true);
		expect(originAllowed("https://app.example.com:444", origins)).toBe(false);
		expect(originAllowed("null", origins)).toBe(false);
		expect(originAllowed("garbage", origins)).toBe(false);
	});

	it("answers 405 to GET and DELETE", async () => {
		h = await startHttp();
		for (const method of ["GET", "DELETE"]) {
			for (const auth of [
				{},
				{ authorization: `Bearer ${FAKE_TOKENS.full}` },
			]) {
				const r = await h.raw(method, "/mcp", {
					headers: { accept: "text/event-stream", ...auth },
				});
				expect(r.status, method).toBe(405);
				expect(r.headers.allow).toBe("POST");
			}
		}
	});

	it("answers 413 to a body over 2 MiB, declared or streamed", async () => {
		h = await startHttp();
		const auth = { authorization: `Bearer ${FAKE_TOKENS.full}` };
		const big = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20);
		const declared = await h.raw("POST", "/mcp", {
			headers: { ...json, ...auth },
			body: big,
		});
		expect(declared.status).toBe(413);
		const streamed = await fetch(h.url, {
			method: "POST",
			headers: { ...json, ...auth },
			body: new ReadableStream({
				start(c) {
					c.enqueue(big.subarray(0, 1024 * 1024));
					c.enqueue(big.subarray(1024 * 1024));
					c.close();
				},
			}),
			duplex: "half",
		} as RequestInit);
		expect(streamed.status).toBe(413);
		// Exactly 2 MiB of JSON passes the limit (and is not valid JSON-RPC).
		const edge = await h.raw("POST", "/mcp", {
			headers: { ...json, ...auth },
			body: Buffer.alloc(MAX_BODY_BYTES, 0x20),
		});
		expect(edge.status).not.toBe(413);
	});

	it("answers 400 to an unknown toolset", async () => {
		h = await startHttp();
		const r = await h.raw("POST", "/mcp?toolsets=core,nope", {
			headers: { ...json, authorization: `Bearer ${FAKE_TOKENS.full}` },
			body: LIST,
		});
		expect(r.status).toBe(400);
		expect(r.text).toContain('unknown toolset \\"nope\\"');
	});
});

describe("tool filters over HTTP", () => {
	it("?toolsets=core&read_only=1 lists core read-only tools only", async () => {
		h = await startHttp();
		const c = await h.connect(FAKE_TOKENS.owner, {
			query: "?toolsets=core&read_only=1",
		});
		const { tools } = await c.client.listTools();
		const want = ALL_TOOLS.filter(
			(t) => t.toolset === "core" && t.annotations.readOnlyHint,
		).map((t) => t.name);
		expect(names(tools)).toEqual(want);
		expect(want).toContain("sandbox_list");
		expect(want).not.toContain("exec_run");
	});

	it("a read-only key sees read-only tools; a hidden tool is unknown", async () => {
		h = await startHttp();
		const c = await h.connect(FAKE_TOKENS.readOnly, { era: "legacy" });
		const { tools } = await c.client.listTools();
		for (const t of tools)
			expect(t.annotations?.readOnlyHint, t.name).toBe(true);
		expect(names(tools)).not.toContain("sandbox_create");
		const r = await c.client
			.callTool({ name: "sandbox_create", arguments: {} })
			.then(
				(v) => ({ ok: v }),
				(e: unknown) => ({ err: e as Error }),
			);
		const text =
			"err" in r
				? r.err.message
				: JSON.stringify((r.ok as { content: unknown }).content);
		expect(text).toMatch(/sandbox_create/);
		expect(text).toMatch(/not found|unknown/i);
		expect(h.journal(/^POST \/v1\/sandboxes$/)).toEqual([]);
	});

	it("a sandbox of another team is not_found from the API and stays untouched", async () => {
		h = await startHttp();
		const mine = await h.connect(FAKE_TOKENS.full);
		const sb = await readySandbox(mine);
		const other = await h.connect(FAKE_TOKENS.otherTeam);
		const r = answerOf(
			(await other.client.callTool({
				name: "sandbox_stop",
				arguments: { sandbox: sb },
			})) as never,
		);
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toMatch(/^error: not_found$/m);
		const state = h.api.state.sandboxes.get(sb);
		expect(state?.state).toBe("ready");
		expect(state?.teamId).toBe(FAKE_TEAM);
	});
});

describe("a 401 of the API during a call", () => {
	// A revoked credential: the command started, its output stream breaks
	// and the reconnect is 401. (`expireTokenOnce` is token_expired, which
	// the SDK retries once with the same bearer: it never reaches the tool.)
	const SLOW = "fake:emit 400:20:300";
	const revokeStream = (api: HttpHarness["api"], cutAfter = 40) => {
		api.script.breakStreamAfterBytes = cutAfter;
		api.script.failNext = {
			path: /^GET \/v1\/sandboxes\/[^/]+\/commands\/[^/]+\/stream$/,
			status: 401,
			code: "unauthorized",
			retryable: false,
		};
	};

	it("becomes HTTP 401 with WWW-Authenticate while the answer is JSON", async () => {
		h = await startHttp();
		const c = await h.connect(FAKE_TOKENS.full);
		const sb = await readySandbox(c);
		revokeStream(h.api);
		const err = await c.client
			.callTool({
				name: "exec_run",
				arguments: { sandbox: sb, command: SLOW },
			})
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(err).not.toBeNull();
		expect(h.api.script.failNext).toBeUndefined();
		const last = c.responses.at(-1);
		expect(last?.status).toBe(401);
		expect(last?.headers.has("www-authenticate")).toBe(false);
		// The cached check was dropped: the next request asks /v1/me again.
		const before = h.journal(/^GET \/v1\/me$/).length;
		await h.raw("POST", "/mcp", {
			headers: { ...json, authorization: `Bearer ${FAKE_TOKENS.full}` },
			body: LIST,
		});
		expect(h.journal(/^GET \/v1\/me$/).length).toBe(before + 1);
		const rejections = await h.metrics.authRejections.get();
		expect(
			rejections.values.find((v) => v.labels.reason === "api_401_in_call")
				?.value,
		).toBe(1);
	});

	it("is a retryable unauthorized tool error once SSE has started", async () => {
		h = await startHttp();
		const c = await h.connect(FAKE_TOKENS.full);
		const sb = await readySandbox(c);
		const s = h;
		let progressed = 0;
		const r = answerOf(
			(await c.client.callTool(
				{
					name: "exec_run",
					arguments: {
						sandbox: sb,
						command: "fake:emit 400:20:500",
						wait_seconds: 30,
					},
				},
				{
					onprogress: () => {
						progressed++;
						// The first progress opened the SSE stream: now break the
						// command stream and make its reconnect 401.
						revokeStream(s.api, 1);
					},
				},
			)) as never,
		);
		expect(progressed).toBeGreaterThan(0);
		expect(c.responses.at(-1)?.status).toBe(200);
		expect(c.responses.at(-1)?.headers.get("content-type")).toMatch(
			/^text\/event-stream/,
		);
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toMatch(/^error: unauthorized$/m);
		expect(r.texts[0]).toMatch(/^retryable: true$/m);
	}, 30_000);

	it("is a retryable unauthorized tool error on a 2025-era stream", async () => {
		h = await startHttp();
		const c = await h.connect(FAKE_TOKENS.full, { era: "legacy" });
		const sb = await readySandbox(c);
		revokeStream(h.api);
		const r = answerOf(
			(await c.client.callTool({
				name: "exec_run",
				arguments: { sandbox: sb, command: SLOW },
			})) as never,
		);
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toMatch(/^error: unauthorized$/m);
		expect(r.texts[0]).toMatch(/^retryable: true$/m);
	});
});

describe("concurrency and cancellation", () => {
	it("answers the 17th concurrent call of a principal with rate_limited", async () => {
		h = await startHttp();
		const c = await h.connect(FAKE_TOKENS.full);
		const sb = await readySandbox(c);
		const s = h;
		const running = Array.from({ length: MAX_CALLS_PER_PRINCIPAL }, () =>
			c.client.callTool({
				name: "exec_run",
				arguments: { sandbox: sb, command: "fake:sleep 2", wait_seconds: 10 },
			}),
		);
		await vi.waitFor(
			() => expect(s.api.state.commands.size).toBe(MAX_CALLS_PER_PRINCIPAL),
			{ timeout: 10_000 },
		);
		const extra = answerOf(
			(await c.client.callTool({ name: "limits_get", arguments: {} })) as never,
		);
		expect(extra.isError).toBe(true);
		expect(extra.texts[0]).toMatch(/^error: rate_limited$/m);
		expect(extra.texts[0]).toMatch(/^retryable: true$/m);
		// Another principal is not limited.
		const other = await h.connect(FAKE_TOKENS.owner);
		const free = await other.client.callTool({
			name: "limits_get",
			arguments: {},
		});
		expect(free.isError).toBeFalsy();
		const done = await Promise.all(running);
		expect(done.every((r) => !r.isError)).toBe(true);
		const after = await c.client.callTool({
			name: "limits_get",
			arguments: {},
		});
		expect(after.isError).toBeFalsy();
		const calls = await h.metrics.calls.get();
		expect(
			calls.values.find(
				(v) =>
					v.labels.tool === "limits_get" && v.labels.outcome === "rate_limited",
			)?.value,
		).toBe(1);
		expect((await h.metrics.inFlight.get()).values[0]?.value).toBe(0);
	}, 30_000);

	for (const era of ["modern", "legacy"] as const) {
		it(`an HTTP cancel or a dropped connection leaves exec_run's command running (${era})`, async () => {
			h = await startHttp();
			const c = await h.connect(FAKE_TOKENS.full, { era });
			const sb = await readySandbox(c);
			const s = h;
			const ac = new AbortController();
			const call = c.client
				.callTool(
					{
						name: "exec_run",
						arguments: { sandbox: sb, command: "fake:sleep 30" },
					},
					{ signal: ac.signal },
				)
				.catch((e: unknown) => e);
			await vi.waitFor(() => expect(s.api.state.commands.size).toBe(1));
			await new Promise((r) => setTimeout(r, 200));
			// Cancel: the 2026 client drops the request; the 2025 one sends
			// notifications/cancelled, which a stateless pod cannot apply.
			ac.abort();
			await call;
			// Drop: the client goes away; the pod ends its wait.
			await c.close();
			await vi.waitFor(() =>
				expect(
					s.logs.some((l) => l.msg === "tool call" && l.tool === "exec_run"),
				).toBe(true),
			);
			await new Promise((r) => setTimeout(r, 200));
			expect(s.journal(/\/kill$/)).toEqual([]);
			const cmd = [...s.api.state.commands.values()][0];
			expect(cmd?.status).toBe("running");
		});
	}
});

describe("health and metrics", () => {
	it("serves /healthz and /readyz without auth; /readyz is 503 after close", async () => {
		h = await startHttp();
		expect((await h.raw("GET", "/healthz")).status).toBe(200);
		expect((await h.raw("GET", "/readyz")).status).toBe(200);
		expect(h.http.ready()).toBe(true);
		await h.http.close();
		const r = await h.raw("GET", "/readyz");
		expect(r.status).toBe(503);
		expect(JSON.parse(r.text).reasons).toEqual(["shutting_down"]);
		const late = await h.raw("POST", "/mcp", {
			headers: { ...json, authorization: `Bearer ${FAKE_TOKENS.full}` },
			body: LIST,
		});
		expect(late.status).toBe(503);
		expect(late.headers["retry-after"]).toBe("1");
	});

	it("drain: /readyz and new /mcp requests are 503 at once; the call in flight still answers", async () => {
		h = await startHttp();
		const s = h;
		const c = await h.connect(FAKE_TOKENS.full);
		const sb = await readySandbox(c);
		const call = c.client.callTool({
			name: "exec_run",
			arguments: { sandbox: sb, command: "fake:sleep 30", wait_seconds: 2 },
		});
		await vi.waitFor(() => expect(s.api.state.commands.size).toBe(1));
		h.http.drain();
		expect(h.http.ready()).toBe(false);
		const ready = await h.raw("GET", "/readyz");
		expect(ready.status).toBe(503);
		expect(JSON.parse(ready.text).reasons).toEqual(["shutting_down"]);
		const late = await h.raw("POST", "/mcp", {
			headers: { ...json, authorization: `Bearer ${FAKE_TOKENS.full}` },
			body: LIST,
		});
		expect(late.status).toBe(503);
		expect(late.headers["retry-after"]).toBe("1");
		const r = answerOf((await call) as never);
		expect(r.isError).toBe(false);
		expect(r.json.status).toBe("running");
	});

	it("exposes call counters and 401s on the ops /metrics", async () => {
		h = await startHttp();
		const c = await h.connect(FAKE_TOKENS.full);
		await c.client.callTool({ name: "limits_get", arguments: {} });
		await h.raw("POST", "/mcp", { headers: json, body: LIST });
		await h.raw("POST", "/mcp", {
			headers: { ...json, authorization: "Bearer umiak_bad" },
			body: LIST,
		});
		const ops = createOpsApp({ metrics: h.metrics, ready: () => true });
		const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
			const s = serve(
				{ fetch: ops.fetch, port: 0, hostname: "127.0.0.1" },
				() => resolve(s),
			);
		});
		try {
			const addr = server.address() as { port: number };
			const base = `http://127.0.0.1:${addr.port}`;
			expect((await fetch(`${base}/healthz`)).status).toBe(200);
			expect((await fetch(`${base}/readyz`)).status).toBe(200);
			const text = await (await fetch(`${base}/metrics`)).text();
			expect(text).toContain(
				'umiak_mcp_tool_calls_total{tool="limits_get",outcome="ok"} 1',
			);
			expect(text).toContain(
				'umiak_mcp_auth_rejections_total{status="401",reason="unauthorized"} 2',
			);
			expect(text).toContain("umiak_mcp_me_cache_misses_total 4");
			expect(text).toContain("umiak_mcp_tool_call_duration_seconds_bucket");
			expect(text).toContain("umiak_mcp_tool_response_bytes_bucket");
			expect(text).toContain("umiak_mcp_tool_calls_in_flight 0");
			expect(text).not.toContain(FAKE_TOKENS.full);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
