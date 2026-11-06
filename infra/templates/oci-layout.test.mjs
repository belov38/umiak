import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AnonymousOCI, LAYER_ARTIFACT_TYPE } from "./oci.mjs";

const exec = promisify(execFile);
test("ORAS 1.3.6 emits the exact titled OCI layers consumed by anonymous installs", {
	skip: !process.env.CI && !process.env.UMIAK_ORAS_TEST_BINARY,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "umiak-oras-layout-"));
	try {
		await writeFile(join(root, "channel.json"), "{}");
		await writeFile(join(root, "chunk-0000.zst"), "fixture compressed bytes");
		await exec(
			process.env.UMIAK_ORAS_TEST_BINARY || "oras",
			[
				"push",
				"--image-spec",
				"v1.1",
				"--artifact-type",
				LAYER_ARTIFACT_TYPE,
				"--oci-layout",
				`${join(root, "layout")}:edge`,
				"channel.json:application/octet-stream",
				"chunk-0000.zst:application/vnd.umiak.layer.chunk.v1+zstd",
				"--registry-config",
				join(root, "auth.json"),
			],
			{ cwd: root },
		);
		const index = JSON.parse(
			await readFile(join(root, "layout/index.json"), "utf8"),
		);
		const manifestDigest = index.manifests[0].digest.split(":")[1];
		const client = new AnonymousOCI({
			registry: "https://layout.invalid",
			repository: "fixture/layer",
			fetcher: async (url) => {
				const path = new URL(url).pathname;
				const digest = path.endsWith("/manifests/edge")
					? manifestDigest
					: path.split("sha256:")[1];
				if (!/^[a-f0-9]{64}$/.test(digest))
					throw Error("unexpected registry request");
				return new Response(
					await readFile(join(root, "layout/blobs/sha256", digest)),
				);
			},
		});
		const manifest = await client.manifest("edge");
		assert.equal(manifest.layers.length, 2);
		const channel = manifest.layers.find(
			(l) =>
				l.annotations?.["org.opencontainers.image.title"] === "channel.json",
		);
		assert.equal(
			(await client.blob(channel.digest.slice(7), channel.size)).toString(),
			"{}",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("source companion OCI digests survive ORAS copy and authenticate reconstructed source bytes", {
	skip: !process.env.CI && !process.env.UMIAK_ORAS_TEST_BINARY,
}, async () => {
	const { captureSourceFile, writeSourceLayout } = await import(
		"./source-artifact.mjs"
	);
	const { assertAnonymousSources } = await import("./release-layers.mjs");
	const { createHash } = await import("node:crypto");
	const root = await mkdtemp(join(tmpdir(), "umiak-oras-sources-"));
	try {
		const bytes = Buffer.from("original upstream source bytes");
		const file = await captureSourceFile({
			url: "https://sources.invalid/fixture.tar.xz",
			sha256: createHash("sha256").update(bytes).digest("hex"),
			sizeBytes: bytes.length,
			cache: join(root, "cache"),
			chunkBytes: 11,
			fetcher: async () => new Response(bytes),
		});
		const layout = join(root, "sources");
		const reference = await writeSourceLayout({
			directory: layout,
			cache: join(root, "cache"),
			version: "20261106.1",
			slug: "linux",
			sourceCommit: "b".repeat(40),
			files: [{ ...file, path: "pool/fixture.tar.xz" }],
			mapping: [
				{ binarySha256: "c".repeat(64), sources: ["pool/fixture.tar.xz"] },
			],
		});
		await exec(process.env.UMIAK_ORAS_TEST_BINARY || "oras", [
			"copy",
			"--from-oci-layout",
			`${layout}:20261106.1`,
			"--to-oci-layout",
			`${join(root, "copied")}:20261106.1`,
			"--to-registry-config",
			join(root, "auth.json"),
		]);
		const index = JSON.parse(await readFile(join(root, "copied/index.json")));
		assert.equal(index.manifests[0].digest, reference.digest);
		await assertAnonymousSources(reference, {
			registry: "https://layout.invalid",
			fetcher: async (url) => {
				const path = new URL(url).pathname;
				const digest = path.split("sha256:")[1];
				if (!/^[a-f0-9]{64}$/.test(digest))
					throw Error("unexpected registry request");
				return new Response(
					await readFile(join(root, "copied/blobs/sha256", digest)),
				);
			},
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
