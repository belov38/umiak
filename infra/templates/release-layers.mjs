import { execFile } from "node:child_process";
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	sign,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { verifyImageManifest, verifyImagePointer } from "./image-manifest.mjs";
import {
	AnonymousOCI,
	LAYER_ARTIFACT_TYPE,
	OCI_REPOSITORIES,
	OCI_SOURCE_REPOSITORIES,
} from "./oci.mjs";

import { SOURCES_ARTIFACT_TYPE } from "./source-artifact.mjs";

const exec = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slugs = ["linux", "linux-desktop"];

export function validateReleaseRequest(o) {
	if (
		!["stable", "edge"].includes(o.channel) ||
		!/^\d{8}\.\d+(?:-edge\.\d{8}\.\d+)?$/.test(o.version || "") ||
		(o.channel === "edge") !== o.version.includes("-edge.") ||
		!/^[a-f0-9]{40}$/.test(o.sourceCommit || "")
	)
		throw Error("Invalid layer release identity");
	if (o.publish && o.approvedSha !== o.sourceCommit)
		throw Error(
			"Publishing requires the exact reviewed head SHA in approved_sha",
		);
	if (o.publish && o.channel === "stable" && o.ref !== "refs/heads/main")
		throw Error("Stable publication must run from main");
}
function signingKey(key, publicKey) {
	try {
		const parsed = createPrivateKey(key);
		if (
			parsed.asymmetricKeyType !== "ed25519" ||
			!createPublicKey(parsed)
				.export({ type: "spki", format: "der" })
				.equals(
					createPublicKey(publicKey).export({ type: "spki", format: "der" }),
				)
		)
			throw Error();
		return parsed;
	} catch {
		throw Error(
			"Signing key does not match the recipe-publisher Ed25519 authority",
		);
	}
}
export function signLayerMetadata({ manifest, key, publicKey, proof }) {
	if (proof?.ok !== true || proof?.offlineReplay !== true)
		throw Error("Fresh offline replay must pass before signing");
	const bytes = Buffer.from(JSON.stringify(manifest));
	const signature = sign(null, bytes, signingKey(key, publicKey));
	verifyImageManifest({
		bytes,
		signature,
		keys: [publicKey],
		slug: manifest.slug,
		channel: manifest.channel,
		platform: manifest.minPlatform,
		agent: manifest.minAgent,
	});
	return { bytes, signature };
}
export function signLayerPointer({
	channel,
	version,
	sequence,
	previousSequence = 0,
	images,
	key,
	publicKey,
}) {
	if (!Number.isSafeInteger(sequence) || sequence <= previousSequence)
		throw Error("Channel sequence must advance monotonically");
	const bytes = Buffer.from(
		JSON.stringify({
			format: "umiak-linux-channel/v1",
			channel,
			sequence,
			version,
			images: Object.fromEntries(slugs.map((s) => [s, sha(images[s])])),
		}),
	);
	const signature = sign(null, bytes, signingKey(key, publicKey));
	verifyImagePointer({
		bytes,
		signature,
		keys: [publicKey],
		channel,
		minimumSequence: previousSequence + 1,
	});
	return { bytes, signature };
}
export async function publishLayerArtifacts({
	publish,
	artifacts,
	version,
	channel,
	upload,
	readback,
	promote,
	timing = () => {},
}) {
	if (!publish) return;
	if (
		artifacts.length !== 4 ||
		slugs.some(
			(slug) =>
				!["sources", "layer"].every((kind) =>
					artifacts.some(
						(a) => a.slug === slug && (a.kind || "layer") === kind,
					),
				),
		)
	)
		throw Error(
			"Both Linux products and their source companions are required before publication",
		);
	const ordered = [...artifacts].sort(
		(a, b) => Number(b.kind === "sources") - Number(a.kind === "sources"),
	);
	for (const artifact of ordered) {
		let started = Date.now();
		await upload(artifact, version);
		await timing({
			slug: artifact.slug,
			kind: artifact.kind || "layer",
			phase: "upload",
			durationMs: Date.now() - started,
		});
		started = Date.now();
		await readback(artifact, version);
		await timing({
			slug: artifact.slug,
			kind: artifact.kind || "layer",
			phase: "anonymous-readback",
			durationMs: Date.now() - started,
		});
	}
	for (const artifact of ordered.filter((a) => a.kind !== "sources"))
		await promote(artifact, channel);
}

async function fileHash(path) {
	const h = createHash("sha256");
	for await (const b of createReadStream(path)) h.update(b);
	return h.digest("hex");
}
async function privateFile(path) {
	const info = await stat(path);
	if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1024 ** 2)
		throw Error("CI secret must be a restricted regular file");
	return readFile(path);
}
export async function oras(args, cwd, token) {
	const { stdout } = await exec(
		"oras",
		[
			...args,
			args[0] === "copy" ? "--to-registry-config" : "--registry-config",
			join(token, "registry.json"),
		],
		{ ...(cwd ? { cwd } : {}), timeout: 30 * 60_000, maxBuffer: 1024 ** 2 },
	);
	return stdout.trim();
}
export async function login(
	tokenDirectory,
	tokenFile = process.env.LAYER_GITHUB_TOKEN_FILE,
) {
	await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
	const token = await privateFile(tokenFile);
	// execFile has no stdin option; write to the pipe without ever placing the token in argv/env.
	const { spawn } = await import("node:child_process");
	await new Promise((resolvePromise, reject) => {
		const child = spawn(
			"oras",
			[
				"login",
				"ghcr.io",
				"--username",
				process.env.ORAS_USERNAME || process.env.GITHUB_ACTOR || "umiak-ci",
				"--password-stdin",
				"--registry-config",
				join(tokenDirectory, "registry.json"),
			],
			{
				stdio: ["pipe", "ignore", "ignore"],
				timeout: 120000,
				killSignal: "SIGKILL",
			},
		);
		child.on("error", () => reject(Error("ORAS login failed")));
		child.on("close", (code) =>
			code === 0 ? resolvePromise() : reject(Error("ORAS login failed")),
		);
		child.stdin.on("error", () => {});
		child.stdin.end(token);
	});
	await chmod(join(tokenDirectory, "registry.json"), 0o600);
}
function packageSettings(repository) {
	return `https://github.com/users/belov38/packages/container/${repository.split("/").at(-1)}/settings`;
}
async function previousSequence(channel, publicKey) {
	let sequence = 0;
	for (const slug of slugs) {
		const client = new AnonymousOCI({ repository: OCI_REPOSITORIES[slug] });
		let artifact;
		try {
			artifact = await client.manifest(channel);
		} catch (error) {
			if (error.status === 404) continue;
			throw error;
		}
		const named = async (title) => {
			const f = artifact.layers.find(
				(l) => l.annotations?.["org.opencontainers.image.title"] === title,
			);
			if (!f) throw Error("Existing channel omits signed controls");
			return client.blob(f.digest.slice(7), f.size);
		};
		const pointer = verifyImagePointer({
			bytes: await named("channel.json"),
			signature: await named("channel.sig"),
			keys: [publicKey],
			channel,
		});
		sequence = Math.max(sequence, pointer.sequence);
	}
	return sequence;
}
export async function assertAnonymousArtifact(artifact, tag) {
	const client = new AnonymousOCI({ repository: artifact.repository });
	let remote;
	try {
		remote = await client.manifest(tag);
	} catch (error) {
		throw Error(
			`Anonymous layer readback failed; set package visibility to Public once: ${packageSettings(artifact.repository)} (${error.message})`,
		);
	}
	const expected = await readFile(join(artifact.directory, "manifest.json"));
	const signed = JSON.parse(expected);
	const titles = [
		"manifest.json",
		"manifest.sig",
		"channel.json",
		"channel.sig",
		"layer-recipe.json",
		"verify.sh",
		"inventory.json",
	];
	for (const title of titles) {
		const file = remote.layers.find(
			(l) => l.annotations?.["org.opencontainers.image.title"] === title,
		);
		const local = await readFile(join(artifact.directory, title));
		if (
			!file ||
			file.digest !== `sha256:${sha(local)}` ||
			file.size !== local.length
		)
			throw Error("OCI readback changed a signed control artifact");
		await client.blob(file.digest.slice(7), file.size);
	}
	for (const chunk of signed.archive.chunks) {
		if (
			!remote.layers.some(
				(l) =>
					l.digest === `sha256:${chunk.sha256}` && l.size === chunk.sizeBytes,
			)
		)
			throw Error("OCI readback omits a signed chunk");
		await client.blob(chunk.sha256, chunk.sizeBytes);
	}
}
export async function assertAnonymousSources(artifact, options = {}) {
	const client = new AnonymousOCI({
		repository: artifact.repository,
		...options,
		artifactType: SOURCES_ARTIFACT_TYPE,
		maxLayers: 8193,
		maxManifestBytes: 8 * 1024 ** 2,
	});
	const remote = await client.manifest(artifact.digest);
	const meta = remote.layers.find(
		(l) =>
			l.annotations?.["org.opencontainers.image.title"] ===
			"source-manifest.json",
	);
	if (!meta) throw Error("Source artifact omits its source manifest");
	const body = JSON.parse(await client.blob(meta.digest.slice(7), meta.size));
	if (
		body.format !== "umiak-linux-sources/v1" ||
		!Array.isArray(body.files) ||
		body.files.length > 8192
	)
		throw Error("Invalid corresponding-source manifest");
	const validated = new Set();
	for (const file of body.files) {
		if (validated.has(file.sha256)) continue;
		const full = createHash("sha256");
		let size = 0;
		for (const chunk of file.chunks) {
			if (
				!remote.layers.some(
					(l) =>
						l.digest === `sha256:${chunk.sha256}` && l.size === chunk.sizeBytes,
				)
			)
				throw Error("Source artifact omits a source chunk");
			const bytes = await client.blob(chunk.sha256, chunk.sizeBytes);
			full.update(bytes);
			size += bytes.length;
		}
		if (full.digest("hex") !== file.sha256 || size !== file.sizeBytes)
			throw Error("Source file readback checksum mismatch");
		validated.add(file.sha256);
	}
	if (remote.config?.digest)
		await client.blob(remote.config.digest.slice(7), remote.config.size);
}
async function command() {
	const mode = process.argv[2];
	const output = resolve(process.env.LAYER_OUTPUT || "dist/linux-layers");
	const request = {
		publish: process.env.LAYER_PUBLISH === "true",
		channel: process.env.LAYER_CHANNEL || "edge",
		version: process.env.LAYER_VERSION,
		sourceCommit:
			process.env.GITHUB_SHA ||
			(await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
		approvedSha: process.env.LAYER_APPROVED_SHA,
		ref: process.env.GITHUB_REF,
	};
	validateReleaseRequest(request);
	if (mode === "fetch-staged") {
		if (
			request.channel !== "edge" ||
			request.approvedSha !== request.sourceCommit
		)
			throw Error("Staged signing requires reviewed edge source SHA");
		const { pullStaged } = await import("./staged-layers.mjs");
		await pullStaged({ ...request, output });
		return;
	}
	if (mode === "build") {
		const { buildLayerRelease } = await import("./build-layers.mjs");
		await buildLayerRelease({
			...request,
			output,
			aptProxy: process.env.UMIAK_BUILD_APT_PROXY,
		});
		return;
	}
	if (
		![
			"sign",
			"publish",
			"preflight",
			"initialize-packages",
			"verify-staged",
		].includes(mode)
	)
		throw Error(
			"Usage: release-layers.mjs build|sign|preflight|publish|initialize-packages",
		);
	const tokenDirectory = await mkdtemp(
		join(process.env.RUNNER_TEMP || output, "umiak-oci-"),
	);
	try {
		if (["preflight", "publish", "initialize-packages"].includes(mode)) {
			if (!request.publish) {
				console.log("Publish gate closed; no registry writes.");
				return;
			}
			await login(tokenDirectory);
		}
		if (mode === "initialize-packages") {
			await writeFile(
				join(tokenDirectory, "README.txt"),
				"Umiak signed offline input layers. Set this package Public before publishing releases. No Ubuntu base image or vendor software is hosted here.\n",
			);
			for (const repository of [
				...Object.values(OCI_REPOSITORIES),
				...Object.values(OCI_SOURCE_REPOSITORIES),
			]) {
				await oras(
					[
						"push",
						"--image-spec",
						"v1.1",
						"--artifact-type",
						"application/vnd.umiak.visibility-init.v1",
						"--annotation",
						`org.opencontainers.image.source=https://github.com/${process.env.GITHUB_REPOSITORY}`,
						`ghcr.io/${repository}:visibility-init`,
						`README.txt:text/plain`,
					],
					tokenDirectory,
					tokenDirectory,
				);
				console.log(`Set package Public once: ${packageSettings(repository)}`);
			}
			return;
		}
		if (mode === "preflight") {
			for (const repository of [
				...Object.values(OCI_REPOSITORIES),
				...Object.values(OCI_SOURCE_REPOSITORIES),
			]) {
				try {
					await oras(
						["manifest", "fetch", `ghcr.io/${repository}:${request.version}`],
						undefined,
						tokenDirectory,
					);
				} catch (error) {
					// Only a definite unknown tag is safe; authorization/network errors never mean absence.
					if (
						/manifest unknown|not found|NAME_UNKNOWN|MANIFEST_UNKNOWN/i.test(
							error.stderr || "",
						)
					)
						continue;
					throw Error("Could not establish immutable tag availability");
				}
				throw Error(
					"Layer version is already published; choose a new immutable version",
				);
			}
			return;
		}
		const publicKey = await readFile(
			"infra/templates/keys/recipe-publisher.pub",
			"utf8",
		);
		const artifacts = [];
		for (const slug of slugs) {
			const directory = join(output, slug);
			const draft = JSON.parse(
				await readFile(join(directory, "manifest.draft.json"), "utf8"),
			);
			if (
				draft.version !== request.version ||
				draft.channel !== request.channel ||
				draft.sourceCommit !== request.sourceCommit
			)
				throw Error("Prepared layer does not match reviewed release identity");
			if (
				mode === "verify-staged" &&
				draft.verification.buildHost !== "local-staged"
			)
				throw Error("Expected local-staged provenance");
			const sourceDirectory = join(output, `${slug}-sources`);
			const sourceIndex = JSON.parse(
				await readFile(join(sourceDirectory, "index.json"), "utf8"),
			);
			if (
				draft.sources.repository !== OCI_SOURCE_REPOSITORIES[slug] ||
				sourceIndex.manifests?.length !== 1 ||
				sourceIndex.manifests[0].digest !== draft.sources.digest
			)
				throw Error("Corresponding-source digest/repository mismatch");
			const inventory = await readFile(join(directory, "inventory.json"));
			const inventoryData = JSON.parse(inventory);
			if (
				JSON.stringify(inventoryData.sources) !==
					JSON.stringify(draft.sources) ||
				inventoryData.vendorTools?.included !== false
			)
				throw Error(
					"Inventory omits authenticated sources or contains vendor payloads",
				);
			if (
				sha(inventory) !== draft.inventory.sha256 ||
				inventory.length !== draft.inventory.sizeBytes
			)
				throw Error("Prepared inventory mismatch");
			for (const chunk of draft.archive.chunks) {
				const file = join(directory, "blobs/sha256", chunk.sha256);
				if (
					(await stat(file)).size !== chunk.sizeBytes ||
					(await fileHash(file)) !== chunk.sha256
				)
					throw Error("Prepared chunk mismatch");
			}
			const sourceRoot = sourceIndex.manifests[0].digest.slice(7);
			const sourceBytes = await readFile(
				join(sourceDirectory, "blobs/sha256", sourceRoot),
			);
			if (sha(sourceBytes) !== sourceRoot)
				throw Error("Source OCI manifest changed");
			const sourceMeta = JSON.parse(sourceBytes).layers.find(
				(l) =>
					l.annotations?.["org.opencontainers.image.title"] ===
					"source-manifest.json",
			);
			if (!sourceMeta) throw Error("Source OCI omits its source manifest");
			const sourceBodyBytes = await readFile(
				join(sourceDirectory, "blobs/sha256", sourceMeta.digest.slice(7)),
			);
			if (sha(sourceBodyBytes) !== sourceMeta.digest.slice(7))
				throw Error("Source manifest changed");
			const sourceBody = JSON.parse(sourceBodyBytes);
			if (
				sourceBody.version !== request.version ||
				sourceBody.sourceCommit !== request.sourceCommit ||
				JSON.stringify(sourceBody.mapping) !==
					JSON.stringify(inventoryData.binarySources)
			)
				throw Error("Signed inventory binary/source mapping mismatch");
			if (draft.verification.buildHost === "local-staged") {
				if (draft.verification.approvedSha !== request.sourceCommit)
					throw Error("Unapproved local-staged provenance");
				const { validateImageManifest } = await import("./image-manifest.mjs");
				validateImageManifest(draft, {
					slug,
					channel: request.channel,
					platform: draft.minPlatform,
					agent: draft.minAgent,
				});
				const { verifySourceLayout } = await import("./staged-layers.mjs");
				await verifySourceLayout(sourceDirectory);
				await exec(
					"python",
					[
						"infra/templates/check-staged-archive.py",
						join(directory, "manifest.draft.json"),
						directory,
					],
					{ timeout: 60 * 60_000, maxBuffer: 1024 ** 2 },
				);
				const { loadRecipe, recipeDigest } = await import(
					"../../apps/template-builder/src/recipe.ts"
				);
				if (
					recipeDigest(
						loadRecipe(resolve("infra/templates"), slug, "linux"),
					) !== draft.recipeSha256
				)
					throw Error("Staged recipe differs from approved source");
			}
			for (const file of draft.files.filter(
				(f) =>
					f.path.startsWith("apt/") &&
					f.path.endsWith(".deb") &&
					!f.path.startsWith("apt/docker-"),
			))
				if (
					!inventoryData.binarySources.some(
						(b) => b.binarySha256 === file.sha256,
					)
				)
					throw Error("Staged deb lacks corresponding sources");
			const descriptor = await readFile(join(directory, "layer-recipe.json"));
			const verifyScript = await readFile(join(directory, "verify.sh"));
			const { layerInventory } = await import("./layer-inventory.mjs");
			layerInventory({
				sourceCommit: request.sourceCommit,
				facts: JSON.parse(descriptor).facts,
				files: draft.files,
				packages: inventoryData.packages,
				npm: inventoryData.npm,
				fetches: inventoryData.nonDebInputs,
				upstream: inventoryData.nonDebInputs.flatMap((f) => f.notices),
			});
			for (const [path, bytes] of [
				["build/layer-recipe.json", descriptor],
				["build/verify.sh", verifyScript],
			]) {
				const member = draft.files.find((f) => f.path === path);
				if (
					!member ||
					member.sha256 !== sha(bytes) ||
					member.sizeBytes !== bytes.length
				)
					throw Error("Staged control/input binding mismatch");
			}
			if (mode === "verify-staged") {
				const { validateOfflineLayerInputs } = await import(
					"../../apps/template-builder/src/layer-release.ts"
				);
				const validated = validateOfflineLayerInputs(
					draft,
					descriptor,
					verifyScript,
				);
				const { loadRecipe, loadVersions } = await import(
					"../../apps/template-builder/src/recipe.ts"
				);
				if (
					JSON.stringify(validated.versions) !==
					JSON.stringify(
						loadVersions(loadRecipe(resolve("infra/templates"), slug, "linux")),
					)
				)
					throw Error("Staged version pins differ from approved recipe");
				continue;
			}
			if (mode === "sign") {
				const key = await privateFile(process.env.RECIPE_SIGNING_KEY_FILE);
				const signed = signLayerMetadata({
					manifest: draft,
					key,
					publicKey,
					proof: JSON.parse(
						await readFile(join(directory, "replay.json"), "utf8"),
					),
				});
				const { verifyOfflineLayer } = await import(
					"../../apps/template-builder/src/layer-release.ts"
				);
				verifyOfflineLayer({
					...signed,
					descriptor,
					verifyScript,
					keys: [publicKey],
					slug,
					channel: request.channel,
					platform: draft.minPlatform,
					agent: draft.minAgent,
				});
				await writeFile(join(directory, "manifest.json"), signed.bytes);
				await writeFile(join(directory, "manifest.sig"), signed.signature);
			} else {
				if (
					(await readFile(join(directory, "manifest.json"))).toString() !==
					JSON.stringify(draft)
				)
					throw Error("Prepared manifest differs from its signed bytes");
				verifyImageManifest({
					bytes: await readFile(join(directory, "manifest.json")),
					signature: await readFile(join(directory, "manifest.sig")),
					keys: [publicKey],
					slug,
					channel: request.channel,
					platform: draft.minPlatform,
					agent: draft.minAgent,
				});
			}
			artifacts.push({
				slug,
				directory: sourceDirectory,
				repository: OCI_SOURCE_REPOSITORIES[slug],
				kind: "sources",
				digest: draft.sources.digest,
			});
			artifacts.push({ slug, directory, repository: OCI_REPOSITORIES[slug] });
		}
		if (mode === "verify-staged") return;
		if (mode === "sign") {
			const sequence = Number(process.env.LAYER_SEQUENCE);
			const key = await privateFile(process.env.RECIPE_SIGNING_KEY_FILE);
			const prior = request.publish
				? await previousSequence(request.channel, publicKey)
				: 0;
			const images = Object.fromEntries(
				await Promise.all(
					artifacts
						.filter((a) => a.kind !== "sources")
						.map(async (a) => {
							return [
								a.slug,
								await readFile(join(a.directory, "manifest.json")),
							];
						}),
				),
			);
			const pointer = signLayerPointer({
				channel: request.channel,
				version: request.version,
				sequence,
				previousSequence: prior,
				images,
				key,
				publicKey,
			});
			for (const a of artifacts.filter((a) => a.kind !== "sources")) {
				await writeFile(join(a.directory, "channel.json"), pointer.bytes);
				await writeFile(join(a.directory, "channel.sig"), pointer.signature);
			}
			return;
		}
		const publication = [];
		await publishLayerArtifacts({
			timing: async (result) => {
				publication.push(result);
				console.log(JSON.stringify(result));
				await writeFile(
					join(output, "publication.json"),
					JSON.stringify(publication, null, 2),
				);
			},
			publish: request.publish,
			artifacts,
			version: request.version,
			channel: request.channel,
			upload: async (a, tag) => {
				if (a.kind === "sources") {
					await oras(
						[
							"copy",
							"--from-oci-layout",
							`${a.directory}:${tag}`,
							`ghcr.io/${a.repository}:${tag}`,
						],
						undefined,
						tokenDirectory,
					);
					return;
				}
				const chunks = (
					await readdir(join(a.directory, "blobs/sha256"))
				).sort();
				const args = [
					"push",
					"--image-spec",
					"v1.1",
					"--artifact-type",
					LAYER_ARTIFACT_TYPE,
					"--annotation",
					`org.opencontainers.image.source=https://github.com/${process.env.GITHUB_REPOSITORY}`,
					`ghcr.io/${a.repository}:${tag}`,
				];
				for (const title of [
					"channel.json",
					"channel.sig",
					"manifest.json",
					"manifest.sig",
					"layer-recipe.json",
					"verify.sh",
					"inventory.json",
				])
					args.push(`${title}:application/octet-stream`);
				for (const [index, digest] of chunks.entries()) {
					const name = `chunk-${index.toString().padStart(4, "0")}.zst`;
					await link(
						join(a.directory, "blobs/sha256", digest),
						join(a.directory, name),
					);
					args.push(`${name}:application/vnd.umiak.layer.chunk.v1+zstd`);
				}
				await oras(args, a.directory, tokenDirectory);
			},
			readback: (a, tag) =>
				a.kind === "sources"
					? assertAnonymousSources(a)
					: assertAnonymousArtifact(a, tag),
			promote: async (a, tag) => {
				await oras(
					["tag", `ghcr.io/${a.repository}:${request.version}`, tag],
					undefined,
					tokenDirectory,
				);
			},
		});
	} finally {
		await rm(tokenDirectory, { recursive: true, force: true });
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		await command();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
