// The dev auth proxy over real sockets: upstreams are plain node:http servers
// that record what reaches them.
import http from "node:http";
import type net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	type AuthProxy,
	DEV_IDENTITY_COOKIE,
	encodeIdentity,
	presets,
	startAuthProxy,
} from "../dev/auth-proxy.ts";

interface Seen {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
}

interface Upstream {
	port: number;
	seen: Seen[];
	upgrades: Seen[];
	close(): Promise<void>;
}

async function upstream(name: string): Promise<Upstream> {
	const seen: Seen[] = [];
	const upgrades: Seen[] = [];
	const sockets = new Set<net.Socket>();
	const server = http.createServer((req, res) => {
		seen.push({
			method: req.method ?? "",
			url: req.url ?? "",
			headers: req.headers,
		});
		res.writeHead(200, { "Content-Type": "text/plain" }).end(name);
	});
	server.on("upgrade", (req, socket: net.Socket) => {
		sockets.add(socket);
		upgrades.push({
			method: req.method ?? "",
			url: req.url ?? "",
			headers: req.headers,
		});
		// Answer the handshake and echo whatever comes next.
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
		);
		socket.on("data", (d) => socket.write(d));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return {
		port: (server.address() as net.AddressInfo).port,
		seen,
		upgrades,
		close: () =>
			new Promise((r) => {
				for (const s of sockets) s.destroy();
				server.closeAllConnections();
				server.close(() => r());
			}),
	};
}

function request(
	proxy: AuthProxy,
	path: string,
	o: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			`${proxy.url}${path}`,
			{ method: o.method ?? "GET", headers: o.headers ?? {} },
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (c) => {
					body += c;
				});
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
				);
			},
		);
		req.on("error", reject);
		req.end(o.body);
	});
}

const operator = presets("sbx-operators").operator;
if (operator === undefined) throw new Error("no operator preset");
const cookie = `${DEV_IDENTITY_COOKIE}=${encodeIdentity(operator)}`;

describe("dev auth proxy (S8 §13)", () => {
	let web: Upstream;
	let api: Upstream;
	let proxy: AuthProxy;

	beforeAll(async () => {
		web = await upstream("web");
		api = await upstream("api");
		proxy = await startAuthProxy({
			port: 0,
			web: { host: "127.0.0.1", port: web.port },
			api: { host: "127.0.0.1", port: api.port },
			log: () => {},
		});
	});
	afterAll(async () => {
		await proxy?.close();
		await web?.close();
		await api?.close();
	});
	const form = (origin = proxy.url) => ({
		"Content-Type": "application/x-www-form-urlencoded",
		Origin: origin,
	});

	beforeEach(() => {
		web.seen.length = 0;
		api.seen.length = 0;
		web.upgrades.length = 0;
		api.upgrades.length = 0;
	});

	it("refuses to listen on anything but 127.0.0.1", async () => {
		await expect(startAuthProxy({ host: "0.0.0.0", port: 0 })).rejects.toThrow(
			/127\.0\.0\.1 only/,
		);
		await expect(startAuthProxy({ host: "::", port: 0 })).rejects.toThrow();
		await expect(
			startAuthProxy({ host: "localhost", port: 0 }),
		).rejects.toThrow();
	});

	it("without the cookie, client X-Auth-Request-* never reach the upstream", async () => {
		const r = await request(proxy, "/app", {
			headers: {
				"X-Auth-Request-Email": "evil@x",
				"X-Auth-Request-User": "evil",
				"x-auth-request-groups": "sbx-operators",
				"X-Auth-Request-Preferred-Username": "evil",
				"X-Other": "kept",
			},
		});
		expect(r.body).toBe("web");
		const h = web.seen[0]?.headers ?? {};
		expect(
			Object.keys(h).filter((k) => k.startsWith("x-auth-request-")),
		).toEqual([]);
		expect(h["x-other"]).toBe("kept");
	});

	it("with the cookie, the headers come from it, not from the client", async () => {
		await request(proxy, "/admin", {
			headers: { Cookie: cookie, "X-Auth-Request-Email": "evil@x" },
		});
		const h = web.seen[0]?.headers ?? {};
		expect(h["x-auth-request-email"]).toBe("operator@example.com");
		expect(h["x-auth-request-user"]).toBe("dev-operator");
		expect(h["x-auth-request-groups"]).toBe("sbx-operators");
		expect(h["x-auth-request-preferred-username"]).toBe("operator");
	});

	it("routes /api/* to the api without /api, /sbx-auth/* unchanged, the rest to web", async () => {
		expect((await request(proxy, "/api/v1/me?x=1")).body).toBe("api");
		expect(api.seen[0]?.url).toBe("/v1/me?x=1");
		expect((await request(proxy, "/sbx-auth/callback?code=1")).body).toBe(
			"api",
		);
		expect(api.seen[1]?.url).toBe("/sbx-auth/callback?code=1");
		expect((await request(proxy, "/apiary")).body).toBe("web");
		expect(web.seen[0]?.url).toBe("/apiary");
	});

	it("POST bodies pass through", async () => {
		const r = await request(proxy, "/api/v1/sandboxes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(r.status).toBe(200);
		expect(api.seen[0]?.method).toBe("POST");
	});

	it("/__dev/login sets the cookie; /__dev/logout clears it", async () => {
		const page = await request(proxy, "/__dev/login");
		expect(page.status).toBe(200);
		expect(page.body).toContain('value="operator"');
		const login = await request(proxy, "/__dev/login", {
			method: "POST",
			headers: form(),
			body: "preset=user&rd=%2Fapp%2Ft%2Fx",
		});
		expect(login.status).toBe(303);
		expect(login.headers.location).toBe("/app/t/x");
		const set = String(login.headers["set-cookie"]);
		expect(set).toMatch(
			new RegExp(`^${DEV_IDENTITY_COOKIE}=[^;]+; Path=/; HttpOnly`),
		);
		// An open redirect is not followed.
		const evil = await request(proxy, "/__dev/login", {
			method: "POST",
			headers: form(),
			body: "preset=user&rd=%2F%2Fevil.example",
		});
		expect(evil.headers.location).toBe("/app");
		const back = await request(proxy, "/__dev/login", {
			method: "POST",
			headers: form(),
			body: "preset=user&rd=%2F%5Cevil.example",
		});
		expect(back.headers.location).toBe("/app");
		const out = await request(proxy, "/__dev/logout");
		expect(out.status).toBe(302);
		expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
		expect(web.seen).toEqual([]);
	});

	it("POST /__dev/login needs Origin = the proxy's own origin", async () => {
		for (const headers of [
			form("http://evil.example"),
			form("http://localhost:1"),
			{ "Content-Type": "application/x-www-form-urlencoded" },
		]) {
			const r = await request(proxy, "/__dev/login", {
				method: "POST",
				headers,
				body: "preset=operator",
			});
			expect(r.status).toBe(403);
			expect(r.headers["set-cookie"]).toBeUndefined();
		}
	});

	it("a custom identity with control characters or a comma in the email is refused", async () => {
		for (const body of [
			"email=a%40b.com%0d%0aX-Auth-Request-Groups%3a%20sbx-operators",
			"email=a%40b.com%2Cevil%40x.com",
			"email=a%40b.com&user=sub%01",
			"email=a%40b.com&user=s1%2Cs2",
			"email=a%40b.com&name=A%0aB",
			"email=a%40b.com&groups=g%09x",
		]) {
			const r = await request(proxy, "/__dev/login", {
				method: "POST",
				headers: form(),
				body,
			});
			expect(r.status, body).toBe(400);
			expect(r.headers["set-cookie"]).toBeUndefined();
		}
		const ok = await request(proxy, "/__dev/login", {
			method: "POST",
			headers: form(),
			body: "email=a%40b.com&groups=g1%2Cg2",
		});
		expect(ok.status).toBe(303);
	});

	it("a cookie identity with control characters or a comma in the email sets no headers", async () => {
		const bad = [
			{ ...operator, email: "op@example.com\r\nx-evil: 1" },
			{ ...operator, email: "op@example.com,evil@x.com" },
			{ ...operator, user: "sub\u0000" },
			{ ...operator, name: "Op\u007f" },
			{ ...operator, groups: ["sbx-operators\n"] },
		];
		for (const id of bad) {
			const r = await request(proxy, "/app", {
				headers: { cookie: `${DEV_IDENTITY_COOKIE}=${encodeIdentity(id)}` },
			});
			expect(r.status).toBe(200);
			const h = web.seen.at(-1)?.headers ?? {};
			expect(h["x-auth-request-email"]).toBeUndefined();
			expect(h["x-auth-request-user"]).toBeUndefined();
			expect(h["x-auth-request-groups"]).toBeUndefined();
		}
	});

	it("a WebSocket upgrade reaches the upstream, with the cookie's identity", async () => {
		const result = await new Promise<{ status: number; echo: string }>(
			(resolve, reject) => {
				const req = http.request(
					`${proxy.url}/api/v1/sandboxes/sb_1/ptys/c/connect`,
					{
						headers: {
							Connection: "Upgrade",
							Upgrade: "websocket",
							Cookie: cookie,
							"X-Auth-Request-Email": "evil@x",
						},
					},
				);
				req.on("upgrade", (res, socket) => {
					socket.once("data", (d: Buffer) => {
						socket.destroy();
						resolve({ status: res.statusCode ?? 0, echo: d.toString() });
					});
					socket.write("ping");
				});
				req.on("response", (res) =>
					reject(new Error(`no upgrade: ${res.statusCode}`)),
				);
				req.on("error", reject);
				req.end();
			},
		);
		expect(result).toEqual({ status: 101, echo: "ping" });
		const up = api.upgrades[0];
		expect(up?.url).toBe("/v1/sandboxes/sb_1/ptys/c/connect");
		expect(up?.headers["x-auth-request-email"]).toBe("operator@example.com");
		expect(up?.headers.upgrade).toBe("websocket");
	});

	it("an unreachable upstream is 502", async () => {
		const p = await startAuthProxy({
			port: 0,
			web: { host: "127.0.0.1", port: 1 },
			log: () => {},
		});
		try {
			expect((await request(p, "/app")).status).toBe(502);
		} finally {
			await p.close();
		}
	});
});
