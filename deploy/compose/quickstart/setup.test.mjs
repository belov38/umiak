import assert from "node:assert/strict";
import { test } from "node:test";
import {
	renderHelp,
	renderSetup,
	SetupWizard,
	validateConnection,
	validateLimits,
	validateNetwork,
	verifyAdoption,
} from "./setup.mjs";

const denySets = {
	"umiak-deny": [
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"100.64.0.0/10",
		"169.254.0.0/16",
		"224.0.0.0/4",
	].map((cidr) => ({ cidr })),
	"umiak-deny6": [{ cidr: "::/1" }, { cidr: "8000::/1" }],
};
const connection = {
	apiUrl: "https://192.168.68.116:8006",
	fingerprint: `${"AA:".repeat(31)}AA`,
	node: "pve",
	tokenId: "umiak@pve!dev",
};
test("connection requires a pinned TLS SHA256 fingerprint and safe node name", () => {
	assert.equal(validateConnection(connection).node, "pve");
	assert.throws(
		() => validateConnection({ ...connection, fingerprint: "" }),
		/fingerprint/,
	);
	assert.throws(
		() => validateConnection({ ...connection, node: "pve; reboot" }),
		/node/,
	);
	assert.throws(
		() => validateConnection({ ...connection, apiUrl: "http://pve:8006" }),
		/https/,
	);
});
test("limits protect infrastructure and clamp total sandbox RAM", () => {
	assert.equal(
		validateLimits({
			storage: "local-lvm",
			vmidMin: 500,
			vmidMax: 589,
			ramCapMb: 8192,
		}).ramCapMb,
		8192,
	);
	for (const limits of [
		{ vmidMin: 499, vmidMax: 589, ramCapMb: 8192 },
		{ vmidMin: 500, vmidMax: 590, ramCapMb: 8192 },
		{ vmidMin: 500, vmidMax: 589, ramCapMb: 8193 },
	])
		assert.throws(() => validateLimits({ storage: "local-lvm", ...limits }));
});
test("network derives preview DNS and refuses guest loopback", () => {
	assert.equal(
		validateNetwork({ gatewayAddress: "192.168.68.90" }).previewDomain,
		"umiak.192-168-68-90.sslip.io",
	);
	assert.throws(() => validateNetwork({ gatewayAddress: "127.0.0.1" }));
});
test("adoption reads only existing PVE objects and fails closed on missing zone", async () => {
	const paths = [];
	const api = {
		get: async (path) => {
			paths.push(path);
			return path === "/cluster/firewall/options"
				? { enable: 1 }
				: path.includes("/zones/")
					? { type: "simple" }
					: path.includes("/vnets/")
						? { zone: "umiak" }
						: path.includes("/ipset/")
							? denySets[path.split("/").at(-1)] || [{ cidr: "192.168.68.90" }]
							: path.includes("/groups/")
								? [
										{
											type: "out",
											action: "ACCEPT",
											proto: "tcp",
											dport: "443",
											dest: "+umiak-gateway",
										},
										{ type: "out", action: "DROP", dest: "+umiak-deny" },
										{ type: "out", action: "DROP", dest: "+umiak-deny6" },
									]
								: path.includes("/tokens/")
									? { privsep: 1 }
									: path.includes("/users/")
										? { enable: 1 }
										: path === "/access/permissions"
											? { "/pool/umiak": { "VM.Audit": 1 } }
											: {};
		},
	};
	const r = await verifyAdoption(api, connection, async () => ({
		version: "test",
		config: { vmidMin: 500, vmidMax: 589, vnet: "umiak0" },
	}));
	assert.ok(r.checks.every((x) => x.ok));
	assert.ok(paths.every((x) => x.startsWith("/")));
	await assert.rejects(
		() =>
			verifyAdoption(
				{
					...api,
					get: async (p) =>
						p.includes("/zones/")
							? Promise.reject(new Error("missing zone"))
							: api.get(p),
				},
				connection,
				async () => ({}),
			),
		/missing zone/,
	);
});
test("failed steps persist an error and cannot complete setup; retry clears error", async () => {
	let state = { steps: {} };
	const store = {
		read: async () => structuredClone(state),
		write: async (s) => {
			state = structuredClone(s);
		},
	};
	const wizard = new SetupWizard({
		store,
		steps: {
			connection: async (x) => {
				if (!x.ok) throw new Error("pin mismatch");
				return { node: "pve" };
			},
		},
	});
	await assert.rejects(() => wizard.run("connection", {}), /pin mismatch/);
	assert.equal(state.steps.connection.status, "error");
	assert.equal(state.complete, false);
	await wizard.run("connection", { ok: true });
	assert.equal(state.steps.connection.status, "ready");
	assert.equal(state.steps.connection.error, undefined);
});
test("help substitutes origin and escapes hostile text with copy controls", () => {
	const html = renderHelp("https://pve.example:8443");
	assert.match(html, /https:\/\/pve.example:8443\/install.sh/);
	assert.match(html, /navigator.clipboard/);
	assert.match(html, /Claude Code/);
	assert.match(html, /Codex/);
	assert.doesNotMatch(
		renderSetup(
			{ steps: { connection: { error: "<script>alert(1)</script>" } } },
			"https://host",
		),
		/<script>alert/,
	);
});
test("connection preserves mounted PVE root CA and writes the configured token ID", async () => {
	const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createSetupHandler } = await import("./setup.mjs");
	const dir = await mkdtemp(join(tmpdir(), "umiak-setup-ca-"));
	await writeFile(join(dir, "pve-root-ca.pem"), "existing-root-ca");
	let state = { steps: {} };
	const store = {
		read: async () => structuredClone(state),
		write: async (s) => {
			state = structuredClone(s);
		},
	};
	const handler = createSetupHandler({
		pool: {},
		store,
		secretsDir: dir,
		makePve: () => ({
			get: async () => ({}),
			certificate: () => "pinned-server-leaf",
		}),
	});
	await handler.wizard.run("connection", {
		...connection,
		tokenSecret: "private-test-token",
	});
	assert.equal(
		await readFile(join(dir, "pve-root-ca.pem"), "utf8"),
		"existing-root-ca",
	);
	assert.equal(
		await readFile(join(dir, "pve-token-id"), "utf8"),
		connection.tokenId,
	);
	assert.doesNotMatch(JSON.stringify(state), /private-test-token/);
});
test("IPv4 gateway derives a DNS tunnel host compatible with generated gateway certificates", () => {
	assert.equal(
		validateNetwork({ gatewayAddress: "192.168.68.90" }).tunnelUrl,
		"wss://tunnel.192-168-68-90.sslip.io/v1/connect",
	);
});
test("isolation verification rejects missing gateway rules and gateways outside IPSet", async () => {
	const { verifyIsolation } = await import("./setup-host.mjs");
	const rules = [
		{
			type: "out",
			action: "ACCEPT",
			dest: "+umiak-gateway",
			proto: "tcp",
			dport: "443",
		},
		{ type: "out", action: "DROP", dest: "+umiak-deny" },
		{ type: "out", action: "DROP", dest: "+umiak-deny6" },
	];
	assert.equal(
		verifyIsolation(
			rules,
			[{ cidr: "192.168.68.90" }],
			"192.168.68.90",
			denySets,
		),
		true,
	);
	assert.throws(
		() =>
			verifyIsolation(
				rules,
				[{ cidr: "192.168.68.91" }],
				"192.168.68.90",
				denySets,
			),
		/absent/,
	);
	assert.throws(
		() =>
			verifyIsolation(
				rules.slice(1),
				[{ cidr: "192.168.68.90" }],
				undefined,
				denySets,
			),
		/tcp\/443/,
	);
	assert.throws(
		() =>
			verifyIsolation(
				rules.slice(0, 1),
				[{ cidr: "192.168.68.90" }],
				undefined,
				denySets,
			),
		/deny/,
	);
});
test("adoption callback token expires, is single use, and setup denies the configured PVE SNAT address", async () => {
	const { Readable } = await import("node:stream");
	const { createSetupHandler } = await import("./setup.mjs");
	let state = {
		steps: {
			connection: {
				status: "ready",
				data: { ...connection, deniedAddresses: ["192.168.68.116"] },
			},
		},
	};
	const store = {
		read: async () => structuredClone(state),
		write: async (s) => {
			state = structuredClone(s);
		},
	};
	const handler = createSetupHandler({ pool: {}, store });
	async function request(path, input, owner = true, ownerPrivateCA = true) {
		const req = Readable.from(
			input === undefined ? [] : [JSON.stringify(input)],
		);
		req.url = path;
		req.method = input === undefined ? "GET" : "POST";
		let status, data;
		const res = {
			writeHead: (s) => {
				status = s;
			},
			end: (x) => {
				data = x;
			},
		};
		await handler(req, res, {
			owner,
			ownerPrivateCA,
			origin: "https://stack.example",
		});
		return { status, data: JSON.parse(data) };
	}
	const publicPrepared = await request(
		"/quickstart/setup/prepare",
		{},
		true,
		false,
	);
	assert.equal(publicPrepared.status, 200);
	assert.doesNotMatch(
		publicPrepared.data.command,
		/--cacert|Copy the verified quickstart CA/,
	);
	assert.equal(state.preparation.caPath, "/etc/ssl/certs/ca-certificates.crt");

	const prepared = await request("/quickstart/setup/prepare", {});
	assert.equal(prepared.status, 200);
	assert.match(prepared.data.command, /--cacert/);
	assert.equal(
		state.preparation.caPath,
		"/root/.config/umiak/quickstart-ca.pem",
	);
	const token = prepared.data.command.match(/token=([a-f0-9]{64})/)[1];
	const report = { zone: { type: "simple" }, vnet: { zone: "umiak" } };
	const accepted = await request(
		"/quickstart/setup/callback",
		{ token, report },
		false,
	);
	assert.equal(accepted.status, 200);
	assert.equal(
		(await request("/quickstart/setup/callback", { token, report }, false))
			.status,
		400,
	);
	await request("/quickstart/setup/prepare", {});
	state.preparation.expiresAt = Date.now() - 1;
	assert.equal(
		(await request("/quickstart/setup/callback", { token, report }, false))
			.status,
		400,
	);
	assert.equal(await handler.deniedPeer("::ffff:192.168.68.116"), true);
	assert.equal(await handler.deniedPeer("192.168.68.50"), false);
});
test("host adoption cannot become ready without a valid mounted PVE root CA", async () => {
	const { createSetupHandler } = await import("./setup.mjs");
	const { mkdtemp } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	let state = { steps: { connection: { status: "ready", data: connection } } };
	const store = {
		read: async () => structuredClone(state),
		write: async (s) => {
			state = structuredClone(s);
		},
	};
	const secretsDir = await mkdtemp(join(tmpdir(), "umiak-missing-root-"));
	const handler = createSetupHandler({
		pool: {},
		store,
		secretsDir,
		makePve: () => ({ get: async () => ({}) }),
	});
	await assert.rejects(
		() => handler.wizard.run("host", { mode: "adopt" }),
		/valid PVE root CA/,
	);
	assert.equal(state.steps.host.status, "error");
	assert.equal(state.complete, false);
});
test("help copy examples contain actual newlines and link certificate settings", () => {
	const html = renderHelp("https://stack.example");
	assert.match(html, /umiak login[^<]*\numiak create/);
	assert.doesNotMatch(html, /\\numiak create/);
	assert.match(html, /href="\/owner\/tls"/);
	assert.doesNotMatch(
		renderSetup({ steps: {} }, "https://stack.example"),
		/otherwise pin the leaf/,
	);
});

test("wizard refuses inherited step names without writing state", async () => {
	let writes = 0;
	const wizard = new SetupWizard({
		store: {
			read: async () => ({ steps: {} }),
			write: async () => {
				writes++;
			},
		},
		steps: {},
	});
	await assert.rejects(
		() => wizard.run("constructor", {}),
		/Unknown setup step/,
	);
	assert.equal(writes, 0);
});
test("adoption rejects disabled cluster firewall before accepting host", async () => {
	await assert.rejects(
		() =>
			verifyAdoption(
				{
					get: async (path) =>
						path === "/cluster/firewall/options" ? { enable: 0 } : {},
				},
				connection,
				async () => ({}),
			),
		/firewall/,
	);
});
test("wizard UI has themes, progress and template selections without raw JSON", () => {
	const html = renderSetup(
		{
			steps: {},
			detectedTemplates: [
				{ templateSlug: "linux", pveVmid: 597, name: "Linux" },
			],
		},
		"https://stack.example",
	);
	assert.match(html, /prefers-color-scheme/);
	assert.match(html, /umiak-theme/);
	assert.match(html, /Toggle light and dark theme/);
	assert.match(html, /progress/);
	assert.match(html, /type="checkbox"/);
	assert.doesNotMatch(
		html,
		/Build registrations \(JSON\)|prepared stand|umiak-tpl preflight/,
	);
	assert.doesNotMatch(html, /class="ready">Not configured/);
});

test("SSH callback rejects multiline and malformed host keys", async () => {
	const { validateSshPublicKey } = await import("./setup.mjs");
	const key = Buffer.concat([
		Buffer.from([0, 0, 0, 11]),
		Buffer.from("ssh-ed25519"),
		Buffer.from([0, 0, 0, 32]),
		Buffer.alloc(32, 1),
	]);
	const valid = `ssh-ed25519 ${key.toString("base64")}`;
	assert.equal(validateSshPublicKey(valid), valid);
	for (const value of [
		`${valid}\n`,
		`${valid}\nhost ssh-ed25519 AAAA`,
		"ssh-ed25519 AAAA",
	])
		assert.throws(() => validateSshPublicKey(value), /Invalid SSH/);
});

test("isolation permits disabled host rules and sealed templates but checks sandbox firewalls", async () => {
	const { verifyFirewall } = await import("./setup-host.mjs");
	const data = {
		"/cluster/firewall/options": { enable: 1 },
		"/nodes/pve/firewall/options": { enable: 0 },
		"/nodes/pve/qemu": [
			{ vmid: 597, template: 1 },
			{ vmid: 500, name: "umiak-500" },
		],
		"/nodes/pve/qemu/597/config": {
			tags: "umiak-tpl",
			net0: "virtio=00:11:22:33:44:55,bridge=umiak0",
		},
		"/nodes/pve/qemu/597/firewall/options": { enable: 0 },
		"/nodes/pve/qemu/500/config": {
			tags: "umiak",
			net0: "virtio=00:11:22:33:44:55,bridge=umiak0,firewall=1",
		},
		"/nodes/pve/qemu/500/firewall/options": {
			enable: 1,
			policy_in: "DROP",
			macfilter: 1,
			ipfilter: 1,
		},
		"/nodes/pve/qemu/500/firewall/rules": [
			{ type: "group", action: "umiak-egress", enable: 1, iface: "net0" },
		],
	};
	const reads = [];
	const api = {
		get: async (path) => {
			reads.push(path);
			return data[path];
		},
	};
	const result = await verifyFirewall(api, { node: "pve" });
	assert.equal(result.nodeFirewall.enable, 0);
	assert.ok(!reads.some((path) => path.includes("/597/")));
	data["/nodes/pve/qemu/500/firewall/options"].policy_in = "ACCEPT";
	await assert.rejects(
		() => verifyFirewall(api, { node: "pve" }),
		/VM 500 isolation/,
	);
	data["/nodes/pve/qemu/500/firewall/options"].policy_in = "DROP";
	const rules = data["/nodes/pve/qemu/500/firewall/rules"];
	data["/nodes/pve/qemu/500/firewall/rules"] = [];
	await assert.rejects(
		() => verifyFirewall(api, { node: "pve" }),
		/VM 500 net0 egress/,
	);
	data["/nodes/pve/qemu/500/firewall/rules"] = rules;
	data["/nodes/pve/qemu/500/firewall/options"].enable = 0;
	await assert.rejects(
		() => verifyFirewall(api, { node: "pve" }),
		/VM 500 firewall/,
	);
	data["/nodes/pve/qemu/500/firewall/options"].enable = 1;
	data["/nodes/pve/qemu/500/config"].net0 =
		"virtio=00:11:22:33:44:55,bridge=umiak0";
	await assert.rejects(
		() => verifyFirewall(api, { node: "pve" }),
		/net0 firewall/,
	);
});
