import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Allocator, macFor, SqliteStateStore } from "@sbx/pve";
import { FakeNode } from "@sbx/pve/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "../src/cleanup.ts";
import type { Manifest } from "../src/manifest.ts";
import { FileRegistry } from "../src/registry.ts";
import { BuildPve } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date("2026-10-30T12:00:00Z");
const ID_STALE = "0192f000-0000-7000-8000-000000000001";
const ID_FRESH = "0192f000-0000-7000-8000-000000000002";
const ID_GONE = "0192f000-0000-7000-8000-000000000003";

function row(over: Partial<Manifest>): Manifest {
	return {
		buildId: ID_STALE,
		templateSlug: "linux",
		version: "20261030.1",
		os: "linux",
		status: "building",
		node: "pve",
		storage: "local-lvm",
		pveVmid: null,
		vmName: "sbx-tpl-linux-20261030-1",
		gitCommit: "c",
		recipeDigest: "d",
		base: {
			distro: "ubuntu",
			release: "26.04",
			flavor: "minimal",
			serial: "1",
			sha256: "s",
		},
		apt: { snapshot: "x" },
		kernel: null,
		systemd: null,
		packages: {},
		tools: {},
		agentVersion: "1",
		defaultTunnelUrl: null,
		hw: {},
		diskLayout: {},
		bootTimeoutS: 300,
		buildMemoryMb: 4096,
		startedAt: "2026-10-30T09:00:00.000Z",
		finishedAt: null,
		durationS: null,
		...over,
	};
}

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "sbx-cleanup-"));
	dirs.push(dir);
	const log: string[] = [];
	const pve = new BuildPve(log);
	const node = new FakeNode(log);
	const iso = [
		"sbx-seed-old.iso",
		`sbx-seed-${ID_FRESH}.iso`,
		"sbx-seed-used.iso",
	];
	node.handlers["media.list"] = () => ({
		iso: iso.map((name) => ({ name, size: 1 })),
		import: [
			{ name: "sbx-ubuntu-26.04-minimal-1.qcow2", size: 1 },
			{ name: "sbx-seed-old.raw", size: 1 },
			{ name: `sbx-seed-${ID_FRESH}.raw`, size: 1 },
		],
	});
	node.handlers["media.remove"] = (a) => ({ removed: a.names, missing: [] });
	const store = new SqliteStateStore(":memory:");
	const allocator = new Allocator({
		store,
		clusterId: 1,
		range: { min: 500, max: 598 },
		templateVmid: 599,
		occupied: async () => new Set(pve.vms.keys()),
	});
	await allocator.ensureTemplate();
	const registry = new FileRegistry(join(dir, "registry"));

	const addVm = (
		vmid: number,
		config: Record<string, string>,
		status: "running" | "stopped" = "stopped",
	) =>
		pve.vms.set(vmid, { config, status, firewall: { rules: [], ipsets: {} } });
	// Failed build left running: removed.
	addVm(
		598,
		{ name: "sbx-tpl-linux-20261029-1", tags: "sbx-tpl", memory: "4096" },
		"running",
	);
	// Finished template: stays.
	addVm(597, {
		name: "sbx-tpl-linux-20261028-1",
		tags: "sbx-tpl",
		template: "1",
	});
	// Build in progress (fresh registry row): stays, and so does its ISO.
	addVm(596, {
		name: "sbx-tpl-linux-20261030-2",
		tags: "sbx-tpl",
		ide2: `local:iso/sbx-seed-${ID_FRESH}.iso,media=cdrom`,
	});
	// A kept failed build that is not ours by name: stays.
	addVm(595, {
		name: "something",
		tags: "sbx-tpl",
		ide2: "local:iso/sbx-seed-used.iso,media=cdrom",
	});
	// A sandbox without the tag: stays.
	addVm(500, { name: "sbx-m", tags: "sbx" }, "running");
	// Outside the range: never touched.
	addVm(9000, { name: "sbx-tpl-linux-x", tags: "sbx-tpl" });
	for (const vmid of [598, 597, 596]) {
		await store.tryInsert({
			cluster: 1,
			vmid,
			mac: macFor(1, vmid),
			state: vmid === 597 ? "active" : "reserved",
			purpose: "template",
			createdAt: 0,
			updatedAt: 0,
		});
	}
	// Lease whose VM is gone: released.
	await store.tryInsert({
		cluster: 1,
		vmid: 590,
		mac: macFor(1, 590),
		state: "active",
		purpose: "template",
		createdAt: 0,
		updatedAt: 0,
	});
	registry.create(
		row({ buildId: ID_STALE, startedAt: "2026-10-30T09:00:00.000Z" }),
	);
	registry.create(
		row({
			buildId: ID_FRESH,
			version: "20261030.2",
			vmName: "sbx-tpl-linux-20261030-2",
			pveVmid: 596,
			startedAt: "2026-10-30T11:30:00.000Z",
		}),
	);
	registry.create(
		row({
			buildId: ID_GONE,
			version: "20261029.1",
			status: "ready",
			pveVmid: 590,
		}),
	);
	const cfg = {
		node: "pve",
		pool: "sandbox",
		templateVmidRange: { min: 500, max: 598 },
		templateVmid: 599,
	};
	return { pve, node, store, allocator, registry, cfg, log };
}

describe("cleanup", () => {
	it("removes failed build leftovers and nothing else", async () => {
		const s = await setup();
		const report = await cleanup({
			api: s.pve,
			node: s.node,
			allocator: s.allocator,
			registry: s.registry,
			cfg: s.cfg,
			now: () => NOW,
		});

		expect([...s.pve.vms.keys()].sort()).toEqual([500, 595, 596, 597, 9000]);
		const del = s.pve.calls.filter((c) => c.method === "DELETE");
		expect(del).toEqual([
			{
				method: "DELETE",
				path: "/nodes/pve/qemu/598",
				params: { purge: 1, "destroy-unreferenced-disks": 1 },
			},
		]);
		expect(
			s.pve.calls.some((c) => c.path === "/nodes/pve/qemu/598/status/stop"),
		).toBe(true);

		const removed = s.node.calls.filter((c) => c.op === "media.remove");
		expect(removed).toEqual([
			{
				op: "media.remove",
				// The base image cache and the running build's seed stay.
				args: { names: ["sbx-seed-old.iso", "sbx-seed-old.raw"] },
			},
		]);

		const leases = (await s.allocator.list()).map((l) => l.vmid).sort();
		expect(leases).toEqual([596, 597, 599]);

		expect(s.registry.get(ID_STALE)?.status).toBe("failed");
		expect(s.registry.get(ID_STALE)?.error?.message).toMatch(/cleanup/);
		expect(s.registry.get(ID_FRESH)?.status).toBe("building");
		expect(s.registry.get(ID_GONE)?.status).toBe("ready");
		expect(report.join("\n")).toContain("598");
	});

	it("reports nothing on a clean node", async () => {
		const s = await setup();
		const d = {
			api: s.pve,
			node: s.node,
			allocator: s.allocator,
			registry: s.registry,
			cfg: s.cfg,
			now: () => NOW,
		};
		await cleanup(d);
		s.node.handlers["media.list"] = () => ({ iso: [], import: [] });
		expect(await cleanup(d)).toEqual([]);
	});

	it("never touches protected VMIDs even when the config range covers them", async () => {
		const s = await setup();
		for (const vmid of [450, 599, 9000, 9001])
			s.pve.vms.set(vmid, {
				config: { name: `sbx-tpl-linux-x-${vmid}`, tags: "sbx-tpl" },
				status: "running",
				firewall: { rules: [], ipsets: {} },
			});
		await s.store.tryInsert({
			cluster: 1,
			vmid: 450,
			mac: macFor(1, 450),
			state: "active",
			purpose: "template",
			createdAt: 0,
			updatedAt: 0,
		});
		s.pve.vms.delete(450);
		await cleanup({
			api: s.pve,
			node: s.node,
			allocator: s.allocator,
			registry: s.registry,
			cfg: {
				...s.cfg,
				templateVmidRange: { min: 100, max: 9999 },
				templateVmid: 0,
			},
			now: () => NOW,
		});
		for (const vmid of [599, 9000, 9001])
			expect(s.pve.vms.has(vmid)).toBe(true);
		const touched = s.pve.calls.filter((c) =>
			/\/qemu\/(450|599|9000|9001)(\/|$)/.test(c.path),
		);
		expect(touched).toEqual([]);
		expect((await s.allocator.get(450))?.state).toBe("active");
		// The unprotected leftover still goes.
		expect(s.pve.vms.has(598)).toBe(false);
	});
});
