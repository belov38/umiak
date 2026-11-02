import type { Payload } from "payload";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUmiakConfig } from "../src/config.ts";
import {
	authenticateHeaders,
	authenticateRequest,
} from "../src/identity/strategy.ts";
import { testOptions } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());
describe("local Payload identity boundary", () => {
	it("rejects unstamped and disallowed clients before touching the database or cache", async () => {
		vi.stubEnv("UMIAK_AUTH_MODE", "none");
		const payload = {} as Payload;
		for (const headers of [
			new Headers(),
			new Headers({
				"x-umiak-client-ip": "203.0.113.1",
				"x-auth-request-email": "operator@example.com",
				"x-forwarded-for": "127.0.0.1",
			}),
		]) {
			expect(await authenticateHeaders(payload, headers)).toEqual({
				kind: "denied",
				status: 403,
				reason: "client_network_forbidden",
			});
			expect(await authenticateRequest(payload, headers)).toEqual({
				kind: "denied",
				status: 403,
				reason: "client_network_forbidden",
			});
		}
	});
	it("uses a non-Host cookie name and disables admin sign-out only for local HTTP", async () => {
		vi.stubEnv("UMIAK_AUTH_MODE", "none");
		const c = await buildUmiakConfig({
			...testOptions("postgres://local/db"),
			appOrigin: "http://192.168.1.10:4180",
		});
		expect(c.cookiePrefix).toBe("payload");
		expect(c.csrf).toEqual(["http://192.168.1.10:4180"]);
		expect(c.admin.components?.logout?.Button).toBe(
			"/src/components/admin/local-logout#LocalLogout",
		);
	});
	it("retains the Host cookie for HTTPS local deployments", async () => {
		vi.stubEnv("UMIAK_AUTH_MODE", "none");
		const c = await buildUmiakConfig(testOptions("postgres://local/db"));
		expect(c.cookiePrefix).toBe("__Host-payload");
	});
});
