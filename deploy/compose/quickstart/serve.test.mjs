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
	const server = createQuickstartServer({ store });
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
		{ env: { ...process.env, TS_AUTHKEY: "config-only" } },
	);
	const config = JSON.parse(stdout);
	assert.deepEqual(Object.keys(config.services.tailscale.networks), [
		"serve-internal",
	]);
	for (const name of ["api", "mcp", "web", "postgres"])
		assert.equal(config.services[name].networks["serve-internal"], undefined);
	const serve = JSON.parse(
		await readFile(new URL("./tailscale/serve.json", import.meta.url), "utf8"),
	);
	assert.ok(JSON.stringify(serve).includes("http://172.30.116.10:4180"));
});
