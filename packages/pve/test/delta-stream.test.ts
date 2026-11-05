import { createHash } from "node:crypto";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import type { NodeOps } from "../src/node-client.ts";
import { relayVolume } from "../src/storage/transfer.ts";

const BLOCK = 8 * 1024 * 1024,
	SIZE = 6 * BLOCK,
	BASE = "b".repeat(64);
function header(offset: number, length: number, flags: number, hash: Buffer) {
	const b = Buffer.alloc(48);
	b.writeBigUInt64BE(BigInt(offset));
	b.writeUInt32BE(length, 8);
	b.writeUInt32BE(flags, 12);
	hash.copy(b, 16);
	return b;
}
function harness(start = 0, corrupt = false, truncated = false) {
	const data = Buffer.alloc(BLOCK, 7),
		zero = Buffer.alloc(BLOCK);
	const chunks: Buffer[] = [];
	const tree = createHash("sha256").update(
		`umiak-block-tree-v1:${SIZE}:${512 * 1024}:${BASE}\n`,
	);
	for (let i = 0; i < 6; i++) {
		const b = i === 1 ? zero : data;
		const flags = (i === 1 ? 1 : 0) | (i * BLOCK < start ? 4 : 0);
		chunks.push(
			header(i * BLOCK, BLOCK, flags, createHash("sha256").update(b).digest()),
		);
		if (!flags) chunks.push(b);
		for (let off = 0; off < BLOCK; off += 512 * 1024)
			tree.update(
				`${i * BLOCK + off}:${512 * 1024}:${createHash("sha256")
					.update(b.subarray(off, off + 512 * 1024))
					.digest("hex")}\n`,
			);
	}
	const digest = tree.digest();
	if (!truncated) chunks.push(header(SIZE, 0, 2, digest));
	let producedFrames = 0,
		producedBeforeDrain = 0,
		delayed = false;
	let sourceOpens = 0,
		targetOpens = 0,
		unacked = 0,
		maxUnacked = 0,
		buffer: Buffer = Buffer.alloc(0);
	const timers: ReturnType<typeof setTimeout>[] = [];
	const source = new Duplex({
		read() {
			const chunk = chunks.shift();
			if (chunk?.length === 48 && chunk.readUInt32BE(12) !== 2)
				producedFrames++;
			this.push(chunk ?? null);
		},
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
	const target = new Duplex({
		read() {},
		write(chunk: Buffer, _encoding, callback) {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 48) {
				const length = buffer.readUInt32BE(8),
					flags = buffer.readUInt32BE(12);
				const payload = flags & (1 | 4 | 2) ? 0 : length;
				if (buffer.length < 48 + payload) break;
				const h = Buffer.from(buffer.subarray(0, 48));
				buffer = buffer.subarray(48 + payload);
				if (flags === 2) {
					h.writeUInt32BE(10, 12);
					this.push(h);
					continue;
				}
				h.writeBigUInt64BE(h.readBigUInt64BE() + BigInt(length));
				h.writeUInt32BE(8, 12);
				if (corrupt) h[16] = (h[16] ?? 0) ^ 1;
				unacked++;
				maxUnacked = Math.max(maxUnacked, unacked);
				timers.push(
					setTimeout(() => {
						unacked--;
						if (!target.destroyed) target.push(h);
					}, 15),
				);
			}
			if (chunk.length > 48 && !delayed) {
				delayed = true;
				setTimeout(() => {
					producedBeforeDrain = producedFrames;
					callback();
				}, 100);
			} else callback();
		},
		final(callback) {
			this.push(null);
			callback();
		},
	});
	target.on("close", () => {
		for (const timer of timers) clearTimeout(timer);
	});
	const finished = (stream: Duplex) =>
		new Promise<void>((resolve) => {
			let ended = false,
				finished = false;
			const check = () => {
				if (ended && finished) resolve();
			};
			stream.on("end", () => {
				ended = true;
				check();
			});
			stream.on("finish", () => {
				finished = true;
				check();
			});
			stream.on("close", () => resolve());
		});
	const sourceClosed = finished(source),
		targetClosed = finished(target);

	const sourceNode: NodeOps = {
		close() {},
		async call<T>() {
			return {
				sizeBytes: SIZE,
				next: 0,
				ranges: [{ offset: 0, length: SIZE }],
			} as T;
		},
		async openTransfer() {
			sourceOpens++;
			return { stream: source, closed: sourceClosed };
		},
	};
	const targetNode: NodeOps = {
		close() {},
		async call<T>() {
			throw Error("per-block RPC must not run");
			return {} as T;
		},
		async openTransfer() {
			targetOpens++;
			return { stream: target, closed: targetClosed };
		},
	};
	return {
		input: {
			source: sourceNode,
			target: targetNode,
			sourceName: "umiak-snap-source-scsi0",
			targetName: "umiak-snap-target-scsi0",
			sizeBytes: SIZE,
			sourceBase: "base-600-disk-0",
			baseChecksum: BASE,
			verifiedBytes: start,
		},
		digest: digest.toString("hex"),
		stats: () => ({
			sourceOpens,
			targetOpens,
			maxUnacked,
			producedBeforeDrain,
		}),
	};
}
describe("bounded delta sessions", () => {
	it("uses one session per endpoint, pipelines at most four frames and computes the existing canonical checksum", async () => {
		const h = harness();
		const progress: number[] = [];
		const r = await relayVolume({
			...h.input,
			onProgress: async (p) => {
				progress.push(p.verifiedBytes);
			},
		});
		expect(r.sha256).toBe(h.digest);
		expect(r.transferredBytes).toBe(5 * BLOCK);
		expect(r.verifiedBytes).toBe(SIZE);
		expect(h.stats().sourceOpens).toBe(1);
		expect(h.stats().targetOpens).toBe(1);
		expect(h.stats().maxUnacked).toBeLessThanOrEqual(4);
		expect(h.stats().producedBeforeDrain).toBeGreaterThanOrEqual(4);
		expect(progress).toEqual([...progress].sort((a, b) => a - b));
	});
	it("revalidates the prefix without retransmitting it or zero payloads", async () => {
		const h = harness(BLOCK);
		const r = await relayVolume(h.input);
		expect(r.sha256).toBe(h.digest);
		expect(r.transferredBytes).toBe(4 * BLOCK);
	});
	it("fails closed on a corrupt destination acknowledgement", async () => {
		const h = harness(0, true);
		await expect(relayVolume(h.input)).rejects.toThrow(/acknowledgement/);
	});
	it("fails closed on a truncated source stream", async () => {
		const h = harness(0, false, true);
		await expect(relayVolume(h.input)).rejects.toThrow(/Truncated/);
	});
});
