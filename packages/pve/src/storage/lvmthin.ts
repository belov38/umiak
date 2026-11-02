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
	/** Measured time the guest held writes. */
	readonly freezeMs: number | undefined;
	constructor(message: string, freezeMs?: number) {
		super(message);
		this.name = "FreezeBudgetExceededError";
		this.freezeMs = freezeMs;
	}
}

/** hook.freeze() did not return within freezeTimeoutMs; the snapshot is cancelled. */
export class FreezeTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FreezeTimeoutError";
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
	/** Time from the return of hook.freeze() to the call of hook.thaw(). */
	freezeBudgetMs?: number;
	/** Limit for hook.freeze() itself (agent hooks, secret wipe, VSS preparation). */
	freezeTimeoutMs?: number;
	maxDataPercent?: number;
	maxMetadataPercent?: number;
	thawRetries?: number;
	/** Maximum wait for each thaw attempt, including a hung QGA/VSS call. */
	thawTimeoutMs?: number;
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

/** The umiak-node guard for snapshot ids; they end up in LV names and tags. */
const SNAPSHOT_ID_RE = /^[a-z0-9]{1,32}$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function randomId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	return Array.from(randomBytes(10), (b) => alphabet[b % alphabet.length]).join(
		"",
	);
}

/** Storage driver for LVM-thin: every clone and snapshot is a thin snapshot made by umiak-node. */
export class LvmThinDriver implements StorageDriver {
	readonly #o: Required<LvmThinOptions>;

	constructor(opts: LvmThinOptions) {
		this.#o = {
			freezeBudgetMs: 10_000,
			freezeTimeoutMs: 30_000,
			maxDataPercent: 80,
			maxMetadataPercent: 70,
			thawRetries: 3,
			thawTimeoutMs: 10_000,
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
		skipSlots: readonly DiskSlot[] = [],
	): { items: SnapshotItem[]; disks: DiskSet } {
		const items: SnapshotItem[] = [];
		const disks: DiskSet = [];
		sorted(source)
			.filter((d) => !skipSlots.includes(d.slot))
			.forEach((d, k) => {
				const name = `vm-${vmid}-disk-${k}`;
				items.push({
					origin: d.lv,
					name,
					tags: ["umiak", `umiak-vm-${vmid}`],
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
		opts: { skipSlots?: DiskSlot[] } = {},
	): Promise<DiskSet> {
		await this.#assertCapacity(target);
		const { items, disks } = this.#vmDisks(
			tpl.disks,
			target.vmid,
			opts.skipSlots,
		);
		await this.#o.node.call("lv.snapshot", { items });
		return disks;
	}

	async cloneFromSnapshot(s: SnapshotRef, target: VmTarget): Promise<DiskSet> {
		await this.#assertCapacity(target);
		const { items, disks } = this.#vmDisks(s.disks, target.vmid);
		await this.#o.node.call("lv.snapshot", { items });
		return disks;
	}

	async snapshot(
		m: MachineRef,
		hook: QuiesceHook,
		opts: { id?: string } = {},
	): Promise<SnapshotRef> {
		if (opts.id !== undefined && !SNAPSHOT_ID_RE.test(opts.id))
			throw new Error(
				`invalid snapshot id ${JSON.stringify(opts.id)}: expected ${SNAPSHOT_ID_RE.source}`,
			);
		await this.#assertCapacity(m);
		const id = opts.id ?? this.#o.newSnapshotId();
		const items: SnapshotItem[] = [];
		const disks: DiskSet = [];
		for (const d of sorted(m.disks)) {
			const name = `umiak-snap-${id}-${d.slot satisfies DiskSlot}`;
			items.push({
				origin: d.lv,
				name,
				tags: ["umiak", `umiak-snap-${id}`, `umiak-src-${m.vmid}`],
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

		let frozen = false;
		let paused = false;
		let created: string[] = [];
		let snapshotCalled = false;
		let opError: unknown;
		let start: number | undefined;
		try {
			frozen = true; // thaw even if freeze itself fails half-way
			await this.#freeze(hook);
			// The budget covers what runs while the guest holds writes: pause, lvcreate, resume.
			start = this.#o.now();
			if (m.disks.length > 1) {
				paused = true;
				await this.#o.vcpu.suspend(m.vmid);
			}
			snapshotCalled = true;
			created = (
				await this.#o.node.call<{ created: string[] }>("lv.snapshot", { items })
			).created;
		} catch (err) {
			opError = err;
		}
		// Thaw even if resume fails: a frozen guest is worse than a paused one.
		let resumeError: unknown;
		if (paused) {
			try {
				await this.#o.vcpu.resume(m.vmid);
			} catch (err) {
				resumeError = err;
			}
		}
		const freezeMs = start === undefined ? 0 : this.#o.now() - start;
		let autoThawed = false;
		try {
			if (frozen) autoThawed = await this.#thaw(m.vmid, hook);
			if (opError) throw opError;
			if (resumeError) throw resumeError;
			if (freezeMs > this.#o.freezeBudgetMs)
				throw new FreezeBudgetExceededError(
					`freeze took ${freezeMs} ms (budget ${this.#o.freezeBudgetMs} ms); snapshot discarded`,
					freezeMs,
				);
		} catch (err) {
			// No ref reaches the caller, so nothing would ever delete these LVs.
			if (snapshotCalled) await this.#discard(id, created).catch(() => {});
			throw err;
		}
		return { ...ref, freezeMs, ...(autoThawed ? { autoThawed: true } : {}) };
	}

	/** Removes the LVs of a failed snapshot: the created ones and any carrying its tag. */
	async #discard(id: string, created: string[]): Promise<void> {
		const { lvs } = await this.#o.node
			.call<{ lvs: { name: string }[] }>("lv.list", {
				tags: ["umiak", `umiak-snap-${id}`],
			})
			.catch(() => ({ lvs: [] as { name: string }[] }));
		const names = [...new Set([...created, ...lvs.map((l) => l.name)])];
		if (names.length > 0) await this.#o.node.call("lv.remove", { names });
	}

	/** hook.freeze() under freezeTimeoutMs. A freeze that finishes late is thawed again. */
	async #freeze(hook: QuiesceHook): Promise<void> {
		const limit = this.#o.freezeTimeoutMs;
		const pending = hook.freeze();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), limit);
		});
		try {
			if ((await Promise.race([pending, timedOut])) !== "timeout") return;
		} finally {
			clearTimeout(timer);
		}
		pending.then(
			() => hook.thaw().catch(() => {}),
			() => {},
		);
		throw new FreezeTimeoutError(
			`freeze did not return within ${limit} ms; snapshot cancelled`,
		);
	}

	/** hook.thaw() with retries; true when the guest had already thawed itself. */
	async #thaw(vmid: number, hook: QuiesceHook): Promise<boolean> {
		let last: unknown;
		for (let i = 0; i < this.#o.thawRetries; i++) {
			try {
				let timer: ReturnType<typeof setTimeout> | undefined;
				let r: Awaited<ReturnType<QuiesceHook["thaw"]>>;
				try {
					r = await Promise.race([
						hook.thaw(),
						new Promise<never>((_, reject) => {
							timer = setTimeout(
								() => reject(new Error("thaw timed out")),
								this.#o.thawTimeoutMs,
							);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}
				return r?.autoThawed === true;
			} catch (err) {
				last = err;
				await sleep(this.#o.thawRetryDelayMs);
			}
		}
		throw new ThawFailedError(vmid, last);
	}

	async delete(ref: MachineDisksRef | SnapshotRef): Promise<void> {
		const tag =
			ref.kind === "machine" ? `umiak-vm-${ref.vmid}` : `umiak-snap-${ref.id}`;
		const { lvs } = await this.#o.node.call<{ lvs: { name: string }[] }>(
			"lv.list",
			{ tags: ["umiak", tag] },
		);
		if (lvs.length > 0)
			await this.#o.node.call("lv.remove", { names: lvs.map((l) => l.name) });
	}
}
