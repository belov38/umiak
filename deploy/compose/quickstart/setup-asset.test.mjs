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
			caPath: "/etc/ssl/certs/ca-certificates.crt",
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
	assert.equal(
		JSON.parse(Buffer.from(encoded, "base64")).caPath,
		"/etc/ssl/certs/ca-certificates.crt",
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
	const caPem = await readFile(join(dir, "ca.pem"), "utf8");
	await writeFile(join(dir, "pve-root-ca.pem"), caPem);
	const rules = [
		{
			type: "out",
			action: "ACCEPT",
			proto: "tcp",
			dport: "443",
			dest: "+umiak-gateway",
		},
		...[
			"10.0.0.0/8",
			"172.16.0.0/12",
			"192.168.0.0/16",
			"100.64.0.0/10",
			"169.254.0.0/16",
			"224.0.0.0/4",
			"::/1",
			"8000::/1",
		].map((dest) => ({ type: "out", action: "DROP", dest })),
	];
	state.hostReport = {
		user: { enable: 1 },
		zone: { type: "simple" },
		vnet: { zone: "umiak" },
		firewall: { enable: 1 },
		nodeFirewall: { enable: 1 },
		vmFirewallsValid: true,
		rules,
		ipset: [{ cidr: "192.168.68.90" }],
	};
	state.hostReportAt = new Date().toISOString();
	let reads = 0;
	const adoption = createSetupHandler({
		pool: {},
		store,
		secretsDir: dir,
		makePve: () => ({
			get: async (path) => {
				reads++;
				if (path === "/cluster/firewall/options")
					throw Object.assign(new Error("forbidden"), { status: 403 });
				return {};
			},
		}),
		nodeCheck: async () => ({
			version: "test",
			config: { vmidMin: 500, vmidMax: 589, vnet: "umiak0" },
		}),
	});
	await adoption.wizard.run("host", { mode: "adopt" });
	assert.equal(state.hostReportUsed, true);
	await assert.rejects(
		() => adoption.wizard.run("host", { mode: "adopt" }),
		/generate a new read-only adoption report/,
	);
	assert.ok(reads >= 3);
	state.hostReportUsed = false;
	state.hostReportAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
	await assert.rejects(
		() => adoption.wizard.run("host", { mode: "adopt" }),
		/generate a new/,
	);
	state.hostReportAt = new Date().toISOString();
	const disabled = createSetupHandler({
		pool: {},
		store,
		secretsDir: dir,
		makePve: () => ({ get: async () => ({ enable: 0 }) }),
	});
	await assert.rejects(
		() => disabled.wizard.run("host", { mode: "adopt" }),
		/Cluster firewall must be enabled/,
	);

	const callback = await request("/quickstart/setup/callback", {
		token,
		tokenSecret: "fake-token-secret",
		caPem: await readFile(join(dir, "ca.pem"), "utf8"),
		sshPublicKey: `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString("base64")}`,
	});
	assert.equal(callback.status, 200);
	assert.equal(
		(await request(`/pve-setup.sh?token=${token}&asset=node-agent`)).status,
		400,
	);
});
