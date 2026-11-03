import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { MemoryOwnerRepository, OwnerStore } from "./owner.mjs";
import { createQuickstartServer, upstreamHeaders } from "./server.mjs";

const externalHost = "quickstart.example-tailnet.ts.net";
const identity = {
	"tailscale-user-login": "attacker@example.test",
	"tailscale-user-name": "Attacker",
	"tailscale-user-profile-pic": "https://example.test/avatar",
	"x-forwarded-for": "100.64.0.25",
	"x-forwarded-proto": "https",
	"x-umiak-client-ip": "100.64.0.25",
};

function request(server, path, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.get(
			{
				host: "127.0.0.1",
				port: server.address().port,
				path,
				headers: { host: externalHost, ...headers },
			},
			(reply) => {
				let body = "";
				reply.setEncoding("utf8");
				reply.on("data", (chunk) => {
					body += chunk;
				});
				reply.on("end", () => resolve({ status: reply.statusCode, body }));
			},
		);
		req.on("error", reject);
	});
}

test("Serve preserves the external origin but identity headers never grant ownership", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.init();
	const server = createQuickstartServer({
		store,
		transport: http,
		env: { UMIAK_QUICKSTART_SERVE_PEERS: "127.0.0.1" },
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		assert.equal((await request(server, "/v1/me", identity)).status, 401);
		assert.equal(
			(await request(server, "/owner/sessions", identity)).status,
			401,
		);
		const upstream = upstreamHeaders(
			{
				headers: { host: externalHost, ...identity },
				socket: { remoteAddress: "172.28.0.2" },
			},
			"http://web:3000",
		);
		for (const key of Object.keys(identity).filter((key) =>
			key.startsWith("tailscale-"),
		))
			assert.equal(upstream[key], undefined);
		assert.equal(upstream["x-forwarded-for"], "172.28.0.2");
		assert.equal(upstream["x-umiak-client-ip"], "172.28.0.2");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("meta uses the Serve external Host and fixed socket peer to select public CA instructions", async (context) => {
	const seen = [];
	context.mock.method(globalThis, "fetch", async (url, options) => {
		seen.push({ url, headers: options.headers });
		return Response.json({
			authMode: "none",
			tenancy: "teams",
			apiUrl: "http://internal:8080",
			appUrl: "http://web:3000",
		});
	});
	for (const [peer, privateCA] of [
		["127.0.0.1", false],
		["100.64.0.25", true],
	]) {
		const store = new OwnerStore(new MemoryOwnerRepository());
		await store.init();
		const server = createQuickstartServer({
			store,
			transport: http,
			env: { UMIAK_QUICKSTART_SERVE_PEERS: peer },
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const reply = await request(server, "/v1/meta", identity);
			assert.equal(reply.status, 200);
			const meta = JSON.parse(reply.body);
			assert.equal(meta.authMode, "owner");
			assert.equal(meta.tenancy, "single");
			assert.equal(meta.apiUrl, `https://${externalHost}`);
			assert.equal(meta.appUrl, `https://${externalHost}`);
			assert.equal(meta.ownerPrivateCA, privateCA);
			const direct = JSON.parse(
				(
					await request(server, "/v1/meta", {
						host: `${externalHost}:8444`,
						...identity,
					})
				).body,
			);
			assert.equal(
				direct.ownerPrivateCA,
				true,
				"NAT must not make direct private HTTPS look publicly trusted",
			);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	}
	assert.equal(seen.length, 4);
	assert.equal(seen[0].headers["tailscale-user-login"], undefined);
});

test("Serve internal quickstart SNI accepts the external Host without trusting identity", async () => {
	const { mkdtemp, readFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const https = await import("node:https");
	const { quickstartTls } = await import("./tls.mjs");
	const dir = await mkdtemp(join(tmpdir(), "umiak-serve-"));
	let server;
	try {
		const store = new OwnerStore(new MemoryOwnerRepository());
		await store.init();
		server = createQuickstartServer({
			store,
			tls: await quickstartTls(dir, ["quickstart"]),
			env: {},
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const ca = await readFile(join(dir, "ca.pem"));
		const response = await new Promise((resolve, reject) => {
			https
				.get(
					{
						host: "127.0.0.1",
						port: server.address().port,
						servername: "quickstart",
						ca,
						headers: { host: externalHost, ...identity },
						path: "/v1/me",
					},
					(res) => {
						res.resume();
						resolve(res.statusCode);
					},
				)
				.on("error", reject);
		});
		assert.equal(response, 401);
	} finally {
		if (server) await new Promise((resolve) => server.close(resolve));
		await rm(dir, { recursive: true, force: true });
	}
});

test("sidecar shares only an owner-ingress network and requires no new owner-CA name", async () => {
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
				TS_AUTHKEY: "test-config-only",
				UMIAK_QUICKSTART_TLS_NAMES: "headless.example.test",
			},
		},
	);
	const config = JSON.parse(stdout);
	assert.deepEqual(Object.keys(config.services.tailscale.networks), [
		"serve-internal",
	]);
	for (const name of ["api", "mcp", "web", "postgres"])
		assert.equal(
			config.services[name].networks["serve-internal"],
			undefined,
			name,
		);
	assert.ok(config.services.quickstart.networks["serve-internal"]);
	assert.equal(
		config.services.quickstart.environment.UMIAK_QUICKSTART_TLS_NAMES,
		"headless.example.test",
	);
	const serve = JSON.parse(
		await readFile(new URL("./tailscale/serve.json", import.meta.url), "utf8"),
	);
	assert.equal(
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Tailscale expands this literal key.
		serve.Web["${TS_CERT_DOMAIN}:443"].Handlers["/"].Proxy,
		"https+insecure://172.30.116.10:8444",
	);
});
