import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const { packages, sources, sourceComponents } = vi.hoisted(() => ({
	packages: [] as unknown[],
	sources: [] as unknown[],
	sourceComponents: new Map<string, unknown[]>(),
}));
vi.mock(
	"../../../infra/templates/source-artifact.mjs",
	async (importOriginal) => {
		const actual = await importOriginal<{
			captureSourceFile: (options: Record<string, unknown>) => Promise<unknown>;
		}>();
		return {
			...actual,
			// Keep source fixtures hermetic after production switched from fetch to raw HTTPS.
			captureSourceFile: (options: Record<string, unknown>) =>
				actual.captureSourceFile({
					...options,
					fetcher: options.fetcher ?? fetch,
				}),
		};
	},
);
vi.mock("../../../infra/templates/linux-source-subset.mjs", () => ({
	deriveLinuxSourceSubset: vi.fn(async ({ source, commit }) => ({
		...source,
		sha256: "f".repeat(64),
		originalArchive: { sha256: source.sha256, commit },
		derivation: {
			reconstructionVerified: true,
			excludedSALPaths: ["src/platform/windows/driver/"],
		},
	})),
}));
vi.mock("../src/offline-apt.ts", () => ({
	verifyAptIndex: vi.fn(async () => packages),
	verifyAptMetadata: vi.fn(async () => {}),
	verifyAptSources: vi.fn(
		async ({ indexPath }) => sourceComponents.get(indexPath) ?? sources,
	),
}));

import { buildSourceCompanion } from "../../../infra/templates/build-sources.mjs";
import { deriveLinuxSourceSubset } from "../../../infra/templates/linux-source-subset.mjs";
import { verifyAptMetadata, verifyAptSources } from "../src/offline-apt.ts";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
afterEach(() => {
	vi.unstubAllGlobals();
	packages.length = 0;
	sources.length = 0;
	sourceComponents.clear();
	vi.clearAllMocks();
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
it("keeps the original Sunshine archive while excluding unrelated Windows SDK gitlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "umiak-source-platforms-"));
	try {
		const layer = join(root, "layer");
		await mkdir(join(layer, "build"), { recursive: true });
		await mkdir(join(layer, "inputs"));
		await writeFile(
			join(layer, "build/layer-recipe.json"),
			JSON.stringify({
				versions: {
					desktop: {
						sunshine: { version: "1" },
						moonlight_web: { version: "2" },
					},
				},
			}),
		);
		await writeFile(
			join(layer, "inputs/fetch.jsonl"),
			[
				{
					url: "https://github.com/LizardByte/Sunshine/releases/download/v1/sunshine.deb",
					sha256: "a".repeat(64),
				},
				{
					url: "https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/v2/moonlight.tar.gz",
					sha256: "b".repeat(64),
				},
			]
				.map((x) => JSON.stringify(x))
				.join("\n"),
		);
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			const u = String(url);
			requests.push(u);
			if (/NVIDIA|ViGEmClient/.test(u))
				throw Error("Non-Linux source must not be fetched");
			if (u.includes("/git/ref/tags/"))
				return Response.json({
					object: { type: "commit", sha: "c".repeat(40) },
				});
			if (u.includes("/git/trees/"))
				return Response.json({
					truncated: false,
					tree: u.includes("Sunshine")
						? [
								"third-party/nvapi",
								"third-party/libvirtualhid",
								"third-party/ViGEmClient",
							].map((path) => ({ mode: "160000", path, sha: "d".repeat(40) }))
						: [],
				});
			if (u.startsWith("https://raw.githubusercontent.com/"))
				return new Response(
					'[submodule "hid"]\n path = third-party/libvirtualhid\n url = https://github.com/LizardByte/libvirtualhid.git\n',
				);
			if (u.startsWith("https://codeload.github.com/"))
				return new Response("original source archive fixture");
			return Response.json({ private: false, license: { spdx_id: "GPL-3.0" } });
		});
		const result = await buildSourceCompanion({
			capture: {
				directory: layer,
				recipe: { slug: "linux-desktop" },
				aptSnapshot: "20261030T000000Z",
				files: [],
			},
			cache: join(root, "cache"),
			directory: join(root, "sources"),
			version: "20261106.1",
			sourceCommit: "e".repeat(40),
		});
		expect(result.mapping).toHaveLength(2);
		expect(result.mapping[0]).toMatchObject({
			binarySha256: "a".repeat(64),
			binaryName: "Sunshine",
			binaryVersion: "1",
			sourceCommit: "c".repeat(40),
			role: ["upstream-release", "packaging-source"],
			sources: expect.arrayContaining([
				`upstream/Sunshine/${"c".repeat(40)}.tar.gz`,
			]),
		});
		const oci = JSON.parse(
			await readFile(
				join(root, "sources/blobs/sha256", result.reference.digest.slice(7)),
				"utf8",
			),
		);
		const companion = JSON.parse(
			await readFile(
				join(root, "sources/blobs/sha256", oci.layers[0].digest.slice(7)),
				"utf8",
			),
		);
		expect(companion.mapping).toEqual(result.mapping);
		expect(
			companion.files.find(
				(file: { path: string }) => file.path === result.mapping[0]?.sources[0],
			),
		).toMatchObject({
			repository: "LizardByte/Sunshine",
			commit: "c".repeat(40),
			sha256: hash(Buffer.from("original source archive fixture")),
		});
		expect(deriveLinuxSourceSubset).toHaveBeenCalledWith(
			expect.objectContaining({ commit: "d".repeat(40) }),
		);
		expect(
			result.mapping[0]?.sources.some((p) => p.endsWith("-linux-mit.tar.gz")),
		).toBe(true);
		expect(result.sourceSubsets).toEqual([
			expect.objectContaining({
				originalArchive: expect.objectContaining({ commit: "d".repeat(40) }),
				derivation: expect.objectContaining({ reconstructionVerified: true }),
			}),
		]);
		expect(
			requests.filter((u) => u.startsWith("https://codeload.github.com/")),
		).toHaveLength(3);
		expect(
			requests.some((url) => url.includes("/LizardByte/libvirtualhid")),
		).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function crossComponentSource(
	scenario: "exact" | "missing" | "wrong-version",
) {
	const root = await mkdtemp(join(tmpdir(), "umiak-cross-component-source-"));
	try {
		const layer = join(root, "layer"),
			directory = join(root, "sources"),
			cache = join(root, "cache");
		const suite = "resolute-updates",
			repo = "ubuntu-resolute-updates",
			version = "1:1.3.dfsg+really1.3.1-1ubuntu3.2";
		const indexBytes = {
			universe: Buffer.from("universe source fixture"),
			main: Buffer.from("main source fixture"),
		};
		const compressed = Object.fromEntries(
			Object.entries(indexBytes).map(([component, bytes]) => [
				component,
				execFileSync("xz", ["-zc"], { input: bytes }),
			]),
		);
		const dsc = Buffer.from("original zlib dsc"),
			original = Buffer.from("original zlib source");
		const sourceFiles = [
			{
				filename: "pool/main/z/zlib/zlib_1.3.dfsg+really1.3.1-1ubuntu3.2.dsc",
				sha256: hash(dsc),
				sizeBytes: dsc.length,
			},
			{
				filename: "pool/main/z/zlib/zlib_1.3.dfsg+really1.3.1.orig.tar.xz",
				sha256: hash(original),
				sizeBytes: original.length,
			},
		];
		sourceComponents.set("universe/source/Sources", [
			{ name: "unrelated", version, files: sourceFiles },
		]);
		sourceComponents.set(
			"main/source/Sources",
			scenario === "missing"
				? []
				: [
						{
							name: "zlib",
							version:
								scenario === "wrong-version"
									? "1:1.3.dfsg+really1.3.1-1ubuntu3.1"
									: version,
							files: sourceFiles,
						},
					],
		);
		const binaries = ["zlib1g", "zlib1g-udeb"].map((name) => ({
			name,
			version,
			source: "zlib",
			sha256: hash(Buffer.from(name)),
		}));
		packages.push(...binaries);
		const save = async (path: string, bytes: string | Buffer) => {
			await mkdir(dirname(join(layer, path)), { recursive: true });
			await writeFile(join(layer, path), bytes);
		};
		await save(
			`apt/${repo}/dists/${suite}/InRelease`,
			"SHA256:\n" +
				Object.entries(compressed)
					.map(
						([component, b]) =>
							` ${hash(b)} ${b.length} ${component}/source/Sources.xz\n`,
					)
					.join(""),
		);
		await save(`apt/${repo}/archive.asc`, "fixture authority");
		await save(
			`apt/${repo}/dists/${suite}/universe/binary-amd64/Packages`,
			"fixture Packages",
		);
		await save("inputs/fetch.jsonl", "");
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			requests.push(String(url));
			const component = String(url).match(
				/\/(universe|main)\/source\/Sources\.xz$/,
			)?.[1];
			if (component) return new Response(compressed[component]);
			if (String(url).endsWith(".dsc")) return new Response(dsc);
			if (String(url).endsWith(".orig.tar.xz")) return new Response(original);
			throw Error(`Unexpected source access: ${url}`);
		});
		const build = buildSourceCompanion({
			capture: {
				directory: layer,
				recipe: { slug: "linux" },
				aptSnapshot: "20261030T000000Z",
				files: binaries.map((b) => ({
					path: `apt/${repo}/pool/universe/z/zlib/${b.name}_amd64.deb`,
					sha256: b.sha256,
				})),
			},
			cache,
			directory,
			version: "20261106.1",
			sourceCommit: "b".repeat(40),
		});
		if (scenario !== "exact") {
			await expect(build).rejects.toThrow(
				`Exact source package missing from pinned index: zlib ${version}`,
			);
			expect(requests).toHaveLength(2);
		} else {
			const result = await build;
			expect(result.mapping).toHaveLength(2);
			for (const mapping of result.mapping)
				expect(mapping).toMatchObject({
					sourcePackage: "zlib",
					sourceVersion: version,
					sources: sourceFiles.map((f) => `apt/${repo}/${f.filename}`),
				});
			const index = JSON.parse(
				await readFile(join(directory, "index.json"), "utf8"),
			);
			const manifest = JSON.parse(
				await readFile(
					join(directory, "blobs/sha256", index.manifests[0].digest.slice(7)),
					"utf8",
				),
			);
			const metadata = manifest.layers.find(
				(l: { annotations: Record<string, string> }) =>
					l.annotations["org.opencontainers.image.title"] ===
					"source-manifest.json",
			);
			const body = JSON.parse(
				await readFile(
					join(directory, "blobs/sha256", metadata.digest.slice(7)),
					"utf8",
				),
			);
			for (const component of ["universe", "main"])
				expect(
					body.files.filter(
						(f: { path: string }) =>
							f.path === `verification/${repo}/${component}/source/Sources`,
					),
				).toHaveLength(1);
		}
		expect(requests.slice(0, 2).map((url) => new URL(url).pathname)).toEqual([
			`/ubuntu/20261030T000000Z/dists/${suite}/universe/source/Sources.xz`,
			`/ubuntu/20261030T000000Z/dists/${suite}/main/source/Sources.xz`,
		]);
		for (const component of ["universe", "main"]) {
			expect(
				requests.filter((url) =>
					url.endsWith(`/${component}/source/Sources.xz`),
				),
			).toHaveLength(1);
			expect(
				vi
					.mocked(verifyAptMetadata)
					.mock.calls.filter(
						([o]) => o.indexPath === `${component}/source/Sources.xz`,
					),
			).toHaveLength(1);
			expect(
				vi
					.mocked(verifyAptSources)
					.mock.calls.filter(
						([o]) => o.indexPath === `${component}/source/Sources`,
					),
			).toHaveLength(1);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
it("finds a universe binary's exact epoch-versioned source in main and reuses verified indexes", () =>
	crossComponentSource("exact"));
it("fails when no signed component lists the source", () =>
	crossComponentSource("missing"));
it("rejects a source with the right name but the wrong version in another component", () =>
	crossComponentSource("wrong-version"));
