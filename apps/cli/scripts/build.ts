// Builds the `sbx` binaries with `bun build --compile` (S7 §14.1):
//   bun scripts/build.ts         the current platform only (`pnpm build`)
//   bun scripts/build.ts --all   the five release targets (`pnpm build:all`;
//                                Bun downloads the other runtimes once)
// Output: dist/sbx-<os>-<arch>[.exe] and dist/SHA256SUMS (sha256sum format)
// of the binaries built by this run. dist/ is not committed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
		file: `sbx-${name}${os === "windows" ? ".exe" : ""}`,
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
			`no sbx build for ${os}-${arch}; targets: ${TARGETS.map((x) => x.name).join(", ")}`,
		);
	}
	return t;
}

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export function build(targets: readonly Target[]): void {
	const dist = join(CLI_DIR, "dist");
	mkdirSync(dist, { recursive: true });
	const sums: string[] = [];
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
		const digest = createHash("sha256").update(readFileSync(out)).digest("hex");
		sums.push(`${digest}  ${t.file}\n`);
	}
	writeFileSync(join(dist, "SHA256SUMS"), sums.join(""));
}

if ((import.meta as { main?: boolean }).main === true) {
	const all = process.argv.slice(2).includes("--all");
	build(all ? TARGETS : [hostTarget(process.platform, process.arch)]);
}
