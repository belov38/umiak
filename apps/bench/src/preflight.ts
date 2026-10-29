import { macFor } from "@sbx/pve";
import { type Check, check } from "./checks.ts";
import type { Ctx } from "./context.ts";

interface Inventory {
	sysctl: Record<string, string>;
	sbx0: { linkLocal: string | null };
	journalReaders: Record<string, string[]>;
}

/** Read-only checks before a run (spec §7.1). */
export async function preflight(
	ctx: Ctx,
): Promise<{ checks: Check[]; inventory?: Inventory }> {
	const { api, node, cfg, store } = ctx;
	const checks: Check[] = [];
	let inv: Inventory | undefined;

	checks.push(
		await check("sbx-node answers with the expected config", async () => {
			const v = await node.call<{
				version: string;
				config: { vmidMin: number; vmidMax: number; templateVmid: number };
			}>("version");
			const ok =
				v.config.templateVmid === cfg.templateVmid &&
				v.config.vmidMin <= cfg.vmidRange.min &&
				v.config.vmidMax >= cfg.vmidRange.max;
			return { ok, detail: `sbx-node ${v.version}` };
		}),
	);
	checks.push(
		await check("node journal readable only by root and adm", async () => {
			inv = await node.call<Inventory>("inventory", {
				sections: ["sysctl", "sbx0", "journalReaders"],
			});
			const members = Object.entries(inv.journalReaders).filter(
				([, m]) => m.length > 0,
			);
			return {
				ok: members.length === 0,
				detail: JSON.stringify(inv.journalReaders),
			};
		}),
	);
	checks.push(
		await check(
			"net.ipv4.ip_forward = 1",
			async () => inv?.sysctl["net.ipv4.ip_forward"] === "1",
		),
	);
	checks.push(
		await check(
			"net.ipv6.conf.all.forwarding = 0",
			async () => inv?.sysctl["net.ipv6.conf.all.forwarding"] === "0",
		),
	);
	checks.push(
		await check("host link-local address on sbx0 known", async () => ({
			ok: !!inv?.sbx0.linkLocal,
			detail: inv?.sbx0.linkLocal ?? "",
		})),
	);

	checks.push(
		await check("token: GET /version", async () => {
			const v = await api.get<{ version: string }>("/version");
			return { ok: true, detail: v.version };
		}),
	);
	checks.push(
		await check(
			`token: pool ${cfg.pool}`,
			async () => !!(await api.get(`/pools/${cfg.pool}`)),
		),
	);
	checks.push(
		await check(`token: VNet ${cfg.vnet} exists`, async () => {
			const vnets =
				await api.get<{ vnet: string; "isolate-ports"?: number }[]>(
					"/cluster/sdn/vnets",
				);
			const v = vnets.find((x) => x.vnet === cfg.vnet);
			return {
				ok: !!v && v["isolate-ports"] === 1,
				detail: JSON.stringify(v ?? null),
			};
		}),
	);
	checks.push(
		await check("token: firewall group sbx-egress exists", async () => {
			const groups = await api.get<{ group: string }[]>(
				"/cluster/firewall/groups",
			);
			return groups.some((g) => g.group === "sbx-egress");
		}),
	);
	checks.push(
		await check("token: IPAM readable", async () =>
			Array.isArray(await api.get("/cluster/sdn/ipams/pve/status")),
		),
	);
	checks.push(
		await check(
			`token: storage ${cfg.storage} status`,
			async () =>
				!!(await api.get(`/nodes/${cfg.node}/storage/${cfg.storage}/status`)),
		),
	);
	checks.push(
		await check(
			`template ${cfg.templateVmid} exists and is a template`,
			async () => {
				const c = await api.get<Record<string, unknown>>(
					`/nodes/${cfg.node}/qemu/${cfg.templateVmid}/config`,
				);
				return { ok: Number(c.template) === 1, detail: String(c.name) };
			},
		),
	);
	checks.push(
		await check("thin pool below thresholds, autoextend off", async () => {
			const u = await node.call<{
				dataPercent: number;
				metadataPercent: number;
				autoextendThreshold: number;
			}>("pool.usage");
			return {
				ok:
					u.dataPercent <= 80 &&
					u.metadataPercent <= 70 &&
					u.autoextendThreshold === 100,
				detail: `data ${u.dataPercent}% meta ${u.metadataPercent}% autoextend ${u.autoextendThreshold}`,
			};
		}),
	);

	checks.push(
		await check("no leftover VMs in the pool", async () => {
			const vms = await api.get<{ vmid: number; pool?: string }[]>(
				"/cluster/resources",
				{ type: "vm" },
			);
			const left = vms
				.filter((v) => v.pool === cfg.pool && v.vmid !== cfg.templateVmid)
				.map((v) => v.vmid);
			return { ok: left.length === 0, detail: left.join(",") };
		}),
	);
	checks.push(
		await check("no leftover LVs tagged sbx", async () => {
			const { lvs } = await node.call<{ lvs: { name: string }[] }>("lv.list", {
				tags: ["sbx"],
			});
			return { ok: lvs.length === 0, detail: lvs.map((l) => l.name).join(",") };
		}),
	);
	checks.push(
		await check("no leftover allocator rows or snapshots", async () => {
			const rows = store
				.list(cfg.clusterId)
				.filter((l) => l.purpose !== "template");
			const snaps = store.listSnapshots();
			return {
				ok: rows.length === 0 && snaps.length === 0,
				detail: `rows ${rows.map((r) => r.vmid).join(",")} snapshots ${snaps.length}`,
			};
		}),
	);
	checks.push(
		await check(
			"no leftover DHCP leases or ethers entries of our MACs",
			async () => {
				const tpl = macFor(cfg.clusterId, cfg.templateVmid).toLowerCase();
				const d = await node.call<{
					leases: { mac: string }[];
					ethers: { mac: string }[];
				}>("dhcp.leases");
				const ours = [...d.leases, ...d.ethers]
					.map((l) => l.mac)
					.filter(
						(m) =>
							m.startsWith(
								`02:${cfg.clusterId.toString(16).padStart(2, "0")}:`,
							) && m !== tpl,
					);
				return { ok: ours.length === 0, detail: ours.join(",") };
			},
		),
	);
	return inv ? { checks, inventory: inv } : { checks };
}
