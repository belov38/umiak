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
			return path.includes("/zones/")
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
	async function request(path, input, owner = true) {
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
		await handler(req, res, { owner, origin: "https://stack.example" });
		return { status, data: JSON.parse(data) };
	}
	const prepared = await request("/quickstart/setup/prepare", {});
	assert.equal(prepared.status, 200);
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
