// Reads the entry headers of a tar file (ustar, pax 'x' records, GNU long
// names), for FakeAgent's archive upload checks before extraction.
import * as fsp from "node:fs/promises";

export interface TarEntry {
	name: string;
	/** ustar typeflag ("0" for a NUL flag). */
	type: string;
	size: number;
	linkname: string;
	/** Permission bits of the header (0o7777). */
	mode: number;
}

/** The file is not a valid tar stream. */
export class TarFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TarFormatError";
	}
}

/** Entries of a tar file; pax global headers and volume labels are skipped. */
export async function readTarEntries(file: string): Promise<TarEntry[]> {
	const fh = await fsp.open(file);
	try {
		const out: TarEntry[] = [];
		const h = Buffer.alloc(512);
		let pos = 0;
		let pax: Record<string, string> = {};
		let longName: string | undefined;
		let longLink: string | undefined;
		const readData = async (at: number, size: number) => {
			const b = Buffer.alloc(size);
			const { bytesRead } = await fh.read(b, 0, size, at);
			if (bytesRead < size) throw new TarFormatError("unexpected EOF");
			return b;
		};
		for (;;) {
			const { bytesRead } = await fh.read(h, 0, 512, pos);
			if (bytesRead === 0) break;
			if (bytesRead < 512) throw new TarFormatError("unexpected EOF");
			if (h.every((b) => b === 0)) break;
			if (!checksumOk(h)) throw new TarFormatError("invalid tar header");
			const flag = h[156] === 0 ? "0" : String.fromCharCode(h[156] as number);
			let size = tarNumber(h.subarray(124, 136));
			const dataAt = pos + 512;
			if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
				const data = await readData(dataAt, size);
				if (flag === "x") pax = parsePax(data);
				if (flag === "L") longName = cString(data);
				if (flag === "K") longLink = cString(data);
				pos = dataAt + Math.ceil(size / 512) * 512;
				continue;
			}
			if (pax.size !== undefined) size = Number(pax.size);
			const ustar = h.subarray(257, 262).toString() === "ustar";
			const base = cString(h.subarray(0, 100));
			const prefix = ustar ? cString(h.subarray(345, 500)) : "";
			const name =
				pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
			const linkname =
				pax.linkpath ?? longLink ?? cString(h.subarray(157, 257));
			pax = {};
			longName = undefined;
			longLink = undefined;
			// Links, directories, devices and FIFOs carry no data.
			const dataSize = "123456".includes(flag) ? 0 : size;
			pos = dataAt + Math.ceil(dataSize / 512) * 512;
			if (flag === "V") continue;
			out.push({
				name,
				type: flag,
				size,
				linkname,
				mode: tarNumber(h.subarray(100, 108)) & 0o7777,
			});
		}
		return out;
	} finally {
		await fh.close();
	}
}

function checksumOk(h: Buffer): boolean {
	let sum = 0;
	for (let i = 0; i < 512; i++) {
		sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
	}
	return tarNumber(h.subarray(148, 156)) === sum;
}

/** An octal field, or base-256 when the high bit is set. */
function tarNumber(b: Buffer): number {
	if (((b[0] as number) & 0x80) !== 0) {
		let n = (b[0] as number) & 0x7f;
		for (let i = 1; i < b.length; i++) n = n * 256 + (b[i] as number);
		return n;
	}
	const s = b
		.toString("latin1")
		.replace(/[\0 ]+$/g, "")
		.trim();
	return s === "" ? 0 : Number.parseInt(s, 8);
}

function cString(b: Buffer): string {
	const nul = b.indexOf(0);
	return b.subarray(0, nul < 0 ? b.length : nul).toString("utf8");
}

/** pax records "<len> <key>=<value>\n". */
function parsePax(b: Buffer): Record<string, string> {
	const out: Record<string, string> = {};
	let i = 0;
	while (i < b.length) {
		const sp = b.indexOf(0x20, i);
		if (sp < 0) break;
		const len = Number(b.subarray(i, sp).toString());
		if (!Number.isSafeInteger(len) || len <= 0) break;
		const rec = b.subarray(sp + 1, i + len - 1).toString("utf8");
		const eq = rec.indexOf("=");
		if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
		i += len;
	}
	return out;
}
