import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
	imageObjectUrl,
	verifyImageManifest,
	verifyImagePointer,
} from "./image-manifest.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const sha = createHash("sha256").update("fixture").digest("hex");
function fixture() {
	return {
		format: "umiak-linux-layer/v1",
		version: "20261106.1",
		slug: "linux",
		channel: "stable",
		arch: "amd64",
		distro: "ubuntu",
		release: "26.04",
		sourceCommit: "a".repeat(40),
		recipeSha256: sha,
		base: {
			url: "https://cloud-images.ubuntu.com/minimal/releases/resolute/release-20261024/ubuntu-26.04-minimal-cloudimg-amd64.img",
			serial: "20261024",
			sha256: sha,
		},
		aptSnapshot: "20261106T000000Z",
		agent: { version: "1.0.0", sha256: sha },
		builderApi: 1,
		minPlatform: "0.1.0",
		maxPlatform: "1.0.0",
		minAgent: "0.1.0",
		bootTrust: "smbios-ca-sha256-v1",
		archive: {
			sizeBytes: 10240,
			compressedBytes: 7,
			sha256: sha,
			rawSha256: sha,
			chunks: [{ sha256: sha, sizeBytes: 7 }],
		},
		files: [{ path: "build/recipe.sh", sizeBytes: 12, sha256: sha, mode: 420 }],
		inventory: { sha256: sha, sizeBytes: 12 },
		verification: { ok: true, offlineReplay: true },
	};
}
function verified(m, opts = {}) {
	const bytes = Buffer.from(JSON.stringify(m));
	return verifyImageManifest({
		bytes,
		signature: sign(null, bytes, privateKey),
		keys: [publicKey],
		platform: "0.1.0",
		agent: "0.1.0",
		channel: "stable",
		slug: "linux",
		...opts,
	});
}
test("verifies exact signed bytes and offline layer identity", () =>
	assert.deepEqual(verified(fixture()), fixture()));
test("rejects invalid signatures, channel and compatibility", () => {
	assert.throws(() => verified(fixture(), { keys: [] }));
	assert.throws(() => verified(fixture(), { signature: Buffer.alloc(64) }));
	assert.throws(() => verified(fixture(), { channel: "edge" }));
	assert.throws(() => verified(fixture(), { platform: "1.0.0" }));
});
for (const [name, mutate] of Object.entries({
	unsafe: (m) => (m.archive.sizeBytes = Number.MAX_SAFE_INTEGER),
	chunk: (m) => (m.archive.chunks[0].sizeBytes = 536870913),
	total: (m) => (m.archive.compressedBytes = 8),
	unknown: (m) => (m.command = "whoami"),
	path: (m) => (m.files[0].path = "../x"),
	unchecked: (m) => (m.verification.ok = false),
}))
	test(`rejects ${name}`, () => {
		const m = fixture();
		mutate(m);
		assert.throws(() => verified(m));
	});
test("rejects duplicate JSON fields rather than parser-dependent interpretation", () => {
	const bytes = Buffer.from(
		JSON.stringify(fixture()).replace(
			'"arch":"amd64"',
			'"arch":"arm64","arch":"amd64"',
		),
	);
	assert.throws(() =>
		verifyImageManifest({
			bytes,
			signature: sign(null, bytes, privateKey),
			keys: [publicKey],
			platform: "0.1.0",
			agent: "0.1.0",
			channel: "stable",
			slug: "linux",
		}),
	);
});
test("pointer binds both product slugs, channel and monotonic sequence", () => {
	const m = {
		format: "umiak-linux-channel/v1",
		channel: "stable",
		sequence: 2,
		version: "20261106.1",
		images: { linux: sha, "linux-desktop": sha },
	};
	const bytes = Buffer.from(JSON.stringify(m));
	const opts = {
		bytes,
		signature: sign(null, bytes, privateKey),
		keys: [publicKey],
		channel: "stable",
		minimumSequence: 2,
	};
	assert.deepEqual(verifyImagePointer(opts), m);
	assert.throws(() => verifyImagePointer({ ...opts, minimumSequence: 3 }));
	assert.throws(() => verifyImagePointer({ ...opts, channel: "edge" }));
});
test("object URLs cannot escape configured HTTPS origin", () => {
	assert.equal(
		imageObjectUrl("https://example.test/images/", `blobs/sha256/${sha}`),
		`https://example.test/images/blobs/sha256/${sha}`,
	);
	for (const key of [
		"../x",
		"https://evil.test/x",
		"//evil.test",
		"blobs/%2e%2e/x",
	])
		assert.throws(() => imageObjectUrl("https://example.test/", key));
	assert.throws(() =>
		imageObjectUrl("http://example.test/", `blobs/sha256/${sha}`),
	);
});

test("rejects any rehosted base, modified disk contract or incomplete offline proof", () => {
	for (const change of [
		(m) => (m.base.url = "https://evil.test/base.img"),
		(m) => (m.format = "umiak-linux-image/v1"),
		(m) => (m.verification.offlineReplay = false),
		(m) => m.files.push({ ...m.files[0] }),
	]) {
		const m = fixture();
		change(m);
		assert.throws(() => verified(m));
	}
});
