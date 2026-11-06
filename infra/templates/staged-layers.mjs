import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateImageManifest } from "./image-manifest.mjs";
import {
	AnonymousOCI,
	OCI_REPOSITORIES,
	OCI_SOURCE_REPOSITORIES,
} from "./oci.mjs";
import { SOURCES_ARTIFACT_TYPE } from "./source-artifact.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
export const STAGING_TYPE = "application/vnd.umiak.linux-layer-staging.v1";
export const stagedControls = [
	"manifest.draft.json",
	"inventory.json",
	"layer-recipe.json",
	"verify.sh",
	"replay.json",
];
export async function stagingLayout(directory, version) {
	const root = join(directory, "staging-layout");
	await mkdir(join(root, "blobs/sha256"), { recursive: true });
	const put = async (bytes) => {
		const digest = sha(bytes);
		await writeFile(join(root, "blobs/sha256", digest), bytes);
		return { digest: `sha256:${digest}`, size: bytes.length };
	};
	const layers = [];
	for (const name of stagedControls)
		layers.push({
			mediaType: "application/octet-stream",
			...(await put(await readFile(join(directory, name)))),
			annotations: { "org.opencontainers.image.title": name },
		});
	const draft = JSON.parse(
		await readFile(join(directory, "manifest.draft.json")),
	);
	for (const chunk of draft.archive.chunks) {
		await link(
			join(directory, "blobs/sha256", chunk.sha256),
			join(root, "blobs/sha256", chunk.sha256),
		);
		layers.push({
			mediaType: "application/vnd.umiak.layer.chunk.v1+zstd",
			digest: `sha256:${chunk.sha256}`,
			size: chunk.sizeBytes,
			annotations: {
				"org.opencontainers.image.title": `chunk-${chunk.sha256}`,
			},
		});
	}
	const config = {
		mediaType: "application/vnd.oci.empty.v1+json",
		...(await put(Buffer.from("{}"))),
	};
	const body = Buffer.from(
		JSON.stringify({
			schemaVersion: 2,
			mediaType: "application/vnd.oci.image.manifest.v1+json",
			artifactType: STAGING_TYPE,
			config,
			layers,
			annotations: {
				"org.opencontainers.image.source": "https://github.com/belov38/umiak",
			},
		}),
	);
	const descriptor = {
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		...(await put(body)),
		annotations: { "org.opencontainers.image.ref.name": `staging-${version}` },
	};
	await writeFile(join(root, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
	await writeFile(
		join(root, "index.json"),
		JSON.stringify({ schemaVersion: 2, manifests: [descriptor] }),
	);
	return root;
}
async function pullLayout(
	repository,
	reference,
	type,
	directory,
	version,
	fetcher = fetch,
) {
	const client = new AnonymousOCI({
		repository,
		fetcher,
		artifactType: type,
		maxLayers: 8193,
		maxManifestBytes: 8 * 1024 ** 2,
	});
	const bytes = await client.request(
		`manifests/${reference}`,
		8 * 1024 ** 2,
		reference.startsWith("sha256:") ? reference.slice(7) : undefined,
	);
	const digest = sha(bytes),
		manifest = await client.manifest(`sha256:${digest}`);
	await mkdir(join(directory, "blobs/sha256"), { recursive: true });
	await writeFile(join(directory, "blobs/sha256", digest), bytes);
	for (const item of [manifest.config, ...manifest.layers]) {
		const data = await client.blob(item.digest.slice(7), item.size);
		await writeFile(
			join(directory, "blobs/sha256", item.digest.slice(7)),
			data,
		);
	}
	await writeFile(
		join(directory, "oci-layout"),
		'{"imageLayoutVersion":"1.0.0"}',
	);
	await writeFile(
		join(directory, "index.json"),
		JSON.stringify({
			schemaVersion: 2,
			manifests: [
				{
					mediaType: manifest.mediaType,
					digest: `sha256:${digest}`,
					size: bytes.length,
					annotations: { "org.opencontainers.image.ref.name": version },
				},
			],
		}),
	);
	return { manifest, digest: `sha256:${digest}` };
}
export async function pullStaged({
	output,
	version,
	sourceCommit,
	fetcher = fetch,
}) {
	await mkdir(output, { recursive: false });
	for (const slug of ["linux", "linux-desktop"]) {
		const directory = join(output, slug);
		await mkdir(directory);
		const layout = join(directory, "staging-layout");
		const { manifest } = await pullLayout(
			OCI_REPOSITORIES[slug],
			`staging-${version}`,
			STAGING_TYPE,
			layout,
			version,
			fetcher,
		);
		for (const name of stagedControls) {
			const entry = manifest.layers.find(
				(l) => l.annotations?.["org.opencontainers.image.title"] === name,
			);
			if (!entry || entry.size > 32 * 1024 ** 2)
				throw Error("Missing/oversized staged control");
			await writeFile(
				join(directory, name),
				await readFile(join(layout, "blobs/sha256", entry.digest.slice(7))),
			);
		}
		const draft = JSON.parse(
			await readFile(join(directory, "manifest.draft.json")),
		);
		validateStagedIdentity(draft, { slug, version, sourceCommit });
		validateImageManifest(draft, {
			slug,
			channel: "edge",
			platform: draft.minPlatform,
			agent: draft.minAgent,
		});
		await mkdir(join(directory, "blobs/sha256"), { recursive: true });
		for (const chunk of draft.archive.chunks) {
			if (
				!manifest.layers.some(
					(l) =>
						l.digest === `sha256:${chunk.sha256}` && l.size === chunk.sizeBytes,
				)
			)
				throw Error("Staged artifact omits input chunk");
			await link(
				join(layout, "blobs/sha256", chunk.sha256),
				join(directory, "blobs/sha256", chunk.sha256),
			);
		}
		const sources = await pullLayout(
			OCI_SOURCE_REPOSITORIES[slug],
			`staging-${version}`,
			SOURCES_ARTIFACT_TYPE,
			join(output, `${slug}-sources`),
			version,
			fetcher,
		);
		if (
			sources.digest !== draft.sources.digest ||
			draft.sources.repository !== OCI_SOURCE_REPOSITORIES[slug]
		)
			throw Error("Staged source companion binding mismatch");
		draft.verification = {
			...draft.verification,
			buildHost: "local-staged",
			approvedSha: sourceCommit,
		};
		await writeFile(
			join(directory, "manifest.draft.json"),
			JSON.stringify(draft),
		);
	}
}
export function validateStagedIdentity(draft, { slug, version, sourceCommit }) {
	if (
		draft.slug !== slug ||
		draft.version !== version ||
		draft.sourceCommit !== sourceCommit ||
		draft.channel !== "edge" ||
		draft.verification?.ok !== true ||
		draft.verification?.offlineReplay !== true
	)
		throw Error(
			"Staged build does not match approved source/version/edge/replay proof",
		);
}
/** Re-hash every original source file locally after anonymous, digest-checked pull. */
export async function verifySourceLayout(directory) {
	const index = JSON.parse(await readFile(join(directory, "index.json")));
	const bytes = await readFile(
		join(directory, "blobs/sha256", index.manifests[0].digest.slice(7)),
	);
	if (`sha256:${sha(bytes)}` !== index.manifests[0].digest)
		throw Error("Source root digest mismatch");
	const manifest = JSON.parse(bytes);
	for (const item of [manifest.config, ...manifest.layers]) {
		if (
			!/^sha256:[a-f0-9]{64}$/.test(item.digest) ||
			!Number.isSafeInteger(item.size) ||
			item.size < 0 ||
			item.size > 512 * 1024 ** 2
		)
			throw Error("Invalid source blob identity");
		const path = join(directory, "blobs/sha256", item.digest.slice(7));
		const hash = createHash("sha256");
		let size = 0;
		for await (const b of createReadStream(path)) {
			hash.update(b);
			size += b.length;
		}
		if (`sha256:${hash.digest("hex")}` !== item.digest || size !== item.size)
			throw Error("Source blob mismatch");
	}
	const meta = manifest.layers.find(
		(l) =>
			l.annotations?.["org.opencontainers.image.title"] ===
			"source-manifest.json",
	);
	const body = JSON.parse(
		await readFile(join(directory, "blobs/sha256", meta.digest.slice(7))),
	);
	if (
		body.format !== "umiak-linux-sources/v1" ||
		!Array.isArray(body.files) ||
		body.files.length < 1 ||
		body.files.length > 8192 ||
		!Array.isArray(body.mapping)
	)
		throw Error("Invalid source file manifest");
	const names = new Set(body.files.map((f) => f.path));
	for (const mapping of body.mapping)
		if (
			!/^[a-f0-9]{64}$/.test(mapping.binarySha256) ||
			!Array.isArray(mapping.sources) ||
			mapping.sources.length < 1 ||
			mapping.sources.some((p) => !names.has(p))
		)
			throw Error("Missing binary corresponding source");
	for (const file of body.files) {
		if (
			!/^[a-f0-9]{64}$/.test(file.sha256) ||
			!Array.isArray(file.chunks) ||
			file.chunks.length < 1 ||
			file.chunks.length > 32
		)
			throw Error("Invalid source file identity");
		for (const c of file.chunks)
			if (
				!/^[a-f0-9]{64}$/.test(c.sha256) ||
				!manifest.layers.some(
					(l) => l.digest === `sha256:${c.sha256}` && l.size === c.sizeBytes,
				)
			)
				throw Error("Invalid source chunk binding");
		const hash = createHash("sha256");
		let size = 0;
		for (const c of file.chunks)
			for await (const b of createReadStream(
				join(directory, "blobs/sha256", c.sha256),
			)) {
				hash.update(b);
				size += b.length;
			}
		if (hash.digest("hex") !== file.sha256 || size !== file.sizeBytes)
			throw Error("Source file mismatch");
	}
}
