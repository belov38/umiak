import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	verifyAptIndex,
	verifyAptMetadata,
	verifyAptSources,
} from "../../apps/template-builder/src/offline-apt.ts";
import { deriveLinuxSourceSubset } from "./linux-source-subset.mjs";
import { captureSourceFile, writeSourceLayout } from "./source-artifact.mjs";

const exec = promisify(execFile);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const authorities = {
	ubuntu: "F6ECB3762474EDA9D21B7022871920D1991BC93C",
	xtradeb: "5301FA4FD93244FBC6F6149982BB6851C64F6880",
};
async function bytesOf(file, cache, max = 256 * 1024 ** 2) {
	if (file.sizeBytes > max) throw Error("Source index exceeds limit");
	return Buffer.concat(
		await Promise.all(
			file.chunks.map((c) => readFile(join(cache, "blobs/sha256", c.sha256))),
		),
	);
}
async function localFile(bytes, url, cache) {
	return captureSourceFile({
		url,
		sha256: hash(bytes),
		sizeBytes: bytes.length,
		cache,
		fetcher: async () => new Response(bytes),
	});
}
function releaseEntries(text) {
	const block = text.match(/(?:^|\n)SHA256:\s*\n((?:[ \t].*\n)+)/)?.[1];
	if (!block) throw Error("Captured Release has no source index hashes");
	return new Map(
		block
			.trim()
			.split("\n")
			.map((line) => {
				const m = /^([a-f0-9]{64})\s+(\d+)\s+(\S+)$/.exec(line.trim());
				if (!m) throw Error("Invalid captured Release index hash");
				return [m[3], { sha256: m[1], sizeBytes: Number(m[2]) }];
			}),
	);
}
async function githubJSON(path) {
	let authorization;
	if (process.env.LAYER_GITHUB_TOKEN_FILE) {
		try {
			authorization = `Bearer ${(await readFile(process.env.LAYER_GITHUB_TOKEN_FILE, "utf8")).trim()}`;
		} catch (e) {
			if (e.code !== "ENOENT") throw e;
		}
	}
	for (let attempt = 0; attempt < 4; attempt++) {
		// Renamed or transferred repositories answer 301 to /repositories/<id>/...
		// Follow only same-origin API redirects; content stays pinned by commit SHA.
		let url = new URL(`https://api.github.com/${path}`);
		let response;
		for (let hop = 0; ; hop++) {
			response = await fetch(url, {
				redirect: "manual",
				signal: AbortSignal.timeout(30000),
				headers: {
					Accept: "application/vnd.github+json",
					...(authorization ? { Authorization: authorization } : {}),
				},
			});
			if (![301, 302, 307, 308].includes(response.status)) break;
			await response.body?.cancel();
			const next = new URL(response.headers.get("location") || "", url);
			if (next.origin !== "https://api.github.com" || hop >= 4)
				throw Error(`GitHub source metadata redirect refused: ${path}`);
			url = next;
		}
		if (response.ok) {
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.length > 16 * 1024 ** 2)
				throw Error("GitHub source metadata exceeds limit");
			return JSON.parse(bytes);
		}
		if (response.status < 500 || attempt === 3)
			throw Error(`GitHub source metadata HTTP ${response.status}: ${path}`);
		await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
	}
}
async function tagCommit(repository, tag) {
	let object = (
		await githubJSON(
			`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
		)
	).object;
	for (let depth = 0; object?.type === "tag" && depth < 4; depth++)
		object = (await githubJSON(`repos/${repository}/git/tags/${object.sha}`))
			.object;
	if (object?.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha))
		throw Error("Upstream source tag did not resolve to a commit");
	return object.sha;
}
async function gitSource(
	repository,
	commit,
	path,
	cache,
	files,
	seen = new Set(),
	depth = 0,
	auditGuest,
) {
	if (
		depth > 5 ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
		!/^[a-f0-9]{40}$/.test(commit)
	)
		throw Error("Unsafe corresponding-source repository/ref");
	const identity = `${repository}@${commit}`;
	if (seen.has(identity)) return [];
	seen.add(identity);
	const repo = await githubJSON(`repos/${repository}`);
	if (repo.private !== false)
		throw Error("Refusing to redistribute a private source repository");
	const source = await captureSourceFile({
		url: `https://codeload.github.com/${repository}/tar.gz/${commit}`,
		cache,
	});
	if (repository.toLowerCase() === "lizardbyte/libvirtualhid") {
		const subset = await deriveLinuxSourceSubset({
			source,
			cache,
			guest: auditGuest,
			commit,
		});
		const subsetPath = path.replace(/\.tar\.gz$/, "-linux-mit.tar.gz");
		files.push({
			...subset,
			path: subsetPath,
			repository,
			commit,
			license: "MIT (Linux CMake/compiler-derived subset)",
		});
		return [subsetPath];
	}
	const entry = {
		...source,
		path,
		repository,
		commit,
		license:
			repo.license?.spdx_id || "See original source archive license texts",
	};
	files.push(entry);
	const paths = [path];
	const tree = await githubJSON(
		`repos/${repository}/git/trees/${commit}?recursive=1`,
	);
	if (tree.truncated) throw Error("Corresponding-source tree is truncated");
	const nonLinux = new Set(["third-party/nvapi", "third-party/ViGEmClient"]);
	const excluded =
		repository.toLowerCase() === "lizardbyte/sunshine"
			? tree.tree.filter(
					(item) => item.mode === "160000" && nonLinux.has(item.path),
				)
			: [];
	entry.excludedGitlinks = excluded.map((item) => ({
		path: item.path,
		commit: item.sha,
		reason: "Windows-only dependency; not used by the Linux deb build",
	}));
	const links = tree.tree.filter(
		(item) => item.mode === "160000" && !excluded.includes(item),
	);
	if (!links.length) return paths;
	// Resolve every gitlink against the pinned .gitmodules, retaining nested source archives too.
	const modules = await fetch(
		`https://raw.githubusercontent.com/${repository}/${commit}/.gitmodules`,
		{ redirect: "error", signal: AbortSignal.timeout(30000) },
	);
	if (!modules.ok) throw Error("Pinned gitlinks have no .gitmodules");
	const text = await modules.text();
	if (text.length > 1024 ** 2) throw Error("Gitmodules exceeds limit");
	const sections = text
		.split(/\[submodule [^\]]+\]/)
		.slice(1)
		.map((section) => ({
			path: section.match(/^\s*path\s*=\s*(\S+)\s*$/m)?.[1],
			url: section.match(/^\s*url\s*=\s*(\S+)\s*$/m)?.[1],
		}));
	for (const entry of links) {
		const module = sections.find((m) => m.path === entry.path);
		if (
			!module ||
			!/^[A-Za-z0-9_./-]+$/.test(entry.path) ||
			entry.path.split("/").some((p) => p === ".." || !p)
		)
			throw Error("Unresolved source gitlink");
		const url = module.url?.startsWith("../")
			? new URL(module.url, `https://github.com/${repository}/`).toString()
			: module.url;
		const child =
			/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
				url || "",
			)?.[1];
		if (!child)
			throw Error("Source submodule is not a public HTTPS GitHub repository");
		const prefix = path.replace(/\.tar\.gz$/, "");
		paths.push(
			...(await gitSource(
				child,
				entry.sha,
				`${prefix}-submodules/${entry.path}/${entry.sha}.tar.gz`,
				cache,
				files,
				seen,
				depth + 1,
				auditGuest,
			)),
		);
	}
	return paths;
}
export async function buildSourceCompanion({
	capture,
	cache,
	directory,
	version,
	sourceCommit,
	auditGuest,
}) {
	console.log(
		`[sources ${capture.recipe.slug}] collecting corresponding sources`,
	);
	const started = Date.now(),
		files = [],
		mapping = [];
	const aptFiles = capture.files.filter(
		(f) => f.path.startsWith("apt/") && f.path.endsWith(".deb"),
	);
	const byRepo = new Map();
	for (const file of aptFiles) {
		const repo = file.path.split("/")[1];
		const list = byRepo.get(repo) || [];
		list.push(file);
		byRepo.set(repo, list);
	}
	const docker = [];
	for (const [name, debs] of byRepo) {
		const family = name.split("-")[0],
			suite = name.slice(family.length + 1);
		const root = join(capture.directory, "apt", name);
		if (family === "docker") {
			docker.push(...debs);
			continue;
		}
		console.log(
			`[sources ${capture.recipe.slug}] authenticate ${name} source indexes for ${debs.length} binary inputs`,
		);
		const keyFingerprint = authorities[family];
		if (!keyFingerprint) throw Error("Unapproved source archive authority");
		const sourceRoot =
			family === "ubuntu"
				? `https://snapshot.ubuntu.com/ubuntu/${capture.aptSnapshot}`
				: "https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu";
		const inRelease = await readFile(
			join(root, "dists", suite, "InRelease"),
			"utf8",
		);
		const publicKey = await readFile(join(root, "archive.asc"), "utf8");
		const release = releaseEntries(inRelease);
		const selected = new Map();
		const components = [
			...new Set(
				debs.map((d) => d.path.slice(`apt/${name}/pool/`.length).split("/")[0]),
			),
		];
		const sourceComponents = [...release.keys()]
			.map((path) => /^([a-z][a-z0-9-]*)\/source\/Sources\.xz$/.exec(path)?.[1])
			.filter(Boolean);
		const sourceIndexes = new Map();
		// A source package belongs to one component, but its binaries may be
		// published in another (e.g. a universe binary of a main source), so
		// look up the source across every signed Sources index of the suite.
		const sourcesFor = (component) => {
			if (!sourceIndexes.has(component))
				sourceIndexes.set(component, loadSources(component));
			return sourceIndexes.get(component);
		};
		const loadSources = async (component) => {
			const compressedPath = `${component}/source/Sources.xz`,
				pin = release.get(compressedPath);
			if (!pin)
				throw Error(`Signed source index is absent: ${name}/${component}`);
			const url = `${sourceRoot}/dists/${suite}/${compressedPath}`;
			const compressed = await captureSourceFile({ url, ...pin, cache });
			const data = await bytesOf(compressed, cache);
			await verifyAptMetadata({
				inRelease,
				publicKey,
				keyFingerprint,
				expectedSuite: suite,
				indexPath: compressedPath,
				index: data,
			});
			const scratch = join(cache, `.index-${hash(data)}.xz`);
			await writeFile(scratch, data);
			let index;
			try {
				index = (
					await exec("xz", ["-dc", scratch], {
						encoding: "buffer",
						maxBuffer: 256 * 1024 ** 2,
						timeout: 120000,
					})
				).stdout;
			} finally {
				await rm(scratch, { force: true });
			}
			const sources = await verifyAptSources({
				inRelease,
				publicKey,
				keyFingerprint,
				expectedSuite: suite,
				indexPath: `${component}/source/Sources`,
				index,
			});
			files.push({
				...(await localFile(
					index,
					`${sourceRoot}/dists/${suite}/${component}/source/Sources`,
					cache,
				)),
				path: `verification/${name}/${component}/source/Sources`,
			});
			return new Map(sources.map((s) => [`${s.name}:${s.version}`, s]));
		};
		for (const component of components) {
			if (!/^[a-z][a-z0-9-]*$/.test(component))
				throw Error("Unsafe source component");
			const packages = await verifyAptIndex({
				inRelease,
				publicKey,
				keyFingerprint,
				expectedSuite: suite,
				indexPath: `${component}/binary-amd64/Packages`,
				index: await readFile(
					join(root, "dists", suite, component, "binary-amd64/Packages"),
				),
			});
			const needed = packages.filter((p) =>
				debs.some((d) => d.sha256 === p.sha256),
			);
			if (!needed.length) continue;
			for (const binary of needed) {
				const match = /^([a-z0-9][a-z0-9+.-]*)(?: \(([^)]+)\))?$/.exec(
					binary.source,
				);
				if (!match) throw Error("Invalid binary-to-source package identity");
				const key = `${match[1]}:${match[2] || binary.version}`;
				let source = (await sourcesFor(component)).get(key);
				for (const other of sourceComponents) {
					if (source) break;
					if (other !== component) source = (await sourcesFor(other)).get(key);
				}
				if (!source)
					throw Error(
						`Exact source package missing from pinned index: ${binary.source} ${binary.version}`,
					);
				const paths = source.files.map((f) => `apt/${name}/${f.filename}`);
				mapping.push({
					binarySha256: binary.sha256,
					binaryName: binary.name,
					binaryVersion: binary.version,
					sourcePackage: source.name,
					sourceVersion: source.version,
					sources: paths,
				});
				for (const file of source.files) selected.set(file.filename, file);
			}
		}
		files.push({
			...(await localFile(
				Buffer.from(inRelease),
				`${sourceRoot}/dists/${suite}/InRelease`,
				cache,
			)),
			path: `verification/${name}/InRelease`,
		});
		files.push({
			...(await localFile(
				Buffer.from(publicKey),
				`https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x${keyFingerprint}`,
				cache,
			)),
			path: `verification/${name}/archive.asc`,
		});
		// Bounded parallelism keeps a large source set from overwhelming snapshot archives.
		const pending = [...selected.values()];
		for (let i = 0; i < pending.length; i += 4) {
			console.log(
				`[sources ${capture.recipe.slug}] ${name}: ${i}/${pending.length} source files`,
			);
			const batch = await Promise.allSettled(
				pending.slice(i, i + 4).map(async (file) => ({
					...(await captureSourceFile({
						url: `${sourceRoot}/${file.filename}`,
						sha256: file.sha256,
						sizeBytes: file.sizeBytes,
						cache,
					})),
					path: `apt/${name}/${file.filename}`,
				})),
			);
			for (const result of batch) {
				if (result.status === "rejected") throw result.reason;
				files.push(result.value);
			}
		}
	}
	const fetches = (
		await readFile(join(capture.directory, "inputs/fetch.jsonl"), "utf8")
	)
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	if (capture.recipe.slug === "linux-desktop") {
		const descriptor = JSON.parse(
			await readFile(
				join(capture.directory, "build/layer-recipe.json"),
				"utf8",
			),
		);
		for (const [name, repository, pin] of [
			[
				"Sunshine",
				"LizardByte/Sunshine",
				descriptor.versions.desktop.sunshine.version,
			],
			[
				"moonlight-web",
				"MrCreativ3001/moonlight-web-stream",
				descriptor.versions.desktop.moonlight_web.version,
			],
		]) {
			const commit = await tagCommit(repository, `v${pin}`);
			const paths = await gitSource(
				repository,
				commit,
				`upstream/${name}/${commit}.tar.gz`,
				cache,
				files,
				new Set(),
				0,
				auditGuest,
			);
			const binary = fetches.find((f) =>
				f.url.startsWith(`https://github.com/${repository}/releases/`),
			);
			if (!binary)
				throw Error(`Source companion has no corresponding ${name} input`);
			mapping.push({
				binarySha256: binary.sha256,
				binaryName: name,
				binaryVersion: pin,
				sourceCommit: commit,
				role: ["upstream-release", "packaging-source"],
				sources: paths,
			});
		}
	}
	const covered = new Set(mapping.map((m) => m.binarySha256));
	for (const deb of aptFiles)
		if (!deb.path.startsWith("apt/docker-") && !covered.has(deb.sha256))
			throw Error("A binary deb has no corresponding source package");
	files.sort((a, b) => a.path.localeCompare(b.path));
	const unique = [...new Map(files.map((f) => [f.path, f])).values()];
	const reference = await writeSourceLayout({
		directory,
		cache,
		version,
		slug: capture.recipe.slug,
		sourceCommit,
		files: unique,
		mapping,
	});
	return {
		reference: { repository: reference.repository, digest: reference.digest },
		mapping,
		sourceSubsets: unique
			.filter((f) => f.originalArchive)
			.map(({ path, sha256, originalArchive, derivation }) => ({
				path,
				sha256,
				originalArchive,
				derivation,
			})),
		dockerBinaries: docker.map((f) => ({
			binarySha256: f.sha256,
			path: f.path,
			sourceRequirement:
				"Apache-2.0: license/NOTICE retention; no corresponding-source requirement",
		})),
		measurements: {
			sourceBytes: reference.bytes,
			sourceFiles: reference.files,
			sourceChunks: reference.chunks,
			sourceCaptureMs: Date.now() - started,
		},
	};
}
