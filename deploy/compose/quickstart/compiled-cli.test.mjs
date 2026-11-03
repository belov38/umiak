import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { MemoryOwnerRepository, OwnerStore } from "./owner.mjs";
import { createQuickstartServer } from "./server.mjs";
import { quickstartTls } from "./tls.mjs";

// This test deliberately executes the shipped Bun runtime, never Node's CLI source.
// Run pnpm build before the Node quickstart gate; a missing binary is a failure.
for (const host of ["localhost", "127.0.0.1"])
	test(`compiled CLI trusts the real ingress CA at ${host} and reaches owner pairing`, {
		timeout: 15000,
	}, async (t) => {
		const binary = resolve(
			`apps/cli/dist/umiak-${process.platform}-${process.arch}`,
		);
		assert.ok(existsSync(binary), "run pnpm build before the quickstart gate");
		const dir = await mkdtemp(join(tmpdir(), "umiak-compiled-tls-"));
		let server;
		let child;
		try {
			t.mock.method(globalThis, "fetch", async () =>
				Response.json({ oidc: null, tenancy: "single" }),
			);
			const repo = new MemoryOwnerRepository();
			const store = new OwnerStore(repo);
			await store.claim(await store.init());
			const tls = await quickstartTls(join(dir, "tls"), [
				"headless.example.test",
			]);
			server = createQuickstartServer({
				store,
				tls,
				env: { UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24" },
			});
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			child = spawn(
				binary,
				[
					"login",
					"--api-url",
					`https://${host}:${server.address().port}`,
					"--cacert",
					join(dir, "tls/ca.pem"),
					"--no-browser",
				],
				{
					env: {
						...process.env,
						UMIAK_CONFIG_DIR: join(dir, "config"),
						UMIAK_CREDENTIAL_STORE: "file",
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
			if (server) await new Promise((resolve) => server.close(resolve));
			await rm(dir, { recursive: true, force: true });
		}
	});
