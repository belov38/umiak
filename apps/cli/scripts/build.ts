// Builds the `umiak` binaries with `bun build --compile` (S7 §14.1):
//   bun scripts/build.ts         the current platform only (`pnpm build`)
//   bun scripts/build.ts --all   the five release targets (`pnpm build:all`;
//                                Bun downloads the other runtimes once)
// Output: dist/umiak-<os>-<arch>[.exe], gzip archives, DOWNLOADS version/size
// metadata and SHA256SUMS (sha256sum format, archive and extracted checksums)
// of every umiak-* binary in dist/ after this run, so the file always matches
// what is there (a host-only build after --all keeps the other entries).
// dist/ is not committed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export interface Target {
	/** `<os>-<arch>` of the release, e.g. linux-x64. */
	name: string;
	/** Value of `--target`. */
	bunTarget: string;
	/** File name in dist/. */
	file: string;
}

function target(os: string, arch: string): Target {
	const name = `${os}-${arch}`;
	return {
		name,
		bunTarget: `bun-${name}`,
		file: `umiak-${name}${os === "windows" ? ".exe" : ""}`,
	};
}

/** The release targets (S7 §14.1). */
export const TARGETS: readonly Target[] = [
	target("linux", "x64"),
	target("linux", "arm64"),
	target("darwin", "arm64"),
	target("darwin", "x64"),
	target("windows", "x64"),
];

/** The target of a Node platform and arch; throws for one not released. */
export function hostTarget(platform: string, arch: string): Target {
	const os = platform === "win32" ? "windows" : platform;
	const t = TARGETS.find((x) => x.name === `${os}-${arch}`);
	if (t === undefined) {
		throw new Error(
			`no umiak build for ${os}-${arch}; targets: ${TARGETS.map((x) => x.name).join(", ")}`,
		);
	}
	return t;
}

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export function build(targets: readonly Target[]): void {
	const dist = join(CLI_DIR, "dist");
	mkdirSync(dist, { recursive: true });
	for (const t of targets) {
		const out = join(dist, t.file);
		const r = spawnSync(
			process.execPath,
			[
				"build",
				"--compile",
				`--target=${t.bunTarget}`,
				"src/main.ts",
				"--outfile",
				out,
			],
			{ cwd: CLI_DIR, stdio: "inherit" },
		);
		if (r.status !== 0) {
			throw new Error(
				`bun build for ${t.name} failed (${r.status ?? r.signal})`,
			);
		}
	}
	const version = JSON.parse(
		readFileSync(join(CLI_DIR, "package.json"), "utf8"),
	).version as string;
	const downloads: string[] = [];
	for (const t of TARGETS) {
		const path = join(dist, t.file);
		if (!readdirSync(dist).includes(t.file)) continue;
		const compressed = gzipSync(readFileSync(path), { level: 9 });
		writeFileSync(`${path}.gz`, compressed);
		downloads.push(`${version} ${t.file}.gz ${compressed.length}\n`);
	}
	writeFileSync(join(dist, "DOWNLOADS"), downloads.join(""));
	const sums = readdirSync(dist)
		.filter((f) => f.startsWith("umiak-"))
		.sort()
		.map((f) => {
			const digest = createHash("sha256")
				.update(readFileSync(join(dist, f)))
				.digest("hex");
			return `${digest}  ${f}\n`;
		});
	writeFileSync(join(dist, "SHA256SUMS"), sums.join(""));
}

if ((import.meta as { main?: boolean }).main === true) {
	const all = process.argv.slice(2).includes("--all");
	build(all ? TARGETS : [hostTarget(process.platform, process.arch)]);
}
