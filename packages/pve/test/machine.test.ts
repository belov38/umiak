import { describe, expect, it } from "vitest";
import { Allocator } from "../src/allocator.ts";
import {
	formatSmbios1,
	Machines,
	pveVcpuControl,
	QgaUnavailableError,
	s2SerialPayload,
	TracesRemainError,
} from "../src/machine.ts";
import { PveApiError } from "../src/pve-api.ts";
import { SqliteStateStore } from "../src/state-sqlite.ts";
import { LvmThinDriver } from "../src/storage/lvmthin.ts";
import { FakeNode, FakePve } from "./fakes.ts";

function setup(opts: { cloneConcurrency?: number } = {}) {
	const log: string[] = [];
	const api = new FakePve(log);
	const node = new FakeNode(log);
	const store = new SqliteStateStore(":memory:");
	const allocator = new Allocator({
		store,
		clusterId: 1,
		range: { min: 500, max: 598 },
		templateVmid: 599,
		occupied: async () => new Set(),
	});
	const driver = new LvmThinDriver({
		node,
		vcpu: pveVcpuControl(api, "pve"),
		storage: "local-lvm",
		thawRetryDelayMs: 0,
	});
	const machines = new Machines({
		api,
		node,
		driver,
		allocator,
		snapshots: store,
		cfg: {
			node: "pve",
			storage: "local-lvm",
			vnet: "sbx0",
			pool: "sandbox",
			templateVmid: 599,
			clusterId: 1,
		},
		cloneConcurrency: opts.cloneConcurrency ?? 4,
		ipfilter: true,
		pollMs: 0,
	});
	return { log, api, node, store, allocator, machines };
}

describe("smbios", () => {
	it("formats smbios1 with a base64 serial", () => {
		expect(formatSmbios1({ uuid: "u", serial: "sbx1:x" })).toBe(
			"uuid=u,serial=c2J4MTp4,base64=1",
		);
	});
	it("builds the S2 serial payload", () => {
		const bs = new Uint8Array(32).fill(255);
		const p = s2SerialPayload("11111111-2222-3333-4444-555555555555", bs);
		expect(p).toBe(
			`sbx1:11111111-2222-3333-4444-555555555555:${Buffer.from(bs).toString("base64url")}`,
		);
		expect(p).toHaveLength(85);
	});
});

describe("create", () => {
	it("creates the VM in the pool first, then disks, config and firewall", async () => {
		const { api, node, machines, store } = setup();
		const m = await machines.create({});
		expect(m).toMatchObject({
			vmid: 500,
			mac: "02:01:00:00:01:F4",
			node: "pve",
		});
		expect(api.paths()).toEqual([
			"GET /nodes/pve/qemu/599/config",
			"POST /nodes/pve/qemu",
			"PUT /nodes/pve/qemu/500/config",
			"PUT /nodes/pve/qemu/500/firewall/options",
			"POST /nodes/pve/qemu/500/firewall/rules",
			"GET /cluster/sdn/ipams/pve/status",
			"POST /nodes/pve/qemu/500/firewall/ipset",
			"POST /nodes/pve/qemu/500/firewall/ipset/ipfilter-net0",
		]);
		expect(node.ops()).toEqual(["pool.usage", "lv.snapshot"]);
		expect(store.get(1, 500)?.state).toBe("active");

		const vm = api.vms.get(500);
		expect(vm?.config).toMatchObject({
			name: "sbx-500",
			net0: "virtio=02:01:00:00:01:F4,bridge=sbx0,firewall=1",
			ide2: "local-lvm:cloudinit",
			ipconfig0: "ip=dhcp",
			ciuser: "sbx",
			balloon: "0",
			cores: "2",
			memory: "2048",
			machine: "q35",
			scsi0: "local-lvm:vm-500-disk-0,discard=on,iothread=1,ssd=1",
			boot: "order=scsi0",
			tags: "sbx",
		});
		expect(vm?.firewall.options).toEqual({
			enable: 1,
			policy_in: "DROP",
			policy_out: "ACCEPT",
			dhcp: 1,
			ndp: 1,
			radv: 0,
			macfilter: 1,
			ipfilter: 1,
		});
		expect(vm?.firewall.rules).toEqual([
			{ type: "group", action: "sbx-egress", iface: "net0", enable: 1 },
		]);
		expect(vm?.firewall.ipsets).toEqual({ "ipfilter-net0": ["10.88.0.101"] });
	});

	it("copies only whitelisted hardware keys and never identity from the template", async () => {
		const { api, machines } = setup();
		await machines.create({});
		const post =
			api.calls.find((c) => c.method === "POST" && c.path === "/nodes/pve/qemu")
				?.params ?? {};
		expect(post.pool).toBe("sandbox");
		for (const k of [
			"sshkeys",
			"smbios1",
			"vmgenid",
			"description",
			"tags",
			"template",
			"scsi0",
		]) {
			expect(post).not.toHaveProperty(k);
		}
		expect(post).toMatchObject({
			machine: "q35",
			cpu: "host",
			ostype: "l26",
			scsihw: "virtio-scsi-single",
			serial0: "socket",
			vga: "std",
		});
	});

	it("passes the caller's smbios1", async () => {
		const { api, machines } = setup();
		await machines.create({
			smbios: { uuid: "u-1", serial: "sbx1:x" },
			size: { cores: 1, memoryMb: 1024 },
		});
		const post =
			api.calls.find((c) => c.path === "/nodes/pve/qemu")?.params ?? {};
		expect(post.smbios1).toBe("uuid=u-1,serial=c2J4MTp4,base64=1");
		expect(post).toMatchObject({ cores: 1, memory: 1024 });
	});

	it("rolls back through delete when a later step fails", async () => {
		const { api, node, machines, store } = setup();
		api.fail["PUT /nodes/pve/qemu/500/firewall/options"] = new PveApiError(
			500,
			"boom",
		);
		await expect(machines.create({})).rejects.toThrow(/boom/);
		expect(api.paths()).toContain("DELETE /nodes/pve/qemu/500");
		expect(api.vms.has(500)).toBe(false);
		expect(node.lvs).toEqual([]);
		expect(store.get(1, 500)).toBeUndefined();
	});

	it("releases the VMID when the VM was never created", async () => {
		const { api, machines, store } = setup();
		api.fail["POST /nodes/pve/qemu"] = new PveApiError(
			400,
			"Parameter verification failed.",
		);
		await expect(machines.create({})).rejects.toThrow(/Parameter verification/);
		expect(store.get(1, 500)).toBeUndefined();
	});

	it("limits concurrent clones per node", async () => {
		const { node, machines } = setup({ cloneConcurrency: 4 });
		let inFlight = 0;
		let max = 0;
		node.handlers["lv.snapshot"] = async (a) => {
			inFlight++;
			max = Math.max(max, inFlight);
			await new Promise((r) => setTimeout(r, 10));
			inFlight--;
			const items = a.items as { name: string; tags: string[] }[];
			for (const it of items) node.lvs.push(it);
			return { created: items.map((i) => i.name) };
		};
		await Promise.all(Array.from({ length: 6 }, () => machines.create({})));
		expect(max).toBe(4);
	});
});

describe("snapshot and fork", () => {
	it("snapshots a running machine with QGA freeze and stores metadata without identity", async () => {
		const { api, log, machines, store } = setup();
		const a = await machines.create({ smbios: { uuid: "ua", serial: "sa" } });
		await machines.start(a.vmid);
		log.length = 0;
		const s = await machines.snapshot(a.vmid);
		expect(log.filter((l) => /fsfreeze|lv\.snapshot/.test(l))).toEqual([
			"api:POST /nodes/pve/qemu/500/agent/fsfreeze-freeze",
			"node:lv.snapshot",
			"api:POST /nodes/pve/qemu/500/agent/fsfreeze-thaw",
		]);
		for (const k of ["smbios1", "vmgenid", "net0", "name"])
			expect(s.hardware).not.toHaveProperty(k);
		expect(s.hardware).toMatchObject({
			machine: "q35",
			cores: "2",
			memory: "2048",
		});
		expect(store.getSnapshot(s.id)).toEqual(s);
		expect(JSON.stringify(store.getSnapshot(s.id))).not.toContain("ua");
		expect(api.vms.get(500)?.status).toBe("running");
	});

	it("refuses to snapshot a running machine without QGA unless crash-consistent", async () => {
		const { api, log, machines } = setup();
		const a = await machines.create({});
		await machines.start(a.vmid);
		api.agentUp = false;
		await expect(machines.snapshot(a.vmid)).rejects.toBeInstanceOf(
			QgaUnavailableError,
		);
		log.length = 0;
		await machines.snapshot(a.vmid, { crashConsistent: true });
		expect(log.some((l) => l.includes("fsfreeze"))).toBe(false);
	});

	it("forks with new identity and the snapshot's hardware and disks", async () => {
		const { api, node, machines } = setup();
		const a = await machines.create({ smbios: { uuid: "ua", serial: "sa" } });
		await machines.start(a.vmid);
		const s = await machines.snapshot(a.vmid);
		const f = await machines.fork(s, { smbios: { uuid: "uf", serial: "sf" } });
		expect(f.vmid).toBe(501);
		expect(f.mac).toBe("02:01:00:00:01:F5");
		const post =
			api.calls.filter((c) => c.path === "/nodes/pve/qemu").at(-1)?.params ??
			{};
		expect(post.smbios1).toBe(formatSmbios1({ uuid: "uf", serial: "sf" }));
		expect(post).not.toHaveProperty("vmgenid");
		expect(post).toMatchObject({ machine: "q35", cores: "2", memory: "2048" });
		const items = node.calls.filter((c) => c.op === "lv.snapshot").at(-1)?.args
			.items as { origin: string }[] | undefined;
		const snapItem = items?.[0];
		expect(snapItem?.origin).toBe(`sbx-snap-${s.id}-scsi0`);
		expect(api.vms.get(501)?.config.vmgenid).not.toBe(
			api.vms.get(500)?.config.vmgenid,
		);
	});

	it("never copies smbios1 from the source even without a caller value", async () => {
		const { api, machines } = setup();
		const a = await machines.create({ smbios: { uuid: "ua", serial: "sa" } });
		const s = await machines.snapshot(a.vmid);
		await machines.fork(s, {});
		const post =
			api.calls.filter((c) => c.path === "/nodes/pve/qemu").at(-1)?.params ??
			{};
		expect(post).not.toHaveProperty("smbios1");
	});
});

describe("delete", () => {
	it("stops, destroys, removes LVs, verifies, then frees the VMID", async () => {
		const { api, node, machines, store } = setup();
		const a = await machines.create({});
		await machines.start(a.vmid);
		node.leases.push({ mac: "02:01:00:00:01:f4", ip: "10.88.0.101" });
		node.ethers.push({ mac: "02:01:00:00:01:f4", ip: "10.88.0.101" });
		let stateDuringVerify: string | undefined;
		node.handlers.inventory = () => {
			stateDuringVerify = store.get(1, 500)?.state;
			return { vmfiles: [] };
		};
		await machines.delete(a.vmid);
		expect(api.paths()).toContain("POST /nodes/pve/qemu/500/status/stop");
		const del = api.calls.find((c) => c.method === "DELETE");
		expect(del?.params).toEqual({ purge: 1, "destroy-unreferenced-disks": 1 });
		expect(node.calls.find((c) => c.op === "dhcp.release")?.args).toEqual({
			mac: "02:01:00:00:01:F4",
		});
		expect(stateDuringVerify).toBe("releasing");
		expect(store.get(1, 500)).toBeUndefined();
		expect(node.lvs).toEqual([]);
	});

	it("keeps the row in releasing when traces remain", async () => {
		const { api, machines, store } = setup();
		const a = await machines.create({});
		api.keepIpamOnDelete = true;
		const err = await machines.delete(a.vmid).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TracesRemainError);
		expect((err as TracesRemainError).problems.join(" ")).toMatch(/IPAM/);
		expect(store.get(1, 500)?.state).toBe("releasing");
	});

	it("reports leftover VM files from the node", async () => {
		const { node, machines } = setup();
		const a = await machines.create({});
		node.vmfiles = ["/etc/pve/firewall/500.fw"];
		await expect(machines.delete(a.vmid)).rejects.toThrow(/500\.fw/);
	});

	it("deletes a snapshot and its metadata", async () => {
		const { node, machines, store } = setup();
		const a = await machines.create({});
		const s = await machines.snapshot(a.vmid);
		await machines.deleteSnapshot(s);
		expect(node.lvs.filter((l) => l.name.startsWith("sbx-snap-"))).toEqual([]);
		expect(store.getSnapshot(s.id)).toBeUndefined();
	});
});

describe("waitReady", () => {
	it("returns ping and IPv4 times and the interface", async () => {
		const { machines } = setup();
		const a = await machines.create({});
		const startedAt = Date.now();
		await machines.start(a.vmid);
		const r = await machines.waitReady(a.vmid, { timeoutMs: 1000, startedAt });
		expect(r.ip).toBe("10.88.0.101");
		expect(r.ifname).toBe("ens18");
		expect(r.pingAt).toBeGreaterThanOrEqual(startedAt);
		expect(r.ipAt).toBeGreaterThanOrEqual(r.pingAt);
	});
});
