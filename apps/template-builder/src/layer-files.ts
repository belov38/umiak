import { createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GuestIo } from "./runner.ts";

export interface CapturedFile {
	path: string;
	sizeBytes: number;
	sha256: string;
	mode: number;
}
export function validateCapturedFiles(files: CapturedFile[]): void {
	if (!Array.isArray(files) || files.length === 0 || files.length > 4096)
		throw Error("Invalid layer file count");
	const names = new Set<string>();
	let total = 0;
	for (const f of files) {
		if (
			typeof f.path !== "string" ||
			f.path.length > 512 ||
			!/^(apt|inputs|build|licenses|recipes)\/[A-Za-z0-9_@+.,=~:/-]+$/.test(
				f.path,
			) ||
			f.path.split("/").some((p) => !p || p === "." || p === "..") ||
			/\.(img|raw|qcow2?|vmdk|vdi|iso)$/i.test(f.path) ||
			names.has(f.path) ||
			!Number.isSafeInteger(f.sizeBytes) ||
			f.sizeBytes < 0 ||
			f.sizeBytes > 4 * 1024 ** 3 ||
			!/^[a-f0-9]{64}$/.test(f.sha256) ||
			![0o644, 0o755].includes(f.mode)
		)
			throw Error("Invalid captured layer member");
		names.add(f.path);
		total += f.sizeBytes;
	}
	if (total > 32 * 1024 ** 3) throw Error("Layer capture size limit exceeded");
}
/** QGA reads are bounded independently of the input's potentially multi-GB size. */
export async function copyCapturedFiles(
	io: GuestIo,
	guestRoot: string,
	output: string,
	files: CapturedFile[],
	signal?: AbortSignal,
): Promise<void> {
	validateCapturedFiles(files);
	if (guestRoot !== "/var/lib/umiak-layer-capture")
		throw Error("Unexpected guest capture root");
	// The caller owns a new private job directory; never merge into a previous capture.
	await mkdir(output, { recursive: false });
	for (const f of files) {
		signal?.throwIfAborted();
		const destination = join(output, f.path);
		await mkdir(dirname(destination), { recursive: true });
		const temporary = `${destination}.part`;
		const file = await open(temporary, "wx", f.mode);
		const hash = createHash("sha256");
		try {
			let offset = 0;
			while (offset < f.sizeBytes) {
				signal?.throwIfAborted();
				const count = Math.min(1024 ** 2, f.sizeBytes - offset);
				const chunk = await io.readFile(
					`${guestRoot}/${f.path}`,
					offset,
					count,
				);
				if (chunk.length === 0 || chunk.length > count)
					throw Error("Captured file size mismatch");
				hash.update(chunk);
				let written = 0;
				while (written < chunk.length) {
					const r = await file.write(chunk, written, chunk.length - written);
					if (r.bytesWritten === 0) throw Error("Layer file write failed");
					written += r.bytesWritten;
				}
				offset += chunk.length;
			}
			if (
				(await io.readFile(`${guestRoot}/${f.path}`, f.sizeBytes, 1)).length !==
					0 ||
				hash.digest("hex") !== f.sha256
			)
				throw Error("Captured file checksum/size mismatch");
			await file.sync();
			await file.close();
			await rename(temporary, destination);
		} catch (error) {
			await file.close();
			await rm(temporary, { force: true });
			throw error;
		}
	}
}
