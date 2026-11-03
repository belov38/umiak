import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { MemoryOwnerRepository, OwnerStore } from "./owner.mjs";
import { createQuickstartServer } from "./server.mjs";

test("trusted HTTPS proxy uses the __Host secure cookie, origin, and CLI bearer; identity headers grant nothing", async (t) => {
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		assert.equal(options.headers["x-umiak-client-ip"], "127.0.0.1");
		return Response.json({ authMode: "owner" });
	});
	const store = new OwnerStore(new MemoryOwnerRepository());
	const token = await store.claim(await store.init());
	const server = createQuickstartServer({
		metadataFetch: fetch,
		store,
		proxyListener: true,
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const call = (path, headers = {}) =>
		new Promise((resolve, reject) => {
			http
				.get(
					{
						host: "127.0.0.1",
						port: server.address().port,
						path,
						headers: {
							host: "lab.example",
							"x-forwarded-proto": "https",
							"x-forwarded-for": "203.0.113.5",
							...headers,
						},
					},
					(r) => {
						let body = "";
						r.on("data", (x) => (body += x));
						r.on("end", () => resolve({ status: r.statusCode, body }));
					},
				)
				.on("error", reject);
		});
	try {
		const meta = JSON.parse((await call("/v1/meta")).body);
		assert.equal(meta.apiUrl, "https://lab.example");
		assert.equal(meta.ownerPrivateCA, undefined);

		for (const headers of [
			{ "tailscale-user-login": "owner" },
			{ cookie: `umiak_owner=${token}` },
		]) {
			const reply = await call("/owner/sessions", headers);
			assert.equal(reply.status, 200);
			assert.match(reply.body, /<h1>Sign in<\/h1>/);
			assert.doesNotMatch(reply.body, /<nav/);
		}
		const signedIn = await call("/owner/sessions", {
			cookie: `__Host-umiak_owner=${token}`,
		});
		assert.equal(signedIn.status, 200);
		assert.match(signedIn.body, /<h1>Owner sessions<\/h1>/);

		assert.equal(
			(await call("/owner/tls", { cookie: `__Host-umiak_owner=${token}` }))
				.status,
			502,
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
test("public socket spoofing cannot change origin, cookie selection or client IP", async (t) => {
	const fetchServer = globalThis.fetch;
	t.mock.method(globalThis, "fetch", async () =>
		Response.json({ authMode: "owner" }),
	);
	const store = new OwnerStore(new MemoryOwnerRepository());
	const code = await store.init();
	let client;
	const server = createQuickstartServer({
		metadataFetch: fetch,
		store,
		env: { UMIAK_TRUSTED_PROXY_CIDRS: "127.0.0.0/8" },
		setupHandler: async (req) => {
			client = req.umiakClientAddress;
			return false;
		},
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const headers = {
		"x-forwarded-proto": "https",
		"x-forwarded-host": "evil.example",
		"x-forwarded-for": "8.8.8.8",
	};
	const meta = await (
		await fetchServer(`${origin}/v1/meta`, { headers })
	).json();
	assert.equal(meta.apiUrl, origin);
	const response = await fetchServer(`${origin}/owner/claim`, {
		method: "POST",
		headers: { ...headers, origin, "content-type": "application/json" },
		body: JSON.stringify({ code }),
	});
	assert.equal(response.status, 200);
	assert.match(
		response.headers.get("set-cookie"),
		/^__Host-umiak_owner=.*; Secure;/,
	);
	await fetchServer(`${origin}/setup`, {
		headers: {
			...headers,
			cookie: response.headers.get("set-cookie").split(";")[0],
		},
	});
	assert.equal(client, "127.0.0.1");
});
