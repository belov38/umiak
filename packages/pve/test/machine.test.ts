import { describe, expect, it } from "vitest";
import { Allocator } from "../src/allocator.ts";
import {
	formatSmbios1,
	Machines,
	OwnerMismatchError,
	pveVcpuControl,
	QgaUnavailableError,
	s2SerialPayload,
	TracesRemainError,
} from "../src/machine.ts";
import { NodeOpsError } from "../src/node-client.ts";
import { PveApiError, QgaTimeoutError } from "../src/pve-api.ts";
import { SqliteStateStore } from "../src/state-sqlite.ts";
import { LvmThinDriver } from "../src/storage/lvmthin.ts";
import { FakeNode, FakePve } from "./fakes.ts";

function setup(
	opts: {
		cloneConcurrency?: number;
		powerLock?: <T>(fn: () => Promise<T>) => Promise<T>;
	} = {},
) {
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
		...(opts.powerLock ? { powerLock: opts.powerLock } : {}),
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
		expect(node.lvs.map((l) => l.name)).toContain("sbx-snap-abc-scsi0");
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
		expect(node.lvs.some((l) => l.name.startsWith("sbx-snap-"))).toBe(false);
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
		expect(snapItem?.origin).toBe(`sbx-snap-${s.id}-scsi0`);
		expect(api.vms.get(501)?.config.vmgenid).not.toBe(
			api.vms.get(500)?.config.vmgenid,
		);
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
			pool: "sandbox",
			name: "sbx-500",
		});
		expect(api.vms.get(500)?.config).toMatchObject({
			net0: "virtio=02:01:00:00:01:F4,bridge=sbx0,firewall=1",
			cores: "2",
			memory: "2048",
			tags: "sbx",
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
