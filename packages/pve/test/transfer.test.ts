import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NodeOps } from "../src/node-client.ts";
import { relayVolume } from "../src/storage/transfer.ts";

function node(data: Buffer) {
	const writes: number[] = [];
	const ops: NodeOps = {
		close() {},
		async call<T>(op: string, raw?: object): Promise<T> {
			const a = raw as {
				offset: number;
				length: number;
				data: string;
				sha256: string;
				hashOnly: boolean;
			};
			if (op === "lv.transferDigest")
				return {
					sha256: createHash("sha256").update(data).digest("hex"),
					sizeBytes: data.length,
				} as T;
			if (op === "lv.transferRead") {
				const b = data.subarray(a.offset, a.offset + a.length);
				return {
					sha256: createHash("sha256").update(b).digest("hex"),
					sizeBytes: data.length,
					zero: b.every((x) => x === 0),
					...(!a.hashOnly ? { data: b.toString("base64") } : {}),
				} as T;
			}
			if (op === "lv.transferWrite") {
				const b = Buffer.from(a.data, "base64");
				b.copy(data, a.offset);
				writes.push(a.offset);
				return { sha256: a.sha256, writtenBytes: b.length } as T;
			}
			throw new Error(op);
		},
	};
	return { ops, writes };
}

describe("sparse volume relay", () => {
	it("copies differing blocks including changed-to-zero, skips identical blocks", async () => {
		const source = node(Buffer.from([0, 0, 3, 4, 5, 6]));
		const target = node(Buffer.from([1, 2, 3, 4, 0, 0]));
		const checkpoints: number[] = [];
		const result = await relayVolume({
			source: source.ops,
			target: target.ops,
			sourceName: "base-599-disk-0",
			targetName: "staging",
			sizeBytes: 6,
			blockBytes: 2,
			onProgress: async (p) => {
				checkpoints.push(p.verifiedBytes);
			},
		});
		expect(target.writes).toEqual([0, 4]);
		expect(result.transferredBytes).toBe(4);
		expect(checkpoints.slice(0, 3)).toEqual([2, 4, 6]);
	});
	it("resumes from verified offset and hashes the entire resulting disk", async () => {
		const source = node(Buffer.from([1, 2, 3, 4]));
		const target = node(Buffer.from([1, 2, 0, 0]));
		const result = await relayVolume({
			source: source.ops,
			target: target.ops,
			sourceName: "source",
			targetName: "staging",
			sizeBytes: 4,
			blockBytes: 2,
			verifiedBytes: 2,
		});
		expect(target.writes).toEqual([2]);
		expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(result.algorithm).toBe("sha256-block-tree-v1");
	});
	it("fails closed on corruption, size changes and invalid checkpoints", async () => {
		const source = node(Buffer.from([1, 2]));
		const target = node(Buffer.from([0, 0]));
		for (const verifiedBytes of [-1, 1, 3])
			await expect(
				relayVolume({
					source: source.ops,
					target: target.ops,
					sourceName: "s",
					targetName: "t",
					sizeBytes: 2,
					blockBytes: 2,
					verifiedBytes,
				}),
			).rejects.toThrow();
		const broken: NodeOps = {
			close() {},
			async call<T>(): Promise<T> {
				return { sizeBytes: 2, sha256: "bad", data: "AQI=" } as T;
			},
		};
		await expect(
			relayVolume({
				source: broken,
				target: target.ops,
				sourceName: "s",
				targetName: "t",
				sizeBytes: 2,
			}),
		).rejects.toThrow(/checksum/);
	});
	it("cancels before writing or checkpointing", async () => {
		const source = node(Buffer.from([1, 2]));
		const target = node(Buffer.from([0, 0]));
		await expect(
			relayVolume({
				source: source.ops,
				target: target.ops,
				sourceName: "s",
				targetName: "t",
				sizeBytes: 2,
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow();
		expect(target.writes).toEqual([]);
	});
});

it("never checkpoints an acknowledged but corrupt destination write", async () => {
	const source = node(Buffer.from([1, 2]));
	const disk = node(Buffer.from([0, 0]));
	const target: NodeOps = {
		close() {},
		call<T>(op: string, args?: object): Promise<T> {
			if (op === "lv.transferWrite") return Promise.resolve({} as T);
			return disk.ops.call<T>(op, args);
		},
	};
	const checkpoints: number[] = [];
	await expect(
		relayVolume({
			source: source.ops,
			target,
			sourceName: "s",
			targetName: "t",
			sizeBytes: 2,
			onProgress: async (p) => {
				checkpoints.push(p.verifiedBytes);
			},
		}),
	).rejects.toThrow(/readback/);
	expect(checkpoints).toEqual([]);
});

it("rechecks the persisted prefix before reporting completion", async () => {
	const source = node(Buffer.from([1, 2, 3, 4]));
	const target = node(Buffer.from([9, 9, 0, 0]));
	await expect(
		relayVolume({
			source: source.ops,
			target: target.ops,
			sourceName: "s",
			targetName: "t",
			sizeBytes: 4,
			blockBytes: 2,
			verifiedBytes: 2,
		}),
	).rejects.toThrow(/final checksum/);
});

it("does not write zero blocks into a fresh sparse target", async () => {
	const source = node(Buffer.from([0, 0, 1, 2, 0, 0]));
	const target = node(Buffer.alloc(6));
	const result = await relayVolume({
		source: source.ops,
		target: target.ops,
		sourceName: "s",
		targetName: "t",
		sizeBytes: 6,
		blockBytes: 2,
	});
	expect(target.writes).toEqual([2]);
	expect(result.transferredBytes).toBe(2);
});

it("does not request unchanged source block payloads", async () => {
	const base = node(Buffer.from([0, 0, 1, 2]));
	const dst = node(Buffer.from([0, 0, 0, 0]));
	const payloadReads: number[] = [];
	const source: NodeOps = {
		close() {},
		call<T>(op: string, args?: object): Promise<T> {
			const a = args as { hashOnly?: boolean; offset: number };
			if (op === "lv.transferRead" && !a.hashOnly) payloadReads.push(a.offset);
			return base.ops.call<T>(op, args);
		},
	};
	await relayVolume({
		source,
		target: dst.ops,
		sourceName: "s",
		targetName: "t",
		sizeBytes: 4,
		blockBytes: 2,
	});
	expect(payloadReads).toEqual([2]);
});

it("observes cancellation during a payload read before mutating staging", async () => {
	const controller = new AbortController();
	const disk = node(Buffer.from([1, 2]));
	const dst = node(Buffer.alloc(2));
	const source: NodeOps = {
		close() {},
		async call<T>(op: string, args?: object): Promise<T> {
			const result = await disk.ops.call<T>(op, args);
			if (
				op === "lv.transferRead" &&
				!(args as { hashOnly?: boolean }).hashOnly
			)
				controller.abort();
			return result;
		},
	};
	await expect(
		relayVolume({
			source,
			target: dst.ops,
			sourceName: "s",
			targetName: "t",
			sizeBytes: 2,
			signal: controller.signal,
		}),
	).rejects.toThrow();
	expect(dst.writes).toEqual([]);
});
