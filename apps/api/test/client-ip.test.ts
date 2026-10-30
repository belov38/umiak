// Client address of the request log (S7 §7.1): X-Forwarded-For counts only
// from SBX_API_TRUSTED_PROXY_CIDRS.
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { TrustedProxies } from "../src/http/client-ip.ts";
import { captureLogs, testSettings } from "../src/testing/index.ts";
import { createHarness } from "./helpers/harness.ts";

describe("TrustedProxies.clientOf", () => {
	const p = new TrustedProxies(["172.16.0.0/12", "127.0.0.1/32", "fd00::/8"]);

	it("an untrusted peer is the client; its X-Forwarded-For is ignored", () => {
		expect(p.clientOf("100.64.1.2", "1.2.3.4")).toBe("100.64.1.2");
	});

	it("a trusted peer: the rightmost untrusted hop", () => {
		expect(p.clientOf("172.18.0.1", "100.101.102.103")).toBe("100.101.102.103");
		// The client sent its own X-Forwarded-For; the proxy appended the real one.
		expect(p.clientOf("172.18.0.1", "6.6.6.6, 100.101.102.103")).toBe(
			"100.101.102.103",
		);
		// Two trusted proxies (Serve to Docker, then oauth2-proxy).
		expect(p.clientOf("172.18.0.5", "100.101.102.103, 172.18.0.1")).toBe(
			"100.101.102.103",
		);
	});

	it("IPv4-mapped peers, IPv6 hops, no or broken header", () => {
		expect(p.clientOf("::ffff:172.18.0.1", "100.1.1.1")).toBe("100.1.1.1");
		expect(p.clientOf("fd00::1", "2001:db8::7")).toBe("2001:db8::7");
		expect(p.clientOf("172.18.0.1", undefined)).toBe("172.18.0.1");
		expect(p.clientOf("172.18.0.1", "not-an-ip")).toBe("172.18.0.1");
		expect(p.clientOf(undefined, "1.2.3.4")).toBeUndefined();
	});

	it("an all-trusted chain: the leftmost hop", () => {
		expect(p.clientOf("172.18.0.5", "172.18.0.2, 172.18.0.1")).toBe(
			"172.18.0.2",
		);
	});

	it("an IPv4-mapped hop behind an IPv6 peer: plain IPv4", () => {
		expect(p.clientOf("fd00::1", "::ffff:100.1.1.1")).toBe("100.1.1.1");
	});

	it("no trusted CIDRs: always the peer", () => {
		expect(new TrustedProxies([]).clientOf("127.0.0.1", "1.2.3.4")).toBe(
			"127.0.0.1",
		);
	});
});

describe("request log clientIp on a real socket", () => {
	async function logged(
		cidrs: string,
		headers: Record<string, string>,
	): Promise<unknown> {
		const logs = captureLogs();
		const h = createHarness({
			deps: {
				log: logs.log,
				settings: testSettings({ SBX_API_TRUSTED_PROXY_CIDRS: cidrs }),
			},
		});
		const server = serve({
			fetch: h.app.fetch,
			port: 0,
			hostname: "127.0.0.1",
		});
		await new Promise<void>((r) => server.once("listening", () => r()));
		try {
			const port = (server.address() as AddressInfo).port;
			const res = await fetch(`http://127.0.0.1:${port}/v1/meta`, { headers });
			expect(res.status).toBe(200);
		} finally {
			await new Promise((r) => server.close(r));
		}
		const line = logs.entries().find((e) => e.msg === "request");
		return line?.clientIp;
	}

	it("loopback trusted: the forwarded client", async () => {
		expect(
			await logged("127.0.0.1/32", { "x-forwarded-for": "100.101.102.103" }),
		).toBe("100.101.102.103");
	});

	it("nothing trusted: the connection address", async () => {
		expect(await logged("", { "x-forwarded-for": "100.101.102.103" })).toBe(
			"127.0.0.1",
		);
	});
});
