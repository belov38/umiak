import { readFile } from "node:fs/promises";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	it,
	vi,
} from "vitest";
import { generateTypes, outputUrl } from "../scripts/gen.ts";
import {
	createRawClient,
	type RawResponse,
	type SbxOptions,
	SDK_VERSION,
} from "../src/client.ts";
import { SbxError } from "../src/errors.ts";
import type { components, paths } from "../src/gen/v1.d.ts";

const API = "https://api.example.test";
const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Seen {
	method: string;
	url: string;
	headers: Headers;
	body: string;
}

type Reply =
	| Response
	| Error
	| ((req: Request) => Response | Promise<Response>);

/** A fetch that answers with the scripted replies in turn and records requests. */
function fakeFetch(...replies: Reply[]) {
	const seen: Seen[] = [];
	const fetch = async (input: Request | string | URL, init?: RequestInit) => {
		const req = input instanceof Request ? input : new Request(input, init);
		seen.push({
			method: req.method,
			url: req.url,
			headers: new Headers(req.headers),
			body: await req.text(),
		});
		const next = replies.shift();
		if (next === undefined) throw new Error("no scripted reply left");
		if (next instanceof Error) throw next;
		if (typeof next === "function") return next(req);
		return next;
	};
	return { fetch: fetch as typeof globalThis.fetch, seen };
}

function json(status: number, body: unknown, headers: HeadersInit = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function apiError(
	status: number,
	code: string,
	retryable: boolean,
	headers: HeadersInit = {},
	details: Record<string, unknown> = {},
) {
	return json(
		status,
		{
			error: {
				code,
				message: `${code} happened`,
				retryable,
				details,
				requestId: "req_body",
			},
		},
		{ "Request-Id": "req_header", ...headers },
	);
}

const SANDBOX = { id: "sb_1", slug: "quiet-otter-lamp", state: "creating" };

function client(
	fetch: typeof globalThis.fetch,
	creds: Pick<SbxOptions, "apiKey" | "tokenProvider"> = { apiKey: "sbx_test" },
) {
	return createRawClient({
		baseUrl: API,
		team: "team_1",
		fetch,
		env: {},
		...creds,
	});
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("headers", () => {
	it("sends Authorization, Sbx-Team and User-Agent", async () => {
		const f = fakeFetch(json(200, { user: null }));
		const { data, response } = await client(f.fetch).GET("/v1/me");
		expect(data).toEqual({ user: null });
		expect(response.status).toBe(200);
		const h = f.seen[0]?.headers;
		expect(f.seen[0]?.url).toBe(`${API}/v1/me`);
		expect(h?.get("authorization")).toBe("Bearer sbx_test");
		expect(h?.get("sbx-team")).toBe("team_1");
		expect(h?.get("user-agent")).toBe(`sbx-sdk-ts/${SDK_VERSION}`);
		expect(h?.has("idempotency-key")).toBe(false);
	});

	it("SDK_VERSION is the package version", async () => {
		const pkg = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as { version: string };
		expect(SDK_VERSION).toBe(pkg.version);
	});

	it("userAgent option replaces the default; no team, no Sbx-Team", async () => {
		const f = fakeFetch(json(200, {}));
		await createRawClient({
			baseUrl: API,
			apiKey: "sbx_test",
			fetch: f.fetch,
			userAgent: "my-tool/1.0",
			env: {},
		}).GET("/v1/me");
		expect(f.seen[0]?.headers.get("user-agent")).toBe("my-tool/1.0");
		expect(f.seen[0]?.headers.has("sbx-team")).toBe(false);
	});

	it("generates an Idempotency-Key for the keyed POSTs only", async () => {
		const keyed = [
			["/v1/sandboxes", {}],
			[
				"/v1/sandboxes/{sandbox}/fork",
				{ params: { path: { sandbox: "sb_1" } } },
			],
			[
				"/v1/sandboxes/{sandbox}/commands",
				{ params: { path: { sandbox: "sb_1" } }, body: { command: "true" } },
			],
			[
				"/v1/sandboxes/{sandbox}/ptys",
				{ params: { path: { sandbox: "sb_1" } } },
			],
			["/v1/snapshots", { body: { sandbox: "sb_1", name: "s" } }],
		] as const;
		for (const [path, init] of keyed) {
			const f = fakeFetch(json(200, {}));
			// biome-ignore lint/suspicious/noExplicitAny: iterating over different paths
			await client(f.fetch).POST(path as any, init as any);
			expect(f.seen[0]?.headers.get("idempotency-key"), path).toMatch(UUID_V4);
		}
		const f = fakeFetch(json(202, {}));
		await client(f.fetch).POST("/v1/sandboxes/{sandbox}/stop", {
			params: { path: { sandbox: "sb_1" } },
		});
		expect(f.seen[0]?.headers.has("idempotency-key")).toBe(false);
	});

	it("uses the caller's idempotencyKey", async () => {
		const f = fakeFetch(json(202, {}));
		await client(f.fetch).POST("/v1/sandboxes", {
			body: {},
			idempotencyKey: "my-key-1",
		});
		expect(f.seen[0]?.headers.get("idempotency-key")).toBe("my-key-1");
	});
});

describe("retries", () => {
	it("503 on create is retried with the same Idempotency-Key", async () => {
		const f = fakeFetch(
			apiError(503, "out_of_capacity", true, { "Retry-After": "1" }),
			json(202, { sandbox: SANDBOX }),
		);
		const p = client(f.fetch).POST("/v1/sandboxes", {
			body: { template: "linux" },
		});
		await vi.runAllTimersAsync();
		const { data } = await p;
		expect(data).toEqual({ sandbox: SANDBOX });
		expect(f.seen).toHaveLength(2);
		const [a, b] = f.seen;
		expect(a?.headers.get("idempotency-key")).toMatch(UUID_V4);
		expect(b?.headers.get("idempotency-key")).toBe(
			a?.headers.get("idempotency-key"),
		);
		expect(b?.body).toBe(JSON.stringify({ template: "linux" }));
	});

	it("network error on a keyed POST is retried with the same key", async () => {
		const f = fakeFetch(
			new TypeError("fetch failed"),
			json(202, { sandbox: SANDBOX }),
		);
		const p = client(f.fetch).POST("/v1/sandboxes", { body: {} });
		await vi.runAllTimersAsync();
		await p;
		expect(f.seen).toHaveLength(2);
		expect(f.seen[1]?.headers.get("idempotency-key")).toBe(
			f.seen[0]?.headers.get("idempotency-key"),
		);
	});

	it("POST without a key and 503 retryable:false is not retried", async () => {
		const f = fakeFetch(
			apiError(503, "server_shutting_down", false, { "Retry-After": "1" }),
			json(202, {}),
		);
		const err = await client(f.fetch)
			.POST("/v1/sandboxes/{sandbox}/stop", {
				params: { path: { sandbox: "sb_1" } },
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SbxError);
		expect(err).toMatchObject({
			status: 503,
			code: "server_shutting_down",
			message: "server_shutting_down happened",
			retryable: false,
			details: {},
			requestId: "req_body",
			retryAfterMs: 1000,
		});
		expect(f.seen).toHaveLength(1);
	});

	it("network error on a POST without a key is not retried", async () => {
		const f = fakeFetch(new TypeError("fetch failed"), json(202, {}));
		const err = await client(f.fetch)
			.POST("/v1/sandboxes/{sandbox}/stop", {
				params: { path: { sandbox: "sb_1" } },
			})
			.catch((e: unknown) => e);
		expect(err).toMatchObject({
			name: "SbxError",
			status: 0,
			code: "network_error",
			retryable: false,
			requestId: null,
		});
		expect((err as Error).cause).toBeInstanceOf(TypeError);
		expect(f.seen).toHaveLength(1);
	});

	it("Retry-After: 2 delays the retry by 2 s", async () => {
		const f = fakeFetch(
			apiError(429, "rate_limited", true, { "Retry-After": "2" }),
			json(200, { items: [] }),
		);
		const p = client(f.fetch).GET("/v1/sandboxes");
		await vi.advanceTimersByTimeAsync(1999);
		expect(f.seen).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await p;
		expect(f.seen).toHaveLength(2);
	});

	it("retryBudgetMs exhausted gives the last error", async () => {
		const f = fakeFetch(
			apiError(503, "agent_unavailable", true, { "Retry-After": "0" }),
			apiError(503, "out_of_capacity", true, { "Retry-After": "2" }),
			json(200, {}),
		);
		const p = client(f.fetch)
			.GET("/v1/sandboxes", { retryBudgetMs: 1000 })
			.catch((e: unknown) => e);
		await vi.runAllTimersAsync();
		expect(await p).toMatchObject({ code: "out_of_capacity" });
		expect(f.seen).toHaveLength(2);
	});

	it("signal.abort() during the backoff rejects with AbortError at once", async () => {
		const f = fakeFetch(
			apiError(503, "agent_unavailable", true, { "Retry-After": "5" }),
			json(200, {}),
		);
		const ac = new AbortController();
		const p = client(f.fetch)
			.GET("/v1/sandboxes", { signal: ac.signal })
			.catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(100);
		ac.abort();
		expect(await p).toMatchObject({ name: "AbortError" });
		await vi.runAllTimersAsync();
		expect(f.seen).toHaveLength(1);
	});

	it("an aborted signal reaches fetch", async () => {
		const ac = new AbortController();
		const f = fakeFetch((req) => {
			expect(req.signal.aborted).toBe(false);
			ac.abort();
			expect(req.signal.aborted).toBe(true);
			throw req.signal.reason;
		});
		const err = await client(f.fetch)
			.GET("/v1/sandboxes", { signal: ac.signal })
			.catch((e: unknown) => e);
		expect(err).toMatchObject({ name: "AbortError" });
		expect(f.seen).toHaveLength(1);
	});

	it("an error body without the envelope becomes unexpected_response", async () => {
		const f = fakeFetch(
			new Response("<html>bad gateway</html>", {
				status: 502,
				headers: { "Request-Id": "req_proxy" },
			}),
			new Response("<html>bad gateway</html>", { status: 500 }),
		);
		const p = client(f.fetch)
			.GET("/v1/sandboxes")
			.catch((e: unknown) => e);
		await vi.runAllTimersAsync();
		expect(await p).toMatchObject({
			status: 500,
			code: "unexpected_response",
			retryable: false,
			requestId: null,
		});
		expect(f.seen).toHaveLength(2);
	});
});

describe("401 token_expired", () => {
	it("takes a new token once and repeats the request", async () => {
		const f = fakeFetch(
			apiError(401, "token_expired", false),
			json(200, { ok: true }),
		);
		let n = 0;
		const raw = client(f.fetch, { tokenProvider: async () => `jwt-${++n}` });
		const { data } = await raw.GET("/v1/me");
		expect(data).toEqual({ ok: true });
		expect(f.seen.map((s) => s.headers.get("authorization"))).toEqual([
			"Bearer jwt-1",
			"Bearer jwt-2",
		]);
	});

	it("a second token_expired is returned to the caller", async () => {
		const f = fakeFetch(
			apiError(401, "token_expired", false),
			apiError(401, "token_expired", false),
			json(200, {}),
		);
		let n = 0;
		const raw = client(f.fetch, { tokenProvider: async () => `jwt-${++n}` });
		await expect(raw.GET("/v1/me")).rejects.toMatchObject({
			status: 401,
			code: "token_expired",
		});
		expect(f.seen).toHaveLength(2);
		expect(n).toBe(2);
	});

	it("unauthorized is not refreshed", async () => {
		const f = fakeFetch(apiError(401, "unauthorized", false), json(200, {}));
		await expect(client(f.fetch).GET("/v1/me")).rejects.toMatchObject({
			code: "unauthorized",
		});
		expect(f.seen).toHaveLength(1);
	});
});

describe("content types", () => {
	it("POST /commands with parseAs stream gives the NDJSON body", async () => {
		const ndjson =
			'{"type":"started","commandId":"cmd_1"}\n{"type":"exit","exitCode":0}\n';
		const f = fakeFetch(
			new Response(ndjson, {
				status: 200,
				headers: { "Content-Type": "application/x-ndjson" },
			}),
		);
		const { data, response } = await client(f.fetch).POST(
			"/v1/sandboxes/{sandbox}/commands",
			{
				params: { path: { sandbox: "sb_1" } },
				// `as const`: openapi-fetch infers the init from the argument, a widened
				// literal would lose `parseAs`.
				body: { command: "echo hi", mode: "stream" as const },
				parseAs: "stream",
			},
		);
		expect(response.headers.get("content-type")).toBe("application/x-ndjson");
		expect(await new Response(data).text()).toBe(ndjson);
	});

	it("204 has no data", async () => {
		const f = fakeFetch(new Response(null, { status: 204 }));
		const { data } = await client(f.fetch).DELETE(
			"/v1/sandboxes/{sandbox}/ports/{port}",
			{ params: { path: { sandbox: "sb_1", port: 8000 } } },
		);
		expect(data).toBeUndefined();
	});
});

describe("generated types", () => {
	it("response enums are open, known values stay", () => {
		type State = components["schemas"]["SandboxState"];
		expectTypeOf<"ready">().toExtend<State>();
		expectTypeOf<"hibernated">().toExtend<State>();
		expectTypeOf<State>().toExtend<string>();
		type Data = RawResponse<
			paths["/v1/sandboxes/{sandbox}"]["get"],
			Record<string, never>
		>["data"];
		expectTypeOf<Data["state"]>().toEqualTypeOf<State>();
		type Reason = components["schemas"]["Sandbox"]["stopReason"];
		expectTypeOf<null>().toExtend<Reason>();
		expectTypeOf<"something_new">().toExtend<Reason>();
		// Closed enums (requests, frame discriminators) stay closed.
		type Mode = NonNullable<
			components["schemas"]["StartCommandRequest"]["mode"]
		>;
		expectTypeOf<"stream">().toExtend<Mode>();
		expectTypeOf<"bogus">().not.toExtend<Mode>();
	});

	it("src/gen/v1.d.ts is fresh (pnpm --filter @sbx/sdk gen)", async () => {
		vi.useRealTimers();
		const committed = await readFile(outputUrl, "utf8");
		expect(committed).toBe(await generateTypes());
	});
});
