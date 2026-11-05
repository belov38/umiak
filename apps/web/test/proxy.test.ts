import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { guard, page } from "../src/lib/guard.ts";

const ORIGIN = "https://app.umiak.example.com";
const ENV = {
	UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8",
	DATABASE_URL: "postgres://u:p@127.0.0.1:5432/umiak",
	PAYLOAD_SECRET: "0123456789abcdef0123",
	UMIAK_APP_ORIGIN: ORIGIN,
	UMIAK_OPERATOR_GROUPS: "umiak-operators",
	UMIAK_PREVIEW_DOMAIN: "umiak.example.com",
	UMIAK_PREVIEW_SCHEME: "http",
	UMIAK_PREVIEW_PORT: "8085",
	UMIAK_API_PUBLIC_URL: "https://api.umiak.example.com",
};
const SIGNED_IN = { "x-umiak-client-ip": "127.0.0.1" };

function req(
	method: string,
	path: string,
	headers: Record<string, string> = {},
): NextRequest {
	return new NextRequest(new URL(path, ORIGIN), { method, headers });
}

describe("guard (S8 §5.1, §5.6)", () => {
	const g = (method: string, path: string, h: Record<string, string> = {}) =>
		guard(
			{ method, pathname: path, headers: new Headers(h) },
			{
				appOrigin: ORIGIN,
				operatorGroups: ["umiak-operators"],
				localAllowedCidrs: "127.0.0.0/8",
			},
		);

	it("no identity header: 401 on every path but /healthz", () => {
		expect(g("GET", "/app")?.status).toBe(403);
		expect(g("GET", "/")?.status).toBe(403);
		expect(g("GET", "/admin")?.status).toBe(403);
		expect(g("GET", "/cms-api/users")?.status).toBe(403);
		expect(g("GET", "/app", { "x-auth-request-email": "  " })?.status).toBe(
			403,
		);
		expect(g("GET", "/healthz")).toBe(null);
	});

	it("unsafe methods need Origin == UMIAK_APP_ORIGIN", () => {
		expect(
			g("POST", "/app", { ...SIGNED_IN, origin: "https://evil" })?.status,
		).toBe(403);
		expect(g("POST", "/app", SIGNED_IN)?.status).toBe(403);
		expect(g("DELETE", "/cms-api/teams/1", SIGNED_IN)?.status).toBe(403);
		expect(
			g("PATCH", "/cms-api/users/1", { ...SIGNED_IN, origin: `${ORIGIN}/` })
				?.status,
		).toBe(403);
		expect(g("POST", "/app", { ...SIGNED_IN, origin: ORIGIN })).toBe(null);
		expect(g("GET", "/app", { ...SIGNED_IN, origin: "https://evil" })).toBe(
			null,
		);
	});

	it("no identity wins over a bad origin (401 first)", () => {
		expect(g("POST", "/app", { origin: "https://evil" })?.status).toBe(403);
	});
});

describe("guard: operator gate and disabled auth endpoints (S8 §5.4, §5.5)", () => {
	const g = (method: string, path: string, h: Record<string, string> = {}) =>
		guard(
			{ method, pathname: path, headers: new Headers(h) },
			{
				appOrigin: ORIGIN,
				operatorGroups: ["umiak-operators"],
				localAllowedCidrs: "127.0.0.0/8",
			},
		);
	const OP = { ...SIGNED_IN, "x-auth-request-groups": "dev, umiak-operators" };

	it("operators pass; the gate does not touch /app or look-alike paths", () => {
		expect(g("GET", "/admin/collections/users", OP)).toBe(null);
		expect(g("GET", "/cms-api/users/me", OP)).toBe(null);
		expect(g("POST", "/cms-api/users/logout", { ...OP, origin: ORIGIN })).toBe(
			null,
		);
		expect(g("GET", "/app/operator", SIGNED_IN)).toBe(null);
		expect(g("GET", "/administrator", SIGNED_IN)).toBe(null);
	});

	it("password-login endpoints of users: 403 for everyone, operators too", () => {
		for (const path of [
			"/cms-api/users/login",
			"/cms-api/users/refresh-token",
			"/cms-api/users/first-register",
			"/cms-api/users/forgot-password",
			"/cms-api/users/reset-password",
			"/cms-api/users/unlock",
			"/cms-api/users/verify/abc",
			"/cms-api/users/abc/api-key/reveal",
		]) {
			const d = g("POST", path, { ...OP, origin: ORIGIN });
			expect(d?.status, path).toBe(403);
			expect(d?.reason, path).toBe("endpoint_disabled");
		}
	});
});

describe("proxy", () => {
	let proxy: typeof import("../src/proxy.ts").proxy;

	beforeAll(async () => {
		Object.assign(process.env, ENV);
		({ proxy } = await import("../src/proxy.ts"));
	});

	it("without the header: 401 HTML with the security headers", async () => {
		const res = proxy(req("GET", "/app"));
		expect(res.status).toBe(403);
		expect(res.headers.get("content-type")).toMatch(/^text\/html/);
		expect(await res.text()).toContain("Forbidden");
		expect(res.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'self'",
		);
		expect(res.headers.get("content-security-policy")).toContain(
			"frame-src 'self' http://*.umiak.example.com:8085",
		);
	});

	it("the app root goes through the guard first: 401 without the header", () => {
		expect(proxy(req("GET", "/")).status).toBe(403);
		expect(proxy(req("GET", "/", SIGNED_IN)).status).toBe(200);
	});

	it("POST with Origin https://evil: 403", () => {
		expect(
			proxy(req("POST", "/app", { ...SIGNED_IN, origin: "https://evil" }))
				.status,
		).toBe(403);
	});

	it("POST without Origin: 403", () => {
		expect(proxy(req("POST", "/cms-api/teams", SIGNED_IN)).status).toBe(403);
	});

	it("GET /healthz without headers passes (200)", () => {
		const res = proxy(req("GET", "/healthz"));
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-next")).toBe("1");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("a signed-in same-origin POST passes with the headers", () => {
		const res = proxy(req("POST", "/app", { ...SIGNED_IN, origin: ORIGIN }));
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-next")).toBe("1");
		expect(res.headers.get("referrer-policy")).toBe("same-origin");
	});
});

describe("proxy config.matcher", () => {
	let config: typeof import("../src/proxy.ts").config;

	beforeAll(async () => {
		for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
		({ config } = await import("../src/proxy.ts"));
	});

	const matches = (url: string) =>
		unstable_doesMiddlewareMatch({ config, url });

	it("runs on pages, the admin, Payload REST and RSC requests", () => {
		for (const url of [
			"/",
			"/app",
			"/admin",
			"/admin/collections/users",
			"/cms-api/teams",
			"/app/t/x?_rsc=1",
			"/_next/image?url=%2Fx.png&w=64&q=75",
		]) {
			expect(matches(url), url).toBe(true);
		}
	});

	it("skips Next's static build files", () => {
		expect(matches("/_next/static/chunks/a.js")).toBe(false);
		expect(matches("/_next/static/css/app.css")).toBe(false);
	});
});

it("denial HTML carries branding and follows the persisted or system appearance", () => {
	const html = page("Forbidden", "No access");
	expect(html).toContain("umiak-theme");
	expect(html).toContain("prefers-color-scheme: dark");
	expect(html).toContain('aria-label="Umiak"');
	expect(html).toContain("color-scheme");
});
