import assert from "node:assert/strict";
import { test } from "node:test";
import {
	renderHelp,
	renderSetup,
	requireRootCA,
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
			if (path.endsWith("/storage"))
				return [{ storage: "local", content: "iso" }];
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
											? {
													"/": { "Sys.Audit": 1 },
													"/pool/umiak": { "VM.Audit": 1 },
													"/nodes/pve": { "Sys.AccessNetwork": 1 },
													"/storage/local": { "Datastore.AllocateTemplate": 1 },
												}
											: {};
		},
	};
	const r = await verifyAdoption(api, connection, async () => ({
		version: "test",
		config: { vmidMin: 500, vmidMax: 589, vnet: "umiak0" },
	}));
	assert.ok(r.checks.every((x) => x.ok));
	assert.ok(paths.every((x) => x.startsWith("/")));
	const withoutAudit = await verifyAdoption(
		{
			...api,
			get: async (path) => {
				const value = await api.get(path);
				if (path === "/access/permissions") delete value["/"];
				return value;
			},
		},
		connection,
		async () => ({
			version: "test",
			config: { vmidMin: 500, vmidMax: 589, vnet: "umiak0" },
		}),
	);
	const download = withoutAudit.checks.find((check) =>
		check.name.includes("native ISO download"),
	);
	assert.equal(download.ok, false);
	assert.equal(download.optional, true);

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
const bootstrapped = Object.fromEntries(
	["connection", "host"].map((name) => [name, { status: "ready", data: {} }]),
);
test("failed steps persist an error and cannot complete setup; retry clears error", async () => {
	let state = { steps: structuredClone(bootstrapped) };
	const store = {
		read: async () => structuredClone(state),
		write: async (s) => {
			state = structuredClone(s);
		},
	};
	const wizard = new SetupWizard({
		store,
		steps: {
			limits: async (x) => {
				if (!x.ok) throw new Error("pin mismatch");
				return { storage: "local-lvm" };
			},
		},
	});
	await assert.rejects(() => wizard.run("limits", {}), /pin mismatch/);
	assert.equal(state.steps.limits.status, "error");
	assert.equal(state.complete, false);
	await wizard.run("limits", { ok: true });
	assert.equal(state.steps.limits.status, "ready");
	assert.equal(state.steps.limits.error, undefined);
});
test("browser steps wait for the installer-recorded connection and host", async () => {
	const { createSetupHandler } = await import("./setup.mjs");
	let state = { steps: {} };
	const wizard = new SetupWizard({
		store: {
			read: async () => structuredClone(state),
			write: async (s) => {
				state = structuredClone(s);
			},
		},
		steps: { limits: async () => ({}) },
	});
	await assert.rejects(() => wizard.run("limits", {}), /installer/);
	assert.equal(state.steps.limits, undefined);
	const { Readable } = await import("node:stream");
	const handler = createSetupHandler({
		pool: {},
		store: {
			read: async () => structuredClone(state),
			write: async () => {},
		},
	});
	const req = Readable.from(["{}"]);
	req.url = "/quickstart/setup/limits";
	req.method = "POST";
	let status, data;
	await handler(
		req,
		{
			writeHead: (s) => {
				status = s;
			},
			end: (x) => {
				data = x;
			},
		},
		{ owner: true, origin: "https://stack.example" },
	);
	assert.equal(status, 400);
	assert.match(JSON.parse(data).error, /installer has not recorded connection/);
});
test("help substitutes origin and escapes hostile text with copy controls", () => {
	const html = renderHelp("https://pve.example:8443");
	assert.match(html, /https:\/\/pve.example:8443\/install.sh/);
	assert.match(html, /navigator.clipboard/);
	assert.match(html, /Claude Code/);
	assert.match(html, /Codex/);
	assert.doesNotMatch(
		renderSetup(
			{
				steps: {
					limits: { status: "error", error: "<script>alert(1)</script>" },
				},
			},
			"https://host",
		),
		/<script>alert/,
	);
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
test("legacy browser Connect, Prepare and callback routes are gone; PVE addresses stay denied", async () => {
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
	async function request(path, input) {
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
		await handler(req, res, { owner: true, origin: "https://stack.example" });
		return { status, data };
	}
	assert.equal((await request("/quickstart/setup/connection", {})).status, 404);
	assert.equal((await request("/quickstart/setup/host", {})).status, 404);
	assert.equal((await request("/quickstart/setup/prepare", {})).status, 404);
	assert.equal((await request("/quickstart/setup/callback", {})).status, 404);
	assert.equal((await request("/pve-setup.sh?token=x")).status, undefined);
	assert.equal(state.preparation, undefined);
	assert.equal(await handler.deniedPeer("::ffff:192.168.68.116"), true);
	assert.equal(await handler.deniedPeer("192.168.68.50"), false);
});
test("requireRootCA accepts a CA certificate and rejects anything else", async () => {
	const { mkdtemp, readFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { testTls } = await import("./test-helpers/tls.mjs");
	const dir = await mkdtemp(join(tmpdir(), "umiak-root-ca-"));
	await testTls(dir);
	const ca = await readFile(join(dir, "ca.pem"), "utf8");
	assert.equal(requireRootCA(ca), ca);
	assert.throws(() => requireRootCA("not a certificate"), /root CA/);
});
test("help copy examples contain actual newlines without owner certificate settings", () => {
	const html = renderHelp("https://stack.example");
	assert.match(html, /umiak login[^<]*\numiak create/);
	assert.doesNotMatch(html, /\\numiak create/);
	assert.doesNotMatch(html, /href="\/owner\/tls"/);
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
	assert.match(html, /Templates/);
	assert.match(html, /Smoke test/);
	assert.doesNotMatch(
		html,
		/Connect Proxmox|Prepare or adopt|chrome:\/\/flags|Funnel(?! Display)|docker compose/,
	);
	assert.match(html, /prefers-color-scheme/);
	assert.match(html, /umiak-theme/);
	assert.match(html, /aria-label="Appearance"/);
	assert.match(html, /data-theme="dark"/);
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

test("API adoption reads pending SDN metadata and refuses staged zone changes", async () => {
	const paths = [];
	const api = {
		get: async (path) => {
			paths.push(path);
			if (path === "/cluster/firewall/options") return { enable: 1 };
			if (path === "/access/permissions")
				return { "/pool/umiak": { "VM.Audit": 1 } };
			if (path.includes("/nodes/pve/storage")) return [];
			if (path === "/cluster/sdn/zones/umiak?pending=1")
				return { type: "simple", state: "changed" };
			return {};
		},
	};
	await assert.rejects(
		verifyAdoption(api, connection, async () => ({})),
		/SDN zone/,
	);
	assert.ok(paths.includes("/cluster/sdn/zones/umiak?pending=1"));
});

test("dashboard template registration preserves completion and smoke; wizard registration invalidates smoke", async () => {
	for (const dashboardBuild of [true, false]) {
		let state = {
			complete: true,
			steps: Object.fromEntries(
				["connection", "host", "limits", "network", "templates", "smoke"].map(
					(name) => [name, { status: "ready", data: {} }],
				),
			),
		};
		const wizard = new SetupWizard({
			store: {
				read: async () => structuredClone(state),
				write: async (next) => {
					state = next;
				},
			},
			steps: { templates: async () => ({ builds: [] }) },
		});
		await wizard.run("templates", {}, { dashboardBuild });
		assert.equal(state.complete, dashboardBuild);
		assert.equal(state.steps.smoke.status, dashboardBuild ? "ready" : "stale");
	}
});
