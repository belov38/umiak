import { describe, expect, it } from "vitest";
import {
	isTrustedIngressClient,
	OWNER_USER_SUB,
	ownerCidrSet,
	ownerSessionHeaders,
	parseAuthMode,
} from "../src/owner-mode.ts";

describe("owner mode configuration", () => {
	it("defaults to owner, accepts owner and rejects everything else", () => {
		expect(parseAuthMode({})).toBe("owner");
		expect(parseAuthMode({ UMIAK_AUTH_MODE: "owner" })).toBe("owner");
		expect(() => parseAuthMode({ UMIAK_AUTH_MODE: "none" })).toThrow(
			/UMIAK_AUTH_MODE must be owner/,
		);
		expect(() => parseAuthMode({ UMIAK_AUTH_MODE: "off" })).toThrow();
	});
	it("has no default allowlist: the ingress CIDRs are required", () => {
		expect(() => ownerCidrSet({})).toThrow(/UMIAK_LOCAL_ALLOWED_CIDRS/);
		expect(() => ownerCidrSet({ UMIAK_LOCAL_ALLOWED_CIDRS: "" })).toThrow(
			/must not be empty/,
		);
		for (const cidr of [
			"garbage",
			"10.0.0.0/33",
			"::/129",
			"10.0.0.0/-1",
			"10.0.0.0/8/9",
		])
			expect(() => ownerCidrSet({ UMIAK_LOCAL_ALLOWED_CIDRS: cidr })).toThrow();
	});
});

describe("isTrustedIngressClient", () => {
	const cidrs = ownerCidrSet({
		UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8,::1/128,172.29.116.0/24",
	});
	it("accepts only the configured ingress networks, including mapped IPv4", () => {
		for (const ip of [
			"127.0.0.1",
			"::1",
			"172.29.116.10",
			"::ffff:172.29.116.10",
		])
			expect(isTrustedIngressClient(ip, cidrs)).toBe(true);
		for (const ip of [
			"",
			"invalid",
			"192.168.1.5",
			"10.1.2.3",
			"100.64.0.1",
			"fd12::1",
		])
			expect(isTrustedIngressClient(ip, cidrs)).toBe(false);
	});
	it("denies sandbox SNAT before allowing, including mapped peers and node IPs", () => {
		const set = ownerCidrSet({
			UMIAK_LOCAL_ALLOWED_CIDRS: "192.168.68.0/24",
			UMIAK_LOCAL_DENIED_CIDRS: "192.168.68.116/32",
		});
		expect(isTrustedIngressClient("192.168.68.20", set)).toBe(true);
		expect(isTrustedIngressClient("192.168.68.116", set)).toBe(false);
		expect(isTrustedIngressClient("::ffff:192.168.68.116", set)).toBe(false);
		const node = ownerCidrSet({
			UMIAK_LOCAL_ALLOWED_CIDRS: "192.168.68.0/24",
			UMIAK_NODE_SSH_HOST: "192.168.68.116",
		});
		expect(isTrustedIngressClient("192.168.68.116", node)).toBe(false);
		const v6 = ownerCidrSet({
			UMIAK_LOCAL_ALLOWED_CIDRS: "fd00::/16",
			UMIAK_PVE_URL: "https://[fd00::12]:8006",
		});
		expect(isTrustedIngressClient("fd00::12", v6)).toBe(false);
		expect(isTrustedIngressClient("fd00::13", v6)).toBe(true);
		expect(() =>
			ownerCidrSet({
				UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8",
				UMIAK_LOCAL_DENIED_CIDRS: "bad",
			}),
		).toThrow(/UMIAK_LOCAL_DENIED_CIDRS/);
	});
});

it("owner session headers carry the fixed owner identity", () => {
	expect(OWNER_USER_SUB).toBe("umiak:local");
	expect(ownerSessionHeaders().user).toBe("umiak:local");
});
