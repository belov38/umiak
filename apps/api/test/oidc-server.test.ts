// The Keycloak-shaped test OIDC server: discovery, JWKS and the endpoints
// the CLI uses (device grant, refresh, revoke).
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	startTestOidcServer,
	type TestOidcServer,
} from "../src/testing/index.ts";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

describe("test OIDC server", () => {
	let oidc: TestOidcServer;
	let endpoints: Record<string, string>;

	beforeAll(async () => {
		oidc = await startTestOidcServer({ deviceInterval: 0 });
		const res = await fetch(`${oidc.issuer}/.well-known/openid-configuration`);
		endpoints = (await res.json()) as Record<string, string>;
	});
	afterAll(async () => {
		await oidc?.close();
	});

	async function post(url: string, form: Record<string, string>) {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(form),
		});
		const text = await res.text();
		return {
			status: res.status,
			body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
		};
	}

	async function startDevice() {
		const r = await post(endpoints.device_authorization_endpoint as string, {
			client_id: "sbx-cli",
			scope: "openid",
		});
		expect(r.status).toBe(200);
		return r.body as { device_code: string; user_code: string };
	}

	const poll = (deviceCode: string) =>
		post(endpoints.token_endpoint as string, {
			grant_type: DEVICE_GRANT,
			client_id: "sbx-cli",
			device_code: deviceCode,
		});

	it("discovery has Keycloak's endpoints under the issuer", () => {
		expect(endpoints).toMatchObject({
			issuer: oidc.issuer,
			jwks_uri: `${oidc.issuer}/protocol/openid-connect/certs`,
			token_endpoint: `${oidc.issuer}/protocol/openid-connect/token`,
			device_authorization_endpoint: `${oidc.issuer}/protocol/openid-connect/auth/device`,
			revocation_endpoint: `${oidc.issuer}/protocol/openid-connect/revoke`,
		});
	});

	it("tokens verify against the JWKS with Keycloak's access token claims", async () => {
		const jwks = createRemoteJWKSet(new URL(endpoints.jwks_uri as string));
		const { payload } = await jwtVerify(await oidc.token({ sub: "s1" }), jwks, {
			issuer: oidc.issuer,
			audience: "sbx-api",
		});
		expect(payload).toMatchObject({
			sub: "s1",
			typ: "Bearer",
			azp: "sbx-cli",
			email_verified: true,
		});
	});

	it("device grant: pending, approved, tokens; the code works once", async () => {
		const d = await startDevice();
		expect(oidc.deviceFlow.pending()).toContain(d.user_code);
		expect((await poll(d.device_code)).body.error).toBe(
			"authorization_pending",
		);
		oidc.deviceFlow.approve(d.user_code, {
			sub: "dev-sub",
			email: "dev@example.com",
		});
		const ok = await poll(d.device_code);
		expect(ok.status).toBe(200);
		expect(decodeJwt(ok.body.access_token as string)).toMatchObject({
			sub: "dev-sub",
			email: "dev@example.com",
			typ: "Bearer",
		});
		expect(typeof ok.body.refresh_token).toBe("string");
		expect((await poll(d.device_code)).body.error).toBe("invalid_grant");
	});

	it("device grant: denied -> access_denied; expired -> expired_token", async () => {
		const d = await startDevice();
		oidc.deviceFlow.deny(d.user_code);
		expect((await poll(d.device_code)).body.error).toBe("access_denied");
		const short = await startTestOidcServer({
			deviceExpiresIn: 0,
			deviceInterval: 0,
		});
		try {
			const r = await fetch(
				`${short.issuer}/protocol/openid-connect/auth/device`,
				{
					method: "POST",
					body: new URLSearchParams({ client_id: "sbx-cli" }),
				},
			);
			const { device_code } = (await r.json()) as { device_code: string };
			await new Promise((res) => setTimeout(res, 5));
			const t = await fetch(`${short.issuer}/protocol/openid-connect/token`, {
				method: "POST",
				body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code }),
			});
			expect(((await t.json()) as { error: string }).error).toBe(
				"expired_token",
			);
		} finally {
			await short.close();
		}
	});

	it("polling faster than the interval: slow_down", async () => {
		const slow = await startTestOidcServer({ deviceInterval: 5 });
		try {
			const r = await fetch(
				`${slow.issuer}/protocol/openid-connect/auth/device`,
				{
					method: "POST",
					body: new URLSearchParams({ client_id: "sbx-cli" }),
				},
			);
			const { device_code } = (await r.json()) as { device_code: string };
			const once = () =>
				fetch(`${slow.issuer}/protocol/openid-connect/token`, {
					method: "POST",
					body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code }),
				}).then((x) => x.json() as Promise<{ error: string }>);
			expect((await once()).error).toBe("authorization_pending");
			expect((await once()).error).toBe("slow_down");
		} finally {
			await slow.close();
		}
	});

	it("autoApprove, refresh (counted), revoke and revokeRefreshTokens", async () => {
		oidc.deviceFlow.autoApprove({ sub: "auto" });
		const d = await startDevice();
		oidc.deviceFlow.autoApprove(null);
		const tokens = (await poll(d.device_code)).body;
		const refresh = () =>
			post(endpoints.token_endpoint as string, {
				grant_type: "refresh_token",
				client_id: "sbx-cli",
				refresh_token: tokens.refresh_token as string,
			});
		const before = oidc.stats.refresh;
		const r = await refresh();
		expect(r.status).toBe(200);
		expect(decodeJwt(r.body.access_token as string).sub).toBe("auto");
		expect(oidc.stats.refresh).toBe(before + 1);
		const revoked = await post(endpoints.revocation_endpoint as string, {
			client_id: "sbx-cli",
			token: tokens.refresh_token as string,
			token_type_hint: "refresh_token",
		});
		expect(revoked.status).toBe(200);
		expect((await refresh()).body.error).toBe("invalid_grant");

		const other = (await poll((await startDeviceApproved()).device_code)).body;
		oidc.revokeRefreshTokens();
		const r2 = await post(endpoints.token_endpoint as string, {
			grant_type: "refresh_token",
			refresh_token: other.refresh_token as string,
		});
		expect(r2.body.error).toBe("invalid_grant");
	});

	async function startDeviceApproved() {
		const d = await startDevice();
		oidc.deviceFlow.approve(d.user_code);
		return d;
	}
});
