// Owner mode: the backend trusts one ingress that has already authenticated
// the owner. Invalid configuration fails startup.
import { BlockList, isIP } from "node:net";
import type { SessionHeaders } from "./identity.ts";

type Environment = Record<string, string | undefined>;
export const OWNER_USER_SUB = "umiak:local";
export const OWNER_USER_EMAIL = "local@umiak.invalid";
export const OWNER_OPERATOR_GROUP = "umiak-local-operator";

export type AuthMode = "oidc" | "owner";

/** Networks of the trusted ingress; `denied` wins over `allowed`. */
export interface CidrSet {
	allowed: readonly string[];
	denied: readonly string[];
}

export function parseAuthMode(env: Environment = process.env): AuthMode {
	const mode = env.UMIAK_AUTH_MODE || "oidc";
	if (mode !== "oidc" && mode !== "owner")
		throw new Error("UMIAK_AUTH_MODE must be oidc or owner");
	return mode;
}

function parseCidrs(name: string, raw: string): string[] {
	const cidrs = raw
		.split(",")
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
			throw new Error(`invalid ${name} entry: ${cidr}`);
	}
	return cidrs;
}

/** There is no default: the deployment names the ingress network explicitly. */
export function ownerAllowedCidrs(env: Environment = process.env): string[] {
	if (env.UMIAK_LOCAL_ALLOWED_CIDRS === undefined)
		throw new Error(
			"UMIAK_LOCAL_ALLOWED_CIDRS is required in owner mode (CIDRs of the trusted ingress)",
		);
	const cidrs = parseCidrs(
		"UMIAK_LOCAL_ALLOWED_CIDRS",
		env.UMIAK_LOCAL_ALLOWED_CIDRS,
	);
	if (!cidrs.length)
		throw new Error("UMIAK_LOCAL_ALLOWED_CIDRS must not be empty");
	return cidrs;
}

/** Literal IPs of the configured PVE node; hostnames are not resolved. */
function nodeAddresses(env: Environment): string[] {
	const out: string[] = [];
	for (const raw of [env.UMIAK_NODE_SSH_HOST, env.UMIAK_PVE_URL]) {
		if (!raw) continue;
		const host = raw.includes("://")
			? new URL(raw).hostname.replace(/^\[|\]$/g, "")
			: raw;
		const family = isIP(host);
		if (family) out.push(`${host}/${family === 4 ? 32 : 128}`);
	}
	return out;
}

export function ownerDeniedCidrs(env: Environment = process.env): string[] {
	// Literal node addresses also cover sandbox traffic SNATed by the PVE host.
	return [
		...parseCidrs(
			"UMIAK_LOCAL_DENIED_CIDRS",
			env.UMIAK_LOCAL_DENIED_CIDRS ?? "10.88.0.0/24",
		),
		...nodeAddresses(env),
	];
}

export function ownerCidrSet(env: Environment = process.env): CidrSet {
	return { allowed: ownerAllowedCidrs(env), denied: ownerDeniedCidrs(env) };
}

function matches(cidrs: readonly string[], addr: string): boolean {
	const list = new BlockList();
	for (const cidr of cidrs) {
		const [address, prefix] = cidr.split("/") as [string, string];
		list.addSubnet(
			address,
			Number(prefix),
			isIP(address) === 6 ? "ipv6" : "ipv4",
		);
	}
	return list.check(addr, isIP(addr) === 6 ? "ipv6" : "ipv4");
}

/** True when the peer address belongs to the trusted ingress network. */
export function isTrustedIngressClient(addr: string, cidrs: CidrSet): boolean {
	const normalized = addr.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
	if (!normalized || !isIP(normalized)) return false;
	return (
		!matches(cidrs.denied, normalized) && matches(cidrs.allowed, normalized)
	);
}

export function ownerSessionHeaders(): SessionHeaders {
	return {
		user: OWNER_USER_SUB,
		email: OWNER_USER_EMAIL,
		name: "Local user",
		preferredUsername: "local",
		groups: [OWNER_OPERATOR_GROUP],
	};
}
