import { posix } from "node:path";

// Minimal tar reader for signed agent packages. Mirrors Unpack in
// services/guest-agent/internal/update/pkg.go: regular files and directories
// only, names must stay inside the package, an entry may appear once, at most
// 64 entries and 512 MiB of file data.
//
// The reader is deliberately stricter than GNU tar and Go archive/tar: the
// package is verified here but extracted by tar in the guest, so anything the
// two could parse differently is rejected. Accepted is exactly what Go's
// writeTar (pkg.go) produces: plain ustar headers (magic "ustar\0", version
// "00"), no pax (x, g) and no GNU long name (L, K) headers, directories
// without data, regular file names without a trailing slash, and the archive
// ends with two zero blocks followed by zeros only.

const BLOCK = 512;
const MAX_ENTRIES = 64;
const MAX_BYTES = 512 << 20;

/** Cleaned slash-separated name; null for the archive root. Mirrors entryName in pkg.go. */
export function entryName(raw: string): string | null {
	if (raw === "" || raw.startsWith("/") || /[\\\0]/.test(raw))
		throw new Error(`tar: bad entry name ${JSON.stringify(raw)}`);
	if (raw.split("/").includes(".."))
		throw new Error(`tar: entry ${JSON.stringify(raw)} leaves the package`);
	const name = posix.normalize(raw).replace(/\/+$/, "");
	return name === "." || name === "" ? null : name;
}

function cString(buf: Buffer, start: number, len: number): string {
	const field = buf.subarray(start, start + len);
	const end = field.indexOf(0);
	return field.subarray(0, end < 0 ? len : end).toString("utf8");
}

function octal(buf: Buffer, start: number, len: number, what: string): number {
	const s = cString(buf, start, len).trim();
	if (!/^[0-7]+$/.test(s)) throw new Error(`tar: bad ${what} field`);
	return Number.parseInt(s, 8);
}

function checksumOk(hdr: Buffer): boolean {
	let sum = 0;
	for (let i = 0; i < BLOCK; i++)
		sum += i >= 148 && i < 156 ? 0x20 : (hdr[i] as number);
	return sum === octal(hdr, 148, 8, "checksum");
}

const MAGIC = Buffer.from("ustar\0");
const VERSION = Buffer.from("00");

/** Regular files of a ustar archive by cleaned name; directory entries are accepted and skipped. */
export function readTar(
	buf: Buffer,
	maxEntries = MAX_ENTRIES,
): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	const dirs = new Set<string>();
	let total = 0;
	let entries = 0;
	let pos = 0;
	while (pos + BLOCK <= buf.length) {
		const hdr = buf.subarray(pos, pos + BLOCK);
		pos += BLOCK;
		if (hdr.every((b) => b === 0)) {
			// End of archive: a second zero block and nothing but zeros after it.
			if (pos + BLOCK > buf.length) throw new Error("tar: truncated archive");
			if (!buf.subarray(pos).every((b) => b === 0))
				throw new Error("tar: data after the end of the archive");
			return files;
		}
		if (!checksumOk(hdr)) throw new Error("tar: header checksum mismatch");
		if (
			!hdr.subarray(257, 263).equals(MAGIC) ||
			!hdr.subarray(263, 265).equals(VERSION)
		)
			throw new Error("tar: not a ustar header");
		const type = String.fromCharCode(hdr[156] as number);
		const size = octal(hdr, 124, 12, "size");
		const prefix = cString(hdr, 345, 155);
		const rawName = cString(hdr, 0, 100);
		const raw = prefix === "" ? rawName : `${prefix}/${rawName}`;
		const next = pos + Math.ceil(size / BLOCK) * BLOCK;
		if (++entries > maxEntries)
			throw new Error(`tar: more than ${maxEntries} entries`);
		const name = entryName(raw);
		if (type === "5") {
			if (size !== 0)
				throw new Error(
					`tar: directory ${JSON.stringify(raw)} has data (size ${size})`,
				);
			if (name !== null) dirs.add(name);
			pos = next;
			continue;
		}
		if (type !== "0" && type !== "\0")
			throw new Error(
				`tar: entry ${JSON.stringify(raw)} has unsupported type ${JSON.stringify(type)}`,
			);
		// GNU tar treats a regular entry with a trailing slash as a directory.
		if (name === null || raw.endsWith("/"))
			throw new Error(`tar: bad entry name ${JSON.stringify(raw)}`);
		if (size > MAX_BYTES - total)
			throw new Error(`tar: package is larger than ${MAX_BYTES} bytes`);
		total += size;
		if (pos + size > buf.length) throw new Error("tar: truncated archive");
		if (files.has(name) || dirs.has(name))
			throw new Error(`tar: duplicate entry ${JSON.stringify(raw)}`);
		files.set(name, Buffer.from(buf.subarray(pos, pos + size)));
		pos = next;
	}
	throw new Error("tar: truncated archive");
}
