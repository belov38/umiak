import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWebEnv } from "../src/lib/env.ts";
import { guard } from "../src/lib/guard.ts";

const options = {
	appOrigin: "http://192.168.1.10:4180",
	operatorGroups: [],
	authMode: "owner" as const,
	localAllowedCidrs: "192.168.1.0/24",
};
function request(
	pathname = "/app",
	headers: Record<string, string> = {},
	method = "GET",
) {
	return { pathname, method, headers: new Headers(headers) };
}
afterEach(() => vi.unstubAllEnvs());
describe("owner web transport boundary", () => {
	it("opens dashboard and admin without oauth headers for an allowed ingress client", () => {
		for (const path of ["/app", "/admin", "/cms-api/users/me"]) {
			expect(
				guard(request(path, { "x-umiak-client-ip": "192.168.1.20" }), options),
			).toBeNull();
		}
	});
	it("fails closed without the ingress client stamp or with a disallowed address", () => {
		for (const address of [
			undefined,
			"203.0.113.4",
			"192.168.1.20, 127.0.0.1",
		]) {
			expect(
				guard(
					request("/admin", {
						"x-forwarded-for": "127.0.0.1",
						"x-auth-request-email": "admin@example.com",
						...(address ? { "x-umiak-client-ip": address } : {}),
					}),
					options,
				)?.reason,
			).toBe("client_network_forbidden");
		}
	});
	it("uses the configured narrower allowlist", () => {
		const restricted = { ...options, localAllowedCidrs: "192.168.2.0/24" };
		expect(
			guard(
				request("/app", { "x-umiak-client-ip": "192.168.1.20" }),
				restricted,
			)?.status,
		).toBe(403);
	});
	it("keeps CSRF origin checks on plain HTTP", () => {
		const h = { "x-umiak-client-ip": "192.168.1.20" };
		expect(guard(request("/app", h, "POST"), options)?.reason).toBe(
			"origin_forbidden",
		);
		expect(
			guard(
				request("/app", { ...h, origin: options.appOrigin }, "POST"),
				options,
			),
		).toBeNull();
	});
	it("does not enable password endpoints", () => {
		expect(
			guard(
				request(
					"/cms-api/users/login",
					{ "x-umiak-client-ip": "192.168.1.20" },
					"POST",
				),
				options,
			)?.reason,
		).toBe("endpoint_disabled");
	});
	it("requires ingress configuration by default", () => {
		expect(
			guard(request(), {
				appOrigin: options.appOrigin,
				operatorGroups: [],
				localAllowedCidrs: "192.168.1.0/24",
			})?.status,
		).toBe(403);
	});
	it("parses owner mode without a sign-out destination", () => {
		const env = parseWebEnv({
			DATABASE_URL: "postgres://local/db",
			PAYLOAD_SECRET: "0123456789abcdef",
			UMIAK_APP_ORIGIN: options.appOrigin,
			UMIAK_OPERATOR_GROUPS: "operators",
			UMIAK_PREVIEW_DOMAIN: "umiak.localhost",
			UMIAK_API_PUBLIC_URL: "http://192.168.1.10:8080",
			UMIAK_AUTH_MODE: "owner",
			UMIAK_LOCAL_ALLOWED_CIDRS: "192.168.1.0/24",
			UMIAK_LOGOUT_URL: "https://idp/logout",
		});
		expect(env.authMode).toBe("owner");
	});
});
