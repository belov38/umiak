// Proxied listener (oauth2-proxy, S7 §7.4, S8 §5.2, C4, C6).
import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { encodeUuid } from "@sbx/auth";
import { skipPg } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseGroups } from "../src/auth/proxied.ts";
import { ERROR_RESPONSES, jsonBody } from "../src/index.ts";
import { testSettings } from "../src/testing/index.ts";
import {
	type IdentityWorld,
	identityWorld,
	OPERATOR_GROUP,
	uniqueEmail,
} from "./helpers/auth.ts";
import { createHarness } from "./helpers/harness.ts";

const APP_ORIGIN = "https://app.sbx.test";

function errorOf(body: unknown) {
	return (body as { error: { code: string; details: Record<string, unknown> } })
		.error;
}

describe("parseGroups", () => {
	it("splits, trims, dedups and drops the role:<name> entries of keycloak-oidc", () => {
		expect(
			parseGroups(" devs, role:offline_access,,sbx-operators,role:a:b,devs"),
		).toEqual(["devs", "sbx-operators"]);
		expect(parseGroups(undefined)).toEqual([]);
	});
});

describe("proxied listener without Postgres", () => {
	it("no X-Auth-Request-Email: 401", async () => {
		const h = createHarness({ listener: "proxied" });
		h.app.get("/v1/__test/private", (c) => c.body(null, 204));
		const r = await h.request("GET", "/v1/__test/private");
		expect(r.status).toBe(401);
		expect(errorOf(r.body).code).toBe("unauthorized");
	});

	it("Tailscale-User-* (set by Tailscale Serve) is not an identity: 401", async () => {
		const h = createHarness({ listener: "proxied" });
		h.app.get("/v1/__test/private", (c) => c.body(null, 204));
		const r = await h.request("GET", "/v1/__test/private", {
			headers: {
				"tailscale-user-login": "admin@example.com",
				"tailscale-user-name": "Admin",
			},
		});
		expect(r.status).toBe(401);
		expect(errorOf(r.body).code).toBe("unauthorized");
	});

	it("Authorization on the proxied host: 400 validation", async () => {
		const h = createHarness({ listener: "proxied" });
		h.app.get("/v1/__test/private", (c) => c.body(null, 204));
		const r = await h.request("GET", "/v1/__test/private", {
			headers: {
				authorization: "Bearer sbx_x",
				"x-auth-request-email": "a@example.com",
				"x-auth-request-user": "sub-a",
			},
		});
		expect(r.status).toBe(400);
		expect(errorOf(r.body).code).toBe("validation");
	});

	it("meta stays anonymous", async () => {
		const h = createHarness({ listener: "proxied" });
		expect((await h.request("GET", "/v1/meta")).status).toBe(200);
	});
});

describe.skipIf(skipPg())("proxied listener", () => {
	let w: IdentityWorld;

	beforeAll(async () => {
		w = await identityWorld();
	});
	afterAll(async () => {
		await w?.close();
	});

	function harness() {
		const h = createHarness({
			listener: "proxied",
			deps: {
				settings: testSettings({ SBX_OPERATOR_GROUPS: OPERATOR_GROUP }),
				pool: w.db.pool,
				identity: w.identity,
				identityEvents: w.events,
			},
		});
		h.app.post("/v1/__test/action", (c) => c.body(null, 204));
		h.app.get("/v1/__test/socket", (c) => c.body(null, 204));
		h.app.openapi(
			createRoute({
				method: "post",
				path: "/v1/__test/json",
				request: {
					body: jsonBody(z.strictObject({ a: z.string() }), "test"),
				},
				responses: { 204: { description: "ok" }, ...ERROR_RESPONSES },
			}),
			(c) => c.body(null, 204),
		);
		return h;
	}

	function person(groups: string[] = []) {
		const sub = randomUUID();
		const email = uniqueEmail();
		return {
			sub,
			email,
			headers: {
				"x-auth-request-email": email,
				"x-auth-request-user": sub,
				"x-auth-request-groups": groups.join(","),
			} as Record<string, string>,
		};
	}

	it("GET /v1/me: kind session with the default (personal) team", async () => {
		const p = person();
		const r = await harness().request("GET", "/v1/me", { headers: p.headers });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({
			user: { email: p.email },
			team: { role: "owner" },
			isOperator: false,
			auth: { kind: "session" },
		});
		expect((r.body as { auth: object }).auth).not.toHaveProperty("expiresAt");
	});

	it("no X-Auth-Request-User (sub): 401", async () => {
		const p = person();
		const r = await harness().request("GET", "/v1/me", {
			headers: { "x-auth-request-email": p.email },
		});
		expect(r.status).toBe(401);
	});

	it("POST without Origin or with a foreign Origin: 403 origin_forbidden", async () => {
		const p = person();
		const h = harness();
		const none = await h.request("POST", "/v1/__test/action", {
			headers: p.headers,
		});
		expect(none.status).toBe(403);
		expect(errorOf(none.body).code).toBe("origin_forbidden");
		const foreign = await h.request("POST", "/v1/__test/action", {
			headers: { ...p.headers, origin: "https://evil.example.com" },
		});
		expect(foreign.status).toBe(403);
		expect(errorOf(foreign.body).code).toBe("origin_forbidden");
		const ok = await h.request("POST", "/v1/__test/action", {
			headers: { ...p.headers, origin: APP_ORIGIN },
		});
		expect(ok.status).toBe(204);
	});

	it("WebSocket upgrade with a foreign Origin: 403; GET without upgrade needs none", async () => {
		const p = person();
		const h = harness();
		const up = await h.request("GET", "/v1/__test/socket", {
			headers: {
				...p.headers,
				upgrade: "websocket",
				connection: "Upgrade",
				origin: "https://evil.example.com",
			},
		});
		expect(up.status).toBe(403);
		expect(errorOf(up.body).code).toBe("origin_forbidden");
		const plain = await h.request("GET", "/v1/__test/socket", {
			headers: p.headers,
		});
		expect(plain.status).toBe(204);
	});

	it("a form content type on an unsafe request: 400 validation", async () => {
		const p = person();
		const h = harness();
		for (const type of [
			"text/plain",
			"application/x-www-form-urlencoded",
			"multipart/form-data; boundary=x",
		]) {
			const r = await h.request("POST", "/v1/__test/json", {
				headers: { ...p.headers, origin: APP_ORIGIN, "content-type": type },
				body: JSON.stringify({ a: "x" }),
			});
			expect(r.status).toBe(400);
			expect(errorOf(r.body).code).toBe("validation");
		}
		const ok = await h.request("POST", "/v1/__test/json", {
			headers: { ...p.headers, origin: APP_ORIGIN },
			json: { a: "x" },
		});
		expect(ok.status).toBe(204);
	});

	it("?team= on GET selects the team; a mismatch with Sbx-Team: 400; on POST: 400", async () => {
		const p = person();
		const h = harness();
		const first = await h.request("GET", "/v1/me", { headers: p.headers });
		const own = (first.body as { team: { id: string } }).team.id;
		const q = await h.request("GET", `/v1/me?team=${own}`, {
			headers: p.headers,
		});
		expect(q.status).toBe(200);
		const other = encodeUuid("team", await w.team());
		const mismatch = await h.request("GET", `/v1/me?team=${own}`, {
			headers: { ...p.headers, "sbx-team": other },
		});
		expect(mismatch.status).toBe(400);
		expect(errorOf(mismatch.body).code).toBe("validation");
		const post = await h.request("POST", `/v1/__test/action?team=${own}`, {
			headers: { ...p.headers, origin: APP_ORIGIN },
		});
		expect(post.status).toBe(400);
	});

	it("a team outside the user's teams: 403 team_forbidden", async () => {
		const p = person();
		const other = encodeUuid("team", await w.team());
		const r = await harness().request("GET", `/v1/me?team=${other}`, {
			headers: p.headers,
		});
		expect(r.status).toBe(403);
		expect(errorOf(r.body).code).toBe("team_forbidden");
	});

	it("an operator may pick any team (role null); groups are parsed from a list", async () => {
		const p = person([]);
		p.headers["x-auth-request-groups"] = ` other, ${OPERATOR_GROUP},,other`;
		const teamId = await w.team();
		const r = await harness().request("GET", "/v1/me", {
			headers: { ...p.headers, "sbx-team": encodeUuid("team", teamId) },
		});
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({
			isOperator: true,
			team: { id: encodeUuid("team", teamId), role: null },
		});
	});

	it("an operator naming a team that does not exist: 403 team_forbidden", async () => {
		const p = person([OPERATOR_GROUP]);
		const r = await harness().request("GET", "/v1/me", {
			headers: { ...p.headers, "sbx-team": encodeUuid("team", randomUUID()) },
		});
		expect(r.status).toBe(403);
		expect(errorOf(r.body).code).toBe("team_forbidden");
	});
});
