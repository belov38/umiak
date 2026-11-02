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
	writeFileSync(join(dir, "payload-secret"), "payload-secret-value\n");
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
			"console.log(JSON.stringify({db:process.env.DATABASE_URL,payload:process.env.PAYLOAD_SECRET,token:process.env.UMIAK_PVE_TOKEN_ID,tunnel:process.env.UMIAK_TUNNEL_URL,preview:process.env.UMIAK_GATEWAY_PREVIEW_DOMAIN,portDomain:process.env.UMIAK_PORT_DOMAIN,host:process.env.UMIAK_GATEWAY_TUNNEL_HOST}))",
		],
		{
			env: {
				...process.env,
				UMIAK_DATABASE_PASSWORD_FILE: join(dir, "password"),
				UMIAK_PAYLOAD_SECRET_FILE: join(dir, "payload-secret"),
				UMIAK_SECRETS_DIR: dir,
			},
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		db: `postgres://umiak:${"a".repeat(64)}@postgres:5432/umiak`,
		payload: "payload-secret-value",
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
