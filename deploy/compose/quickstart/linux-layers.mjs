import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	loadOfflineLayer,
	verifyOfflineLayer,
} from "../../../apps/template-builder/src/layer-release.ts";
import {
	IMAGE_LIMITS,
	verifyImageManifest,
	verifyImagePointer,
} from "../../../infra/templates/image-manifest.mjs";
import {
	AnonymousOCI,
	OCI_REGISTRY,
	OCI_REPOSITORIES,
} from "../../../infra/templates/oci.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Anonymous control downloads only: large input chunks are fetched once by the selected node. */
export async function fetchLinuxLayer({
	registry = process.env.UMIAK_LAYER_REGISTRY || OCI_REGISTRY,
	repository,
	keys,
	channel,
	slug,
	platform = process.env.UMIAK_PLATFORM_VERSION || "0.1.0",
	agent = process.env.UMIAK_AGENT_VERSION || "0.1.0",
	fetcher = fetch,
	minimumSequence = 0,
	previousPointerSha256,
}) {
	if (
		!["linux", "linux-desktop"].includes(slug) ||
		!["stable", "edge"].includes(channel)
	)
		throw Error("Unknown Linux layer product/channel");
	repository ||=
		process.env[
			`UMIAK_LAYER_${slug.replaceAll("-", "_").toUpperCase()}_REPOSITORY`
		] || OCI_REPOSITORIES[slug];
	const client = new AnonymousOCI({ registry, repository, fetcher });
	const artifact = await client.manifest(channel);
	const named = async (title, max = IMAGE_LIMITS.metadata) => {
		const layer = artifact.layers.find(
			(l) => l.annotations?.["org.opencontainers.image.title"] === title,
		);
		if (!layer || layer.size > max)
			throw Error(`OCI layer omits bounded ${title}`);
		return client.blob(layer.digest.slice(7), layer.size);
	};
	const [pointerBytes, pointerSig] = await Promise.all([
		named("channel.json"),
		named("channel.sig", 64),
	]);
	const pointer = verifyImagePointer({
		bytes: pointerBytes,
		signature: pointerSig,
		keys,
		channel,
		minimumSequence,
	});
	const pointerSha256 = sha(pointerBytes);
	if (
		pointer.sequence === minimumSequence &&
		previousPointerSha256 &&
		previousPointerSha256 !== pointerSha256
	)
		throw Error("Linux layer channel reused a sequence with different content");
	const [bytes, signature] = await Promise.all([
		named("manifest.json"),
		named("manifest.sig", 64),
	]);
	if (sha(bytes) !== pointer.images[slug])
		throw Error("Linux layer manifest hash differs from signed channel");
	const manifest = verifyImageManifest({
		bytes,
		signature,
		keys,
		platform,
		agent,
		channel,
		slug,
	});
	if (manifest.version !== pointer.version)
		throw Error("Linux layer release version mismatch");
	for (const chunk of manifest.archive.chunks)
		if (
			!artifact.layers.some(
				(l) =>
					l.digest === `sha256:${chunk.sha256}` && l.size === chunk.sizeBytes,
			)
		)
			throw Error("OCI artifact omits a signed layer chunk");
	const member = async (path, title) => {
		const file = manifest.files.find((f) => f.path === path),
			data = await named(title);
		if (!file || data.length !== file.sizeBytes || sha(data) !== file.sha256)
			throw Error("Linux layer control file hash mismatch");
		return data;
	};
	const [descriptor, verifyScript] = await Promise.all([
		member("build/layer-recipe.json", "layer-recipe.json"),
		member("build/verify.sh", "verify.sh"),
	]);
	const layer = verifyOfflineLayer({
		bytes,
		signature,
		descriptor,
		verifyScript,
		keys,
		platform,
		agent,
		channel,
		slug,
	});
	return {
		layer,
		sequence: pointer.sequence,
		pointerSha256,
		envelope: {
			manifest: bytes.toString("base64"),
			signature: signature.toString("base64"),
			descriptor: descriptor.toString("base64"),
			verifyScript: verifyScript.toString("base64"),
		},
	};
}

export async function cacheLinuxLayer(release, secretsDir) {
	const directory = join(secretsDir, "linux-layer-cache");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = await mkdtemp(join(directory, ".layer-"));
	const file = join(directory, `${release.layer.manifestSha256}.json`);
	try {
		await writeFile(
			join(temporary, "release.json"),
			JSON.stringify(release.envelope),
			{ mode: 0o600 },
		);
		await rename(join(temporary, "release.json"), file);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	return file;
}

/** Rebuild an immutable template from its original, freshly authenticated cached envelope. */
export function cachedLinuxLayer({
	secretsDir,
	manifestSha256,
	keys,
	slug,
	channel,
}) {
	if (!/^[a-f0-9]{64}$/.test(manifestSha256 || ""))
		throw Error("Invalid cached layer identity");
	const file = join(secretsDir, "linux-layer-cache", `${manifestSha256}.json`);
	const layer = loadOfflineLayer(file, {
		keys,
		slug,
		channel,
		platform: process.env.UMIAK_PLATFORM_VERSION || "0.1.0",
		agent: process.env.UMIAK_AGENT_VERSION || "0.1.0",
	});
	if (layer.manifestSha256 !== manifestSha256)
		throw Error("Cached layer identity mismatch");
	return { file, layer };
}
