import type { NodeOps } from "../src/node-client.ts";
import { NodeOpsError } from "../src/node-client.ts";
import { PveApiError } from "../src/pve-api.ts";

export interface Call {
	op: string;
	args: Record<string, unknown>;
}

type Handler = (args: Record<string, unknown>) => unknown;

/** In-memory sbx-node: a list of LVs with tags plus a call log. */
export class FakeNode implements NodeOps {
	calls: Call[] = [];
	log: string[];
	lvs: { name: string; tags: string[] }[] = [];
	usage = {
		dataPercent: 10,
		metadataPercent: 5,
		ourLvCount: 0,
		ourLvUsedBytes: 0,
		autoextendThreshold: 100,
	};
	leases: { mac: string; ip: string }[] = [];
	ethers: { mac: string; ip: string }[] = [];
	vmfiles: string[] = [];
	fail: Record<string, Error> = {};
	handlers: Record<string, Handler> = {};

	constructor(log: string[] = []) {
		this.log = log;
	}

	async call<T>(op: string, args: object = {}): Promise<T> {
		const a = args as Record<string, unknown>;
		this.calls.push({ op, args: a });
		this.log.push(`node:${op}`);
		const f = this.fail[op];
		if (f) throw f;
		const h = this.handlers[op];
		if (h) return h(a) as T;
		switch (op) {
			case "pool.usage":
				return this.usage as T;
			case "lv.snapshot": {
				const items = a.items as { name: string; tags: string[] }[];
				for (const it of items) this.lvs.push({ name: it.name, tags: it.tags });
				return { created: items.map((i) => i.name) } as T;
			}
			case "lv.list": {
				const tags = (a.tags as string[] | undefined) ?? [];
				return {
					lvs: this.lvs.filter((l) => tags.every((t) => l.tags.includes(t))),
				} as T;
			}
			case "lv.remove": {
				const names = a.names as string[];
				this.lvs = this.lvs.filter((l) => !names.includes(l.name));
				return { removed: names, missing: [] } as T;
			}
			case "dhcp.leases":
				return { leases: this.leases, ethers: this.ethers } as T;
			case "dhcp.release": {
				const mac = String(a.mac).toLowerCase();
				this.leases = this.leases.filter((l) => l.mac !== mac);
				this.ethers = this.ethers.filter((l) => l.mac !== mac);
				return { released: true } as T;
			}
			case "inventory":
				return { vmfiles: this.vmfiles } as T;
			default:
				throw new NodeOpsError(op, "bad_request", "unknown op in fake");
		}
	}

	close(): void {}

	ops(): string[] {
		return this.calls.map((c) => c.op);
	}
}

/** Manually advanced clock. */
export class FakeClock {
	t = 1_000_000;
	now = () => this.t;
	advance(ms: number) {
		this.t += ms;
	}
}

export interface FakeVm {
	config: Record<string, string>;
	/** Node /cluster/resources reports; the fake's own node when unset. */
	node?: string;
	status: "stopped" | "running" | "paused";
	firewall: {
		options?: Record<string, unknown>;
		rules: Record<string, unknown>[];
		ipsets: Record<string, string[]>;
	};
}

export const TEMPLATE_CONFIG: Record<string, string> = {
	agent: "enabled=1,fstrim_cloned_disks=1",
	balloon: "0",
	boot: "order=scsi0",
	ciuser: "sbx",
	cores: "2",
	cpu: "host",
	description: "template",
	ide2: "local-lvm:vm-599-cloudinit,media=cdrom",
	ipconfig0: "ip=dhcp",
	machine: "q35",
	memory: "2048",
	name: "sbx-ubuntu-poc",
	net0: "virtio=02:01:00:00:02:57,bridge=sbx0,firewall=1",
	ostype: "l26",
	rng0: "source=/dev/urandom",
	scsi0: "local-lvm:base-599-disk-0,discard=on,iothread=1,size=40G,ssd=1",
	scsihw: "virtio-scsi-single",
	serial0: "socket",
	smbios1: "uuid=c21a67ce-9d7e-4f1f-a375-2a2f09354836",
	sshkeys: "ssh-ed25519%20AAAA",
	tags: "sbx-tpl",
	template: "1",
	vga: "std",
	vmgenid: "9284e86e-d1f5-4d93-b063-5ebf6c414d42",
};

type P = Record<string, unknown> | undefined;

/** In-memory Proxmox API for one node ("pve" by default) with pool "sandbox". */
export class FakePve {
	/** Node name in /nodes/<node>/... paths. */
	readonly node: string;
	calls: { method: string; path: string; params: P }[] = [];
	log: string[];
	vms = new Map<number, FakeVm>();
	ipam: { vmid: number; mac: string; ip: string }[] = [];
	agentUp = true;
	/** Config GET /qemu/599/config returns; tests replace it to model other templates. */
	templateConfig: Record<string, string> = { ...TEMPLATE_CONFIG };
	fail: Record<string, Error> = {};
	keepIpamOnDelete = false;
	/** Status /cluster/resources reports instead of the real one: pvestatd lags by seconds. */
	staleStatus = new Map<number, string>();
	#nextIp = 101;
	#upid = 0;
	#generated = 0;

	constructor(log: string[] = [], opts: { node?: string } = {}) {
		this.log = log;
		this.node = opts.node ?? "pve";
	}

	#vm(path: string): [number, FakeVm] {
		const id = Number(/\/qemu\/(\d+)/.exec(path)?.[1]);
		const vm = this.vms.get(id);
		if (!vm)
			throw new PveApiError(
				403,
				`Permission check failed (/vms/${id}, VM.Audit)`,
			);
		return [id, vm];
	}

	#task(): string {
		return `UPID:pve:${++this.#upid}`;
	}

	async #handle(method: string, path: string, params: P): Promise<unknown> {
		const p = (params ?? {}) as Record<string, string | number | string[]>;
		const key = `${method} ${path}`;
		const n = `/nodes/${this.node}`;
		this.calls.push({ method, path, params });
		this.log.push(`api:${key}`);
		const f = this.fail[key];
		if (f) throw f;
		if (key === `GET ${n}/qemu/599/config`) return { ...this.templateConfig };
		if (key === `POST ${n}/qemu`) {
			const vmid = Number(p.vmid);
			if (this.vms.has(vmid)) {
				throw new PveApiError(
					500,
					`unable to create VM ${vmid} - config file already exists`,
				);
			}
			const config: Record<string, string> = {};
			for (const [k, v] of Object.entries(p))
				if (k !== "vmid" && k !== "pool") config[k] = String(v);
			this.#generated++;
			config.vmgenid = `gen-${this.#generated}`;
			if (!config.smbios1) config.smbios1 = `uuid=auto-${this.#generated}`;
			this.vms.set(vmid, {
				config,
				status: "stopped",
				firewall: { rules: [], ipsets: {} },
			});
			const mac = /virtio=([0-9A-F:]+)/i.exec(String(p.net0))?.[1] ?? "";
			this.ipam.push({ vmid, mac, ip: `10.88.0.${this.#nextIp++}` });
			return this.#task();
		}
		if (key === `POST ${n}/qemu/599/clone`) {
			const vmid = Number(p.newid);
			const config: Record<string, string> = {
				...TEMPLATE_CONFIG,
				name: String(p.name),
			};
			delete config.template;
			config.scsi0 = `local-lvm:vm-${vmid}-disk-0,discard=on,iothread=1,size=40G,ssd=1`;
			config.net0 = "virtio=BC:24:11:00:00:01,bridge=sbx0,firewall=1";
			config.vmgenid = `gen-clone-${vmid}`;
			this.vms.set(vmid, {
				config,
				status: "stopped",
				firewall: { rules: [], ipsets: {} },
			});
			this.ipam.push({
				vmid,
				mac: "BC:24:11:00:00:01",
				ip: `10.88.0.${this.#nextIp++}`,
			});
			return this.#task();
		}
		if (key === "GET /cluster/sdn/ipams/pve/status") {
			return this.ipam.map((e) => ({
				vmid: e.vmid,
				mac: e.mac,
				ip: e.ip,
				vnet: "sbx0",
			}));
		}
		if (key === "GET /cluster/resources") {
			return [...this.vms.entries()].map(([vmid, vm]) => ({
				vmid,
				type: "qemu",
				node: vm.node ?? this.node,
				name: vm.config.name,
				...(vm.config.tags !== undefined ? { tags: vm.config.tags } : {}),
				status:
					this.staleStatus.get(vmid) ??
					(vm.status === "paused" ? "running" : vm.status),
				pool: "sandbox",
				maxmem: Number(vm.config.memory ?? 0) * 1024 * 1024,
				template: vm.config.template === "1" ? 1 : 0,
			}));
		}
		let m = /^(GET|PUT|POST|DELETE) \/nodes\/([^/]+)\/qemu\/(\d+)(\/.*)?$/.exec(
			key,
		);
		if (m && m[2] !== this.node) m = null;
		if (!m) throw new Error(`fake: unhandled ${key}`);
		const sub = m[4] ?? "";
		if (method === "DELETE" && sub === "") {
			const [id, vm] = this.#vm(path);
			if (vm.status !== "stopped")
				throw new PveApiError(500, `VM ${id} is running - destroy failed`);
			this.vms.delete(id);
			if (!this.keepIpamOnDelete)
				this.ipam = this.ipam.filter((e) => e.vmid !== id);
			return this.#task();
		}
		const [, vm] = this.#vm(path);
		switch (`${method} ${sub}`) {
			case "GET /config":
				return { ...vm.config };
			case "PUT /config": {
				const id = Number(/\/qemu\/(\d+)/.exec(path)?.[1]);
				for (const [k, v] of Object.entries(p)) {
					// "<storage>:<size GiB>,opts" asks Proxmox to allocate a new volume.
					const alloc = /^([^:,]+):\d+(,.*)?$/.exec(String(v));
					if (k === "tpmstate0" && alloc) {
						const used = new Set(
							[
								...Object.values(vm.config)
									.join(" ")
									.matchAll(new RegExp(`vm-${id}-disk-(\\d+)`, "g")),
							].map((m) => Number(m[1])),
						);
						let n = 0;
						while (used.has(n)) n++;
						vm.config[k] =
							`${alloc[1]}:vm-${id}-disk-${n},size=4M${alloc[2] ?? ""}`;
					} else vm.config[k] = String(v);
				}
				const mac = /virtio=([0-9A-F:]+)/i.exec(String(p.net0 ?? ""))?.[1];
				const entry = this.ipam.find(
					(e) => e.vmid === Number(/\/qemu\/(\d+)/.exec(path)?.[1]),
				);
				if (mac && entry) entry.mac = mac;
				return null;
			}
			case "GET /status/current":
				return {
					status: vm.status === "paused" ? "running" : vm.status,
					qmpstatus: vm.status,
					maxmem: Number(vm.config.memory ?? 0) * 1024 * 1024,
				};
			case "POST /status/start":
				vm.status = "running";
				return this.#task();
			case "POST /status/stop":
			case "POST /status/shutdown":
				vm.status = "stopped";
				return this.#task();
			case "POST /status/suspend":
				vm.status = "paused";
				return this.#task();
			case "POST /status/resume":
				vm.status = "running";
				return this.#task();
			case "PUT /sendkey":
				return null;
			case "PUT /firewall/options":
				vm.firewall.options = { ...p };
				return null;
			case "POST /firewall/rules":
				vm.firewall.rules.push({ ...p });
				return null;
			case "POST /firewall/ipset":
				vm.firewall.ipsets[String(p.name)] = [];
				return null;
		}
		m = /^POST \/firewall\/ipset\/([\w-]+)$/.exec(`${method} ${sub}`);
		if (m?.[1]) {
			vm.firewall.ipsets[m[1]]?.push(String(p.cidr));
			return null;
		}
		if (sub.startsWith("/agent/")) {
			if (!this.agentUp || vm.status !== "running")
				throw new PveApiError(500, "QEMU guest agent is not running");
			if (sub === "/agent/network-get-interfaces") {
				const mac =
					/virtio=([0-9A-F:]+)/i.exec(vm.config.net0 ?? "")?.[1] ?? "";
				const ip = this.ipam.find((e) => e.mac === mac)?.ip ?? "";
				return {
					result: [
						{
							name: "lo",
							"ip-addresses": [
								{
									"ip-address-type": "ipv4",
									"ip-address": "127.0.0.1",
									prefix: 8,
								},
							],
						},
						{
							name: "ens18",
							"hardware-address": mac.toLowerCase(),
							"ip-addresses": [
								{ "ip-address-type": "ipv4", "ip-address": ip, prefix: 24 },
							],
						},
					],
				};
			}
			if (sub === "/agent/exec") return { pid: 42 };
			if (sub === "/agent/exec-status")
				return { exited: 1, exitcode: 0, "out-data": "ok\n" };
			return { result: {} };
		}
		throw new Error(`fake: unhandled ${key}`);
	}

	get<T>(path: string, params?: P) {
		return this.#handle("GET", path, params) as Promise<T>;
	}
	post<T>(path: string, params?: P) {
		return this.#handle("POST", path, params) as Promise<T>;
	}
	put<T>(path: string, params?: P) {
		return this.#handle("PUT", path, params) as Promise<T>;
	}
	delete<T>(path: string, params?: P) {
		return this.#handle("DELETE", path, params) as Promise<T>;
	}
	async waitTask(_node: string, upid: string): Promise<void> {
		this.log.push(`api:wait ${upid}`);
		const f = this.fail[`wait ${upid}`];
		if (f) throw f;
	}

	paths(): string[] {
		return this.calls.map((c) => `${c.method} ${c.path}`);
	}
}
