import { describe, expect, it } from "vitest";
import { testSettings } from "../src/testing/index.ts";
import { createHarness } from "./helpers/harness.ts";

describe("owner deployment metadata", () => {
	it("advertises owner pairing, single tenancy, preview and SSH endpoints", async () => {
		const h = createHarness({
			deps: {
				settings: testSettings({
					UMIAK_PREVIEW_SCHEME: "http",
					UMIAK_PREVIEW_PORT: "8085",
				}),
			},
		});
		const r = await h.request("GET", "/v1/meta");
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({
			authMode: "owner",
			tenancy: "single",
			apiVersion: "v1",
			previewScheme: "http",
			previewPort: 8085,
			ssh: { host: "ssh.umiak.test", port: 22, hostKeys: [] },
		});
		expect(Object.keys(r.body as object).sort()).toEqual(
			[
				"authMode",
				"tenancy",
				"apiVersion",
				"build",
				"appUrl",
				"apiUrl",
				"umiakDomain",
				"previewScheme",
				"previewPort",
				"ssh",
				"minCliVersion",
				"latestCliVersion",
			].sort(),
		);
	});
	it("serves the OpenAPI document through both trusted ingress listeners", async () => {
		for (const listener of ["public", "proxied"] as const) {
			const h = createHarness({ listener });
			const r = await h.request("GET", "/v1/openapi.json");
			expect(r.status).toBe(200);
			expect(r.body).toMatchObject({
				openapi: "3.1.0",
				servers: [{ url: h.deps.settings.apiUrl }],
			});
		}
	});
	it("does not host third-party API reference scripts on the authenticated origin", async () => {
		const h = createHarness();
		const r = await h.request("GET", "/v1/docs");
		expect(r.status).toBe(404);
		expect(r.headers.get("content-type")).not.toContain("text/html");
	});
});
