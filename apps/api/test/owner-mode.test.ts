import type { IncomingMessage } from "node:http";
import { OWNER_USER_SUB } from "@umiak/auth";
import { describe, expect, it } from "vitest";
import { createProxiedApp, createPublicApp } from "../src/app.ts";
import {
	makeTestDeps,
	TEST_API_KEY,
	TEST_TEAM_ID,
	testIdentityStore,
	testSettings,
} from "../src/testing/index.ts";

const INGRESS = "172.29.116.10";

function setup(
	listener: "public" | "proxied" = "public",
	cidrs = "127.0.0.0/8,::1/128,172.29.116.0/24",
	trusted = "",
) {
	const settings = testSettings({
		UMIAK_AUTH_MODE: "owner",
		UMIAK_LOCAL_ALLOWED_CIDRS: cidrs,
		UMIAK_API_TRUSTED_PROXY_CIDRS: trusted,
	});
	const identity = testIdentityStore({
		sessions: [
			{
				sub: OWNER_USER_SUB,
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
		peer = INGRESS,
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

describe("owner API", () => {
	for (const listener of ["public", "proxied"] as const) {
		it(`${listener}: the ingress peer authenticates as the owner, forged identity ignored`, async () => {
			const { request } = setup(listener);
			const res = await request(undefined, INGRESS, {
				"x-umiak-client-ip": "100.64.10.20",
				"x-auth-request-email": "attacker@example.com",
				"x-auth-request-user": "attacker",
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(JSON.stringify(body)).not.toContain("attacker");
			expect(JSON.stringify(body)).toContain("umiak:local");
		});
		it(`${listener}: rejects peers outside the ingress network even on metadata, ignores spoofed XFF`, async () => {
			const { request } = setup(listener);
			const res = await request("/v1/meta", "192.168.1.5", {
				"x-forwarded-for": "127.0.0.1",
				"x-umiak-client-ip": "172.29.116.10",
			});
			expect(res.status).toBe(403);
			expect(await res.text()).toContain("ingress_required");
		});
	}
	it("checks the socket peer, not the forwarded client address", async () => {
		const trusted = setup("public", undefined, "172.29.116.0/24");
		expect(
			(
				await trusted.request("/v1/meta", INGRESS, {
					"x-forwarded-for": "100.64.10.20",
					"x-umiak-client-ip": "100.64.10.20",
				})
			).status,
		).toBe(200);
		const outsider = setup("public");
		expect(
			(
				await outsider.request("/v1/meta", "192.168.1.5", {
					"x-forwarded-for": INGRESS,
				})
			).status,
		).toBe(403);
	});
	it("requires the ingress allowlist to be configured", () => {
		expect(() => testSettings({ UMIAK_AUTH_MODE: "owner" })).toThrow(
			/UMIAK_LOCAL_ALLOWED_CIDRS/,
		);
		expect(() =>
			testSettings({
				UMIAK_AUTH_MODE: "none",
				UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8",
			}),
		).toThrow(/UMIAK_AUTH_MODE must be oidc or owner/);
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
	it("accepts the configured API and app authorities", async () => {
		const { request, settings } = setup();
		for (const host of [
			new URL(settings.apiUrl).host,
			new URL(settings.appOrigin).host,
		])
			expect((await request("/v1/meta", undefined, { host })).status).toBe(200);
	});

	it("advertises owner, single tenancy and suppresses OIDC", async () => {
		const { request, settings } = setup();
		expect(settings.oidc).toBeNull();
		expect(await (await request("/v1/meta")).json()).toMatchObject({
			authMode: "owner",
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
	it("team API keys keep their scoped key identity in owner mode", async () => {
		const deps = makeTestDeps({
			settings: testSettings({
				UMIAK_AUTH_MODE: "owner",
				UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8",
			}),
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

	it("does not turn invalid bearer credentials into owner authority", async () => {
		expect(
			(
				await setup().request(undefined, undefined, {
					authorization: "Bearer garbage",
				})
			).status,
		).toBe(401);
	});
});

it("owner public GET honors team query and rejects conflicting header", async () => {
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
