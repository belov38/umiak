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
		format: "umiak-linux-image/v1",
		version: "20261106.1",
		slug: "linux",
		channel: "stable",
		arch: "amd64",
		distro: "fixture",
		release: "1",
		sourceCommit: "a".repeat(40),
		recipeSha256: sha,
		base: { url: "https://example.test/base", serial: "1", sha256: sha },
		aptSnapshot: "20261106T000000Z",
		agent: { version: "1.0.0", sha256: sha },
		builderApi: 1,
		minPlatform: "0.1.0",
		maxPlatform: "1.0.0",
		minAgent: "0.1.0",
		bootTrust: "smbios-ca-sha256-v1",
		hardware: { bios: "seabios", scsihw: "virtio-scsi-single", machine: "q35" },
		disks: [
			{
				slot: "scsi0",
				sizeBytes: 512,
				compressedBytes: 7,
				sha256: sha,
				rawSha256: sha,
				chunks: [{ sha256: sha, sizeBytes: 7 }],
			},
		],
		inventory: { sha256: sha, sizeBytes: 12 },
		verification: { ok: true },
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
test("verifies exact signed bytes and distro-independent framing", () =>
	assert.deepEqual(verified(fixture()), fixture()));
test("rejects invalid signatures, channel and compatibility", () => {
	assert.throws(() => verified(fixture(), { keys: [] }));
	assert.throws(() => verified(fixture(), { signature: Buffer.alloc(64) }));
	assert.throws(() => verified(fixture(), { channel: "edge" }));
	assert.throws(() => verified(fixture(), { platform: "1.0.0" }));
});
for (const [name, mutate] of Object.entries({
	unsafe: (m) => (m.disks[0].sizeBytes = Number.MAX_SAFE_INTEGER),
	chunk: (m) => (m.disks[0].chunks[0].sizeBytes = 536870913),
	total: (m) => (m.disks[0].compressedBytes = 8),
	unknown: (m) => (m.command = "whoami"),
	path: (m) => (m.disks[0].slot = "../x"),
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
