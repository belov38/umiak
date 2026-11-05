import type { Duplex } from "node:stream";
import type { TransferSession } from "../node-client.ts";
import type { RelayVolumeInput, TransferProgress } from "./transfer.ts";

const MAX = 8 * 1024 * 1024,
	HEADER = 48,
	ZERO = 1,
	END = 2,
	PREFIX = 4,
	ACK = 8;
class Reader {
	readonly iterator: AsyncIterator<Buffer>;
	buffer: Buffer = Buffer.alloc(0);
	constructor(stream: Duplex) {
		this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
	}
	async finish() {
		if (this.buffer.length) throw Error("Trailing delta stream data");
		const next = await this.iterator.next();
		if (!next.done) throw Error("Trailing delta stream data");
	}

	async read(n: number) {
		const out = Buffer.allocUnsafe(n);
		let p = 0;
		while (p < n) {
			if (!this.buffer.length) {
				const next = await this.iterator.next();
				if (next.done) throw Error("Truncated delta stream");
				this.buffer = next.value;
			}
			const size = Math.min(n - p, this.buffer.length);
			this.buffer.copy(out, p, 0, size);
			this.buffer = this.buffer.subarray(size);
			p += size;
		}
		return out;
	}
}
async function write(stream: Duplex, b: Buffer) {
	if (stream.destroyed) throw Error("Delta stream closed");
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			stream.off("drain", ok);
			stream.off("error", fail);
			stream.off("close", closed);
		};
		const ok = () => {
			cleanup();
			resolve();
		};
		const fail = (error: Error) => {
			cleanup();
			reject(error);
		};
		const closed = () => fail(new Error("Delta stream closed"));
		stream.once("drain", ok);
		stream.once("error", fail);
		stream.once("close", closed);
		if (stream.write(b)) ok();
	});
}
function frame(b: Buffer) {
	const offset = Number(b.readBigUInt64BE());
	const length = b.readUInt32BE(8),
		flags = b.readUInt32BE(12);
	if (!Number.isSafeInteger(offset) || length > MAX)
		throw Error("Invalid delta frame bounds");
	return { offset, length, flags, hash: b.subarray(16) };
}
/** Four bounded frames in flight, with contiguous durable readback acknowledgements. */
export async function streamDelta(
	input: RelayVolumeInput,
	ranges: { offset: number; length: number }[],
) {
	if (
		!input.source.openTransfer ||
		!input.target.openTransfer ||
		!input.baseChecksum
	)
		throw Error("Delta stream unavailable");
	const start = input.verifiedBytes ?? 0;
	const args = {
		sizeBytes: input.sizeBytes,
		verifiedBytes: start,
		baseChecksum: input.baseChecksum,
		ranges,
	};
	const sessions: TransferSession[] = [];
	let inFlight: Promise<unknown> = Promise.resolve();
	let writeTail = Promise.resolve();
	try {
		const source = await input.source.openTransfer({
			...args,
			mode: "export",
			name: input.sourceName,
		});
		sessions.push(source);
		const target = await input.target.openTransfer({
			...args,
			mode: "import",
			name: input.targetName,
		});
		sessions.push(target);
		const src = new Reader(source.stream),
			dst = new Reader(target.stream);
		const abort = () => {
			source.stream.destroy(new Error("Delta transfer aborted"));
			target.stream.destroy(new Error("Delta transfer aborted"));
		};
		input.signal?.addEventListener("abort", abort, { once: true });
		try {
			const progress: TransferProgress = {
				verifiedBytes: start,
				transferredBytes: 0,
				totalBytes: input.sizeBytes,
			};
			const pending: Promise<void>[] = [];
			let ackTail = Promise.resolve();
			function* frames() {
				for (const range of ranges)
					for (
						let offset = range.offset;
						offset < range.offset + range.length;
					) {
						let length = Math.min(MAX, range.offset + range.length - offset);
						if (offset < start && offset + length > start)
							length = start - offset;
						yield { offset, length };
						offset += length;
					}
			}
			for (const e of frames()) {
				input.signal?.throwIfAborted();
				const header = await src.read(HEADER),
					f = frame(header);
				if (
					f.offset !== e.offset ||
					f.length !== e.length ||
					f.flags & ~(ZERO | PREFIX) ||
					Boolean(f.flags & PREFIX) !== f.offset < start
				)
					throw Error("Unexpected delta frame sequence");
				const payload =
					f.flags & (ZERO | PREFIX) ? undefined : await src.read(f.length);
				const sending = writeTail.then(async () => {
					await write(target.stream, header);
					if (payload) await write(target.stream, payload);
				});
				sending.catch(() => {});
				writeTail = sending;
				const ack = ackTail.then(async () => {
					await sending;
					const proof = frame(await dst.read(HEADER));
					if (
						proof.flags !== ACK ||
						proof.offset !== f.offset + f.length ||
						proof.length !== f.length ||
						!proof.hash.equals(f.hash)
					)
						throw Error("Delta readback acknowledgement mismatch");
					if (!(f.flags & PREFIX)) {
						progress.verifiedBytes = f.offset + f.length;
						progress.transferredBytes += f.flags & ZERO ? 0 : f.length;
						await input.onProgress?.({ ...progress });
					}
				});
				// Attach a handler immediately while other frames are still being pipelined.
				ack.catch(() => {});
				ackTail = ack;
				inFlight = ack;
				pending.push(ack);
				if (pending.length >= 4) await pending.shift();
			}
			await Promise.all(pending);
			const end = await src.read(HEADER),
				digest = frame(end);
			if (
				digest.flags !== END ||
				digest.length !== 0 ||
				digest.offset !== input.sizeBytes
			)
				throw Error("Invalid final delta proof");
			await write(target.stream, end);
			target.stream.end();
			const proof = frame(await dst.read(HEADER));
			if (
				proof.flags !== (END | ACK) ||
				proof.length !== 0 ||
				proof.offset !== input.sizeBytes ||
				!proof.hash.equals(digest.hash)
			)
				throw Error("Delta final checksum mismatch");
			source.stream.end();
			await Promise.all([src.finish(), dst.finish()]);
			await Promise.all(sessions.map((s) => s.closed));
			progress.verifiedBytes = input.sizeBytes;
			await input.onProgress?.({ ...progress });
			return {
				...progress,
				sha256: digest.hash.toString("hex"),
				algorithm: "sha256-block-tree-v1" as const,
			};
		} finally {
			input.signal?.removeEventListener("abort", abort);
		}
	} finally {
		for (const s of sessions) {
			s.stream.destroy();
			s.stream.resume();
		}
		await Promise.allSettled([
			inFlight,
			writeTail,
			...sessions.map((s) => s.closed),
		]);
	}
}
