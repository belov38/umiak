import { expect, it } from "vitest";
import { runningSandboxMemory } from "../../../infra/dev-cp/desktop-budget.ts";

it("counts all running 500–599 VMs, including builds outside the sandbox pool", () => {
	expect(
		runningSandboxMemory(`VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID
101 other running 16384 600 1
500 s9 running 4096 96 2
595 desktop running 4096 64 3
596 previous stopped 4096 64 0
599 poc stopped 2048 40 0`),
	).toBe(8192);
});
it("rejects unreadable host memory instead of assuming zero", () => {
	expect(() =>
		runningSandboxMemory("VMID NAME STATUS MEM(MB)\n500 s9 running unknown"),
	).toThrow("memory");
	expect(() => runningSandboxMemory("unavailable")).toThrow("header");
});

it("limits S10 itself to one 4GiB guest even while S9 is idle", () => {
	const list =
		"VMID NAME STATUS MEM(MB)\n580 probe running 4096\n595 template stopped 4096";
	expect(runningSandboxMemory(list, true)).toBe(4096);
});
