import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createSetupHandler } from "./setup.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
test("fresh node download uses only the expiring setup capability and expires after callback", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-setup-asset-"));
	const bytes = Buffer.from("test-node-binary");
	await writeFile(join(dir, "umiak-node-linux-amd64"), bytes);
	await writeFile(join(dir, "umiak-node_ed25519.pub"), "ssh-ed25519 AAAA test");
	await writeFile(
		join(dir, "ca.conf"),
		"[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Test PVE Root\n[ca]\nbasicConstraints=critical,CA:TRUE\n",
	);
	execFileSync(
		"openssl",
		[
			"req",
			"-sha256",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-config",
			join(dir, "ca.conf"),
			"-keyout",
			join(dir, "ca.key"),
			"-out",
			join(dir, "ca.pem"),
			"-days",
			"1",
		],
		{ stdio: "ignore" },
	);
	const token = "a".repeat(64);
	const connection = {
		apiUrl: "https://pve:8006",
		node: "pve",
		sshHost: "192.168.68.116",
		tokenId: "umiak@pve!dev",
	};
	let state = {
		steps: { connection: { status: "ready", data: connection } },
		preparation: {
			mode: "fresh",
			origin: "https://stack.example:8443",
			gateway: "192.168.68.90",
			hash: hash(token),
			connectionHash: hash(JSON.stringify(connection)),
			expiresAt: Date.now() + 60000,
		},
	};
	const store = {
		read: async () => structuredClone(state),
		write: async (value) => {
			state = structuredClone(value);
		},
	};
	const handler = createSetupHandler({
		pool: {},
		store,
		secretsDir: dir,
		assetsDir: dir,
		makePve: () => ({ get: async () => ({}) }),
	});
	async function request(path, input) {
		const req = Readable.from(
			input === undefined ? [] : [JSON.stringify(input)],
		);
		req.url = path;
		req.method = input === undefined ? "GET" : "POST";
		let status, body, headers;
		const res = {
			writeHead: (code, h) => {
				status = code;
				headers = h;
			},
			end: (value) => {
				body = value;
			},
		};
		await handler(req, res, {
			origin: "https://stack.example:8443",
			owner: false,
		});
		return { status, body, headers };
	}
	const script = await request(`/pve-setup.sh?token=${token}`);
	assert.equal(script.status, 200);
	const encoded = script.body.match(/python3 - '([^']+)'/)[1];
	assert.equal(
		JSON.parse(Buffer.from(encoded, "base64")).nodeSha256,
		hash(bytes),
	);
	const download = await request(
		`/pve-setup.sh?token=${token}&asset=node-agent`,
	);
	assert.equal(download.status, 200);
	assert.deepEqual(download.body, bytes);
	assert.equal(download.headers["Cache-Control"], "no-store");
	assert.equal(
		(await request(`/pve-setup.sh?token=${token}&asset=other`)).status,
		400,
	);
	state.preparation.mode = "adopt";
	assert.equal(
		(await request(`/pve-setup.sh?token=${token}&asset=node-agent`)).status,
		400,
	);
	state.preparation.mode = "fresh";
	assert.equal(
		(await request(`/pve-setup.sh?token=${"b".repeat(64)}&asset=node-agent`))
			.status,
		400,
	);
	state.preparation.expiresAt = 0;
	assert.equal(
		(await request(`/pve-setup.sh?token=${token}&asset=node-agent`)).status,
		400,
	);
	state.preparation.expiresAt = Date.now() + 60000;
	const callback = await request("/quickstart/setup/callback", {
		token,
		tokenSecret: "fake-token-secret",
		caPem: await readFile(join(dir, "ca.pem"), "utf8"),
		sshPublicKey: "ssh-ed25519 AAAA",
	});
	assert.equal(callback.status, 200);
	assert.equal(
		(await request(`/pve-setup.sh?token=${token}&asset=node-agent`)).status,
		400,
	);
});
