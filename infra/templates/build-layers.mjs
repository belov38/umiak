import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { validateBuildAptProxy } from "../../apps/template-builder/src/build-apt-proxy.ts";
import {
	defaultDownloadFetch,
	fetchBaseImage,
} from "../../apps/template-builder/src/image.ts";
import {
	captureLayer,
	describeLayerFiles,
	replayLayer,
} from "../../apps/template-builder/src/qemu-build.ts";
import {
	loadRecipe,
	loadVersions,
} from "../../apps/template-builder/src/recipe.ts";
import { buildSourceCompanion } from "./build-sources.mjs";
import { layerInventory } from "./layer-inventory.mjs";
import {
	collectAgentNotices,
	collectUpstreamNotices,
	dockerLicenseReferences,
} from "./layer-notices.mjs";
import { packLayer } from "./layer-pack.mjs";

const exec = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function buildLayerRelease(o) {
	const aptProxy = validateBuildAptProxy(o.aptProxy);
	const output = resolve(o.output);
	try {
		await lstat(output);
		throw Error("Layer output already exists; use a fresh output directory");
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	await mkdir(output, { recursive: true, mode: 0o700 });
	const work = join(output, "work");
	const cache = join(work, "official-base-cache");
	await mkdir(cache, { recursive: true });
	const measurements = [];
	for (const slug of ["linux", "linux-desktop"]) {
		const started = Date.now();
		const directory = join(work, slug);
		let companion;
		const capture = await captureLayer({
			...(slug === "linux-desktop"
				? {
						afterCapture: async (captured, guest) => {
							companion = await buildSourceCompanion({
								capture: captured,
								cache: join(work, "source-cache"),
								directory: join(output, `${slug}-sources`),
								version: o.version,
								sourceCommit: o.sourceCommit,
								auditGuest: guest,
							});
						},
					}
				: {}),
			slug,
			...(aptProxy ? { aptProxy } : {}),
			version: o.version,
			templatesDir: resolve("infra/templates"),
			outputDir: directory,
			diagnosticsDirectory: join(output, "diagnostics", slug, "capture"),
			cacheDir: cache,
			agentBinary: resolve(
				process.env.LAYER_AGENT_BINARY || "dist/layer-agent/umiak-agent",
			),
			agentVersion: process.env.LAYER_AGENT_VERSION || "0.4.0",
			unitsDirectory: resolve("services/guest-agent/packaging/systemd"),
			updateKeysFile: resolve(
				"services/guest-agent/packaging/trust/update-keys.pub",
			),
			log: (line) => console.log(`[${slug}] ${line}`),
		});
		const upstream = await collectUpstreamNotices(capture);
		const agentModules = await collectAgentNotices(directory, o.sourceCommit);
		const packages = JSON.parse(
			await readFile(join(directory, "licenses/packages.json"), "utf8"),
		);
		const npm = JSON.parse(
			await readFile(join(directory, "licenses/npm.json"), "utf8"),
		);
		const fetches = (
			await readFile(join(directory, "inputs/fetch.jsonl"), "utf8")
		)
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const dockerReferences = await dockerLicenseReferences(capture, packages);
		const files = await describeLayerFiles(directory);
		companion ||= await buildSourceCompanion({
			capture,
			cache: join(work, "source-cache"),
			directory: join(output, `${slug}-sources`),
			version: o.version,
			sourceCommit: o.sourceCommit,
		});
		const inventory = layerInventory({
			sourceCommit: o.sourceCommit,
			facts: capture.facts,
			files,
			packages,
			npm,
			fetches,
			upstream,
		});
		inventory.sources = companion.reference;
		inventory.binarySources = companion.mapping;
		inventory.sourceSubsets = companion.sourceSubsets;
		inventory.apacheDocker = companion.dockerBinaries.map((binary) => ({
			...binary,
			...dockerReferences,
		}));
		inventory.agentModules = agentModules;
		inventory.aptSnapshot = capture.aptSnapshot;
		inventory.chromium = JSON.parse(
			await readFile(join(directory, "build/layer-inputs.json"), "utf8"),
		).chromium;
		inventory.desktopSources =
			capture.recipe.slug === "linux-desktop"
				? loadVersions(capture.recipe).desktop
				: null;
		const inventoryBytes = Buffer.from(JSON.stringify(inventory));
		if (inventoryBytes.length > 32 * 1024 ** 2)
			throw Error("Signed license inventory exceeds limit");
		await writeFile(join(directory, "licenses/inventory.json"), inventoryBytes);
		capture.files = await describeLayerFiles(directory);
		const recipe = loadRecipe(resolve("infra/templates"), slug, "linux");
		const versions = loadVersions(recipe);
		const base = await fetchBaseImage({
			fetch: defaultDownloadFetch,
			cacheDir: cache,
			base: versions.base,
			keyFile: resolve("infra/templates/keys/ubuntu-cloud-images.asc"),
		});
		const proof = await replayLayer({
			capture,
			basePath: base.path,
			workDirectory: work,
			diagnosticsDirectory: join(output, "diagnostics", slug, "replay"),
			log: (line) => console.log(`[${slug} offline] ${line}`),
		});
		// The replay must not change any exported byte; sealing affects only its private overlay.
		if (
			JSON.stringify(await describeLayerFiles(directory)) !==
			JSON.stringify(capture.files)
		)
			throw Error("Input layer changed during replay");
		const product = join(output, slug);
		await mkdir(product);
		for (const [path, title] of [
			["build/layer-recipe.json", "layer-recipe.json"],
			["build/verify.sh", "verify.sh"],
			["licenses/inventory.json", "inventory.json"],
		])
			await cp(join(directory, path), join(product, title));
		// Normalize the tar's file modes to precisely the signed extraction policy.
		for (const file of capture.files)
			await chmod(join(directory, file.path), file.mode);
		const tar = join(work, `${slug}.tar`);
		const roots = (await readdir(directory)).sort();
		await exec(
			"tar",
			[
				"--format=ustar",
				"--sort=name",
				"--mtime=@0",
				"--owner=0",
				"--group=0",
				"--numeric-owner",
				"-cf",
				tar,
				"-C",
				directory,
				...roots,
			],
			{ timeout: 10 * 60_000, maxBuffer: 1024 ** 2 },
		);
		const archive = await packLayer({ path: tar, outputDir: product });
		const manifest = {
			format: "umiak-linux-layer/v1",
			version: o.version,
			slug,
			channel: o.channel,
			arch: "amd64",
			distro: "ubuntu",
			release: "26.04",
			sourceCommit: o.sourceCommit,
			recipeSha256: capture.recipeSha256,
			base: capture.base,
			aptSnapshot: capture.aptSnapshot,
			agent: capture.agent,
			builderApi: 1,
			minPlatform: process.env.LAYER_MIN_PLATFORM || "0.4.0",
			maxPlatform: process.env.LAYER_MAX_PLATFORM || "0.5.0",
			minAgent: "0.1.0",
			bootTrust: "smbios-ca-sha256-v1",
			archive,
			files: capture.files,
			sources: companion.reference,
			inventory: {
				sha256: hash(inventoryBytes),
				sizeBytes: inventoryBytes.length,
			},
			verification: {
				ok: true,
				offlineReplay: true,
				...(aptProxy ? { aptCacheProxyUsed: true } : {}),
			},
		};
		await writeFile(
			join(product, "manifest.draft.json"),
			JSON.stringify(manifest),
		);
		await writeFile(join(product, "replay.json"), JSON.stringify(proof));
		measurements.push({
			slug,
			baseBytes: (await lstat(base.path)).size,
			rawInputTarBytes: archive.sizeBytes,
			layerCompressedBytes: archive.compressedBytes,
			chunks: archive.chunks.length,
			replayMs: proof.durationMs,
			buildMs: Date.now() - started,
			...companion.measurements,
			downloadAt20MbitSeconds: Math.ceil(
				((archive.compressedBytes + (await lstat(base.path)).size) * 8) /
					20_000_000,
			),
			downloadAt100MbitSeconds: Math.ceil(
				((archive.compressedBytes + (await lstat(base.path)).size) * 8) /
					100_000_000,
			),
		});
		await writeFile(
			join(output, "measurements.json"),
			JSON.stringify(measurements, null, 2),
		);
		console.log(JSON.stringify(measurements.at(-1)));
		await rm(tar);
		await rm(directory, { recursive: true });
	}
	// The official disk and locally customized disks never enter publishable product directories.
	await rm(work, { recursive: true });
}
