import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Allocator, macFor, SqliteStateStore } from "@umiak/pve";
import { FakeNode } from "@umiak/pve/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest.ts";
import { FileRegistry } from "../src/registry.ts";
import { configuredBuilds, type RetireDeps, retire } from "../src/retire.ts";
import { BuildPve } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date("2026-10-31T12:00:00Z");
const DESKTOP: Manifest["desktop"] = {
	pins: {
		sunshine: { version: "1.0.0", sha256: "a".repeat(64) },
		moonlight_web: { version: "1.0.0", sha256: "b".repeat(64) },
		cua_driver: { version: "1.0.0", sha256: "c".repeat(64) },
	},
	sources: {},
};
const ID_LIVE = "0192f000-0000-7000-8000-000000000011";
const ID_GONE = "0192f000-0000-7000-8000-000000000012";
const ID_REUSED = "0192f000-0000-7000-8000-000000000013";
const ID_FAILED = "0192f000-0000-7000-8000-000000000014";
const ID_NEWEST = "0192f000-0000-7000-8000-000000000015";
const ID_POC = "0192f000-0000-7000-8000-000000000016";

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
		vmName: "umiak-tpl-linux-20261030-15",
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
	const dir = mkdtempSync(join(tmpdir(), "umiak-retire-"));
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
		templateRange: { min: 597, max: 599 },
		occupied: async () => new Set(pve.vms.keys()),
	});
	await allocator.ensureTemplate();
	const registry = new FileRegistry(join(dir, "registry"));
	const template = (name: string) => ({
		config: {
			name,
			tags: "umiak-tpl",
			// Proxmox returns `template` as a JSON number.
			template: 1 as unknown as string,
		},
		status: "stopped" as const,
		firewall: { rules: [], ipsets: {} },
	});
	pve.vms.set(598, template("umiak-tpl-linux-20261030-15"));
	// Slot 597 now holds the newest build; 599 a Linux build of the PoC slot.
	pve.vms.set(597, template("umiak-tpl-linux-20261031-1"));
	pve.vms.set(599, template("umiak-tpl-linux-20261029-1"));
	// The fake answers 599's config from templateConfig.
	pve.templateConfig = {
		...pve.templateConfig,
		name: "umiak-tpl-linux-20261029-1",
	};
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
			vmName: "umiak-tpl-linux-20261030-11",
		}),
	);
	registry.create(
		row({
			buildId: ID_GONE,
			version: "20261030.7",
			pveVmid: 596,
			vmName: "umiak-tpl-linux-20261030-7",
		}),
	);
	registry.create(
		row({
			buildId: ID_FAILED,
			version: "20261030.14",
			status: "failed",
		}),
	);
	registry.create(
		row({
			buildId: ID_POC,
			version: "20261029.1",
			pveVmid: 599,
			vmName: "umiak-tpl-linux-20261029-1",
			startedAt: "2026-10-29T09:00:00.000Z",
		}),
	);
	registry.create(
		row({
			buildId: ID_NEWEST,
			version: "20261031.1",
			pveVmid: 597,
			vmName: "umiak-tpl-linux-20261031-1",
			startedAt: "2026-10-31T09:00:00.000Z",
		}),
	);
	const cfg = {
		node: "pve",
		templateVmidRange: { min: 597, max: 599 },
		templateVmid: 599,
	};
	const deps: RetireDeps = {
		api: pve,
		node,
		allocator,
		registry,
		cfg,
		// The worker config uses the newest build and the PoC seed.
		configured: {
			file: "umiak.yaml",
			builds: [
				{ templateSlug: "linux", version: "599-seed", pveVmid: 599 },
				{ templateSlug: "linux", version: "20261031.1", pveVmid: 597 },
			],
		},
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
		expect([...s.pve.vms.keys()].sort()).toEqual([597, 598, 599]);
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

	it.each([597, 598])(
		"preserves a legacy headless Windows build in slot %s without --force",
		async (vmid) => {
			const s = await setup();
			s.registry.update(ID_LIVE, {
				os: "windows",
				templateSlug: "windows",
				pveVmid: vmid,
			});
			const template = s.pve.vms.get(598);
			if (!template) throw new Error("missing template fixture");
			s.pve.vms.set(vmid, template);
			// A newer desktop build means the newest-ready guard no longer protects this build.
			s.registry.update(ID_NEWEST, {
				os: "windows",
				templateSlug: "windows",
				desktop: DESKTOP,
			});
			await expect(retire(s.deps, ID_LIVE, { deleteVm: true })).rejects.toThrow(
				/headless Windows.*--force/,
			);
			expect(s.pve.calls.filter((c) => c.method !== "GET")).toEqual([]);
			expect(s.pve.vms.has(vmid)).toBe(true);
			expect(s.registry.get(ID_LIVE)?.status).toBe("ready");
			expect((await s.allocator.list()).some((l) => l.vmid === vmid)).toBe(
				true,
			);
			await retire(s.deps, ID_LIVE, { deleteVm: true, force: true });
			expect(s.pve.vms.has(vmid)).toBe(false);
			expect(s.registry.get(ID_LIVE)?.status).toBe("retired");
		},
	);

	it("retires a headless Windows build whose VM is gone without requesting deletion", async () => {
		const s = await setup();
		s.registry.update(ID_GONE, { os: "windows", templateSlug: "windows" });
		s.registry.update(ID_NEWEST, {
			os: "windows",
			templateSlug: "windows",
			desktop: DESKTOP,
		});
		await retire(s.deps, ID_GONE, { deleteVm: false });
		expect(s.registry.get(ID_GONE)?.status).toBe("retired");
		expect(s.pve.calls.filter((c) => c.method !== "GET")).toEqual([]);
	});

	it("allows deleting a superseded Windows desktop build without --force", async () => {
		const s = await setup();
		s.registry.update(ID_LIVE, {
			os: "windows",
			templateSlug: "windows",
			desktopMarker: "umiak-desktop",
		});
		s.registry.update(ID_NEWEST, {
			os: "windows",
			templateSlug: "windows",
			desktopMarker: "umiak-desktop",
		});
		await retire(s.deps, ID_LIVE, { deleteVm: true });
		expect(s.pve.vms.has(598)).toBe(false);
	});

	it("refuses deleting an already retired build without --force", async () => {
		const s = await setup();
		const retiredAt = "2026-10-30T11:00:00.000Z";
		s.registry.update(ID_LIVE, { status: "retired", retiredAt });
		await expect(retire(s.deps, ID_LIVE, { deleteVm: true })).rejects.toThrow(
			/retired.*--force/,
		);
		expect(s.pve.calls).toEqual([]);
		expect(s.pve.vms.has(598)).toBe(true);
		expect(
			await retire(s.deps, ID_LIVE, { deleteVm: true, force: true }),
		).toEqual([`build ${ID_LIVE} is already retired`]);
		expect(s.pve.vms.has(598)).toBe(true);
		expect(s.registry.get(ID_LIVE)?.retiredAt).toBe(retiredAt);
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

	it("refuses the build the worker config uses, before any change; --force overrides", async () => {
		const s = await setup();
		s.deps.configured.builds.push({
			templateSlug: "linux",
			version: "20261030.15",
		});
		await expect(retire(s.deps, ID_LIVE, { deleteVm: true })).rejects.toThrow(
			/umiak\.yaml.*--force/,
		);
		expect(s.pve.calls.filter((c) => c.method !== "GET")).toEqual([]);
		expect(s.registry.get(ID_LIVE)?.status).toBe("ready");
		await retire(s.deps, ID_LIVE, { deleteVm: true, force: true });
		expect(s.pve.vms.has(598)).toBe(false);
		expect(s.registry.get(ID_LIVE)?.status).toBe("retired");
	});

	it("refuses a build whose VM the config uses by VMID", async () => {
		const s = await setup();
		s.deps.configured.builds.push({
			templateSlug: "linux",
			version: "other",
			node: "pve",
			pveVmid: 598,
		});
		await expect(retire(s.deps, ID_LIVE, { deleteVm: true })).rejects.toThrow(
			/topology\.templateBuilds other/,
		);
		expect(s.pve.vms.has(598)).toBe(true);
	});

	it("refuses the newest ready build of its template; --force overrides", async () => {
		const s = await setup();
		s.deps.configured.builds = [];
		await expect(retire(s.deps, ID_NEWEST, { deleteVm: true })).rejects.toThrow(
			/newest ready linux build/,
		);
		expect(s.pve.vms.has(597)).toBe(true);
		expect(s.registry.get(ID_NEWEST)?.status).toBe("ready");
		await retire(s.deps, ID_NEWEST, { deleteVm: true, force: true });
		expect(s.pve.vms.has(597)).toBe(false);
	});

	it("refuses a build in the PoC slot 599 even with --force, unless --force-poc", async () => {
		const s = await setup();
		for (const o of [{ deleteVm: true }, { deleteVm: true, force: true }])
			await expect(retire(s.deps, ID_POC, o)).rejects.toThrow(/--force-poc/);
		expect(s.pve.vms.has(599)).toBe(true);
		// The config still uses VM 599 (599-seed): --force-poc alone does not override that.
		await expect(
			retire(s.deps, ID_POC, { deleteVm: true, forcePoc: true }),
		).rejects.toThrow(/599-seed/);
		const report = await retire(s.deps, ID_POC, {
			deleteVm: true,
			force: true,
			forcePoc: true,
		});
		expect(report.join("\n")).toContain("deleted template VM 599");
		expect(s.pve.vms.has(599)).toBe(false);
		expect(s.registry.get(ID_POC)?.status).toBe("retired");
	});
});

describe("configuredBuilds", () => {
	it("reads topology.templateBuilds of a worker config", () => {
		const dir = mkdtempSync(join(tmpdir(), "umiak-retire-cfg-"));
		dirs.push(dir);
		const file = join(dir, "umiak.yaml");
		writeFileSync(
			file,
			[
				"topology:",
				"  templateBuilds:",
				"    - templateSlug: linux",
				"      version: 599-seed",
				"      pveVmid: 599",
				"    - templateSlug: linux",
				'      version: "20261030.16"',
				"      node: pve",
				"      pveVmid: 597",
				"",
			].join("\n"),
		);
		expect(configuredBuilds(file)).toEqual([
			{ templateSlug: "linux", version: "599-seed", pveVmid: 599 },
			{
				templateSlug: "linux",
				version: "20261030.16",
				node: "pve",
				pveVmid: 597,
			},
		]);
		writeFileSync(file, "templates: []\n");
		expect(configuredBuilds(file)).toEqual([]);
	});

	it("reads the dev stand config", () => {
		const builds = configuredBuilds(
			join(import.meta.dirname, "../../../deploy/compose/config/umiak.yaml"),
		);
		expect(builds.some((b) => b.templateSlug === "linux")).toBe(true);
	});
});
