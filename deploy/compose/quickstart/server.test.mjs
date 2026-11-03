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
		assert.match(cookie, /HttpOnly/);
		assert.doesNotMatch(cookie, /Secure/);
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
				cookie: `umiak_owner=${token}`,
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

test("denied PVE peer can only invoke token-protected preparation endpoints", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.init();
	const server = createQuickstartServer({
		store,
		transport: http,
		env: { UMIAK_LOCAL_DENIED_CIDRS: "127.0.0.1/32" },
		setupHandler: async (req, res) => {
			const valid =
				new URL(req.url, "https://host").searchParams.get("token") ===
				"capability";
			res.writeHead(valid ? 200 : 403);
			res.end();
			return true;
		},
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		assert.equal(
			(await fetch(`${base}/pve-setup.sh?token=capability`)).status,
			200,
		);
		assert.equal((await fetch(`${base}/pve-setup.sh?token=bad`)).status, 403);
		assert.equal((await fetch(`${base}/v1/me?token=capability`)).status, 403);
		assert.equal(
			(await fetch(`${base}/pve-setup.sh/other?token=capability`)).status,
			403,
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
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
			/^umiak_owner=.*HttpOnly; SameSite=Strict/,
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
					{ origin, cookie: `umiak_owner=${first}` },
				)
			).status,
			200,
		);
	} finally {
		await new Promise((r) => server.close(r));
	}
});
