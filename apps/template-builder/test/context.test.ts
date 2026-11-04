import { FakePve } from "@umiak/pve/testing";
import { describe, expect, it, vi } from "vitest";
import { imageCacheDir, RamGuard, registryDir } from "../src/context.ts";

function pveWith(
	vms: {
		vmid: number;
		memory: number;
		status: "running" | "stopped";
		template?: boolean;
	}[],
) {
	const pve = new FakePve();
	for (const v of vms)
		pve.vms.set(v.vmid, {
			config: {
				memory: String(v.memory),
				...(v.template ? { template: "1" } : {}),
			},
			status: v.status,
			firewall: { rules: [], ipsets: {} },
		});
	return pve;
}

describe("RamGuard", () => {
	it("does not charge another node's VMs against the target node cap", async () => {
		const pve = pveWith([{ vmid: 500, memory: 8192, status: "running" }]);
		const get = pve.get.bind(pve);
		vi.spyOn(pve, "get").mockImplementation(async (path, params) => {
			const result = await get(path, params);
			if (path === "/cluster/resources")
				return (result as object[]).map((v) => ({ ...v, node: "pve2" }));
			return result;
		});
		const g = new RamGuard({
			api: pve,
			node: "pve",
			pool: "umiak",
			capMb: 4096,
		});
		expect(await g.runningMb()).toBe(0);
		await expect(g.reserve(601, 4096)).resolves.toBeUndefined();
	});

	it("counts running non-template pool VMs and refuses to exceed the cap", async () => {
		const pve = pveWith([
			{ vmid: 500, memory: 2048, status: "running" },
			{ vmid: 501, memory: 2048, status: "stopped" },
			{ vmid: 598, memory: 4096, status: "running", template: true },
		]);
		const g = new RamGuard({
			api: pve,
			node: "pve",
			pool: "umiak",
			capMb: 8192,
		});
		await g.reserve(597, 4096);
		// 2048 running + 4096 reserved + 4096 new > 8192
		await expect(g.reserve(596, 4096)).rejects.toThrow(/RAM cap/);
		g.release(597);
		await g.reserve(596, 4096);
	});

	it("does not count the VM being reserved twice", async () => {
		const pve = pveWith([{ vmid: 597, memory: 4096, status: "running" }]);
		const g = new RamGuard({
			api: pve,
			node: "pve",
			pool: "umiak",
			capMb: 4096,
		});
		await g.reserve(597, 4096);
		await g.reserve(597, 4096);
	});
});

describe("paths", () => {
	it("default to the user's state and cache dirs, env overrides", () => {
		expect(registryDir({}, "/h")).toBe("/h/.local/state/umiak/templates");
		expect(registryDir({ UMIAK_TEMPLATE_REGISTRY: "/r" }, "/h")).toBe("/r");
		expect(imageCacheDir({}, "/h")).toBe("/h/.cache/umiak/images");
		expect(imageCacheDir({ UMIAK_IMAGE_CACHE: "/c" }, "/h")).toBe("/c");
	});
});

describe("node build RAM cap", () => {
	it("accepts configured node cap and refuses invalid values", async () => {
		const { templateRamCapMb } = await import("../src/context.ts");
		expect(templateRamCapMb({})).toBe(8192);
		expect(templateRamCapMb({ UMIAK_TEMPLATE_RAM_CAP_MB: "4096" })).toBe(4096);
		expect(() =>
			templateRamCapMb({ UMIAK_TEMPLATE_RAM_CAP_MB: "nope" }),
		).toThrow(/RAM/);
	});
});
