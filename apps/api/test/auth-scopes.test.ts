// Route guards: requireScope, requireHuman, requireOwner (S7 §7.3, §7.5).
import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { generateApiKeySecret, type Scope } from "@sbx/auth";
import { describe, expect, it } from "vitest";
import {
	ERROR_RESPONSES,
	jsonBody,
	requireHuman,
	requireOwner,
	requireScope,
} from "../src/index.ts";
import { testIdentityStore } from "../src/testing/index.ts";
import { createHarness } from "./helpers/harness.ts";

function errorOf(body: unknown) {
	return (body as { error: { code: string; details: Record<string, unknown> } })
		.error;
}

const TEAM = randomUUID();
const READER = generateApiKeySecret();
const WRITER = generateApiKeySecret();

function harness(listener: "public" | "proxied" = "public") {
	const identity = testIdentityStore({
		keys: [
			{ secret: READER, teamId: TEAM, scopes: ["files:read"] },
			{ secret: WRITER, teamId: TEAM, scopes: ["files:read", "files:write"] },
		],
		sessions: [
			{ sub: "owner", teams: [{ teamId: TEAM, name: "t", role: "owner" }] },
			{ sub: "member", teams: [{ teamId: TEAM, name: "t", role: "member" }] },
		],
	});
	const h = createHarness({ listener, deps: { identity } });
	h.app.get("/v1/__test/write", requireScope("files:write"), (c) =>
		c.body(null, 204),
	);
	h.app.get("/v1/__test/human", requireHuman(), (c) => c.body(null, 204));
	h.app.get("/v1/__test/owner", requireOwner(), (c) => c.body(null, 204));
	h.app.openapi(
		createRoute({
			method: "post",
			path: "/v1/__test/validated",
			middleware: [requireScope("files:write" satisfies Scope)],
			request: { body: jsonBody(z.strictObject({ a: z.string() }), "t") },
			responses: { 204: { description: "ok" }, ...ERROR_RESPONSES },
		}),
		(c) => c.body(null, 204),
	);
	return h;
}

const key = (secret: string) => ({ authorization: `Bearer ${secret}` });
const session = (sub: string) => ({
	"x-auth-request-email": `${sub}@example.com`,
	"x-auth-request-user": sub,
});

describe("requireScope", () => {
	it("a key without the scope: 403 forbidden with details.requiredScope", async () => {
		const r = await harness().request("GET", "/v1/__test/write", {
			headers: key(READER),
		});
		expect(r.status).toBe(403);
		expect(errorOf(r.body)).toMatchObject({
			code: "forbidden",
			details: { requiredScope: "files:write" },
		});
	});

	it("a key with the scope passes", async () => {
		const r = await harness().request("GET", "/v1/__test/write", {
			headers: key(WRITER),
		});
		expect(r.status).toBe(204);
	});

	it("is checked before body validation (403, not 400)", async () => {
		const r = await harness().request("POST", "/v1/__test/validated", {
			headers: key(READER),
			json: { wrong: 1 },
		});
		expect(r.status).toBe(403);
	});

	it("a person has every scope", async () => {
		const r = await harness("proxied").request("GET", "/v1/__test/write", {
			headers: session("member"),
		});
		expect(r.status).toBe(204);
	});
});

describe("requireHuman and requireOwner", () => {
	it("a team key: 403 user_required on both", async () => {
		const h = harness();
		for (const path of ["/v1/__test/human", "/v1/__test/owner"]) {
			const r = await h.request("GET", path, { headers: key(WRITER) });
			expect(r.status).toBe(403);
			expect(errorOf(r.body)).toMatchObject({
				code: "forbidden",
				details: { reason: "user_required" },
			});
		}
	});

	it("a member: human ok, owner 403 role", async () => {
		const h = harness("proxied");
		expect(
			(
				await h.request("GET", "/v1/__test/human", {
					headers: session("member"),
				})
			).status,
		).toBe(204);
		const r = await h.request("GET", "/v1/__test/owner", {
			headers: session("member"),
		});
		expect(r.status).toBe(403);
		expect(errorOf(r.body)).toMatchObject({
			code: "forbidden",
			details: { reason: "role" },
		});
	});

	it("an owner passes", async () => {
		const r = await harness("proxied").request("GET", "/v1/__test/owner", {
			headers: session("owner"),
		});
		expect(r.status).toBe(204);
	});
});
