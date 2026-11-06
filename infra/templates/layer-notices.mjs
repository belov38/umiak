import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function downloadNotice(url, optional = false) {
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
			if (optional && response.status === 404) return null;
			if (!response.ok) throw Error(`HTTP ${response.status}`);
			const chunks = [];
			let size = 0;
			for await (const b of response.body) {
				size += b.length;
				if (size > 4 * 1024 ** 2) throw Error("notice exceeds limit");
				chunks.push(b);
			}
			if (!size) throw Error("empty notice");
			return Buffer.concat(chunks);
		} catch (error) {
			if (attempt === 3)
				throw Error(`Upstream notice unavailable: ${url}: ${error.message}`);
			await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
		}
	}
}
/** Fixed upstream locations at the exact recipe release, recorded with full byte hashes. */
export async function collectUpstreamNotices(capture) {
	const pins = JSON.parse(
		await readFile(join(capture.directory, "build/layer-recipe.json"), "utf8"),
	).versions;
	const raw = "https://raw.githubusercontent.com";
	const sources = [
		["Node.js", `${raw}/nodejs/node/v${pins.tools.node.version}/LICENSE`],
		["Go", `${raw}/golang/go/go${pins.tools.go.version}/LICENSE`],
		["Go", `${raw}/golang/go/go${pins.tools.go.version}/PATENTS`],
		[
			"Rust / rustup",
			`${raw}/rust-lang/rust/${pins.tools.rust.version}/LICENSE-APACHE`,
		],
		[
			"Rust / rustup",
			`${raw}/rust-lang/rust/${pins.tools.rust.version}/LICENSE-MIT`,
		],
		[
			"Rust / rustup",
			`${raw}/rust-lang/rust/${pins.tools.rust.version}/COPYRIGHT`,
		],
		["uv", `${raw}/astral-sh/uv/${pins.tools.uv.version}/LICENSE-APACHE`],
		["uv", `${raw}/astral-sh/uv/${pins.tools.uv.version}/LICENSE-MIT`],
		["GitHub CLI", `${raw}/cli/cli/v${pins.tools.gh.version}/LICENSE`],
	];
	if (capture.recipe.slug === "linux-desktop")
		sources.push(
			[
				"Sunshine",
				`${raw}/LizardByte/Sunshine/v${pins.desktop.sunshine.version}/LICENSE`,
			],
			[
				"moonlight-web",
				`${raw}/MrCreativ3001/moonlight-web-stream/v${pins.desktop.moonlight_web.version}/LICENSE`,
			],
			[
				"Cua Driver",
				`${raw}/trycua/cua/cua-driver-rs-v${pins.desktop.cua_driver.version}/LICENSE.md`,
			],
			[
				"cosign",
				`${raw}/sigstore/cosign/v${pins.desktop.cosign.version}/LICENSE`,
			],
		);
	const entries = [];
	for (const [name, url] of sources) {
		const bytes = await downloadNotice(url);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const path = `licenses/upstream/${sha256}.txt`;
		await mkdir(join(capture.directory, "licenses/upstream"), {
			recursive: true,
		});
		await writeFile(join(capture.directory, path), bytes);
		entries.push({ name, url, sha256, path });
	}
	return entries;
}

function moduleLicense(text, name, file) {
	if (/Apache License[\s\S]{0,100}Version 2\.0/.test(text)) return "Apache-2.0";
	if (/Permission is hereby granted, free of charge/i.test(text)) return "MIT";
	if (/Redistribution and use in source and binary forms/.test(text))
		return "LicenseRef-BSD-Notice";
	if (/Permission to use, copy, modify, and(?:\/or)? distribute/i.test(text))
		return "ISC";
	throw Error(`Unresolved embedded Go module license: ${name}/${file}`);
}
/** Enumerate the target agent's dependencies, not unrelated modules from the Go workspace. */
export async function collectAgentNotices(directory, sourceCommit) {
	const result = await exec(
		"go",
		[
			"-C",
			"services/guest-agent",
			"list",
			"-deps",
			"-f",
			"{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}",
			"./cmd/umiak-agent",
		],
		{
			env: { ...process.env, GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" },
			maxBuffer: 4 * 1024 ** 2,
		},
	);
	const records = [];
	for (const line of [
		...new Set(result.stdout.split("\n").filter(Boolean)),
	].sort()) {
		const [name, version, root] = line.split("|");
		if (!root) throw Error("Agent module source directory missing");
		const firstParty = name.startsWith("github.com/belov38/umiak/");
		const paths = firstParty
			? ["LICENSE"]
			: (await readdir(root)).filter((n) =>
					/^(LICEN[CS]E|COPYING|NOTICE)([.-]|$)/i.test(n),
				);
		if (!paths.length) throw Error(`Embedded module notices missing: ${name}`);
		const notices = [];
		for (const nameOfFile of paths) {
			let bytes;
			try {
				bytes = await readFile(firstParty ? "LICENSE" : join(root, nameOfFile));
			} catch (error) {
				if (error.code === "EISDIR") continue;
				throw error;
			}
			const hash = createHash("sha256").update(bytes).digest("hex");
			const path = `licenses/agent/${hash}.txt`;
			await mkdir(join(directory, "licenses/agent"), { recursive: true });
			await writeFile(join(directory, path), bytes);
			notices.push({
				path,
				sha256: hash,
				license: /^NOTICE/i.test(nameOfFile)
					? "LicenseRef-Attribution-Notice"
					: moduleLicense(bytes.toString(), name, nameOfFile),
			});
		}
		if (
			!notices.some(
				(notice) => notice.license !== "LicenseRef-Attribution-Notice",
			)
		)
			throw Error(`Embedded module license missing: ${name}`);
		records.push({
			name,
			version: version || sourceCommit,
			source: firstParty
				? `https://github.com/belov38/umiak/tree/${sourceCommit}`
				: `https://pkg.go.dev/${name}@${version}`,
			notices,
		});
	}
	await writeFile(
		join(directory, "licenses/agent.json"),
		JSON.stringify(records),
	);
	return records;
}

/** Apache Docker source references are best-effort provenance, not a corresponding-source gate. */
export async function dockerLicenseReferences(capture, packages) {
	const pins = JSON.parse(
		await readFile(join(capture.directory, "build/layer-recipe.json"), "utf8"),
	).versions;
	const policy = JSON.parse(
		await readFile(join(capture.directory, "build/layer-inputs.json"), "utf8"),
	).dockerPackaging;
	const runtime = JSON.parse(
		await readFile(
			join(capture.directory, "licenses/docker-components.json"),
			"utf8",
		),
	);
	const version = (v) => v.replace(/^\d+:/, "").split("-")[0];
	const upstream = [
		{ repository: "moby/moby", tag: `v${version(pins.docker.docker_ce)}` },
		{ repository: "docker/cli", tag: `v${version(pins.docker.docker_ce)}` },
		{
			repository: "containerd/containerd",
			tag: `v${version(pins.docker.containerd_io)}`,
		},
		{
			repository: "docker/compose",
			tag: `v${version(pins.docker.compose_plugin)}`,
		},
		{
			repository: "docker/buildx",
			tag: `v${version(pins.docker.buildx_plugin)}`,
		},
	];
	const runc = runtime.runc?.match(/^runc version v?([^\s]+)/)?.[1];
	if (runc)
		upstream.push({ repository: "opencontainers/runc", tag: `v${runc}` });
	const notices = [];
	for (const p of packages.filter((p) =>
		/^(docker-ce|docker-compose-plugin|docker-buildx-plugin|containerd\.io)/.test(
			p.name,
		),
	)) {
		const bytes = await readFile(join(capture.directory, p.notice));
		// This flags actual notice evidence for review, rather than assuming every Docker component is Apache.
		if (
			/\b[AL]?GPL(?:[- ]|v\d)|GNU (?:Lesser |General )?Public License/i.test(
				bytes.toString(),
			)
		)
			throw Error(
				`Docker package copyright mentions copyleft; inspect bundled components before public upload: ${p.name}`,
			);
		notices.push(...(p.notices || [p.notice]));
	}
	for (const source of upstream) {
		for (const title of ["LICENSE", "NOTICE"]) {
			const url = `https://raw.githubusercontent.com/${source.repository}/${source.tag}/${title}`;
			const bytes = await downloadNotice(url, true);
			if (!bytes) continue;
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const path = `licenses/upstream/${sha256}.txt`;
			await mkdir(join(capture.directory, "licenses/upstream"), {
				recursive: true,
			});
			await writeFile(join(capture.directory, path), bytes);
			notices.push(path);
		}
	}
	return {
		license: "Apache-2.0",
		sourceRequired: false,
		upstream: upstream.map((s) => ({
			...s,
			url: `https://github.com/${s.repository}/tree/${s.tag}`,
			provenance: "best-effort upstream release reference",
		})),
		packaging: {
			...policy,
			repositories: policy.repositories.map((r) => ({
				...r,
				url: `https://github.com/${r.repository}/tree/${r.commit}`,
			})),
		},
		runtime,
		notices: [...new Set(notices)],
	};
}

/**
 * Some npm tarballs (pnpm, the Codex CLI, node-pty prebuilds) ship no LICENSE
 * file. Fetch the license text from the package's GitHub repository at a tag
 * of that exact version (never a branch), hash it and attach it; fail when no
 * tagged license exists.
 */
export async function collectNpmUpstreamNotices(directory, npm) {
	const files = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"];
	for (const p of npm) {
		if (p.notices?.length) continue;
		const repo = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(
			String(p.repository?.url || p.repository || ""),
		);
		if (!repo)
			throw Error(
				`npm package without notices or GitHub repository: ${p.name}`,
			);
		// Platform packages carry a suffix (0.166.0-linux-x64); tags use the base version.
		const base = String(p.version).replace(
			/-(?:linux|darwin|win32)-[\w]+$/,
			"",
		);
		const raw = "https://raw.githubusercontent.com";
		let found;
		search: for (const tag of [`v${base}`, base, `rust-v${base}`])
			for (const name of files) {
				const url = `${raw}/${repo[1]}/${repo[2]}/${tag}/${name}`;
				const bytes = await downloadNotice(url, true);
				if (bytes) {
					found = { url, bytes };
					break search;
				}
			}
		if (!found)
			throw Error(
				`No tagged upstream license for npm package ${p.name}@${p.version}`,
			);
		const sha256 = createHash("sha256").update(found.bytes).digest("hex");
		const path = `licenses/upstream/${sha256}.txt`;
		await mkdir(join(directory, "licenses/upstream"), { recursive: true });
		await writeFile(join(directory, path), found.bytes);
		p.notices = [path];
		p.noticeSource = found.url;
	}
	await writeFile(join(directory, "licenses/npm.json"), JSON.stringify(npm));
	return npm;
}
