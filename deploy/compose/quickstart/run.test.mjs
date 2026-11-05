import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const launcher = new URL("./run.mjs", import.meta.url).pathname;
test("loads generated credentials and wizard network config without shell evaluation", () => {
	const dir = mkdtempSync(join(tmpdir(), "umiak-run-test-"));
	writeFileSync(join(dir, "password"), "a".repeat(64));
	writeFileSync(join(dir, "pve-token-id"), "umiak@pve!custom\n");
	writeFileSync(
		join(dir, "quickstart-network.json"),
		JSON.stringify({
			tunnelUrl: "wss://tunnel.192-168-1-2.sslip.io/v1/connect",
			previewDomain: "umiak.192-168-1-2.sslip.io",
			gatewayAddress: "192.168.1.2",
		}),
	);
	const result = spawnSync(
		process.execPath,
		[
			launcher,
			process.execPath,
			"-e",
			"console.log(JSON.stringify({db:process.env.DATABASE_URL,token:process.env.UMIAK_PVE_TOKEN_ID,tunnel:process.env.UMIAK_TUNNEL_URL,preview:process.env.UMIAK_GATEWAY_PREVIEW_DOMAIN,portDomain:process.env.UMIAK_PORT_DOMAIN,host:process.env.UMIAK_GATEWAY_TUNNEL_HOST}))",
		],
		{
			env: {
				...process.env,
				UMIAK_DATABASE_PASSWORD_FILE: join(dir, "password"),
				UMIAK_SECRETS_DIR: dir,
			},
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		db: `postgres://umiak:${"a".repeat(64)}@postgres:5432/umiak`,
		token: "umiak@pve!custom",
		tunnel: "wss://tunnel.192-168-1-2.sslip.io/v1/connect",
		preview: "umiak.192-168-1-2.sslip.io",
		portDomain: "umiak.192-168-1-2.sslip.io",
		host: "tunnel.192-168-1-2.sslip.io",
	});
});
test("rejects malformed database credentials before starting any consumer", () => {
	const dir = mkdtempSync(join(tmpdir(), "umiak-run-test-"));
	writeFileSync(join(dir, "password"), "invalid");
	const result = spawnSync(
		process.execPath,
		[launcher, process.execPath, "-e", 'console.log("consumer-started")'],
		{
			env: {
				...process.env,
				UMIAK_DATABASE_PASSWORD_FILE: join(dir, "password"),
			},
			encoding: "utf8",
		},
	);
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /Invalid generated database password/);
});

test("network settings load from a public config volume with no PVE secrets mount", async () => {
	const { rmSync } = await import("node:fs");
	const dir = mkdtempSync(join(tmpdir(), "umiak-network-test-"));
	try {
		writeFileSync(join(dir, "password"), "a".repeat(64));
		writeFileSync(
			join(dir, "network.json"),
			JSON.stringify({
				tunnelUrl: "wss://tunnel.example.test/v1/connect",
				previewDomain: "preview.example.test",
				gatewayAddress: "192.168.1.2",
			}),
		);
		const result = spawnSync(
			process.execPath,
			[
				launcher,
				process.execPath,
				"-e",
				"console.log(JSON.stringify({preview:process.env.UMIAK_PREVIEW_DOMAIN,tunnel:process.env.UMIAK_TUNNEL_URL,host:process.env.UMIAK_SSH_HOST}))",
			],
			{
				env: {
					...process.env,
					UMIAK_DATABASE_PASSWORD_FILE: join(dir, "password"),
					UMIAK_SECRETS_DIR: join(dir, "unmounted-pve-secrets"),
					UMIAK_QUICKSTART_NETWORK_FILE: join(dir, "network.json"),
				},
				encoding: "utf8",
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {
			preview: "preview.example.test",
			tunnel: "wss://tunnel.example.test/v1/connect",
			host: "tunnel.example.test",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("installer SSH host (tailnet address) wins over the gateway tunnel host", () => {
	const dir = mkdtempSync(join(tmpdir(), "umiak-run-test-"));
	writeFileSync(join(dir, "password"), "a".repeat(64));
	writeFileSync(
		join(dir, "quickstart-network.json"),
		JSON.stringify({
			gatewayAddress: "192.168.68.50",
			previewDomain: "umiak.100-64-10-20.sslip.io",
			tunnelUrl: "wss://tunnel.192-168-68-50.sslip.io/v1/connect",
			guestDns: "1.1.1.1",
		}),
	);
	const run = (extra) =>
		spawnSync(
			process.execPath,
			[
				launcher,
				process.execPath,
				"-e",
				"console.log(JSON.stringify({ssh:process.env.UMIAK_SSH_HOST,gatewaySsh:process.env.UMIAK_GATEWAY_SSH_HOST}))",
			],
			{
				env: {
					...process.env,
					UMIAK_DATABASE_PASSWORD_FILE: join(dir, "password"),
					UMIAK_SECRETS_DIR: dir,
					UMIAK_QUICKSTART_NETWORK_FILE: join(dir, "quickstart-network.json"),
					...extra,
				},
				encoding: "utf8",
			},
		);
	const set = run({ UMIAK_SSH_HOST: "100.64.10.20" });
	assert.equal(set.status, 0, set.stderr);
	assert.deepEqual(JSON.parse(set.stdout), {
		ssh: "100.64.10.20",
		gatewaySsh: "tunnel.192-168-68-50.sslip.io",
	});
	const unset = run({ UMIAK_SSH_HOST: "" });
	assert.equal(JSON.parse(unset.stdout).ssh, "tunnel.192-168-68-50.sslip.io");
});
