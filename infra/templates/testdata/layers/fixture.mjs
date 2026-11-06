import { createHash } from "node:crypto";

const sha = createHash("sha256").update("fixture").digest("hex");
export function layerFixture() {
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
		files: [
			{ path: "build/recipe.sh", sizeBytes: 12, sha256: sha, mode: 420 },
			{
				path: "licenses/inventory.json",
				sizeBytes: 12,
				sha256: sha,
				mode: 420,
			},
		],
		sources: {
			repository: "belov38/umiak-linux-layer-sources",
			digest: `sha256:${sha}`,
		},
		inventory: { sha256: sha, sizeBytes: 12 },
		verification: { ok: true, offlineReplay: true },
	};
}
