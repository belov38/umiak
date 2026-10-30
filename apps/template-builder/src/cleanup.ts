import type { Allocator, NodeOps, PveClient } from "@sbx/pve";
import type { FileRegistry } from "./registry.ts";
import { isProtectedVmid } from "./vmid-guard.ts";

// `sbx-tpl cleanup`: leftovers of failed builds (spec S5 section 7.1)

const BUILD_TAG = "sbx-tpl";
const STALE_BUILD_MS = 2 * 60 * 60_000;
// Seeds are raw images in local:import; .iso in local:iso is the earlier CD form.
const SEED_RE = /^sbx-seed-[a-z0-9-]+\.(?:raw|iso)$/;

export interface CleanupDeps {
	api: PveClient;
	node: NodeOps;
	allocator: Pick<Allocator, "list" | "release">;
	registry: FileRegistry;
	cfg: {
		node: string;
		pool: string;
		/** Where build VMs and template leases live (pve: 597-598). */
		templateVmidRange: { min: number; max: number };
		templateVmid: number;
	};
	now: () => Date;
}

interface VmResource {
	vmid: number;
	node?: string;
	name?: string;
	tags?: string;
	template?: number;
}

const tagsOf = (v: string | undefined) => (v ?? "").split(/[;,]/);
const errorText = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

/**
 * Deletes build VMs (tag sbx-tpl, name sbx-tpl-*, not a template) in the VMID range and not
 * protected (vmid-guard.ts), unused
 * seed images and template leases whose VM is gone, and marks builds that have been `building`
 * for more than 2 h as failed. A build still in progress keeps its VM, seed and lease.
 */
export async function cleanup(d: CleanupDeps): Promise<string[]> {
	const { api, node, cfg } = d;
	const report: string[] = [];
	const now = d.now();

	for (const m of d.registry.list()) {
		if (m.status !== "building") continue;
		if (now.getTime() - Date.parse(m.startedAt) <= STALE_BUILD_MS) continue;
		d.registry.update(m.buildId, {
			status: "failed",
			error: {
				stage: "unknown",
				message: "marked failed by cleanup: still building after 2 h",
			},
			finishedAt: now.toISOString(),
		});
		report.push(
			`build ${m.buildId} (${m.templateSlug} ${m.version}): building -> failed`,
		);
	}
	const active = d.registry.list().filter((m) => m.status === "building");
	const activeVmids = new Set(active.map((m) => m.pveVmid));
	const activeSeeds = new Set(
		active.flatMap((m) => [
			`sbx-seed-${m.buildId}.raw`,
			`sbx-seed-${m.buildId}.iso`,
		]),
	);

	const inRange = (vmid: number) =>
		vmid >= cfg.templateVmidRange.min &&
		vmid <= cfg.templateVmidRange.max &&
		vmid !== cfg.templateVmid &&
		!isProtectedVmid(vmid);
	const vms = await api.get<VmResource[]>("/cluster/resources", { type: "vm" });
	const present = new Set(vms.map((v) => v.vmid));
	const buildVms = vms.filter(
		(v) =>
			(v.node ?? cfg.node) === cfg.node &&
			inRange(v.vmid) &&
			tagsOf(v.tags).includes(BUILD_TAG),
	);

	const remaining: number[] = [];
	for (const v of buildVms) {
		const path = `/nodes/${cfg.node}/qemu/${v.vmid}`;
		try {
			// /cluster/resources lags; the config decides.
			const c = await api.get<Record<string, string>>(`${path}/config`);
			if (
				c.template === "1" ||
				!tagsOf(c.tags).includes(BUILD_TAG) ||
				!c.name?.startsWith("sbx-tpl-") ||
				activeVmids.has(v.vmid)
			) {
				remaining.push(v.vmid);
				continue;
			}
			const st = await api.get<{ status: string }>(`${path}/status/current`);
			if (st.status !== "stopped") {
				const upid = await api.post<string>(`${path}/status/stop`);
				await api.waitTask(cfg.node, upid);
			}
			const upid = await api.delete<string>(path, {
				purge: 1,
				"destroy-unreferenced-disks": 1,
			});
			await api.waitTask(cfg.node, upid, { timeoutMs: 10 * 60_000 });
			present.delete(v.vmid);
			report.push(`deleted build VM ${v.vmid} ${c.name}`);
		} catch (err) {
			remaining.push(v.vmid);
			report.push(`VM ${v.vmid}: ${errorText(err)}`);
		}
	}

	try {
		const used = new Set(activeSeeds);
		for (const vmid of remaining) {
			const c = await api.get<Record<string, string>>(
				`/nodes/${cfg.node}/qemu/${vmid}/config`,
			);
			for (const value of Object.values(c)) {
				const m = /(?:^|:)iso\/([^,]+)/.exec(String(value));
				if (m?.[1]) used.add(m[1]);
			}
		}
		const media = await node.call<{
			iso: { name: string }[];
			import: { name: string }[];
		}>("media.list");
		const unused = [...media.iso, ...media.import]
			.map((f) => f.name)
			.filter((n) => SEED_RE.test(n) && !used.has(n));
		if (unused.length > 0) {
			await node.call("media.remove", { names: unused });
			report.push(`removed ${unused.join(", ")}`);
		}
	} catch (err) {
		report.push(`seed images: ${errorText(err)}`);
	}

	for (const l of await d.allocator.list()) {
		if (l.purpose !== "template" || !inRange(l.vmid)) continue;
		if (present.has(l.vmid) || activeVmids.has(l.vmid)) continue;
		try {
			await d.allocator.release(l.vmid);
			await node.call("dhcp.release", { mac: l.mac });
			report.push(`released template lease ${l.vmid}`);
		} catch (err) {
			report.push(`lease ${l.vmid}: ${errorText(err)}`);
		}
	}
	return report;
}
