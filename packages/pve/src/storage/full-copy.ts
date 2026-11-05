import type { NodeOps } from "../node-client.ts";
import type { TransferProgress } from "./transfer.ts";
export interface FullCopyReceipt {
	name: string;
	uuid: string;
	sourceUUID: string;
	sha256: string;
	algorithm: string;
	sizeBytes: number;
	wireBytes: number;
	elapsedSeconds: number;
	verified: boolean;
}
/** Proxmox raw+size/zstd stream over the cluster's existing pinned root SSH trust. */
export async function fullVolumeCopy(input: {
	source: NodeOps;
	sourceStorage: string;
	sourceName: string;
	targetNode: string;
	targetName: string;
	targetVmid?: number;
	sizeBytes: number;
	onProgress?: (p: TransferProgress) => Promise<void>;
}) {
	const r = await input.source.call<FullCopyReceipt>(
		"volume.sendTo",
		{
			volume: `${input.sourceStorage}:${input.sourceName}`,
			targetNode: input.targetNode,
			targetName: input.targetName,
			targetVmid: input.targetVmid ?? 0,
		},
		async (p) =>
			input.onProgress?.({
				verifiedBytes: 0,
				transferredBytes: 0,
				totalBytes: input.sizeBytes,
				...p,
			}),
	);
	if (
		!r.verified ||
		r.name !== input.targetName ||
		r.sizeBytes !== input.sizeBytes ||
		!/^[a-f0-9]{64}$/.test(r.sha256) ||
		r.algorithm !== "sha256-pvesm-raw+size-v1" ||
		!r.uuid
	)
		throw Error("Invalid verified Proxmox import receipt");
	await input.onProgress?.({
		verifiedBytes: r.sizeBytes,
		transferredBytes: r.wireBytes ?? 0,
		elapsedSeconds: r.elapsedSeconds,
		wireBytes: r.wireBytes,
		totalBytes: r.sizeBytes,
	});
	return r;
}
