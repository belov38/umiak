import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import {
	formatSmbios1,
	PveApi,
	PveApiError,
	PveTaskError,
	SshNodeOps,
} from "@sbx/pve";
import { FakeNode, FakePve, TEMPLATE_CONFIG } from "@sbx/pve/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	loadNodeTopology,
	PveInfraRegistry,
	pveClientsFromSecrets,
} from "../src/adapters/pve-infra.ts";
import {
	type InfraSmbios,
	isPermanent,
	isRetryable,
	type NodeInfra,
} from "../src/ports.ts";
import { createTopology, type Topology } from "./fakes/world.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

const SIZE = { vcpu: 2, memoryMb: 2048 };

function smbiosFor(machineId: string): InfraSmbios {
	return {
		uuid: machineId,
		serial: `sbx1:${machineId}:${Buffer.alloc(32, 7).toString("base64url")}`,
	};
}

async function nodeName(nodeId: string): Promise<string> {
	const r = await db.pool.query<{ name: string }>(
		"SELECT name FROM runtime.nodes WHERE id = $1",
		[nodeId],
	);
	return r.rows[0]?.name ?? "";
}

async function leases(providerId: string) {
	const r = await db.pool.query<{
		vmid: number;
		mac: string;
		state: string;
		machine_id: string | null;
		purpose: string;
	}>(
		"SELECT vmid, mac, state, machine_id, purpose FROM runtime.vmid_leases WHERE provider_id = $1 ORDER BY vmid",
		[providerId],
	);
	return r.rows;
}

interface Env {
	topo: Topology;
	name: string;
	api: FakePve;
	node: FakeNode;
	registry: PveInfraRegistry;
	infra: NodeInfra;
	factoryCalls: number;
}

async function setup(): Promise<Env> {
	const topo = await createTopology(db.pool);
	const name = await nodeName(topo.nodeId);
	const api = new FakePve([], { node: name });
	// The template is visible in the pool: the anchor of "missing" detection.
	api.vms.set(599, {
		config: { ...TEMPLATE_CONFIG },
		status: "stopped",
		firewall: { rules: [], ipsets: {} },
	});
	const node = new FakeNode();
	const env = { topo, name, api, node, factoryCalls: 0 } as Env;
	env.registry = new PveInfraRegistry(db.pool, {
		secretsDir: "/nonexistent",
		clients: () => {
			env.factoryCalls += 1;
			return { api, node };
		},
	});
	env.infra = await env.registry.forNode(topo.nodeId);
	return env;
}

describe("PveInfraRegistry", () => {
	it("builds the clients of a node once and caches them", async () => {
		const e = await setup();
		expect(await e.registry.forNode(e.topo.nodeId)).toBe(e.infra);
		expect(e.factoryCalls).toBe(1);
		expect(e.infra.vmidRange).toEqual({ min: 500, max: 598 });
		expect(e.infra.templateVmids).toEqual([599]);
	});

	it("an unknown node is an error", async () => {
		const e = await setup();
		await expect(e.registry.forNode(randomUUID())).rejects.toThrow(/node/);
	});

	it("records a template lease for the active template", async () => {
		const e = await setup();
		expect(await leases(e.topo.providerId)).toEqual([
			expect.objectContaining({ vmid: 599, purpose: "template" }),
		]);
	});
});

describe("PveNodeInfra lifecycle", () => {
	let e: Env;
	beforeEach(async () => {
		e = await setup();
	});

	it("create, start, status, snapshot, delete; the lease lives in Postgres", async () => {
		const machineId = randomUUID();
		const smbios = smbiosFor(machineId);
		const vm = await e.infra.create({
			machineId,
			templateVmid: 599,
			size: { vcpu: 3, memoryMb: 3072 },
			smbios,
		});
		expect(vm.vmid).toBe(500);
		expect(vm.disks).toEqual([
			{
				slot: "scsi0",
				volume: "local-lvm:vm-500-disk-0",
				options: { discard: "on", iothread: "1", ssd: "1" },
			},
		]);
		const cfg = e.api.vms.get(500)?.config ?? {};
		expect(cfg.smbios1).toBe(formatSmbios1(smbios));
		expect(cfg.cores).toBe("3");
		expect(cfg.memory).toBe("3072");
		expect(await leases(e.topo.providerId)).toContainEqual(
			expect.objectContaining({
				vmid: 500,
				mac: vm.mac,
				state: "active",
				machine_id: machineId,
			}),
		);
		expect(await e.infra.leaseOf(machineId)).toEqual({
			vmid: 500,
			mac: vm.mac,
		});
		expect(await e.infra.vmSize(500)).toEqual({ vcpu: 3, memoryMb: 3072 });

		expect(await e.infra.status(500)).toBe("stopped");
		await e.infra.start(500);
		expect(await e.infra.status(500)).toBe("running");
		expect(await e.infra.qgaPing(500)).toBe(true);
		expect(await e.infra.qgaExec(500, ["true"])).toEqual({ exitCode: 0 });

		const lvId = randomUUID().replaceAll("-", "");
		const snap = await e.infra.snapshot(500, { lvId });
		expect(snap.consistency).toBe("quiesced");
		expect(snap.disks).toEqual([
			{
				slot: "scsi0",
				volume: `local-lvm:sbx-snap-${lvId}-scsi0`,
				options: { discard: "on", iothread: "1", ssd: "1" },
			},
		]);
		expect(snap.hw).toMatchObject({ cores: "3", memory: "3072" });
		expect(e.api.paths()).toContain(
			`POST /nodes/${e.name}/qemu/500/agent/fsfreeze-freeze`,
		);
		expect((await e.infra.listLvs()).map((l) => l.name)).toContain(
			`sbx-snap-${lvId}-scsi0`,
		);

		await e.infra.delete(500);
		expect(e.api.vms.has(500)).toBe(false);
		expect(await e.infra.status(500)).toBe("missing");
		expect(await e.infra.leaseOf(machineId)).toBeUndefined();
		expect(
			(await leases(e.topo.providerId)).filter((l) => l.vmid === 500),
		).toEqual([]);
	});

	it("a snapshot with an external hook uses it and not QGA; stopped is powered_off", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		const stopped = await e.infra.snapshot(vmid, {
			lvId: randomUUID().replaceAll("-", ""),
		});
		expect(stopped.consistency).toBe("powered_off");

		await e.infra.start(vmid);
		const hookCalls: string[] = [];
		const snap = await e.infra.snapshot(vmid, {
			lvId: randomUUID().replaceAll("-", ""),
			hook: {
				freeze: async () => {
					hookCalls.push("freeze");
				},
				thaw: async () => {
					hookCalls.push("thaw");
				},
			},
		});
		expect(snap.consistency).toBe("quiesced");
		expect(hookCalls).toEqual(["freeze", "thaw"]);
		expect(e.api.paths().some((p) => p.includes("fsfreeze"))).toBe(false);
	});

	it("QGA down during a running snapshot is a permanent quiesce_failed", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vmid);
		e.api.agentUp = false;
		const err = await e.infra
			.snapshot(vmid, { lvId: randomUUID().replaceAll("-", "") })
			.catch((x: unknown) => x);
		expect((err as { code?: string }).code).toBe("quiesce_failed");
		expect(isPermanent(err)).toBe(true);
		expect(await e.infra.qgaPing(vmid)).toBe(false);
	});

	it("fork from a snapshot, then delete the snapshot", async () => {
		const src = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: src,
			templateVmid: 599,
			size: { vcpu: 4, memoryMb: 4096 },
			smbios: smbiosFor(src),
		});
		const lvId = randomUUID().replaceAll("-", "");
		const snap = await e.infra.snapshot(vmid, { lvId });
		const child = randomUUID();
		const forked = await e.infra.fork({
			machineId: child,
			snapshot: { lvId, sourceVmid: vmid, disks: snap.disks, hw: snap.hw },
			smbios: smbiosFor(child),
		});
		expect(forked.vmid).not.toBe(vmid);
		const cfg = e.api.vms.get(forked.vmid)?.config ?? {};
		expect(cfg.cores).toBe("4");
		expect(cfg.smbios1).toBe(formatSmbios1(smbiosFor(child)));
		const forkLv = e.node.calls.find(
			(c) =>
				c.op === "lv.snapshot" &&
				JSON.stringify(c.args).includes(`vm-${forked.vmid}-disk-0`),
		);
		expect(JSON.stringify(forkLv?.args)).toContain(`sbx-snap-${lvId}-scsi0`);
		expect(await e.infra.leaseOf(child)).toEqual({
			vmid: forked.vmid,
			mac: forked.mac,
		});

		await e.infra.deleteSnapshot({
			lvId,
			sourceVmid: vmid,
			disks: [],
			hw: {},
		});
		expect(
			(await e.infra.listLvs()).filter((l) =>
				l.tags.includes(`sbx-snap-${lvId}`),
			),
		).toEqual([]);
	});

	it("shutdown: stopped, or timeout when the VM still runs", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vmid);
		expect(await e.infra.shutdown(vmid, 30)).toBe("stopped");
		await e.infra.start(vmid);
		e.api.fail[`POST /nodes/${e.name}/qemu/${vmid}/status/shutdown`] =
			new PveTaskError("UPID:x", "VM quit/powerdown failed - got timeout");
		expect(await e.infra.shutdown(vmid, 1)).toBe("timeout");
		expect(await e.infra.status(vmid)).toBe("running");
		await e.infra.stop(vmid);
		expect(await e.infra.status(vmid)).toBe("stopped");
	});

	it("configure sets cores and memory", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.configure(vmid, { vcpu: 6, memoryMb: 6144 });
		expect(await e.infra.vmSize(vmid)).toEqual({ vcpu: 6, memoryMb: 6144 });
	});

	it("status: missing only when the VM is not listed; paused from qmpstatus", async () => {
		expect(await e.infra.status(555)).toBe("missing");
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		const vm = e.api.vms.get(vmid);
		if (vm) vm.status = "paused";
		expect(await e.infra.status(vmid)).toBe("paused");
		// A listed VM whose status cannot be read is an error, not "missing".
		e.api.fail[`GET /nodes/${e.name}/qemu/${vmid}/status/current`] =
			new PveApiError(403, "Permission check failed");
		await expect(e.infra.status(vmid)).rejects.toThrow(/Permission/);
	});

	it("status: an unanchored listing (lost pool ACL) is a transient error, not missing", async () => {
		e.api.vms.delete(599);
		const err = await e.infra.status(555).catch((x: unknown) => x);
		expect((err as { code?: string }).code).toBe("pve_listing_unverified");
		expect(isRetryable(err)).toBe(true);
	});

	it("status: another leased VM in the listing is an anchor too", async () => {
		e.api.vms.delete(599);
		const m = randomUUID();
		await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		expect(await e.infra.status(555)).toBe("missing");
	});

	it("status: a failing /cluster/resources rethrows", async () => {
		e.api.fail["GET /cluster/resources"] = new PveApiError(
			500,
			"GET /cluster/resources: proxy loop",
		);
		const err = await e.infra.status(555).catch((x: unknown) => x);
		expect(String(err)).toMatch(/proxy loop/);
		expect(isRetryable(err)).toBe(true);
	});

	it("delete refuses a template and tolerates a missing VM", async () => {
		const err = await e.infra.delete(599).catch((x: unknown) => x);
		expect(String(err)).toMatch(/template/);
		expect(isPermanent(err)).toBe(true);

		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		e.api.vms.delete(vmid);
		e.api.ipam = e.api.ipam.filter((x) => x.vmid !== vmid);
		e.node.lvs = e.node.lvs.filter((l) => !l.name.startsWith(`vm-${vmid}-`));
		await e.infra.delete(vmid);
		expect(await e.infra.leaseOf(m)).toBeUndefined();
	});

	it("create again for the same machine reuses its lease and never rolls it back", async () => {
		const m = randomUUID();
		const first = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		const err = await e.infra
			.create({
				machineId: m,
				templateVmid: 599,
				size: SIZE,
				smbios: smbiosFor(m),
			})
			.catch((x: unknown) => x);
		expect(isRetryable(err)).toBe(true);
		expect(e.api.vms.has(first.vmid)).toBe(true);
		expect(await e.infra.leaseOf(m)).toEqual({
			vmid: first.vmid,
			mac: first.mac,
		});
	});

	it("errors that echo smbios1 leave the adapter scrubbed, without the original", async () => {
		const m = randomUUID();
		const smbios = smbiosFor(m);
		const secret = Buffer.from(smbios.serial).toString("base64");
		e.api.fail[`POST /nodes/${e.name}/qemu`] = new PveApiError(
			400,
			`POST /nodes/${e.name}/qemu: Parameter verification failed.`,
			{ smbios1: `value '${formatSmbios1(smbios)}' does not look valid` },
		);
		const err = (await e.infra
			.create({ machineId: m, templateVmid: 599, size: SIZE, smbios })
			.catch((x: unknown) => x)) as Error;
		expect(err.message).toContain("Parameter verification failed");
		expect(err.message).not.toContain(secret);
		expect(err.message).not.toContain(smbios.serial);
		expect(err.cause).toBeUndefined();
		expect(isPermanent(err)).toBe(true);
	});

	it("listVms: this node only, with pool, tags, status and template", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		e.api.vms.set(599, {
			config: { ...TEMPLATE_CONFIG },
			status: "stopped",
			firewall: { rules: [], ipsets: {} },
		});
		e.api.vms.set(570, {
			config: { tags: "sbx;extra" },
			status: "running",
			firewall: { rules: [], ipsets: {} },
		});
		e.api.vms.set(571, {
			config: { tags: "sbx" },
			node: "elsewhere",
			status: "running",
			firewall: { rules: [], ipsets: {} },
		});
		const vms = await e.infra.listVms();
		expect(vms.map((v) => v.vmid).sort()).toEqual([vmid, 570, 599].sort());
		expect(vms.find((v) => v.vmid === vmid)).toEqual({
			vmid,
			status: "stopped",
			pool: "sandbox",
			tags: ["sbx"],
			template: false,
		});
		expect(vms.find((v) => v.vmid === 570)?.tags).toEqual(["sbx", "extra"]);
		expect(vms.find((v) => v.vmid === 599)?.template).toBe(true);
	});

	it("listLvs and removeLvs go through sbx-node", async () => {
		e.node.lvs.push(
			{ name: "sbx-snap-aa-scsi0", tags: ["sbx", "sbx-snap-aa"] },
			{ name: "vm-590-disk-0", tags: ["sbx", "sbx-vm-590"] },
		);
		expect(await e.infra.listLvs()).toEqual([
			{ name: "sbx-snap-aa-scsi0", tags: ["sbx", "sbx-snap-aa"] },
			{ name: "vm-590-disk-0", tags: ["sbx", "sbx-vm-590"] },
		]);
		await e.infra.removeLvs(["vm-590-disk-0"]);
		await e.infra.removeLvs([]);
		expect(e.node.lvs.map((l) => l.name)).toEqual(["sbx-snap-aa-scsi0"]);
		expect(e.node.ops().filter((o) => o === "lv.remove")).toHaveLength(1);
	});
});

describe("pveClientsFromSecrets", () => {
	const KNOWN = (host: string) =>
		`${host} ssh-ed25519 ${Buffer.from("fake-host-key").toString("base64")}\n`;

	function writeSecrets(dir: string, host = "sbx-node") {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "pve-token"), "token-secret\n");
		chmodSync(join(dir, "pve-token"), 0o600);
		writeFileSync(
			join(dir, "pve-root-ca.pem"),
			"-----BEGIN CERTIFICATE-----\n",
		);
		writeFileSync(join(dir, "sbx-node_ed25519"), "private key");
		chmodSync(join(dir, "sbx-node_ed25519"), 0o600);
		writeFileSync(join(dir, "known_hosts"), KNOWN(host));
	}

	it("reads <secretsDir>/<secret_ref>/ files and builds PveApi and SshNodeOps", async () => {
		const topo = await createTopology(db.pool);
		const t = await loadNodeTopology(db.pool, topo.nodeId);
		const root = mkdtempSync(join(tmpdir(), "sbx-secrets-"));
		writeSecrets(join(root, t.secretRef));
		const c = await pveClientsFromSecrets(root, {})(t);
		expect(c.api).toBeInstanceOf(PveApi);
		expect(c.node).toBeInstanceOf(SshNodeOps);
		c.close?.();
	});

	it("falls back to files directly in secretsDir when the secret_ref dir is absent", async () => {
		const topo = await createTopology(db.pool);
		const t = await loadNodeTopology(db.pool, topo.nodeId);
		const root = mkdtempSync(join(tmpdir(), "sbx-secrets-"));
		writeSecrets(root);
		const c = await pveClientsFromSecrets(root, {})(t);
		expect(c.api).toBeInstanceOf(PveApi);
		c.close?.();
	});

	it("rejects a token file readable by others", async () => {
		const topo = await createTopology(db.pool);
		const t = await loadNodeTopology(db.pool, topo.nodeId);
		const root = mkdtempSync(join(tmpdir(), "sbx-secrets-"));
		writeSecrets(root);
		chmodSync(join(root, "pve-token"), 0o644);
		await expect(async () =>
			pveClientsFromSecrets(root, {})(t),
		).rejects.toThrow(/mode 600/);
	});

	it("SBX_NODE_SSH_HOST overrides node_agent_ref as the SSH host", async () => {
		const topo = await createTopology(db.pool);
		const t = await loadNodeTopology(db.pool, topo.nodeId);
		const root = mkdtempSync(join(tmpdir(), "sbx-secrets-"));
		writeSecrets(root, "pve.example.ts.net");
		await expect(async () =>
			pveClientsFromSecrets(root, {})(t),
		).rejects.toThrow(/no pinned host key for sbx-node/);
		const c = await pveClientsFromSecrets(root, {
			SBX_NODE_SSH_HOST: "pve.example.ts.net",
		})(t);
		expect(c.node).toBeInstanceOf(SshNodeOps);
		c.close?.();
	});
});
