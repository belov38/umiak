import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
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
	// R10: GPL-3.0 text from the same upstream tag, pinned and verified, plus a SOURCE note.
	assert.equal(
		dockerfile.match(/^ARG MOONLIGHT_WEB_LICENSE_SHA256=(\S+)$/m)?.[1],
		"8b1ba204bb69a0ade2bfcf65ef294a920f6bb361b317dba43c7ef29d96332b9b",
	);
	assert.match(
		dockerfile,
		/raw\.githubusercontent\.com\/MrCreativ3001\/moonlight-web-stream\/v\$\{MOONLIGHT_WEB_VERSION\}\/LICENSE/,
	);
	assert.match(
		dockerfile,
		/\$\{MOONLIGHT_WEB_LICENSE_SHA256\} {2}\/moonlight-web\/LICENSE" \| sha256sum -c -/,
	);
	assert.match(dockerfile, /> \/moonlight-web\/SOURCE/);
	const notices = readFileSync(
		new URL("./THIRD_PARTY_NOTICES.md", import.meta.url),
		"utf8",
	);
	assert.match(notices, /moonlight-web-stream/);
	assert.match(notices, /GPL-3\.0/);
	assert.match(
		notices,
		/https:\/\/github\.com\/MrCreativ3001\/moonlight-web-stream\/tree\/v3\.0\.1/,
	);
	assert.ok(notices.includes(pin[2]), "notices carry the tarball sha256");
});

const accept = (key) =>
	createHash("sha1")
		.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
		.digest("base64");
const VIEWER_CSP_RE =
	/^default-src 'none'; script-src 'self' 'wasm-unsafe-eval'.*; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'$/;
const sha = (text) =>
	`'sha256-${createHash("sha256").update(text).digest("base64")}'`;
function assertPageCsp(res) {
	const csp = res.headers["content-security-policy"];
	assert.match(csp, /^default-src 'none';/);
	assert.match(
		csp,
		/style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'$/,
	);
	assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
	for (const [, body] of res.body.matchAll(/<script>([\s\S]*?)<\/script>/g))
		assert.ok(csp.includes(sha(body)), "inline script hash in CSP");
}
const DATA_CSP = "default-src 'none'; sandbox";

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
	writeFileSync(
		join(assets, "stream.html"),
		"<!doctype html>TRUSTED-STREAM<script src=./config.js></script><script>INLINE()</script><script src=stream.js></script>",
	);
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
	let upgradeReply = (socket, req) => {
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: guest=1\r\nX-Evil: 1\r\nSec-WebSocket-Accept: ${accept(req.headers["sec-websocket-key"])}\r\n\r\nHELLO`,
		);
		socket.on("data", (d) => socket.write(d));
	};
	const open = new Set();
	gateway.on("upgrade", (req, socket) => {
		open.add(socket);
		socket.on("close", () => open.delete(socket));
		upgrades.push({ url: req.url, headers: req.headers });
		upgradeReply(socket, req);
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
	assert.ok(
		res.body.startsWith(
			`window.__CONFIG_JS__ = {"path_prefix":"/desktop/${SLUG}"};\n`,
		),
	);
	assert.match(res.body, new RegExp(`"umiak-desktop:/desktop/${SLUG}/"`));
	assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
	assert.match(res.headers["content-security-policy"], VIEWER_CSP_RE);
	const other = await f.call("/desktop/quiet-red-fox/config.js");
	assert.match(other.body, /"\/desktop\/quiet-red-fox"/);
	assert.equal(f.seen.length, 0);
});

test("viewer files come from the trusted assets directory only", async (t) => {
	const f = await fixture(t);
	const html = await f.call(`/desktop/${SLUG}/stream.html?hostId=1&appId=2`);
	assert.equal(html.status, 200);
	assert.match(html.body, /^<!doctype html>TRUSTED-STREAM/);
	assert.match(html.headers["content-type"], /^text\/html/);
	assert.equal(html.headers["x-frame-options"], "SAMEORIGIN");
	const csp = html.headers["content-security-policy"];
	assert.match(csp, VIEWER_CSP_RE);
	assert.match(
		csp,
		new RegExp(
			`script-src 'self' 'wasm-unsafe-eval' ${sha("INLINE()").replace(/[+/]/g, "\\$&")};`,
		),
	);
	assert.doesNotMatch(csp, /'unsafe-eval'|script-src[^;]*unsafe-inline/);
	const js = await f.call(`/desktop/${SLUG}/stream.js`);
	assert.match(js.headers["content-type"], /^text\/javascript/);
	assert.match(js.headers["content-security-policy"], VIEWER_CSP_RE);
	assert.doesNotMatch(js.headers["content-security-policy"], /sha256/);
	const modified = js.headers["last-modified"];
	assert.ok(modified && !Number.isNaN(Date.parse(modified)));
	const cached = await f.call(`/desktop/${SLUG}/stream.js`, {
		headers: { "if-modified-since": modified },
	});
	assert.equal(cached.status, 304);
	assert.equal(cached.body, "");
	const stale = await f.call(`/desktop/${SLUG}/stream.js`, {
		headers: { "if-modified-since": new Date(0).toUTCString() },
	});
	assert.equal(stale.status, 200);
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

	await f.call(`/desktop/${SLUG}/?fps=30`);
	assert.equal(f.seen.at(-1).url, "/?fps=30&dataTransport=websocket");
	const count = f.seen.length;
	const head = await f.call(`/desktop/${SLUG}/?fps=30`, { method: "HEAD" });
	assert.equal(head.status, 405);
	assert.equal(f.seen.length, count);
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
	assertPageCsp(res);

	f.replies.set("GET /", (_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<script>GUEST-HTML</script>");
	});
	const odd = await f.call(
		`/desktop/${SLUG}/?fps=60&bitrate=9000&language=de&dataTransport=webrtc&x="><b>`,
	);
	assert.equal(odd.status, 502);
	assert.doesNotMatch(odd.body, /GUEST-HTML/);
	assert.match(odd.body, />Try again<\/button>/);
	for (const [k, v] of [
		["fps", "60"],
		["bitrate", "9000"],
		["language", "de"],
		["dataTransport", "webrtc"],
	])
		assert.match(
			odd.body,
			new RegExp(`<input type="hidden" name="${k}" value="${v}">`),
		);
	assert.doesNotMatch(odd.body, /<b>/);
	assertPageCsp(odd);
});

test("the stream-end navigation shows a Stream ended page with Reconnect", async (t) => {
	const f = await fixture(t);
	const res = await f.call(`/desktop/${SLUG}/`);
	assert.equal(res.status, 200);
	assert.match(res.body, /Stream ended/);
	assert.match(res.body, /<button[^>]*>Reconnect<\/button>/);
	assert.match(res.body, new RegExp(`action="/desktop/${SLUG}/"`));
	assert.match(res.body, /name="dataTransport" value="websocket"/);
	assert.match(res.body, /sessionStorage\.getItem\("umiak-desktop:"/);
	assertPageCsp(res);
	assert.match(res.headers["content-security-policy"], /script-src 'sha256-/);
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
	assert.equal(res.headers["content-security-policy"], DATA_CSP);
	assert.equal(res.headers["cross-origin-resource-policy"], "same-origin");
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
		assert.equal(res.headers["content-security-policy"], DATA_CSP);
		assert.equal(res.headers["cross-origin-resource-policy"], "same-origin");
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
	assert.ok(
		ok.startsWith(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept("dGhlIHNhbXBsZSBub25jZQ==")}\r\n\r\nHELLO`,
		),
		ok,
	);
	assert.doesNotMatch(ok, /set-cookie|x-evil/i);
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

test("the 101 is rebuilt and refused unless accept, protocol, extensions and bytes are valid", async (t) => {
	const f = await fixture(t);
	const path = `/desktop/${SLUG}/api/host/stream/web_socket`;
	const reply = (extra, acceptValue) => (socket, req) => {
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptValue ?? accept(req.headers["sec-websocket-key"])}\r\n${extra}\r\nHELLO`,
		);
		socket.on("data", (d) => socket.write(d));
	};
	f.setUpgradeReply(reply("Sec-WebSocket-Protocol: b\r\n"));
	const chosen = await f.rawUpgrade(
		path,
		{ "sec-websocket-protocol": "a, b" },
		"PING-ECHO",
	);
	assert.match(chosen, /^HTTP\/1\.1 101 /);
	assert.match(chosen, /\r\nSec-WebSocket-Protocol: b\r\n/);
	assert.equal(f.upgrades.at(-1).headers["sec-websocket-protocol"], "a, b");

	const refused = async (fn, headers = {}) => {
		f.setUpgradeReply(fn);
		const out = await f.rawUpgrade(path, headers);
		assert.doesNotMatch(out, /^HTTP\/1\.1 101/);
		assert.doesNotMatch(out, /HELLO/);
	};
	await refused(reply("Sec-WebSocket-Protocol: c\r\n"), {
		"sec-websocket-protocol": "a, b",
	});
	await refused(reply("Sec-WebSocket-Protocol: a\r\n"));
	await refused(reply("", "AAAAAAAAAAAAAAAAAAAAAAAAAAA="));
	await refused(reply("Sec-WebSocket-Extensions: permessage-deflate\r\n"));
	await refused(reply("X-Bad: a\x01b\r\n"));
	await refused(reply("X-Split: a\nInjected: 1\r\n"));

	const before = f.upgrades.length;
	assert.doesNotMatch(
		await f.rawUpgrade(path, { "sec-websocket-key": "short" }),
		/^HTTP\/1\.1 101/,
	);
	assert.equal(f.upgrades.length, before);
	assert.equal(
		f.upgrades.at(-1).headers["sec-websocket-extensions"],
		undefined,
	);
});
