import { isIP } from "node:net";

/** The sandbox subnet from the install facts: any aligned IPv4 network /8–/30 (new installs use /18). */
export function guestSubnet(): string {
	const value = process.env.UMIAK_GUEST_SUBNET ?? "10.88.0.0/24";
	const [base = "", bitsText = ""] = value.split("/");
	const bits = Number(bitsText);
	if (isIP(base) !== 4 || !/^\d+$/.test(bitsText) || bits < 8 || bits > 30)
		throw new Error(
			`UMIAK_GUEST_SUBNET must be an IPv4 network /8-/30, got ${value}`,
		);
	const n = base.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
	if (n % 2 ** (32 - bits) !== 0)
		throw new Error(
			`UMIAK_GUEST_SUBNET must be a network address, got ${value}`,
		);
	return value;
}
