import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootstrapFromInstall, safeBootstrap } from "./bootstrap.mjs";
import { createSetupHandler } from "./setup.mjs";

const install = {
	version: 1,
	release: "0.2.0",
	connection: {
		apiUrl: "https://192.168.68.116:8006",
		node: "pve",
		tokenId: "umiak@pve!umiak",
		fingerprint: "ab".repeat(32),
		tlsName: "pve",
		sshHost: "192.168.68.116",
	},
	limits: {
		storage: "local-lvm",
		vmidMin: 500,
		vmidMax: 589,
		ramCapMb: 8192,
		templateVmidMin: 600,
		templateVmidMax: 699,
	},
	network: {
		gatewayAddress: "192.168.68.50",
		guestDns: "1.1.1.1",
		previewDomain: "umiak.100-64-10-20.sslip.io",
		sshHost: "100.64.10.20",
	},
	publicUrl: "https://umiak.tail0000.ts.net",
};
const report = {
	user: { enable: 1 },
	zone: { type: "simple" },
	vnet: { zone: "umiak" },
	firewall: { enable: 1 },
	vmFirewallsValid: true,
	ipset: [{ cidr: "192.168.68.50" }],
	rules: [
		{
			type: "out",
			action: "ACCEPT",
			dest: "+umiak-gateway",
			proto: "tcp",
			dport: "443",
			enable: 1,
		},
		{ type: "out", action: "DROP", dest: "+umiak-deny", enable: 1 },
	],
	denySets: { "umiak-deny": [{ cidr: "0.0.0.0/0" }, { cidr: "::/0" }] },
};

async function setup(overrides = {}) {
	const dir = await mkdtemp(join(tmpdir(), "umiak-bootstrap-"));
	const files = { install: structuredClone(install), report, ...overrides };
	const secretsDir = join(dir, "secrets");
	const write = async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(secretsDir, { recursive: true });
		await writeFile(
			join(secretsDir, "install.json"),
			JSON.stringify(files.install),
		);
		await writeFile(
			join(secretsDir, "host-report.json"),
			JSON.stringify(files.report),
		);
		await writeFile(join(secretsDir, "pve-token"), "secret\n");
	};
	let state = { steps: {}, complete: false };
	let writes = 0;
	const store = {
		read: async () => structuredClone(state),
		write: async (value) => {
			writes++;
			state = value;
		},
		exclusive: (fn) => fn(),
	};
	const nodes = new Map([["pve2", { id: 9, node_agent_ref: "10.0.0.2" }]]);
	const nodeUpserts = [];
	const pool = {
		query: async (sql, args) => {
			if (sql.includes("runtime.providers")) return { rows: [{ id: 1 }] };
			if (sql.includes("runtime.nodes")) {
				nodeUpserts.push(args);
				nodes.set(args[1], { id: 2, node_agent_ref: args[3] });
				return { rows: [{ id: 2 }] };
			}
			return { rows: [{ id: 3 }] };
		},
	};
	let versionError;
	const makePve = () => ({
		get: async (path) => {
			if (path === "/version") {
				if (versionError) throw versionError;
				return { version: "9.0" };
			}
			if (path === "/cluster/resources") return [];
			if (path.endsWith("/status")) return { type: "lvmthin" };
			if (path.endsWith("/qemu")) return [];
			throw new Error(`unexpected ${path}`);
		},
	});
	const networkFile = join(dir, "quickstart-network.json");
	const handler = createSetupHandler({
		store,
		pool,
		secretsDir,
		networkFile,
		makePve,
	});
	const options = () => ({
		store,
		secretsDir,
		steps: handler.wizard.steps,
		makePve,
		nodeCheck: async () => ({ version: "1.0" }),
		lookup: async () => [],
		now: () => new Date("2026-11-04T00:00:00Z"),
	});
	await write();
	return {
		files,
		write,
		options,
		networkFile,
		nodes,
		nodeUpserts,
		state: () => state,
		setState: (value) => {
			state = value;
		},
		writes: () => writes,
		failVersion: (error) => {
			versionError = error;
		},
	};
}

test("absent install.json leaves state untouched", async () => {
	const t = await setup();
	const { rm } = await import("node:fs/promises");
	await rm(join(t.options().secretsDir, "install.json"));
	assert.equal(await bootstrapFromInstall(t.options()), "absent");
	assert.equal(t.writes(), 0);
});

test("first import records bootstrap, limits and network; second is unchanged", async () => {
	const t = await setup();
	assert.equal(await bootstrapFromInstall(t.options()), "imported");
	const s = t.state();
	for (const name of ["connection", "host", "limits", "network"])
		assert.equal(s.steps[name].status, "ready", name);
	assert.equal(s.complete, false);
	assert.deepEqual(s.steps.connection.data.deniedAddresses, ["192.168.68.116"]);
	assert.equal(s.bootstrap.release, "0.2.0");
	assert.equal(s.bootstrap.sshHost, "100.64.10.20");
	assert.equal(s.bootstrap.publicUrl, install.publicUrl);
	assert.match(s.bootstrap.digest, /^[0-9a-f]{64}$/);
	assert.equal(t.nodeUpserts.length, 1);
	assert.deepEqual(
		[t.nodeUpserts[0][1], t.nodeUpserts[0][3]],
		["pve", "192.168.68.116"],
	);
	const network = JSON.parse(await readFile(t.networkFile, "utf8"));
	assert.equal(network.previewDomain, install.network.previewDomain);
	assert.equal(network.sshHost, undefined);
	const before = t.writes();
	assert.equal(await bootstrapFromInstall(t.options()), "unchanged");
	assert.equal(t.writes(), before);
	assert.equal(t.nodeUpserts.length, 1);
});

test("release-only update keeps completion and smoke; other nodes are never touched", async () => {
	const t = await setup();
	await bootstrapFromInstall(t.options());
	const s = t.state();
	s.steps.templates = { status: "ready", data: { builds: [] } };
	s.steps.smoke = { status: "ready", data: { ok: true } };
	s.complete = true;
	t.setState(s);
	t.files.install.release = "0.3.0";
	await t.write();
	assert.equal(await bootstrapFromInstall(t.options()), "imported");
	assert.equal(t.state().bootstrap.release, "0.3.0");
	assert.equal(t.state().complete, true);
	assert.deepEqual(t.state().steps.smoke.data, { ok: true });
	assert.equal(t.state().steps.templates.status, "ready");
	assert.deepEqual(t.nodes.get("pve2"), { id: 9, node_agent_ref: "10.0.0.2" });
	assert.ok(t.nodeUpserts.every((args) => args[1] === "pve"));
});

test("changed limits mark later steps stale", async () => {
	const t = await setup();
	await bootstrapFromInstall(t.options());
	const s = t.state();
	s.steps.templates = { status: "ready", data: { builds: [] } };
	s.steps.smoke = { status: "ready", data: {} };
	s.complete = true;
	t.setState(s);
	t.files.install.limits.ramCapMb = 4096;
	await t.write();
	await bootstrapFromInstall(t.options());
	assert.equal(t.state().steps.templates.status, "stale");
	assert.equal(t.state().steps.smoke.status, "stale");
	assert.equal(t.state().complete, false);
});

test("fingerprint mismatch and failing isolation throw without touching state", async () => {
	const t = await setup();
	t.failVersion(new Error("Proxmox TLS fingerprint mismatch; verify"));
	await assert.rejects(
		bootstrapFromInstall(t.options()),
		/fingerprint mismatch/,
	);
	assert.equal(t.writes(), 0);
	t.failVersion(undefined);
	t.files.report = { ...report, rules: [], ipset: [] };
	await t.write();
	await assert.rejects(bootstrapFromInstall(t.options()));
	assert.equal(t.writes(), 0);
	assert.equal(t.nodeUpserts.length, 0);
});

test("safeBootstrap logs failures and never throws", async () => {
	const t = await setup();
	t.failVersion(new Error("Proxmox TLS fingerprint mismatch; verify"));
	const logs = [];
	const result = await safeBootstrap(t.options(), (m) => logs.push(m));
	assert.equal(result, "error");
	assert.match(logs.join("\n"), /fingerprint mismatch/);
	assert.equal(t.writes(), 0);
});
