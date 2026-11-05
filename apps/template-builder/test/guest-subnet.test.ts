import { afterEach, describe, expect, it } from "vitest";
import { guestSubnet } from "../src/guest-subnet.ts";

const saved = process.env.UMIAK_GUEST_SUBNET;
afterEach(() => {
	if (saved === undefined) delete process.env.UMIAK_GUEST_SUBNET;
	else process.env.UMIAK_GUEST_SUBNET = saved;
});

describe("guestSubnet", () => {
	it("accepts the legacy /24 and the /18 of new installs", () => {
		for (const value of ["10.88.0.0/24", "10.88.0.0/18", "10.89.64.0/18"]) {
			process.env.UMIAK_GUEST_SUBNET = value;
			expect(guestSubnet()).toBe(value);
		}
	});
	it("rejects unaligned, non-IPv4 and out-of-range networks", () => {
		for (const value of [
			"10.88.1.0/18",
			"fd00::/64",
			"10.88.0.0/31",
			"10.0.0.0/7",
			"10.88.0.0",
		]) {
			process.env.UMIAK_GUEST_SUBNET = value;
			expect(() => guestSubnet()).toThrow();
		}
	});
});
