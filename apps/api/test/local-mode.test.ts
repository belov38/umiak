import type { IncomingMessage } from "node:http";
import { LOCAL_USER_SUB } from "@umiak/auth";
import { describe, expect, it } from "vitest";
import { createProxiedApp, createPublicApp } from "../src/app.ts";
import {
	makeTestDeps,
	TEST_API_KEY,
	TEST_TEAM_ID,
	testIdentityStore,
	testSettings,
} from "../src/testing/index.ts";

function setup(
	listener: "public" | "proxied" = "public",
	cidrs?: string,
	trusted = "",
	hosts = "",
) {
	const settings = testSettings({
		UMIAK_AUTH_MODE: "none",
		...(cidrs === undefined ? {} : { UMIAK_LOCAL_ALLOWED_CIDRS: cidrs }),
		UMIAK_API_TRUSTED_PROXY_CIDRS: trusted,
		UMIAK_LOCAL_ALLOWED_HOSTS: hosts,
	});
	const identity = testIdentityStore({
		sessions: [
			{
				sub: LOCAL_USER_SUB,
				isOperator: true,
				teams: [
					{ teamId: TEST_TEAM_ID, name: "Local", role: "owner" },
					{
						teamId: "00000000-0000-7000-8000-000000000002",
						name: "Second",
						role: "owner",
					},
				],
			},
		],
	});
	const deps = makeTestDeps({ settings, identity });
	const app =
		listener === "public" ? createPublicApp(deps) : createProxiedApp(deps);
	function request(
		path = "/v1/me",
		peer = "192.168.1.2",
		headers: Record<string, string> = {},
		method = "GET",
	) {
		return app.request(
			path,
			{ method, headers: { host: new URL(settings.apiUrl).host, ...headers } },
			{ incoming: { socket: { remoteAddress: peer } } as IncomingMessage },
		);
	}
	return { request, settings };
}

describe("local API", () => {
	for (const listener of ["public", "proxied"] as const) {
		it(`${listener}: unauthenticated local owner/operator, forged identity ignored`, async () => {
			const { request } = setup(listener);
			const res = await request(undefined, undefined, {
				"x-auth-request-email": "attacker@example.com",
				"x-auth-request-user": "attacker",
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(JSON.stringify(body)).not.toContain("attacker");
			expect(JSON.stringify(body)).toContain("owner");
		});
		it(`${listener}: denies outside networks even on metadata, ignores spoofed XFF`, async () => {
			const { request } = setup(listener);
			expect(
				(
					await request("/v1/meta", "8.8.8.8", {
						"x-forwarded-for": "127.0.0.1",
					})
				).status,
			).toBe(403);
		});
	}
	it("uses trusted proxy chain and replaces defaults", async () => {
		const { request } = setup("public", "192.168.4.0/24", "10.0.0.0/8");
		expect(
			(
				await request("/v1/meta", "10.0.0.1", {
					"x-forwarded-for": "192.168.4.10",
				})
			).status,
		).toBe(200);
		expect(
			(
				await request("/v1/meta", "10.0.0.1", {
					"x-forwarded-for": "127.0.0.1,8.8.8.8",
				})
			).status,
		).toBe(403);
	});
	it("rejects arbitrary Host even on a same-origin GET without Origin", async () => {
		const { request } = setup();
		expect(
			(await request("/v1/me", undefined, { host: "evil.example" })).status,
		).toBe(403);
		expect((await request("/v1/meta", undefined, { host: "" })).status).toBe(
			403,
		);
	});
	it("accepts configured API, app and explicitly allowed internal authorities", async () => {
		const { request, settings } = setup("public", undefined, "", "api:8080");
		for (const host of [
			new URL(settings.apiUrl).host,
			new URL(settings.appOrigin).host,
			"api:8080",
		])
			expect((await request("/v1/meta", undefined, { host })).status).toBe(200);
		expect(
			(await request("/v1/meta", undefined, { host: "api:8081" })).status,
		).toBe(403);
		expect(() =>
			testSettings({ UMIAK_LOCAL_ALLOWED_HOSTS: "trusted@evil.example" }),
		).toThrow();
	});

	it("advertises none and suppresses OIDC", async () => {
		const { request, settings } = setup();
		expect(settings.oidc).toBeNull();
		expect(await (await request("/v1/meta")).json()).toMatchObject({
			authMode: "none",
			tenancy: "single",
			oidc: null,
		});
	});
	it("rejects browser cross-origin calls and form writes", async () => {
		const { request } = setup();
		expect(
			(await request(undefined, undefined, { origin: "http://evil.invalid" }))
				.status,
		).toBe(403);
		expect(
			(
				await request(
					"/v1/sandboxes",
					undefined,
					{ "content-type": "text/plain" },
					"POST",
				)
			).status,
		).toBe(403);
	});
	it("team API keys keep their scoped key identity in none mode", async () => {
		const deps = makeTestDeps({
			settings: testSettings({ UMIAK_AUTH_MODE: "none" }),
		});
		const r = await createPublicApp(deps).request(
			"/v1/me",
			{
				headers: {
					authorization: `Bearer ${TEST_API_KEY}`,
					host: new URL(deps.settings.apiUrl).host,
				},
			},
			{
				incoming: { socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage,
			},
		);
		expect(r.status).toBe(200);
		expect(await r.json()).toMatchObject({ auth: { kind: "team_key" } });
	});

	it("does not turn invalid bearer credentials into local authority", async () => {
		expect(
			(
				await setup().request(undefined, undefined, {
					authorization: "Bearer garbage",
				})
			).status,
		).toBe(401);
	});
});

it("local public GET honors team query and rejects conflicting header", async () => {
	const { request } = setup();
	const { encodeUuid } = await import("@umiak/auth");
	const team = encodeUuid("team", "00000000-0000-7000-8000-000000000002");
	const res = await request(`/v1/me?team=${team}`);
	expect(res.status).toBe(200);
	expect((await res.json()).team.id).toBe(team);
	expect(
		(
			await request(`/v1/me?team=${team}`, undefined, {
				"umiak-team": "team_00000000000000000000000000",
			})
		).status,
	).toBe(400);
});
