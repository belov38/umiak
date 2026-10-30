// Screenshots of the fake desktop: real, decodable images of exactly the
// requested size, generated in code (no binary fixtures).
//   PNG:  8-bit grayscale, horizontal bands, deflated IDAT.
//   JPEG: baseline grayscale with custom one-code Huffman tables: every 8x8
//         block is the flat gray 128 and costs two bits ("0" DC category 0,
//         "0" end of block).
import { crc32, deflateSync } from "node:zlib";

const cache = new Map<string, Uint8Array>();

function memo(key: string, make: () => Uint8Array): Uint8Array {
	let v = cache.get(key);
	if (v === undefined) {
		v = make();
		cache.set(key, v);
	}
	return v;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const body = Buffer.concat([head.subarray(4), data]);
	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([head.subarray(0, 4), body, tail]);
}

export function pngBytes(width: number, height: number): Uint8Array {
	return memo(`png:${width}x${height}`, () => {
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(width, 0);
		ihdr.writeUInt32BE(height, 4);
		ihdr[8] = 8; // bit depth
		ihdr[9] = 0; // grayscale
		const raw = Buffer.alloc((width + 1) * height);
		for (let y = 0; y < height; y++) {
			// Filter type 0, then a band of constant gray per row.
			raw.fill(
				Math.floor((y * 255) / Math.max(1, height)),
				y * (width + 1) + 1,
				(y + 1) * (width + 1),
			);
		}
		return Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IDAT", deflateSync(raw)),
			chunk("IEND", Buffer.alloc(0)),
		]);
	});
}

export function jpegBytes(width: number, height: number): Uint8Array {
	return memo(`jpeg:${width}x${height}`, () => {
		const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
		const bits = blocks * 2;
		const data = Buffer.alloc(Math.ceil(bits / 8));
		if (bits % 8 !== 0) data[data.length - 1] = 0xff >> (bits % 8);
		const counts = Buffer.alloc(16);
		counts[0] = 1;
		const dht = (tableClass: number) =>
			Buffer.concat([
				Buffer.from([0xff, 0xc4, 0x00, 0x14, tableClass]),
				counts,
				Buffer.from([0x00]),
			]);
		const sof = Buffer.from([
			0xff,
			0xc0,
			0x00,
			0x0b,
			0x08,
			height >> 8,
			height & 0xff,
			width >> 8,
			width & 0xff,
			0x01,
			0x01,
			0x11,
			0x00,
		]);
		return Buffer.concat([
			Buffer.from([0xff, 0xd8]),
			Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]),
			Buffer.alloc(64, 1),
			sof,
			dht(0x00),
			dht(0x10),
			Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
			data,
			Buffer.from([0xff, 0xd9]),
		]);
	});
}

/**
 * Size of a screenshot scaled to fit `maxWidth` x `maxHeight` (S10 §12.1):
 * the aspect ratio is kept, never upscaled, rounded with Math.round.
 */
export function scaleToFit(
	width: number,
	height: number,
	maxWidth?: number,
	maxHeight?: number,
): { width: number; height: number } {
	const scale = Math.min(
		1,
		maxWidth === undefined ? 1 : maxWidth / width,
		maxHeight === undefined ? 1 : maxHeight / height,
	);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}
