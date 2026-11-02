// Pinned, read-only Proxmox transport and restricted node-agent checks.

import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";
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
									new Error(
										`PVE ${path}: HTTP ${response.statusCode}; check token permissions`,
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

export function verifyIsolation(rules, ipset, gateway) {
	const enabled = rules.filter(
		(rule) => Number(rule.enable ?? 1) !== 0 && rule.type === "out",
	);
	if (
		!enabled.some(
			(rule) =>
				rule.action === "ACCEPT" &&
				rule.dest === "+umiak-gateway" &&
				rule.proto === "tcp" &&
				String(rule.dport) === "443",
		)
	)
		throw new Error(
			"Gateway firewall must allow only the designated tcp/443 endpoint",
		);
	const drop = enabled
		.filter((rule) => rule.action === "DROP")
		.map((rule) => rule.dest);
	if (
		!(
			drop.includes("+umiak-deny") ||
			[
				"10.0.0.0/8",
				"172.16.0.0/12",
				"192.168.0.0/16",
				"100.64.0.0/10",
				"169.254.0.0/16",
			].every((cidr) => drop.includes(cidr))
		) ||
		!(
			drop.includes("+umiak-deny6") ||
			(drop.includes("::/1") && drop.includes("8000::/1"))
		)
	)
		throw new Error(
			"Sandbox firewall must deny private, tailnet and IPv6 destinations",
		);
	if (gateway) {
		const family = isIP(gateway);
		if (!family)
			throw new Error(
				"Gateway address must be a literal IP for IPSet verification",
			);
		const list = new BlockList();
		for (const item of ipset) {
			const [address, bits] = String(item.cidr).split("/");
			if (isIP(address))
				list.addSubnet(
					address,
					Number(bits ?? (isIP(address) === 4 ? 32 : 128)),
					isIP(address) === 4 ? "ipv4" : "ipv6",
				);
		}
		if (!list.check(gateway, family === 4 ? "ipv4" : "ipv6"))
			throw new Error(
				"Guest gateway address is absent from the verified umiak-gateway IPSet",
			);
	}
	return true;
}

export async function verifyAdoption(api, connection, nodeCheck) {
	const uid = connection.tokenId.split("!")[0];
	const token = connection.tokenId.split("!")[1];
	const checks = [];
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
	verifyIsolation(rules, ipset);
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
	return { checks, nodeVersion: node.version, ipset, rules };
}
