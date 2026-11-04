import { isIP } from "node:net";

export function guestSubnet(): string {
	const value = process.env.UMIAK_GUEST_SUBNET ?? "10.88.0.0/24";
	if (!value.endsWith(".0/24") || isIP(value.split("/")[0] ?? "") !== 4)
		throw new Error("UMIAK_GUEST_SUBNET must be an IPv4 /24 network");
	return value;
}
