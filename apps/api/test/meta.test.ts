import { describe, expect, it } from "vitest";
import { testSettings } from "../src/testing/index.ts";
import { createHarness } from "./helpers/harness.ts";

const HOST_KEY =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

describe("GET /v1/meta (S7 §13)", () => {
	it("answers without auth with every field", async () => {
		const settings = testSettings({
			SBX_OIDC_ISSUER: "https://auth.example.test/realms/sbx",
			SBX_BUILD: "1.2.3+abc",
			SBX_MIN_CLI_VERSION: "0.4.0",
			SBX_LATEST_CLI_VERSION: "0.5.1",
		});
		const h = createHarness({ deps: { settings, hostKeys: [HOST_KEY] } });
		const r = await h.request("GET", "/v1/meta");
		expect(r.status).toBe(200);
		expect(r.body).toEqual({
			apiVersion: "v1",
			build: "1.2.3+abc",
			appUrl: settings.appUrl,
			apiUrl: settings.apiUrl,
			sbxDomain: settings.sbxDomain,
			oidc: {
				issuer: "https://auth.example.test/realms/sbx",
				clientId: "sbx-cli",
				audience: "sbx-api",
			},
			ssh: {
				host: `ssh.${settings.sbxDomain}`,
				port: 22,
				hostKeys: [HOST_KEY],
			},
			minCliVersion: "0.4.0",
			latestCliVersion: "0.5.1",
		});
	});

	it("oidc is null without SBX_OIDC_ISSUER", async () => {
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

	it("openapi.json and docs are served without auth on public and proxied", async () => {
		for (const listener of ["public", "proxied"] as const) {
			const h = createHarness({ listener });
			const doc = await h.request("GET", "/v1/openapi.json");
			expect(doc.status).toBe(200);
			expect((doc.body as { openapi: string }).openapi).toBe("3.1.0");
			const docs = await h.request("GET", "/v1/docs");
			expect(docs.status).toBe(200);
			expect(docs.headers.get("content-type")).toContain("text/html");
		}
	});

	it("the served document points keycloak at the configured issuer", async () => {
		const settings = testSettings({
			SBX_OIDC_ISSUER: "https://auth.example.test/realms/sbx",
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
			"https://auth.example.test/realms/sbx/.well-known/openid-configuration",
		);
		expect(doc.servers).toEqual([{ url: settings.apiUrl }]);
	});
});
