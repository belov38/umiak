// Rate limits per principal and per team for starts (S7 §5.8).
import { randomUUID } from "node:crypto";
import { generateApiKeySecret } from "@umiak/auth";
import { describe, expect, it } from "vitest";
import { limitStarts } from "../src/index.ts";
import { testIdentityStore, testSettings } from "../src/testing/index.ts";
import { createHarness } from "./helpers/harness.ts";

function errorOf(body: unknown) {
	return (body as { error: { code: string; details: Record<string, unknown> } })
		.error;
}

const TEAM_A = randomUUID();
const TEAM_B = randomUUID();
const A1 = generateApiKeySecret();
const A2 = generateApiKeySecret();
const B1 = generateApiKeySecret();

function harness(env: Record<string, string> = {}) {
	const identity = testIdentityStore({
		keys: [
			{ secret: A1, teamId: TEAM_A },
			{ secret: A2, teamId: TEAM_A },
			{ secret: B1, teamId: TEAM_B },
		],
	});
	const h = createHarness({ deps: { identity, settings: testSettings(env) } });
	h.app.get("/v1/__test/ping", (c) => c.body(null, 204));
	return h;
}

const as = (secret: string) => ({
	headers: { authorization: `Bearer ${secret}` },
});

describe("request rate limit (20/s, burst 100)", () => {
	it("the 101st request of a burst: 429 rate_limited with headers", async () => {
		const h = harness();
		const all = await Promise.all(
			Array.from({ length: 101 }, () =>
				h.request("GET", "/v1/__test/ping", as(A1)),
			),
		);
		const ok = all.filter((r) => r.status === 204);
		const limited = all.filter((r) => r.status === 429);
		expect(ok).toHaveLength(100);
		expect(limited).toHaveLength(1);
		const r = limited[0] as (typeof all)[number];
		expect(errorOf(r.body)).toMatchObject({
			code: "rate_limited",
			retryable: true,
		});
		const after = Number(r.headers.get("retry-after"));
		expect(after).toBeGreaterThanOrEqual(1);
		expect(after).toBeLessThanOrEqual(5);
		expect(errorOf(r.body).details.retryAfterSeconds).toBe(after);
		expect(r.headers.get("ratelimit-policy")).toBe('"req";q=100;w=5');
		expect(r.headers.get("ratelimit")).toMatch(/^"req";r=0;t=[1-5]$/);
	});

	it("successful answers carry RateLimit headers with the remaining count", async () => {
		const h = harness();
		const r = await h.request("GET", "/v1/__test/ping", as(A1));
		expect(r.headers.get("ratelimit-policy")).toBe('"req";q=100;w=5');
		expect(r.headers.get("ratelimit")).toMatch(/^"req";r=99;t=[1-5]$/);
	});

	it("each principal has its own bucket", async () => {
		const h = harness({ UMIAK_API_RATE_BURST: "2", UMIAK_API_RATE_RPS: "1" });
		expect((await h.request("GET", "/v1/__test/ping", as(A1))).status).toBe(
			204,
		);
		expect((await h.request("GET", "/v1/__test/ping", as(A1))).status).toBe(
			204,
		);
		expect((await h.request("GET", "/v1/__test/ping", as(A1))).status).toBe(
			429,
		);
		expect((await h.request("GET", "/v1/__test/ping", as(A2))).status).toBe(
			204,
		);
	});

	it("anonymous routes are not limited", async () => {
		const h = harness({ UMIAK_API_RATE_BURST: "1", UMIAK_API_RATE_RPS: "1" });
		for (let i = 0; i < 3; i++) {
			const r = await h.request("GET", "/v1/meta");
			expect(r.status).toBe(200);
			expect(r.headers.get("ratelimit")).toBeNull();
		}
	});
});

describe("starts per team per minute", () => {
	it("over the limit: 429 rate_limited; another team is not affected", async () => {
		const h = harness({ UMIAK_API_RATE_STARTS_PER_MIN: "2" });
		h.app.post("/v1/__test/start", limitStarts(h.deps), (c) =>
			c.body(null, 204),
		);
		const start = (s: string) => h.request("POST", "/v1/__test/start", as(s));
		expect((await start(A1)).status).toBe(204);
		// Another key of the same team shares the team's budget.
		expect((await start(A2)).status).toBe(204);
		const r = await start(A1);
		expect(r.status).toBe(429);
		expect(errorOf(r.body)).toMatchObject({
			code: "rate_limited",
			retryable: true,
			details: { limit: "starts" },
		});
		expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await start(B1)).status).toBe(204);
	});
});
