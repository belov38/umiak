import { describe, expect, it } from "vitest";
import { Allocator } from "../src/allocator.ts";
import {
	familyForTunnelUrl,
	formatSmbios1,
	Machines,
	OwnerMismatchError,
	pveVcpuControl,
	QgaUnavailableError,
	SmbiosTooLongError,
	SNAPSHOT_CLOUDINIT_KEY,
	SnapshotModeRequiredError,
	s2SerialPayload,
	sendKey,
	skuForTunnelCA,
	TracesRemainError,
	validatePinnedTunnelUrl,
} from "../src/machine.ts";
import { NodeOpsError } from "../src/node-client.ts";
import { PveApiError, QgaTimeoutError } from "../src/pve-api.ts";
import { SqliteStateStore } from "../src/state-sqlite.ts";
import { LvmThinDriver } from "../src/storage/lvmthin.ts";
import { FakeNode, FakePve, TEMPLATE_CONFIG } from "./fakes.ts";

function setup(
	opts: {
		cloneConcurrency?: number;
		powerLock?: <T>(fn: () => Promise<T>) => Promise<T>;
	} = {},
) {
	const log: string[] = [];
	const api = new FakePve(log);
	const node = new FakeNode(log);
	// PVE-allocated volumes (a fresh tpmstate0) land in umiak-node's LV list; lv.adopt reads configs.
	api.lvStore = node;
	node.pve = api;
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
			vnet: "umiak0",
			pool: "umiak",
			templateVmid: 599,
			clusterId: 1,
		},
		cloneConcurrency: opts.cloneConcurrency ?? 4,
		ipfilter: true,
		pollMs: 0,
		...(opts.powerLock ? { powerLock: opts.powerLock } : {}),
	});
	return { log, api, node, store, allocator, machines };
}

describe("smbios", () => {
	it("formats smbios1 with a base64 serial", () => {
		expect(formatSmbios1({ uuid: "u", serial: "umiak1:x" })).toBe(
			"uuid=u,serial=dW1pYWsxOng=,base64=1",
		);
	});
	it("puts a base64 family before base64=1", () => {
		const family = "umiakt1:wss://t.example/v1/connect";
		expect(formatSmbios1({ uuid: "u", serial: "umiak1:x", family })).toBe(
			`uuid=u,serial=dW1pYWsxOng=,family=${Buffer.from(family).toString("base64")},base64=1`,
		);
	});
	it("accepts exactly 512 chars and rejects 513", () => {
		const family = "f".repeat(300);
		const s = { uuid: "", serial: "umiak1:x", family };
		// Pad the uuid so the string is exactly 512 chars, then one more.
		const uuid = "u".repeat(512 - formatSmbios1(s).length);
		expect(formatSmbios1({ ...s, uuid })).toHaveLength(512);
		expect(() => formatSmbios1({ ...s, uuid: `${uuid}u` })).toThrow(
			SmbiosTooLongError,
		);
	});
	it("builds the family for a wss tunnel URL and limits it", () => {
		expect(familyForTunnelUrl("wss://t.example/v1/connect")).toBe(
			"umiakt1:wss://t.example/v1/connect",
		);
		expect(() => familyForTunnelUrl("https://x")).toThrow();
		expect(() => familyForTunnelUrl("ws://host/x")).toThrow();
		expect(() => familyForTunnelUrl("wss:///x")).toThrow();
		expect(() => familyForTunnelUrl("wss://")).toThrow();
		const url = (n: number) => `wss://h.example/${"a".repeat(n - 16)}`;
		expect(url(200)).toHaveLength(200);
		expect(familyForTunnelUrl(url(200))).toBe(`umiakt1:${url(200)}`);
		expect(() => familyForTunnelUrl(url(201))).toThrow();
	});
	it("builds the S2 serial payload", () => {
		const bs = new Uint8Array(32).fill(255);
		const p = s2SerialPayload("11111111-2222-3333-4444-555555555555", bs);
		expect(p).toBe(
			`umiak1:11111111-2222-3333-4444-555555555555:${Buffer.from(bs).toString("base64url")}`,
		);
		expect(p).toHaveLength(87);
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
			name: "umiak-500",
			net0: "virtio=02:01:00:00:01:F4,bridge=umiak0,firewall=1",
			ide2: "local-lvm:cloudinit",
			ipconfig0: "ip=dhcp",
			ciuser: "umiak",
			balloon: "0",
			cores: "2",
			memory: "2048",
			machine: "q35",
			scsi0: "local-lvm:vm-500-disk-0,discard=on,iothread=1,ssd=1",
			boot: "order=scsi0",
			tags: "umiak",
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
			{ type: "group", action: "umiak-egress", iface: "net0", enable: 1 },
		]);
		expect(vm?.firewall.ipsets).toEqual({ "ipfilter-net0": ["10.88.0.101"] });
	});

	it("turns off the cloud-init package upgrade on first boot", async () => {
		const { api, machines } = setup();
		await machines.create({});
		await machines.createViaQmClone({});
		expect(api.vms.get(500)?.config.ciupgrade).toBe("0");
		expect(api.vms.get(501)?.config.ciupgrade).toBe("0");
	});

	it("copies only whitelisted hardware keys and never identity from the template", async () => {
		const { api, machines } = setup();
		await machines.create({});
		const post =
			api.calls.find((c) => c.method === "POST" && c.path === "/nodes/pve/qemu")
				?.params ?? {};
		expect(post.pool).toBe("umiak");
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

	it("copies rng0 from the template", async () => {
		const { api, machines } = setup();
		await machines.create({});
		expect(api.vms.get(500)?.config.rng0).toBe("source=/dev/urandom");
	});

	it("create from a template with localtime=0 posts localtime 0, and a fork keeps it", async () => {
		const { api, machines } = setup();
		api.templateConfig.localtime = "0";
		const a = await machines.create({});
		const post = () =>
			api.calls.filter(
				(c) => c.method === "POST" && c.path === "/nodes/pve/qemu",
			);
		expect(post()[0]?.params).toMatchObject({ localtime: "0" });
		await machines.start(a.vmid);
		const s = await machines.snapshot(a.vmid);
		expect(s.hardware.localtime).toBe("0");
		await machines.fork(s, {});
		expect(post().at(-1)?.params).toMatchObject({ localtime: "0" });
	});

	it("posts no cloud-init parameters when the template has no cloud-init drive", async () => {
		const { api, machines } = setup();
		const cfg = { ...api.templateConfig };
		delete cfg.ide2;
		api.templateConfig = cfg;
		await machines.create({});
		const post =
			api.calls.find((c) => c.method === "POST" && c.path === "/nodes/pve/qemu")
				?.params ?? {};
		for (const k of ["ide2", "ipconfig0", "ciuser", "ciupgrade"])
			expect(post).not.toHaveProperty(k);
		expect(post).toMatchObject({ name: "umiak-500", balloon: 0 });
	});

	it("does not take an ISO named cloudinit for a cloud-init drive", async () => {
		const { api, machines } = setup();
		const cfg = { ...api.templateConfig };
		cfg.ide2 = "local:iso/cloudinit-x.iso,media=cdrom";
		api.templateConfig = cfg;
		await machines.create({});
		const post =
			api.calls.find((c) => c.method === "POST" && c.path === "/nodes/pve/qemu")
				?.params ?? {};
		for (const k of ["ide2", "ipconfig0", "ciuser", "ciupgrade"])
			expect(post).not.toHaveProperty(k);
	});

	it("detects the cloud-init drive on any ide/scsi/sata key", async () => {
		const { api, machines } = setup();
		const cfg = { ...api.templateConfig };
		delete cfg.ide2;
		cfg.sata1 = "local-lvm:vm-598-cloudinit,media=cdrom";
		api.templateConfig = cfg;
		await machines.create({});
		expect(api.vms.get(500)?.config).toMatchObject({
			ide2: "local-lvm:cloudinit",
			ipconfig0: "ip=dhcp",
			ciuser: "umiak",
			ciupgrade: "0",
		});
	});

	it("passes the caller's smbios1", async () => {
		const { api, machines } = setup();
		await machines.create({
			smbios: { uuid: "u-1", serial: "umiak1:x" },
			size: { cores: 1, memoryMb: 1024 },
		});
		const post =
			api.calls.find((c) => c.path === "/nodes/pve/qemu")?.params ?? {};
		expect(post.smbios1).toBe("uuid=u-1,serial=dW1pYWsxOng=,base64=1");
		expect(post).toMatchObject({ cores: 1, memory: 1024 });
	});

	it("passes the family in smbios1", async () => {
		const { api, machines } = setup();
		const family = familyForTunnelUrl("wss://t.example/v1/connect");
		await machines.create({
			smbios: { uuid: "u-1", serial: "umiak1:x", family },
		});
		expect(api.vms.get(500)?.config.smbios1).toBe(
			formatSmbios1({ uuid: "u-1", serial: "umiak1:x", family }),
		);
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

describe("lease owner", () => {
	it("records ownerId on create and fork and reuses the lease for the same owner", async () => {
		const { allocator, machines } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		expect((await allocator.get(a.vmid))?.ownerId).toBe("m-a");
		await machines.start(a.vmid);
		const s = await machines.snapshot(a.vmid);
		const f = await machines.fork(s, { ownerId: "m-f" });
		expect((await allocator.get(f.vmid))?.ownerId).toBe("m-f");
		expect(f.vmid).not.toBe(a.vmid);
	});

	it("an owner's second create on its active lease fails without deleting the existing VM", async () => {
		const { api, allocator, machines, node } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		const lvsBefore = [...node.lvs];
		await expect(machines.create({ ownerId: "m-a" })).rejects.toThrow(
			/already exists/,
		);
		expect(api.paths()).not.toContain(`DELETE /nodes/pve/qemu/${a.vmid}`);
		expect(api.vms.has(a.vmid)).toBe(true);
		expect(node.lvs).toEqual(lvsBefore);
		const lease = await allocator.get(a.vmid);
		expect(lease?.state).toBe("active");
		expect(lease?.ownerId).toBe("m-a");
	});

	it("a new lease is still rolled back on failure", async () => {
		const { api, allocator, machines } = setup();
		api.fail["PUT /nodes/pve/qemu/500/firewall/options"] = new PveApiError(
			500,
			"boom",
		);
		await expect(machines.create({ ownerId: "m-b" })).rejects.toThrow(/boom/);
		expect(api.vms.has(500)).toBe(false);
		expect(await allocator.get(500)).toBeUndefined();
	});

	it("frees the lease with the owner on delete", async () => {
		const { allocator, machines } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		await machines.delete(a.vmid);
		expect(await allocator.get(a.vmid)).toBeUndefined();
		const b = await machines.create({ ownerId: "m-a" });
		expect(b.vmid).toBe(a.vmid);
	});
});

describe("snapshot and fork", () => {
	it("snapshots a running machine with QGA freeze and stores metadata without identity", async () => {
		const { api, log, machines, store } = setup();
		const a = await machines.create({
			smbios: { uuid: "uuid-src-a", serial: "serial-src-a" },
		});
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
		// Identity values contain "-", which random snapshot ids ([a-z0-9]) never do.
		const stored = JSON.stringify(store.getSnapshot(s.id));
		expect(stored).not.toContain("uuid-src-a");
		expect(stored).not.toContain("serial-src-a");
		expect(api.vms.get(500)?.status).toBe("running");
	});

	it("uses an external quiesce hook and snapshot id instead of QGA", async () => {
		const { log, node, machines, store } = setup();
		const a = await machines.create({});
		await machines.start(a.vmid);
		log.length = 0;
		const hook = {
			freeze: async () => {
				log.push("hook:freeze");
			},
			thaw: async () => {
				log.push("hook:thaw");
			},
		};
		const s = await machines.snapshot(a.vmid, { hook, id: "abc" });
		expect(log.filter((l) => /fsfreeze|lv\.snapshot|hook:/.test(l))).toEqual([
			"hook:freeze",
			"node:lv.snapshot",
			"hook:thaw",
		]);
		expect(s.id).toBe("abc");
		expect(node.lvs.map((l) => l.name)).toContain("umiak-snap-abc-scsi0");
		expect(store.getSnapshot("abc")).toEqual(s);
	});

	it("does not require QGA when an external hook is given", async () => {
		const { api, machines } = setup();
		const a = await machines.create({});
		await machines.start(a.vmid);
		api.agentUp = false;
		const hook = { freeze: async () => {}, thaw: async () => {} };
		await expect(
			machines.snapshot(a.vmid, { hook, id: "abc" }),
		).resolves.toMatchObject({ id: "abc" });
	});

	it("thaws after a freeze timeout and does not repeat the freeze", async () => {
		const { api, log, machines, node } = setup();
		const a = await machines.create({});
		await machines.start(a.vmid);
		api.fail["POST /nodes/pve/qemu/500/agent/fsfreeze-freeze"] =
			new QgaTimeoutError(
				500,
				"VM 500 qga command 'guest-fsfreeze-freeze' failed - got timeout",
				"guest-fsfreeze-freeze",
			);
		log.length = 0;
		await expect(machines.snapshot(a.vmid)).rejects.toBeInstanceOf(
			QgaTimeoutError,
		);
		expect(log.filter((l) => /fsfreeze|lv\.snapshot/.test(l))).toEqual([
			"api:POST /nodes/pve/qemu/500/agent/fsfreeze-freeze",
			"api:POST /nodes/pve/qemu/500/agent/fsfreeze-thaw",
		]);
		expect(node.lvs.some((l) => l.name.startsWith("umiak-snap-"))).toBe(false);
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
		const a = await machines.create({
			smbios: { uuid: "uuid-src-a", serial: "serial-src-a" },
		});
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
		expect(snapItem?.origin).toBe(`umiak-snap-${s.id}-scsi0`);
		expect(api.vms.get(501)?.config.vmgenid).not.toBe(
			api.vms.get(500)?.config.vmgenid,
		);
	});

	it("a fork of a machine without a cloud-init drive gets none either (S5 17.1 p. 4)", async () => {
		const { api, machines } = setup();
		const cfg = { ...api.templateConfig };
		delete cfg.ide2;
		api.templateConfig = cfg;
		const a = await machines.create({});
		const s = await machines.snapshot(a.vmid);
		expect(s.hardware[SNAPSHOT_CLOUDINIT_KEY]).toBe("0");
		await machines.fork(s, {});
		const post =
			api.calls.filter((c) => c.path === "/nodes/pve/qemu").at(-1)?.params ??
			{};
		for (const k of [
			"ide2",
			"ipconfig0",
			"ciuser",
			"ciupgrade",
			SNAPSHOT_CLOUDINIT_KEY,
		])
			expect(post).not.toHaveProperty(k);
	});

	it("a fork of a 599 clone keeps cloud-init, and so does a snapshot without the entry", async () => {
		const { api, machines } = setup();
		const a = await machines.create({});
		const s = await machines.snapshot(a.vmid);
		expect(s.hardware[SNAPSHOT_CLOUDINIT_KEY]).toBe("1");
		await machines.fork(s, {});
		const { [SNAPSHOT_CLOUDINIT_KEY]: _, ...legacy } = s.hardware;
		await machines.fork({ ...s, hardware: legacy }, {});
		const posts = api.calls.filter(
			(c) => c.method === "POST" && c.path === "/nodes/pve/qemu",
		);
		for (const p of posts.slice(-2)) {
			expect(p.params).toMatchObject({ ciuser: "umiak", ciupgrade: 0 });
			expect(p.params).not.toHaveProperty(SNAPSHOT_CLOUDINIT_KEY);
		}
	});

	it("never copies smbios1 from the source even without a caller value", async () => {
		const { api, machines } = setup();
		const a = await machines.create({
			smbios: { uuid: "uuid-src-a", serial: "serial-src-a" },
		});
		const s = await machines.snapshot(a.vmid);
		await machines.fork(s, {});
		const post =
			api.calls.filter((c) => c.path === "/nodes/pve/qemu").at(-1)?.params ??
			{};
		expect(post).not.toHaveProperty("smbios1");
	});
});

describe("delete", () => {
	it("deletes only this machine's disks when an unrelated PVE storage is unavailable", async () => {
		const { api, node, machines, store } = setup();
		const machine = await machines.create({});
		await machines.start(machine.vmid);
		// A deleted config may leave a tagged clone behind; our driver still removes it.
		node.lvs.push({ name: "vm-500-disk-9", tags: ["umiak", "umiak-vm-500"] });
		const unrelated = {
			name: "vm-501-disk-0",
			tags: ["umiak", "umiak-vm-501"],
		};
		node.lvs.push(unrelated);
		api.unavailableStorageForScan = "vmdata";
		await machines.delete(machine.vmid);
		expect(api.paths()).toContain("POST /nodes/pve/qemu/500/status/stop");
		expect(api.vms.has(machine.vmid)).toBe(false);
		expect(node.calls.find((c) => c.op === "lv.remove")?.args).toEqual({
			names: ["vm-500-disk-0", "vm-500-disk-9"],
		});
		expect(node.lvs).toEqual([unrelated]);
		expect(store.get(1, machine.vmid)).toBeUndefined();
	});

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
		expect(del?.params).toEqual({ purge: 1, "destroy-unreferenced-disks": 0 });
		expect(node.calls.find((c) => c.op === "dhcp.release")?.args).toEqual({
			mac: "02:01:00:00:01:F4",
		});
		expect(stateDuringVerify).toBe("releasing");
		expect(store.get(1, 500)).toBeUndefined();
		expect(node.lvs).toEqual([]);
	});

	it("stops a just-started VM that /cluster/resources still shows as stopped", async () => {
		const { api, machines, store } = setup();
		const a = await machines.create({});
		await machines.start(a.vmid);
		api.staleStatus.set(a.vmid, "stopped");
		await machines.delete(a.vmid);
		expect(api.paths()).toContain("POST /nodes/pve/qemu/500/status/stop");
		expect(api.vms.has(500)).toBe(false);
		expect(store.get(1, 500)).toBeUndefined();
	});

	it("completes a failed delete on retry", async () => {
		const { api, machines, store } = setup();
		const a = await machines.create({});
		await machines.start(a.vmid);
		api.fail["POST /nodes/pve/qemu/500/status/stop"] = new PveApiError(
			500,
			"stop failed",
		);
		await expect(machines.delete(a.vmid)).rejects.toThrow(/stop failed/);
		expect(store.get(1, 500)?.state).toBe("releasing");
		delete api.fail["POST /nodes/pve/qemu/500/status/stop"];
		await machines.delete(a.vmid);
		expect(api.vms.has(500)).toBe(false);
		expect(store.get(1, 500)).toBeUndefined();
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
		expect(node.lvs.filter((l) => l.name.startsWith("umiak-snap-"))).toEqual(
			[],
		);
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

describe("createViaQmClone (baseline)", () => {
	it("clones the template through the API, then applies our MAC, size and firewall", async () => {
		const { api, machines, store } = setup();
		const m = await machines.createViaQmClone({});
		expect(m.vmid).toBe(500);
		expect(api.paths().slice(0, 3)).toEqual([
			"POST /nodes/pve/qemu/599/clone",
			"PUT /nodes/pve/qemu/500/config",
			"PUT /nodes/pve/qemu/500/firewall/options",
		]);
		const clone = api.calls[0]?.params;
		expect(clone).toEqual({
			newid: 500,
			full: 0,
			pool: "umiak",
			name: "umiak-500",
		});
		expect(api.vms.get(500)?.config).toMatchObject({
			net0: "virtio=02:01:00:00:01:F4,bridge=umiak0,firewall=1",
			cores: "2",
			memory: "2048",
			tags: "umiak",
		});
		expect(api.vms.get(500)?.firewall.ipsets).toEqual({
			"ipfilter-net0": ["10.88.0.101"],
		});
		expect(m.disks[0]?.volid).toBe("local-lvm:vm-500-disk-0");
		expect(store.get(1, 500)?.state).toBe("active");
	});
});

describe("review fixes", () => {
	it("rolls back through delete even when the create POST itself fails", async () => {
		const { api, node, machines, store } = setup();
		api.fail["POST /nodes/pve/qemu"] = new PveApiError(
			500,
			"connection reset after create",
		);
		await expect(machines.create({})).rejects.toThrow(/connection reset/);
		expect(node.ops()).toContain("inventory");
		expect(store.get(1, 500)).toBeUndefined();
	});

	it("waits for an asynchronous dhcp_release before reporting traces", async () => {
		const { node, machines, store } = setup();
		const a = await machines.create({});
		node.leases.push({ mac: "02:01:00:00:01:f4", ip: "10.88.0.101" });
		let readsAfterRelease = -1;
		node.handlers["dhcp.release"] = () => {
			readsAfterRelease = 0;
			return { released: true };
		};
		node.handlers["dhcp.leases"] = () => {
			if (readsAfterRelease >= 0 && ++readsAfterRelease > 2) node.leases = [];
			return { leases: node.leases, ethers: [] };
		};
		await machines.delete(a.vmid);
		expect(store.get(1, 500)).toBeUndefined();
	});

	it("sends dhcp_release again when dnsmasq dropped the first one", async () => {
		const { node, machines, store } = setup();
		const a = await machines.create({});
		node.leases.push({ mac: "02:01:00:00:01:f4", ip: "10.88.0.101" });
		let releases = 0;
		node.handlers["dhcp.release"] = () => {
			// The releases before destroy and right after it never reach dnsmasq.
			if (++releases > 2) node.leases = [];
			return { released: true };
		};
		await machines.delete(a.vmid);
		expect(releases).toBe(3);
		expect(machines.dhcpReleaseRetries).toBe(1);
		expect(store.get(1, 500)).toBeUndefined();
	});

	it("releases even when the first lease read comes back empty", async () => {
		const { node, machines } = setup();
		const a = await machines.create({});
		node.leases.push({ mac: "02:01:00:00:01:f4", ip: "10.88.0.101" });
		let reads = 0;
		node.handlers["dhcp.leases"] = () => ({
			leases: ++reads === 1 ? [] : node.leases,
			ethers: [],
		});
		await machines.delete(a.vmid);
		// One release before destroy, one in verification.
		expect(node.ops().filter((o) => o === "dhcp.release")).toHaveLength(2);
		expect(node.leases).toEqual([]);
		expect(machines.dhcpReleaseRetries).toBe(0);
	});

	it("reports a lease that survives every release", async () => {
		const { node, machines, store } = setup();
		const a = await machines.create({});
		node.leases.push({ mac: "02:01:00:00:01:f4", ip: "10.88.0.101" });
		node.handlers["dhcp.release"] = () => ({ released: true });
		const err = await machines.delete(a.vmid).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TracesRemainError);
		// One release before destroy, then three rounds in verification.
		expect(node.ops().filter((o) => o === "dhcp.release")).toHaveLength(4);
		expect(store.get(1, 500)?.state).toBe("releasing");
	});

	it("releases the DHCP lease before destroy, while the IP still belongs to the VM", async () => {
		const { api, node, machines, store } = setup();
		const a = await machines.create({});
		await machines.start(a.vmid);
		const x = "02:01:00:00:01:f4";
		node.leases.push({ mac: x, ip: "10.88.0.101" });
		// Right after destroy frees the IP, a new VM Y takes it and dnsmasq moves the lease to Y.
		const destroy = api.delete.bind(api);
		api.delete = async <T>(path: string, params?: Record<string, unknown>) => {
			const r = await destroy<T>(path, params);
			node.leases = node.leases.map((l) =>
				l.mac === x ? { ...l, mac: "02:01:00:00:01:ff" } : l,
			);
			return r;
		};
		let effective = 0;
		node.handlers["dhcp.release"] = (args) => {
			const m = String(args.mac).toLowerCase();
			if (node.leases.some((l) => l.mac === m)) effective++;
			node.leases = node.leases.filter((l) => l.mac !== m);
			return { released: true };
		};
		await machines.delete(a.vmid);
		expect(effective).toBe(1);
		const order = node.log.filter(
			(l) => l === "node:dhcp.release" || l.startsWith("api:DELETE"),
		);
		expect(order[0]).toBe("node:dhcp.release");
		expect(store.get(1, 500)).toBeUndefined();
	});

	it("retries a lease read while the lease file is being rewritten", async () => {
		const { node, machines, store } = setup();
		const a = await machines.create({});
		let reads = 0;
		node.handlers["dhcp.leases"] = () => {
			if (++reads <= 2)
				throw new NodeOpsError("dhcp.leases", "busy", "keeps changing");
			return { leases: [], ethers: [] };
		};
		await machines.delete(a.vmid);
		expect(store.get(1, 500)).toBeUndefined();
	});

	it("refuses to delete the template", async () => {
		const { api, machines } = setup();
		await expect(machines.delete(599)).rejects.toThrow(/template/);
		expect(api.paths().some((p) => p.startsWith("DELETE"))).toBe(false);
	});
});

describe("owner-checked power operations", () => {
	it("delete with the lease owner deletes and frees the VMID", async () => {
		const { api, machines, store } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		await machines.delete(a.vmid, { expectedOwner: "m-a" });
		expect(api.vms.has(a.vmid)).toBe(false);
		expect(store.get(1, a.vmid)).toBeUndefined();
	});

	it("delete for another owner refuses before touching anything", async () => {
		const { api, machines, store, node } = setup();
		const b = await machines.create({ ownerId: "m-b" });
		await machines.start(b.vmid);
		api.calls.length = 0;
		node.calls.length = 0;
		const err = await machines
			.delete(b.vmid, { expectedOwner: "m-a" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(OwnerMismatchError);
		expect(err).toMatchObject({
			code: "owner_mismatch",
			retryable: false,
			op: "delete",
			vmid: b.vmid,
			expectedOwner: "m-a",
			actualOwner: "m-b",
		});
		expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
		expect(node.ops()).toEqual([]);
		expect(api.vms.get(b.vmid)?.status).toBe("running");
		expect(store.get(1, b.vmid)?.state).toBe("active");
	});

	it("delete for an owner whose lease is gone does nothing when the VM is gone too", async () => {
		const { api, machines, node } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		await machines.delete(a.vmid);
		api.calls.length = 0;
		node.calls.length = 0;
		await machines.delete(a.vmid, { expectedOwner: "m-a" });
		expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
		// Nothing freed, no dhcp.release for a MAC a new VM could have by now.
		expect(node.ops()).toEqual([]);
	});

	it("delete for an owner whose lease is gone refuses a VM that has the VMID", async () => {
		const { api, machines, store } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		store.remove(1, a.vmid);
		const err = await machines
			.delete(a.vmid, { expectedOwner: "m-a" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(OwnerMismatchError);
		expect((err as OwnerMismatchError).actualOwner).toBeNull();
		expect(api.vms.has(a.vmid)).toBe(true);
	});

	it("delete with expectedOwner null removes a VM without a lease and refuses an owned one", async () => {
		const { api, machines, store } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		const b = await machines.create({ ownerId: "m-b" });
		store.remove(1, a.vmid);
		await machines.delete(a.vmid, { expectedOwner: null });
		expect(api.vms.has(a.vmid)).toBe(false);
		await expect(
			machines.delete(b.vmid, { expectedOwner: null }),
		).rejects.toBeInstanceOf(OwnerMismatchError);
		expect(api.vms.has(b.vmid)).toBe(true);
	});

	it("an orphan delete reserves the VMID: a create during it gets another VMID and keeps its lease", async () => {
		const { api, allocator, machines, node, store } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		store.remove(1, a.vmid);
		let b: { vmid: number } | undefined;
		let stateDuringDelete: string | undefined;
		node.handlers["dhcp.release"] = async () => {
			stateDuringDelete ??= store.get(1, a.vmid)?.state;
			b ??= await allocator.allocate("m-b");
			return { released: true };
		};
		await machines.delete(a.vmid, { expectedOwner: null });
		expect(api.vms.has(a.vmid)).toBe(false);
		expect(stateDuringDelete).toBe("releasing");
		expect(b?.vmid).toBeDefined();
		expect(b?.vmid).not.toBe(a.vmid);
		expect(store.get(1, b?.vmid ?? 0)?.ownerId).toBe("m-b");
		expect(store.get(1, a.vmid)).toBeUndefined();
	});

	it("the final release frees only the delete's own releasing lease, not one that changed hands meanwhile", async () => {
		const { api, machines, node, store } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		node.handlers["dhcp.release"] = async () => {
			// Someone frees the lease mid-delete and another owner takes the VMID.
			if (store.get(1, a.vmid)?.ownerId === "m-a") {
				store.remove(1, a.vmid);
				store.tryInsert({
					cluster: 1,
					vmid: a.vmid,
					mac: "02:01:00:00:01:F4",
					state: "reserved",
					purpose: "machine",
					createdAt: 0,
					updatedAt: 0,
					ownerId: "m-c",
				});
			}
			return { released: true };
		};
		await machines.delete(a.vmid, { expectedOwner: "m-a" });
		expect(api.vms.has(a.vmid)).toBe(false);
		expect(store.get(1, a.vmid)).toMatchObject({
			ownerId: "m-c",
			state: "reserved",
		});
	});

	it("an orphan delete that loses the reservation re-checks the new lease and refuses", async () => {
		const { api, allocator, machines, store } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		store.remove(1, a.vmid);
		const reserve = allocator.reserveForDelete.bind(allocator);
		allocator.reserveForDelete = async (vmid) => {
			// A create takes the VMID between the lease read and the reservation.
			store.tryInsert({
				cluster: 1,
				vmid,
				mac: "02:01:00:00:01:F4",
				state: "reserved",
				purpose: "machine",
				createdAt: 0,
				updatedAt: 0,
				ownerId: "m-c",
			});
			return reserve(vmid);
		};
		await expect(
			machines.delete(a.vmid, { expectedOwner: null }),
		).rejects.toBeInstanceOf(OwnerMismatchError);
		expect(api.vms.has(a.vmid)).toBe(true);
		expect(store.get(1, a.vmid)?.ownerId).toBe("m-c");
	});

	it("start, stop and shutdown act only for the lease owner", async () => {
		const { api, machines } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		for (const call of [
			() => machines.start(a.vmid, { expectedOwner: "m-x" }),
			() => machines.stop(a.vmid, { expectedOwner: "m-x" }),
			() => machines.shutdown(a.vmid, 5, { expectedOwner: "m-x" }),
		]) {
			await expect(call()).rejects.toBeInstanceOf(OwnerMismatchError);
		}
		expect(api.paths().filter((p) => p.includes("/status/"))).toEqual([]);
		await machines.start(a.vmid, { expectedOwner: "m-a" });
		expect(api.vms.get(a.vmid)?.status).toBe("running");
		await machines.shutdown(a.vmid, 5, { expectedOwner: "m-a" });
		await machines.start(a.vmid, { expectedOwner: "m-a" });
		await machines.stop(a.vmid, { expectedOwner: "m-a" });
		expect(api.vms.get(a.vmid)?.status).toBe("stopped");
	});

	it("start refuses a VMID without a lease or with a releasing lease", async () => {
		const { api, machines, store } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		store.setState(1, a.vmid, "releasing");
		const err = await machines
			.start(a.vmid, { expectedOwner: "m-a" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(OwnerMismatchError);
		store.remove(1, a.vmid);
		await expect(
			machines.start(a.vmid, { expectedOwner: "m-a" }),
		).rejects.toBeInstanceOf(OwnerMismatchError);
		expect(api.paths().filter((p) => p.includes("/status/start"))).toEqual([]);
	});

	it("without expectedOwner nothing is checked (bench)", async () => {
		const { api, machines, store } = setup();
		const a = await machines.create({ ownerId: "m-a" });
		store.remove(1, a.vmid);
		await machines.start(a.vmid);
		await machines.stop(a.vmid);
		await machines.delete(a.vmid);
		expect(api.vms.has(a.vmid)).toBe(false);
	});
});

describe("rollback under the power lock", () => {
	it("a failed create rolls back inside the powerLock hook", async () => {
		const events: string[] = [];
		const { api, machines } = setup({
			powerLock: async (fn) => {
				events.push("lock");
				try {
					return await fn();
				} finally {
					events.push("unlock");
				}
			},
		});
		const del = api.delete.bind(api);
		api.delete = async <T>(path: string, params?: Record<string, unknown>) => {
			events.push(`DELETE ${path}`);
			return del<T>(path, params);
		};
		api.fail["PUT /nodes/pve/qemu/500/firewall/options"] = new PveApiError(
			500,
			"boom",
		);
		await expect(machines.create({ ownerId: "m-a" })).rejects.toThrow(/boom/);
		expect(events).toEqual(["lock", "DELETE /nodes/pve/qemu/500", "unlock"]);
		expect(api.vms.has(500)).toBe(false);

		// Power operations themselves never take the hook (the caller holds the lock).
		delete api.fail["PUT /nodes/pve/qemu/500/firewall/options"];
		events.length = 0;
		const a = await machines.create({ ownerId: "m-b" });
		await machines.start(a.vmid);
		await machines.delete(a.vmid);
		expect(events.filter((e) => e === "lock")).toEqual([]);
	});

	it("a rollback waits for a power operation that holds the lock", async () => {
		let held: Promise<void> = Promise.resolve();
		const lock = <T>(fn: () => Promise<T>): Promise<T> => {
			const run = held.then(fn);
			held = run.then(
				() => {},
				() => {},
			);
			return run;
		};
		const { api, machines } = setup({ powerLock: lock });
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const holder = lock(() => gate);
		api.fail["PUT /nodes/pve/qemu/500/firewall/options"] = new PveApiError(
			500,
			"boom",
		);
		let settled = false;
		const create = machines.create({ ownerId: "m-a" }).finally(() => {
			settled = true;
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(settled).toBe(false);
		expect(api.paths()).not.toContain("DELETE /nodes/pve/qemu/500");
		release();
		await holder;
		await expect(create).rejects.toThrow(/boom/);
		expect(api.paths()).toContain("DELETE /nodes/pve/qemu/500");
	});
});

describe("delete of a template", () => {
	it("refuses a VM with template: 1 and makes no DELETE call or lease change", async () => {
		const { api, store, machines } = setup();
		api.vms.set(598, {
			config: { name: "umiak-tpl-x", template: "1", tags: "umiak-tpl" },
			status: "stopped",
			firewall: { rules: [], ipsets: {} },
		});
		await expect(machines.delete(598)).rejects.toThrow(
			"refusing to delete template VM 598",
		);
		expect(api.paths().some((p) => p.startsWith("DELETE"))).toBe(false);
		expect(store.get(1, 598)).toBeUndefined();
	});

	it("still deletes an orphan VM that is not a template", async () => {
		const { api, machines } = setup();
		api.vms.set(598, {
			config: { name: "x" },
			status: "stopped",
			firewall: { rules: [], ipsets: {} },
		});
		await machines.delete(598);
		expect(api.vms.has(598)).toBe(false);
	});

	it("treats a missing VM as not a template", async () => {
		const { machines } = setup();
		await expect(machines.delete(598)).resolves.toBeUndefined();
	});

	it("propagates other config read errors", async () => {
		const { api, machines } = setup();
		api.vms.set(598, {
			config: { name: "x" },
			status: "stopped",
			firewall: { rules: [], ipsets: {} },
		});
		api.fail["GET /nodes/pve/qemu/598/config"] = new PveApiError(502, "bad gw");
		await expect(machines.delete(598)).rejects.toThrow(/bad gw/);
	});
});

describe("occupiedVmids", () => {
	it("counts VM disks and template disks, even of VMs the token cannot list", async () => {
		const { node, machines } = setup();
		node.lvs.push(
			{ name: "vm-512-disk-0", tags: ["umiak"] },
			{ name: "base-597-disk-0", tags: [] },
			{ name: "data", tags: [] },
		);
		const ids = await machines.occupiedVmids();
		expect(ids.has(512)).toBe(true);
		expect(ids.has(597)).toBe(true);
	});
});

const WIN_TEMPLATE_CONFIG: Record<string, string> = {
	...TEMPLATE_CONFIG,
	bios: "ovmf",
	ostype: "win11",
	machine: "pc-q35-9.2",
	efidisk0:
		"local-lvm:base-599-disk-0,efitype=4m,pre-enrolled-keys=1,ms-cert=2023k,size=4M",
	scsi0: "local-lvm:base-599-disk-1,discard=on,iothread=1,size=100G,ssd=1",
	tpmstate0: "local-lvm:base-599-disk-2,size=4M,version=v2.0",
};
delete WIN_TEMPLATE_CONFIG.ide2;
delete WIN_TEMPLATE_CONFIG.ipconfig0;
delete WIN_TEMPLATE_CONFIG.ciuser;

describe("Windows template (three disks)", () => {
	it("create clones efidisk0 and scsi0 only and allocates a fresh tpmstate0", async () => {
		const { api, node, machines } = setup();
		api.templateConfig = { ...WIN_TEMPLATE_CONFIG };
		const m = await machines.create({});
		const items = node.calls.find((c) => c.op === "lv.snapshot")?.args
			.items as { origin: string; name: string }[];
		expect(items.map((i) => `${i.origin}->${i.name}`)).toEqual([
			"base-599-disk-0->vm-500-disk-0",
			"base-599-disk-1->vm-500-disk-1",
		]);
		const puts = api.calls.filter(
			(c) => c.method === "PUT" && c.path === "/nodes/pve/qemu/500/config",
		);
		expect(puts.map((c) => c.params)).toEqual([
			expect.objectContaining({
				efidisk0:
					"local-lvm:vm-500-disk-0,efitype=4m,pre-enrolled-keys=1,ms-cert=2023k",
				scsi0: "local-lvm:vm-500-disk-1,discard=on,iothread=1,ssd=1",
			}),
			{ tpmstate0: "local-lvm:1,version=v2.0" },
		]);
		const cfg = api.vms.get(500)?.config ?? {};
		expect(cfg.tpmstate0).toBe("local-lvm:vm-500-disk-2,size=4M,version=v2.0");
		expect(cfg.efidisk0).toContain(
			"efitype=4m,pre-enrolled-keys=1,ms-cert=2023k",
		);
		expect(m.disks.map((d) => `${d.slot}=${d.lv}`)).toEqual([
			"efidisk0=vm-500-disk-0",
			"scsi0=vm-500-disk-1",
			"tpmstate0=vm-500-disk-2",
		]);
	});

	it("takes the vTPM version from the template", async () => {
		const { api, machines } = setup();
		api.templateConfig = {
			...WIN_TEMPLATE_CONFIG,
			tpmstate0: "local-lvm:base-599-disk-2,size=4M,version=v1.2",
		};
		await machines.create({});
		expect(api.vms.get(500)?.config.tpmstate0).toContain("version=v1.2");
	});

	it("keeps a Linux template without tpmstate0 on one config PUT", async () => {
		const { api, machines } = setup();
		await machines.create({});
		const puts = api.calls.filter(
			(c) => c.method === "PUT" && c.path === "/nodes/pve/qemu/500/config",
		);
		expect(puts).toHaveLength(1);
	});

	it("create tags the PVE-allocated tpmstate0 LV through lv.adopt", async () => {
		const { api, node, machines, log } = setup();
		api.templateConfig = { ...WIN_TEMPLATE_CONFIG };
		await machines.create({});
		expect(node.calls.find((c) => c.op === "lv.adopt")?.args).toEqual({
			vmid: 500,
		});
		// After the tpmstate0 PUT, before the firewall.
		const adopt = log.indexOf("node:lv.adopt");
		expect(adopt).toBeGreaterThan(
			log.lastIndexOf("api:PUT /nodes/pve/qemu/500/config"),
		);
		expect(adopt).toBeLessThan(
			log.indexOf("api:PUT /nodes/pve/qemu/500/firewall/options"),
		);
		expect(node.lvs).toEqual(
			[0, 1, 2].map((n) => ({
				name: `vm-500-disk-${n}`,
				tags: ["umiak", "umiak-vm-500"],
			})),
		);
	});

	it("snapshot of a Windows clone snapshots all three LVs", async () => {
		const { node, api, machines, log } = setup();
		api.templateConfig = { ...WIN_TEMPLATE_CONFIG };
		const m = await machines.create({});
		await machines.start(m.vmid);
		node.calls.length = 0;
		const snap = await machines.snapshot(m.vmid, { crashConsistent: true });
		expect(snap.consistency).toBe("crash");
		expect(log.some((line) => line.includes("fsfreeze"))).toBe(false);
		const items = node.calls.find((c) => c.op === "lv.snapshot")?.args
			.items as { origin: string; name: string }[];
		expect(items.map((i) => `${i.origin}->${i.name}`)).toEqual([
			`vm-500-disk-0->umiak-snap-${snap.id}-efidisk0`,
			`vm-500-disk-1->umiak-snap-${snap.id}-scsi0`,
			`vm-500-disk-2->umiak-snap-${snap.id}-tpmstate0`,
		]);
	});

	it("a running Windows VM without an explicit crashConsistent is refused, nothing snapshotted", async () => {
		const { node, api, machines, log } = setup();
		api.templateConfig = { ...WIN_TEMPLATE_CONFIG };
		const m = await machines.create({});
		await machines.start(m.vmid);
		node.calls.length = 0;
		await expect(machines.snapshot(m.vmid)).rejects.toBeInstanceOf(
			SnapshotModeRequiredError,
		);
		expect(node.calls.some((c) => c.op === "lv.snapshot")).toBe(false);
		expect(log.some((line) => line.includes("fsfreeze"))).toBe(false);
		// A stopped Windows VM needs no choice: powered_off.
		await machines.stop(m.vmid);
		const snap = await machines.snapshot(m.vmid);
		expect(snap.consistency).toBe("powered_off");
	});

	it("Windows VSS thawed by itself during the snapshot: the ref says autoThawed, no error", async () => {
		const { node, api, machines, store } = setup();
		api.templateConfig = { ...WIN_TEMPLATE_CONFIG };
		const m = await machines.create({});
		await machines.start(m.vmid);
		const thaw = `POST /nodes/pve/qemu/${m.vmid}/agent/fsfreeze-thaw`;
		node.handlers["lv.snapshot"] = (a) => {
			const items = a.items as { name: string; tags: string[] }[];
			for (const it of items) node.lvs.push({ name: it.name, tags: it.tags });
			// The VSS hold ran out on a slow host: the guest thawed, the thaw call fails.
			api.guestFrozen = false;
			api.fail[thaw] = new PveApiError(500, "guest-fsfreeze-thaw failed");
			return { created: items.map((i) => i.name) };
		};
		const snap = await machines.snapshot(m.vmid, { crashConsistent: false });
		expect(snap.autoThawed).toBe(true);
		expect(snap.consistency).toBe("crash");
		expect(store.getSnapshot(snap.id)?.autoThawed).toBe(true);
		expect(
			node.lvs.filter((l) => l.tags.includes(`umiak-snap-${snap.id}`)),
		).toHaveLength(3);
	});

	it("a thaw that fails on a still-frozen Windows guest leaves no snapshot LV behind", async () => {
		const { node, api, machines } = setup();
		api.templateConfig = { ...WIN_TEMPLATE_CONFIG };
		const m = await machines.create({});
		await machines.start(m.vmid);
		api.fail[`POST /nodes/pve/qemu/${m.vmid}/agent/fsfreeze-thaw`] =
			new PveApiError(500, "guest-fsfreeze-thaw failed");
		await expect(
			machines.snapshot(m.vmid, { id: "s1", crashConsistent: false }),
		).rejects.toThrow(/thaw failed for VM 500/);
		expect(node.lvs.filter((l) => l.name.startsWith("umiak-snap-"))).toEqual(
			[],
		);
	});

	it("a create whose tpmstate0 LV lv.adopt does not report rolls back", async () => {
		const { api, node, machines, store } = setup();
		api.templateConfig = { ...WIN_TEMPLATE_CONFIG };
		node.handlers["lv.adopt"] = () => ({
			tagged: [],
			already: ["vm-500-disk-0", "vm-500-disk-1"],
		});
		await expect(machines.create({})).rejects.toThrow(
			/tpmstate0.*vm-500-disk-2/,
		);
		expect(api.vms.has(500)).toBe(false);
		expect(node.lvs).toEqual([]);
		expect(store.get(1, 500)).toBeUndefined();
	});

	it("delete removes the PVE-allocated tpmstate0 volume", async () => {
		const { api, node, machines } = setup();
		api.templateConfig = { ...WIN_TEMPLATE_CONFIG };
		const m = await machines.create({});
		expect(node.lvs.map((l) => l.name).sort()).toEqual([
			"vm-500-disk-0",
			"vm-500-disk-1",
			"vm-500-disk-2",
		]);
		await machines.delete(m.vmid);
		expect(node.lvs).toEqual([]);
	});

	it("a create failing right after the tpmstate0 PUT rolls back without traces", async () => {
		const { api, node, machines, store } = setup();
		api.templateConfig = { ...WIN_TEMPLATE_CONFIG };
		// The re-read of the config after the tpmstate0 PUT fails once; the rollback reads it again.
		const get = api.get.bind(api);
		let failed = false;
		api.get = ((path: string, params?: Record<string, unknown>) => {
			if (path === "/nodes/pve/qemu/500/config" && !failed) {
				failed = true;
				return Promise.reject(new Error("config read failed"));
			}
			return get(path, params);
		}) as typeof api.get;
		await expect(machines.create({})).rejects.toThrow(/config read failed/);
		expect(api.vms.has(500)).toBe(false);
		expect(node.lvs).toEqual([]);
		expect(store.get(1, 500)).toBeUndefined();
	});

	it("fork copies tpmstate0 of the source", async () => {
		const { api, node, machines } = setup();
		api.templateConfig = { ...WIN_TEMPLATE_CONFIG };
		const a = await machines.create({});
		await machines.start(a.vmid);
		const snap = await machines.snapshot(a.vmid, { crashConsistent: true });
		expect(snap.disks.map((d) => d.slot)).toEqual([
			"efidisk0",
			"scsi0",
			"tpmstate0",
		]);
		node.calls.length = 0;
		const b = await machines.fork(snap);
		const items = node.calls.find((c) => c.op === "lv.snapshot")?.args
			.items as { origin: string; name: string }[];
		expect(items.map((i) => i.name)).toEqual([
			`vm-${b.vmid}-disk-0`,
			`vm-${b.vmid}-disk-1`,
			`vm-${b.vmid}-disk-2`,
		]);
		expect(items[2]?.origin).toBe(`umiak-snap-${snap.id}-tpmstate0`);
		expect(api.vms.get(b.vmid)?.config.tpmstate0).toBe(
			`local-lvm:vm-${b.vmid}-disk-2,version=v2.0`,
		);
		const puts = api.calls.filter(
			(c) =>
				c.method === "PUT" && c.path === `/nodes/pve/qemu/${b.vmid}/config`,
		);
		expect(puts).toHaveLength(1);
	});
});

describe("sendKey", () => {
	it("puts the key", async () => {
		const { api, machines } = setup();
		const m = await machines.create({});
		await sendKey(api, "pve", m.vmid, "ret");
		const last = api.calls.at(-1);
		expect(last).toEqual({
			method: "PUT",
			path: `/nodes/pve/qemu/${m.vmid}/sendkey`,
			params: { key: "ret" },
		});
	});
});

describe("firmware CA pin configuration", () => {
	it("validates the full descriptor before accepting a hostname", () => {
		const name = (n: number) =>
			Array.from({ length: Math.ceil(n / 40) }, (_, i) =>
				"a".repeat(Math.min(39, n - i * 40)),
			)
				.join(".")
				.slice(0, n);
		const url = (n: number) => `wss://${name(n)}/v1/connect`;
		expect(validatePinnedTunnelUrl(url(143))).toBe(url(143));
		expect(() => validatePinnedTunnelUrl(url(144))).toThrow(
			/tunnel hostname too long.*max 143 chars/,
		);
		const pin = skuForTunnelCA("a".repeat(64));
		expect(
			formatSmbios1({
				uuid: "0".repeat(36),
				serial: s2SerialPayload("0".repeat(36), new Uint8Array(32)),
				family: familyForTunnelUrl(url(143)),
				sku: pin,
			}),
		).toHaveLength(511);
		expect(() => skuForTunnelCA("bad")).toThrow();
		expect(() =>
			validatePinnedTunnelUrl(`wss://${name(143)}:8443/v1/connect`),
		).toThrow(/max 138 chars/);
	});
});

it("refreshes the CA SKU on start after checking ownership without changing the serial", async () => {
	const { machines, api } = setup();
	const vm = await machines.create({
		size: { cores: 2, memoryMb: 2048 },
		smbios: { uuid: "u", serial: "umiak1:x" },
	});
	await machines.start(vm.vmid, { tunnelCAPin: "a".repeat(64) });
	expect(api.vms.get(vm.vmid)?.config.smbios1).toBe(
		formatSmbios1({
			uuid: "u",
			serial: "umiak1:x",
			sku: `umiakca1:${"a".repeat(64)}`,
		}),
	);
});
