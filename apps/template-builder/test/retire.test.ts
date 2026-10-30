import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Allocator, macFor, SqliteStateStore } from "@sbx/pve";
import { FakeNode } from "@sbx/pve/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest.ts";
import { FileRegistry } from "../src/registry.ts";
import { retire } from "../src/retire.ts";
import { BuildPve } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date("2026-10-31T12:00:00Z");
const ID_LIVE = "0192f000-0000-7000-8000-000000000011";
const ID_GONE = "0192f000-0000-7000-8000-000000000012";
const ID_REUSED = "0192f000-0000-7000-8000-000000000013";
const ID_FAILED = "0192f000-0000-7000-8000-000000000014";

function row(over: Partial<Manifest>): Manifest {
	return {
		buildId: ID_LIVE,
		templateSlug: "linux",
		version: "20261030.15",
		os: "linux",
		status: "ready",
		node: "pve",
		storage: "local-lvm",
		pveVmid: 598,
		vmName: "sbx-tpl-linux-20261030-15",
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
		finishedAt: "2026-10-30T10:00:00.000Z",
		durationS: 3600,
		...over,
	};
}

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "sbx-retire-"));
	dirs.push(dir);
	const log: string[] = [];
	const pve = new BuildPve(log);
	const node = new FakeNode(log);
	node.handlers["dhcp.release"] = () => ({ released: true });
	const store = new SqliteStateStore(":memory:");
	const allocator = new Allocator({
		store,
		clusterId: 1,
		range: { min: 500, max: 589 },
		templateVmid: 599,
		templateRange: { min: 597, max: 598 },
		occupied: async () => new Set(pve.vms.keys()),
	});
	await allocator.ensureTemplate();
	const registry = new FileRegistry(join(dir, "registry"));
	const template = (name: string) => ({
		config: {
			name,
			tags: "sbx-tpl",
			// Proxmox returns `template` as a JSON number.
			template: 1 as unknown as string,
		},
		status: "stopped" as const,
		firewall: { rules: [], ipsets: {} },
	});
	pve.vms.set(598, template("sbx-tpl-linux-20261030-15"));
	// Slot 597 now holds a newer build.
	pve.vms.set(597, template("sbx-tpl-linux-20261031-1"));
	for (const vmid of [597, 598])
		await store.tryInsert({
			cluster: 1,
			vmid,
			mac: macFor(1, vmid),
			state: "active",
			purpose: "template",
			createdAt: 0,
			updatedAt: 0,
		});
	registry.create(row({}));
	registry.create(
		row({
			buildId: ID_REUSED,
			version: "20261030.11",
			pveVmid: 597,
			vmName: "sbx-tpl-linux-20261030-11",
		}),
	);
	registry.create(
		row({
			buildId: ID_GONE,
			version: "20261030.7",
			pveVmid: 596,
			vmName: "sbx-tpl-linux-20261030-7",
		}),
	);
	registry.create(
		row({
			buildId: ID_FAILED,
			version: "20261030.14",
			status: "failed",
		}),
	);
	const cfg = {
		node: "pve",
		templateVmidRange: { min: 597, max: 598 },
		templateVmid: 599,
	};
	const deps = {
		api: pve,
		node,
		allocator,
		registry,
		cfg,
		now: () => NOW,
	};
	return { pve, node, allocator, registry, deps };
}

describe("retire", () => {
	it("marks a build whose VM is gone or reused, and touches no VM", async () => {
		const s = await setup();
		for (const id of [ID_GONE, ID_REUSED]) {
			const report = await retire(s.deps, id, { deleteVm: false });
			expect(report.at(-1)).toMatch(/retired$/);
			expect(s.registry.get(id)?.status).toBe("retired");
			expect(s.registry.get(id)?.retiredAt).toBe(NOW.toISOString());
		}
		expect(s.pve.calls.filter((c) => c.method === "DELETE")).toEqual([]);
		expect([...s.pve.vms.keys()].sort()).toEqual([597, 598]);
		expect((await s.allocator.list()).map((l) => l.vmid).sort()).toEqual([
			597, 598, 599,
		]);
	});

	it("refuses a build whose template VM still exists without --delete-vm", async () => {
		const s = await setup();
		await expect(retire(s.deps, ID_LIVE, { deleteVm: false })).rejects.toThrow(
			/--delete-vm/,
		);
		expect(s.registry.get(ID_LIVE)?.status).toBe("ready");
		expect(s.pve.vms.has(598)).toBe(true);
	});

	it("with --delete-vm deletes the template VM and releases its lease", async () => {
		const s = await setup();
		const report = await retire(s.deps, ID_LIVE, { deleteVm: true });
		expect(s.pve.calls.filter((c) => c.method === "DELETE")).toEqual([
			{
				method: "DELETE",
				path: "/nodes/pve/qemu/598",
				params: { purge: 1, "destroy-unreferenced-disks": 1 },
			},
		]);
		expect(s.pve.vms.has(598)).toBe(false);
		expect((await s.allocator.list()).map((l) => l.vmid).sort()).toEqual([
			597, 599,
		]);
		expect(s.node.calls).toContainEqual({
			op: "dhcp.release",
			args: { mac: macFor(1, 598) },
		});
		expect(s.registry.get(ID_LIVE)?.status).toBe("retired");
		expect(report.join("\n")).toContain("deleted template VM 598");
	});

	it("marks the build retired when the VM is deleted but the lease release fails", async () => {
		const s = await setup();
		s.node.handlers["dhcp.release"] = () => {
			throw new Error("forbidden: MAC is not from our allocator");
		};
		const report = await retire(s.deps, ID_LIVE, { deleteVm: true });
		expect(s.pve.vms.has(598)).toBe(false);
		expect(report.join("\n")).toMatch(/lease 598: .*forbidden/);
		expect(s.registry.get(ID_LIVE)?.status).toBe("retired");
	});

	it("refuses failed and unknown builds, and is idempotent", async () => {
		const s = await setup();
		await expect(retire(s.deps, ID_FAILED, { deleteVm: true })).rejects.toThrow(
			/failed/,
		);
		await expect(
			retire(s.deps, "0192f000-0000-7000-8000-0000000000ff", {
				deleteVm: false,
			}),
		).rejects.toThrow(/not found/);
		await retire(s.deps, ID_GONE, { deleteVm: false });
		expect(await retire(s.deps, ID_GONE, { deleteVm: false })).toEqual([
			`build ${ID_GONE} is already retired`,
		]);
	});
});
