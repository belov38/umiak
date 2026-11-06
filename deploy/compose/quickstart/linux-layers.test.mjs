import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { offlineFixtureInput } from "../../../apps/template-builder/test/offline-fixture.ts";
import { fetchLinuxLayer } from "./linux-layers.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function source() {
	const input = offlineFixtureInput("a".repeat(64), {
		kernel: "test",
		systemd: "systemd259",
		packages: { bash: "5.3" },
		tools: { claude: null },
	});
	// Sign both channel and manifest with one ephemeral test publisher.
	const key = generateKeyPairSync("ed25519");
	input.keys = [
		key.publicKey.export({ type: "spki", format: "pem" }).toString(),
	];
	input.signature = sign(null, input.bytes, key.privateKey);
	const metadata = JSON.parse(input.bytes),
		digest = hash(input.bytes);
	const pointer = Buffer.from(
		JSON.stringify({
			format: "umiak-linux-channel/v1",
			channel: "stable",
			sequence: 2,
			version: metadata.version,
			images: { linux: digest, "linux-desktop": "b".repeat(64) },
		}),
	);
	const objects = new Map();
	const blobs = new Map([
		["channel.json", pointer],
		["channel.sig", sign(null, pointer, key.privateKey)],
		["manifest.json", input.bytes],
		["manifest.sig", input.signature],
		["layer-recipe.json", input.descriptor],
		["verify.sh", input.verifyScript],
		["chunk.zst", Buffer.from("fixture")],
	]);
	const layers = [];
	for (const [title, body] of blobs) {
		const digest = hash(body);
		objects.set(`v2/fixture/linux/blobs/sha256:${digest}`, body);
		layers.push({
			mediaType: "application/octet-stream",
			digest: `sha256:${digest}`,
			size: body.length,
			annotations: { "org.opencontainers.image.title": title },
		});
	}
	const artifact = {
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		artifactType: "application/vnd.umiak.linux-layer.v1",
		layers,
	};
	objects.set(
		"v2/fixture/linux/manifests/stable",
		Buffer.from(JSON.stringify(artifact)),
	);
	const calls = [];
	const fetcher = async (url, init) => {
		calls.push({ url, init });
		const body = objects.get(new URL(url).pathname.slice(1));
		return new Response(body ?? "missing", { status: body ? 200 : 404 });
	};

	return {
		input,
		pointer,
		objects,
		calls,
		options: {
			registry: "https://layers.invalid",
			repository: "fixture/linux",
			keys: input.keys,
			channel: "stable",
			slug: "linux",
			platform: "0.1.0",
			agent: "0.1.0",
			fetcher,
		},
	};
}
test("downloads signed control artifacts anonymously and binds the exact recipe/base without private GitHub auth", async () => {
	const s = source();
	const release = await fetchLinuxLayer(s.options);
	assert.equal(release.layer.manifest.slug, "linux");
	assert.equal(release.sequence, 2);
	assert.ok(s.calls.every((c) => !c.init.headers?.Authorization));
	assert.ok(s.calls.every((c) => new URL(c.url).hostname === "layers.invalid"));
	assert.equal(release.envelope.manifest, s.input.bytes.toString("base64"));
});
test("rejects rollback, altered metadata and missing releases before a node build starts", async () => {
	const s = source();
	await assert.rejects(
		fetchLinuxLayer({ ...s.options, minimumSequence: 3 }),
		/rollback/i,
	);
	const file = `v2/fixture/linux/blobs/sha256:${hash(s.input.bytes)}`;
	s.objects.set(file, Buffer.from("{}"));
	await assert.rejects(fetchLinuxLayer(s.options), /digest|hash/i);
	s.objects.clear();
	await assert.rejects(
		fetchLinuxLayer(s.options),
		/not published|not available/i,
	);
});

test("vendor rebuild re-verifies its cached release without registry requests", async () => {
	const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { cacheLinuxLayer, cachedLinuxLayer } = await import(
		"./linux-layers.mjs"
	);
	const directory = await mkdtemp(join(tmpdir(), "umiak-layer-retry-"));
	try {
		const sourceFixture = source();
		const release = await fetchLinuxLayer(sourceFixture.options);
		const file = await cacheLinuxLayer(release, directory);
		const options = {
			secretsDir: directory,
			manifestSha256: release.layer.manifestSha256,
			keys: sourceFixture.input.keys,
			slug: "linux",
			channel: "stable",
		};
		const cached = cachedLinuxLayer(options);
		assert.equal(cached.layer.manifestSha256, release.layer.manifestSha256);
		assert.equal(cached.file, file);
		await writeFile(
			file,
			JSON.stringify({
				...release.envelope,
				signature: Buffer.alloc(64).toString("base64"),
			}),
		);
		assert.throws(() => cachedLinuxLayer(options), /signature/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
