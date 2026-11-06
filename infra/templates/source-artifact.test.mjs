import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureSourceFile, writeSourceLayout } from "./source-artifact.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
test("source files split at stable boundaries and cached chunks are re-verified without re-downloading", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-source-chunks-"));
	try {
		const body = Buffer.from("unchanged source bytes");
		let downloads = 0;
		const options = {
			url: "https://sources.invalid/source.tar.xz",
			sha256: sha(body),
			sizeBytes: body.length,
			cache: dir,
			chunkBytes: 7,
			fetcher: async () => {
				downloads++;
				return new Response(body);
			},
		};
		const a = await captureSourceFile(options),
			b = await captureSourceFile(options);
		assert.deepEqual(a, b);
		assert.equal(downloads, 1);
		assert.equal(a.chunks.length, 4);
		const layout = join(dir, "layout");
		const result = await writeSourceLayout({
			directory: layout,
			cache: dir,
			version: "20261106.1",
			slug: "linux",
			sourceCommit: "b".repeat(40),
			files: [{ ...a, path: "pool/source.tar.xz" }],
			mapping: [
				{ binarySha256: "c".repeat(64), sources: ["pool/source.tar.xz"] },
			],
		});
		const manifest = await readFile(
			join(layout, "blobs/sha256", result.digest.slice(7)),
		);
		assert.equal(sha(manifest), result.digest.slice(7));
		assert.equal(
			JSON.parse(manifest).artifactType,
			"application/vnd.umiak.linux-sources.v1",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("source capture rejects altered size/hash before a companion can be published", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-source-tamper-"));
	try {
		await assert.rejects(
			captureSourceFile({
				url: "https://sources.invalid/source.dsc",
				sha256: "a".repeat(64),
				sizeBytes: 1,
				cache: dir,
				fetcher: async () => new Response("x"),
				wait: async () => {},
			}),
			/hash|checksum/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
