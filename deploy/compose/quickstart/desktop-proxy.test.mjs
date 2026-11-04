import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signDesktop } from "./desktop-proxy.mjs";
import { MemoryOwnerRepository, OwnerStore } from "./owner.mjs";
import { createQuickstartServer } from "./server.mjs";

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const DOMAIN = "umiak.100-64-1-2.sslip.io";
const SLUG = "brave-otter-lake";

test("signDesktop reproduces the gateway golden vector", () => {
	assert.equal(
		signDesktop(KEY, "brave-otter-lake-desktop", 1800000000),
		"brave-otter-lake-desktop.1800000030.w5ToK3OgWoDIjQyZJxRrOLHdue4nMbyOKoD_UQbfkgo",
	);
	assert.match(
		signDesktop(KEY, "Brave-Otter-Lake-Desktop", 1800000000),
		/^brave-otter-lake-desktop\.1800000030\./,
	);
});

test("Dockerfile pins the same moonlight-web release and SHA256 as the desktop template", () => {
	const dockerfile = readFileSync(
		new URL("./Dockerfile", import.meta.url),
		"utf8",
	);
	const versions = readFileSync(
		new URL(
			"../../../infra/templates/linux-desktop/versions.toml",
			import.meta.url,
		),
		"utf8",
	);
	const pin = versions.match(
		/^moonlight_web = \{ version = "([^"]+)", sha256 = "([0-9a-f]{64})" \}$/m,
	);
	assert.ok(pin, "moonlight_web pin in versions.toml");
	assert.equal(
		dockerfile.match(/^ARG MOONLIGHT_WEB_VERSION=(\S+)$/m)?.[1],
		pin[1],
	);
	assert.equal(
		dockerfile.match(/^ARG MOONLIGHT_WEB_SHA256=(\S+)$/m)?.[1],
		pin[2],
	);
	assert.match(dockerfile, /sha256sum -c/);
	assert.match(
		dockerfile,
		/releases\/download\/v\$\{MOONLIGHT_WEB_VERSION\}\/moonlight-web-x86_64-unknown-linux-gnu\.tar\.gz/,
	);
	assert.match(dockerfile, /\/app\/quickstart-assets\/moonlight-web/);
});

function verifyIngress(value, label) {
	const [l, exp, mac] = value.split(".");
	assert.equal(l, label);
	const now = Math.floor(Date.now() / 1000);
	assert.ok(Number(exp) > now && Number(exp) <= now + 60);
	assert.equal(
		mac,
		createHmac("sha256", KEY).update(`${l}.${exp}`).digest("base64url"),
	);
}

async function fixture(t) {
	const assets = mkdtempSync(join(tmpdir(), "umiak-desktop-assets-"));
	mkdirSync(assets, { recursive: true });
	writeFileSync(join(assets, "stream.html"), "<!doctype html>TRUSTED-STREAM");
	writeFileSync(join(assets, "stream.js"), "console.log('trusted')");
	writeFileSync(join(assets, "5d0c0d09e21580d5f403.wasm"), "\0asm");
	writeFileSync(join(assets, "moonlight.svg"), "<svg/>");
	writeFileSync(join(assets, "index.html"), "UPSTREAM-INDEX");
	writeFileSync(join(assets, "manifest.json"), "{}");

	const seen = [];
	const replies = new Map();
	const gateway = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.push({
				method: req.method,
				url: req.url,
				headers: req.headers,
				body: Buffer.concat(chunks).toString(),
			});
			const reply = replies.get(`${req.method} ${req.url.split("?")[0]}`);
			if (!reply) {
				res.writeHead(404, { "content-type": "application/json" });
				return res.end('{"error":"missing"}');
			}
			reply(req, res);
		});
	});
	const upgrades = [];
	let upgradeReply = (socket) => {
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: guest=1\r\nSec-WebSocket-Accept: abc\r\n\r\nHELLO",
		);
		socket.on("data", (d) => socket.write(d));
	};
	const open = new Set();
	gateway.on("upgrade", (req, socket) => {
		open.add(socket);
		socket.on("close", () => open.delete(socket));
		upgrades.push({ url: req.url, headers: req.headers });
		upgradeReply(socket);
	});
	await new Promise((r) => gateway.listen(0, "127.0.0.1", r));

	const store = new OwnerStore(new MemoryOwnerRepository());
	const browserToken = await store.claim(await store.init());
	const pair = await store.pairStart();
	await store.pairApprove(pair.id, pair.code);
	const cliToken = await store.pairPoll(pair.id, pair.secret);
	const server = createQuickstartServer({
		store,
		env: { UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24" },
		transport: http,
		desktop: () => ({
			key: KEY,
			gatewayUrl: `http://127.0.0.1:${gateway.address().port}`,
			previewDomain: DOMAIN,
			assetsDir: assets,
		}),
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const origin = `http://127.0.0.1:${port}`;
	t.after(async () => {
		server.closeAllConnections();
		gateway.closeAllConnections();
		for (const socket of open) socket.destroy();
		await new Promise((r) => server.close(r));
		await new Promise((r) => gateway.close(r));
	});
	const cookie = `__Host-umiak_owner=${browserToken}`;
	const call = (path, { method = "GET", headers = {}, body } = {}) =>
		new Promise((resolve, reject) => {
			const req = http.request(
				{
					host: "127.0.0.1",
					port,
					path,
					method,
					headers: { cookie, ...headers },
				},
				(res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () =>
						resolve({
							status: res.statusCode,
							headers: res.headers,
							body: Buffer.concat(chunks).toString(),
						}),
					);
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	const rawUpgrade = (path, headers = {}, send) =>
		new Promise((resolve) => {
			const socket = net.connect(port, "127.0.0.1", () => {
				const all = {
					host: `127.0.0.1:${port}`,
					connection: "Upgrade",
					upgrade: "websocket",
					"sec-websocket-version": "13",
					"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
					cookie,
					origin,
					...headers,
				};
				socket.write(
					`GET ${path} HTTP/1.1\r\n${Object.entries(all)
						.filter(([, v]) => v !== undefined)
						.map(([k, v]) => `${k}: ${v}`)
						.join("\r\n")}\r\n\r\n`,
				);
			});
			let data = "";
			socket.on("data", (d) => {
				data += d;
				if (send && data.includes("HELLO")) {
					socket.write(send);
					send = undefined;
				}
				if (data.includes("PING-ECHO")) socket.destroy();
			});
			const timer = setTimeout(() => socket.destroy(), 3000);
			socket.on("close", () => {
				clearTimeout(timer);
				resolve(data);
			});
			socket.on("end", () => socket.destroy());
			socket.on("error", () => {});
		});
	return {
		call,
		rawUpgrade,
		replies,
		seen,
		upgrades,
		origin,
		cliToken,
		setUpgradeReply: (fn) => {
			upgradeReply = fn;
		},
	};
}

test("config.js carries the per-slug path prefix", async (t) => {
	const f = await fixture(t);
	const res = await f.call(`/desktop/${SLUG}/config.js`);
	assert.equal(res.status, 200);
	assert.match(res.headers["content-type"], /^text\/javascript/);
	assert.equal(
		res.body,
		`window.__CONFIG_JS__ = {"path_prefix":"/desktop/${SLUG}"};\n`,
	);
	assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
	const other = await f.call("/desktop/quiet-red-fox/config.js");
	assert.match(other.body, /"\/desktop\/quiet-red-fox"/);
	assert.equal(f.seen.length, 0);
});

test("viewer files come from the trusted assets directory only", async (t) => {
	const f = await fixture(t);
	const html = await f.call(`/desktop/${SLUG}/stream.html?hostId=1&appId=2`);
	assert.equal(html.status, 200);
	assert.equal(html.body, "<!doctype html>TRUSTED-STREAM");
	assert.match(html.headers["content-type"], /^text\/html/);
	assert.equal(html.headers["x-frame-options"], "SAMEORIGIN");
	const js = await f.call(`/desktop/${SLUG}/stream.js`);
	assert.match(js.headers["content-type"], /^text\/javascript/);
	const wasm = await f.call(`/desktop/${SLUG}/5d0c0d09e21580d5f403.wasm`);
	assert.equal(wasm.headers["content-type"], "application/wasm");
	const svg = await f.call(`/desktop/${SLUG}/moonlight.svg`);
	assert.equal(svg.headers["content-type"], "image/svg+xml");
	assert.equal((await f.call(`/desktop/${SLUG}/manifest.json`)).status, 200);
	for (const file of ["index.html", "admin.html", "nope.js", "x.css"])
		assert.equal((await f.call(`/desktop/${SLUG}/${file}`)).status, 404);
	assert.equal(f.seen.length, 0);
});

test("opening the desktop proxies GET / and rewrites the stream redirect", async (t) => {
	const f = await fixture(t);
	f.replies.set("GET /", (_req, res) => {
		res.writeHead(302, {
			location: "/stream.html?appId=7&dataTransport=websocket&fps=60&hostId=3",
			"set-cookie": "guest=1",
		});
		res.end();
	});
	const ok = await f.call(
		`/desktop/${SLUG}/?dataTransport=websocket&fps=60&bitrate=20000&evil=1`,
	);
	assert.equal(ok.status, 302);
	assert.equal(
		ok.headers.location,
		`/desktop/${SLUG}/stream.html?appId=7&dataTransport=websocket&fps=60&hostId=3`,
	);
	assert.equal(ok.headers["set-cookie"], undefined);
	assert.equal(ok.headers["x-frame-options"], "SAMEORIGIN");
	const sent = f.seen.at(-1);
	assert.equal(sent.url, "/?dataTransport=websocket&fps=60&bitrate=20000");
	assert.equal(sent.headers.host, `${SLUG}-desktop.${DOMAIN}:8085`);
	assert.equal(sent.headers.cookie, undefined);
	assert.equal(sent.headers.authorization, undefined);
	verifyIngress(sent.headers["umiak-ingress-desktop"], `${SLUG}-desktop`);
});

test("a starting desktop gets the owner's own Starting page, never the gateway HTML", async (t) => {
	const f = await fixture(t);
	f.replies.set("GET /", (_req, res) => {
		res.writeHead(503, {
			"content-type": "text/html; charset=utf-8",
			"umiak-error": "desktop_starting",
			"retry-after": "5",
		});
		res.end("<script>GATEWAY-HTML</script>");
	});
	const res = await f.call(`/desktop/${SLUG}/?dataTransport=websocket`);
	assert.equal(res.status, 503);
	assert.match(res.headers["content-type"], /^text\/html/);
	assert.match(res.body, /Starting the desktop…/);
	assert.match(res.body, /This takes up to a minute\./);
	assert.match(res.body, /<meta http-equiv="refresh" content="5">/);
	assert.doesNotMatch(res.body, /GATEWAY-HTML/);
	assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");

	f.replies.set("GET /", (_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<script>GUEST-HTML</script>");
	});
	const odd = await f.call(`/desktop/${SLUG}/?dataTransport=websocket`);
	assert.equal(odd.status, 502);
	assert.doesNotMatch(odd.body, /GUEST-HTML/);
});

test("the stream-end navigation shows a Stream ended page with Reconnect", async (t) => {
	const f = await fixture(t);
	const res = await f.call(`/desktop/${SLUG}/`);
	assert.equal(res.status, 200);
	assert.match(res.body, /Stream ended/);
	assert.match(res.body, /<button[^>]*>Reconnect<\/button>/);
	assert.match(res.body, new RegExp(`action="/desktop/${SLUG}/"`));
	assert.match(res.body, /name="dataTransport" value="websocket"/);
	assert.equal(f.seen.length, 0);
	const bare = await f.call(`/desktop/${SLUG}?fps=30`);
	assert.equal(bare.status, 302);
	assert.equal(bare.headers.location, `/desktop/${SLUG}/?fps=30`);
});

test("API calls are proxied as data with the prefix stripped and credentials replaced", async (t) => {
	const f = await fixture(t);
	f.replies.set("POST /api/host/stream/webrtc", (_req, res) => {
		res.writeHead(201, {
			"content-type": "application/sdp",
			"set-cookie": "guest=1",
			refresh: "0;url=https://evil",
			link: "<https://evil>; rel=preload",
		});
		res.end("v=0 answer");
	});
	const res = await f.call(`/desktop/${SLUG}/api/host/stream/webrtc?x=1`, {
		method: "POST",
		headers: {
			origin: f.origin,
			"content-type": "application/sdp",
			"x-forwarded-for": "6.6.6.6",
		},
		body: "v=0 offer",
	});
	assert.equal(res.status, 201);
	assert.equal(res.body, "v=0 answer");
	assert.equal(res.headers["content-type"], "application/sdp");
	assert.equal(res.headers["set-cookie"], undefined);
	assert.equal(res.headers.refresh, undefined);
	assert.equal(res.headers.link, undefined);
	assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
	const sent = f.seen.at(-1);
	assert.equal(sent.url, "/api/host/stream/webrtc?x=1");
	assert.equal(sent.body, "v=0 offer");
	assert.equal(sent.headers.host, `${SLUG}-desktop.${DOMAIN}:8085`);
	assert.equal(sent.headers.cookie, undefined);
	assert.equal(sent.headers.authorization, undefined);
	assert.equal(sent.headers["x-forwarded-for"], undefined);
	assert.equal(sent.headers.origin, undefined);
	verifyIngress(sent.headers["umiak-ingress-desktop"], `${SLUG}-desktop`);

	f.replies.set("GET /api/user", (_req, res) => {
		res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
		res.end('{"name":"umiak"}');
	});
	assert.equal(
		(await f.call(`/desktop/${SLUG}/api/user`)).body,
		'{"name":"umiak"}',
	);
	f.replies.set("PATCH /api/host/stream/webrtc", (_req, res) => {
		res.writeHead(204);
		res.end();
	});
	assert.equal(
		(
			await f.call(`/desktop/${SLUG}/api/host/stream/webrtc`, {
				method: "PATCH",
				headers: {
					origin: f.origin,
					"content-type": "application/trickle-ice-sdpfrag",
				},
				body: "a=candidate",
			})
		).status,
		204,
	);
});

test("non-data upstream responses become 502 desktop_upstream_rejected", async (t) => {
	const f = await fixture(t);
	const cases = [
		["text/html; charset=utf-8", "<script>alert(1)</script>"],
		["application/javascript", "alert(1)"],
		["text/javascript", "alert(1)"],
		["image/svg+xml", "<svg onload=alert(1)/>"],
		[undefined, "untyped body"],
	];
	for (const [type, body] of cases) {
		f.replies.set("GET /api/authenticate", (_req, res) => {
			res.writeHead(200, type ? { "content-type": type } : {});
			res.end(body);
		});
		const res = await f.call(`/desktop/${SLUG}/api/authenticate`);
		assert.equal(res.status, 502, String(type));
		assert.deepEqual(JSON.parse(res.body), {
			error: "desktop_upstream_rejected",
		});
		assert.match(res.headers["content-type"], /^application\/json/);
	}
	f.replies.set("GET /api/authenticate", (_req, res) => {
		res.writeHead(200);
		res.end();
	});
	assert.equal((await f.call(`/desktop/${SLUG}/api/authenticate`)).status, 200);
});

test("only browser owner sessions with an exact Origin may use the desktop", async (t) => {
	const f = await fixture(t);
	f.replies.set("POST /api/login", (_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	});
	const cli = await f.call(`/desktop/${SLUG}/config.js`, {
		headers: { cookie: "", authorization: `Bearer ${f.cliToken}` },
	});
	assert.equal(cli.status, 403);
	assert.equal(
		(await f.call(`/desktop/${SLUG}/config.js`, { headers: { cookie: "" } }))
			.status,
		401,
	);
	const post = (headers) =>
		f.call(`/desktop/${SLUG}/api/login`, {
			method: "POST",
			headers,
			body: "{}",
		});
	assert.equal((await post({})).status, 403, "missing Origin");
	assert.equal((await post({ origin: "http://evil" })).status, 403);
	assert.equal((await post({ origin: f.origin })).status, 200);
	assert.equal(f.seen.length, 1);
});

test("malformed or traversing slugs are 404 without reaching the gateway", async (t) => {
	const f = await fixture(t);
	for (const path of [
		"/desktop/../desktop/brave-otter-lake/config.js",
		"/desktop/brave-otter-lake/../config.js",
		"/desktop/brave%2Fotter/config.js",
		"/desktop/brave-otter-lake/%2e%2e/config.js",
		"/desktop/brave-otter-lake/api%2fuser",
		"/desktop/Brave-Otter-Lake/config.js",
		"/desktop/brave_otter/config.js",
		"/desktop/brave-otter-lake-desktop/config.js",
		"/desktop/brave-otter-lake/sub/stream.js",
		"/desktop//config.js",
		"/desktop/",
	]) {
		const res = await f.call(path);
		assert.equal(res.status, 404, path);
	}
	assert.equal(f.seen.length, 0);
});

test("WebSocket upgrade relays only after an upstream 101", async (t) => {
	const f = await fixture(t);
	const ok = await f.rawUpgrade(
		`/desktop/${SLUG}/api/host/stream/web_socket`,
		{},
		"PING-ECHO",
	);
	assert.match(ok, /^HTTP\/1\.1 101 /);
	assert.doesNotMatch(ok, /set-cookie/i);
	assert.match(ok, /HELLO/);
	assert.match(ok, /PING-ECHO/);
	const up = f.upgrades.at(-1);
	assert.equal(up.url, "/api/host/stream/web_socket");
	assert.equal(up.headers.host, `${SLUG}-desktop.${DOMAIN}:8085`);
	assert.equal(up.headers.cookie, undefined);
	assert.equal(up.headers.origin, undefined);
	verifyIngress(up.headers["umiak-ingress-desktop"], `${SLUG}-desktop`);

	f.setUpgradeReply((socket) =>
		socket.end(
			"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 30\r\n\r\n<script>UPSTREAM-HTML</script>",
		),
	);
	const bad = await f.rawUpgrade(`/desktop/${SLUG}/api/host/stream/web_socket`);
	assert.doesNotMatch(bad, /UPSTREAM-HTML/);
	assert.doesNotMatch(bad, /^HTTP\/1\.1 (101|200)/);

	const count = f.upgrades.length;
	assert.doesNotMatch(
		await f.rawUpgrade(`/desktop/${SLUG}/api/host/stream/web_socket`, {
			origin: undefined,
		}),
		/^HTTP\/1\.1 101/,
	);
	assert.doesNotMatch(
		await f.rawUpgrade(`/desktop/${SLUG}/api/host/stream/web_socket`, {
			origin: "http://evil",
		}),
		/^HTTP\/1\.1 101/,
	);
	assert.doesNotMatch(
		await f.rawUpgrade(`/desktop/${SLUG}/api/host/stream/web_socket`, {
			cookie: undefined,
			authorization: `Bearer ${f.cliToken}`,
		}),
		/^HTTP\/1\.1 101/,
	);
	assert.doesNotMatch(
		await f.rawUpgrade(`/desktop/${SLUG}/api/other`),
		/^HTTP\/1\.1 101/,
	);
	assert.equal(f.upgrades.length, count);
});
