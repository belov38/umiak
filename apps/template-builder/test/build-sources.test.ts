import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const { packages, sources } = vi.hoisted(() => ({
	packages: [] as unknown[],
	sources: [] as unknown[],
}));
vi.mock("../src/offline-apt.ts", () => ({
	verifyAptIndex: vi.fn(async () => packages),
	verifyAptMetadata: vi.fn(async () => {}),
	verifyAptSources: vi.fn(async () => sources),
}));

import { buildSourceCompanion } from "../../../infra/templates/build-sources.mjs";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
afterEach(() => {
	vi.unstubAllGlobals();
	packages.length = 0;
	sources.length = 0;
});
it("collects every indexed source file and maps the deb hash, while excluding Apache Docker payloads", async () => {
	const root = await mkdtemp(join(tmpdir(), "umiak-source-build-"));
	try {
		const layer = join(root, "layer"),
			cache = join(root, "cache"),
			directory = join(root, "sources");
		const binary = Buffer.from("fixture deb"),
			dsc = Buffer.from("original dsc"),
			orig = Buffer.from("original source tar"),
			sourceIndex = Buffer.from("original source index");
		const compressed = execFileSync("xz", ["-zc"], { input: sourceIndex });
		const sourceFiles = [
			{
				filename: "pool/main/f/fixture/fixture_1.dsc",
				sha256: hash(dsc),
				sizeBytes: dsc.length,
			},
			{
				filename: "pool/main/f/fixture/fixture_1.orig.tar.xz",
				sha256: hash(orig),
				sizeBytes: orig.length,
			},
		];
		packages.push({
			name: "fixture",
			version: "1",
			source: "fixture",
			sha256: hash(binary),
		});
		sources.push({ name: "fixture", version: "1", files: sourceFiles });
		const save = async (path: string, data: Buffer | string) => {
			await mkdir(dirname(join(layer, path)), { recursive: true });
			await writeFile(join(layer, path), data);
		};
		await save(
			"apt/ubuntu-resolute/dists/resolute/InRelease",
			`SHA256:\n ${hash(compressed)} ${compressed.length} main/source/Sources.xz\n`,
		);
		await save("apt/ubuntu-resolute/archive.asc", "fixture authority");
		await save(
			"apt/ubuntu-resolute/dists/resolute/main/binary-amd64/Packages",
			"fixture packages",
		);
		await save("inputs/fetch.jsonl", "");
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			requests.push(String(url));
			if (String(url).endsWith("Sources.xz")) return new Response(compressed);
			if (String(url).endsWith("fixture_1.dsc")) return new Response(dsc);
			if (String(url).endsWith("fixture_1.orig.tar.xz"))
				return new Response(orig);
			throw Error(`Unexpected archive access: ${url}`);
		});
		const result = await buildSourceCompanion({
			capture: {
				directory: layer,
				recipe: { slug: "linux" },
				aptSnapshot: "20261030T000000Z",
				files: [
					{
						path: "apt/ubuntu-resolute/pool/main/f/fixture/fixture_1_amd64.deb",
						sha256: hash(binary),
					},
					{
						path: "apt/docker-resolute/dists/resolute/pool/stable/amd64/docker.deb",
						sha256: "a".repeat(64),
					},
				],
			},
			cache,
			directory,
			version: "20261106.1",
			sourceCommit: "b".repeat(40),
		});
		expect(result.mapping[0]).toMatchObject({
			binarySha256: hash(binary),
			sourcePackage: "fixture",
			sourceVersion: "1",
			sources: sourceFiles.map((f) => `apt/ubuntu-resolute/${f.filename}`),
		});
		expect(result.dockerBinaries).toHaveLength(1);
		expect(
			requests.every((u) =>
				u.startsWith("https://snapshot.ubuntu.com/ubuntu/20261030T000000Z/"),
			),
		).toBe(true);
		const index = JSON.parse(
			await readFile(join(directory, "index.json"), "utf8"),
		);
		expect(index.manifests[0].digest).toBe(result.reference.digest);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
