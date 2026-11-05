import { describe, expect, it } from "vitest";
import { createHarness } from "./helpers/harness.ts";

describe("owner proxied listener", () => {
	it("ignores client-supplied identity headers", async () => {
		const h = createHarness({ listener: "proxied" });
		const res = await h.request("GET", "/v1/me", {
			headers: {
				"x-auth-request-user": "attacker",
				"x-auth-request-email": "attacker@example.com",
			},
		});
		expect(res.status, res.text).toBe(200);
		expect(res.text).not.toContain("attacker");
	});
	it("does not accept bearer credentials on the private browser listener", async () => {
		const h = createHarness({ listener: "proxied" });
		expect(
			(
				await h.request("GET", "/v1/me", {
					headers: { authorization: "Bearer forged" },
				})
			).status,
		).toBe(400);
	});
	it("requires the dashboard Origin on writes and websocket upgrades", async () => {
		const h = createHarness({ listener: "proxied" });
		h.app.post("/v1/__test/action", (c) => c.body(null, 204));
		h.app.get("/v1/__test/socket", (c) => c.body(null, 204));
		for (const headers of [{}, { origin: "https://evil.invalid" }])
			expect(
				(await h.request("POST", "/v1/__test/action", { headers })).status,
			).toBe(403);
		expect(
			(
				await h.request("GET", "/v1/__test/socket", {
					headers: { upgrade: "websocket" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await h.request("POST", "/v1/__test/action", {
					headers: { origin: h.deps.settings.appOrigin },
				})
			).status,
		).toBe(204);
	});
	it("rejects form submissions even from the dashboard Origin", async () => {
		const h = createHarness({ listener: "proxied" });
		for (const type of [
			"text/plain",
			"application/x-www-form-urlencoded",
			"multipart/form-data",
		])
			expect(
				(
					await h.request("POST", "/v1/__test/action", {
						headers: {
							origin: h.deps.settings.appOrigin,
							"content-type": type,
						},
						body: "x=y",
					})
				).status,
			).toBe(400);
	});
});
