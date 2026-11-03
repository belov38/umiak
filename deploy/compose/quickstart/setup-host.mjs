// Pinned, read-only Proxmox transport and restricted node-agent checks.

import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import https from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import tls from "node:tls";

export const fingerprintOf = (raw) =>
	createHash("sha256").update(raw).digest("hex");
export const normalizedFingerprint = (value) =>
	String(value ?? "")
		.replaceAll(":", "")
		.toLowerCase();
export async function atomicSecret(dir, name, value) {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, name);
	const temp = `${path}.new`;
	await writeFile(temp, value, { mode: 0o600 });
	await rename(temp, path);
}
export async function readOptional(dir, name) {
	try {
		return await readFile(join(dir, name), "utf8");
	} catch (e) {
		if (e.code === "ENOENT") return "";
		throw e;
	}
}
export function pinnedPve(connection, tokenSecret) {
	let leaf;
	const agent = new https.Agent({ keepAlive: false });
	agent.createConnection = (options, cb) => {
		const socket = tls.connect({
			...options,
			rejectUnauthorized: false,
			servername: connection.tlsName || new URL(connection.apiUrl).hostname,
		});
		const fail = (error) => {
			socket.destroy();
			cb(error);
		};
		socket.once("error", fail);
		socket.once("secureConnect", () => {
			const cert = socket.getPeerCertificate(true);
			if (
				!cert.raw ||
				fingerprintOf(cert.raw) !==
					normalizedFingerprint(connection.fingerprint)
			)
				return fail(
					new Error(
						"Proxmox TLS fingerprint mismatch; verify the fingerprint at the host console",
					),
				);
			leaf = new X509Certificate(cert.raw).toString();
			socket.removeListener("error", fail);
			cb(null, socket);
		});
	};
	return {
		certificate: () => leaf,
		get(path) {
			if (!/^\/[a-zA-Z0-9_@!./%-]+$/.test(path))
				throw new Error("Invalid PVE API path");
			const url = new URL(`/api2/json${path}`, connection.apiUrl);
			return new Promise((resolve, reject) => {
				const request = https.get(
					url,
					{
						agent,
						headers: tokenSecret
							? {
									Authorization: `PVEAPIToken=${connection.tokenId}=${tokenSecret}`,
								}
							: {},
						timeout: 15000,
					},
					(response) => {
						let body = "";
						response.on("data", (chunk) => {
							body += chunk;
							if (body.length > 2_000_000)
								request.destroy(new Error("PVE response too large"));
						});
						response.on("end", () => {
							if (response.statusCode !== 200)
								return reject(
									Object.assign(
										new Error(
											`PVE ${path}: HTTP ${response.statusCode}; check token permissions`,
										),
										{ status: response.statusCode },
									),
								);
							try {
								resolve(JSON.parse(body).data);
							} catch {
								reject(new Error("Invalid PVE JSON response"));
							}
						});
					},
				);
				request.on("timeout", () =>
					request.destroy(new Error("PVE request timed out")),
				);
				request.on("error", reject);
			});
		},
	};
}
export async function checkNode(connection, secretsDir) {
	const key = join(secretsDir, "umiak-node_ed25519");
	const known = join(secretsDir, "known_hosts");
	const host = connection.sshHost || new URL(connection.apiUrl).hostname;
	if (!/^[a-zA-Z0-9.:-]+$/.test(host) || host.startsWith("-"))
		throw new Error("Invalid node SSH host");
	return new Promise((resolve, reject) => {
		const child = spawn(
			"ssh",
			[
				"-T",
				"-o",
				"BatchMode=yes",
				"-o",
				"StrictHostKeyChecking=yes",
				"-o",
				`UserKnownHostsFile=${known}`,
				"-o",
				"ConnectTimeout=10",
				"-i",
				key,
				`root@${host}`,
				"umiak-node",
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let output = "";
		child.stdout.on("data", (c) => {
			output += c;
			if (output.length > 1_000_000) child.kill();
		});
		child.stderr.resume();
		const timer = setTimeout(() => child.kill(), 20000);
		timer.unref();
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0)
				return reject(
					new Error(
						"Node-agent SSH verification failed; check the restricted key and pinned known_hosts",
					),
				);
			try {
				const result = JSON.parse(output);
				if (result.error) throw new Error("node-agent rejected version");
				resolve(result.result ?? result);
			} catch {
				reject(new Error("Node-agent returned an invalid version response"));
			}
		});
		child.stdin.end(
			`${JSON.stringify({
				op: "version",
				args: {},
				requestId: "quickstart-verify",
			})}\n`,
		);
	});
}

function ipNumber(address) {
	const family = isIP(address);
	if (!family) throw new Error("Invalid firewall address");
	if (family === 4)
		return address
			.split(".")
			.reduce((value, part) => (value << 8n) + BigInt(part), 0n);
	let value = address.toLowerCase();
	if (value.includes(".")) {
		const index = value.lastIndexOf(":");
		const v4 = ipNumber(value.slice(index + 1));
		value = `${value.slice(0, index)}:${(v4 >> 16n).toString(16)}:${(v4 & 65535n).toString(16)}`;
	}
	const halves = value.split("::");
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const parts =
		halves.length === 2
			? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
			: left;
	return parts.reduce(
		(result, part) => (result << 16n) + BigInt(`0x${part}`),
		0n,
	);
}
function cidrRange(cidr) {
	const [address, rawBits, ...extra] = String(cidr).split("/");
	const family = isIP(address);
	const width = family === 4 ? 32 : 128;
	const bits = rawBits === undefined ? width : Number(rawBits);
	if (
		!family ||
		extra.length ||
		!Number.isInteger(bits) ||
		bits < 0 ||
		bits > width
	)
		throw new Error("Invalid firewall CIDR");
	const size = 1n << BigInt(width - bits);
	const start = (ipNumber(address) / size) * size;
	return { family, start, end: start + size - 1n };
}
function rangesCover(ranges, cidr) {
	const target = cidrRange(cidr);
	let next = target.start;
	for (const range of ranges
		.filter((range) => range.family === target.family)
		.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))) {
		if (range.end < next) continue;
		if (range.start > next) return false;
		next = range.end + 1n;
		if (next > target.end) return true;
	}
	return false;
}
function destinationRanges(dest, ipset, sets) {
	const entries =
		dest === "+umiak-gateway"
			? ipset
			: dest?.startsWith("+")
				? sets[dest.slice(1)]
				: [{ cidr: dest }];
	return (entries || [])
		.filter(
			(item) =>
				item.cidr && !item.nomatch && !String(item.cidr).startsWith("!"),
		)
		.map((item) => cidrRange(item.cidr));
}
export function verifyIsolation(rules, ipset, gateway, sets = {}) {
	if (!Array.isArray(rules) || !Array.isArray(ipset))
		throw new Error("Missing firewall rules or gateway IPSet");
	for (const item of ipset) {
		if (item.nomatch) continue;
		const range = cidrRange(item.cidr);
		if (range.start !== range.end)
			throw new Error(
				"Gateway IPSet must contain individual endpoint IPs, not whole networks",
			);
	}
	const enabled = rules
		.filter((rule) => Number(rule.enable ?? 1) !== 0 && rule.type === "out")
		.map((rule, index) => ({ ...rule, index: Number(rule.pos ?? index) }))
		.sort((a, b) => a.index - b.index);
	const unrestricted = (rule) =>
		!rule.source &&
		!rule.sport &&
		!rule.dport &&
		!rule.proto &&
		!rule.icmp_type;
	const accepts = enabled.filter((rule) => rule.action === "ACCEPT");
	for (const rule of accepts) {
		const expected =
			rule.dest === "+umiak-gateway" &&
			!rule.source &&
			!rule.sport &&
			!rule.icmp_type &&
			((rule.proto === "tcp" && String(rule.dport) === "443") ||
				(rule.proto === "udp" && String(rule.dport) === "3478"));
		if (!expected)
			throw new Error(
				"Unexpected ACCEPT rule can bypass sandbox isolation; inspect the Umiak egress group",
			);
	}
	const gatewayRule = accepts.find(
		(rule) => rule.proto === "tcp" && String(rule.dport) === "443",
	);
	if (!gatewayRule)
		throw new Error(
			"Gateway firewall must allow only the designated tcp/443 endpoint",
		);
	const drops = enabled.filter(
		(rule) => ["DROP", "REJECT"].includes(rule.action) && unrestricted(rule),
	);
	const ranges = drops.flatMap((rule) =>
		destinationRanges(rule.dest, ipset, sets),
	);
	for (const cidr of [
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"100.64.0.0/10",
		"169.254.0.0/16",
		"224.0.0.0/4",
		"::/0",
	]) {
		if (!rangesCover(ranges, cidr))
			throw new Error(
				`Sandbox firewall deny coverage is incomplete for ${cidr}; verify the referenced deny IPSets`,
			);
	}
	if (gateway) {
		const family = isIP(gateway);
		if (!family)
			throw new Error(
				"Gateway address must be a literal IP for IPSet verification",
			);
		if (!rangesCover(destinationRanges("+umiak-gateway", ipset, sets), gateway))
			throw new Error(
				"Guest gateway address is absent from the verified umiak-gateway IPSet",
			);
		const blocking = drops.find(
			(rule) =>
				rule.index < gatewayRule.index &&
				rangesCover(destinationRanges(rule.dest, ipset, sets), gateway),
		);
		if (blocking)
			throw new Error(
				"Gateway tcp/443 rule must precede the deny rule covering its address",
			);
	}
	return true;
}

export async function verifyFirewall(api, connection) {
	const firewall = await api.get("/cluster/firewall/options");
	if (Number(firewall.enable) !== 1)
		throw new Error("Cluster firewall must be enabled");
	const nodeFirewall = await api.get(
		`/nodes/${connection.node}/firewall/options`,
	);
	if (Number(nodeFirewall.enable ?? 1) !== 1)
		throw new Error("Node firewall must be enabled");
	const vms = await api.get(`/nodes/${connection.node}/qemu`);
	for (const vm of Array.isArray(vms) ? vms : []) {
		const id = Number(vm.vmid);
		if (!((id >= 500 && id <= 589) || (id >= 595 && id <= 598))) continue;
		const config = await api.get(`/nodes/${connection.node}/qemu/${id}/config`);
		if (
			!String(config.tags || "")
				.split(";")
				.some((tag) => tag === "umiak-tpl" || tag.startsWith("umiak"))
		)
			continue;
		const options = await api.get(
			`/nodes/${connection.node}/qemu/${id}/firewall/options`,
		);
		if (Number(options.enable ?? 0) !== 1)
			throw new Error(`VM ${id} firewall must be enabled`);
		for (const [key, value] of Object.entries(config)) {
			if (
				/^net\d+$/.test(key) &&
				!/(?:^|,)firewall=1(?:,|$)/.test(String(value))
			)
				throw new Error(`VM ${id} ${key} firewall must be enabled`);
		}
	}
	return { firewall, nodeFirewall };
}

export async function verifyAdoption(api, connection, nodeCheck) {
	const uid = connection.tokenId.split("!")[0];
	const token = connection.tokenId.split("!")[1];
	const checks = [];
	await verifyFirewall(api, connection);
	checks.push({ name: "enabled cluster, node and VM firewalls", ok: true });
	const check = async (name, path, valid = () => true) => {
		const result = await api.get(path);
		if (!valid(result))
			throw new Error(`${name}: existing object does not match Umiak setup`);
		checks.push({ name, ok: true });
		return result;
	};
	await check(
		"user",
		`/access/users/${encodeURIComponent(uid)}`,
		(x) => Number(x.enable ?? 1) === 1,
	);
	await check(
		"token",
		`/access/users/${encodeURIComponent(uid)}/token/${encodeURIComponent(token)}`,
	);
	await check("permissions", "/access/permissions", (x) =>
		Boolean(x["/pool/umiak"]?.["VM.Audit"] || x["/"]?.["VM.Audit"]),
	);
	await check("pool", "/pools/umiak");
	await check(
		"SDN zone",
		"/cluster/sdn/zones/umiak",
		(x) => x.type === "simple",
	);
	await check(
		"SDN VNet",
		"/cluster/sdn/vnets/umiak0",
		(x) => x.zone === "umiak",
	);
	const ipset = await check(
		"gateway IPSet",
		"/cluster/firewall/ipset/umiak-gateway",
		(x) => Array.isArray(x) && x.some((y) => y.cidr),
	);
	const rules = await check(
		"egress firewall rules",
		"/cluster/firewall/groups/umiak-egress",
		(x) => Array.isArray(x) && x.length > 0,
	);
	const denySets = {};
	for (const name of ["umiak-deny", "umiak-deny6", "umiak-deny-public"]) {
		if (rules.some((rule) => rule.dest === `+${name}`))
			denySets[name] = await check(
				`${name} IPSet`,
				`/cluster/firewall/ipset/${name}`,
				Array.isArray,
			);
	}
	verifyIsolation(rules, ipset, undefined, denySets);
	const node = await nodeCheck();
	if (
		!node.version ||
		node.config?.vmidMin !== 500 ||
		node.config?.vmidMax !== 589 ||
		node.config?.vnet !== "umiak0"
	)
		throw new Error(
			"Node-agent configuration must use VMIDs 500–589 and VNet umiak0",
		);
	checks.push({ name: "restricted node-agent", ok: true });
	return { checks, nodeVersion: node.version, ipset, rules, denySets };
}
