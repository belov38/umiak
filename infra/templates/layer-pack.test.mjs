import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packLayer } from "./layer-pack.mjs";

test("tar zstd chunks round-trip with archive hash and bounded chunks", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-pack-"));
	try {
		const raw = Buffer.alloc(1024 * 1024);
		for (let i = 0; i < raw.length; i++) raw[i] = (i * 31) % 251;
		await writeFile(join(dir, "layer.tar"), raw);
		const disk = await packLayer({
			path: join(dir, "layer.tar"),
			outputDir: dir,
			chunkBytes: 128,
		});
		assert.equal(disk.sizeBytes, raw.length);
		assert.ok(disk.chunks.length > 1);
		const chunks = [];
		for (const c of disk.chunks) {
			const bytes = await readFile(join(dir, "blobs", "sha256", c.sha256));
			assert.equal(bytes.length, c.sizeBytes);
			assert.ok(bytes.length <= 128);
			assert.equal(createHash("sha256").update(bytes).digest("hex"), c.sha256);
			chunks.push(bytes);
		}
		const compressed = Buffer.concat(chunks);
		assert.equal(
			disk.sha256,
			createHash("sha256").update(compressed).digest("hex"),
		);
		assert.equal(disk.compressedBytes, compressed.length);
		const decoded = execFileSync("zstd", ["-d", "-q", "-c"], {
			input: compressed,
			maxBuffer: raw.length + 1024,
		});
		assert.deepEqual(decoded, raw);
		assert.equal(
			disk.rawSha256,
			createHash("sha256").update(decoded).digest("hex"),
		);
		assert.deepEqual(
			await packLayer({
				path: join(dir, "layer.tar"),
				outputDir: dir,
				chunkBytes: 128,
			}),
			disk,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("refuses empty sources and invalid chunk limits", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-pack-"));
	try {
		const path = join(dir, "layer.tar");
		await writeFile(path, "");
		await assert.rejects(packLayer({ path, outputDir: dir }));
		await assert.rejects(packLayer({ path, outputDir: dir, chunkBytes: 0 }));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
