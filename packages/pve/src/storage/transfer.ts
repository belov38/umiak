import { createHash } from "node:crypto";
import type { NodeOps } from "../node-client.ts";

export interface TransferProgress {
	verifiedBytes: number;
	transferredBytes: number;
	totalBytes: number;
}

export interface RelayVolumeInput {
	source: NodeOps;
	target: NodeOps;
	sourceName: string;
	/** An unpublished lv.transferPrepare volume, never a working VM disk. */
	targetName: string;
	sizeBytes: number;
	blockBytes?: number;
	/** Durable verified checkpoint, aligned to blockBytes (or at EOF). */
	verifiedBytes?: number;
	signal?: AbortSignal;
	/** Persist before returning; throwing leaves this block safe to replay. */
	onProgress?: (progress: TransferProgress) => Promise<void>;
}

interface Block {
	sha256: string;
	sizeBytes: number;
	data?: string;
}

function decoded(block: Block, length: number, sizeBytes: number): Buffer {
	if (block.sizeBytes !== sizeBytes) throw new Error("transfer size changed");
	const data = Buffer.from(block.data ?? "", "base64");
	if (
		data.length !== length ||
		createHash("sha256").update(data).digest("hex") !== block.sha256
	)
		throw new Error("transfer block checksum mismatch");
	return data;
}

/**
 * Sparse/base-relative relay over the existing bounded forced-command RPCs.
 * Comparing the actual destination handles retries and changed-to-zero blocks
 * without trusting a base identity. The caller fences both LVs until completion.
 * A final full verification also covers blocks before a resumed checkpoint.
 */
export async function relayVolume(
	input: RelayVolumeInput,
): Promise<TransferProgress & { sha256: string }> {
	const { source, target, sourceName, targetName, sizeBytes, signal } = input;
	const blockBytes = input.blockBytes ?? 512 * 1024;
	const start = input.verifiedBytes ?? 0;
	if (
		!Number.isSafeInteger(sizeBytes) ||
		sizeBytes < 1 ||
		!Number.isSafeInteger(blockBytes) ||
		blockBytes < 1 ||
		blockBytes > 512 * 1024 ||
		!Number.isSafeInteger(start) ||
		start < 0 ||
		start > sizeBytes ||
		(start !== sizeBytes && start % blockBytes !== 0)
	)
		throw new Error("invalid transfer size or checkpoint");
	const progress: TransferProgress = {
		verifiedBytes: start,
		transferredBytes: 0,
		totalBytes: sizeBytes,
	};
	for (let offset = start; offset < sizeBytes; offset += blockBytes) {
		signal?.throwIfAborted();
		const length = Math.min(blockBytes, sizeBytes - offset);
		const src = await source.call<Block>("lv.transferRead", {
			name: sourceName,
			offset,
			length,
			hashOnly: true,
		});
		if (src.sizeBytes !== sizeBytes || !/^[a-f0-9]{64}$/.test(src.sha256))
			throw new Error("transfer source checksum or size invalid");
		const dst = await target.call<Block>("lv.transferRead", {
			name: targetName,
			offset,
			length,
			hashOnly: true,
		});
		if (dst.sizeBytes !== sizeBytes)
			throw new Error("transfer target size changed");
		if (dst.sha256 !== src.sha256) {
			signal?.throwIfAborted();
			const payload = await source.call<Block>("lv.transferRead", {
				name: sourceName,
				offset,
				length,
			});
			const data = decoded(payload, length, sizeBytes);
			if (payload.sha256 !== src.sha256)
				throw new Error("transfer source changed");
			signal?.throwIfAborted();
			await target.call("lv.transferWrite", {
				name: targetName,
				offset,
				data: data.toString("base64"),
				sha256: src.sha256,
			});
			const check = await target.call<Block>("lv.transferRead", {
				name: targetName,
				offset,
				length,
				hashOnly: true,
			});
			if (check.sizeBytes !== sizeBytes || check.sha256 !== src.sha256)
				throw new Error("transfer readback checksum mismatch");
			progress.transferredBytes += length;
		}
		progress.verifiedBytes = offset + length;
		await input.onProgress?.({ ...progress });
	}
	signal?.throwIfAborted();
	const src = await source.call<Block>("lv.transferDigest", {
		name: sourceName,
	});
	const dst = await target.call<Block>("lv.transferDigest", {
		name: targetName,
	});
	if (
		src.sizeBytes !== sizeBytes ||
		dst.sizeBytes !== sizeBytes ||
		!/^[a-f0-9]{64}$/.test(src.sha256) ||
		src.sha256 !== dst.sha256
	)
		throw new Error("transfer final checksum mismatch");
	signal?.throwIfAborted();
	return { ...progress, sha256: src.sha256 };
}
