// Local-only HTTP ingress. Never expose the upstream Next.js listener.
import http from "node:http";
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
	denied = process.env.UMIAK_LOCAL_DENIED_CIDRS ?? "10.88.0.0/24",
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
export function startIngress() {
	const allowed = clientGuard(process.env.UMIAK_LOCAL_ALLOWED_CIDRS);
	const expectedHost = new URL(
		process.env.UMIAK_APP_ORIGIN ?? "http://localhost:4180",
	).host;
	let observed = 0;
	const validHost = (req) => {
		if (observed++ < 10)
			console.info(
				"local ingress observed socket peer (may be Docker NAT)",
				req.socket.remoteAddress,
			);
		return req.headers.host === expectedHost;
	};
	const route = (url) =>
		url.startsWith("/mcp")
			? ["mcp", 8080, url]
			: url.startsWith("/api/")
				? ["api", 8081, url.slice(4)]
				: ["web", 3000, url];
	const headers = (req) => ({
		...req.headers,
		"x-forwarded-for": req.socket.remoteAddress,
		"x-umiak-client-ip": req.socket.remoteAddress,
		"x-forwarded-proto": "http",
		"x-forwarded-host": expectedHost,
	});
	const server = http.createServer((req, res) => {
		if (req.url.startsWith("/umiak-auth/")) {
			res.writeHead(403);
			res.end("SSO is unavailable in local mode");
			return;
		}
		if (!validHost(req)) {
			res.writeHead(421);
			res.end("local_host_forbidden");
			return;
		}
		if (!allowed(req.socket.remoteAddress)) {
			res.writeHead(403);
			res.end("local_network_forbidden");
			return;
		}
		const [host, port, path] = route(req.url);
		const upstream = http.request(
			{ host, port, path, method: req.method, headers: headers(req) },
			(reply) => {
				res.writeHead(reply.statusCode, reply.headers);
				reply.pipe(res);
			},
		);
		upstream.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		req.on("aborted", () => upstream.destroy());
		req.pipe(upstream);
	});
	server.on("upgrade", (req, socket, head) => {
		if (!validHost(req)) {
			socket.end(
				"HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n",
			);
			return;
		}
		if (!allowed(req.socket.remoteAddress)) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		const [host, port, path] = route(req.url);
		const upstream = net.connect(port, host, () => {
			upstream.write(
				`${req.method} ${path} HTTP/1.1\r\n${Object.entries(headers(req))
					.map(([k, v]) => `${k}: ${v}`)
					.join("\r\n")}\r\n\r\n`,
			);
			upstream.write(head);
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
		socket.on("close", () => upstream.destroy());
	});
	server.listen(4180, "0.0.0.0");
	return server;
}
if (process.argv[1]?.endsWith("/ingress.mjs")) startIngress();
