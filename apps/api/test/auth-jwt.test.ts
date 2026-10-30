// Keycloak access tokens on the public listener (S7 §7.10, §16 "Keycloak
// JWT"), verified against the test OIDC server's JWKS.
import { randomUUID } from "node:crypto";
import { encodeUuid } from "@sbx/auth";
import { skipPg } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OidcSettings, OidcVerifier } from "../src/index.ts";
import {
	startTestOidcServer,
	type TestOidcServer,
	testSettings,
} from "../src/testing/index.ts";
import {
	eventually,
	type IdentityWorld,
	identityWorld,
	OPERATOR_GROUP,
	uniqueEmail,
} from "./helpers/auth.ts";
import { createHarness } from "./helpers/harness.ts";

function errorOf(body: unknown) {
	return (body as { error: { code: string; details: Record<string, unknown> } })
		.error;
}

describe.skipIf(skipPg())("Keycloak JWT", () => {
	let w: IdentityWorld;
	let oidc: TestOidcServer;

	beforeAll(async () => {
		w = await identityWorld();
		oidc = await startTestOidcServer();
	});
	afterAll(async () => {
		await oidc?.close();
		await w?.close();
	});

	function harness(listener: "public" | "proxied" = "public") {
		return createHarness({
			listener,
			deps: {
				settings: testSettings({
					SBX_OIDC_ISSUER: oidc.issuer,
					SBX_OPERATOR_GROUPS: OPERATOR_GROUP,
				}),
				pool: w.db.pool,
				identity: w.identity,
				identityEvents: w.events,
			},
		});
	}

	function person() {
		return { sub: randomUUID(), email: uniqueEmail() };
	}

	async function me(
		h: ReturnType<typeof harness>,
		token: string,
		headers: Record<string, string> = {},
	) {
		return h.request("GET", "/v1/me", {
			headers: { authorization: `Bearer ${token}`, ...headers },
		});
	}

	it("a valid token: JIT user, kind oidc, all scopes, no operator rights", async () => {
		const p = person();
		const token = await oidc.token({ ...p, groups: [OPERATOR_GROUP] });
		const r = await me(harness(), token);
		expect(r.status).toBe(200);
		const body = r.body as {
			user: { id: string; email: string };
			team: { id: string; role: string };
			isOperator: boolean;
			auth: { kind: string; scopes: string[]; expiresAt: string };
		};
		expect(body.user.email).toBe(p.email);
		expect(body.user.id).toMatch(/^usr_/);
		expect(body.team.role).toBe("owner");
		// C6: operator rights only in a browser session.
		expect(body.isOperator).toBe(false);
		expect(body.auth.kind).toBe("oidc");
		expect(body.auth.scopes).toContain("keys:admin");
		expect(Date.parse(body.auth.expiresAt)).toBeGreaterThan(Date.now());
	});

	const rejected: [string, () => Promise<string>][] = [
		[
			"a foreign iss",
			() =>
				oidc.token({ ...person(), iss: "https://evil.example.com/realms/sbx" }),
		],
		["no aud", () => oidc.token({ ...person(), aud: undefined })],
		["another aud", () => oidc.token({ ...person(), aud: "account" })],
		["alg none", () => oidc.token(person(), { alg: "none" })],
		["HS256", () => oidc.token(person(), { alg: "HS256" })],
		["an ID token (typ ID)", () => oidc.token(person(), { typ: "ID" })],
		[
			"a refresh token (typ Refresh)",
			() => oidc.token(person(), { typ: "Refresh" }),
		],
		["a foreign azp", () => oidc.token({ ...person(), azp: "oauth2-proxy" })],
		[
			"email_verified false",
			() => oidc.token({ ...person(), email_verified: false }),
		],
		["no sub", () => oidc.token({ ...person(), sub: undefined })],
		["no email", () => oidc.token({ ...person(), email: undefined })],
		[
			"a bad signature",
			async () => `${(await oidc.token(person())).slice(0, -4)}AAAA`,
		],
		[
			"nbf 5 min in the future",
			() =>
				oidc.token({ ...person(), nbf: Math.floor(Date.now() / 1000) + 300 }),
		],
		[
			"iat 5 min in the future",
			() =>
				oidc.token({ ...person(), iat: Math.floor(Date.now() / 1000) + 300 }),
		],
	];
	for (const [name, make] of rejected) {
		it(`${name}: 401 unauthorized invalid_token`, async () => {
			const r = await me(harness(), await make());
			expect(r.status).toBe(401);
			expect(errorOf(r.body)).toMatchObject({
				code: "unauthorized",
				details: { reason: "invalid_token" },
			});
			expect(r.headers.get("www-authenticate")).toBe(
				'Bearer realm="sbx", error="invalid_token"',
			);
		});
	}

	it("an expired token: 401 token_expired; within the 60 s tolerance it passes", async () => {
		const h = harness();
		const r = await me(h, await oidc.token(person(), { expiresIn: -120 }));
		expect(r.status).toBe(401);
		expect(errorOf(r.body).code).toBe("token_expired");
		expect(r.headers.get("www-authenticate")).toBe(
			'Bearer realm="sbx", error="invalid_token"',
		);
		const ok = await me(h, await oidc.token(person(), { expiresIn: -30 }));
		expect(ok.status).toBe(200);
	});

	it("nbf and iat within the 60 s tolerance are accepted", async () => {
		const soon = Math.floor(Date.now() / 1000) + 30;
		const r = await me(
			harness(),
			await oidc.token({ ...person(), nbf: soon, iat: soon }),
		);
		expect(r.status).toBe(200);
	});

	it("Keycloak's JWKS fails: cached keys keep working offline, an unknown kid is 503", async () => {
		const settings = testSettings({ SBX_OIDC_ISSUER: oidc.issuer });
		const h = createHarness({
			deps: {
				settings,
				pool: w.db.pool,
				identity: w.identity,
				identityEvents: w.events,
				oidc: new OidcVerifier(settings.oidc as OidcSettings, {
					jwksMaxAgeMs: 100,
					jwksCooldownMs: 100,
					// Long enough for the checks inside it on a loaded machine;
					// its end is awaited by polling, not by a fixed sleep.
					outageBackoffMs: 3_000,
				}),
			},
		});
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		try {
			expect((await me(h, await oidc.token(person()))).status).toBe(200);
			oidc.fail({ jwks: 503 });
			await sleep(150); // the cached set is stale now
			const before = oidc.stats.jwks;
			expect((await me(h, await oidc.token(person()))).status).toBe(200);
			expect(oidc.stats.jwks).toBe(before + 1); // one failed fetch
			// Inside the backoff Keycloak is not asked again.
			expect((await me(h, await oidc.token(person()))).status).toBe(200);
			expect(oidc.stats.jwks).toBe(before + 1);
			oidc.rotateKey();
			const unknown = await me(h, await oidc.token(person()));
			expect(unknown.status).toBe(503);
			expect(errorOf(unknown.body)).toMatchObject({
				code: "idp_unavailable",
				retryable: true,
			});
			oidc.fail({ jwks: null });
			// Backoff over: the new key is fetched.
			await eventually(
				async () => (await me(h, await oidc.token(person()))).status === 200,
				15_000,
			);
		} finally {
			oidc.fail({ jwks: null });
		}
	});

	it("a JWKS failure before any key was fetched does not start the outage backoff", async () => {
		const other = await startTestOidcServer();
		const settings = testSettings({ SBX_OIDC_ISSUER: other.issuer });
		const h = createHarness({
			deps: {
				settings,
				pool: w.db.pool,
				identity: w.identity,
				identityEvents: w.events,
				oidc: new OidcVerifier(settings.oidc as OidcSettings, {
					outageBackoffMs: 60_000,
				}),
			},
		});
		try {
			other.fail({ jwks: 503 });
			const token = await other.token(person());
			expect((await me(h, token)).status).toBe(503);
			other.fail({ jwks: null });
			// No cached keys to verify with: the next request asks Keycloak again.
			expect((await me(h, token)).status).toBe(200);
		} finally {
			await other.close();
		}
	});

	it("a failed discovery is not retried for a short while", async () => {
		const other = await startTestOidcServer();
		const settings = testSettings({ SBX_OIDC_ISSUER: other.issuer });
		const h = createHarness({
			deps: {
				settings,
				pool: w.db.pool,
				identity: w.identity,
				identityEvents: w.events,
				// Long enough for the checks inside it on a loaded machine.
				oidc: new OidcVerifier(settings.oidc as OidcSettings, {
					discoveryRetryMs: 3_000,
				}),
			},
		});
		try {
			other.fail({ discovery: 500 });
			const token = await other.token(person());
			expect((await me(h, token)).status).toBe(503);
			expect((await me(h, token)).status).toBe(503);
			expect(other.stats.discovery).toBe(1);
			other.fail({ discovery: null });
			// Requests inside the window do not fetch; the first one after it does.
			await eventually(async () => (await me(h, token)).status === 200, 15_000);
			expect(other.stats.discovery).toBe(2);
		} finally {
			await other.close();
		}
	});

	it("an ES256 token is accepted", async () => {
		const r = await me(harness(), await oidc.token(person(), { alg: "ES256" }));
		expect(r.status).toBe(200);
	});

	it("an unknown kid re-reads the JWKS once per cooldown", async () => {
		const settings = testSettings({ SBX_OIDC_ISSUER: oidc.issuer });
		const h = createHarness({
			deps: {
				settings,
				pool: w.db.pool,
				identity: w.identity,
				identityEvents: w.events,
				// 30 s in production; shorter here, but long enough for the
				// checks inside it on a loaded machine.
				oidc: new OidcVerifier(settings.oidc as OidcSettings, {
					jwksCooldownMs: 3_000,
				}),
			},
		});
		expect((await me(h, await oidc.token(person()))).status).toBe(200);
		const fetched = oidc.stats.jwks;
		oidc.rotateKey();
		// Inside the cooldown after the first fetch the new kid is unknown.
		expect((await me(h, await oidc.token(person()))).status).toBe(401);
		expect(oidc.stats.jwks).toBe(fetched);
		// After the cooldown the unknown kid re-reads the JWKS, exactly once.
		await eventually(
			async () => (await me(h, await oidc.token(person()))).status === 200,
			15_000,
		);
		expect(oidc.stats.jwks).toBe(fetched + 1);
		// Another unknown kid inside the cooldown: no new fetch, rejected.
		const r = await me(h, await oidc.token(person(), { kid: "no-such-kid" }));
		expect(r.status).toBe(401);
		expect(oidc.stats.jwks).toBe(fetched + 1);
	});

	it("the same sub is the same user as the browser session (X-Auth-Request-User)", async () => {
		const p = person();
		const viaJwt = await me(harness(), await oidc.token(p));
		expect(viaJwt.status).toBe(200);
		const viaProxy = await harness("proxied").request("GET", "/v1/me", {
			headers: {
				"x-auth-request-email": p.email,
				"x-auth-request-user": p.sub,
			},
		});
		expect(viaProxy.status).toBe(200);
		const id = (b: unknown) => (b as { user: { id: string } }).user.id;
		expect(id(viaProxy.body)).toBe(id(viaJwt.body));
	});

	it("a deactivated user with a live token: 403 user_disabled", async () => {
		const p = person();
		const token = await oidc.token(p);
		const h = harness();
		const first = await me(h, token);
		expect(first.status).toBe(200);
		const userId = (first.body as { user: { id: string } }).user.id;
		const r = await w.db.pool.query<{ id: string }>(
			"SELECT id FROM identity.users WHERE idp_subject = $1",
			[p.sub],
		);
		const uuid = r.rows[0]?.id as string;
		expect(encodeUuid("user", uuid)).toBe(userId);
		await w.seed.setActive(uuid, false);
		await eventually(async () => (await me(h, token)).status === 403);
		const denied = await me(h, token);
		expect(errorOf(denied.body)).toMatchObject({
			code: "forbidden",
			details: { reason: "user_disabled" },
		});
	});

	it("a new sub with the email of another account: 403 identity_conflict", async () => {
		const p = person();
		const h = harness();
		expect((await me(h, await oidc.token(p))).status).toBe(200);
		const r = await me(h, await oidc.token({ ...p, sub: randomUUID() }));
		expect(r.status).toBe(403);
		expect(errorOf(r.body)).toMatchObject({
			code: "forbidden",
			details: { reason: "identity_conflict" },
		});
	});

	it("Sbx-Team outside the user's teams: 403 team_forbidden", async () => {
		const other = await w.team();
		const r = await me(harness(), await oidc.token(person()), {
			"sbx-team": encodeUuid("team", other),
		});
		expect(r.status).toBe(403);
		expect(errorOf(r.body).code).toBe("team_forbidden");
	});

	it("Sbx-Team of a team the user belongs to selects it with the role", async () => {
		const p = person();
		const h = harness();
		const first = await me(h, await oidc.token(p));
		const uuid = (
			await w.db.pool.query<{ id: string }>(
				"SELECT id FROM identity.users WHERE idp_subject = $1",
				[p.sub],
			)
		).rows[0]?.id as string;
		const shared = await w.team();
		await w.seed.addMember(uuid, shared, "member");
		await eventually(async () => {
			const r = await me(h, await oidc.token(p), {
				"sbx-team": encodeUuid("team", shared),
			});
			return (
				r.status === 200 &&
				(r.body as { team: { role: string } }).team.role === "member"
			);
		});
		expect(first.status).toBe(200);
	});
});

describe("Keycloak unreachable", () => {
	it("discovery fails: 503 idp_unavailable, retryable", async () => {
		const h = createHarness({
			deps: {
				settings: testSettings({
					SBX_OIDC_ISSUER: "http://127.0.0.1:1/realms/sbx",
				}),
			},
		});
		const oidc = await startTestOidcServer();
		try {
			const r = await h.request("GET", "/v1/me", {
				headers: { authorization: `Bearer ${await oidc.token()}` },
			});
			expect(r.status).toBe(503);
			expect(errorOf(r.body)).toMatchObject({
				code: "idp_unavailable",
				retryable: true,
			});
		} finally {
			await oidc.close();
		}
	});
});
