import { describe, expect, it } from "vitest";
import {
	authMode,
	isLocalClientAllowed,
	localAllowedCidrs,
	localDeniedCidrs,
	localPolicyWarnings,
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
		expect(() =>
			localAllowedCidrs({ UMIAK_LOCAL_ALLOWED_CIDRS: "" }),
		).toThrow();
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

it("denies sandbox SNAT before allowing LAN, including mapped peers", () => {
	const env = {
		UMIAK_LOCAL_ALLOWED_CIDRS: "192.168.68.0/24",
		UMIAK_LOCAL_DENIED_CIDRS: "192.168.68.116/32",
	};
	expect(isLocalClientAllowed("192.168.68.20", env)).toBe(true);
	expect(isLocalClientAllowed("192.168.68.116", env)).toBe(false);
	expect(isLocalClientAllowed("::ffff:192.168.68.116", env)).toBe(false);
	expect(isLocalClientAllowed("10.88.0.2", {})).toBe(false);
	expect(
		isLocalClientAllowed("192.168.68.116", {
			UMIAK_NODE_SSH_HOST: "192.168.68.116",
		}),
	).toBe(false);
});

it("validates denied CIDRs and derives node IPv6 addresses", () => {
	expect(() =>
		isLocalClientAllowed("127.0.0.1", { UMIAK_LOCAL_DENIED_CIDRS: "bad" }),
	).toThrow();
	expect(
		isLocalClientAllowed("fd00::12", {
			UMIAK_PVE_URL: "https://[fd00::12]:8006",
		}),
	).toBe(false);
	expect(
		isLocalClientAllowed("fd00::13", {
			UMIAK_PVE_URL: "https://[fd00::12]:8006",
		}),
	).toBe(true);
});

it("warns once about open or node-blind policies, not per request", () => {
	expect(
		localPolicyWarnings({ UMIAK_NODE_SSH_HOST: "192.168.68.116" }),
	).toEqual([]);
	expect(localPolicyWarnings({ UMIAK_NODE_SSH_HOST: "pve" }).join(" ")).toMatch(
		/UMIAK_LOCAL_DENIED_CIDRS/,
	);
	expect(
		localPolicyWarnings({
			UMIAK_NODE_SSH_HOST: "pve",
			UMIAK_LOCAL_DENIED_CIDRS: "192.168.68.116/32",
		}),
	).toEqual([]);
	expect(
		localPolicyWarnings({
			UMIAK_LOCAL_ALLOWED_CIDRS: "0.0.0.0/0",
			UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24",
		}).join(" "),
	).toMatch(/entire Internet/);
	expect(() => localDeniedCidrs({ UMIAK_LOCAL_DENIED_CIDRS: "bad" })).toThrow(
		/UMIAK_LOCAL_DENIED_CIDRS/,
	);
});
