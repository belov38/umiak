import { type Allocator, macFor, type SnapshotStore } from "./allocator.ts";
import type { Config } from "./config.ts";
import { type NodeOps, NodeOpsError } from "./node-client.ts";
import type { Params, PveClient } from "./pve-api.ts";
import { Qga } from "./qga.ts";
import {
	formatDisk,
	parseDiskSet,
	type VcpuControl,
} from "./storage/lvmthin.ts";
import type {
	DiskSet,
	QuiesceHook,
	SnapshotRef,
	StorageDriver,
	TemplateRef,
} from "./storage/types.ts";

/** Caller-provided SMBIOS identity. serial is the raw payload; it is base64-encoded for Proxmox. */
export interface Smbios {
	uuid: string;
	serial: string;
}

export function formatSmbios1(s: Smbios): string {
	return `uuid=${s.uuid},serial=${Buffer.from(s.serial, "utf8").toString("base64")},base64=1`;
}

/** Serial payload from S2 §5.2: "sbx1:" + machineId + ":" + base64url(bootstrap secret). */
export function s2SerialPayload(
	machineId: string,
	bootstrapSecret: Uint8Array,
): string {
	return `sbx1:${machineId}:${Buffer.from(bootstrapSecret).toString("base64url")}`;
}

export interface MachineSize {
	cores: number;
	memoryMb: number;
}

export const DEFAULT_SIZE: MachineSize = { cores: 2, memoryMb: 2048 };

/** Hardware keys copied from the template config (spec §6.3). */
export const TEMPLATE_HW_KEYS = [
	"machine",
	"cpu",
	"bios",
	"ostype",
	"scsihw",
	"agent",
	"serial0",
	"vga",
	"tablet",
];
/**
 * Proxmox defaults to ciupgrade=1: cloud-init runs apt upgrade on first boot, which restarts
 * qemu-guest-agent (forgetting running exec PIDs), journald, networkd and more about two minutes
 * after the sandbox is ready.
 */
const NO_CI_UPGRADE = { ciupgrade: 0 };
/** Hardware recorded in snapshot metadata: the template keys plus size. Never identity. */
const SNAPSHOT_HW_KEYS = [...TEMPLATE_HW_KEYS, "cores", "memory", "balloon"];

export interface MachineInfo {
	vmid: number;
	mac: string;
	node: string;
	disks: DiskSet;
}

export interface ReadyInfo {
	pingAt: number;
	ipAt: number;
	ip: string;
	ifname: string;
}

export class QgaUnavailableError extends Error {
	constructor(vmid: number) {
		super(
			`QEMU guest agent of VM ${vmid} does not answer; snapshot refused (use crashConsistent to override)`,
		);
		this.name = "QgaUnavailableError";
	}
}

export class TracesRemainError extends Error {
	readonly vmid: number;
	readonly problems: string[];
	constructor(vmid: number, problems: string[]) {
		super(`VM ${vmid} left traces: ${problems.join("; ")}`);
		this.name = "TracesRemainError";
		this.vmid = vmid;
		this.problems = problems;
	}
}

export function pveVcpuControl(api: PveClient, node: string): VcpuControl {
	return {
		suspend: async (vmid) =>
			api.waitTask(
				node,
				await api.post<string>(`/nodes/${node}/qemu/${vmid}/status/suspend`),
			),
		resume: async (vmid) =>
			api.waitTask(
				node,
				await api.post<string>(`/nodes/${node}/qemu/${vmid}/status/resume`),
			),
	};
}

class Semaphore {
	#free: number;
	#waiters: (() => void)[] = [];
	constructor(n: number) {
		this.#free = n;
	}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#free > 0) this.#free--;
		else await new Promise<void>((r) => this.#waiters.push(r));
		try {
			return await fn();
		} finally {
			const next = this.#waiters.shift();
			if (next) next();
			else this.#free++;
		}
	}
}

function ipInSubnet(ip: string, cidr: string): boolean {
	const [net = "", bitsStr = "32"] = cidr.split("/");
	const toInt = (a: string) =>
		a.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
	const bits = Number(bitsStr);
	const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
	return (
		/^\d+\.\d+\.\d+\.\d+$/.test(ip) &&
		(toInt(ip) & mask) === (toInt(net) & mask)
	);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MachinesOptions {
	api: PveClient;
	node: NodeOps;
	driver: StorageDriver;
	allocator: Allocator;
	snapshots: SnapshotStore;
	cfg: Pick<
		Config,
		"node" | "storage" | "vnet" | "pool" | "templateVmid" | "clusterId"
	>;
	/** Concurrent create/fork per node. */
	cloneConcurrency?: number;
	/** Fill ipfilter-net0 with the IPAM address and enable ipfilter. */
	ipfilter?: boolean;
	subnet?: string;
	pollMs?: number;
}

type Source = { kind: "template" } | { kind: "snapshot"; snap: SnapshotRef };

/** Machine primitives on top of the PVE API, sbx-node and a storage driver (spec §6.3). */
export class Machines {
	readonly qga: Qga;
	/** Extra dhcp.release rounds in delete verification, reported by the bench. */
	dhcpReleaseRetries = 0;
	readonly #o: MachinesOptions;
	readonly #sem: Semaphore;
	#template:
		| Promise<{ config: Record<string, string>; ref: TemplateRef }>
		| undefined;

	constructor(opts: MachinesOptions) {
		this.#o = opts;
		this.#sem = new Semaphore(opts.cloneConcurrency ?? 4);
		this.qga = new Qga(opts.api, opts.cfg.node);
	}

	get #node(): string {
		return this.#o.cfg.node;
	}

	#vmPath(vmid: number, sub = ""): string {
		return `/nodes/${this.#node}/qemu/${vmid}${sub}`;
	}

	#templateInfo() {
		this.#template ??= this.#o.api
			.get<Record<string, string>>(
				this.#vmPath(this.#o.cfg.templateVmid, "/config"),
			)
			.then((config) => ({
				config,
				ref: {
					node: this.#node,
					vmid: this.#o.cfg.templateVmid,
					disks: parseDiskSet(config, this.#o.cfg.storage),
				},
			}))
			.catch((err: unknown) => {
				this.#template = undefined;
				throw err;
			});
		return this.#template;
	}

	create(
		opts: { size?: MachineSize; smbios?: Smbios; ownerId?: string } = {},
	): Promise<MachineInfo> {
		return this.#sem.run(() => this.#build({ kind: "template" }, opts));
	}

	fork(
		snap: SnapshotRef,
		opts: { size?: MachineSize; smbios?: Smbios; ownerId?: string } = {},
	): Promise<MachineInfo> {
		return this.#sem.run(() => this.#build({ kind: "snapshot", snap }, opts));
	}

	async #build(
		src: Source,
		opts: { size?: MachineSize; smbios?: Smbios; ownerId?: string },
	): Promise<MachineInfo> {
		const { api, allocator, driver, cfg } = this.#o;
		const hardware: Record<string, string> = {};
		let tpl: TemplateRef | undefined;
		if (src.kind === "template") {
			const t = await this.#templateInfo();
			tpl = t.ref;
			for (const k of TEMPLATE_HW_KEYS)
				if (t.config[k] !== undefined) hardware[k] = String(t.config[k]);
		} else {
			Object.assign(hardware, src.snap.hardware);
		}
		const size =
			opts.size ?? (src.kind === "snapshot" ? undefined : DEFAULT_SIZE);

		const { vmid, mac, reused } = await allocator.allocate(opts.ownerId);
		try {
			const params: Params = {
				vmid,
				name: `sbx-${vmid}`,
				pool: cfg.pool,
				...hardware,
				balloon: 0,
				net0: `virtio=${mac},bridge=${cfg.vnet},firewall=1`,
				ide2: `${cfg.storage}:cloudinit`,
				ipconfig0: "ip=dhcp",
				ciuser: "sbx",
				...NO_CI_UPGRADE,
			};
			if (size) {
				params.cores = size.cores;
				params.memory = size.memoryMb;
			}
			// Identity: the caller's smbios1 or a fresh one from Proxmox. vmgenid is always generated by Proxmox.
			if (opts.smbios) params.smbios1 = formatSmbios1(opts.smbios);
			const upid = await api.post<string>(`/nodes/${this.#node}/qemu`, params);
			await api.waitTask(this.#node, upid);

			const target = { node: this.#node, vmid };
			const disks =
				src.kind === "template" && tpl
					? await driver.cloneFromTemplate(tpl, target)
					: await driver.cloneFromSnapshot(
							(src as { snap: SnapshotRef }).snap,
							target,
						);

			const diskParams: Params = { tags: "sbx" };
			for (const d of disks) diskParams[d.slot] = formatDisk(d);
			if (disks.some((d) => d.slot === "scsi0"))
				diskParams.boot = "order=scsi0";
			await api.put(this.#vmPath(vmid, "/config"), diskParams);
			await this.#firewall(vmid, mac);
			await allocator.markActive(vmid);
			return { vmid, mac, node: this.#node, disks };
		} catch (err) {
			// A reused lease belongs to the owner's other attempt, which may have created
			// the VM (S6: a stale executor of the same machine): never delete it here.
			if (reused) throw err;
			// Roll back through delete even if the POST failed: a broken connection may hide a
			// created VM. delete() tolerates a missing VM and keeps the row in releasing on failure.
			await this.delete(vmid).catch(() => {});
			throw err;
		}
	}

	/**
	 * Baseline for the bench (spec §7.2 step 4): a linked clone through the Proxmox API (qm clone),
	 * then the same MAC, size and firewall as create.
	 */
	createViaQmClone(opts: { size?: MachineSize } = {}): Promise<MachineInfo> {
		return this.#sem.run(async () => {
			const { api, allocator, cfg } = this.#o;
			const size = opts.size ?? DEFAULT_SIZE;
			const { vmid, mac } = await allocator.allocate();
			try {
				const upid = await api.post<string>(
					this.#vmPath(cfg.templateVmid, "/clone"),
					{
						newid: vmid,
						full: 0,
						pool: cfg.pool,
						name: `sbx-${vmid}`,
					},
				);
				await api.waitTask(this.#node, upid);
				await api.put(this.#vmPath(vmid, "/config"), {
					net0: `virtio=${mac},bridge=${cfg.vnet},firewall=1`,
					cores: size.cores,
					memory: size.memoryMb,
					tags: "sbx",
					...NO_CI_UPGRADE,
				});
				await this.#firewall(vmid, mac);
				await allocator.markActive(vmid);
				const disks = parseDiskSet(await this.config(vmid), cfg.storage);
				return { vmid, mac, node: this.#node, disks };
			} catch (err) {
				await this.delete(vmid).catch(() => {});
				throw err;
			}
		});
	}

	async #ipamIp(mac: string): Promise<string | undefined> {
		const entries = await this.#o.api.get<{ mac?: string; ip?: string }[]>(
			"/cluster/sdn/ipams/pve/status",
		);
		return entries.find((e) => e.mac?.toUpperCase() === mac.toUpperCase())?.ip;
	}

	async #firewall(vmid: number, mac: string): Promise<void> {
		const { api } = this.#o;
		const ipfilter = this.#o.ipfilter ?? true;
		await api.put(this.#vmPath(vmid, "/firewall/options"), {
			enable: 1,
			policy_in: "DROP",
			policy_out: "ACCEPT",
			dhcp: 1,
			ndp: 1,
			radv: 0,
			macfilter: 1,
			ipfilter: ipfilter ? 1 : 0,
		});
		await api.post(this.#vmPath(vmid, "/firewall/rules"), {
			type: "group",
			action: "sbx-egress",
			iface: "net0",
			enable: 1,
		});
		if (ipfilter) {
			// ipfilter with an empty ipfilter-net0 drops all IPv4 but DHCP; PVE does not fill it from IPAM.
			const ip = await this.#ipamIp(mac);
			if (!ip) throw new Error(`no IPAM address for VM ${vmid} (${mac})`);
			await api.post(this.#vmPath(vmid, "/firewall/ipset"), {
				name: "ipfilter-net0",
			});
			await api.post(this.#vmPath(vmid, "/firewall/ipset/ipfilter-net0"), {
				cidr: ip,
			});
		}
	}

	async #task(vmid: number, action: string, params?: Params): Promise<void> {
		const upid = await this.#o.api.post<string>(
			this.#vmPath(vmid, `/status/${action}`),
			params,
		);
		await this.#o.api.waitTask(this.#node, upid);
	}

	start(vmid: number): Promise<void> {
		return this.#task(vmid, "start");
	}

	stop(vmid: number): Promise<void> {
		return this.#task(vmid, "stop");
	}

	shutdown(vmid: number, timeoutS = 60): Promise<void> {
		return this.#task(vmid, "shutdown", { timeout: timeoutS });
	}

	async status(vmid: number): Promise<string> {
		return (
			await this.#o.api.get<{ status: string }>(
				this.#vmPath(vmid, "/status/current"),
			)
		).status;
	}

	config(vmid: number): Promise<Record<string, string>> {
		return this.#o.api.get<Record<string, string>>(
			this.#vmPath(vmid, "/config"),
		);
	}

	/** Waits for the first QGA ping and an IPv4 address in the sandbox subnet. */
	async waitReady(
		vmid: number,
		opts: { timeoutMs?: number; startedAt?: number } = {},
	): Promise<ReadyInfo> {
		const deadline =
			(opts.startedAt ?? Date.now()) + (opts.timeoutMs ?? 180_000);
		const poll = this.#o.pollMs ?? 200;
		const subnet = this.#o.subnet ?? "10.88.0.0/24";
		while (!(await this.qga.ping(vmid))) {
			if (Date.now() > deadline)
				throw new Error(`VM ${vmid}: QGA did not answer in time`);
			await sleep(poll);
		}
		const pingAt = Date.now();
		for (;;) {
			const ifs = await this.qga.interfaces(vmid).catch(() => []);
			for (const i of ifs) {
				const a = i["ip-addresses"]?.find(
					(x) =>
						x["ip-address-type"] === "ipv4" &&
						ipInSubnet(x["ip-address"], subnet),
				);
				if (a)
					return {
						pingAt,
						ipAt: Date.now(),
						ip: a["ip-address"],
						ifname: i.name,
					};
			}
			if (Date.now() > deadline)
				throw new Error(`VM ${vmid}: no IPv4 in ${subnet} in time`);
			await sleep(poll);
		}
	}

	async snapshot(
		vmid: number,
		opts: { crashConsistent?: boolean; hook?: QuiesceHook; id?: string } = {},
	): Promise<SnapshotRef> {
		const config = await this.config(vmid);
		const running = (await this.status(vmid)) === "running";
		let hook: QuiesceHook = { freeze: async () => {}, thaw: async () => {} };
		if (opts.hook) {
			// External quiesce (S3 agent): QGA is not involved.
			hook = opts.hook;
		} else if (running && !opts.crashConsistent) {
			if (!(await this.qga.ping(vmid))) throw new QgaUnavailableError(vmid);
			hook = {
				freeze: () => this.qga.fsfreezeFreeze(vmid),
				thaw: () => this.qga.fsfreezeThaw(vmid),
			};
		}
		const ref = await this.#o.driver.snapshot(
			{
				node: this.#node,
				vmid,
				disks: parseDiskSet(config, this.#o.cfg.storage),
				running,
			},
			hook,
			opts.id !== undefined ? { id: opts.id } : undefined,
		);
		const hardware: Record<string, string> = {};
		for (const k of SNAPSHOT_HW_KEYS)
			if (config[k] !== undefined) hardware[k] = String(config[k]);
		const snap: SnapshotRef = { ...ref, hardware };
		this.#o.snapshots.putSnapshot(snap);
		return snap;
	}

	async deleteSnapshot(snap: SnapshotRef): Promise<void> {
		await this.#o.driver.delete(snap);
		const { lvs } = await this.#o.node.call<{ lvs: unknown[] }>("lv.list", {
			tags: ["sbx", `sbx-snap-${snap.id}`],
		});
		if (lvs.length > 0)
			throw new TracesRemainError(snap.sourceVmid, [
				`snapshot ${snap.id} LVs remain`,
			]);
		this.#o.snapshots.removeSnapshot(snap.id);
	}

	/** VMs visible to the token (pool sandbox). */
	async #resources(): Promise<
		{
			vmid: number;
			status: string;
			maxmem?: number;
			template?: number;
			pool?: string;
		}[]
	> {
		return this.#o.api.get("/cluster/resources", { type: "vm" });
	}

	/** VMIDs taken outside the allocator table: VMs in Proxmox and LVs vm-<id>-*. */
	async occupiedVmids(): Promise<Set<number>> {
		const ids = new Set((await this.#resources()).map((r) => r.vmid));
		const { lvs } = await this.#o.node.call<{ lvs: { name: string }[] }>(
			"lv.list",
			{},
		);
		for (const l of lvs) {
			const m = /^vm-(\d+)-/.exec(l.name);
			if (m) ids.add(Number(m[1]));
		}
		return ids;
	}

	/** Deletes a machine and frees its VMID only after verifying no traces remain (spec §6.3). */
	async delete(vmid: number): Promise<void> {
		const { api, allocator, cfg } = this.#o;
		if (vmid === cfg.templateVmid)
			throw new Error(`refusing to delete the template VM ${vmid}`);
		const lease = await allocator.get(vmid);
		const mac = lease?.mac ?? macFor(cfg.clusterId, vmid);
		if (lease) await allocator.markReleasing(vmid);

		// /cluster/resources is right about existence but its status lags by seconds; status/current is not.
		const vm = (await this.#resources()).find((r) => r.vmid === vmid);
		if (vm) {
			if ((await this.status(vmid)) !== "stopped") await this.stop(vmid);
			// Release while the IP, the ethers line and the lease still belong to this VM: once
			// destroy frees the IP in IPAM, a new VM may take it and dnsmasq moves the lease to the
			// new MAC, after which a release for our MAC finds nothing. sbx-node keeps the ethers
			// line while the MAC is in mac-cache.json; verifyGone removes it after destroy.
			await this.#o.node.call("dhcp.release", { mac });
			const upid = await api.delete<string>(this.#vmPath(vmid), {
				purge: 1,
				"destroy-unreferenced-disks": 1,
			});
			await api.waitTask(this.#node, upid);
		}
		await this.#o.driver.delete({ kind: "machine", node: this.#node, vmid });
		await this.verifyGone(vmid, mac);
		await allocator.release(vmid);
	}

	/** dhcp.leases, repeated while sbx-node finds the lease file in the middle of a rewrite. */
	async #dhcpLeases(): Promise<{
		leases: { mac: string }[];
		ethers?: { mac: string }[];
	}> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.#o.node.call("dhcp.leases");
			} catch (err) {
				if (
					attempt >= 4 ||
					!(err instanceof NodeOpsError && err.code === "busy")
				)
					throw err;
				await sleep(this.#o.pollMs ?? 200);
			}
		}
	}

	async verifyGone(vmid: number, mac: string): Promise<void> {
		const { node } = this.#o;
		const problems: string[] = [];
		if ((await this.#resources()).some((r) => r.vmid === vmid))
			problems.push("VM still listed in /cluster/resources");
		const inv = await node.call<{ vmfiles: string[] }>("inventory", {
			sections: ["vmfiles"],
		});
		for (const f of inv.vmfiles) {
			if (f.endsWith(`/${vmid}.conf`) || f.endsWith(`/${vmid}.fw`))
				problems.push(`${f} exists`);
		}
		if (await this.#ipamIp(mac)) problems.push(`IPAM still has ${mac}`);
		const { lvs } = await node.call<{ lvs: { name: string }[] }>("lv.list", {});
		for (const l of lvs)
			if (l.name.startsWith(`vm-${vmid}-`))
				problems.push(`LV ${l.name} remains`);

		const hasLease = async () => {
			const d = await this.#dhcpLeases();
			const m = mac.toLowerCase();
			return (
				d.leases.some((l) => l.mac === m) ||
				(d.ethers ?? []).some((l) => l.mac === m)
			);
		};
		// Proxmox removes neither the dnsmasq lease nor the ethers mapping on VM delete, so release
		// always, without trusting a first read. dhcp_release only sends a DHCPRELEASE packet:
		// dnsmasq rewrites its lease file shortly after, and may drop the packet (seen with
		// concurrent releases), so it is sent again. Releasing a lease that is gone does nothing.
		let left = true;
		for (let round = 0; round < 3 && left; round++) {
			if (round > 0) this.dhcpReleaseRetries++;
			await node.call("dhcp.release", { mac });
			for (let i = 0; i < 10 && left; i++) {
				left = await hasLease();
				if (left) await sleep(this.#o.pollMs ?? 200);
			}
		}
		if (left) problems.push(`DHCP lease or ethers entry for ${mac} remains`);
		if (problems.length > 0) throw new TracesRemainError(vmid, problems);
	}
}
