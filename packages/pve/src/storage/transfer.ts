import { createHash } from "node:crypto";
import type { NodeOps } from "../node-client.ts";
import { streamDelta } from "./delta-stream.ts";

export interface TransferProgress {
	verifiedBytes: number;
	transferredBytes: number;
	totalBytes: number;
	elapsedSeconds?: number;
	wireBytes?: number;
	processedBytes?: number;
}
export interface RelayVolumeInput {
	source: NodeOps;
	target: NodeOps;
	sourceName: string;
	targetName: string;
	sizeBytes: number;
	blockBytes?: number;
	verifiedBytes?: number;
	signal?: AbortSignal;
	/** Source-local base; only use together with the verified target replica checksum. */
	sourceBase?: string;
	baseChecksum?: string;
	onProgress?: (progress: TransferProgress) => Promise<void>;
}
interface Block {
	sha256: string;
	sizeBytes: number;
	data?: string;
	zero?: boolean;
}
interface Extent {
	offset: number;
	length: number;
}
interface MapPage {
	ranges: Extent[];
	next: number;
	sizeBytes: number;
}
function validBlock(b: Block, size: number) {
	if (b.sizeBytes !== size || !/^[a-f0-9]{64}$/.test(b.sha256))
		throw new Error("transfer checksum or size invalid");
}
function decoded(b: Block, length: number, size: number) {
	validBlock(b, size);
	const data = Buffer.from(b.data ?? "", "base64");
	if (
		data.length !== length ||
		createHash("sha256").update(data).digest("hex") !== b.sha256
	)
		throw new Error("transfer block checksum mismatch");
	return data;
}

/** Normalized block runs; metadata allocations never dictate checksum chunk boundaries. */
async function runs(input: RelayVolumeInput, block: number): Promise<Extent[]> {
	const out: Extent[] = [];
	let after = 0;
	try {
		do {
			input.signal?.throwIfAborted();
			const p = await input.source.call<MapPage>("lv.transferMap", {
				name: input.sourceName,
				base: input.sourceBase ?? "",
				after,
			});
			if (
				p.sizeBytes !== input.sizeBytes ||
				!Array.isArray(p.ranges) ||
				p.ranges.length > 4096 ||
				!Number.isSafeInteger(p.next) ||
				p.next < 0 ||
				p.next > input.sizeBytes ||
				(p.next !== 0 && p.next <= after)
			)
				throw new Error("invalid transfer map");
			for (const r of p.ranges) {
				if (
					!Number.isSafeInteger(r.offset) ||
					!Number.isSafeInteger(r.length) ||
					r.offset < after ||
					r.length < 1 ||
					r.offset + r.length > input.sizeBytes
				)
					throw new Error("invalid transfer extent");
				const start = Math.floor(r.offset / block) * block;
				const end = Math.min(
					input.sizeBytes,
					Math.ceil((r.offset + r.length) / block) * block,
				);
				out.push({ offset: start, length: end - start });
			}
			after = p.next;
		} while (after);
	} catch (error) {
		input.signal?.throwIfAborted();
		// Older agents or temporarily busy metadata snapshots retain the safe block
		// comparison fallback. No source data is dropped on metadata failure.
		if (out.length) throw error;
		return [{ offset: 0, length: input.sizeBytes }];
	}
	out.sort((a, b) => a.offset - b.offset);
	const merged: Extent[] = [];
	for (const r of out) {
		const last = merged.at(-1);
		if (last && r.offset <= last.offset + last.length)
			last.length = Math.max(last.length, r.offset + r.length - last.offset);
		else merged.push({ ...r });
	}
	return merged;
}

/**
 * Each RPC handles at most 512 KiB. Verification is a canonical SHA-256 tree
 * over logical block offsets and hashes (zero blocks omitted), or a delta
 * proof anchored to the verified identical base. No whole-disk hashing RPC.
 * Callers fence immutable source and staging target through publication.
 */
export async function relayVolume(
	input: RelayVolumeInput,
): Promise<
	TransferProgress & { sha256: string; algorithm: "sha256-block-tree-v1" }
> {
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
		(start !== sizeBytes && start % blockBytes !== 0) ||
		Boolean(input.sourceBase) !== Boolean(input.baseChecksum)
	)
		throw new Error("invalid transfer size, base or checkpoint");
	const extents = await runs(input, blockBytes);
	if (
		input.sourceBase &&
		input.source.deltaStreamEnabled === true &&
		input.target.deltaStreamEnabled === true &&
		input.source.openTransfer &&
		input.target.openTransfer
	)
		return streamDelta(input, extents);
	if (!input.sourceBase) {
		const targetRuns = await runs(
			{ ...input, source: target, sourceName: targetName },
			blockBytes,
		);
		extents.push(...targetRuns);
		extents.sort((a, b) => a.offset - b.offset);
		for (let i = 1; i < extents.length; ) {
			const prev = extents[i - 1];
			const cur = extents[i];
			if (!prev || !cur) throw new Error("invalid transfer extent merge");
			if (cur.offset <= prev.offset + prev.length) {
				prev.length = Math.max(
					prev.length,
					cur.offset + cur.length - prev.offset,
				);
				extents.splice(i, 1);
			} else i++;
		}
	}
	const progress: TransferProgress = {
		verifiedBytes: start,
		transferredBytes: 0,
		totalBytes: sizeBytes,
	};
	for (const extent of extents)
		for (
			let offset = extent.offset;
			offset < extent.offset + extent.length;
			offset += blockBytes
		) {
			if (offset < start) continue;
			signal?.throwIfAborted();
			const length = Math.min(blockBytes, sizeBytes - offset);
			const src = await source.call<Block>("lv.transferRead", {
				name: sourceName,
				offset,
				length,
				hashOnly: true,
			});
			validBlock(src, sizeBytes);
			const dst = await target.call<Block>("lv.transferRead", {
				name: targetName,
				offset,
				length,
				hashOnly: true,
			});
			validBlock(dst, sizeBytes);
			if (src.sha256 !== dst.sha256) {
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
	const hash = createHash("sha256").update(
		`umiak-block-tree-v1:${sizeBytes}:${blockBytes}:${input.baseChecksum ?? ""}\n`,
	);
	for (const extent of extents)
		for (
			let offset = extent.offset;
			offset < extent.offset + extent.length;
			offset += blockBytes
		) {
			signal?.throwIfAborted();
			const length = Math.min(blockBytes, sizeBytes - offset);
			const src = await source.call<Block>("lv.transferRead", {
				name: sourceName,
				offset,
				length,
				hashOnly: true,
			});
			validBlock(src, sizeBytes);
			const dst = await target.call<Block>("lv.transferRead", {
				name: targetName,
				offset,
				length,
				hashOnly: true,
			});
			if (dst.sizeBytes !== sizeBytes || src.sha256 !== dst.sha256)
				throw new Error("transfer final checksum mismatch");
			if (input.sourceBase || !src.zero)
				hash.update(`${offset}:${length}:${src.sha256}\n`);
			// Heartbeats/checkpoints bound verification by progress, not disk size.
			await input.onProgress?.({ ...progress });
		}
	signal?.throwIfAborted();
	progress.verifiedBytes = sizeBytes;
	await input.onProgress?.({ ...progress });
	return {
		...progress,
		sha256: hash.digest("hex"),
		algorithm: "sha256-block-tree-v1",
	};
}
