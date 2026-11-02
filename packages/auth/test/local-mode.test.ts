import { describe, expect, it } from "vitest";
import {
	authMode,
	isLocalClientAllowed,
	localAllowedCidrs,
} from "../src/local-mode.ts";

describe("local mode configuration", () => {
	it("defaults to oidc and rejects unknown modes", () => {
		expect(authMode({})).toBe("oidc");
		expect(authMode({ UMIAK_AUTH_MODE: "none" })).toBe("none");
		expect(() => authMode({ UMIAK_AUTH_MODE: "off" })).toThrow();
	});
	it("allows loopback, private IPv4 and ULA, including mapped IPv4", () => {
		for (const ip of [
			"127.0.0.1",
			"::1",
			"10.1.2.3",
			"172.16.0.1",
			"192.168.1.2",
			"fd12::1",
			"::ffff:192.168.1.2",
		])
			expect(isLocalClientAllowed(ip, {})).toBe(true);
		for (const ip of [
			undefined,
			"",
			"invalid",
			"8.8.8.8",
			"100.64.0.1",
			"172.32.0.1",
			"fe80::1",
		])
			expect(isLocalClientAllowed(ip, {})).toBe(false);
	});
	it("replaces defaults and fails closed for empty or malformed allowlists", () => {
		const env = { UMIAK_LOCAL_ALLOWED_CIDRS: "192.168.4.0/24,fd00:1::/48" };
		expect(isLocalClientAllowed("192.168.4.5", env)).toBe(true);
		expect(isLocalClientAllowed("127.0.0.1", env)).toBe(false);
		expect(
			isLocalClientAllowed("127.0.0.1", { UMIAK_LOCAL_ALLOWED_CIDRS: "" }),
		).toBe(false);
		for (const cidr of [
			"garbage",
			"10.0.0.0/33",
			"::/129",
			"10.0.0.0/-1",
			"10.0.0.0/8/9",
		])
			expect(() =>
				localAllowedCidrs({ UMIAK_LOCAL_ALLOWED_CIDRS: cidr }),
			).toThrow();
	});
});
