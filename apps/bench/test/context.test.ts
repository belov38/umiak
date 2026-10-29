import { describe, expect, it } from "vitest";
import { FakePve } from "../../../packages/pve/test/fakes.ts";
import { type Ctx, RamGuard } from "../src/context.ts";

function guard(capMb = 8192) {
	const api = new FakePve();
	const ctx = { api, cfg: { pool: "sandbox", node: "pve" } } as unknown as Ctx;
	const vm = (vmid: number, status: "running" | "stopped", memory = 2048) =>
		api.vms.set(vmid, {
			config: { memory: String(memory) },
			status,
			firewall: { rules: [], ipsets: {} },
		});
	return { api, vm, ram: new RamGuard(ctx, capMb) };
}

describe("RamGuard", () => {
	it("ignores a stale running status of recycled VMIDs", async () => {
		const { api, vm, ram } = guard();
		vm(500, "running");
		vm(501, "running");
		await ram.reserve(500, 2048);
		await ram.reserve(501, 2048);
		// 502 and 503 were deleted and re-created; /cluster/resources still says running.
		vm(502, "stopped");
		vm(503, "stopped");
		api.staleStatus.set(502, "running");
		api.staleStatus.set(503, "running");
		await ram.reserve(502, 2048);
		await ram.reserve(503, 2048);
	});

	it("still refuses to go over the cap", async () => {
		const { vm, ram } = guard();
		for (const id of [500, 501, 502]) {
			vm(id, "running");
			await ram.reserve(id, 2048);
		}
		vm(503, "stopped");
		await ram.reserve(503, 2048);
		vm(504, "stopped");
		await expect(ram.reserve(504, 2048)).rejects.toThrow(/RAM cap/);
	});

	it("counts running sandbox VMs it did not reserve, by their real status", async () => {
		const { api, vm, ram } = guard();
		vm(510, "running", 4096);
		api.staleStatus.set(510, "stopped");
		vm(511, "running", 2048);
		await expect(ram.reserve(512, 4096)).rejects.toThrow(
			/running 6144 MB \+ reserved 0 MB/,
		);
	});

	it("keeps the cap under concurrent reservations", async () => {
		const { vm, ram } = guard();
		const ids = [500, 501, 502, 503, 504];
		for (const id of ids) vm(id, "stopped");
		const r = await Promise.allSettled(ids.map((id) => ram.reserve(id, 2048)));
		expect(r.filter((x) => x.status === "rejected")).toHaveLength(1);
	});

	it("still counts a VM whose reservation was released while it runs", async () => {
		// The bench releases a reservation even when delete fails; a VM left running is still counted.
		const { vm, ram } = guard(4096);
		vm(500, "running");
		await ram.reserve(500, 2048);
		ram.release(500);
		await ram.reserve(501, 2048);
		await expect(ram.reserve(502, 2048)).rejects.toThrow(/running 2048 MB/);
	});

	it("does not count the VM being reserved twice", async () => {
		const { vm, ram } = guard(2048);
		vm(500, "running");
		await ram.reserve(500, 2048);
	});
});
