import { randomBytes } from "node:crypto";
import type { NodeOps } from "../node-client.ts";
import {
	type Disk,
	type DiskSet,
	type DiskSlot,
	type MachineDisksRef,
	type MachineRef,
	type NodeRef,
	type QuiesceHook,
	SLOT_ORDER,
	type SnapshotRef,
	type StorageDriver,
	type StorageUsage,
	type TemplateRef,
	type VmTarget,
} from "./types.ts";

export class StorageFullError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StorageFullError";
	}
}

export class FreezeBudgetExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FreezeBudgetExceededError";
	}
}

/** The guest may still be frozen: the machine needs attention. */
export class ThawFailedError extends Error {
	readonly vmid: number;
	constructor(vmid: number, cause: unknown) {
		super(`thaw failed for VM ${vmid}; machine needs attention`, { cause });
		this.name = "ThawFailedError";
		this.vmid = vmid;
	}
}

/** Parses the disk slots of a VM config. Size is dropped: Proxmox reads it from the volume. */
export function parseDiskSet(
	config: Record<string, unknown>,
	storage: string,
): DiskSet {
	const disks: DiskSet = [];
	for (const slot of SLOT_ORDER) {
		const v = config[slot];
		if (typeof v !== "string") continue;
		const [volid = "", ...rest] = v.split(",");
		if (!volid.startsWith(`${storage}:`)) {
			throw new Error(`${slot} is on ${volid}, expected storage ${storage}`);
		}
		const options: Record<string, string> = {};
		for (const kv of rest) {
			const [k = "", val = ""] = kv.split("=");
			if (k && k !== "size") options[k] = val;
		}
		disks.push({ slot, volid, lv: volid.slice(storage.length + 1), options });
	}
	return disks;
}

export function formatDisk(d: Disk): string {
	return [
		d.volid,
		...Object.entries(d.options).map(([k, v]) => `${k}=${v}`),
	].join(",");
}

function sorted(disks: DiskSet): DiskSet {
	return [...disks].sort(
		(a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot),
	);
}

export interface VcpuControl {
	suspend(vmid: number): Promise<void>;
	resume(vmid: number): Promise<void>;
}

export interface LvmThinOptions {
	node: NodeOps;
	vcpu: VcpuControl;
	storage: string;
	freezeBudgetMs?: number;
	maxDataPercent?: number;
	maxMetadataPercent?: number;
	thawRetries?: number;
	thawRetryDelayMs?: number;
	newSnapshotId?: () => string;
	now?: () => number;
}

interface SnapshotItem {
	origin: string;
	name: string;
	tags: string[];
	activationSkip: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function randomId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	return Array.from(randomBytes(10), (b) => alphabet[b % alphabet.length]).join(
		"",
	);
}

/** Storage driver for LVM-thin: every clone and snapshot is a thin snapshot made by sbx-node. */
export class LvmThinDriver implements StorageDriver {
	readonly #o: Required<LvmThinOptions>;

	constructor(opts: LvmThinOptions) {
		this.#o = {
			freezeBudgetMs: 10_000,
			maxDataPercent: 80,
			maxMetadataPercent: 70,
			thawRetries: 3,
			thawRetryDelayMs: 500,
			newSnapshotId: randomId,
			now: Date.now,
			...opts,
		};
	}

	async usage(_node: NodeRef): Promise<StorageUsage> {
		const u = await this.#o.node.call<StorageUsage>("pool.usage");
		return {
			dataPercent: u.dataPercent,
			metadataPercent: u.metadataPercent,
			ourLvCount: u.ourLvCount,
			ourLvUsedBytes: u.ourLvUsedBytes,
		};
	}

	async #assertCapacity(node: NodeRef): Promise<void> {
		const u = await this.usage(node);
		if (
			u.dataPercent > this.#o.maxDataPercent ||
			u.metadataPercent > this.#o.maxMetadataPercent
		) {
			throw new StorageFullError(
				`thin pool data ${u.dataPercent}% (max ${this.#o.maxDataPercent}), metadata ${u.metadataPercent}% (max ${this.#o.maxMetadataPercent})`,
			);
		}
	}

	#vmDisks(
		source: DiskSet,
		vmid: number,
	): { items: SnapshotItem[]; disks: DiskSet } {
		const items: SnapshotItem[] = [];
		const disks: DiskSet = [];
		sorted(source).forEach((d, k) => {
			const name = `vm-${vmid}-disk-${k}`;
			items.push({
				origin: d.lv,
				name,
				tags: ["sbx", `sbx-vm-${vmid}`],
				activationSkip: false,
			});
			disks.push({
				slot: d.slot,
				volid: `${this.#o.storage}:${name}`,
				lv: name,
				options: { ...d.options },
			});
		});
		return { items, disks };
	}

	async cloneFromTemplate(
		tpl: TemplateRef,
		target: VmTarget,
	): Promise<DiskSet> {
		await this.#assertCapacity(target);
		const { items, disks } = this.#vmDisks(tpl.disks, target.vmid);
		await this.#o.node.call("lv.snapshot", { items });
		return disks;
	}

	async cloneFromSnapshot(s: SnapshotRef, target: VmTarget): Promise<DiskSet> {
		await this.#assertCapacity(target);
		const { items, disks } = this.#vmDisks(s.disks, target.vmid);
		await this.#o.node.call("lv.snapshot", { items });
		return disks;
	}

	async snapshot(m: MachineRef, hook: QuiesceHook): Promise<SnapshotRef> {
		await this.#assertCapacity(m);
		const id = this.#o.newSnapshotId();
		const items: SnapshotItem[] = [];
		const disks: DiskSet = [];
		for (const d of sorted(m.disks)) {
			const name = `sbx-snap-${id}-${d.slot satisfies DiskSlot}`;
			items.push({
				origin: d.lv,
				name,
				tags: ["sbx", `sbx-snap-${id}`, `sbx-src-${m.vmid}`],
				activationSkip: true,
			});
			disks.push({
				slot: d.slot,
				volid: `${this.#o.storage}:${name}`,
				lv: name,
				options: { ...d.options },
			});
		}
		const ref: SnapshotRef = {
			kind: "snapshot",
			id,
			node: m.node,
			sourceVmid: m.vmid,
			disks,
			hardware: {},
			createdAt: this.#o.now(),
		};
		if (!m.running) {
			await this.#o.node.call("lv.snapshot", { items });
			return ref;
		}

		const start = this.#o.now();
		let frozen = false;
		let paused = false;
		let created: string[] = [];
		try {
			frozen = true; // thaw even if freeze itself fails half-way
			await hook.freeze();
			if (m.disks.length > 1) {
				paused = true;
				await this.#o.vcpu.suspend(m.vmid);
			}
			created = (
				await this.#o.node.call<{ created: string[] }>("lv.snapshot", { items })
			).created;
		} finally {
			if (paused) await this.#o.vcpu.resume(m.vmid);
			if (frozen) await this.#thaw(m.vmid, hook);
		}
		const freezeMs = this.#o.now() - start;
		if (freezeMs > this.#o.freezeBudgetMs) {
			if (created.length > 0)
				await this.#o.node.call("lv.remove", { names: created });
			throw new FreezeBudgetExceededError(
				`freeze took ${freezeMs} ms (budget ${this.#o.freezeBudgetMs} ms); snapshot discarded`,
			);
		}
		return { ...ref, freezeMs };
	}

	async #thaw(vmid: number, hook: QuiesceHook): Promise<void> {
		let last: unknown;
		for (let i = 0; i < this.#o.thawRetries; i++) {
			try {
				await hook.thaw();
				return;
			} catch (err) {
				last = err;
				await sleep(this.#o.thawRetryDelayMs);
			}
		}
		throw new ThawFailedError(vmid, last);
	}

	async delete(ref: MachineDisksRef | SnapshotRef): Promise<void> {
		const tag =
			ref.kind === "machine" ? `sbx-vm-${ref.vmid}` : `sbx-snap-${ref.id}`;
		const { lvs } = await this.#o.node.call<{ lvs: { name: string }[] }>(
			"lv.list",
			{ tags: ["sbx", tag] },
		);
		if (lvs.length > 0)
			await this.#o.node.call("lv.remove", { names: lvs.map((l) => l.name) });
	}
}
