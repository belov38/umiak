import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
	publishLayerArtifacts,
	signLayerMetadata,
	signLayerPointer,
	validateReleaseRequest,
} from "./release-layers.mjs";
import { layerFixture } from "./testdata/layers/fixture.mjs";

const keys = generateKeyPairSync("ed25519");
const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const key = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const draft = () => layerFixture();
test("signs compact metadata with only the configured recipe authority after replay proof", () => {
	const m = draft();
	const signed = signLayerMetadata({
		manifest: m,
		key,
		publicKey: pub,
		proof: { ok: true, offlineReplay: true },
	});
	assert.equal(signed.bytes.toString(), JSON.stringify(m));
	assert.equal(signed.signature.length, 64);
	assert.throws(
		() =>
			signLayerMetadata({
				manifest: m,
				key,
				publicKey: generateKeyPairSync("ed25519").publicKey.export({
					type: "spki",
					format: "pem",
				}),
				proof: { ok: true, offlineReplay: true },
			}),
		/authority/,
	);
	assert.throws(
		() =>
			signLayerMetadata({
				manifest: m,
				key,
				publicKey: pub,
				proof: { ok: true, offlineReplay: false },
			}),
		/offline/,
	);
	m.files.push({
		path: "inputs/modified-base.qcow2",
		sha256: "a".repeat(64),
		sizeBytes: 1,
		mode: 420,
	});
	assert.throws(() =>
		signLayerMetadata({
			manifest: m,
			key,
			publicKey: pub,
			proof: { ok: true, offlineReplay: true },
		}),
	);
});
test("pointer binds both verified product manifests with a strictly advancing sequence", () => {
	const m = draft();
	const a = signLayerMetadata({
		manifest: m,
		key,
		publicKey: pub,
		proof: { ok: true, offlineReplay: true },
	});
	const result = signLayerPointer({
		channel: m.channel,
		version: m.version,
		sequence: 3,
		previousSequence: 2,
		images: { linux: a.bytes, "linux-desktop": a.bytes },
		key,
		publicKey: pub,
	});
	assert.equal(
		JSON.parse(result.bytes).images.linux,
		createHash("sha256").update(a.bytes).digest("hex"),
	);
	assert.throws(
		() =>
			signLayerPointer({
				channel: m.channel,
				version: m.version,
				sequence: 2,
				previousSequence: 2,
				images: { linux: a.bytes, "linux-desktop": a.bytes },
				key,
				publicKey: pub,
			}),
		/sequence/,
	);
});
test("public upload requires an explicit reviewed SHA and stable requires main", () => {
	const o = {
		publish: false,
		channel: "edge",
		version: "20261106.1-edge.20261106.1",
		sourceCommit: "a".repeat(40),
		ref: "refs/heads/s25-prebuilt-images",
	};
	validateReleaseRequest(o);
	assert.throws(
		() => validateReleaseRequest({ ...o, publish: true }),
		/reviewed/,
	);
	validateReleaseRequest({ ...o, publish: true, approvedSha: o.sourceCommit });
	assert.throws(
		() =>
			validateReleaseRequest({
				...o,
				publish: true,
				approvedSha: o.sourceCommit,
				channel: "stable",
				version: "20261106.1",
			}),
		/main/,
	);
});
test("both immutable artifacts pass anonymous readback before either channel advances", async () => {
	const events = [];
	const artifacts = [
		{
			slug: "linux",
			kind: "sources",
			repository: "belov38/umiak-linux-layer-sources",
			directory: "fixture",
		},
		{
			slug: "linux-desktop",
			kind: "sources",
			repository: "belov38/umiak-linux-desktop-layer-sources",
			directory: "fixture",
		},
		{
			slug: "linux",
			repository: "belov38/umiak-linux-layer",
			directory: "fixture",
		},
		{
			slug: "linux-desktop",
			repository: "belov38/umiak-linux-desktop-layer",
			directory: "fixture",
		},
	];
	await publishLayerArtifacts({
		publish: true,
		artifacts,
		version: "20261106.1",
		channel: "stable",
		upload: async (a) =>
			events.push(`upload:${a.slug}${a.kind ? "-sources" : ""}`),
		readback: async (a) =>
			events.push(`read:${a.slug}${a.kind ? "-sources" : ""}`),
		promote: async (a) => events.push(`promote:${a.slug}`),
	});
	assert.deepEqual(events, [
		"upload:linux-sources",
		"read:linux-sources",
		"upload:linux-desktop-sources",
		"read:linux-desktop-sources",
		"upload:linux",
		"read:linux",
		"upload:linux-desktop",
		"read:linux-desktop",
		"promote:linux",
		"promote:linux-desktop",
	]);
	events.length = 0;
	await assert.rejects(
		publishLayerArtifacts({
			publish: true,
			artifacts,
			version: "x",
			channel: "edge",
			upload: async (a) =>
				events.push(`upload:${a.slug}${a.kind ? "-sources" : ""}`),
			readback: async () => {
				throw Error("private package");
			},
			promote: async () => events.push("promote"),
		}),
		/private/,
	);
	assert.ok(!events.includes("promote"));
	events.length = 0;
	await publishLayerArtifacts({
		publish: false,
		artifacts,
		upload: async () => events.push("upload"),
	});
	assert.deepEqual(events, []);
});
