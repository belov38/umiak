import type { NodeOps } from "./node-client.ts";
import type { PveClient } from "./pve-api.ts";
import { fullVolumeCopy } from "./storage/full-copy.ts";
import type { TransferProgress } from "./storage/transfer.ts";

export interface TemplateReplicaInput {
	api: PveClient;
	source: NodeOps;
	target: NodeOps;
	sourceNode: string;
	targetNode: string;
	sourceStorage: string;
	targetStorage: string;
	sourceVmid: number;
	targetVmid: number;
	id: string;
	progress?: Record<string, number>;
	checkpoint: (slot: string, progress: TransferProgress) => Promise<void>;
}
const HW = [
	"machine",
	"cpu",
	"bios",
	"ostype",
	"scsihw",
	"agent",
	"serial0",
	"vga",
	"tablet",
	"localtime",
	"rng0",
	"boot",
];

/** Idempotent unpublished staging -> tagged template. The caller owns the VMID lease. */
export async function replicateTemplate(
	p: TemplateReplicaInput,
): Promise<
	Record<string, { sha256: string; sizeBytes: number; algorithm: string }>
> {
	if (
		!/^[a-f0-9]{32}$/.test(p.id) ||
		p.sourceVmid === p.targetVmid ||
		p.sourceNode === p.targetNode
	)
		throw new Error("invalid template replica identity");
	const path = `/nodes/${p.targetNode}/qemu/${p.targetVmid}`;
	const src = await p.api.get<Record<string, string | number>>(
		`/nodes/${p.sourceNode}/qemu/${p.sourceVmid}/config`,
	);
	if (
		Number(src.template) !== 1 ||
		!String(src.tags ?? "")
			.split(/[;, ]/)
			.includes("umiak-tpl")
	)
		throw new Error("source is not an Umiak template");
	const proof = `umiak-copy-${p.id}`;
	const vms = await p.api.get<{ vmid: number }[]>(
		`/nodes/${p.targetNode}/qemu`,
	);
	if (!vms.some((v) => Number(v.vmid) === p.targetVmid)) {
		const hw: Record<string, string | number> = {};
		for (const key of HW) if (src[key] !== undefined) hw[key] = src[key];
		const task = await p.api.post<string>(`/nodes/${p.targetNode}/qemu`, {
			...hw,
			vmid: p.targetVmid,
			name: `umiak-replica-${p.id}`,
			memory: 512,
			cores: 1,
			pool: "umiak",
		});
		if (task) await p.api.waitTask(p.targetNode, task);
	}
	let cfg = await p.api.get<Record<string, string | number>>(`${path}/config`);
	const tagged = String(cfg.tags ?? "")
		.split(/[;, ]/)
		.includes(proof);
	if (!tagged) {
		// PVE checks tag permissions on /vms/<id> before the new VM joins the pool,
		// so a pool-scoped token cannot tag in the create call: tag right after it.
		if (cfg.name !== `umiak-replica-${p.id}`)
			throw new Error("template replica VMID collision");
		await p.api.put(`${path}/config`, { tags: `umiak-tpl;${proof}` });
		cfg = await p.api.get<Record<string, string | number>>(`${path}/config`);
	}
	const { lvs } = await p.source.call<{
		lvs: { name: string; sizeBytes: number }[];
	}>("lv.list", { tags: ["umiak-tpl"] });
	const checksums: Record<
		string,
		{ sha256: string; sizeBytes: number; algorithm: string }
	> = {};
	let disks = 0;
	for (const slot of ["efidisk0", "scsi0", "tpmstate0"]) {
		const ref = String(src[slot] ?? "");
		if (!ref) continue;
		const [vol, ...options] = ref.split(",");
		const match = new RegExp(
			`^${p.sourceStorage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:base-${p.sourceVmid}-disk-([0-9]+)$`,
		).exec(vol ?? "");
		if (!match) throw new Error(`invalid template disk ${slot}`);
		const lv = lvs.find((v) => v.name === vol?.split(":")[1]);
		if (!lv || !Number.isSafeInteger(lv.sizeBytes) || lv.sizeBytes < 1)
			throw new Error("template LV size unavailable");
		const stage = { name: `umiak-snap-${p.id}-${slot}` };
		const result = await fullVolumeCopy({
			source: p.source,
			sourceStorage: p.sourceStorage,
			sourceName: lv.name,
			targetNode: p.targetNode,
			targetName: stage.name,
			targetVmid: p.targetVmid,
			sizeBytes: lv.sizeBytes,
			onProgress: (progress) => p.checkpoint(slot, progress),
		});

		checksums[slot] = {
			sha256: result.sha256,
			sizeBytes: lv.sizeBytes,
			algorithm: result.algorithm,
		};
		if (Number(cfg.template) !== 1) {
			const target = `vm-${p.targetVmid}-disk-${match[1]}`;
			await p.target.call("lv.transferPublish", { name: stage.name, target });
			await p.api.put(`${path}/config`, {
				[slot]: `${p.targetStorage}:${target}${options.length ? `,${options.join(",")}` : ""}`,
			});
		}
		disks++;
	}
	if (disks === 0) throw new Error("template has no transferable disks");
	if (Number(cfg.template) !== 1) {
		const task = await p.api.post<string>(`${path}/template`);
		if (task) await p.api.waitTask(p.targetNode, task);
	}
	await p.target.call("lv.tagTemplate", { vmid: p.targetVmid });
	cfg = await p.api.get(`${path}/config`);
	if (Number(cfg.template) !== 1)
		throw new Error("replica template conversion incomplete");
	// PVE creates a COW clone of the already verified staging device and renames
	// it on template conversion. Prove that identity rather than rereading data.
	const published = await p.target.call<{
		lvs: { name: string; origin: string; sizeBytes: number; tags: string[] }[];
	}>("lv.list", { tags: ["umiak-tpl"] });
	for (const [slot, checksum] of Object.entries(checksums)) {
		const original = String(src[slot]).split(",")[0]?.split(":")[1];
		const index = original?.match(/-disk-([0-9]+)$/)?.[1];
		const name = `base-${p.targetVmid}-disk-${index}`;
		const disk = published.lvs.find((l) => l.name === name);
		if (
			index === undefined ||
			String(cfg[slot]).split(",")[0] !== `${p.targetStorage}:${name}` ||
			!disk ||
			disk.origin !== `umiak-snap-${p.id}-${slot}` ||
			disk.sizeBytes !== checksum.sizeBytes ||
			!disk.tags.includes(`umiak-transfer-${p.id}`)
		)
			throw Error(
				"Published template does not reference the verified staging clone",
			);
	}

	// Retain staging until durable registry promotion. The caller cleans it only
	// after persisting the verified manifest/checksums and commit phase.
	return checksums;
}
