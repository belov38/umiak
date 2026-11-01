import {
	Allocator,
	LvmThinDriver,
	Machines,
	pveVcpuControl,
	SqliteStateStore,
} from "@umiak/pve";
import { describe, expect, it } from "vitest";
import { FakeNode, FakePve } from "../../../packages/pve/test/fakes.ts";
import { cleanup } from "../src/cleanup.ts";
import type { Ctx } from "../src/context.ts";

function ctx(): {
	c: Ctx;
	api: FakePve;
	node: FakeNode;
	store: SqliteStateStore;
} {
	const api = new FakePve();
	const node = new FakeNode();
	const store = new SqliteStateStore(":memory:");
	node.handlers["media.list"] = () => ({ iso: [], import: [] });
	const cfg = {
		node: "pve",
		storage: "local-lvm",
		vnet: "umiak0",
		pool: "umiak",
		templateVmid: 599,
		clusterId: 1,
		vmidRange: { min: 500, max: 598 },
	};
	const allocator = new Allocator({
		store,
		clusterId: 1,
		range: cfg.vmidRange,
		templateVmid: 599,
		occupied: async () => new Set(),
	});
	const driver = new LvmThinDriver({
		node,
		vcpu: pveVcpuControl(api, "pve"),
		storage: "local-lvm",
	});
	const machines = new Machines({
		api,
		node,
		driver,
		allocator,
		snapshots: store,
		cfg,
		pollMs: 0,
	});
	const c = {
		cfg,
		api,
		node,
		store,
		allocator,
		driver,
		machines,
		close() {},
	} as unknown as Ctx;
	return { c, api, node, store };
}

describe("cleanup", () => {
	it("refuses broad cleanup without explicit opt-in before any side effect", async () => {
		const { c, api, node } = ctx();
		await expect(cleanup(c)).rejects.toThrow(/all-sandbox-resources/);
		expect(api.paths()).toEqual([]);
		expect(node.calls).toEqual([]);
	});
	it("keeps the DHCP entries of template lease MACs", async () => {
		const { c, node, store } = ctx();
		const t = Date.now();
		store.tryInsert({
			cluster: 1,
			vmid: 598,
			mac: "02:01:00:00:02:56",
			state: "active",
			purpose: "template",
			createdAt: t,
			updatedAt: t,
		});
		node.leases.push({ mac: "02:01:00:00:02:56", ip: "10.88.0.150" });
		node.leases.push({ mac: "02:01:00:00:01:f4", ip: "10.88.0.101" });
		const report = await cleanup(c, { allSandboxResources: true });
		const released = node.calls
			.filter((x) => x.op === "dhcp.release")
			.map((x) => x.args.mac);
		expect(released).toContain("02:01:00:00:01:f4");
		expect(released).not.toContain("02:01:00:00:02:56");
		expect(report.join("\n")).not.toMatch(/02:56/);
		expect(store.get(1, 598)).toBeDefined();
	});

	it("never deletes a template VM (tag umiak-tpl or template: 1)", async () => {
		const { c, api } = ctx();
		for (const [vmid, config] of [
			[598, { name: "t1", tags: "umiak-tpl", template: "1" }],
			[597, { name: "t2", tags: "umiak;umiak-tpl" }],
			[596, { name: "t3", template: "1" }],
		] as const) {
			api.vms.set(vmid, {
				config: { ...config },
				status: "stopped",
				firewall: { rules: [], ipsets: {} },
			});
		}
		const report = await cleanup(c, { allSandboxResources: true });
		expect(api.paths().some((p) => p.startsWith("DELETE"))).toBe(false);
		expect([...api.vms.keys()].sort()).toEqual([596, 597, 598]);
		expect(report.join("\n")).not.toMatch(/59[678]/);
	});

	it("keeps an allocator row whose traces cannot be removed", async () => {
		const { c, node, store } = ctx();
		await c.machines.create({});
		node.leases.push({ mac: "02:01:00:00:01:f4", ip: "10.88.0.101" });
		node.handlers["dhcp.release"] = () => ({ released: false });
		const report = await cleanup(c, { allSandboxResources: true });
		expect(store.get(1, 500)).toBeDefined();
		expect(report.join("\n")).toMatch(/500/);
	});

	it("drops rows, records and LVs when everything is gone", async () => {
		const { c, node, store } = ctx();
		const m = await c.machines.create({});
		await c.machines.snapshot(m.vmid);
		const report = await cleanup(c, { allSandboxResources: true });
		expect(store.list(1)).toEqual([]);
		expect(store.listSnapshots()).toEqual([]);
		expect(node.lvs).toEqual([]);
		expect(report.join("\n")).toMatch(/deleted VM 500/);
	});

	it("removes the ISOs of agent-tests but not other media or an ISO still attached", async () => {
		const { c, api, node } = ctx();
		node.handlers["media.list"] = () => ({
			iso: [
				{ name: "umiak-build-agenttests-20261031050000.iso" },
				{ name: "umiak-build-agenttests-20261031060000.iso" },
				{ name: "umiak-build-seed-abc.iso" },
				{ name: "Win11.iso" },
			],
			import: [],
		});
		// A VM that cannot be deleted keeps its ISO.
		api.vms.set(510, {
			config: {
				name: "x",
				ide2: "local:iso/umiak-build-agenttests-20261031060000.iso,media=cdrom",
			},
			status: "stopped",
			firewall: { rules: [], ipsets: {} },
		});
		node.handlers["media.remove"] = (a) => ({ removed: a.names });
		const del = c.machines.delete.bind(c.machines);
		c.machines.delete = async (vmid, o) => {
			if (vmid === 510) throw new Error("locked");
			return del(vmid, o);
		};
		const report = await cleanup(c, { allSandboxResources: true });
		const removed = node.calls.filter((x) => x.op === "media.remove");
		expect(removed.map((x) => x.args.names)).toEqual([
			["umiak-build-agenttests-20261031050000.iso"],
		]);
		expect(report.join("\n")).toMatch(
			/removed ISOs umiak-build-agenttests-20261031050000/,
		);
	});
});
