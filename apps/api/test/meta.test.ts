import { describe, expect, it } from "vitest";
import { testSettings } from "../src/testing/index.ts";
import { createHarness } from "./helpers/harness.ts";

const HOST_KEY =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

describe("GET /v1/meta (S7 §13)", () => {
	it("answers without auth with every field", async () => {
		const settings = testSettings({
			UMIAK_OIDC_ISSUER: "https://auth.example.test/realms/umiak",
			UMIAK_BUILD: "1.2.3+abc",
			UMIAK_MIN_CLI_VERSION: "0.4.0",
			UMIAK_LATEST_CLI_VERSION: "0.5.1",
		});
		const h = createHarness({ deps: { settings, hostKeys: [HOST_KEY] } });
		const r = await h.request("GET", "/v1/meta");
		expect(r.status).toBe(200);
		expect(r.body).toEqual({
			tenancy: "teams",
			apiVersion: "v1",
			build: "1.2.3+abc",
			appUrl: settings.appUrl,
			apiUrl: settings.apiUrl,
			umiakDomain: settings.umiakDomain,
			oidc: {
				issuer: "https://auth.example.test/realms/umiak",
				clientId: "umiak-cli",
				audience: "umiak-api",
			},
			ssh: {
				host: `ssh.${settings.umiakDomain}`,
				port: 22,
				hostKeys: [HOST_KEY],
			},
			minCliVersion: "0.4.0",
			latestCliVersion: "0.5.1",
		});
	});

	it("oidc is null without UMIAK_OIDC_ISSUER", async () => {
		const h = createHarness();
		const r = await h.request("GET", "/v1/meta");
		expect(r.status).toBe(200);
		expect((r.body as { oidc: unknown }).oidc).toBeNull();
		expect((r.body as { ssh: { hostKeys: string[] } }).ssh.hostKeys).toEqual(
			[],
		);
	});

	it("is served on the proxied listener too", async () => {
		const h = createHarness({ listener: "proxied" });
		const r = await h.request("GET", "/v1/meta");
		expect(r.status).toBe(200);
		expect((r.body as { apiVersion: string }).apiVersion).toBe("v1");
	});

	it("openapi.json is served without auth on public and proxied", async () => {
		for (const listener of ["public", "proxied"] as const) {
			const h = createHarness({ listener });
			const doc = await h.request("GET", "/v1/openapi.json");
			expect(doc.status).toBe(200);
			expect((doc.body as { openapi: string }).openapi).toBe("3.1.0");
		}
	});

	it("docs on the public listener: a pinned Scalar bundle with SRI, no inline script, a strict CSP", async () => {
		const h = createHarness();
		const docs = await h.app.request("/v1/docs");
		expect(docs.status).toBe(200);
		expect(docs.headers.get("content-type")).toContain("text/html");
		const html = await docs.text();
		const scripts = [
			...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g),
		];
		const external = scripts.filter((m) => /\ssrc=/.test(m[1] ?? ""));
		expect(external).toHaveLength(1);
		const tag = external[0]?.[1] ?? "";
		expect(tag).toContain(
			'src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.3/dist/browser/standalone.js"',
		);
		expect(tag).toMatch(/integrity="sha384-[A-Za-z0-9+/=]{64}"/);
		expect(tag).toContain('crossorigin="anonymous"');
		// The only other script element is the data holder, not executable code.
		for (const m of scripts.filter((m) => !/\ssrc=/.test(m[1] ?? ""))) {
			expect(m[1]).toContain('type="application/json"');
		}
		const csp = docs.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain(
			"script-src https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.3/dist/browser/standalone.js",
		);
		expect(csp).not.toContain("unsafe-eval");
		expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
		expect(csp).toContain("frame-ancestors 'none'");
	});

	it("docs are not served on the proxied (cookie-authenticated) listener", async () => {
		const h = createHarness({ listener: "proxied" });
		const docs = await h.app.request("/v1/docs");
		expect(docs.status).not.toBe(200);
		expect(docs.headers.get("content-type") ?? "").not.toContain("text/html");
	});

	it("the served document points keycloak at the configured issuer", async () => {
		const settings = testSettings({
			UMIAK_OIDC_ISSUER: "https://auth.example.test/realms/umiak",
		});
		const h = createHarness({ deps: { settings } });
		const r = await h.request("GET", "/v1/openapi.json");
		const doc = r.body as {
			components: {
				securitySchemes: { keycloak: { openIdConnectUrl: string } };
			};
			servers: { url: string }[];
		};
		expect(doc.components.securitySchemes.keycloak.openIdConnectUrl).toBe(
			"https://auth.example.test/realms/umiak/.well-known/openid-configuration",
		);
		expect(doc.servers).toEqual([{ url: settings.apiUrl }]);
	});
});
