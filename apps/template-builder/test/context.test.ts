import { FakePve } from "@sbx/pve/testing";
import { describe, expect, it } from "vitest";
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
	it("counts running non-template pool VMs and refuses to exceed the cap", async () => {
		const pve = pveWith([
			{ vmid: 500, memory: 2048, status: "running" },
			{ vmid: 501, memory: 2048, status: "stopped" },
			{ vmid: 598, memory: 4096, status: "running", template: true },
		]);
		const g = new RamGuard({
			api: pve,
			node: "pve",
			pool: "sandbox",
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
			pool: "sandbox",
			capMb: 4096,
		});
		await g.reserve(597, 4096);
		await g.reserve(597, 4096);
	});
});

describe("paths", () => {
	it("default to the user's state and cache dirs, env overrides", () => {
		expect(registryDir({}, "/h")).toBe("/h/.local/state/sbx/templates");
		expect(registryDir({ SBX_TEMPLATE_REGISTRY: "/r" }, "/h")).toBe("/r");
		expect(imageCacheDir({}, "/h")).toBe("/h/.cache/sbx/images");
		expect(imageCacheDir({ SBX_IMAGE_CACHE: "/c" }, "/h")).toBe("/c");
	});
});
