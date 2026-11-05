import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { MemoryOwnerRepository, OwnerStore } from "./owner.mjs";
import { createQuickstartServer } from "./server.mjs";
import { testTls } from "./test-helpers/tls.mjs";

// This test deliberately executes the shipped Bun runtime, never Node's CLI source.
// Run pnpm build before the Node quickstart gate; a missing binary is a failure.
for (const httpsProxy of [false, true])
	test(`compiled CLI reaches owner pairing through ${httpsProxy ? "HTTPS reverse proxy with --cacert" : "HTTP ingress"}`, {
		timeout: 15000,
	}, async (t) => {
		const binary = resolve(
			`apps/cli/dist/umiak-${process.platform}-${process.arch}`,
		);
		assert.ok(existsSync(binary), "run pnpm build before the quickstart gate");
		const dir = await mkdtemp(join(tmpdir(), "umiak-compiled-ingress-"));
		let server;
		let proxy;
		let child;
		try {
			t.mock.method(globalThis, "fetch", async () =>
				Response.json({ tenancy: "single" }),
			);
			const repo = new MemoryOwnerRepository();
			const store = new OwnerStore(repo);
			await store.claim(await store.init());
			server = createQuickstartServer({
				metadataFetch: fetch,
				proxyListener: httpsProxy,
				store,
				env: { UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24" },
			});
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			let apiUrl = `http://127.0.0.1:${server.address().port}`;
			const caArgs = [];
			if (httpsProxy) {
				const tls = await testTls(join(dir, "proxy-tls"));
				proxy = createServer(tls, (req, res) => {
					const upstream = request(
						{
							host: "127.0.0.1",
							port: server.address().port,
							method: req.method,
							path: req.url,
							headers: { ...req.headers, "x-forwarded-proto": "https" },
						},
						(reply) => {
							res.writeHead(reply.statusCode, reply.headers);
							reply.pipe(res);
						},
					);
					upstream.on("error", () => res.writeHead(502).end());
					req.pipe(upstream);
				});
				await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
				apiUrl = `https://localhost:${proxy.address().port}`;
				caArgs.push("--cacert", tls.caFile);
			}

			child = spawn(
				binary,
				["login", "--api-url", apiUrl, ...caArgs, "--no-browser"],
				{
					env: {
						...process.env,
						XDG_CONFIG_HOME: join(dir, "config"),
						XDG_STATE_HOME: join(dir, "state"),
						UMIAK_CREDENTIAL_STORE: "file",
						UMIAK_SYSTEM_CONFIG: join(dir, "system-config.json"),
						UMIAK_API_URL: "",
						UMIAK_CA_FILE: "",
						UMIAK_PROFILE: "",
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let output = "";
			await new Promise((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error(`CLI pairing timed out: ${output}`)),
					10000,
				);
				const collect = (chunk) => {
					output += chunk;
					if (/Enter pairing code/.test(output)) {
						clearTimeout(timeout);
						resolve();
					}
				};
				child.stdout.on("data", collect);
				child.stderr.on("data", collect);
				child.on("error", (error) => {
					clearTimeout(timeout);
					reject(error);
				});
				child.on("exit", (code) => {
					clearTimeout(timeout);
					reject(new Error(`CLI exited ${code}: ${output}`));
				});
			});
			assert.equal(Object.keys(repo.state.pairs).length, 1);
			assert.doesNotMatch(output, /network_error|UNSUPPORTED_CONSTRAINT_TYPE/);
		} finally {
			if (child && child.exitCode === null) {
				child.kill("SIGTERM");
				await new Promise((resolve) => child.once("exit", resolve));
			}
			if (proxy) {
				proxy.closeAllConnections();
				await new Promise((resolve) => proxy.close(resolve));
			}
			if (server) await new Promise((resolve) => server.close(resolve));
			await rm(dir, { recursive: true, force: true });
		}
	});
