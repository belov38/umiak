import { describe, expect, it } from "vitest";
import {
	contentSecurityPolicy,
	securityHeaders,
} from "../src/lib/security-headers.ts";

function directives(csp: string): Map<string, string[]> {
	return new Map(
		csp.split(";").map((d) => {
			const [k = "", ...v] = d.trim().split(/\s+/);
			return [k, v];
		}),
	);
}

describe("securityHeaders (S8 §5.6)", () => {
	const h = securityHeaders({ umiakDomain: "umiak.example.com" });
	const csp = directives(h["Content-Security-Policy"] ?? "");

	it("CSP: own origin, frames of sandbox hosts only", () => {
		expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'self'");
		expect(h["Content-Security-Policy"]).toContain(
			"frame-src 'self' https://*.umiak.example.com",
		);
		expect(csp.get("default-src")).toEqual(["'self'"]);
		expect(csp.get("connect-src")).toEqual(["'self'"]);
		expect(csp.get("object-src")).toEqual(["'none'"]);
		expect(csp.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
		expect(csp.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
		expect(csp.get("script-src")).toEqual(["'self'", "'unsafe-inline'"]);
	});

	it("no external origin anywhere", () => {
		for (const [k, v] of csp) {
			if (k === "frame-src") continue;
			for (const s of v) expect(s).not.toMatch(/^https?:/);
		}
	});

	it("'unsafe-eval' only in dev", () => {
		expect(
			directives(
				contentSecurityPolicy({ umiakDomain: "umiak.example.com", dev: true }),
			).get("script-src"),
		).toContain("'unsafe-eval'");
	});

	it("frame-src allows the same-origin owner desktop viewer (/desktop/<slug>/)", () => {
		expect(csp.get("frame-src")?.[0]).toBe("'self'");
	});

	it("nosniff, same-origin referrer", () => {
		expect(h["X-Content-Type-Options"]).toBe("nosniff");
		expect(h["Referrer-Policy"]).toBe("same-origin");
	});

	it("allows configured HTTP preview frames only on their published domain and port", () => {
		const csp = directives(
			contentSecurityPolicy({
				umiakDomain: "umiak.example.com",
				previewScheme: "http",
				previewPort: 8085,
			}),
		);
		expect(csp.get("frame-src")).toEqual([
			"'self'",
			"http://*.umiak.example.com:8085",
		]);
		const https = directives(
			contentSecurityPolicy({
				umiakDomain: "umiak.example.com",
				previewScheme: "https",
				previewPort: 8443,
			}),
		);
		expect(https.get("frame-src")).toEqual([
			"'self'",
			"https://*.umiak.example.com:8443",
		]);
	});
});
