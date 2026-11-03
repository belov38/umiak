import { readFileSync } from "node:fs";
import type { Allocator, NodeOps, PveClient } from "@umiak/pve";
import { parse as parseYaml } from "yaml";
import type { FileRegistry } from "./registry.ts";
import { isProtectedVmid } from "./vmid-guard.ts";

// `umiak-tpl retire <buildId> [--delete-vm] [--force] [--force-poc]`: a ready build that is no
// longer used. The registry marks it `retired`; with --delete-vm its template VM goes too, with
// the VMID lease. A build the worker config uses, or the newest ready build of its template,
// stays unless --force; retained retired/headless Windows builds require --force for VM
// deletion. A build in the PoC slot (599) stays unless --force-poc.

const BUILD_TAG = "umiak-tpl";

/** A template build the worker config registers (`topology.templateBuilds`). */
export interface ConfiguredBuild {
	templateSlug: string;
	version: string;
	node?: string;
	pveVmid?: number;
}

export interface RetireDeps {
	api: PveClient;
	node: NodeOps;
	allocator: Pick<Allocator, "list" | "release">;
	registry: FileRegistry;
	cfg: {
		node: string;
		/** Template slot bounds; dev recipes use 595/596/597/598. */
		templateVmidRange: { min: number; max: number };
		/** The PoC template (pve: 599). */
		templateVmid: number;
	};
	/** Builds of the worker config, and where they come from (for the messages). */
	configured: { file: string; builds: ConfiguredBuild[] };
	now: () => Date;
}

export interface RetireOptions {
	deleteVm: boolean;
	/** Override configured/newest/headless guards and acknowledge a retired build. */
	force?: boolean;
	/** Retire a build in the PoC slot. */
	forcePoc?: boolean;
}

const tagsOf = (v: string | undefined) => (v ?? "").split(/[;,]/);

/** `topology.templateBuilds` of a worker YAML config (UMIAK_CONFIG_FILE). */
export function configuredBuilds(file: string): ConfiguredBuild[] {
	const doc = parseYaml(readFileSync(file, "utf8")) as {
		topology?: { templateBuilds?: unknown };
	} | null;
	const list = doc?.topology?.templateBuilds ?? [];
	if (!Array.isArray(list))
		throw new Error(`${file}: topology.templateBuilds is not a list`);
	return list.map((b, i) => {
		const r = b as Record<string, unknown>;
		if (typeof r.templateSlug !== "string" || r.version === undefined)
			throw new Error(
				`${file}: topology.templateBuilds[${i}] lacks templateSlug or version`,
			);
		return {
			templateSlug: r.templateSlug,
			version: String(r.version),
			...(typeof r.node === "string" ? { node: r.node } : {}),
			...(typeof r.pveVmid === "number" ? { pveVmid: r.pveVmid } : {}),
		};
	});
}

/**
 * Marks a ready build retired. Its template VM (the VMID of the manifest, a template tagged
 * umiak-tpl with the build's VM name) blocks that unless `deleteVm` is set; then the VM is deleted
 * and its template lease released. A VMID that is gone or now holds another build is left alone.
 * Every refusal comes before the first change.
 */
export async function retire(
	d: RetireDeps,
	buildId: string,
	opts: RetireOptions,
): Promise<string[]> {
	const m = d.registry.get(buildId);
	if (!m) throw new Error(`build ${buildId} not found in ${d.registry.dir}`);
	if (m.status === "retired") {
		if (opts.deleteVm && !opts.force)
			throw new Error(
				`build ${buildId} is retired; --delete-vm requires --force`,
			);
		return [`build ${buildId} is already retired`];
	}
	if (m.status !== "ready")
		throw new Error(
			`build ${buildId} is ${m.status}: only a ready build is retired (umiak-tpl cleanup removes failed ones)`,
		);
	// A retired catalog build can still be ready in this local registry. Its saved artifact
	// metadata identifies legacy headless Windows images regardless of their VMID or version.
	if (
		opts.deleteVm &&
		!opts.force &&
		m.os === "windows" &&
		m.desktop === undefined
	)
		throw new Error(
			`build ${buildId} is a legacy headless Windows build; --force allows deleting its retained VM`,
		);
	const vmid = m.pveVmid;
	if (vmid !== null && vmid === d.cfg.templateVmid && !opts.forcePoc)
		throw new Error(
			`build ${buildId} is in the PoC template slot ${vmid}; --force-poc retires it`,
		);

	let ours = false;
	let present = false;
	let name: string | undefined;
	if (vmid !== null) {
		const vms = await d.api.get<{ vmid: number; node?: string }[]>(
			"/cluster/resources",
			{ type: "vm" },
		);
		present = vms.some((v) => v.vmid === vmid && (v.node ?? m.node) === m.node);
		// /cluster/resources lags; the config decides.
		const c = present
			? await d.api.get<Record<string, string>>(
					`/nodes/${m.node}/qemu/${vmid}/config`,
				)
			: undefined;
		name = c?.name;
		ours =
			c !== undefined &&
			// A JSON number in the Proxmox API.
			Number(c.template) === 1 &&
			tagsOf(c.tags).includes(BUILD_TAG) &&
			c.name === m.vmName;
	}

	if (!opts.force) {
		// The config names a build by version; its VMID counts only while the VM is this build's.
		const used = d.configured.builds.find(
			(b) =>
				b.templateSlug === m.templateSlug &&
				(b.version === m.version ||
					(ours && b.pveVmid === vmid && (b.node ?? m.node) === m.node)),
		);
		if (used)
			throw new Error(
				`build ${buildId} (${m.templateSlug} ${m.version}, VM ${vmid ?? "-"}) is in ${d.configured.file} (topology.templateBuilds ${used.version}); switch the config first, or --force`,
			);
		const newest = d.registry
			.list(m.templateSlug)
			.filter((b) => b.status === "ready")
			.at(-1);
		if (newest?.buildId === buildId)
			throw new Error(
				`build ${buildId} is the newest ready ${m.templateSlug} build; build and verify its successor first, or --force`,
			);
	}

	const report: string[] = [];
	if (vmid !== null && !ours) {
		report.push(
			`VM ${vmid}: ${present ? `holds ${name ?? "another guest"}, not this build` : "gone"}; left alone`,
		);
	} else if (vmid !== null && !opts.deleteVm) {
		throw new Error(
			`template VM ${vmid} (${m.vmName}) of build ${buildId} still exists; --delete-vm deletes it`,
		);
	} else if (vmid !== null) {
		const r = d.cfg.templateVmidRange;
		const poc = vmid === d.cfg.templateVmid && opts.forcePoc === true;
		if (
			vmid < r.min ||
			vmid > r.max ||
			(!poc && (vmid === d.cfg.templateVmid || isProtectedVmid(vmid)))
		)
			throw new Error(`VM ${vmid} is not a template slot of umiak-tpl`);
		const upid = await d.api.delete<string>(`/nodes/${m.node}/qemu/${vmid}`, {
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
	d.registry.update(buildId, {
		status: "retired",
		retiredAt: d.now().toISOString(),
	});
	report.push(`build ${buildId} (${m.templateSlug} ${m.version}): retired`);
	return report;
}
