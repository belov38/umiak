import {
	Allocator,
	LvmThinDriver,
	Machines,
	pveVcpuControl,
	SqliteStateStore,
} from "@sbx/pve";
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
	const cfg = {
		node: "pve",
		storage: "local-lvm",
		vnet: "sbx0",
		pool: "sandbox",
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
	it("never deletes a template VM (tag sbx-tpl or template: 1)", async () => {
		const { c, api } = ctx();
		for (const [vmid, config] of [
			[598, { name: "t1", tags: "sbx-tpl", template: "1" }],
			[597, { name: "t2", tags: "sbx;sbx-tpl" }],
			[596, { name: "t3", template: "1" }],
		] as const) {
			api.vms.set(vmid, {
				config: { ...config },
				status: "stopped",
				firewall: { rules: [], ipsets: {} },
			});
		}
		const report = await cleanup(c);
		expect(api.paths().some((p) => p.startsWith("DELETE"))).toBe(false);
		expect([...api.vms.keys()].sort()).toEqual([596, 597, 598]);
		expect(report.join("\n")).not.toMatch(/59[678]/);
	});

	it("keeps an allocator row whose traces cannot be removed", async () => {
		const { c, node, store } = ctx();
		await c.machines.create({});
		node.leases.push({ mac: "02:01:00:00:01:f4", ip: "10.88.0.101" });
		node.handlers["dhcp.release"] = () => ({ released: false });
		const report = await cleanup(c);
		expect(store.get(1, 500)).toBeDefined();
		expect(report.join("\n")).toMatch(/500/);
	});

	it("drops rows, records and LVs when everything is gone", async () => {
		const { c, node, store } = ctx();
		const m = await c.machines.create({});
		await c.machines.snapshot(m.vmid);
		const report = await cleanup(c);
		expect(store.list(1)).toEqual([]);
		expect(store.listSnapshots()).toEqual([]);
		expect(node.lvs).toEqual([]);
		expect(report.join("\n")).toMatch(/deleted VM 500/);
	});
});
