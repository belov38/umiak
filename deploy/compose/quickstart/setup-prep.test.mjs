import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderPreparation } from "./setup-prep.mjs";

test("fresh host dry run runs without PVE tools or mutation and never calls callback", async () => {
	const script = renderPreparation({
		origin: "https://stack.example:8443",
		token: "a".repeat(64),
		publicKey: "ssh-ed25519 AAAA test",
		gateway: "192.168.68.90",
		node: "pve",
	});
	const dir = await mkdtemp(join(tmpdir(), "umiak-prep-test-"));
	const file = join(dir, "prepare.sh");
	await writeFile(file, script);
	const result = spawnSync("bash", [file, "--dry-run"], {
		encoding: "utf8",
		env: { PATH: "/usr/bin:/bin" },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /umiak@pve/);
	assert.match(result.stdout, /rollback/);
	assert.match(result.stdout, /callback/);
	assert.doesNotMatch(result.stdout, /PVEAPIToken=/);
});
test("prep validates generated values before interpolating a shell script", () => {
	assert.throws(() =>
		renderPreparation({
			origin: "https://stack",
			token: "x;shutdown",
			publicKey: "ssh-ed25519 AAAA",
			gateway: "192.168.1.1",
			node: "pve",
		}),
	);
});
test("fresh SDN apply and rollback preserve the vmbr0 multicast setting", () => {
	const script = renderPreparation({
		origin: "https://stack.example:8443",
		token: "a".repeat(64),
		publicKey: "ssh-ed25519 AAAA test",
		gateway: "192.168.68.90",
		node: "pve",
	});
	assert.match(script, /mcast_hash_max/);
	assert.match(script, /restore_bridge/);
});
