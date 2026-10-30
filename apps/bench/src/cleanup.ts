import {
	type Ctx,
	isTemplateVm,
	templateMacs,
	type VmResource,
} from "./context.ts";

/** Removes everything a failed run may have left (spec §7.1). Never touches the template or sbx-tpl LVs. */
export async function cleanup(ctx: Ctx): Promise<string[]> {
	const { api, node, cfg, store, machines } = ctx;
	const report: string[] = [];
	const vms = await api.get<VmResource[]>("/cluster/resources", {
		type: "vm",
	});
	for (const v of vms.filter(
		(x) =>
			x.pool === cfg.pool && x.vmid !== cfg.templateVmid && !isTemplateVm(x),
	)) {
		try {
			await machines.delete(v.vmid);
			report.push(`deleted VM ${v.vmid}`);
		} catch (err) {
			report.push(`VM ${v.vmid}: ${(err as Error).message}`);
		}
	}
	try {
		const { lvs } = await node.call<{
			lvs: { name: string; tags: string[] }[];
		}>("lv.list", { tags: ["sbx"] });
		const ours = lvs
			.filter((l) => !l.tags.includes("sbx-tpl"))
			.map((l) => l.name);
		if (ours.length > 0) {
			await node.call("lv.remove", { names: ours });
			report.push(`removed LVs ${ours.join(",")}`);
		}
	} catch (err) {
		report.push(`LVs: ${(err as Error).message}`);
	}
	const tpl = templateMacs(ctx);
	const prefix = `02:${cfg.clusterId.toString(16).padStart(2, "0")}:`;
	const d = await node.call<{
		leases: { mac: string }[];
		ethers: { mac: string }[];
	}>("dhcp.leases");
	for (const mac of new Set([...d.leases, ...d.ethers].map((l) => l.mac))) {
		if (!mac.startsWith(prefix) || tpl.has(mac)) continue;
		try {
			await node.call("dhcp.release", { mac });
			report.push(`released DHCP ${mac}`);
		} catch (err) {
			report.push(`DHCP ${mac}: ${(err as Error).message}`);
		}
	}
	// A VMID and MAC are freed only when nothing of the machine is left (spec §6.3).
	for (const row of store.list(cfg.clusterId)) {
		if (row.purpose === "template") continue;
		try {
			await machines.verifyGone(row.vmid, row.mac);
			store.remove(cfg.clusterId, row.vmid);
			report.push(`dropped allocator row ${row.vmid} (${row.state})`);
		} catch (err) {
			report.push(`kept allocator row ${row.vmid}: ${(err as Error).message}`);
		}
	}
	for (const s of store.listSnapshots()) {
		store.removeSnapshot(s.id);
		report.push(`dropped snapshot record ${s.id}`);
	}
	return report;
}
