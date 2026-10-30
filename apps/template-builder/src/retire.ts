import type { Allocator, NodeOps, PveClient } from "@sbx/pve";
import type { FileRegistry } from "./registry.ts";
import { isProtectedVmid } from "./vmid-guard.ts";

// `sbx-tpl retire <buildId> [--delete-vm]`: a ready build that is no longer used. The registry
// marks it `retired`; with --delete-vm its template VM goes too, with the VMID lease.

const BUILD_TAG = "sbx-tpl";

export interface RetireDeps {
	api: PveClient;
	node: NodeOps;
	allocator: Pick<Allocator, "list" | "release">;
	registry: FileRegistry;
	cfg: {
		node: string;
		/** Template slots sbx-tpl owns (pve: 597-598). */
		templateVmidRange: { min: number; max: number };
		templateVmid: number;
	};
	now: () => Date;
}

const tagsOf = (v: string | undefined) => (v ?? "").split(/[;,]/);

/**
 * Marks a ready build retired. Its template VM (the VMID of the manifest, a template tagged
 * sbx-tpl with the build's VM name) blocks that unless `deleteVm` is set; then the VM is deleted
 * and its template lease released. A VMID that is gone or now holds another build is left alone.
 */
export async function retire(
	d: RetireDeps,
	buildId: string,
	opts: { deleteVm: boolean },
): Promise<string[]> {
	const m = d.registry.get(buildId);
	if (!m) throw new Error(`build ${buildId} not found in ${d.registry.dir}`);
	if (m.status === "retired") return [`build ${buildId} is already retired`];
	if (m.status !== "ready")
		throw new Error(
			`build ${buildId} is ${m.status}: only a ready build is retired (sbx-tpl cleanup removes failed ones)`,
		);
	const report: string[] = [];
	const vmid = m.pveVmid;
	if (vmid !== null) {
		const path = `/nodes/${m.node}/qemu/${vmid}`;
		const vms = await d.api.get<{ vmid: number; node?: string }[]>(
			"/cluster/resources",
			{ type: "vm" },
		);
		const present = vms.some(
			(v) => v.vmid === vmid && (v.node ?? m.node) === m.node,
		);
		// /cluster/resources lags; the config decides.
		const c = present
			? await d.api.get<Record<string, string>>(`${path}/config`)
			: undefined;
		const ours =
			c !== undefined &&
			// A JSON number in the Proxmox API.
			Number(c.template) === 1 &&
			tagsOf(c.tags).includes(BUILD_TAG) &&
			c.name === m.vmName;
		if (!ours) {
			report.push(
				`VM ${vmid}: ${present ? `holds ${c?.name ?? "another guest"}, not this build` : "gone"}; left alone`,
			);
		} else if (!opts.deleteVm) {
			throw new Error(
				`template VM ${vmid} (${m.vmName}) of build ${buildId} still exists; --delete-vm deletes it (check that no config uses it, e.g. deploy/compose/config/sbx.yaml)`,
			);
		} else {
			const r = d.cfg.templateVmidRange;
			if (
				vmid < r.min ||
				vmid > r.max ||
				vmid === d.cfg.templateVmid ||
				isProtectedVmid(vmid)
			)
				throw new Error(`VM ${vmid} is not a template slot of sbx-tpl`);
			const upid = await d.api.delete<string>(path, {
				purge: 1,
				"destroy-unreferenced-disks": 1,
			});
			await d.api.waitTask(m.node, upid, { timeoutMs: 10 * 60_000 });
			report.push(`deleted template VM ${vmid} ${m.vmName}`);
			const lease = (await d.allocator.list()).find(
				(l) => l.vmid === vmid && l.purpose === "template",
			);
			// The VM is gone: a lease failure is reported and does not keep the build ready.
			if (lease) {
				try {
					await d.allocator.release(vmid);
					await d.node.call("dhcp.release", { mac: lease.mac });
					report.push(`released template lease ${vmid}`);
				} catch (err) {
					report.push(
						`lease ${vmid}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	}
	d.registry.update(buildId, {
		status: "retired",
		retiredAt: d.now().toISOString(),
	});
	report.push(`build ${buildId} (${m.templateSlug} ${m.version}): retired`);
	return report;
}
