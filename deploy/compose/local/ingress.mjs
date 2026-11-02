// Local-only HTTP ingress. Never expose the upstream Next.js listener.
import http from "node:http";
import net from "node:net";

export function clientGuard(raw) {
	const list = new net.BlockList();
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
		list.addSubnet(ip, Number(bits), family === 6 ? "ipv6" : "ipv4");
	}
	return (address) => {
		const ip = address?.replace(/^::ffff:/, "") ?? "";
		const family = net.isIP(ip);
		return family !== 0 && list.check(ip, family === 6 ? "ipv6" : "ipv4");
	};
}
export function startIngress() {
	const allowed = clientGuard(process.env.UMIAK_LOCAL_ALLOWED_CIDRS);
	const expectedHost = new URL(
		process.env.UMIAK_APP_ORIGIN ?? "http://localhost:4180",
	).host;
	const validHost = (req) => req.headers.host === expectedHost;
	const route = (url) =>
		url.startsWith("/api/")
			? ["api", 8081, url.slice(4)]
			: url.startsWith("/umiak-auth/")
				? ["api", 8081, url]
				: ["web", 3000, url];
	const headers = (req) => ({
		...req.headers,
		"x-forwarded-for": req.socket.remoteAddress,
		"x-umiak-client-ip": req.socket.remoteAddress,
		"x-forwarded-proto": "http",
	});
	const server = http.createServer((req, res) => {
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
