import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { MemoryOwnerRepository, OwnerStore } from "./owner.mjs";
import {
	createQuickstartServer,
	requestOrigin,
	upstreamHeaders,
} from "./server.mjs";

test("upstream headers remove forged identity, credentials and forwarding headers", () => {
	const h = upstreamHeaders(
		{
			headers: {
				host: "evil",
				"x-auth-request-user": "attacker",
				"x-forwarded-for": "1.2.3.4",
				authorization: "Bearer secret",
				cookie: "umiak_owner=secret",
			},
			socket: { remoteAddress: "192.168.1.2" },
		},
		"http://localhost:4180",
	);
	assert.equal(h.authorization, undefined);
	assert.equal(h.cookie, undefined);
	assert.equal(h["x-auth-request-user"], undefined);
	assert.equal(h.host, "localhost:4180");
	assert.equal(h["x-forwarded-for"], "192.168.1.2");
});

test("origin accepts DNS and IP but refuses malformed authority", () => {
	assert.equal(
		requestOrigin(
			{ headers: { host: "pve:8444" } },
			{ UMIAK_QUICKSTART_ALLOWED_HOSTS: "pve" },
		),
		"http://pve:8444",
	);
	assert.equal(
		requestOrigin({ headers: { host: "192.168.1.2:8444" } }),
		"http://192.168.1.2:8444",
	);
	assert.throws(() => requestOrigin({ headers: { host: "evil/path" } }));
	assert.throws(() => requestOrigin({ headers: { host: "bad'host" } }));
});

test("HTTP routes gate API and WS, claim requires same origin, pair needs owner approval", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	const code = await store.init();
	const server = createQuickstartServer({
		store,
		env: { UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24" },
		transport: http,
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const origin = base;
	const post = (path, body, headers = {}) =>
		fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	try {
		assert.equal((await fetch(`${base}/v1/me`)).status, 401);
		assert.equal(
			(await post("/owner/claim", { code }, { origin: "https://evil" })).status,
			403,
		);
		const claim = await post("/owner/claim", { code }, { origin });
		assert.equal(claim.status, 200);
		const cookie = claim.headers.get("set-cookie");
		assert.match(cookie, /^__Host-umiak_owner=/);
		assert.match(cookie, /Path=\//);
		assert.match(cookie, /HttpOnly/);
		assert.match(cookie, /Secure/);
		assert.match(cookie, /SameSite=Strict/);
		const auth = { cookie: cookie.split(";")[0], origin };
		assert.equal(
			(await post("/owner/claim", { code }, { origin })).status,
			403,
		);
		const pair = await (await post("/owner/pair", {})).json();
		assert.equal(
			(await post("/owner/pair/approve", { id: pair.id }, { origin })).status,
			401,
		);
		assert.equal(
			(
				await post(
					"/owner/pair/approve",
					{ id: pair.id, code: pair.code },
					auth,
				)
			).status,
			200,
		);
		const token = await (
			await post("/owner/pair/poll", { id: pair.id, secret: pair.secret })
		).json();
		assert.equal(await store.authenticate(token.token), true);
		assert.equal((await post("/owner/logout", {}, auth)).status, 200);
		assert.equal(
			(
				await post(
					"/owner/pair/approve",
					{ id: pair.id, code: pair.code },
					auth,
				)
			).status,
			401,
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("WebSocket upgrades cannot bypass owner authentication or origin checks", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	const token = await store.claim(await store.init());
	const server = createQuickstartServer({
		store,
		env: { UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24" },
		transport: http,
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	async function upgrade(headers) {
		return new Promise((resolve, reject) => {
			const req = http.request(
				{
					host: "127.0.0.1",
					port,
					path: "/v1/ptys/test/ws",
					headers: { connection: "Upgrade", upgrade: "websocket", ...headers },
				},
				(res) => {
					resolve(res.statusCode);
					res.resume();
				},
			);
			req.on("error", reject);
			req.end();
		});
	}
	try {
		assert.equal(
			await upgrade({
				"x-auth-request-user": "owner",
				"x-umiak-client-ip": "127.0.0.1",
			}),
			401,
		);
		assert.equal(
			await upgrade({
				cookie: `__Host-umiak_owner=${token}`,
				origin: "https://evil.example",
			}),
			401,
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("network denial precedes public and authenticated routes despite forged forwarded peer", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.init();
	const server = createQuickstartServer({
		store,
		env: { UMIAK_LOCAL_DENIED_CIDRS: "127.0.0.0/8" },
		transport: http,
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const res = await fetch(
			`http://127.0.0.1:${server.address().port}/v1/meta`,
			{ headers: { "x-forwarded-for": "192.168.1.2" } },
		);
		assert.equal(res.status, 403);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("denied PVE peer gets no preparation exemption", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.init();
	let called = false;
	const server = createQuickstartServer({
		store,
		transport: http,
		env: { UMIAK_LOCAL_DENIED_CIDRS: "127.0.0.1/32" },
		setupHandler: async () => {
			called = true;
			return true;
		},
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		for (const path of [
			"/pve-setup.sh?token=capability",
			"/quickstart/setup/callback",
			"/v1/me",
		])
			assert.equal((await fetch(base + path)).status, 403);
		assert.equal(called, false);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

// Drives the request handler with a chosen socket peer, which loopback tests cannot spoof.
async function viaPeer(options, { peer, host, accept }) {
	const { Readable } = await import("node:stream");
	let handler;
	createQuickstartServer({
		...options,
		transport: {
			createServer: (fn) => {
				handler = fn;
				return { on() {} };
			},
		},
	});
	const req = Readable.from([]);
	req.method = "GET";
	req.url = "/";
	req.headers = { host, accept };
	req.socket = { remoteAddress: peer };
	const out = {};
	await new Promise((resolve) => {
		const res = {
			setHeader() {},
			writeHead(status) {
				out.status = status;
			},
			end(data) {
				out.body = String(data ?? "");
				resolve();
			},
		};
		handler(req, res);
	});
	return out;
}

test("port 4180 serves only loopback Host names; other Hosts are told to use the tailnet", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.init();
	const options = { store, env: { UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24" } };
	const wrongHost = await viaPeer(options, {
		peer: "192.168.68.116",
		host: "192.168.68.50:4180",
		accept: "application/json",
	});
	assert.equal(wrongHost.status, 403);
	assert.equal(JSON.parse(wrongHost.body).error.code, "use_tailnet_https");
	const html = await viaPeer(options, {
		peer: "192.168.68.116",
		host: "umiak.tail123.ts.net",
		accept: "text/html",
	});
	assert.equal(html.status, 403);
	assert.match(html.body, /use_tailnet_https/);
	for (const host of ["localhost:4180", "127.0.0.1:4180", "[::1]:4180"]) {
		const served = await viaPeer(options, {
			peer: "192.168.68.116",
			host,
			accept: "text/html",
		});
		assert.equal(served.status, 200, host);
		assert.match(served.body, /Claim this Umiak deployment/);
	}
});

test("plain umiak_owner cookie is neither accepted nor set", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	const token = await store.claim(await store.init());
	const server = createQuickstartServer({ store });
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		const get = (cookie) =>
			fetch(`${base}/owner/sessions`, {
				headers: { cookie, accept: "application/json" },
			});
		assert.equal((await get(`umiak_owner=${token}`)).status, 401);
		assert.equal((await get(`__Host-umiak_owner=${token}`)).status, 200);
		const issued = await store.signinCode();
		const reply = await fetch(`${base}/owner/signin`, {
			method: "POST",
			headers: { origin: base, "content-type": "application/json" },
			body: JSON.stringify(issued),
		});
		assert.equal(reply.status, 200);
		assert.doesNotMatch(reply.headers.get("set-cookie"), /^umiak_owner=/);
		assert.match(reply.headers.get("set-cookie"), /^__Host-umiak_owner=/);
	} finally {
		await new Promise((r) => server.close(r));
	}
});

test("wizard resolved PVE addresses are denied dynamically", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.init();
	const handler = async () => false;
	handler.deniedPeer = async () => true;
	const server = createQuickstartServer({
		store,
		setupHandler: handler,
		transport: http,
		env: {},
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		assert.equal(
			(await fetch(`http://127.0.0.1:${server.address().port}/v1/me`)).status,
			403,
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("anonymous browser guide navigations show claim while API clients retain JSON", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.init();
	const server = createQuickstartServer({
		store,
		transport: http,
		env: { UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24" },
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		const browser = await fetch(`${base}/app/getting-started`, {
			headers: { accept: "text/html" },
		});
		assert.equal(browser.status, 200);
		assert.match(await browser.text(), /Claim this Umiak deployment/);
		const api = await fetch(`${base}/app/getting-started`, {
			headers: { accept: "application/json" },
		});
		assert.equal(api.status, 401);
		assert.equal((await api.json()).error.code, "owner_required");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("download length enables determinate installer progress through Serve", async (t) => {
	const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "umiak-download-length-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "umiak-darwin-arm64.gz"), "compressed bytes");
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.init();
	const server = createQuickstartServer({
		store,
		transport: http,
		assetsDir: dir,
		env: {},
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const response = await fetch(
		`http://127.0.0.1:${server.address().port}/downloads/umiak-darwin-arm64.gz`,
	);
	assert.equal(response.headers.get("content-length"), "16");
	assert.equal(await response.text(), "compressed bytes");
});

test("public installer and downloads HEAD match GET headers without a body or owner session", async (t) => {
	const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "umiak-head-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "install.sh"), "origin=__UMIAK_ORIGIN__");
	await writeFile(join(dir, "umiak-darwin-arm64.gz"), "compressed");
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.init();
	const server = createQuickstartServer({
		store,
		transport: http,
		assetsDir: dir,
		env: {},
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const base = `http://127.0.0.1:${server.address().port}`;
	for (const path of ["/install.sh", "/downloads/umiak-darwin-arm64.gz"]) {
		const get = await fetch(base + path);
		const bytes = await get.arrayBuffer();
		const head = await fetch(base + path, { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(
			head.headers.get("content-type"),
			get.headers.get("content-type"),
		);
		assert.equal(Number(head.headers.get("content-length")), bytes.byteLength);
		assert.equal(await head.text(), "");
	}
	assert.equal(
		(await fetch(`${base}/downloads/missing`, { method: "HEAD" })).status,
		404,
	);
});

test("HTTPS proxy claim retains __Host cookie and direct HTTP ignores forwarded headers from untrusted peers", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	const code = await store.init();
	const server = createQuickstartServer({
		store,
		proxyListener: true,
		env: {
			UMIAK_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
			UMIAK_PUBLIC_URL: "https://lab.example",
		},
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const response = await fetch(
			`http://127.0.0.1:${server.address().port}/owner/claim`,
			{
				method: "POST",
				headers: {
					"x-forwarded-proto": "https",
					"x-forwarded-host": "lab.example",
					origin: "https://lab.example",
					"content-type": "application/json",
				},
				body: JSON.stringify({ code }),
			},
		);
		assert.equal(response.status, 200);
		assert.match(
			response.headers.get("set-cookie"),
			/^__Host-umiak_owner=.*; Secure;/,
		);
		const issued = await store.signinCode();
		const signin = await fetch(
			`http://127.0.0.1:${server.address().port}/owner/signin`,
			{
				method: "POST",
				headers: {
					"x-forwarded-proto": "https",
					"x-forwarded-host": "lab.example",
					origin: "https://lab.example",
					"content-type": "application/json",
				},
				body: JSON.stringify(issued),
			},
		);
		assert.equal(signin.status, 200);
		assert.match(
			signin.headers.get("set-cookie"),
			/^__Host-umiak_owner=.*; Secure;/,
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("trusted proxies cannot bypass denied client CIDRs", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.init();
	const server = createQuickstartServer({
		store,
		proxyListener: true,
		env: { UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24" },
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const response = await fetch(
			`http://127.0.0.1:${server.address().port}/owner/pair`,
			{
				method: "POST",
				headers: {
					"x-forwarded-proto": "https",
					"x-forwarded-host": "lab.example",
					"x-forwarded-for": "10.88.0.3",
					"content-type": "application/json",
				},
				body: "{}",
			},
		);
		assert.equal(response.status, 403);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("sign-in POST checks Origin and Host; only browser owners mint codes", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	const first = await store.claim(await store.init(), "original");
	const server = createQuickstartServer({
		store,
		env: { UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24" },
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const post = (path, data, headers = {}) =>
		fetch(origin + path, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(data),
		});
	try {
		for (const path of [
			"/",
			"/app/x",
			"/setup",
			"/owner/sessions",
			"/owner/pair",
		]) {
			const html = await (await fetch(origin + path)).text();
			assert.match(html, /<h1>Sign in/);
			assert.doesNotMatch(html, /<nav|Open navigation/);
		}
		const issued = await store.signinCode();
		for (const headers of [{}, { origin: "https://evil" }])
			assert.equal((await post("/owner/signin", issued, headers)).status, 403);
		assert.equal(
			(await post("/owner/signin", { code: "bad" }, { origin })).status,
			403,
		);
		const forbiddenHost = await new Promise((resolve, reject) => {
			const req = http.request(
				`${origin}/owner/signin`,
				{
					method: "POST",
					headers: {
						host: "evil.example",
						origin,
						"content-type": "application/json",
					},
				},
				(res) => {
					res.resume();
					res.on("end", () => resolve(res.statusCode));
				},
			);
			req.on("error", reject);
			req.end(JSON.stringify(issued));
		});
		assert.equal(forbiddenHost, 403);
		const reply = await post("/owner/signin", issued, { origin });
		assert.equal(reply.status, 200);
		assert.match(
			reply.headers.get("set-cookie"),
			/^__Host-umiak_owner=.*HttpOnly; Secure; SameSite=Strict/,
		);
		assert.equal(await store.authenticate(first), true);
		const pair = await store.pairStart();
		await store.pairApprove(pair.id, pair.code);
		const cli = await store.pairPoll(pair.id, pair.secret);
		assert.equal(
			(
				await post(
					"/owner/signin-code",
					{},
					{ origin, authorization: `Bearer ${cli}` },
				)
			).status,
			403,
		);
		assert.equal(
			(
				await post(
					"/owner/signin-code",
					{},
					{ origin, cookie: `__Host-umiak_owner=${first}` },
				)
			).status,
			200,
		);
	} finally {
		await new Promise((r) => server.close(r));
	}
});

test("sign-in limits have retry metadata; JSON owner gate and self revoke behave correctly", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	const token = await store.claim(await store.init());
	const server = createQuickstartServer({ store });
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const post = (path, data, auth = false) =>
		fetch(origin + path, {
			method: "POST",
			headers: {
				origin,
				"content-type": "application/json",
				...(auth ? { cookie: `__Host-umiak_owner=${token}` } : {}),
			},
			body: JSON.stringify(data),
		});
	try {
		assert.equal(
			(
				await fetch(`${origin}/owner/sessions`, {
					headers: { accept: "application/json" },
				})
			).status,
			401,
		);
		for (let i = 0; i < 20; i++)
			assert.equal((await post("/owner/signin", { code: "bad" })).status, 403);
		const limited = await post("/owner/signin", { code: "bad" });
		assert.equal(limited.status, 429);
		assert.ok(Number(limited.headers.get("retry-after")) > 0);
		assert.deepEqual((await limited.json()).error, {
			code: "signin_limited",
			message: "signin_limited",
			retryable: true,
		});
		const html = await (
			await fetch(`${origin}/owner/sessions`, {
				headers: { cookie: `__Host-umiak_owner=${token}` },
			})
		).text();
		assert.match(html, /This browser/);
		assert.match(html, /aria-label="Revoke browser session created/);
		const bogus = await fetch(`${origin}/owner/pair?id=bogus`, {
			headers: { cookie: `__Host-umiak_owner=${token}` },
		});
		assert.match(await bogus.text(), /Pairing unavailable/);
		const revoked = await post(
			"/owner/sessions/revoke",
			{ id: (await store.sessions())[0].id },
			true,
		);
		assert.match(revoked.headers.get("set-cookie"), /Max-Age=0/);
	} finally {
		await new Promise((r) => server.close(r));
	}
});

test("the 4180 Host gate also covers WebSocket upgrades", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	const token = await store.claim(await store.init());
	const server = createQuickstartServer({
		store,
		env: { UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24" },
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	const upgrade = (host) =>
		new Promise((resolve) => {
			const req = http.request({
				host: "127.0.0.1",
				port,
				path: "/v1/ptys/test/ws",
				headers: {
					host,
					connection: "Upgrade",
					upgrade: "websocket",
					cookie: `__Host-umiak_owner=${token}`,
				},
			});
			req.on("response", (res) => {
				let body = "";
				res.on("data", (x) => (body += x));
				res.on("end", () => resolve({ status: res.statusCode, body }));
			});
			req.on("error", () => resolve({ status: "closed", body: "" }));
			req.end();
		});
	try {
		const denied = await upgrade("192.168.68.50:4180");
		assert.equal(denied.status, 403);
		assert.match(denied.body, /use_tailnet_https/);
		// Loopback Host passes the gate and fails later only because no upstream exists.
		const served = await upgrade(`127.0.0.1:${port}`);
		assert.notEqual(served.status, 403);
		assert.doesNotMatch(served.body, /use_tailnet_https/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
