import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { materializeCapturedApt } from "../src/offline-layer.ts";

const fixture = vi.hoisted(() => ({ packages: [] as unknown[] }));
// Cryptographic verification has separate real-key tests; this fixture exercises capture closure/layout.
vi.mock("../src/offline-apt.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	verifyAptIndex: vi.fn(async () => fixture.packages),
}));
async function capture() {
	const root = await mkdtemp(join(tmpdir(), "umiak-apt-export-"));
	const raw = join(root, "raw"),
		layer = join(root, "layer");
	const repo = "ubuntu-resolute";
	const keyFingerprint = "F6ECB3762474EDA9D21B7022871920D1991BC93C";
	const body = Buffer.from("qga fixture input");
	const sha = createHash("sha256").update(body).digest("hex");
	fixture.packages = [
		{
			name: "qemu-guest-agent",
			version: "1.0",
			arch: "amd64",
			filename: "pool/main/q/qemu/qemu-guest-agent_1.0_amd64.deb",
			sizeBytes: body.length,
			sha256: sha,
			source: "qemu (1.0)",
		},
	];
	const r = join(raw, "inputs/apt-capture", repo);
	await mkdir(join(r, "main/binary-amd64"), { recursive: true });
	await writeFile(join(r, "InRelease"), "fixture signed Release");
	await writeFile(join(r, "archive.asc"), "fixture key");
	await writeFile(join(r, "main/binary-amd64/Packages"), "fixture Packages");
	const path = `inputs/apt-capture/debs/${sha}.deb`;
	await mkdir(join(raw, "inputs/apt-capture/debs"));
	await writeFile(join(raw, path), body);
	const metadata = {
		repositories: [
			{
				name: repo,
				suite: "resolute",
				components: ["main"],
				keyFingerprint,
				indexes: ["main/binary-amd64/Packages"],
			},
		],
		debs: [{ path, sha256: sha, sizeBytes: body.length }],
	};
	const metadataFile = join(raw, "inputs/apt-capture/capture.json");
	await writeFile(metadataFile, JSON.stringify(metadata));
	return { root, raw, layer, metadata, metadataFile, body };
}
it("materializes only approved apt inputs and retains QGA's bootstrap closure", async () => {
	const f = await capture();
	try {
		const result = await materializeCapturedApt({
			rawDirectory: f.raw,
			layerDirectory: f.layer,
			directDebs: new Set(),
		});
		expect(result[0]?.name).toBe("qemu-guest-agent");
		expect(
			await readFile(
				join(
					f.layer,
					"apt/ubuntu-resolute/pool/main/q/qemu/qemu-guest-agent_1.0_amd64.deb",
				),
			),
		).toEqual(f.body);
		expect(
			await readFile(join(f.layer, "apt/offline.sources"), "utf8"),
		).toContain("Signed-By: /mnt/layer/apt/ubuntu-resolute/archive.asc");
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
it("rejects unapproved authorities, escaped indexes, unknown debs and omitted bootstrap dependencies", async () => {
	const f = await capture();
	try {
		const original = structuredClone(f.metadata);
		for (const mutate of [
			() => {
				const repo = f.metadata.repositories[0];
				if (!repo) throw Error("missing fixture repo");
				repo.keyFingerprint = "f".repeat(40);
			},
			() => {
				const repo = f.metadata.repositories[0];
				if (!repo) throw Error("missing fixture repo");
				repo.indexes = ["../escape"];
			},
			() => {
				const deb = f.metadata.debs[0];
				if (!deb) throw Error("missing fixture deb");
				deb.sha256 = "f".repeat(64);
				deb.path = `inputs/apt-capture/debs/${"f".repeat(64)}.deb`;
			},
			() => {
				f.metadata.debs = [];
			},
		]) {
			f.metadata = structuredClone(original);
			mutate();
			await writeFile(f.metadataFile, JSON.stringify(f.metadata));
			await expect(
				materializeCapturedApt({
					rawDirectory: f.raw,
					layerDirectory: f.layer,
					directDebs: new Set(),
				}),
			).rejects.toThrow();
		}
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
