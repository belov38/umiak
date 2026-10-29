// Public listener: bearer handling and team API keys (S7 §7.1, §7.2, §7.10)
// and GET /v1/me for a key (§13).

import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
	apiKeyHash,
	encodeUuid,
	generateApiKeySecret,
	PRESETS,
} from "@sbx/auth";
import { skipPg } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IdentityListener } from "../src/index.ts";
import { issueApiKey, TEST_API_KEY } from "../src/testing/index.ts";
import {
	eventually,
	type IdentityWorld,
	identityWorld,
} from "./helpers/auth.ts";
import { createHarness } from "./helpers/harness.ts";

function errorOf(body: unknown) {
	return (body as { error: { code: string; details: Record<string, unknown> } })
		.error;
}

/** Flips one character of the CRC part: well-formed shape, wrong checksum. */
function breakCrc(secret: string): string {
	const last = secret.at(-1) === "A" ? "B" : "A";
	return secret.slice(0, -1) + last;
}

describe("public listener without credentials", () => {
	it("no Authorization: 401 unauthorized with WWW-Authenticate", async () => {
		const h = createHarness();
		h.app.get("/v1/__test/private", (c) => c.body(null, 204));
		const r = await h.request("GET", "/v1/__test/private");
		expect(r.status).toBe(401);
		expect(errorOf(r.body).code).toBe("unauthorized");
		expect(r.headers.get("www-authenticate")).toBe('Bearer realm="sbx"');
	});

	it("X-Auth-Request-Email without a bearer is ignored: 401", async () => {
		const h = createHarness();
		h.app.get("/v1/__test/private", (c) => c.body(null, 204));
		const r = await h.request("GET", "/v1/__test/private", {
			headers: {
				"x-auth-request-email": "admin@example.com",
				"x-auth-request-user": "sub-admin",
				"x-forwarded-email": "admin@example.com",
				"x-forwarded-user": "admin",
			},
		});
		expect(r.status).toBe(401);
	});

	for (const [name, value] of [
		["reserved sandbox key sbxs_", `Bearer sbxs_${"a".repeat(49)}`],
		["port token sbxp_", `Bearer sbxp_${"a".repeat(43)}`],
		["garbage", "Bearer not-a-token"],
		[
			"alg none (empty signature)",
			"Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.",
		],
		["basic auth", "Basic dXNlcjpwYXNz"],
		["empty bearer", "Bearer "],
	] as const) {
		it(`${name}: 401 unauthorized, invalid_token`, async () => {
			const h = createHarness();
			h.app.get("/v1/__test/private", (c) => c.body(null, 204));
			const r = await h.request("GET", "/v1/__test/private", {
				headers: { authorization: value },
			});
			expect(r.status).toBe(401);
			expect(errorOf(r.body).code).toBe("unauthorized");
			expect(r.headers.get("www-authenticate")).toMatch(/^Bearer realm="sbx"/);
		});
	}

	it("anonymous routes stay anonymous, unknown paths stay 404", async () => {
		const h = createHarness();
		expect((await h.request("GET", "/v1/meta")).status).toBe(200);
		expect((await h.request("GET", "/v1/openapi.json")).status).toBe(200);
		expect((await h.request("GET", "/v1/nope")).status).toBe(404);
	});

	it("proxy identity headers are removed on a real @hono/node-server socket", async () => {
		const h = createHarness();
		h.app.get("/v1/__test/headers", (c) =>
			c.body(null, 204, {
				"x-seen": c.req.header("x-auth-request-email") ?? "none",
			}),
		);
		const server = serve({
			fetch: h.app.fetch,
			port: 0,
			hostname: "127.0.0.1",
		});
		await new Promise<void>((r) => server.once("listening", () => r()));
		try {
			const port = (server.address() as AddressInfo).port;
			const res = await fetch(`http://127.0.0.1:${port}/v1/__test/headers`, {
				headers: {
					authorization: `Bearer ${TEST_API_KEY}`,
					"x-auth-request-email": "admin@example.com",
				},
			});
			expect(res.status).toBe(204);
			expect(res.headers.get("x-seen")).toBe("none");
		} finally {
			await new Promise((r) => server.close(r));
		}
	});

	it("routes registered with app.all or a wildcard path are authenticated too", async () => {
		const h = createHarness();
		h.app.all("/v1/__test/all", (c) => c.body(null, 204));
		h.app.get("/v1/__test/wild/*", (c) => c.body(null, 204));
		expect((await h.request("GET", "/v1/__test/all")).status).toBe(401);
		expect((await h.request("GET", "/v1/__test/wild/x/y")).status).toBe(401);
	});

	it("an invalid bearer with a malformed Sbx-Team: 401, not 400", async () => {
		const h = createHarness();
		h.app.get("/v1/__test/private", (c) => c.body(null, 204));
		const r = await h.request("GET", "/v1/__test/private", {
			headers: { authorization: "Bearer junk", "sbx-team": "nope" },
		});
		expect(r.status).toBe(401);
	});

	it("a JWT without SBX_OIDC_ISSUER: 401", async () => {
		const h = createHarness();
		h.app.get("/v1/__test/private", (c) => c.body(null, 204));
		const r = await h.request("GET", "/v1/__test/private", {
			headers: { authorization: "Bearer aaa.bbb.ccc" },
		});
		expect(r.status).toBe(401);
		expect(errorOf(r.body)).toMatchObject({
			code: "unauthorized",
			details: { reason: "invalid_token" },
		});
		expect(r.headers.get("www-authenticate")).toBe(
			'Bearer realm="sbx", error="invalid_token"',
		);
	});
});

describe.skipIf(skipPg())("team API keys", () => {
	let w: IdentityWorld;
	let teamId: string;

	beforeAll(async () => {
		w = await identityWorld();
		teamId = await w.team();
	});
	afterAll(async () => {
		await w?.close();
	});

	function harness() {
		return createHarness({
			deps: { pool: w.db.pool, identity: w.identity, identityEvents: w.events },
		});
	}

	it("a valid key: GET /v1/me describes the key", async () => {
		const { secret, key } = await issueApiKey(w.identity, {
			teamId,
			scopes: [...PRESETS.ci],
		});
		const h = harness();
		const r = await h.request("GET", "/v1/me", {
			headers: { authorization: `Bearer ${secret}` },
		});
		expect(r.status).toBe(200);
		const team = await w.identity.team(teamId);
		expect(r.body).toEqual({
			user: null,
			team: { id: encodeUuid("team", teamId), name: team?.name, role: null },
			teams: [{ id: encodeUuid("team", teamId), name: team?.name, role: null }],
			isOperator: false,
			auth: {
				kind: "team_key",
				apiKeyId: encodeUuid("apiKey", key.id),
				scopes: [...PRESETS.ci],
				expiresAt: key.expiresAt.toISOString(),
				createdBy: null,
			},
		});
	});

	it("X-Auth-Request-* and X-Forwarded-User/Email are removed before handlers", async () => {
		const { secret } = await issueApiKey(w.identity, { teamId });
		const h = harness();
		h.app.get("/v1/__test/headers", (c) => {
			const seen = [
				"x-auth-request-email",
				"x-auth-request-user",
				"x-auth-request-groups",
				"x-forwarded-user",
				"x-forwarded-email",
			].filter((n) => c.req.header(n) !== undefined);
			return c.body(null, 204, { "x-seen": seen.join(",") || "none" });
		});
		const r = await h.request("GET", "/v1/__test/headers", {
			headers: {
				authorization: `Bearer ${secret}`,
				"x-auth-request-email": "admin@example.com",
				"x-auth-request-user": "sub",
				"x-auth-request-groups": "sbx-operators",
				"x-forwarded-user": "admin",
				"x-forwarded-email": "admin@example.com",
			},
		});
		expect(r.status).toBe(204);
		expect(r.headers.get("x-seen")).toBe("none");
	});

	it("a revoked key stops working within 1 s of NOTIFY (cache flushed)", async () => {
		const { secret, key } = await issueApiKey(w.identity, { teamId });
		const h = harness();
		const call = () =>
			h.request("GET", "/v1/me", {
				headers: { authorization: `Bearer ${secret}` },
			});
		expect((await call()).status).toBe(200);
		// Cached now: the positive TTL (30 s) would keep it alive without NOTIFY.
		await w.identity.revokeApiKey(key.id, {});
		const ms = await eventually(async () => (await call()).status === 401);
		expect(ms).toBeLessThanOrEqual(1000);
		const r = await call();
		expect(errorOf(r.body).code).toBe("unauthorized");
	});

	it("an expired key: 401 api_key_expired", async () => {
		const { secret } = await issueApiKey(w.identity, {
			teamId,
			expiresAt: new Date(Date.now() - 1000),
		});
		const r = await harness().request("GET", "/v1/me", {
			headers: { authorization: `Bearer ${secret}` },
		});
		expect(r.status).toBe(401);
		expect(errorOf(r.body).code).toBe("api_key_expired");
	});

	it("a broken CRC: 401 without a store lookup", async () => {
		const { secret } = await issueApiKey(w.identity, { teamId });
		const spy = vi.spyOn(w.identity, "findApiKeyByHash");
		try {
			const r = await harness().request("GET", "/v1/me", {
				headers: { authorization: `Bearer ${breakCrc(secret)}` },
			});
			expect(r.status).toBe(401);
			expect(errorOf(r.body).code).toBe("unauthorized");
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("an unknown key is cached negatively; a new key clears it at once", async () => {
		const secret = generateApiKeySecret();
		const h = harness();
		const spy = vi.spyOn(w.identity, "findApiKeyByHash");
		try {
			const call = () =>
				h.request("GET", "/v1/me", {
					headers: { authorization: `Bearer ${secret}` },
				});
			expect((await call()).status).toBe(401);
			expect((await call()).status).toBe(401);
			expect(spy).toHaveBeenCalledTimes(1);
			// The key appears (NOTIFY api-keys:<id>): the negative entry goes.
			await w.identity.createApiKey({
				teamId,
				name: "late",
				scopes: ["sandboxes:read"],
				expiresAt: new Date(Date.now() + 86_400_000),
				createdByUserId: null,
				createdVia: "api",
				secretHash: apiKeyHash(secret),
				prefix: secret.slice(4, 12),
				last4: secret.slice(-4),
			});
			await eventually(async () => (await call()).status === 200);
		} finally {
			spy.mockRestore();
		}
	});

	it("lastUsedAt is touched at most once per 60 s", async () => {
		const { secret } = await issueApiKey(w.identity, { teamId });
		const spy = vi.spyOn(w.identity, "touchApiKey");
		try {
			const h = harness();
			for (let i = 0; i < 3; i++) {
				await h.request("GET", "/v1/me", {
					headers: { authorization: `Bearer ${secret}` },
				});
			}
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("Sbx-Team: own team ok, another team 403 team_forbidden, garbage 400", async () => {
		const { secret } = await issueApiKey(w.identity, { teamId });
		const other = await w.team();
		const h = harness();
		const call = (team: string) =>
			h.request("GET", "/v1/me", {
				headers: { authorization: `Bearer ${secret}`, "sbx-team": team },
			});
		expect((await call(encodeUuid("team", teamId))).status).toBe(200);
		const r = await call(encodeUuid("team", other));
		expect(r.status).toBe(403);
		expect(errorOf(r.body).code).toBe("team_forbidden");
		const g = await call("team-x");
		expect(g.status).toBe(400);
		expect(errorOf(g.body).code).toBe("validation");
	});
});

describe.skipIf(skipPg())("/readyz and the sbx_identity listener", () => {
	it("503 until LISTEN is confirmed, 200 after", async () => {
		const w = await identityWorld();
		const dead = IdentityListener.connect("postgres://sbx:sbx@127.0.0.1:1/x", {
			reconnectDelayMs: 10_000,
		});
		dead.start();
		try {
			const bad = createHarness({
				listener: "ops",
				deps: { identityEvents: dead },
			});
			const r = await bad.request("GET", "/readyz");
			expect(r.status).toBe(503);
			expect(errorOf(r.body).details).toMatchObject({
				reasons: ["identity_listener"],
			});
			const good = createHarness({
				listener: "ops",
				deps: { pool: w.db.pool, identityEvents: w.events },
			});
			expect((await good.request("GET", "/readyz")).status).toBe(200);
		} finally {
			await dead.close();
			await w.close();
		}
	});

	it("a killed LISTEN connection: not ready, then ready again after reconnect", async () => {
		const w = await identityWorld();
		try {
			expect(w.events.isReady()).toBe(true);
			await w.db.pool.query(
				`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
				  WHERE query = 'LISTEN sbx_identity' AND datname = current_database()`,
			);
			await eventually(async () => !w.events.isReady(), 2000);
			await eventually(async () => w.events.isReady(), 3000);
		} finally {
			await w.close();
		}
	});
});
