import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { MemoryOwnerRepository, OwnerStore } from "./owner.mjs";
import { createQuickstartServer } from "./server.mjs";

test("trusted HTTPS proxy preserves legacy secure cookie, origin, and CLI bearer; identity headers grant nothing", async (t) => {
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		assert.equal(options.headers["x-umiak-client-ip"], "127.0.0.1");
		return Response.json({ authMode: "none" });
	});
	const store = new OwnerStore(new MemoryOwnerRepository());
	const token = await store.claim(await store.init());
	const server = createQuickstartServer({ store, proxyListener: true });
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
		assert.equal(
			(await call("/owner/sessions", { "tailscale-user-login": "owner" }))
				.status,
			401,
		);
		assert.equal(
			(await call("/owner/sessions", { cookie: `__Host-umiak_owner=${token}` }))
				.status,
			200,
		);
		assert.equal(
			(await call("/owner/sessions", { cookie: `umiak_owner=${token}` }))
				.status,
			401,
		);
		assert.equal(
			(await call("/owner/tls", { cookie: `__Host-umiak_owner=${token}` }))
				.status,
			502,
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
test("optional proxy sidecar has no upstream network and uses HTTP ingress", async () => {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const { readFile } = await import("node:fs/promises");
	const { stdout } = await promisify(execFile)(
		"docker",
		[
			"compose",
			"-f",
			"compose.yaml",
			"-f",
			"deploy/compose/quickstart/compose.tailscale.yaml",
			"config",
			"--format",
			"json",
		],
		{
			env: {
				...process.env,
				TS_AUTHKEY: "config-only",
				UMIAK_QUICKSTART_ALLOWED_HOSTS: "lab.example",
			},
		},
	);
	const config = JSON.parse(stdout);
	const ingress = config.services.quickstart;
	assert.ok(
		ingress.ports.some(
			(port) => port.target === 4181 && port.host_ip === "127.0.0.1",
		),
	);
	assert.doesNotMatch(
		ingress.environment.UMIAK_TRUSTED_PROXY_CIDRS,
		/172\.29\.116\.(?:1|128)\//,
	);

	assert.equal(
		config.services.mcp.environment.UMIAK_MCP_ALLOWED_HOSTS,
		"localhost:4180",
	);
	assert.deepEqual(Object.keys(config.services.tailscale.networks), [
		"serve-internal",
	]);
	for (const name of ["api", "mcp", "web", "postgres"])
		assert.equal(config.services[name].networks["serve-internal"], undefined);
	const serve = JSON.parse(
		await readFile(new URL("./tailscale/serve.json", import.meta.url), "utf8"),
	);
	assert.ok(JSON.stringify(serve).includes("http://172.30.116.10:4181"));
});

test("public socket spoofing cannot change origin, cookie selection or client IP", async (t) => {
	const fetchServer = globalThis.fetch;
	t.mock.method(globalThis, "fetch", async () =>
		Response.json({ authMode: "none" }),
	);
	const store = new OwnerStore(new MemoryOwnerRepository());
	const code = await store.init();
	let client;
	const server = createQuickstartServer({
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
	assert.match(response.headers.get("set-cookie"), /^umiak_owner=/);
	assert.doesNotMatch(response.headers.get("set-cookie"), /Secure/);
	await fetchServer(`${origin}/setup`, {
		headers: {
			...headers,
			cookie: response.headers.get("set-cookie").split(";")[0],
		},
	});
	assert.equal(client, "127.0.0.1");
});
