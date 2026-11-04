// Client address admission shared by the owner ingress and its origin checks.
import net from "node:net";

function nodeAddresses(env) {
	const out = [];
	for (const raw of [env.UMIAK_NODE_SSH_HOST, env.UMIAK_PVE_URL]) {
		if (!raw) continue;
		const host = raw.includes("://")
			? new URL(raw).hostname.replace(/^\[|\]$/g, "")
			: raw;
		const family = net.isIP(host);
		if (family) out.push(`${host}/${family === 4 ? 32 : 128}`);
	}
	return out;
}

export function clientGuard(
	raw,
	denied = process.env.UMIAK_LOCAL_DENIED_CIDRS ??
		process.env.UMIAK_GUEST_SUBNET ??
		"10.88.0.0/24",
	env = process.env,
) {
	const list = new net.BlockList();
	const deny = new net.BlockList();
	const deniedEntries = denied.split(",").filter(Boolean);
	const nodes = nodeAddresses(env);
	if (env.UMIAK_LOCAL_DENIED_CIDRS === undefined && nodes.length === 0)
		console.warn(
			"WARNING: PVE node address is not a literal IP and UMIAK_LOCAL_DENIED_CIDRS is unset; set it to the node LAN address",
		);
	deniedEntries.push(...nodes);
	for (const entry of deniedEntries) {
		const [ip, bits, extra] = entry.trim().split("/");
		if (
			!net.isIP(ip) ||
			bits === undefined ||
			!/^\d+$/.test(bits) ||
			extra !== undefined
		)
			throw new Error("Invalid denied CIDR");
		deny.addSubnet(ip, Number(bits), net.isIP(ip) === 6 ? "ipv6" : "ipv4");
	}
	const entries = (
		raw ??
		"127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7"
	).split(",");
	for (const entry of entries) {
		const [ip, bits, extra] = entry.trim().split("/");
		const family = net.isIP(ip);
		if (
			!family ||
			bits === undefined ||
			!/^\d+$/.test(bits) ||
			extra !== undefined
		)
			throw new Error("Invalid local CIDR");
		if (Number(bits) === 0)
			console.warn("WARNING: local allowlist permits the entire Internet");
		list.addSubnet(ip, Number(bits), family === 6 ? "ipv6" : "ipv4");
	}
	return (address) => {
		const ip = address?.replace(/^::ffff:/, "") ?? "";
		const family = net.isIP(ip);
		return (
			family !== 0 &&
			!deny.check(ip, family === 6 ? "ipv6" : "ipv4") &&
			list.check(ip, family === 6 ? "ipv6" : "ipv4")
		);
	};
}
