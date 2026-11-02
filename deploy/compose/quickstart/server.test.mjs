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
		requestOrigin({ headers: { host: "pve:8444" } }),
		"https://pve:8444",
	);
	assert.equal(
		requestOrigin({ headers: { host: "192.168.1.2:8444" } }),
		"https://192.168.1.2:8444",
	);
	assert.throws(() => requestOrigin({ headers: { host: "evil/path" } }));
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
	const origin = base.replace("http:", "https:");
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
			(await post("/owner/pair/approve", { id: pair.id }, auth)).status,
			200,
		);
		const token = await (
			await post("/owner/pair/poll", { id: pair.id, secret: pair.secret })
		).json();
		assert.equal(await store.authenticate(token.token), true);
		assert.equal((await post("/owner/logout", {}, auth)).status, 200);
		assert.equal(
			(await post("/owner/pair/approve", { id: pair.id }, auth)).status,
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

test("dedicated CA authenticates IP and newly observed DNS SNI names", async () => {
	const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const https = await import("node:https");
	const { quickstartTls } = await import("./server.mjs");
	const dir = mkdtempSync(join(tmpdir(), "umiak-owner-tls-"));
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.init();
	const server = createQuickstartServer({
		store,
		tls: quickstartTls(dir, ["127.0.0.1"]),
		env: { UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24" },
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const ca = readFileSync(join(dir, "ca.pem"));
	const get = (servername) =>
		new Promise((resolve, reject) => {
			https
				.get(
					{
						host: "127.0.0.1",
						port: server.address().port,
						path: "/setup",
						ca,
						...(servername
							? { servername, headers: { host: servername } }
							: {}),
					},
					(res) => {
						res.resume();
						resolve(res.statusCode);
					},
				)
				.on("error", reject);
		});
	try {
		assert.equal(await get(), 200);
		assert.equal(await get("home.example.test"), 200);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	}
});
