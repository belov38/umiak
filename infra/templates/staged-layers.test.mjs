import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { signLayerMetadata } from "./release-layers.mjs";
import { captureSourceFile, writeSourceLayout } from "./source-artifact.mjs";
import {
	stagingLayout,
	validateStagedIdentity,
	verifySourceLayout,
} from "./staged-layers.mjs";
import { layerFixture } from "./testdata/layers/fixture.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
test("staged provenance is signed and cannot claim another approved SHA", () => {
	const m = layerFixture(),
		keys = generateKeyPairSync("ed25519");
	m.verification.buildHost = "local-staged";
	m.verification.approvedSha = m.sourceCommit;
	const args = {
		manifest: m,
		key: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
		publicKey: keys.publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
		proof: { ok: true, offlineReplay: true },
	};
	assert.equal(
		JSON.parse(signLayerMetadata(args).bytes).verification.buildHost,
		"local-staged",
	);
	m.verification.approvedSha = "b".repeat(40);
	assert.throws(() => signLayerMetadata(args), /provenance/);
});
test("staged identity requires exact reviewed source, version, edge and replay proof", () => {
	const m = layerFixture();
	m.channel = "edge";
	const options = {
		slug: m.slug,
		version: m.version,
		sourceCommit: m.sourceCommit,
	};
	validateStagedIdentity(m, options);
	for (const patch of [
		{ sourceCommit: "b".repeat(40) },
		{ channel: "stable" },
		{ version: "wrong" },
		{ verification: { ok: true, offlineReplay: false } },
	])
		assert.throws(
			() => validateStagedIdentity({ ...m, ...patch }, options),
			/approved/,
		);
});
test("unsigned OCI layout contains only staged controls and content-addressed chunks", async () => {
	const root = await mkdtemp(join(tmpdir(), "staging-layout-"));
	try {
		const chunk = Buffer.from("compressed fixture");
		await mkdir(join(root, "blobs/sha256"), { recursive: true });
		await writeFile(join(root, "blobs/sha256", sha(chunk)), chunk);
		for (const file of [
			"inventory.json",
			"layer-recipe.json",
			"verify.sh",
			"replay.json",
		])
			await writeFile(join(root, file), "fixture");
		await writeFile(
			join(root, "manifest.draft.json"),
			JSON.stringify({
				archive: { chunks: [{ sha256: sha(chunk), sizeBytes: chunk.length }] },
			}),
		);
		const layout = await stagingLayout(root, "version");
		const index = JSON.parse(await readFile(join(layout, "index.json")));
		assert.equal(
			index.manifests[0].annotations["org.opencontainers.image.ref.name"],
			"staging-version",
		);
		const body = await readFile(
			join(layout, "blobs/sha256", index.manifests[0].digest.slice(7)),
		);
		assert.equal(`sha256:${sha(body)}`, index.manifests[0].digest);
		const names = JSON.parse(body).layers.map(
			(l) => l.annotations["org.opencontainers.image.title"],
		);
		assert.ok(names.includes("manifest.draft.json"));
		assert.ok(!names.includes("channel.json"));
		assert.ok(!names.includes("manifest.sig"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("source layout verification reconstructs sources and rejects changed blobs", async () => {
	const root = await mkdtemp(join(tmpdir(), "staged-source-"));
	try {
		const data = Buffer.from("original source"),
			cache = join(root, "cache"),
			directory = join(root, "layout");
		const file = await captureSourceFile({
			url: "https://example.invalid/source",
			sha256: sha(data),
			sizeBytes: data.length,
			cache,
			fetcher: async () => new Response(data),
		});
		await writeSourceLayout({
			directory,
			cache,
			version: "version",
			slug: "linux",
			sourceCommit: "a".repeat(40),
			files: [{ ...file, path: "source.tar" }],
			mapping: [{ binarySha256: "b".repeat(64), sources: ["source.tar"] }],
		});
		await verifySourceLayout(directory);
		await writeFile(
			join(directory, "blobs/sha256", file.chunks[0].sha256),
			"tampered",
		);
		await assert.rejects(verifySourceLayout(directory), /mismatch/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("CI validates every tar member without extracting scripts; altered content is rejected", async () => {
	const root = await mkdtemp(join(tmpdir(), "staged-tar-"));
	try {
		await mkdir(join(root, "blobs/sha256"), { recursive: true });
		const make = (content) =>
			execFileSync("python", [
				"-c",
				`import io,sys,tarfile\nb=io.BytesIO()\nwith tarfile.open(fileobj=b,mode='w') as a:\n m=tarfile.TarInfo('build/script.sh');d=sys.argv[1].encode();m.size=len(d);m.mode=0o644;a.addfile(m,io.BytesIO(d))\nsys.stdout.buffer.write(b.getvalue())`,
				content,
			]);
		const original = Buffer.from("do not execute"),
			raw = make(original.toString());
		const manifest = {
			files: [
				{
					path: "build/script.sh",
					sha256: sha(original),
					sizeBytes: original.length,
					mode: 420,
				},
			],
			archive: {},
		};
		const save = async (tar) => {
			const compressed = execFileSync("zstd", ["-q", "-c"], { input: tar });
			const hash = sha(compressed);
			await writeFile(join(root, "blobs/sha256", hash), compressed);
			manifest.archive = {
				sha256: hash,
				compressedBytes: compressed.length,
				rawSha256: sha(tar),
				sizeBytes: tar.length,
				chunks: [{ sha256: hash, sizeBytes: compressed.length }],
			};
			await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
		};
		const args = [
			"infra/templates/check-staged-archive.py",
			join(root, "manifest.json"),
			root,
		];
		await save(raw);
		execFileSync("python", args, { cwd: resolve(".") });
		await save(make("changed content"));
		assert.throws(() => execFileSync("python", args, { stdio: "pipe" }));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("network guard dumps failure facts and exits before apt retries", async () => {
	const root = await mkdtemp(join(tmpdir(), "network-guard-"));
	try {
		const script = (
			await readFile("infra/templates/linux/capture-network-check.sh", "utf8")
		)
			.replaceAll("/dev/ttyS0", join(root, "serial.log"))
			.replaceAll("/run/systemd/network", join(root, "run"))
			.replaceAll("/etc/netplan", join(root, "netplan"));
		await mkdir(join(root, "netplan"));
		await writeFile(join(root, "netplan/50-cloud-init.yaml"), "capture0: down");
		const env = join(root, "commands.sh");
		await writeFile(
			env,
			"systemctl() { return 0; }; networkctl() { echo networkctl-dump; }; cloud-init() { echo cloud-init-failed; }; ip() { echo DOWN; }; export -f systemctl networkctl cloud-init ip\n",
		);
		assert.throws(() =>
			execFileSync("bash", ["-c", `. '${env}'\n${script}`], {
				stdio: "pipe",
			}),
		);
		const output = await readFile(join(root, "serial.log"), "utf8");
		assert.match(output, /networkctl-dump/);
		assert.match(output, /cloud-init-failed/);
		assert.match(output, /capture0: down/);
		assert.ok(output.trim().endsWith("UMIAK_CAPTURE_NETWORK_FAILED"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("anonymous staged pull binds both products to source digests and adds honest provenance", async () => {
	const { pullStaged } = await import("./staged-layers.mjs");
	const { OCI_REPOSITORIES, OCI_SOURCE_REPOSITORIES } = await import(
		"./oci.mjs"
	);
	const root = await mkdtemp(join(tmpdir(), "staged-pull-"));
	try {
		const repos = new Map(),
			version = "20261106.1-edge.20261106.1",
			sourceCommit = "a".repeat(40);
		for (const slug of ["linux", "linux-desktop"]) {
			const sourcesDir = join(root, `${slug}-sources`),
				data = Buffer.from("source fixture");
			const file = await captureSourceFile({
				url: "https://example.invalid/source",
				cache: join(root, "cache"),
				sha256: sha(data),
				sizeBytes: data.length,
				fetcher: async () => new Response(data),
			});
			const ref = await writeSourceLayout({
				directory: sourcesDir,
				cache: join(root, "cache"),
				version,
				slug,
				sourceCommit,
				files: [{ ...file, path: "source.tar" }],
				mapping: [{ binarySha256: "b".repeat(64), sources: ["source.tar"] }],
			});
			repos.set(OCI_SOURCE_REPOSITORIES[slug], sourcesDir);
			const dir = join(root, slug);
			await mkdir(join(dir, "blobs/sha256"), { recursive: true });
			const draft = layerFixture();
			draft.slug = slug;
			draft.channel = "edge";
			draft.version = version;
			draft.sources = { repository: ref.repository, digest: ref.digest };
			await writeFile(join(dir, "manifest.draft.json"), JSON.stringify(draft));
			for (const name of [
				"inventory.json",
				"layer-recipe.json",
				"verify.sh",
				"replay.json",
			])
				await writeFile(join(dir, name), "control");
			for (const c of draft.archive.chunks)
				await writeFile(join(dir, "blobs/sha256", c.sha256), "fixture");
			repos.set(OCI_REPOSITORIES[slug], await stagingLayout(dir, version));
		}
		const fetcher = async (url) => {
			const path = new URL(url).pathname,
				m = path.match(/^\/v2\/(.+)\/(manifests|blobs)\/(.+)$/);
			assert.ok(m);
			const dir = repos.get(m[1]);
			assert.ok(dir);
			const index = JSON.parse(await readFile(join(dir, "index.json")));
			const digest =
				m[2] === "manifests" && !m[3].startsWith("sha256:")
					? index.manifests[0].digest
					: m[3];
			return new Response(
				await readFile(join(dir, "blobs/sha256", digest.slice(7))),
			);
		};
		const output = join(root, "downloaded");
		await pullStaged({ output, version, sourceCommit, fetcher });
		for (const slug of ["linux", "linux-desktop"]) {
			const m = JSON.parse(
				await readFile(join(output, slug, "manifest.draft.json")),
			);
			assert.equal(m.verification.buildHost, "local-staged");
			assert.equal(m.verification.approvedSha, sourceCommit);
			await verifySourceLayout(join(output, `${slug}-sources`));
		}
		await assert.rejects(
			pullStaged({
				output: join(root, "wrong-sha"),
				version,
				sourceCommit: "b".repeat(40),
				fetcher,
			}),
			/approved/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
