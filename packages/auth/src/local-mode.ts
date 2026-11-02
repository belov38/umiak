// Shared local deployment policy. An explicit empty allowlist denies everyone.
import { BlockList, isIP } from "node:net";
import type { SessionHeaders } from "./identity.ts";

type Environment = Record<string, string | undefined>;
export const LOCAL_USER_SUB = "umiak:local";
export const LOCAL_USER_EMAIL = "local@umiak.invalid";
export const LOCAL_OPERATOR_GROUP = "umiak-local-operator";
export const DEFAULT_LOCAL_ALLOWED_CIDRS = [
	"127.0.0.0/8",
	"::1/128",
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"fc00::/7",
] as const;

export function authMode(env: Environment = process.env): "oidc" | "none" {
	const mode = env.UMIAK_AUTH_MODE || "oidc";
	if (mode !== "oidc" && mode !== "none")
		throw new Error("UMIAK_AUTH_MODE must be oidc or none");
	return mode;
}

export function localAllowedCidrs(env: Environment = process.env): string[] {
	const cidrs =
		env.UMIAK_LOCAL_ALLOWED_CIDRS === undefined
			? [...DEFAULT_LOCAL_ALLOWED_CIDRS]
			: env.UMIAK_LOCAL_ALLOWED_CIDRS.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
	for (const cidr of cidrs) {
		const [ip, prefix, extra] = cidr.split("/");
		const family = ip === undefined ? 0 : isIP(ip);
		if (
			!family ||
			prefix === undefined ||
			extra !== undefined ||
			!/^\d+$/.test(prefix) ||
			Number(prefix) > (family === 4 ? 32 : 128)
		)
			throw new Error(`invalid UMIAK_LOCAL_ALLOWED_CIDRS entry: ${cidr}`);
	}
	return cidrs;
}

export function isLocalClientAllowed(
	ip: string | undefined,
	env: Environment = process.env,
): boolean {
	const list = new BlockList();
	for (const cidr of localAllowedCidrs(env)) {
		const [address, prefix] = cidr.split("/") as [string, string];
		list.addSubnet(
			address,
			Number(prefix),
			isIP(address) === 6 ? "ipv6" : "ipv4",
		);
	}
	const normalized = ip?.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
	if (!normalized || !isIP(normalized)) return false;
	return list.check(normalized, isIP(normalized) === 6 ? "ipv6" : "ipv4");
}

export function localSessionHeaders(): SessionHeaders {
	return {
		user: LOCAL_USER_SUB,
		email: LOCAL_USER_EMAIL,
		name: "Local user",
		preferredUsername: "local",
		groups: [LOCAL_OPERATOR_GROUP],
	};
}
