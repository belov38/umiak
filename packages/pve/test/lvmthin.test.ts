import { describe, expect, it } from "vitest";
import {
	FreezeBudgetExceededError,
	formatDisk,
	LvmThinDriver,
	parseDiskSet,
	StorageFullError,
	ThawFailedError,
} from "../src/storage/lvmthin.ts";
import type {
	Disk,
	DiskSet,
	MachineRef,
	QuiesceHook,
} from "../src/storage/types.ts";
import { FakeClock, FakeNode } from "./fakes.ts";

const linuxTpl: DiskSet = parseDiskSet(
	{ scsi0: "local-lvm:base-599-disk-0,discard=on,iothread=1,size=40G,ssd=1" },
	"local-lvm",
);
const winTpl: DiskSet = parseDiskSet(
	{
		scsi0: "local-lvm:base-598-disk-1,discard=on,size=100G",
		efidisk0:
			"local-lvm:base-598-disk-0,efitype=4m,pre-enrolled-keys=1,size=4M",
		tpmstate0: "local-lvm:base-598-disk-2,size=4M,version=v2.0",
	},
	"local-lvm",
);

function setup(opts: { budgetMs?: number } = {}) {
	const log: string[] = [];
	const node = new FakeNode(log);
	const clock = new FakeClock();
	const vcpu = {
		suspend: async () => {
			log.push("suspend");
		},
		resume: async () => {
			log.push("resume");
		},
	};
	const driver = new LvmThinDriver({
		node,
		vcpu,
		storage: "local-lvm",
		freezeBudgetMs: opts.budgetMs ?? 10_000,
		thawRetryDelayMs: 0,
		now: clock.now,
		newSnapshotId: () => "snap1",
	});
	let thawFailures = 0;
	const hook: QuiesceHook & { thawFailures: number } = {
		thawFailures: 0,
		freeze: async () => {
			log.push("freeze");
		},
		thaw: async () => {
			log.push("thaw");
			if (thawFailures < hook.thawFailures) {
				thawFailures++;
				throw new Error("thaw failed");
			}
		},
	};
	return { log, node, clock, driver, hook };
}

const tplDisk = linuxTpl[0] as Disk;

const machine = (disks: DiskSet, running = true): MachineRef => ({
	node: "pve",
	vmid: 500,
	disks,
	running,
});

describe("parseDiskSet / formatDisk", () => {
	it("parses slots and drops size", () => {
		expect(linuxTpl).toEqual([
			{
				slot: "scsi0",
				volid: "local-lvm:base-599-disk-0",
				lv: "base-599-disk-0",
				options: { discard: "on", iothread: "1", ssd: "1" },
			},
		]);
		expect(winTpl.map((d) => d.slot)).toEqual([
			"efidisk0",
			"scsi0",
			"tpmstate0",
		]);
		expect(formatDisk({ ...tplDisk, volid: "local-lvm:vm-500-disk-0" })).toBe(
			"local-lvm:vm-500-disk-0,discard=on,iothread=1,ssd=1",
		);
	});
});

describe("cloneFromTemplate", () => {
	it("checks the pool, then creates one writable thin snapshot per disk", async () => {
		const { node, driver } = setup();
		const disks = await driver.cloneFromTemplate(
			{ node: "pve", vmid: 599, disks: linuxTpl },
			{ node: "pve", vmid: 500 },
		);
		expect(node.ops()).toEqual(["pool.usage", "lv.snapshot"]);
		expect(node.calls[1]?.args).toEqual({
			items: [
				{
					origin: "base-599-disk-0",
					name: "vm-500-disk-0",
					tags: ["sbx", "sbx-vm-500"],
					activationSkip: false,
				},
			],
		});
		expect(disks).toEqual([
			{
				slot: "scsi0",
				volid: "local-lvm:vm-500-disk-0",
				lv: "vm-500-disk-0",
				options: { discard: "on", iothread: "1", ssd: "1" },
			},
		]);
	});

	it("numbers disks by slot order for a Windows template", async () => {
		const { node, driver } = setup();
		await driver.cloneFromTemplate(
			{ node: "pve", vmid: 598, disks: winTpl },
			{ node: "pve", vmid: 501 },
		);
		const items = node.calls[1]?.args.items as {
			origin: string;
			name: string;
		}[];
		expect(items.map((i) => `${i.origin}->${i.name}`)).toEqual([
			"base-598-disk-0->vm-501-disk-0",
			"base-598-disk-1->vm-501-disk-1",
			"base-598-disk-2->vm-501-disk-2",
		]);
	});

	it("refuses when the thin pool is over the thresholds", async () => {
		for (const usage of [{ dataPercent: 81 }, { metadataPercent: 71 }]) {
			const { node, driver } = setup();
			Object.assign(node.usage, usage);
			await expect(
				driver.cloneFromTemplate(
					{ node: "pve", vmid: 599, disks: linuxTpl },
					{ node: "pve", vmid: 500 },
				),
			).rejects.toBeInstanceOf(StorageFullError);
			expect(node.ops()).not.toContain("lv.snapshot");
		}
	});
});

describe("snapshot", () => {
	it("freezes, snapshots and thaws a running single-disk machine without pausing", async () => {
		const { log, node, driver, hook } = setup();
		const s = await driver.snapshot(
			machine([{ ...tplDisk, lv: "vm-500-disk-0" }]),
			hook,
		);
		expect(log).toEqual([
			"node:pool.usage",
			"freeze",
			"node:lv.snapshot",
			"thaw",
		]);
		expect(node.calls[1]?.args).toEqual({
			items: [
				{
					origin: "vm-500-disk-0",
					name: "sbx-snap-snap1-scsi0",
					tags: ["sbx", "sbx-snap-snap1", "sbx-src-500"],
					activationSkip: true,
				},
			],
		});
		expect(s).toMatchObject({ kind: "snapshot", id: "snap1", sourceVmid: 500 });
		expect(s.disks[0]?.lv).toBe("sbx-snap-snap1-scsi0");
	});

	it("uses the caller-supplied snapshot id for LV names and tags", async () => {
		const { node, driver, hook } = setup();
		const s = await driver.snapshot(machine(linuxTpl), hook, { id: "abc123" });
		expect(s.id).toBe("abc123");
		expect(s.disks[0]?.lv).toBe("sbx-snap-abc123-scsi0");
		const items = node.calls.find((c) => c.op === "lv.snapshot")?.args
			.items as { name: string; tags: string[] }[];
		expect(items[0]).toMatchObject({
			name: "sbx-snap-abc123-scsi0",
			tags: ["sbx", "sbx-snap-abc123", "sbx-src-500"],
		});
	});

	it("accepts a 32-character hex id and rejects ids the sbx-node guard would refuse", async () => {
		const { node, driver, hook } = setup();
		await driver.snapshot(machine(linuxTpl), hook, {
			id: "0123456789abcdef0123456789abcdef",
		});
		const before = node.calls.length;
		for (const id of ["", "ABC", "a-b", "a_b", "a b", "x".repeat(33), "../x"]) {
			await expect(
				driver.snapshot(machine(linuxTpl), hook, { id }),
			).rejects.toThrow(/invalid snapshot id/);
		}
		expect(node.calls.length).toBe(before);
	});

	it("pauses vCPUs between freeze and thaw when there are several disks", async () => {
		const { log, driver, hook } = setup();
		await driver.snapshot(machine(winTpl), hook);
		expect(log).toEqual([
			"node:pool.usage",
			"freeze",
			"suspend",
			"node:lv.snapshot",
			"resume",
			"thaw",
		]);
	});

	it("thaws (and resumes) even when lvcreate fails", async () => {
		const { log, node, driver, hook } = setup();
		node.fail["lv.snapshot"] = new Error("lvcreate failed");
		await expect(driver.snapshot(machine(winTpl), hook)).rejects.toThrow(
			/lvcreate failed/,
		);
		expect(log.slice(-2)).toEqual(["resume", "thaw"]);
	});

	it("removes the created LVs when the freeze budget is exceeded", async () => {
		const { log, node, clock, driver, hook } = setup({ budgetMs: 10_000 });
		node.handlers["lv.snapshot"] = (a) => {
			clock.advance(11_000);
			const items = a.items as { name: string; tags: string[] }[];
			for (const it of items) node.lvs.push({ name: it.name, tags: it.tags });
			return { created: items.map((i) => i.name) };
		};
		await expect(
			driver.snapshot(machine(linuxTpl), hook),
		).rejects.toBeInstanceOf(FreezeBudgetExceededError);
		expect(log).toContain("thaw");
		expect(node.calls.at(-1)).toEqual({
			op: "lv.remove",
			args: { names: ["sbx-snap-snap1-scsi0"] },
		});
	});

	it("retries thaw and reports a machine that needs attention after the last retry", async () => {
		const ok = setup();
		ok.hook.thawFailures = 2;
		await expect(
			ok.driver.snapshot(machine(linuxTpl), ok.hook),
		).resolves.toMatchObject({ id: "snap1" });

		const bad = setup();
		bad.hook.thawFailures = 3;
		await expect(
			bad.driver.snapshot(machine(linuxTpl), bad.hook),
		).rejects.toBeInstanceOf(ThawFailedError);
		expect(bad.log.filter((l) => l === "thaw")).toHaveLength(3);
	});

	it("still thaws when resume fails", async () => {
		const log: string[] = [];
		const node = new FakeNode(log);
		const driver = new LvmThinDriver({
			node,
			vcpu: {
				suspend: async () => {},
				resume: async () => {
					throw new Error("resume failed");
				},
			},
			storage: "local-lvm",
			thawRetryDelayMs: 0,
			newSnapshotId: () => "snap1",
		});
		const hook = {
			freeze: async () => {
				log.push("freeze");
			},
			thaw: async () => {
				log.push("thaw");
			},
		};
		await expect(driver.snapshot(machine(winTpl), hook)).rejects.toThrow(
			/resume failed/,
		);
		expect(log).toContain("thaw");
	});

	it("skips freeze and pause for a stopped machine", async () => {
		const { log, driver, hook } = setup();
		await driver.snapshot(machine(winTpl, false), hook);
		expect(log).toEqual(["node:pool.usage", "node:lv.snapshot"]);
	});
});

describe("cloneFromSnapshot / delete / usage", () => {
	it("clones writable disks from the snapshot LVs", async () => {
		const { node, driver, hook } = setup();
		const s = await driver.snapshot(machine(linuxTpl), hook);
		node.calls = [];
		const disks = await driver.cloneFromSnapshot(s, { node: "pve", vmid: 501 });
		expect(node.calls[1]?.args).toEqual({
			items: [
				{
					origin: "sbx-snap-snap1-scsi0",
					name: "vm-501-disk-0",
					tags: ["sbx", "sbx-vm-501"],
					activationSkip: false,
				},
			],
		});
		expect(disks[0]?.volid).toBe("local-lvm:vm-501-disk-0");
	});

	it("deletes by owner tag", async () => {
		const { node, driver, hook } = setup();
		await driver.cloneFromTemplate(
			{ node: "pve", vmid: 599, disks: linuxTpl },
			{ node: "pve", vmid: 500 },
		);
		const s = await driver.snapshot(machine(linuxTpl), hook);
		node.calls = [];
		await driver.delete({ kind: "machine", node: "pve", vmid: 500 });
		expect(node.calls).toEqual([
			{ op: "lv.list", args: { tags: ["sbx", "sbx-vm-500"] } },
			{ op: "lv.remove", args: { names: ["vm-500-disk-0"] } },
		]);
		await driver.delete(s);
		expect(node.lvs).toEqual([]);
	});

	it("reports usage from the node", async () => {
		const { driver } = setup();
		expect(await driver.usage({ node: "pve" })).toEqual({
			dataPercent: 10,
			metadataPercent: 5,
			ourLvCount: 0,
			ourLvUsedBytes: 0,
		});
	});
});
