import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	AnonymousOCI,
	OCI_REPOSITORIES,
	OCI_SOURCE_REPOSITORIES,
} from "./oci.mjs";
import { login, oras, validateReleaseRequest } from "./release-layers.mjs";
import { stagingLayout } from "./staged-layers.mjs";

const exec = promisify(execFile);
const [action, version, arg, outputArg] = process.argv.slice(2);
const sourceCommit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
const channel = version?.includes("-edge.") ? "edge" : "stable";
validateReleaseRequest({ version, channel, sourceCommit, publish: false });
const output = resolve(
	action === "build"
		? outputArg || "dist/linux-layers"
		: arg || "dist/linux-layers",
);
const temporary = await mkdtemp(join(tmpdir(), "umiak-local-layers-"));
try {
	if (action === "build") {
		const agentVersion = arg;
		if (!/^\d+\.\d+\.\d+(?:-edge\.\d{8}\.\d+)?$/.test(agentVersion || ""))
			throw Error("Usage: local-layers.mjs build VERSION AGENT_VERSION OUTPUT");
		if ((await exec("git", ["status", "--porcelain"])).stdout.trim())
			throw Error("Local layer build requires a clean approved checkout");
		const binary = join(temporary, "umiak-agent");
		await exec(
			"go",
			[
				"-C",
				"services/guest-agent",
				"build",
				"-trimpath",
				"-buildvcs=false",
				"-ldflags",
				`-s -w -X main.version=${agentVersion}`,
				"-o",
				binary,
				"./cmd/umiak-agent",
			],
			{
				env: {
					...process.env,
					GOOS: "linux",
					GOARCH: "amd64",
					CGO_ENABLED: "0",
				},
				timeout: 10 * 60_000,
			},
		);
		process.env.LAYER_AGENT_BINARY = binary;
		process.env.LAYER_AGENT_VERSION = agentVersion;
		if (process.env.ORAS_TOKEN_FILE)
			process.env.LAYER_GITHUB_TOKEN_FILE = process.env.ORAS_TOKEN_FILE;
		const { buildLayerRelease } = await import("./build-layers.mjs");
		await buildLayerRelease({ output, version, channel, sourceCommit });
		for (const slug of ["linux", "linux-desktop"])
			await stagingLayout(join(output, slug), version);
		console.log(
			`Unsigned build complete: ${output}; approved source ${sourceCommit}`,
		);
	} else if (action === "stage") {
		const tag = `staging-${version}`;
		if (!process.env.ORAS_TOKEN_FILE)
			throw Error("ORAS_TOKEN_FILE must point to a restricted token file");
		await login(temporary, process.env.ORAS_TOKEN_FILE);
		const artifacts = [];
		for (const slug of ["linux", "linux-desktop"]) {
			const draft = JSON.parse(
				await readFile(join(output, slug, "manifest.draft.json")),
			);
			if (draft.sourceCommit !== sourceCommit || draft.version !== version)
				throw Error("Build/source/version mismatch");
			artifacts.push(
				{
					repository: OCI_SOURCE_REPOSITORIES[slug],
					directory: join(output, `${slug}-sources`),
					from: version,
				},
				{
					repository: OCI_REPOSITORIES[slug],
					directory: join(output, slug, "staging-layout"),
					from: tag,
				},
			);
		}
		for (const artifact of artifacts) {
			try {
				await oras(
					["manifest", "fetch", `ghcr.io/${artifact.repository}:${tag}`],
					undefined,
					temporary,
				);
			} catch (error) {
				if (
					/manifest unknown|not found|NAME_UNKNOWN|MANIFEST_UNKNOWN/i.test(
						error.stderr || "",
					)
				)
					continue;
				throw Error("Cannot establish staging tag availability");
			}
			throw Error("Immutable staging tag already exists; choose a new version");
		}
		for (const a of artifacts)
			await oras(
				[
					"copy",
					"--from-oci-layout",
					`${a.directory}:${a.from}`,
					`ghcr.io/${a.repository}:${tag}`,
				],
				undefined,
				temporary,
			);
		// Anonymous manifest readback also proves all four packages are public; CI re-hashes all blobs.
		for (const a of artifacts) {
			const index = JSON.parse(await readFile(join(a.directory, "index.json")));
			const type = JSON.parse(
				await readFile(
					join(a.directory, "blobs/sha256", index.manifests[0].digest.slice(7)),
				),
			).artifactType;
			const client = new AnonymousOCI({
				repository: a.repository,
				artifactType: type,
				maxLayers: 8193,
				maxManifestBytes: 8 * 1024 ** 2,
			});
			await client.manifest(index.manifests[0].digest);
		}
		console.log(
			`Staged four artifacts at ${tag}; no channel pointers changed.`,
		);
	} else
		throw Error(
			"Usage: local-layers.mjs build VERSION AGENT_VERSION OUTPUT | stage VERSION OUTPUT",
		);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
