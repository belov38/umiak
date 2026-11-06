// Layer bytes are opaque tar input here; signed inventory and extraction validate members.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { IMAGE_LIMITS } from "./image-manifest.mjs";
export async function packLayer({
	path,
	outputDir,
	chunkBytes = IMAGE_LIMITS.chunk,
	signal,
}) {
	if (
		!Number.isSafeInteger(chunkBytes) ||
		chunkBytes < 1 ||
		chunkBytes > IMAGE_LIMITS.chunk
	)
		throw Error("Invalid layer chunk size");
	const source = await lstat(path);
	if (
		!source.isFile() ||
		source.size === 0 ||
		source.size > IMAGE_LIMITS.archive
	)
		throw Error("Invalid layer archive source");
	const dir = join(outputDir, "blobs", "sha256");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const zipper = spawn("zstd", ["-q", "-3", "-T1", "-c"], {
		stdio: ["pipe", "pipe", "pipe"],
		signal,
	});
	let diagnostic = "";
	zipper.stderr.on("data", (b) => {
		diagnostic = (diagnostic + b.toString()).slice(-2048);
	});
	const exit = new Promise((resolve, reject) => {
		zipper.on("error", reject);
		zipper.on("close", (code) =>
			code === 0
				? resolve()
				: reject(Error(`zstd exited ${code}: ${diagnostic}`)),
		);
	});
	const rawHash = createHash("sha256"),
		compressedHash = createHash("sha256");
	let rawBytes = 0,
		compressedBytes = 0;
	const input = pipeline(
		createReadStream(path),
		async function* (source) {
			for await (const b of source) {
				rawHash.update(b);
				rawBytes += b.length;
				yield b;
			}
		},
		zipper.stdin,
		{ signal },
	);
	const chunks = [];
	let file,
		part,
		chunkHash,
		chunkSize = 0;
	async function finish() {
		if (!file) return;
		await file.sync();
		await file.close();
		file = undefined;
		const sha256 = chunkHash.digest("hex");
		const dest = join(dir, sha256);
		// Replacing an existing digest is safe: these bytes were just hashed, not trusted by name.
		await rename(part, dest);
		part = undefined;
		chunks.push({ sha256, sizeBytes: chunkSize });
		chunkSize = 0;
	}
	const output = (async () => {
		for await (const b of zipper.stdout) {
			compressedHash.update(b);
			compressedBytes += b.length;
			if (compressedBytes > IMAGE_LIMITS.archive)
				throw Error("Compressed layer too large");
			let offset = 0;
			while (offset < b.length) {
				if (!file) {
					part = join(dir, `.incoming-${randomUUID()}`);
					file = await open(part, "wx", 0o600);
					chunkHash = createHash("sha256");
				}
				const slice = b.subarray(
					offset,
					Math.min(b.length, offset + chunkBytes - chunkSize),
				);
				await file.writeFile(slice);
				chunkHash.update(slice);
				chunkSize += slice.length;
				offset += slice.length;
				if (chunkSize === chunkBytes) await finish();
			}
		}
		await finish();
	})();
	try {
		const stopOnFailure = (promise) =>
			promise.catch((err) => {
				zipper.kill();
				zipper.stdin.destroy();
				zipper.stdout.destroy();
				throw err;
			});
		const results = await Promise.allSettled(
			[input, output, exit].map(stopOnFailure),
		);
		const failure = results.find((r) => r.status === "rejected");
		if (failure) throw failure.reason;
		if (rawBytes !== source.size)
			throw Error("Layer source changed during compression");
		return {
			sizeBytes: rawBytes,
			compressedBytes,
			sha256: compressedHash.digest("hex"),
			rawSha256: rawHash.digest("hex"),
			chunks,
		};
	} finally {
		zipper.kill();
		if (file) await file.close();
		if (part) await rm(part, { force: true });
	}
}
